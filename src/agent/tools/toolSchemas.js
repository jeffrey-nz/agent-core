import { zodToJsonSchema } from "zod-to-json-schema";

let _cached = null;

export async function getAllToolJsonSchemas() {
  if (_cached) return _cached;

  const [
    { filesystemTools },
    { searchTools },
    { shellTools },
    { databaseTools },
    { httpTools },
    { phpTools },
    { diagnosticsTools },
    { gitTools },
    { githubTools },
    { memoryTools },
    { browserTools },
  ] = await Promise.all([
    import("./definitions/filesystem.js"),
    import("./definitions/search.js"),
    import("./definitions/shell.js"),
    import("./definitions/database.js"),
    import("./definitions/http.js"),
    import("./definitions/php.js"),
    import("./definitions/diagnostics.js"),
    import("./definitions/git.js"),
    import("./definitions/github.js"),
    import("./definitions/memory.js"),
    import("./definitions/browser.js"),
  ]);

  const allTools = {
    ...filesystemTools,
    ...searchTools,
    ...shellTools,
    ...databaseTools,
    ...httpTools,
    ...phpTools,
    ...diagnosticsTools,
    ...gitTools,
    ...githubTools,
    ...memoryTools,
    ...browserTools,
  };

  const result = {};
  for (const [name, def] of Object.entries(allTools)) {
    result[name] = {
      description: def.description,
      parameters: zodToJsonSchema(def.parameters, {
        target: "openApi3",
        $refStrategy: "none",
      }),
    };
  }

  _cached = result;
  return result;
}
