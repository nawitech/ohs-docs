// One invocation, one summary. Runs the checks a repeat run needs and returns
// a short block plus the paths to the evidence.
//
//   node tools/qa/run.mjs <report directory> [--changed | --scheduled | --all] [--drift-only] [--clones <directory>] [--compare <directory>]
//
// --changed   the default. Runs the selector first, then the claims the change
//             touches. Cheap, and the usual case.
// --scheduled links, module names, registry versions, version agreement,
//             lists that match the code, sentence claims and commands. These move without a
//             documentation edit, so they run on a schedule rather than on a diff.
// --all       everything, for a full run or when the setup changed.
// --clones    the folder holding the library clones that check-page-symbols.mjs
//             reads. Without it, --all does not run that check and says so.
// --compare   the folder the workflow's comparison step wrote, with an earlier
//             run's summary.json and comparison.json. Each finding is then
//             marked new or also found. Comparing never changes the result,
//             except with --fail-on touched.
// --touched <touched.json> --fail-on touched
//             the pull request run. touched.json comes from touched.mjs. A
//             finding fails only on a page the pull request touches, and only
//             when main's run in --compare did not have it. An unread item
//             fails on a touched page, or when it belongs to no page. A
//             targets entry that names a page that does not exist fails too.
//
// Every finding fails the run. There is no list of known findings.
//
// A check counts only if it wrote its report during this run. A script that
// stops early, or leaves an older report behind, counts as Blocked, never as
// passed. Each check exits 1 when it has findings. Any other exit except 0 is
// Blocked too, and so is exit 1 with nothing in the report to explain it.
//
// The point is that a routine run does not need a reading pass. Read the two or
// three findings this names, and the evidence files behind them, not the logs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyOf, readComparison, readSummaryFile } from "./compare.mjs";
import { repositoryRoot, toolsRoot } from "../scripts/shared.mjs";
import { reportDirectory } from "./lib.mjs";

const mode = ["--scheduled", "--all", "--changed"].find((flag) => process.argv.includes(flag)) ?? "--changed";
const driftOnly = process.argv.includes("--drift-only");
const clonesAt = process.argv.indexOf("--clones");
const clones = clonesAt < 0 ? null : process.argv[clonesAt + 1];
const compareAt = process.argv.indexOf("--compare");
const compareFolder = compareAt < 0 ? null : process.argv[compareAt + 1];
const touchedAt = process.argv.indexOf("--touched");
const touchedFile = touchedAt < 0 ? null : process.argv[touchedAt + 1];
const failOnAt = process.argv.indexOf("--fail-on");
const failOn = failOnAt < 0 ? "every finding" : process.argv[failOnAt + 1];
if (failOn !== "every finding" && failOn !== "touched") throw new Error(`--fail-on takes touched, not ${failOn}`);
if ((failOn === "touched") !== Boolean(touchedFile)) throw new Error("--touched and --fail-on touched go together");
const pullRequest = failOn === "touched";

// The docs commit the run checked. A copy made with git archive has no .git,
// so the workflow passes it in DOCS_COMMIT.
const gitHead = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
const docsCommit = process.env.DOCS_COMMIT || (gitHead.status === 0 ? gitHead.stdout.trim() : "unknown");

