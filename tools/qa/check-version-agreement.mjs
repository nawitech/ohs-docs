// Checks that pages using the same library setup name the same versions, and
// that they agree with the versions table in docs/fhir-foundations/versions.md.
//
//   node tools/qa/check-version-agreement.mjs [report directory]
//
// versions.md defines setups by which libraries an app uses, not by page.
// - A page that names Kotlin FHIR Engine or Kotlin FHIR Data Capture uses the
//   stack setup. Those libraries must match "Current versions". The model and
//   FHIRPath must match that library's row in "Pairing the libraries".
// - A page that names Kotlin FHIRPath and neither of those uses the FHIRPath
//   setup. FHIRPath matches "Current versions", the model its pairing row.
// - A page that names only the model uses Kotlin FHIR on its own, and must
//   match "Current versions".
// Both tables are read on every run. No version is written here.
//
// A pin that differs fails. The table fails too when a library's version in
// "Pairing the libraries" differs from "Current versions". A different artifact
// of the same library, such as fhir-model where the table says fhir-model-r4,
// is information. If a table cannot be read, the check is blocked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteRoot } from "../scripts/shared.mjs";
import { packageUses, writeReport } from "./lib.mjs";

const tableFile = "docs/fhir-foundations/versions.md";
const VERSION = /[0-9][A-Za-z0-9_.-]*/;

// The library an artifact belongs to. Variants such as -r4 and -jvm are the
// same library.
const familyOf = (artifact) =>
  artifact.startsWith("fhir-data-capture") ? "data-capture"
    : artifact.startsWith("fhir-engine") ? "engine"
      : artifact.startsWith("fhir-model") ? "model"
        : artifact.startsWith("fhir-path") ? "path"
          : null;

// The rows of the first table under a "## " heading.
function tableUnder(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const end = text.indexOf("\n## ", start + 1);
  const rows = text.slice(start, end < 0 ? undefined : end).split("\n").filter((line) => line.startsWith("|"));
  return rows.slice(2).map((row) => row.split("|").slice(1, -1).map((cell) => cell.trim()));
}

const tableText = readFileSync(join(siteRoot, tableFile), "utf8");
const tableErrors = [];

// Current versions. Repository, artifact, version.
const current = {};
const repositoryFamily = [];
const currentRows = tableUnder(tableText, "Current versions");
if (!currentRows) tableErrors.push('No "Current versions" heading');
for (const [repository, artifactCell, versionCell] of currentRows ?? []) {
  const artifact = artifactCell?.match(/`([a-z0-9-]+)`/)?.[1];
  const family = artifact && familyOf(artifact);
  const version = versionCell?.match(VERSION)?.[0];
  if (!family || !version) { tableErrors.push(`Current versions row for ${repository} not read`); continue; }
  current[family] = { artifact, version };
  repositoryFamily.push([repository, family]);
}

// Pairing the libraries. "<repository> <version>", then the artifacts and
// versions it is built against.
const pairing = {};
const pairingRows = tableUnder(tableText, "Pairing the libraries");
if (!pairingRows) tableErrors.push('No "Pairing the libraries" heading');
const byLongestName = [...repositoryFamily].sort((a, b) => b[0].length - a[0].length);
for (const [libraryCell, builtAgainst] of pairingRows ?? []) {
  const match = byLongestName.find(([repository]) => libraryCell?.startsWith(`${repository} `));
  const version = match && libraryCell.slice(match[0].length).trim().match(VERSION)?.[0];
  const pairs = [...(builtAgainst ?? "").matchAll(/`([a-z0-9-]+)`\s+([0-9][A-Za-z0-9_.-]*)/g)]
    .map(([, artifact, pairedVersion]) => ({ family: familyOf(artifact), artifact, version: pairedVersion }));
  if (!match || !version || pairs.length === 0) { tableErrors.push(`Pairing row ${libraryCell} not read`); continue; }
  pairing[match[1]] = { version, builtAgainst: Object.fromEntries(pairs.map((pair) => [pair.family, pair])) };
}
if (Object.keys(current).length < 2) tableErrors.push("Fewer than 2 Current versions rows read");
if (Object.keys(pairing).length < 1) tableErrors.push("No Pairing the libraries rows read");

// The table must agree with itself.
const tableConflicts = Object.entries(pairing)
  .filter(([family, row]) => current[family] && current[family].version !== row.version)
  .map(([family, row]) => ({
    file: tableFile, family, value: `${current[family].artifact} ${row.version} in Pairing the libraries`,
    expected: current[family].version, verdict: "table disagrees",
  }));

// Pins, grouped by page.
const { used, linesScanned } = await packageUses();
const pages = new Map();
for (const use of used) {
  if (!pages.has(use.file)) pages.set(use.file, []);
  pages.get(use.file).push({ ...use, family: familyOf(use.artifact) });
}

