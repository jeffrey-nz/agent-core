import fs from "node:fs";
import path from "node:path";

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(base, full);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      walk(full, base, out);
    } else {
      out.push({
        path: rel,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  return out;
}

export function snapshotWorkspace(rootDir) {
  return walk(rootDir);
}

export function diffSnapshots(before, after) {
  const map = new Map(before.map((f) => [f.path, f]));
  const changes = [];

  for (const f of after) {
    const prev = map.get(f.path);
    if (!prev) {
      changes.push({ type: "ADDED", path: f.path });
    } else if (prev.mtime !== f.mtime || prev.size !== f.size) {
      changes.push({ type: "MODIFIED", path: f.path });
    }
    map.delete(f.path);
  }

  for (const leftover of map.keys()) {
    changes.push({ type: "DELETED", path: leftover });
  }

  return changes;
}