// Each confirmed failure in one shape, so it can be compared with an earlier
// run. One item per check, page and exact value. The lines it appears on are
// listed, not compared, because lines move with every edit.
function failuresOf(check, result) {
  // problem says what is wrong in plain words, built from the report's own
  // fields. source keeps the longer text that names what was compared.
  const items = [];
  if (check === "links") {
    for (const r of [...result.broken, ...(result.redirectedToRoot ?? []), ...result.sectionNotFound]) {
      const problem = r.verdict === "redirected to root" ? `redirects to the site's home page, ${r.finalUrl}`
        : r.verdict === "section not found" ? `the linked page has no section #${r.url.split("#")[1] ?? ""}`
        : r.status ? `answers ${r.status}` : `could not be opened, ${r.error}`;
      for (const page of r.usedOn) items.push({ check, page, value: r.url, problem, source: r.verdict === "redirected to root" ? `redirected to ${r.finalUrl}` : `${r.verdict}, status ${r.status ?? r.error}` });
    }
    for (const m of result.missingSections) items.push({ check, page: m.page, value: m.link, problem: "the section is missing from the built page", source: "page section missing in the build" });
    // A page the route contract lacks, whose links were never read, and a slug
    // that gives no known route. Older reports lack both lists.
    for (const p of result.notInRoutes ?? []) items.push({ check, page: p.route, value: "not in tools/routes.json", problem: "the page is missing from tools/routes.json, so its links are not checked", source: `${p.file}, route ${p.route}` });
    for (const p of result.relativeSlugs ?? []) items.push({ check, page: p.file, value: `slug ${p.slug ?? "missing"}`, problem: "the slug does not start with /, so the page's route is not known", source: p.file });
  } else if (check === "source-paths") {
    for (const r of [...result.missing, ...result.notMapped])
      items.push({ check, page: r.file, value: r.module, line: r.line, problem: r.checkedAgainst ? `not a module in ${r.checkedAgainst}` : "the page is not in gradle-targets.json", source: r.checkedAgainst ?? "not in gradle-targets.json" });
  } else if (check === "versions") {
    for (const r of result.results.filter((r) => r.verdict.endsWith("not found")))
      items.push({ check, page: r.file, value: `${r.group}:${r.artifact}:${r.version}`, line: r.line, problem: r.verdict === "package not found" ? "no such package on Maven Central" : "Maven Central does not list this version", source: `Maven Central, ${r.verdict}` });
  } else if (check === "version-agreement") {
    for (const r of result.disagree)
      items.push({ check, page: r.file, value: `${r.group}:${r.artifact}:${r.version}`, line: r.line, problem: `${result.tableFile.split("/").pop()} expects ${r.expected}`, source: `${result.tableFile}, ${r.expectedFrom}, expects ${r.expected}` });
    for (const r of result.tableConflicts)
      items.push({ check, page: r.file, value: r.value, problem: `the Current versions table says ${r.expected}`, source: `${r.file}, Current versions says ${r.expected}` });
  } else if (check === "sentence-claims") {
    for (const r of result.results.filter((r) => r.verdict === "mismatch" || r.verdict === "quote gone"))
      items.push({ check, page: r.page, value: `${r.id} ${r.verdict}`, problem: r.verdict === "quote gone" ? "the quoted sentence is no longer on the page" : r.why, source: `${r.source.list ? `list ${r.source.list} on the page` : `${r.source.repository} ${r.source.path}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}`}, ${r.why}` });
  } else if (check === "commands") {
    for (const r of result.results.filter((r) => r.verdict === "missing" || r.verdict === "not mapped"))
      items.push({ check, page: r.file, value: r.value, line: r.line, problem: r.repository ? `${r.why}, at ${result.commits[r.repository]?.slice(0, 7) ?? "local"}` : r.why, source: r.repository ? `${r.repository} at ${result.commits[r.repository]?.slice(0, 7) ?? "local"}, ${r.why}` : r.why });
  } else if (check === "lists") {
    for (const list of result.lists) {
      for (const r of list.missingFromPage)
        items.push({ check, page: list.page, value: `${list.id} ${r.value} not on the page`, problem: `in ${list.repository} ${r.file} at ${list.commit.slice(0, 7)}, not on the page`, source: `in ${list.repository} ${r.file} at ${list.commit.slice(0, 7)}, not on the page` });
      for (const r of list.goneFromCode)
        items.push({ check, page: list.page, value: `${list.id} ${r.value} not in the code`, line: r.line, problem: `on the page, not in ${list.repository} at ${list.commit.slice(0, 7)}`, source: `on the page, not in ${list.repository} at ${list.commit.slice(0, 7)}` });
    }
  }
  const grouped = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!grouped.has(key)) grouped.set(key, { check: item.check, page: item.page, value: item.value, problem: item.problem, source: item.source, lines: [] });
    if (item.line) grouped.get(key).lines.push(item.line);
  }
  return [...grouped.values()];
}
const findings = [];
const checkResults = {};

