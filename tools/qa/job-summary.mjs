// Writes the job summary for a docs checks run, from the reports that run.mjs
// and the checks wrote.
//
//   node tools/qa/job-summary.mjs <reports folder> > summary.md
//
// The summary says what to do first, then lists every new finding with its page,
// value and the source it was compared with, so a person can act without opening
// the JSON files. Known findings and information are folded at the end.
//
// It reads only the reports folder and imports nothing from the docs checkout,
// so the workflow can call it even when the build failed.
//
// Safety. Every table, list and paragraph is a raw HTML block with no blank line
// inside, so GitHub does not read Markdown in it. Strikethrough, autolinks and
// table pipes in page text stay literal. Every value from a page, a source or a
// report is HTML-escaped, cut to MAX_VALUE characters, and written on one line.
// A link is written only for an http or https address. The whole summary stays
// under BUDGET bytes, below GitHub's 1 MiB limit for one step.
//
// DOCS_REPO, SITE_ORIGIN and ARTIFACT_NAME can override the defaults below. On
// GitHub, GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID give the run link.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: node tools/qa/job-summary.mjs <reports folder>");
  process.exit(2);
}
const DOCS_REPO = process.env.DOCS_REPO ?? "ohs-foundation/ohs-docs";
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://ohs-foundation.github.io";
const ARTIFACT = process.env.ARTIFACT_NAME ?? "the run's artifact";
const RUN_URL = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;
const ROWS = 50;
const MAX_VALUE = 300;
const BUDGET = 900_000;
const DAY = 86400000;

// Escaping and building blocks.
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const cut = (value) => { const s = oneLine(value); return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}...` : s; };
const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const text = (value) => escapeHtml(cut(value));
const code = (value) => `<code>${text(value)}</code>`;
const safeUrl = (url) => {
  // A very long address is shown as text only, so one value cannot fill the summary.
  try { const u = new URL(oneLine(url)); return ["http:", "https:"].includes(u.protocol) && u.href.length <= 2000 ? u.href : null; } catch { return null; }
};
const link = (url, label) => {
  const href = safeUrl(url);
  return href ? `<a href="${escapeHtml(href).replaceAll("|", "%7C")}">${label}</a>` : label;
};
const heading = (title) => `<h3>${title}</h3>`;
const para = (html) => `<p>${html}</p>`;
const list = (items) => `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
const table = (head, rows) => {
  const shown = rows.slice(0, ROWS);
  const body = shown.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  const more = rows.length > ROWS ? `\n<p>And ${rows.length - ROWS} more. The full list is in the reports.</p>` : "";
  return `<table>\n<tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>\n${body}\n</table>${more}`;
};
const folded = (summary, blocks) => `<details><summary>${summary}</summary>\n${blocks.join("\n")}\n</details>`;

const blocks = [];
const add = (block) => blocks.push(block);
const read = (name) => {
  const path = join(folder, name);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};
const finish = (footer) => {
  // Keep whole blocks while they fit the budget, then say what was left out.
  const out = [];
  let bytes = Buffer.byteLength(footer) + 400;
  for (const [index, block] of blocks.entries()) {
    const size = Buffer.byteLength(block) + 2;
    if (bytes + size > BUDGET) {
      out.push(para(`The summary was cut to fit GitHub's size limit. ${blocks.length - index} parts are left out. They are in the reports.`));
      break;
    }
    out.push(block);
    bytes += size;
  }
  out.push(footer);
  console.log(out.join("\n\n"));
};

const summary = read("summary.json");
if (!summary) {
  const status = existsSync(join(folder, "status.txt")) ? readFileSync(join(folder, "status.txt"), "utf8") : "";
  add("## Docs checks did not finish");
  add(para(summary === undefined ? "summary.json could not be read." : "The checks wrote no summary.json."));
  if (status.trim()) add(para(`The status file says ${code(status)}`));
  add(para(`What to do. Read the job log${RUN_URL ? ` of ${link(RUN_URL, "this run")}` : ""}, fix the step that failed, then run the workflow again.`));
  finish("");
  process.exit(0);
}

const CHECK_NAMES = {
  links: "Links", "source-paths": "Gradle modules", versions: "Package versions", "version-agreement": "Version agreement",
  lists: "Lists that match the code", "sentence-claims": "Sentence claims", commands: "Commands",
};
const REPORT_FILES = {
  links: "links.json", "source-paths": "source-paths.json", versions: "versions.json", "version-agreement": "version-agreement.json",
  lists: "lists.json", "sentence-claims": "sentence-claims-check.json", commands: "commands.json",
};
// The labels run.mjs puts in front of each Review needed line.
const REVIEW_LABELS = {
  "links:": "links", "source paths:": "source-paths", "versions:": "versions", "version agreement:": "version-agreement",
  "lists:": "lists", "sentence claims:": "sentence-claims", "commands:": "commands",
};
const checkName = (check) => text(CHECK_NAMES[check] ?? check);
const reports = Object.fromEntries(Object.keys(summary.checks ?? {}).map((check) => [check, read(REPORT_FILES[check] ?? `${check}.json`)]));