// The setup a page uses, and the libraries whose version comes from a pairing row.
function setupOf(pins) {
  const families = new Set(pins.map((pin) => pin.family));
  const tops = ["engine", "data-capture"].filter((family) => families.has(family));
  const setup = tops.length ? "stack" : families.has("path") ? "fhirpath" : "kotlin fhir alone";
  const pairedBy = tops.length ? tops : families.has("path") ? ["path"] : [];
  return { families, setup, pairedBy };
}
const fromCurrent = (family, setup, pairedBy) => pairedBy.includes(family) || setup === "kotlin fhir alone";

// Every table entry a page needs must exist before any pin is judged. A
// missing row or entry is a table error, so the check is blocked rather than
// passing pins it never compared.
for (const [file, pins] of pages) {
  const { families, setup, pairedBy } = setupOf(pins);
  for (const family of families) {
    if (!family) continue;
    if (fromCurrent(family, setup, pairedBy)) {
      if (!current[family]) tableErrors.push(`No Current versions row for ${family}, needed by ${file}`);
    } else {
      for (const top of pairedBy)
        if (!pairing[top]?.builtAgainst[family]) tableErrors.push(`No ${family} entry in the ${top} pairing row, needed by ${file}`);
    }
  }
}

const results = [];
const information = [];
for (const [file, pins] of pages) {
  const { setup, pairedBy } = setupOf(pins);

  for (const pin of pins) {
    let expected = null, expectedFrom = null, expectedArtifact = null;
    // A table that was not read decides nothing, so no pin is judged.
    if (tableErrors.length) {
      results.push({ ...pin, setup, verdict: "not checked" });
      continue;
    }
    if (!pin.family) {
      results.push({ ...pin, setup, verdict: "no rule" });
      continue;
    }
    let verdict;
    if (fromCurrent(pin.family, setup, pairedBy)) {
      expected = current[pin.family].version;
      expectedFrom = "Current versions";
      verdict = pin.version === expected ? "agree" : "disagree";
    } else {
      // A library the page's top libraries are built against. The pin must
      // match every top library's pairing. If two rows pair it differently,
      // no pin can match both, so it disagrees and the note says why.
      const rows = pairedBy.map((top) => pairing[top].builtAgainst[pin.family]);
      const versions = [...new Set(rows.map((row) => row.version))];
      expected = versions.join(" and ");
      expectedFrom = `Pairing the libraries, ${pairedBy.join(" and ")} row`;
      expectedArtifact = rows[0].artifact;
      verdict = rows.every((row) => row.version === pin.version) ? "agree" : "disagree";
      if (versions.length > 1)
        information.push({ file, line: pin.line, note: `${pin.artifact} is paired at ${expected} by the ${pairedBy.join(" and ")} rows, so no version satisfies both` });
    }
    results.push({ ...pin, setup, expected, expectedFrom, verdict });
    const baseArtifact = pin.artifact.replace(/-jvm$/, "");
    if (expectedArtifact && baseArtifact !== expectedArtifact)
      information.push({ file, line: pin.line, note: `names ${pin.artifact} where the table pairs ${expectedArtifact}` });
  }
}

const pick = (verdict) => results.filter((result) => result.verdict === verdict);
for (const error of tableErrors) console.log(`table not read  ${error}`);
for (const conflict of tableConflicts) console.log(`table disagrees  ${conflict.value}, Current versions says ${conflict.expected}`);
for (const result of pick("disagree"))
  console.log(`disagree  ${result.group}:${result.artifact}:${result.version}  expected ${result.expected} from ${result.expectedFrom}  ${result.file}:${result.line}`);
for (const note of information) console.log(`note  ${note.file}:${note.line}  ${note.note}`);
const counts = { linesScanned, pages: pages.size, found: used.length, checked: pick("agree").length + pick("disagree").length, skipped: pick("no rule").length, notChecked: pick("not checked").length };
console.log(
  `Scanned ${linesScanned} lines naming dev.ohs on ${pages.size} pages, found ${used.length} pins, skipped ${counts.skipped} with no rule, ${counts.notChecked} not checked. ` +
    `${pick("disagree").length} disagree, ${tableConflicts.length} table conflicts, ${tableErrors.length} table errors.`,
);
if (used.length === 0) console.log("Found no pins. The extractor may be broken, so this check counts as blocked.");

await writeReport("version-agreement.json", {
  counts, tableFile, tables: { current, pairing }, tableErrors, tableConflicts,
  disagree: pick("disagree"), information, results,
});
if (pick("disagree").length + tableConflicts.length > 0) process.exitCode = 1;