const SETS = {
  "--changed": ["select", "claims"],
  "--scheduled": ["links", "source-paths", "versions", "version-agreement", "lists", "sentence-claims", "commands"],
  "--all": ["select", "links", "source-paths", "versions", "version-agreement", "lists", "sentence-claims", "commands", "page-symbols", "claims"],
};
const SCRIPT = {
  select: "select.mjs", links: "check-links.mjs", "source-paths": "check-source-paths.mjs",
  versions: "check-versions.mjs", "version-agreement": "check-version-agreement.mjs", lists: "check-lists.mjs", "sentence-claims": "check-sentence-claims.mjs", commands: "check-commands.mjs", "page-symbols": "check-page-symbols.mjs", claims: "check-claims.mjs",
};

const REPORT = {
  select: "selection.json", links: "links.json", "source-paths": "source-paths.json",
  versions: "versions.json", "version-agreement": "version-agreement.json", lists: "lists.json", "sentence-claims": "sentence-claims-check.json", commands: "commands.json", "page-symbols": "page-symbols.json", claims: "claims-check.json",
};

// A report counts only if this run wrote it. An older file in the same folder
// is last time's answer, not this one's.
const started = Date.now();
// null means no report from this run, undefined a report that is not JSON.
const fresh = (name) => {
  const path = join(reportDirectory, name);
  if (!existsSync(path) || statSync(path).mtimeMs < started - 1000) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
const firstError = (stderr) => stderr.split("\n").find((line) => /Error\b/.test(line))?.trim().slice(0, 140) ?? "";

const outcomes = [];
const notRun = [];
for (const check of SETS[mode]) {
  if (check === "page-symbols" && !clones) {
    notRun.push("page symbols, which needs --clones <directory>");
    continue;
  }
  const extra = check === "claims" && driftOnly ? ["--drift-only"] : check === "page-symbols" ? [clones] : [];
  const run = spawnSync("node", [join(toolsRoot, "qa", SCRIPT[check]), reportDirectory, ...extra], { encoding: "utf8" });
  outcomes.push({ check, status: run.status, signal: run.signal, error: run.error?.message ?? null, stdout: run.stdout ?? "", stderr: run.stderr ?? "" });
}

// Counting rule: a check passes when it found nothing to act on. "Blocked"
// means it could not decide, which is not the same as finding nothing. A
// check with no report from this run could not decide either.
const review = [];
const information = [];
let passed = 0, failed = 0, blocked = 0;
const unread = new Set();
// Each unread item as { check, page }. page is null for an item that belongs
// to no page, such as a check with no report or a table that was not read.
const unreadItems = [];
// Checks that read some items but not all, for the next run's warning. It
// does not change the result. Unread items already fail the run as blocked.
const partial = new Set();
// Why a check's exit status made it blocked, by check.
const exits = {};
const exitText = (outcome) => outcome.error ? `could not start, ${outcome.error}` : outcome.signal ? `was stopped by ${outcome.signal}` : `exited with status ${outcome.status}`;

for (const outcome of outcomes) {
  if (outcome.check === "select") continue;
  const result = fresh(REPORT[outcome.check]);
  if (!result) {
    blocked += 1;
    checkResults[outcome.check] = "blocked";
    const why = firstError(outcome.stderr);
    exits[outcome.check] = `${result === undefined ? "its report from this run is not valid JSON" : "it wrote no report in this run"}, and it ${exitText(outcome)}${why ? `, ${why}` : ""}`;
    review.push(`${outcome.check}: ${result === undefined ? "report not readable" : "no report from this run"}, exit ${outcome.status ?? outcome.signal ?? "none"}${why ? `, ${why}` : ""}`);
    unread.add(outcome.check);
    unreadItems.push({ check: outcome.check, page: null });
    continue;
  }
  let bad = 0, unknown = 0;
  // A report that is JSON but lacks the fields read below blocks only its own
  // check. What the check added to the lists before the error is taken back.
  const marks = { review: review.length, information: information.length, partial: partial.has(outcome.check) };
  let items = [];
  // The pages of this check's unread items. null for one that has no page.
  let pages = [];
  try {
  if (outcome.check === "claims") {
    unknown = result.results.filter((r) => r.verdict === "blocked").length;
    bad = result.changed.length + result.stale.length + (driftOnly ? 0 : result.open.length);
    review.push(...result.changed, ...result.stale);
    if (!driftOnly && !result.changed.length && !result.stale.length && result.open.length)
      review.push(`${result.open.length} open findings, unchanged. See the issue records, not the log`);
  } else if (outcome.check === "links") {
    // Fail: broken links, redirects to a site's root and sections not found. Information: other redirects,
    // blocked sites and network errors, which prove nothing about the page.
    const c = result.counts;
    bad = c.broken + (c.redirectedToRoot ?? 0) + c.sectionNotFound + c.missingPageSections;
    if (c.outsideLinks === 0) { unknown = 1; pages = [null]; }
    if (c.blocked + c.unreachable) partial.add("links");
    if (c.redirected + c.blocked + c.unreachable)
      information.push(`links: ${c.redirected} redirected, ${c.blocked} blocked, ${c.unreachable} unreachable`);
  } else if (outcome.check === "source-paths") {
    bad = result.missing.length + result.notMapped.length;
    unknown = result.unreachable.length + (result.counts.found === 0 ? 1 : 0);
    pages = [...result.unreachable.map((r) => r.file), ...(result.counts.found === 0 ? [null] : [])];
    if (result.unreachable.length) review.push(`source paths: ${result.unreachable.length} not checked, settings file unreachable`);
    if (result.skipped.length) information.push(`source paths: ${result.skipped.length} skipped on pages listed under skip`);
  } else if (outcome.check === "versions") {
    // A version or package that was never published fails. A version neither
    // Maven Central nor the mirror confirmed means the check could not decide.
    // Behind the latest, and versions confirmed on the mirror, are information.
    bad = result.results.filter((r) => r.verdict.endsWith("not found")).length;
    unknown = result.results.filter((r) => r.verdict === "source unreachable").length + (result.counts.found === 0 ? 1 : 0);
    pages = [...result.results.filter((r) => r.verdict === "source unreachable").map((r) => r.file), ...(result.counts.found === 0 ? [null] : [])];
    if (unknown) review.push(`versions: ${unknown} not checked, Maven Central and the mirror could not confirm them, or nothing was found`);
    const behind = result.results.filter((r) => r.verdict === "behind").length;
    if (behind) information.push(`versions: ${behind} behind the latest`);
    if (result.counts.fromMirror) information.push(`versions: ${result.counts.fromMirror} packages with versions confirmed on the Google mirror, not judged for latest`);
  } else if (outcome.check === "version-agreement") {
    // Pins that disagree with the versions table, or a table that disagrees
    // with itself, fail. A table that cannot be read means nothing was decided.
    unknown = result.tableErrors.length + (result.counts.found === 0 ? 1 : 0);
    // The versions table serves every page, so an error in it has no page.
    pages = unknown ? [null] : [];
    if (result.tableErrors.length) review.push(`version agreement: versions table not read, ${result.tableErrors[0]}`);
    if (result.information.length) information.push(`version agreement: ${result.information.length} notes`);
  } else if (outcome.check === "lists") {
    // A value on one side and not the other fails. A list that could not be
    // read on either side compared nothing.
    unknown = result.counts.errors + (result.counts.lists === 0 ? 1 : 0);
    pages = [...result.lists.filter((list) => list.errors.length).map((list) => list.page), ...(result.counts.lists === 0 ? [null] : [])];
    for (const list of result.lists) if (list.errors.length) review.push(`lists: ${list.id} not compared, ${list.errors[0]}`);
    if (result.counts.covered) information.push(`lists: ${result.counts.covered} parameter paths covered by a parent`);
  } else if (outcome.check === "sentence-claims") {
    // A claim whose source disagrees, or whose quote left the page, fails. A
    // claim that could not be judged, or an empty claims file, is blocked.
    unknown = result.counts.blocked + (result.counts.claims === 0 ? 1 : 0);
    pages = [...result.results.filter((r) => r.verdict === "blocked").map((r) => r.page), ...(result.counts.claims === 0 ? [null] : [])];
    for (const r of result.results.filter((r) => r.verdict === "blocked")) review.push(`sentence claims: ${r.id} not checked, ${r.why}`);
    if (result.counts.claims === 0) review.push("sentence claims: the claims file has no claims");
  } else if (outcome.check === "commands") {
    // A missing file, script, profile or service, or an unmapped page, fails.
    // A value the check could not decide is blocked. Built-ins are information.
    unknown = result.counts.blocked + (result.counts.commands === 0 ? 1 : 0);
    pages = [...result.results.filter((r) => r.verdict === "blocked").map((r) => r.file), ...(result.counts.commands === 0 ? [null] : [])];
    for (const r of result.results.filter((r) => r.verdict === "blocked")) review.push(`commands: ${r.value} on ${r.file}:${r.line} not checked, ${r.why}`);
    if (result.counts.commands === 0) review.push("commands: no commands found");
    if (result.counts.information) information.push(`commands: ${result.counts.information} built-in or need no compose file`);
  } else if (outcome.check === "page-symbols") {
    unknown = (result.errors ?? []).length; pages = unknown ? [null] : []; if (unknown) review.push(`page symbols: ${unknown} pages not checked, clone missing`);
    bad = result.absent.length; if (bad) review.push(`page symbols: ${bad} names not found`);
  }
  if (["links", "source-paths", "versions", "version-agreement", "lists", "sentence-claims", "commands"].includes(outcome.check)) {
    // Every finding fails the check.
    items = failuresOf(outcome.check, result);
    bad = items.length;
  }
  // A count the report lacks makes NaN, which would read as nothing found.
  if (!Number.isFinite(bad) || !Number.isFinite(unknown)) throw new Error("a count it needs is missing or not a number");
  } catch (error) {
    review.length = marks.review;
    information.length = marks.information;
    if (!marks.partial) partial.delete(outcome.check);
    blocked += 1;
    checkResults[outcome.check] = "blocked";
    exits[outcome.check] = `its report from this run lacks fields the summary needs, and it ${exitText(outcome)}`;
    review.push(`${outcome.check}: report has the wrong shape, ${oneLine(error.message)}`);
    unread.add(outcome.check);
    unreadItems.push({ check: outcome.check, page: null });
    continue;
  }
  findings.push(...items);
  // Exit 1 means findings. With none in the report and nothing unread, the
  // report does not explain the exit. Any other status, a signal or a start
  // error is blocked even when there are findings, which still fail the run.
  const normal = outcome.status === 0 || (outcome.status === 1 && (bad || unknown));
  if (!normal) {
    exits[outcome.check] = outcome.status === 1 ? "it exited with status 1, but its report shows no findings and nothing unread" : `it ${exitText(outcome)}`;
    review.push(`${outcome.check}: ${exits[outcome.check]}`);
    unknown = Math.max(unknown, 1);
    pages.push(null);
  }
  // A count with no page behind it, such as a mismatch between the counts and
  // the lists, has no page either.
  if (unknown && !pages.length) pages = [null];
  for (const page of new Set(pages)) unreadItems.push({ check: outcome.check, page: typeof page === "string" ? page : null });
  checkResults[outcome.check] = bad ? "fail" : unknown ? "blocked" : "pass";
  // A check that failed can still have items it could not read. It counts as
  // blocked too in the reasons the run did not pass.
  if (unknown) unread.add(outcome.check);
  if (unknown && checkResults[outcome.check] !== "blocked") partial.add(outcome.check);
  if (bad) failed += 1;
  else if (unknown) blocked += 1;
  else passed += 1;
}
for (const check of Object.keys(checkResults)) if (checkResults[check] === "blocked") partial.delete(check);

const ranSelect = outcomes.some((outcome) => outcome.check === "select");
const selection = ranSelect ? fresh(REPORT.select) : null;
if (ranSelect && !selection) review.unshift("select: no report from this run, so the changed pages are unknown");
console.log("");
if (selection) console.log(`Changed pages: ${selection.routes.length}${selection.routes.length ? ` (${selection.routes.join(", ")})` : ""}`);
else if (ranSelect) console.log("Changed pages: unknown");
// The earlier run to compare with. Its findings are matched on check, page
// and value. Only its findings and its lists of incomplete checks are used.
let comparison;
if (!compareFolder) comparison = { status: "unavailable", reason: "no comparison folder was given" };
else {
  const metaPath = join(compareFolder, "comparison.json");
  let meta = null;
  try { meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null; } catch { meta = undefined; }
  const read = meta ? readComparison(meta) : null;
  if (!meta) comparison = { status: "unavailable", reason: meta === null ? "the comparison step did not finish" : "the comparison files are not valid" };
  else if (read.error) comparison = { status: "unavailable", reason: "the comparison files are not valid", detail: read.error };
  else if (read.status !== "compared") comparison = read;
  else {
    const earlier = readSummaryFile(join(compareFolder, "summary.json"));
    if (earlier.error) comparison = { status: "unavailable", reason: "the comparison files are not valid", detail: earlier.error };
    else {
      comparison = { status: "compared", ...read.run, version: earlier.version, blocked: earlier.blocked, partial: earlier.partial, notRun: earlier.notRun };
      const before = new Set(earlier.findings.map(keyOf));
      for (const item of findings) item.new = !before.has(keyOf(item));
    }
  }
}
if (comparison.status !== "compared") for (const item of findings) item.new = null;
const newCount = findings.filter((item) => item.new === true).length;

// The pull request run. Which pages the pull request touches, and whether a
// finding main's run had can be excused. Each doubt fails closed, so nothing
// is excused.
let touched = null;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
if (pullRequest) {
  let data = null;
  try { data = JSON.parse(readFileSync(touchedFile, "utf8")); } catch { data = null; }
  const strings = (list) => Array.isArray(list) && list.every((item) => typeof item === "string");
  const valid = data && typeof data.all === "boolean" && strings(data.files) && strings(data.routes) && strings(data.reasons ?? []) && Array.isArray(data.missingPages);
  if (!valid) review.unshift("touched pages: touched.json is missing or not valid, so every page counts as touched");
  const t = valid ? data : { all: true, reasons: ["touched.json is missing or not valid"], files: [], routes: [], removed: [] };
  const files = new Set(t.files), routes = new Set(t.routes);
  const main = t.mainChanged && strings(t.mainChanged.files) && strings(t.mainChanged.routes) ? t.mainChanged : null;
  const changedOnMain = new Set([...(main?.files ?? []), ...(main?.routes ?? [])]);
  // Why nothing can be excused, or null when a finding main's run had can be.
  let earlierDocsCommit = null;
  try { earlierDocsCommit = JSON.parse(readFileSync(join(compareFolder, "summary.json"), "utf8")).docsCommit ?? null; } catch { earlierDocsCommit = null; }
  const headSha = comparison.headSha ?? "";
  const noWaiver = comparison.status !== "compared" ? `not compared with main, ${comparison.status === "none" ? "main has no earlier run" : comparison.reason}`
    : !valid ? "the touched pages are unknown"
    : !t.since || t.since !== headSha ? "the files main changed since its run are unknown"
    : !t.sinceOk ? "the commit main's run checked could not be read"
    : typeof earlierDocsCommit !== "string" || !/^[0-9a-f]{7,40}$/.test(earlierDocsCommit) || !headSha.startsWith(earlierDocsCommit) ? "main's run checked a docs commit other than the one it ran on"
    : t.mainChangedAll || !main ? `main changed a file that affects every page since its run${t.mainChangedReasons?.[0] ? `, ${t.mainChangedReasons[0]}` : ""}`
    : null;
  const isTouched = (page) => t.all || files.has(page) || routes.has(page);
  for (const item of findings) {
    item.touched = isTouched(item.page);
    item.changedOnMain = changedOnMain.has(item.page);
    item.onMain = !noWaiver && item.new === false && !item.changedOnMain;
  }
  const removed = Array.isArray(t.removed) ? t.removed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.page === "string") : [];
  // Targets entries that name a page that does not exist. Each fails the run.
  const missingPages = (t.missingPages ?? []).map((entry) => ({
    file: typeof entry?.file === "string" ? entry.file : "a targets file", kind: typeof entry?.kind === "string" ? entry.kind : "entry",
    id: typeof entry?.id === "string" ? entry.id : null, page: typeof entry?.page === "string" ? entry.page : null,
  }));
  touched = {
    all: t.all, reasons: t.reasons ?? [], files: t.files, routes: t.routes, removed, missingPages, valid: Boolean(valid),
    since: t.since ?? null, mainChanged: main ?? { files: [], routes: [] }, noWaiver,
    failing: findings.filter((item) => item.touched && !item.onMain).length,
    onMain: findings.filter((item) => item.touched && item.onMain).length,
    otherPages: findings.filter((item) => !item.touched).length,
    unread: unreadItems.filter((item) => item.page === null || isTouched(item.page)),
  };
}

