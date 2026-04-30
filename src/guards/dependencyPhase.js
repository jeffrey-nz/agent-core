import { requireFile } from "./requireFile.js";

export function checkDependencyPhase(projectRoot) {
  const composer = requireFile(`${projectRoot}/composer.json`);
  const lock = requireFile(`${projectRoot}/composer.lock`);

  if (!composer.ok || !lock.ok) {
    return {
      ok: false,
      hardBlocker: true,
      message:
        "Dependency phase cannot proceed without readable composer.json and composer.lock",
    };
  }

  return { ok: true };
}
