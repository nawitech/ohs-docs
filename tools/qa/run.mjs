// One invocation, one summary. Runs the checks a repeat run needs and returns
// a short block plus the paths to the evidence.
//
//   node tools/qa/run.mjs <report directory> [--changed | --scheduled | --all] [--drift-only] [--clones <directory>]
//
// --changed   the default. Runs the selector first, then the claims the change
//             touches. Cheap, and the usual case.
// --scheduled links, module names, registry versions, version agreement,
//             lists that match the code, sentence claims and commands. These move without a
//             documentation edit, so they run on a schedule rather than on a diff.
// --all       everything, for a full run or when the setup changed.
// --clones    the folder holding the library clones that check-page-symbols.mjs
//             reads. Without it, --all does not run that check and says so.
//
// A check counts only if it wrote its report during this run. A script that
// stops early, or leaves an older report behind, counts as Blocked, never as
// passed.
//
// The point is that a routine run does not need a reading pass. Read the two or
// three findings this names, and the evidence files behind them, not the logs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, toolsRoot } from "../scripts/shared.mjs";
import { reportDirectory } from "./lib.mjs";

const mode = ["--scheduled", "--all", "--changed"].find((flag) => process.argv.includes(flag)) ?? "--changed";
const driftOnly = process.argv.includes("--drift-only");
const clonesAt = process.argv.indexOf("--clones");
const clones = clonesAt < 0 ? null : process.argv[clonesAt + 1];
const knownAt = process.argv.indexOf("--known");
// The known-findings list sits beside the scripts, so it travels with them to
// the fork. --known points at another copy.
const knownFile = knownAt < 0 ? join(toolsRoot, "qa", "known-findings.json") : process.argv[knownAt + 1];
const knownList = existsSync(knownFile) ? JSON.parse(readFileSync(knownFile, "utf8")) : { entries: [] };
const knownEntries = knownList.entries;
if (!existsSync(knownFile)) console.log(`No known-findings list at ${knownFile}, so every failure counts as new.`);

// The docs commit the run checked. A copy made with git archive has no .git,
// so the workflow passes it in DOCS_COMMIT.
const gitHead = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
const docsCommit = process.env.DOCS_COMMIT || (gitHead.status === 0 ? gitHead.stdout.trim() : "unknown");

