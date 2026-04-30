/*
 * Canonical Project Builder
 *
 * Deterministically merges legacy project sources (meta.json, config.json, project.js)
 * and produces a stable canonical project object.
 */

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// Only use a value as a filesystem path if it's an absolute path string.
// Sentinel strings like "system" in meta.json must not be used as repoPath.
function absPath(val) {
  return typeof val === 'string' && val.startsWith('/') ? val : undefined;
}

function deriveId({ explicitId, parent, folderName }) {
  if (typeof explicitId === 'string' && explicitId.length > 0) return explicitId;
  if (parent && parent.length > 0) return `${parent}/${folderName}`;
  return folderName;
}

export function buildCanonicalProject({
  folderName,
  parent = '',
  dirAbs,
  meta = {},
  config = {},
  project = {},
}) {
  const id = deriveId({
    explicitId: firstDefined(project.id, config.id, meta.id),
    parent,
    folderName,
  });

  const name = firstDefined(
    project.name,
    config.name,
    meta.name,
    project.title,
    config.title,
    folderName
  );

  const title = firstDefined(
    project.title,
    config.title,
    meta.title,
    name
  );

  const repoPath = firstDefined(
    project.repoPath,
    project.targetRepoDir,
    absPath(project.location),
    config.repoPath,
    config.targetRepoDir,
    absPath(config.location),
    meta.repoPath,
    meta.targetRepoDir,
    absPath(meta.location),   // meta.json uses "location" as the repo path field
    dirAbs
  );

  const cheatsheet = firstDefined(
    project.cheatsheet,
    project.cheats,
    config.cheatsheet,
    config.cheats
  );

  // Merge all legacy sources so callers can access project-specific fields
  // (smokeTestUrls, getPrompt, afterSubmit, contextDirs, scopeDir, etc.)
  // without knowing which file defined them. Canonical fields take precedence.
  // Precedence: meta.json → config.json → project.js → canonical overrides.
  const merged = {
    ...meta,
    ...config,
    ...(project || {}),
    id,
    name,
    title,
    repoPath,
    targetRepoDir: repoPath !== dirAbs ? repoPath : undefined,
  };

  return {
    id,
    parent,
    name,
    title,
    repoPath,
    dirAbs,
    cheatsheet,
    // Expose merged as top-level ".project" so config.js and runCopilotFlow.js
    // can continue using chosen.project.X without changes.
    project: merged,
    legacy: {
      meta,
      config,
      project,
    },
  };
}

export default buildCanonicalProject;
