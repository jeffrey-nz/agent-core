/**
 * GitHub Projects v2 — Kanban board operations via GraphQL
 *
 * All node IDs are cached in projectConfig.github._state after first provisioning
 * to avoid querying them on every call.
 */

const STATUS_OPTIONS = ["Backlog", "In Progress", "Review", "Done"];

// ── Queries ──────────────────────────────────────────────────────────────────

const Q_USER_NODE_ID = `query { viewer { id login } }`;

const Q_LIST_PROJECTS = `
  query($login: String!) {
    user(login: $login) {
      projectsV2(first: 100) {
        nodes { id title number }
      }
    }
  }
`;

const Q_PROJECT_FIELDS = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 20) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id name options { id name }
            }
          }
        }
      }
    }
  }
`;

const Q_PROJECT_ITEMS = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100) {
          nodes {
            id
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
            }
            content {
              ... on Issue { number title url state }
              ... on PullRequest { number title url state }
            }
          }
        }
      }
    }
  }
`;

// ── Mutations ────────────────────────────────────────────────────────────────

const M_CREATE_PROJECT = `
  mutation($ownerId: ID!, $title: String!) {
    createProjectV2(input: { ownerId: $ownerId, title: $title }) {
      projectV2 { id number title }
    }
  }
`;

const M_CREATE_STATUS_FIELD = `
  mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    createProjectV2Field(input: {
      projectId: $projectId
      dataType: SINGLE_SELECT
      name: $name
      singleSelectOptions: $options
    }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }
    }
  }
`;

const M_ADD_ISSUE = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

const M_UPDATE_STATUS = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getUserNodeId(client) {
  const data = await client.graphql(Q_USER_NODE_ID);
  return { id: data.viewer.id, login: data.viewer.login };
}

async function findExistingProject(client, login, title) {
  const data = await client.graphql(Q_LIST_PROJECTS, { login });
  return data.user.projectsV2.nodes.find((p) => p.title === title) || null;
}

async function getStatusField(client, projectId) {
  const data = await client.graphql(Q_PROJECT_FIELDS, { projectId });
  const fields = data.node.fields?.nodes || [];
  return fields.find((f) => f.name === "Status") || null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function findOrCreateProject({ client, login, repoName }) {
  const { id: ownerId } = await getUserNodeId(client);
  const title = `${repoName} — Copilot`;

  let project = await findExistingProject(client, login, title);

  if (!project) {
    const data = await client.graphql(M_CREATE_PROJECT, { ownerId, title });
    project = data.createProjectV2.projectV2;
  }

  // Get or create the Status field
  let statusField = await getStatusField(client, project.id);

  if (!statusField) {
    const data = await client.graphql(M_CREATE_STATUS_FIELD, {
      projectId: project.id,
      name: "Status",
      options: STATUS_OPTIONS.map((name, color) => ({ name, color: "GRAY", description: "" })),
    });
    statusField = data.createProjectV2Field.projectV2Field;
  }

  const statusOptions = {};
  for (const opt of statusField.options || []) {
    statusOptions[opt.name] = opt.id;
  }

  return {
    projectId: project.id,
    projectNumber: project.number,
    statusFieldId: statusField.id,
    statusOptions,
  };
}

export async function ensureStatusOptions({ client, projectConfig }) {
  const state = projectConfig?.github?._state;
  if (!state?.projectId) return;

  const statusField = await getStatusField(client, state.projectId);
  if (statusField) {
    state.statusOptions = {};
    for (const opt of statusField.options || []) {
      state.statusOptions[opt.name] = opt.id;
    }
    if (STATUS_OPTIONS.every((name) => state.statusOptions[name])) return;
  }

  // Status field missing or incomplete — re-provision (idempotent, recreates field)
  const { login } = await getUserNodeId(client);
  const result = await findOrCreateProject({ client, login, repoName: projectConfig.github.repo });
  state.projectId = result.projectId;
  state.projectNumber = result.projectNumber;
  state.statusFieldId = result.statusFieldId;
  state.statusOptions = result.statusOptions;
}

export async function getBoardSummary({ client, projectConfig }) {
  const state = projectConfig?.github?._state;
  if (!state?.projectId) return null;

  const board = await getBoard({ client, projectId: state.projectId });
  const hasItems = board.items.some((i) => i.content);
  if (!hasItems) return null;

  const lines = ["[GITHUB BOARD]"];
  for (const col of board.columns) {
    const open = col.items
      .filter((item) => item.content?.state !== "closed")
      .map((item) => `#${item.content?.number} ${item.content?.title}`)
      .slice(0, 8);
    lines.push(`${col.name}: ${open.length ? open.join(", ") : "(none)"}`);
  }
  return lines.join("\n");
}

export async function addItemToProject({ client, projectId, issueNodeId }) {
  const data = await client.graphql(M_ADD_ISSUE, { projectId, contentId: issueNodeId });
  return data.addProjectV2ItemById.item.id;
}

export async function moveCard({ client, projectConfig, issueNumber, column }) {
  const state = projectConfig?.github?._state;
  if (!state?.projectId || !state?.statusFieldId) return;

  let optionId = state.statusOptions?.[column];
  if (!optionId) {
    await ensureStatusOptions({ client, projectConfig });
    optionId = state.statusOptions?.[column];
  }
  if (!optionId) return;

  const coords = { owner: projectConfig.github.owner, repo: projectConfig.github.repo };

  // Get issue node ID
  const issue = await client.rest("GET", `/repos/${coords.owner}/${coords.repo}/issues/${issueNumber}`);
  const issueNodeId = issue.node_id;

  // Ensure item exists on the board
  let itemId;
  try {
    const addData = await client.graphql(M_ADD_ISSUE, { projectId: state.projectId, contentId: issueNodeId });
    itemId = addData.addProjectV2ItemById.item.id;
  } catch {
    // Item may already be on the board; query for it
    const board = await getBoard({ client, projectId: state.projectId });
    const existing = board.items.find((i) => i.content?.number === issueNumber);
    if (!existing) return;
    itemId = existing.id;
  }

  await client.graphql(M_UPDATE_STATUS, {
    projectId: state.projectId,
    itemId,
    fieldId: state.statusFieldId,
    optionId,
  });
}

export async function getBoard({ client, projectId }) {
  const data = await client.graphql(Q_PROJECT_ITEMS, { projectId });
  const items = data.node.items?.nodes || [];

  const columns = { Backlog: [], "In Progress": [], Review: [], Done: [] };

  for (const item of items) {
    const status = item.fieldValueByName?.name || "Backlog";
    if (!columns[status]) columns[status] = [];
    columns[status].push({
      id: item.id,
      content: item.content,
    });
  }

  return {
    columns: Object.entries(columns).map(([name, items]) => ({ name, items })),
    items,
  };
}