const commit = oneLine(summary.docsCommit ?? "unknown");
const commitUrl = /^[0-9a-f]{7,40}$/.test(commit) ? `https://github.com/${DOCS_REPO}/commit/${commit}` : null;
// A page is a site route for links, and a Markdown file for the other checks.
const pageCell = (page, lines = []) => {
  const p = oneLine(page);
  if (p.startsWith("/")) return link(`${SITE_ORIGIN}${p}`, code(p));
  const nums = lines.filter((n) => Number.isInteger(n));
  const label = `${code(p)}${nums.length ? ` line ${nums.join(", ")}` : ""}`;
  return commitUrl && /^[\w./-]+$/.test(p) ? link(`https://github.com/${DOCS_REPO}/blob/${commit}/${p}${nums.length ? `#L${nums[0]}` : ""}`, label) : label;
};
const valueCell = (value) => (safeUrl(value) ? link(value, code(value)) : code(value));
const issueLabel = (issue) => oneLine(String(issue ?? "no issue").split("/").pop().replace(/\.md$/, "")).match(/^ISSUE-\d+/)?.[0] ?? oneLine(issue ?? "no issue");
const addDays = (date, days) => { const t = Date.parse(`${date}T00:00:00Z`); return Number.isNaN(t) ? "an unknown date" : new Date(t + days * DAY).toISOString().slice(0, 10); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const news = summary.new ?? [];
const known = summary.known ?? [];
const stale = summary.staleEntries ?? [];
const blocked = summary.blocked ?? [];
const review = summary.reviewNeeded ?? [];
const notRun = summary.notRun ?? [];
const aging = summary.aging ?? {};
const overdue = aging.overdue ?? [];
const dueSoon = aging.review ?? [];
const failAfter = aging.failAfterDays ?? 14;

// Why each blocked check could not decide, read from its own report.
function blockedReasons(check) {
  const r = reports[check];
  if (r === null) return ["It wrote no report in this run. Read the job log for its error."];
  if (r === undefined) return ["Its report could not be read. Read the job log."];
  const reasons = [];
  const group = (items, key) => { const m = new Map(); for (const item of items) { const k = key(item); m.set(k, [...(m.get(k) ?? []), item]); } return [...m]; };
  if (check === "links") {
    if (r.counts?.outsideLinks === 0) reasons.push("It found no outside links in the build, so the link reader may be broken.");
  } else if (check === "source-paths") {
    for (const [source, items] of group(r.unreachable ?? [], (i) => `${i.checkedAgainst} answered ${i.error}`))
      reasons.push(`${text(source)}. ${plural(items.length, "module use")} not checked, on ${items.map((i) => pageCell(i.file, [i.line])).join(", ")}.`);
    if (r.counts?.found === 0) reasons.push("It found no Gradle module names on the pages.");
  } else if (check === "versions") {
    const unreachable = (r.results ?? []).filter((i) => i.verdict === "source unreachable");
    for (const [error, items] of group(unreachable, (i) => i.error)) {
      const packages = [...new Set(items.map((i) => `${i.group}:${i.artifact}`))];
      reasons.push(`Maven Central answered ${code(error)} for ${plural(packages.length, "package")}, ${packages.map(code).join(", ")}. ${plural(items.length, "use")} on the pages not checked.${/429/.test(error) ? " 429 means too many requests, and usually clears on a rerun." : ""}`);
    }
    if (r.counts?.found === 0) reasons.push("It found no dev.ohs packages on the pages.");
  } else if (check === "version-agreement") {
    for (const error of r.tableErrors ?? []) reasons.push(`The versions table was not read. ${text(error)}.`);
    if (r.counts?.found === 0) reasons.push("It found no library versions on the pages.");
  } else if (check === "lists") {
    for (const l of r.lists ?? []) for (const error of l.errors ?? []) reasons.push(`${code(l.id)} not compared. ${text(error)}.`);
    if (r.counts?.lists === 0) reasons.push("list-targets.json has no lists.");
  } else if (check === "sentence-claims") {
    for (const i of (r.results ?? []).filter((i) => i.verdict === "blocked")) reasons.push(`${code(i.id)} on ${pageCell(i.page)} not checked. ${text(i.why)}.`);
    if (r.counts?.claims === 0) reasons.push("sentence-claims.json has no claims.");
  } else if (check === "commands") {
    for (const i of (r.results ?? []).filter((i) => i.verdict === "blocked")) reasons.push(`${code(i.value)} on ${pageCell(i.file, [i.line])} not checked. ${text(i.why)}.`);
    if (r.counts?.commands === 0) reasons.push("It found no commands on the mapped pages.");
  }
  return reasons.length ? reasons : ["Its report gives no reason. Read run-output.txt and the job log."];
}

// Sentence claims say more than the summary item. Show the quote, the value the
// sentence states, and what the source has.
const claimDetail = (item) => {
  const r = (reports["sentence-claims"]?.results ?? []).find((c) => item.value === `${c.id} ${c.verdict}`);
  if (!r) return null;
  const source = r.source?.list ? `the list ${r.source.list} on the page` : `${r.source?.repository ?? ""} ${r.source?.path ?? ""}${r.commit && r.commit !== "local" ? ` at ${r.commit.slice(0, 7)}` : ""}`;
  const value = `${code(r.quote)}`;
  const compared = r.verdict === "quote gone"
    ? `The quote is no longer on the rendered page. ${text(r.why ?? "")}`
    : `The sentence states ${code(r.rule?.value)}. ${text(source)} has ${code(r.observed ?? "nothing")}. ${text(r.why ?? "")}`;
  return { value, compared };
};

// Heading and where the run looked.
add(`## Docs checks ${summary.result === "pass" ? "passed" : "failed"}`);
add(para(`Checked ${code(DOCS_REPO)} at ${commitUrl ? link(commitUrl, code(commit)) : code(commit)} on ${text(String(summary.checkedAt ?? "").replace("T", " ").slice(0, 16))} UTC.`));

// What to do, in the order a person should do it.
const byIssue = (items) => {
  const groups = new Map();
  for (const item of items) {
    const label = issueLabel(item.issue);
    if (!groups.has(label)) groups.set(label, { label, added: item.added, ids: [], state: item.state });
    const g = groups.get(label);
    g.ids.push(item.id);
    if (String(item.added) < String(g.added)) g.added = item.added;
  }
  return [...groups.values()];
};
const otherReview = review.filter((line) => {
  if (/^\d+ known entr/.test(line)) return false;
  const label = Object.keys(REVIEW_LABELS).find((l) => line.startsWith(l));
  return !(label && blocked.includes(REVIEW_LABELS[label]));
});
const todo = [];
if (notRun.length) todo.push(`Fix the run. Not run ${notRun.map(code).join(", ")}.`);
if (blocked.length) todo.push(`Rerun the workflow. ${plural(blocked.length, "check")} could not decide, ${blocked.map(checkName).join(", ")}. The reasons are under Blocked. If a rerun is blocked again, fix the cause.`);
if (news.length) todo.push(`Triage ${plural(news.length, "new finding")} under New findings. For each, open the page and the source. If the problem is real, draft the issue and add a known entry. If the check is wrong, fix the check or its targets file.`);
if (overdue.length) todo.push(`Post ${byIssue(overdue).map((g) => code(g.label)).join(", ")} now. ${plural(overdue.length, "known entry", "known entries")} reached ${failAfter} days not posted, and every run fails until each is posted. Then set ${code("issue")} to the URL and ${code("state")} to ${code("posted")} in known-findings.json.`);
if (dueSoon.length) todo.push(`Post ${byIssue(dueSoon).map((g) => `${code(g.label)} before ${text(addDays(g.added, failAfter))} UTC`).join(", ")}. Runs fail from that date.`);
if (stale.length) todo.push(`Delete ${plural(stale.length, "stale entry", "stale entries")} from known-findings.json, ${stale.map((e) => code(e.id)).join(", ")}. A stale entry was judged and matched nothing, so its fix has probably merged.`);
if (otherReview.length) todo.push(`Read the ${plural(otherReview.length, "item")} under Review needed.`);
add(heading("What to do"));
add(todo.length ? list(todo) : para("Nothing. No new finding, no blocked check, and no known entry needs posting yet."));

// One row per check.
const countBy = (items, check) => items.filter((item) => item.check === check).length;
add(heading("Checks"));
add(table(["Check", "Result", "New", "Known"], Object.entries(summary.checks ?? {}).map(([check, result]) => [
  checkName(check), result === "pass" ? "pass" : `<b>${text(result)}</b>`, String(countBy(news, check)), String(countBy(known, check)),
])));

if (news.length) {
  add(heading(`New findings (${news.length})`));
  add(para("Each fails the run. Page links open the docs source at the checked commit, or the live page for links."));
  add(table(["Check", "Page", "Value", "Compared with"], news.map((item) => {
    const claim = item.check === "sentence-claims" ? claimDetail(item) : null;
    return [checkName(item.check), pageCell(item.page, item.lines ?? []), claim?.value ?? valueCell(item.value), claim?.compared ?? text(item.source)];
  })));
}

if (blocked.length || notRun.length) {
  add(heading("Blocked"));
  const items = [...notRun.map((line) => `Not run, ${text(line)}.`)];
  for (const check of blocked) for (const reason of blockedReasons(check)) items.push(`<b>${checkName(check)}</b>. ${reason}`);
  add(list(items));
}

if (otherReview.length) {
  add(heading("Review needed"));
  add(list(otherReview.slice(0, ROWS).map(text).concat(otherReview.length > ROWS ? [`And ${otherReview.length - ROWS} more. The full list is in summary.json.`] : [])));
}

if (overdue.length || dueSoon.length) {
  add(heading("Known issues not posted"));
  const groups = [...byIssue(overdue).map((g) => ({ ...g, note: "Overdue. Every run fails" })), ...byIssue(dueSoon).map((g) => ({ ...g, note: "Not posted after 7 days" }))];
  add(table(["Draft", "Entries", "Added", "Runs fail from", "State"], groups.map((g) => [
    code(g.label), g.ids.map(code).join(", "), text(g.added), text(addDays(g.added, failAfter)), text(g.note),
  ])));
}

if (stale.length) {
  add(heading(`Stale entries (${stale.length})`));
  add(table(["Entry", "Check", "Page", "Value", "Draft"], stale.map((e) => [code(e.id), checkName(e.check), pageCell(e.page), valueCell(e.value), code(issueLabel(e.issue))])));
}

if (known.length) {
  add(folded(`Known findings (${known.length}). They do not fail the run.`, [table(["Draft", "Entry", "Check", "Page", "Value"], known.map((item) => [
    code(issueLabel(item.issue)), code(item.id), checkName(item.check), pageCell(item.page, item.lines ?? []), valueCell(item.value),
  ]))]));
}

// Information, with the items behind each count.
const info = [];
const links = reports.links;
if (links) {
  const usedOn = (r) => (r.usedOn ?? []).map((p) => pageCell(p)).join(", ");
  if (links.redirected?.length) info.push(["Links redirected to another host", ["Link", "Lands on", "Used on"], links.redirected.map((r) => [valueCell(r.url), valueCell(r.finalUrl), usedOn(r)])]);
  if (links.blocked?.length) info.push(["Links not judged, the site refused or failed", ["Link", "Answer", "Used on"], links.blocked.map((r) => [valueCell(r.url), code(r.status), usedOn(r)])]);
  if (links.unreachable?.length) info.push(["Links not reached, network error", ["Link", "Error", "Used on"], links.unreachable.map((r) => [valueCell(r.url), code(r.error), usedOn(r)])]);
}
const behind = (reports.versions?.results ?? []).filter((r) => r.verdict === "behind");
if (behind.length) info.push(["Versions behind the latest on Maven Central", ["Page", "Package", "Page names", "Latest"], behind.map((r) => [pageCell(r.file, [r.line]), code(`${r.group}:${r.artifact}`), code(r.version), code(r.latest)])]);
if (reports["version-agreement"]?.information?.length) info.push(["Version agreement notes", ["Page", "Note"], reports["version-agreement"].information.map((r) => [pageCell(r.file, [r.line]), text(r.note)])]);
const covered = (reports.lists?.lists ?? []).flatMap((l) => (l.covered ?? []).map((r) => ({ ...r, id: l.id })));
if (covered.length) info.push(["List values covered by a parent path", ["List", "Value", "Parent on the page"], covered.map((r) => [code(r.id), code(r.value), code(r.parent)])]);
const builtIn = (reports.commands?.results ?? []).filter((r) => r.verdict === "information");
if (builtIn.length) info.push(["Commands with nothing to compare", ["Page", "Command", "Why"], builtIn.map((r) => [pageCell(r.file, [r.line]), code(r.command), text(r.why)])]);
if (reports["source-paths"]?.skipped?.length) info.push(["Gradle modules skipped on pages listed under skip", ["Page", "Module"], reports["source-paths"].skipped.map((r) => [pageCell(r.file, [r.line]), code(r.module)])]);
const missingReports = Object.keys(reports).filter((check) => reports[check] == null && !blocked.includes(check));
if (info.length || missingReports.length) {
  const parts = info.map(([title, head, rows]) => `<p><b>${title} (${rows.length})</b></p>\n${table(head, rows)}`);
  if (missingReports.length) parts.push(para(`No readable report for ${missingReports.map(checkName).join(", ")}, so its details are not shown.`));
  add(folded(`Information (${info.reduce((n, [, , rows]) => n + rows.length, 0)} items). Nothing here fails the run.`, parts));
}

finish(para(`The reports are in ${text(ARTIFACT)}${RUN_URL ? ` on ${link(RUN_URL, "the run page")}` : ""}. Start with summary.json and run-output.txt.`));