// Each confirmed failure in one shape, so it can be matched against the
// known-findings list. One item per check, page and exact value. The lines it
// appears on are listed, not matched, because lines move with every edit.
function failuresOf(check, result) {
  const items = [];
  if (check === "links") {
    for (const r of [...result.broken, ...(result.redirectedToRoot ?? []), ...result.sectionNotFound])
      for (const page of r.usedOn) items.push({ check, page, value: r.url, source: r.verdict === "redirected to root" ? `redirected to ${r.finalUrl}` : `${r.verdict}, status ${r.status ?? r.error}` });
    for (const m of result.missingSections) items.push({ check, page: m.page, value: m.link, source: "page section missing in the build" });
  } else if (check === "source-paths") {
    for (const r of [...result.missing, ...result.notMapped])
      items.push({ check, page: r.file, value: r.module, line: r.line, source: r.checkedAgainst ?? "not in gradle-targets.json" });
  } else if (check === "versions") {
    for (const r of result.results.filter((r) => r.verdict.endsWith("not found")))
      items.push({ check, page: r.file, value: `${r.group}:${r.artifact}:${r.version}`, line: r.line, source: `Maven Central, ${r.verdict}` });
  } else if (check === "version-agreement") {
    for (const r of result.disagree)
      items.push({ check, page: r.file, value: `${r.group}:${r.artifact}:${r.version}`, line: r.line, source: `${result.tableFile}, ${r.expectedFrom}, expects ${r.expected}` });
    for (const r of result.tableConflicts)
      items.push({ check, page: r.file, value: r.value, source: `${r.file}, Current versions says ${r.expected}` });
  } else if (check === "sentence-claims") {
    for (const r of result.results.filter((r) => r.verdict === "mismatch" || r.verdict === "quote gone"))
      items.push({ check, page: r.page, value: `${r.id} ${r.verdict}`, source: `${r.source.list ? `list ${r.source.list} on the page` : `${r.source.repository} ${r.source.path}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}`}, ${r.why}` });
  } else if (check === "commands") {
    for (const r of result.results.filter((r) => r.verdict === "missing" || r.verdict === "not mapped"))
      items.push({ check, page: r.file, value: r.value, line: r.line, source: r.repository ? `${r.repository} at ${result.commits[r.repository]?.slice(0, 7) ?? "local"}, ${r.why}` : r.why });
  } else if (check === "lists") {
    for (const list of result.lists) {
      for (const r of list.missingFromPage)
        items.push({ check, page: list.page, value: `${list.id} ${r.value} not on the page`, source: `in ${list.repository} ${r.file} at ${list.commit.slice(0, 7)}, not on the page` });
      for (const r of list.goneFromCode)
        items.push({ check, page: list.page, value: `${list.id} ${r.value} not in the code`, line: r.line, source: `on the page, not in ${list.repository} at ${list.commit.slice(0, 7)}` });
    }
  }
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.check}|${item.page}|${item.value}`;
    if (!grouped.has(key)) grouped.set(key, { check: item.check, page: item.page, value: item.value, source: item.source, lines: [] });
    if (item.line) grouped.get(key).lines.push(item.line);
  }
  return [...grouped.values()];
}
const matches = (entry, item) => entry.check === item.check && entry.page === item.page && entry.value === item.value;
const newFailures = [], knownFailures = [];
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
const fresh = (name) => {
  const path = join(reportDirectory, name);
  if (!existsSync(path) || statSync(path).mtimeMs < started - 1000) return null;
  return JSON.parse(readFileSync(path, "utf8"));
};
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
  outcomes.push({ check, status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" });
}

// Counting rule: a check passes when it found nothing to act on. "Blocked"
// means it could not decide, which is not the same as finding nothing. A
// check with no report from this run could not decide either.
const review = [];
const information = [];
let passed = 0, failed = 0, blocked = 0;

for (const outcome of outcomes) {
  if (outcome.check === "select") continue;
  const result = fresh(REPORT[outcome.check]);
  if (!result) {
    blocked += 1;
    checkResults[outcome.check] = "blocked";
    const why = firstError(outcome.stderr);
    review.push(`${outcome.check}: no report from this run, exit ${outcome.status}${why ? `, ${why}` : ""}`);
    continue;
  }
  let bad = 0, unknown = 0;
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
    if (c.outsideLinks === 0) unknown = 1;
    if (c.redirected + c.blocked + c.unreachable)
      information.push(`links: ${c.redirected} redirected, ${c.blocked} blocked, ${c.unreachable} unreachable`);
  } else if (outcome.check === "source-paths") {
    bad = result.missing.length + result.notMapped.length;
    unknown = result.unreachable.length + (result.counts.found === 0 ? 1 : 0);
    if (result.unreachable.length) review.push(`source paths: ${result.unreachable.length} not checked, settings file unreachable`);
    if (result.skipped.length) information.push(`source paths: ${result.skipped.length} skipped on pages listed under skip`);
  } else if (outcome.check === "versions") {
    // A version or package that was never published fails. A version neither
    // Maven Central nor the mirror confirmed means the check could not decide.
    // Behind the latest, and versions confirmed on the mirror, are information.
    bad = result.results.filter((r) => r.verdict.endsWith("not found")).length;
    unknown = result.results.filter((r) => r.verdict === "source unreachable").length + (result.counts.found === 0 ? 1 : 0);
    if (unknown) review.push(`versions: ${unknown} not checked, Maven Central and the mirror could not confirm them, or nothing was found`);
    const behind = result.results.filter((r) => r.verdict === "behind").length;
    if (behind) information.push(`versions: ${behind} behind the latest`);
    if (result.counts.fromMirror) information.push(`versions: ${result.counts.fromMirror} packages with versions confirmed on the Google mirror, not judged for latest`);
  } else if (outcome.check === "version-agreement") {
    // Pins that disagree with the versions table, or a table that disagrees
    // with itself, fail. A table that cannot be read means nothing was decided.
    unknown = result.tableErrors.length + (result.counts.found === 0 ? 1 : 0);
    if (result.tableErrors.length) review.push(`version agreement: versions table not read, ${result.tableErrors[0]}`);
    if (result.information.length) information.push(`version agreement: ${result.information.length} notes`);
  } else if (outcome.check === "lists") {
    // A value on one side and not the other fails. A list that could not be
    // read on either side compared nothing.
    unknown = result.counts.errors + (result.counts.lists === 0 ? 1 : 0);
    for (const list of result.lists) if (list.errors.length) review.push(`lists: ${list.id} not compared, ${list.errors[0]}`);
    if (result.counts.covered) information.push(`lists: ${result.counts.covered} parameter paths covered by a parent`);
  } else if (outcome.check === "sentence-claims") {
    // A claim whose source disagrees, or whose quote left the page, fails. A
    // claim that could not be judged, or an empty claims file, is blocked.
    unknown = result.counts.blocked + (result.counts.claims === 0 ? 1 : 0);
    for (const r of result.results.filter((r) => r.verdict === "blocked")) review.push(`sentence claims: ${r.id} not checked, ${r.why}`);
    if (result.counts.claims === 0) review.push("sentence claims: the claims file has no claims");
  } else if (outcome.check === "commands") {
    // A missing file, script, profile or service, or an unmapped page, fails.
    // A value the check could not decide is blocked. Built-ins are information.
    unknown = result.counts.blocked + (result.counts.commands === 0 ? 1 : 0);
    for (const r of result.results.filter((r) => r.verdict === "blocked")) review.push(`commands: ${r.value} on ${r.file}:${r.line} not checked, ${r.why}`);
    if (result.counts.commands === 0) review.push("commands: no commands found");
    if (result.counts.information) information.push(`commands: ${result.counts.information} built-in or need no compose file`);
  } else if (outcome.check === "page-symbols") {
    unknown = (result.errors ?? []).length; if (unknown) review.push(`page symbols: ${unknown} pages not checked, clone missing`);
    bad = result.absent.length; if (bad) review.push(`page symbols: ${bad} names not found`);
  }
  if (["links", "source-paths", "versions", "version-agreement", "lists", "sentence-claims", "commands"].includes(outcome.check)) {
    // Only new failures fail the check. Known ones are listed, not counted.
    const items = failuresOf(outcome.check, result);
    for (const item of items) {
      const entry = knownEntries.find((entry) => matches(entry, item));
      if (entry) knownFailures.push({ id: entry.id, ...item, issue: entry.issue });
      else newFailures.push(item);
    }
    bad = items.filter((item) => !knownEntries.some((entry) => matches(entry, item))).length;
  }
  checkResults[outcome.check] = bad ? "fail" : unknown ? "blocked" : "pass";
  if (bad) failed += 1;
  else if (unknown) blocked += 1;
  else passed += 1;
}

const ranSelect = outcomes.some((outcome) => outcome.check === "select");
const selection = ranSelect ? fresh(REPORT.select) : null;
if (ranSelect && !selection) review.unshift("select: no report from this run, so the changed pages are unknown");
console.log("");
if (selection) console.log(`Changed pages: ${selection.routes.length}${selection.routes.length ? ` (${selection.routes.join(", ")})` : ""}`);
else if (ranSelect) console.log("Changed pages: unknown");
const ranChecks = new Set(outcomes.map((outcome) => outcome.check));
// An entry is stale only when its check completed. A blocked check compared
// nothing, so its entries are not evidence of a fix. The same holds for one
// blocked list inside a lists check that failed on another list.
const blockedLists = new Set((fresh(REPORT.lists)?.lists ?? []).filter((list) => list.errors.length).map((list) => list.id));
const inBlockedList = (entry) => entry.check === "lists" && blockedLists.has(entry.value.split(" ")[0]);
// Likewise for one sentence claim that was blocked while others failed.
const blockedClaims = new Set((fresh(REPORT["sentence-claims"])?.results ?? []).filter((r) => r.verdict === "blocked").map((r) => r.id));
const inBlockedClaim = (entry) => entry.check === "sentence-claims" && blockedClaims.has(entry.value.split(" ")[0]);
// A blocked command proves nothing about the page it is on. Its values may
// not be the ones a known entry names, so every commands entry for that page
// stays, rather than being called stale.
const pagesWithBlockedCommands = new Set((fresh(REPORT.commands)?.results ?? []).filter((r) => r.verdict === "blocked").map((r) => r.file));
const inBlockedCommand = (entry) => entry.check === "commands" && pagesWithBlockedCommands.has(entry.page);
// A link that was blocked or unreachable this run was not judged, so its
// known entry is not stale, even though the links check itself passed.
const linksReport = fresh(REPORT.links);
const unjudgedLinks = [...(linksReport?.blocked ?? []), ...(linksReport?.unreachable ?? [])];
const inBlockedLink = (entry) => entry.check === "links" && unjudgedLinks.some((r) => r.url === entry.value && r.usedOn.includes(entry.page));
// A version or module whose source could not be read was not judged either,
// even when the same check failed on another item, so its entry is not stale.
const unreadVersions = (fresh(REPORT.versions)?.results ?? []).filter((r) => r.verdict === "source unreachable");
const unreadModules = fresh(REPORT["source-paths"])?.unreachable ?? [];
const inUnreadSource = (entry) =>
  (entry.check === "versions" && unreadVersions.some((r) => r.file === entry.page && `${r.group}:${r.artifact}:${r.version}` === entry.value)) ||
  (entry.check === "source-paths" && unreadModules.some((r) => r.file === entry.page && r.module === entry.value));
// A blocked check usually compared nothing, so none of its entries is stale.
// Lists, sentence claims, commands, versions and Gradle modules are blocked
// one item at a time. When
// the report exists and other items were compared, an entry outside the
// blocked items was judged, so it can be stale.
const judgedDespiteBlock = (entry) => {
  const report = fresh(REPORT[entry.check]);
  if (!report) return false;
  if (entry.check === "lists") return report.counts.lists > 0 && !inBlockedList(entry);
  if (entry.check === "sentence-claims") return report.counts.claims > 0 && !inBlockedClaim(entry);
  if (entry.check === "commands") return report.counts.commands > 0 && !inBlockedCommand(entry);
  if (entry.check === "versions") return report.counts.found > 0 && !inUnreadSource(entry);
  if (entry.check === "source-paths") return report.counts.checked > 0 && !inUnreadSource(entry);
  return false;
};
const staleEntries = knownEntries.filter((entry) => ranChecks.has(entry.check) && (checkResults[entry.check] !== "blocked" || judgedDespiteBlock(entry)) && !inBlockedList(entry) && !inBlockedClaim(entry) && !inBlockedCommand(entry) && !inBlockedLink(entry) && !inUnreadSource(entry) && !knownFailures.some((item) => item.id === entry.id));

// Known entries whose issue is not posted yet. A known problem does not fail
// the run, so an entry left unposted would otherwise go unseen. After
// reviewAfterDays it is listed under Review needed. After failAfterDays it is
// overdue and fails the run, because posting is in the checks owner's hands.
// Posted entries and stale entries are not aged. Dates are UTC days, the
// runner's date. An entry dated one day ahead, as a UTC+3 date can be just
// after midnight, counts as added today. QA_TODAY sets the date, for tests only.
const DAY = 86400000;
const today = process.env.QA_TODAY ?? new Date().toISOString().slice(0, 10);
const dateOf = (text) => {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text ? null : time;
};
if (dateOf(today) === null) throw new Error(`QA_TODAY must be a date such as 2026-11-23, not ${today}`);
const setting = (key, fallback) => {
  const value = knownList[key];
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && value > 0) return value;
  review.push(`known findings: ${key} is not a whole number of days, so ${fallback} is used`);
  return fallback;
};
let reviewAfterDays = setting("reviewAfterDays", 7);
let failAfterDays = setting("failAfterDays", 14);
if (failAfterDays < reviewAfterDays) {
  review.push(`known findings: failAfterDays is less than reviewAfterDays, so 7 and 14 are used`);
  [reviewAfterDays, failAfterDays] = [7, 14];
}
const staleIds = new Set(staleEntries.map((entry) => entry.id));
const aging = [], overdue = [];
for (const entry of knownEntries) {
  if (staleIds.has(entry.id) || entry.state === "posted") continue;
  const issue = String(entry.issue ?? "no issue").split("/").pop().replace(/\.md$/, "").match(/^ISSUE-\d+/)?.[0] ?? String(entry.issue ?? "no issue");
  if (entry.state !== "not posted") { review.push(`known findings: ${entry.id} has state "${entry.state}", not "posted" or "not posted"`); continue; }
  const added = dateOf(entry.added);
  if (added === null) { review.push(`known findings: ${entry.id} has no valid added date, so its age is unknown`); continue; }
  const days = Math.floor((dateOf(today) - added) / DAY);
  if (days < -1) { review.push(`known findings: ${entry.id} was added after the run date`); continue; }
  const item = { id: entry.id, issue: entry.issue, label: issue, state: entry.state, added: entry.added, days: Math.max(days, 0) };
  if (item.days >= failAfterDays) overdue.push(item);
  else if (item.days >= reviewAfterDays) aging.push(item);
}
const byIssue = (items) => {
  const counts = new Map();
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => `${label} (${count})`).join(", ");
};
if (aging.length) review.unshift(`${aging.length} known ${aging.length === 1 ? "entry" : "entries"} not posted after ${reviewAfterDays} days: ${byIssue(aging)}`);
const notPosted = knownEntries.filter((entry) => entry.state !== "posted");
const oldest = notPosted.map((entry) => entry.added).filter((added) => dateOf(added) !== null).sort()[0];
const knownStates = notPosted.length ? `, ${notPosted.length} not posted${oldest ? `, oldest added ${oldest}` : ""}` : "";
const result = failed || blocked || notRun.length || overdue.length || (ranSelect && !selection) ? "fail" : "pass";
const name = (item) => `${item.check} ${item.value} on ${item.page}${item.lines?.length ? ` line ${item.lines.join(", ")}` : ""}`;
console.log(`Result: ${result}, docs commit ${docsCommit}`);
console.log(`New: ${newFailures.length ? newFailures.map(name).join("; ") : "nothing"}`);
console.log(`Known: ${knownFailures.length}${knownFailures.length ? ` (${knownFailures.map((item) => item.id).join(", ")})` : ""}${knownStates ? `. The list has ${knownStates.slice(2).replace(" not posted, ", " entries not posted, the ")}` : ""}`);
if (overdue.length) console.log(`Overdue: ${overdue.length} known ${overdue.length === 1 ? "entry" : "entries"} not posted after ${failAfterDays} days: ${byIssue(overdue)}. Post each issue, then set its URL and state "posted" in known-findings.json`);
console.log(`Stale entries: ${staleEntries.length ? staleEntries.map((entry) => entry.id).join(", ") + ". Each matched nothing, so its fix may have merged" : "nothing"}`);
console.log(`Selected: ${passed + failed + blocked} checks`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Blocked: ${blocked}`);
if (notRun.length) console.log(`Not run: ${notRun.join(", ")}`);
console.log(`Review needed: ${review.length ? review.slice(0, 12).join(", ") + (review.length > 12 ? `, and ${review.length - 12} more` : "") : "nothing"}`);
console.log(`Information: ${information.length ? information.join(", ") : "nothing"}`);
if (selection?.steps.length) console.log(`Steps to repeat: ${selection.steps.join(", ")}`);
if (selection?.routes.length) console.log(`Pages to read: ${selection.routes.join(", ")}`);
console.log(`Evidence: ${reportDirectory}/`);
console.log("");
writeFileSync(join(reportDirectory, "summary.json"), JSON.stringify({
  checkedAt: new Date().toISOString(), docsCommit, result, knownFile, checks: checkResults,
  new: newFailures, known: knownFailures, blocked: Object.keys(checkResults).filter((check) => checkResults[check] === "blocked"),
  information, staleEntries, reviewNeeded: review, notRun,
  aging: { today, reviewAfterDays, failAfterDays, review: aging, overdue },
}, null, 2) + "\n");
if (result === "fail") process.exitCode = 1;
