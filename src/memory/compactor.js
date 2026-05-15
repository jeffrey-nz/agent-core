/**
 * Conversation compactor — when the LangGraph `state.messages` grows past a
 * soft size threshold, summarise the oldest middle slice into a single
 * "## Conversation summary" message and drop the originals. The very first
 * messages (task + initial context) and the most-recent slice are preserved
 * verbatim so the agent never loses fresh context.
 *
 * Mirrors how Claude Code's auto-compact behaves on its own context window:
 * - The system prompt and the original user request stay anchored.
 * - The middle (oldest non-essential turns) gets collapsed.
 * - The tail (recent reasoning + tool I/O) is kept verbatim.
 */

const DEFAULT_KEEP_HEAD = 2;
const DEFAULT_KEEP_TAIL = 6;

/**
 * Estimate the character cost of a message. Tool outputs can be huge so
 * count the full content length.
 */
function msgChars(m) {
  if (!m) return 0;
  if (typeof m.content === "string") return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce(
      (n, p) => n + (typeof p === "string" ? p.length : JSON.stringify(p).length),
      0,
    );
  }
  return JSON.stringify(m).length;
}

export function totalChars(messages) {
  let n = 0;
  for (const m of messages || []) n += msgChars(m);
  return n;
}

/**
 * Decides whether compaction is needed.
 * @param {Array} messages
 * @param {object} opts
 *   - softCapChars: total content size at which compaction triggers
 *   - minMessages: don't compact unless there are at least this many messages
 */
export function shouldCompact(messages, { softCapChars = 80_000, minMessages = 12 } = {}) {
  if (!Array.isArray(messages) || messages.length < minMessages) return false;
  return totalChars(messages) > softCapChars;
}

/**
 * Builds a single "summary" message from a slice of older messages without
 * involving the LLM. Pure text concatenation with role labels and length
 * truncation — deterministic and free.
 *
 * For higher-quality compaction the caller can pass an `aiSummarise` function
 * that takes (text) → Promise<text>; if provided and the slice is large
 * enough, we use it. Otherwise we fall back to the deterministic summary.
 */
async function summariseSlice(slice, { aiSummarise = null, maxChars = 4000 } = {}) {
  const lines = [];
  let total = 0;
  for (const m of slice) {
    const role = m.role || "(?)";
    const content = typeof m.content === "string"
      ? m.content
      : JSON.stringify(m.content);
    const truncated = content.length > 600 ? content.slice(0, 600) + " …[truncated]" : content;
    const line = `- **${role}**: ${truncated.replace(/\n+/g, " ")}`;
    lines.push(line);
    total += line.length;
    if (total > maxChars) {
      lines.push(`- _(${slice.length - lines.length + 1} older messages omitted to fit budget)_`);
      break;
    }
  }

  const deterministic = lines.join("\n");

  if (aiSummarise) {
    try {
      const better = await aiSummarise(deterministic);
      if (better && better.trim().length > 0) return better.trim();
    } catch {
      // fall through to deterministic
    }
  }
  return deterministic;
}

/**
 * Compacts a message array. Returns a NEW array; does not mutate input.
 * The compaction inserts a single synthetic user message immediately after
 * the head slice:
 *   { role: "user", content: "## Conversation summary (auto-compacted)\n\n..." }
 *
 * @param {Array} messages
 * @param {object} opts
 *   - keepHead: how many leading messages to keep verbatim (default 2)
 *   - keepTail: how many trailing messages to keep verbatim (default 6)
 *   - aiSummarise: optional async (text) → text for higher-quality summary
 *   - maxSummaryChars: cap on the generated summary block
 */
export async function compactMessages(
  messages,
  {
    keepHead = DEFAULT_KEEP_HEAD,
    keepTail = DEFAULT_KEEP_TAIL,
    aiSummarise = null,
    maxSummaryChars = 4000,
  } = {},
) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (messages.length <= keepHead + keepTail + 1) return messages;

  const head = messages.slice(0, keepHead);
  const tail = messages.slice(-keepTail);
  const middle = messages.slice(keepHead, messages.length - keepTail);

  if (middle.length === 0) return messages;

  const summary = await summariseSlice(middle, { aiSummarise, maxChars: maxSummaryChars });

  const summaryMsg = {
    role: "user",
    content:
      `## Conversation summary (auto-compacted — ${middle.length} older messages collapsed)\n\n` +
      summary +
      `\n\n_Continue the task from here. The recent turns below have the active state._`,
  };

  return [...head, summaryMsg, ...tail];
}
