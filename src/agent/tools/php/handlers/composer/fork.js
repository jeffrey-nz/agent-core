import fs from "node:fs/promises";
import path from "node:path";
import { execAsync } from "#utils/exec.js";

export async function handleComposerFork(input, rootDir) {
  const { package: pkg, version } = input;
  const vendorPath = path.join(rootDir, "vendor", pkg);
  const forkPath = path.join(rootDir, "packages", pkg);

  try {
    await fs.mkdir(path.dirname(forkPath), { recursive: true });
    await execAsync(`cp -a "${vendorPath}" "${forkPath}"`);

    const forkJsonPath = path.join(forkPath, "composer.json");
    const forkContent = JSON.parse(await fs.readFile(forkJsonPath, "utf8"));
    forkContent.version = version;
    await fs.writeFile(forkJsonPath, JSON.stringify(forkContent, null, 4));

    const rootJsonPath = path.join(rootDir, "composer.json");
    const rootContent = JSON.parse(await fs.readFile(rootJsonPath, "utf8"));

    if (!rootContent.repositories) rootContent.repositories = [];
    rootContent.repositories.unshift({
      type: "path",
      url: `packages/${pkg}`,
      options: { symlink: false },
    });

    if (rootContent.require?.[pkg]) rootContent.require[pkg] = `^${version}`;
    await fs.writeFile(rootJsonPath, JSON.stringify(rootContent, null, 4));

    return `[SUCCESS] ${pkg} forked to packages/${pkg} as version ${version}. Root composer.json updated.`;
  } catch (err) {
    return `[ERROR forking ${pkg}]: ${err.message}`;
  }
}
