// Back-compat entrypoint ONLY.
// IMPORTANT: package.json import-map maps #projects/* -> ./projects/* (NOT ./src/projects/*).
// Canonical discovery lives at /projects/index.js -> /projects/discover.js (buildCanonicalProject).
// Do not introduce a second discovery shape here.

export { discoverProjects } from "../../projects/discover.js";
export { runBuildSteps } from "../../projects/lib/runBuildSteps.js";