// Every reason the run did not pass, in the order the summary names them.
const failReasons = [];
const runLabel = comparison.status === "compared" ? `run ${comparison.runNumber}` : null;
if (pullRequest) {
  if (touched.failing) failReasons.push({ reason: "touched", count: touched.failing, text: `${plural(touched.failing, "finding")} on pages this pull request touches` });
  const checks = [...new Set(touched.unread.map((item) => item.check))];
  if (checks.length) failReasons.push({ reason: "unread", checks, count: touched.unread.length, text: `${plural(checks.length, "check")} could not read every item` });
  const missing = touched.missingPages.length;
  if (missing) failReasons.push({ reason: "missing page", count: missing, text: `${plural(missing, "targets entry", "targets entries")} ${missing === 1 ? "names" : "name"} a page that does not exist` });
} else if (findings.length) failReasons.push({ reason: "findings", count: findings.length, new: runLabel ? newCount : null, text: `${plural(findings.length, "finding")}${runLabel ? `, ${newCount || "none"} new compared with ${runLabel}` : ""}` });
// Claims and page symbols fail without findings this summary lists.
const failedOther = Object.keys(checkResults).filter((check) => checkResults[check] === "fail" && !findings.some((item) => item.check === check));
if (failedOther.length) failReasons.push({ reason: "failed", checks: failedOther, text: `${failedOther.join(" and ")} failed` });
if (!pullRequest && unread.size) failReasons.push({ reason: "blocked", checks: [...unread], text: `${plural(unread.size, "check")} blocked` });
if (notRun.length) failReasons.push({ reason: "not run", count: notRun.length, text: `${plural(notRun.length, "check")} did not run` });
if (ranSelect && !selection) failReasons.push({ reason: "no selection", text: "the changed pages are unknown" });
const result = failReasons.length ? "fail" : "pass";

