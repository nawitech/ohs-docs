// Checks that every Gradle module named in a command on a page exists in the
// repository that command runs in.
//
//   node tools/qa/check-source-paths.mjs [report directory]
//
// gradle-targets.json says which repository and settings file each page's
// commands belong to. The source of truth is that settings file on the
// repository's default branch. A page with a module command that is not in the
// map fails as "not mapped", so a new page cannot pass by accident. Pages under
// "skip" are counted as skipped, with their reason.
//
// A settings file that cannot be fetched makes its uses "unreachable". That is
// reported apart from a missing module, because it proves nothing about the page.
// Links to files in a repository are covered by check-links.mjs, which opens them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolsRoot } from "../scripts/shared.mjs";
import { request, sourcePages, writeReport } from "./lib.mjs";

const targets = JSON.parse(readFileSync(join(toolsRoot, "qa", "gradle-targets.json"), "utf8"));

// One fetch per settings file. A failed fetch is recorded, not dropped.
const settings = new Map();
async function modulesFor({ repository, settings: path }) {
  const key = `${repository}/${path}`;
  if (settings.has(key)) return settings.get(key);
  const url = `https://raw.githubusercontent.com/${repository}/HEAD/${path}`;
  let entry;
  try {
    const response = await request(url);
    if (!response.ok) entry = { url, error: `status ${response.status}` };
    else {
      // Drop comments first, so a commented-out include does not count. Gradle
      // accepts a module name with or without the leading colon.
      const code = (await response.text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const modules = [...code.matchAll(/\binclude\(([^)]*)\)/g)]
        .flatMap(([, list]) => [...list.matchAll(/"([^"]+)"/g)].map(([, module]) => (module.startsWith(":") ? module : `:${module}`)));
      entry = { url, modules: new Set(modules) };
    }
  } catch (error) {
    entry = { url, error: String(error.cause?.code ?? error.message) };
  }
  settings.set(key, entry);
  return entry;
}

let linesScanned = 0;
const uses = [];
for (const { file, text } of await sourcePages()) {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!/gradlew?\b/.test(line)) continue;
    linesScanned += 1;
    for (const [, module] of line.matchAll(/\s(:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*):[A-Za-z]/g))
      uses.push({ file, line: index + 1, module });
  }
}

const results = [];
for (const use of uses) {
  if (targets.skip[use.file]) {
    results.push({ ...use, verdict: "skipped", reason: targets.skip[use.file] });
    continue;
  }
  const target = targets.pages[use.file];
  if (!target) {
    results.push({ ...use, verdict: "not mapped" });
    continue;
  }
  const entry = await modulesFor(target);
  const checkedAgainst = `${target.repository}/${target.settings}`;
  if (entry.error) results.push({ ...use, checkedAgainst, verdict: "unreachable", error: entry.error });
  else results.push({ ...use, checkedAgainst, verdict: entry.modules.has(use.module) ? "found" : "missing" });
}

const pick = (verdict) => results.filter((result) => result.verdict === verdict);
const counts = {
  linesScanned,
  found: uses.length,
  checked: pick("found").length + pick("missing").length,
  skipped: pick("skipped").length,
};
for (const result of results.filter((result) => !["found", "skipped"].includes(result.verdict)))
  console.log(`${result.verdict}  ${result.module}  ${result.file}:${result.line}${result.checkedAgainst ? `  against ${result.checkedAgainst}` : ""}${result.error ? `  ${result.error}` : ""}`);
console.log(
  `Scanned ${linesScanned} Gradle lines, found ${uses.length} module uses, skipped ${counts.skipped} on pages listed under skip. ` +
    `${pick("missing").length} missing, ${pick("not mapped").length} not mapped, ${pick("unreachable").length} unreachable.`,
);
if (uses.length === 0) console.log("Found no module uses. The extractor may be broken, so this check counts as blocked.");

await writeReport("source-paths.json", {
  counts,
  settings: Object.fromEntries([...settings].map(([key, entry]) => [key, entry.error ? { url: entry.url, error: entry.error } : { url: entry.url, modules: [...entry.modules] }])),
  missing: pick("missing"),
  notMapped: pick("not mapped"),
  unreachable: pick("unreachable"),
  skipped: pick("skipped"),
  found: pick("found"),
});
if (pick("missing").length + pick("not mapped").length > 0) process.exitCode = 1;
