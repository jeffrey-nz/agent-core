import { makeRl, askLine, closeRl } from "#app/ui/readline/index.js";

export async function promptRequired(label, existingRl = null) {
  const rl = existingRl || makeRl();
  const shouldClose = !existingRl;

  try {
    const answer = await askLine(rl, `${label} (required): `);
    const t = String(answer ?? "").trim();
    if (!t) throw new Error(`${label} is required (empty input).`);
    return t;
  } finally {
    if (shouldClose) closeRl(rl);
  }
}