const name = (item) => `${item.check} ${item.value} on ${item.page}${item.lines?.length ? ` line ${item.lines.join(", ")}` : ""}`;
const compared = comparison.status === "compared" ? `run ${comparison.runNumber}, ${comparison.createdAt}` : comparison.status === "none" ? "no earlier run" : `unavailable, ${comparison.reason}`;
console.log(`Result: ${result}, docs commit ${docsCommit}`);
if (failReasons.length) console.log(`Why: ${failReasons.map((r) => r.text).join(", ")}`);
console.log(`Compared with: ${compared}`);
if (pullRequest) {
  console.log(`Touched: ${touched.all ? `every page, ${touched.reasons.join(", ")}` : `${plural(touched.files.length, "file")}${touched.routes.length ? ` (${touched.routes.join(", ")})` : ""}`}`);
  console.log(`On touched pages: ${touched.failing} to fix, ${touched.onMain} already on main${touched.noWaiver ? `. Nothing excused, ${touched.noWaiver}` : ""}`);
  console.log(`On other pages: ${touched.otherPages}`);
  if (touched.removed.length) console.log(`Checks removed: ${touched.removed.map((entry) => `${entry.kind} ${entry.id} for ${entry.page}`).join(", ")}`);
  if (touched.missingPages.length) console.log(`Missing pages: ${touched.missingPages.map((entry) => `${entry.kind} ${entry.id ?? "without an id"} in ${entry.file} names ${entry.page ?? "no page"}`).join(", ")}`);
}
if (runLabel) console.log(`New: ${newCount ? findings.filter((item) => item.new).map(name).join("; ") : "nothing"}`);
console.log(`Findings: ${findings.length ? findings.map(name).join("; ") : "nothing"}`);
const blockedChecks = Object.keys(checkResults).filter((check) => checkResults[check] === "blocked" || (exits[check] && unread.has(check)));
console.log(`Selected: ${passed + failed + blocked} checks`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Blocked: ${blockedChecks.length}${blockedChecks.length ? ` (${blockedChecks.join(", ")})` : ""}`);
if (notRun.length) console.log(`Not run: ${notRun.join(", ")}`);
console.log(`Review needed: ${review.length ? review.slice(0, 12).join(", ") + (review.length > 12 ? `, and ${review.length - 12} more` : "") : "nothing"}`);
console.log(`Information: ${information.length ? information.join(", ") : "nothing"}`);
if (selection?.steps.length) console.log(`Steps to repeat: ${selection.steps.join(", ")}`);
if (selection?.routes.length) console.log(`Pages to read: ${selection.routes.join(", ")}`);
console.log(`Evidence: ${reportDirectory}/`);
console.log("");
// The commit of the checks themselves, the fork commit GitHub ran.
const checksCommit = /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null;
writeFileSync(join(reportDirectory, "summary.json"), JSON.stringify({
  schemaVersion: 2, checkedAt: new Date().toISOString(), docsCommit, checksCommit, failOn, result, failReasons, checks: checkResults,
  findings, blocked: blockedChecks, partial: [...partial].filter((check) => !blockedChecks.includes(check)), unread: [...unread], unreadItems, exits, notRun, reviewNeeded: review, information, comparison,
  ...(touched ? { touched } : {}),
}, null, 2) + "\n");
// Plain sentences for the workflow to show if job-summary.mjs fails.
// Each sentence comes from a reason's own text, so no reason is assumed to be
// first. A findings reason has no checks, so it reads as before.
const sentences = [result === "fail" ? "The run failed." : findings.length ? "The run passed. Nothing to fix on the pages this pull request touches." : "The run passed. No findings."];
for (const r of failReasons) sentences.push(`${r.text.charAt(0).toUpperCase()}${r.text.slice(1)}${r.checks ? `, ${r.checks.join(", ")}` : ""}.`);
if (pullRequest) {
  sentences.push(comparison.status === "compared" ? `Compared with main's run ${comparison.runNumber}.` : `Not compared with main, ${comparison.status === "none" ? "main has no earlier run" : comparison.reason}.`);
  if (touched.noWaiver && comparison.status === "compared") sentences.push(`No finding was excused as already on main, because ${touched.noWaiver}.`);
  sentences.push(touched.all ? "This pull request changes files that affect every page." : `This pull request touches ${plural(touched.files.length, "page")}.`);
  if (touched.otherPages) sentences.push(`${plural(touched.otherPages, "finding")} on other pages ${touched.otherPages === 1 ? "is" : "are"} not this pull request's to fix.`);
} else sentences.push(comparison.status === "compared" ? `Compared with run ${comparison.runNumber}.` : comparison.status === "none" ? "No earlier run to compare with." : `Comparison unavailable, ${comparison.reason}.`);
sentences.push(`The docs commit was ${docsCommit}. Every finding is in summary.json.`);
writeFileSync(join(reportDirectory, "fallback.txt"), sentences.join("\n") + "\n");
if (result === "fail") process.exitCode = 1;
