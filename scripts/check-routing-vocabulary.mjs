import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .trim()
  .split("\n");

const immutableMigration =
  /^packages\/api\/drizzle\/(?:meta\/)?00(?:[0-5][0-9]|6[01])_/;
const retiredProductRoutes = new RegExp(
  `(?:${"kaana"}|${"alia"})-(?:lite|v1(?:-[a-z0-9-]+)?)`,
  "g",
);
const failures = [];

for (const file of tracked) {
  if (immutableMigration.test(file)) continue;
  const url = new URL(file, root);
  // `git ls-files --cached` also reports a tracked file deleted in the current
  // change. A deletion cannot introduce retired vocabulary.
  if (!existsSync(url)) continue;
  const source = readFileSync(url, "utf8");
  for (const match of source.matchAll(retiredProductRoutes)) {
    const line = source.slice(0, match.index).split("\n").length;
    failures.push(`${file}:${line}: ${match[0]}`);
  }
}

if (failures.length > 0) {
  console.error("Retired routing vocabulary found:\n" + failures.join("\n"));
  process.exit(1);
}

console.log(`routing-vocabulary: OK — ${tracked.length} tracked files checked`);
