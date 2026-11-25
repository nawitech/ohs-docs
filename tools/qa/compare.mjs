// Reads the findings of an earlier docs checks run, so a run can say which of
// its own findings are new. The workflow's comparison step and run.mjs both use
// it, so a summary is judged the same way in both places.
//
//   node tools/qa/compare.mjs --check <summary.json>
//
// --check exits 0 when the file can be compared with, and 1 with the reason
// when it cannot.
//
// The file comes from an earlier run's artifact, so it is treated as outside
// data. Only what a comparison uses is read and checked. Its result, counts,
// dates, line numbers and fail reasons are never used.
//
// Two forms are accepted. Version 1, written before 2026-11-25, has no
// schemaVersion and lists findings in new and known. Version 2 has
// schemaVersion 2 and one findings list, plus blocked, partial and notRun.
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_BYTES = 5_000_000;
export const CHECKS = ["links", "source-paths", "versions", "version-agreement", "lists", "sentence-claims", "commands", "claims", "page-symbols"];
// A key no page or value can forge, since JSON quotes each part.
export const keyOf = (item) => JSON.stringify([item.check, item.page, item.value]);

const words = (value) => typeof value === "string" && value.trim() !== "";
const checkNames = (value) => Array.isArray(value) && value.every((check) => CHECKS.includes(check));

// Returns { findings, blocked, partial, notRun, version } or { error }.
export function readSummary(text) {
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: `the file is over ${MAX_BYTES} bytes` };
  let data;
  try { data = JSON.parse(text); } catch { return { error: "the file is not JSON" }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "the file is not a JSON object" };
  let version, findings, blocked, partial, notRun;
  if (data.schemaVersion === undefined) {
    if (!Array.isArray(data.new) || !Array.isArray(data.known)) return { error: "a version 1 summary needs new and known lists" };
    version = 1;
    findings = [...data.new, ...data.known];
    blocked = data.blocked ?? [];
    // Version 1 lists checks with unread items in unread, blocked ones included.
    partial = (data.unread ?? []).filter((check) => !blocked.includes(check));
    notRun = data.notRun ?? [];
  } else if (data.schemaVersion === 2) {
    if (!Array.isArray(data.findings)) return { error: "a version 2 summary needs a findings list" };
    for (const key of ["blocked", "partial", "notRun"]) if (!Array.isArray(data[key])) return { error: `a version 2 summary needs a ${key} list` };
    version = 2;
    ({ findings, blocked, partial, notRun } = data);
  } else {
    return { error: `schemaVersion ${JSON.stringify(data.schemaVersion)} is not supported` };
  }
  if (!checkNames(blocked) || !checkNames(partial)) return { error: "blocked or partial names a check that does not exist" };
  if (!Array.isArray(notRun) || !notRun.every(words)) return { error: "notRun holds something other than text" };
  const keys = new Set();
  for (const [index, item] of findings.entries()) {
    if (!item || typeof item !== "object") return { error: `finding ${index + 1} is not an object` };
    if (!CHECKS.includes(item.check)) return { error: `finding ${index + 1} names a check that does not exist` };
    if (!words(item.page) || !words(item.value)) return { error: `finding ${index + 1} has no page or no value` };
    const key = keyOf(item);
    if (keys.has(key)) return { error: `finding ${index + 1} has the same check, page and value as another` };
    keys.add(key);
  }
  return { version, findings: findings.map(({ check, page, value }) => ({ check, page, value })), blocked, partial, notRun };
}

export function readSummaryFile(path) {
  try {
    if (statSync(path).size > MAX_BYTES) return { error: `the file is over ${MAX_BYTES} bytes` };
    return readSummary(readFileSync(path, "utf8"));
  } catch {
    return { error: "the file could not be read" };
  }
}

// The step writes comparison.json from GitHub's run data. A comparison is used
// only when both files are valid.
export function readComparison(meta) {
  if (!meta || typeof meta !== "object") return { error: "comparison.json is not an object" };
  if (meta.status === "none") return { status: "none" };
  if (meta.status === "unavailable") return { status: "unavailable", reason: words(meta.reason) ? meta.reason : "no reason given" };
  if (meta.status !== "compared") return { error: "comparison.json has no known status" };
  const numbers = ["runId", "runNumber", "attempt"].every((key) => Number.isInteger(meta[key]) && meta[key] > 0);
  const texts = ["event", "createdAt", "headSha"].every((key) => words(meta[key]));
  if (!numbers || !texts || Number.isNaN(Date.parse(meta.createdAt))) return { error: "comparison.json lacks the run's id, number, attempt, event, time or commit" };
  return { status: "compared", run: { runId: meta.runId, runNumber: meta.runNumber, attempt: meta.attempt, event: meta.event, createdAt: meta.createdAt, headSha: meta.headSha } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const at = process.argv.indexOf("--check");
  if (at < 0 || !process.argv[at + 1]) {
    console.error("Usage: node tools/qa/compare.mjs --check <summary.json>");
    process.exit(2);
  }
  const result = readSummaryFile(process.argv[at + 1]);
  if (result.error) { console.log(`Not usable. ${result.error}.`); process.exit(1); }
  console.log(`Usable. Version ${result.version}, ${result.findings.length} findings.`);
}
