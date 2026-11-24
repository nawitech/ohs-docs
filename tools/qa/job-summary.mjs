// Writes the job summary for a docs checks run, from the reports that run.mjs
// and the checks wrote.
//
//   node tools/qa/job-summary.mjs <reports folder> > summary.md
//
// The headline names every reason the run did not pass, and how many known
// findings remain. What to do comes first, with the dates by which each known
// issue must be posted. Then every new finding with its page, value and problem,
// so a person can act without opening the JSON files. Known findings, grouped by
// issue with each cause and fix, then Worth a look and Not compared, are folded
// at the end.
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
// GitHub, GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID give the run link,
// and GITHUB_SHA the commit the checks themselves came from. Without GITHUB_SHA
// the summary says that commit is not known.
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
  lists: "Lists that match the code", "sentence-claims": "Sentence claims", commands: "Commands", claims: "Claims", "page-symbols": "Page symbols",
};
const REPORT_FILES = {
  links: "links.json", "source-paths": "source-paths.json", versions: "versions.json", "version-agreement": "version-agreement.json",
  lists: "lists.json", "sentence-claims": "sentence-claims-check.json", commands: "commands.json", claims: "claims-check.json", "page-symbols": "page-symbols.json",
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
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (value) => { const s = oneLine(value); return `${s.charAt(0).toUpperCase()}${s.slice(1)}`; };
const count = (n) => Number(n ?? 0).toLocaleString("en-US");

const news = summary.new ?? [];
const known = summary.known ?? [];
const stale = summary.staleEntries ?? [];
const blocked = summary.blocked ?? [];
const review = summary.reviewNeeded ?? [];
const notRun = summary.notRun ?? [];
const issues = summary.issues ?? {};
const unjudged = summary.unjudged ?? [];
const tracked = summary.tracked ?? [];
const listErrors = summary.listErrors ?? [];
const aging = summary.aging ?? {};
const overdue = aging.overdue ?? [];
const waiting = aging.waiting ?? [];
const failAfter = aging.failAfterDays ?? 14;
const today = aging.today ?? String(summary.checkedAt ?? "").slice(0, 10);

// An issue label links to its GitHub issue once posted. Until then it names a
// local draft, which the reader cannot open.
const issueCell = (label) => {
  const issue = issues[label];
  return issue?.state === "posted" && safeUrl(issue.url) ? link(issue.url, code(label)) : code(label);
};
const issueList = (labels) => labels.map(issueCell).join(", ");

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
    // Group by what each source answered, then list the packages and versions.
    const unreachable = (r.results ?? []).filter((i) => i.verdict === "source unreachable");
    const cause = (i) => i.centralError
      ? `Maven Central answered ${i.centralError}. ${i.missingOnMirror ? "The Google mirror does not list these versions, and may be behind" : i.mirrorAnswer === "no such package" ? "The Google mirror has no such package, and may be behind" : `The Google mirror answered ${i.mirrorAnswer}`}`
      : `Maven Central answered ${i.error}`;
    for (const [reason, items] of group(unreachable, cause)) {
      const uses = [...new Set(items.map((i) => `${i.group}:${i.artifact}:${i.version}`))];
      reasons.push(`${text(reason)}. ${plural(uses.length, "version")} not checked, ${uses.map(code).join(", ")}.${/429/.test(reason) ? " 429 means too many requests, and usually clears on a rerun." : ""}`);
    }
    if (r.counts?.found === 0) reasons.push("It found no dev.ohs packages on the pages.");
  } else if (check === "version-agreement") {
    for (const error of r.tableErrors ?? []) reasons.push(`The versions table was not read. ${text(sentence(error))}.`);
    if (r.counts?.found === 0) reasons.push("It found no library versions on the pages.");
  } else if (check === "lists") {
    for (const l of r.lists ?? []) for (const error of l.errors ?? []) reasons.push(`${code(l.id)} not compared. ${text(sentence(error))}.`);
    if (r.counts?.lists === 0) reasons.push("list-targets.json has no lists.");
  } else if (check === "sentence-claims") {
    for (const i of (r.results ?? []).filter((i) => i.verdict === "blocked")) reasons.push(`${code(i.id)} on ${pageCell(i.page)} not checked. ${text(sentence(i.why))}.`);
    if (r.counts?.claims === 0) reasons.push("sentence-claims.json has no claims.");
  } else if (check === "commands") {
    for (const i of (r.results ?? []).filter((i) => i.verdict === "blocked")) reasons.push(`${code(i.value)} on ${pageCell(i.file, [i.line])} not checked. ${text(sentence(i.why))}.`);
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
const problemOf = (item) => text(item.problem ?? item.source);

// Headline. It names every reason the run did not pass, then the known count.
const CHECK_WORDS = { claims: "claims", "page-symbols": "page symbols" };
const reasonText = (r) => {
  if (r.reason === "new") return plural(r.count, "new finding");
  if (r.reason === "failed") return `${(r.checks ?? []).map((check) => CHECK_WORDS[check] ?? CHECK_NAMES[check]?.toLowerCase() ?? check).join(" and ")} failed`;
  if (r.reason === "overdue") return `${plural(r.count, "issue")} overdue`;
  if (r.reason === "blocked") return `${plural((r.checks ?? []).length, "check")} blocked`;
  if (r.reason === "not run") return `${plural(r.count, "check")} did not run`;
  if (r.reason === "no selection") return "the changed pages are unknown";
  if (r.reason === "list errors") return "the known findings list has errors";
  return r.text ?? r.reason;
};
const knownLabels = [...new Set(known.map((item) => item.issue))];
const reasons = (summary.failReasons ?? []).map(reasonText);
if (summary.result !== "pass" && !reasons.length) reasons.push("the checks failed");
const lead = reasons.length ? reasons.join(", ") : "no new findings";
const knownPart = known.length ? `. ${plural(known.length, "known finding")} ${known.length === 1 ? "remains" : "remain"}, in ${plural(knownLabels.length, "issue")}` : "";
add(`## ${text(`${lead.charAt(0).toUpperCase()}${lead.slice(1)}${knownPart}`)}`);

// Where the run looked. The checks' own commit is the fork commit GitHub ran.
const SHA = oneLine(process.env.GITHUB_SHA ?? "");
const toolsRepo = oneLine(process.env.GITHUB_REPOSITORY ?? "");
const toolsAt = /^[0-9a-f]{40}$/.test(SHA) && /^[\w.-]+\/[\w.-]+$/.test(toolsRepo)
  ? `, with the checks from ${code(toolsRepo)} at ${link(`${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${toolsRepo}/commit/${SHA}`, code(SHA.slice(0, 7)))}`
  : ". The commit of the checks themselves is not known";
add(para(`Checked ${code(DOCS_REPO)} at ${commitUrl ? link(commitUrl, code(commit)) : code(commit)} on ${text(String(summary.checkedAt ?? "").replace("T", " ").slice(0, 16))} UTC${toolsAt}.`));

// What to do, in the order a person should do it.
// A check that failed on one item can still have others it could not read.
// It is not blocked then, so their reasons go under Review needed instead.
const unreadItems = {
  versions: (r) => (r?.results ?? []).some((i) => i.verdict === "source unreachable"),
  "source-paths": (r) => (r?.unreachable ?? []).length > 0,
  "version-agreement": (r) => (r?.tableErrors ?? []).length > 0,
};
const partlyRead = Object.keys(unreadItems).filter((check) => !blocked.includes(check) && unreadItems[check](reports[check]));
// run.mjs starts most Review needed lines with a check label and a colon. The
// summary shows the check's name in bold and the rest as a sentence.
const LINE_NAMES = { select: "Changed pages", "page symbols": "Page symbols", "known findings": "Known findings" };
const reviewLine = (line) => {
  const m = oneLine(line).match(/^([a-z][a-z -]*): (.+)$/);
  if (!m) return text(line);
  const check = REVIEW_LABELS[`${m[1]}:`] ?? Object.keys(CHECK_NAMES).find((key) => key === m[1] || key === m[1].replaceAll(" ", "-"));
  const name = check ? checkName(check) : text(LINE_NAMES[m[1]] ?? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}`);
  return `<b>${name}</b>. ${text(sentence(m[2]))}`;
};
const otherReview = review.filter((line) => {
  if (/^known issues: /.test(line)) return false;
  const label = Object.keys(REVIEW_LABELS).find((l) => line.startsWith(l));
  return !(label && (blocked.includes(REVIEW_LABELS[label]) || partlyRead.includes(REVIEW_LABELS[label])));
});
// Each item is HTML. Reasons from blockedReasons are escaped already.
const reviewItems = [
  ...partlyRead.flatMap((check) => blockedReasons(check).map((reason) => `<b>${checkName(check)}</b>. Not checked, so not stale and not new. ${reason}`)),
  ...otherReview.map((line) => reviewLine(line)),
];
const todo = [];
if (listErrors.length) todo.push(`Fix known-findings.json. Every run fails until each error is fixed.${list(listErrors.slice(0, ROWS).map(text).concat(listErrors.length > ROWS ? [`And ${listErrors.length - ROWS} more. The full list is in summary.json.`] : []))}`);
if (notRun.length) todo.push(`Fix the run. Not run ${notRun.map(code).join(", ")}.`);
if (blocked.length) todo.push(`Rerun the workflow. ${plural(blocked.length, "check")} could not decide, ${blocked.map(checkName).join(", ")}. The reasons are under Blocked. If a rerun is blocked again, fix the cause.`);
if (news.length) todo.push(`Triage ${plural(news.length, "new finding")} under New findings. For each, open the page and the source. If the problem is real, draft the issue and add a known entry. If the check is wrong, fix the check or its targets file.`);
const failedOther = (summary.failReasons ?? []).find((r) => r.reason === "failed");
if (failedOther) todo.push(`Read run-output.txt for ${failedOther.checks.map(checkName).join(" and ")}. ${failedOther.checks.length === 1 ? "It" : "They"} failed without a finding this summary can list.`);
if (overdue.length) todo.push(`Post ${issueList(overdue.map((item) => item.label))} now. ${overdue.length === 1 ? "It has" : "They have"} gone ${failAfter} days without being posted, and every run fails until each is posted. Then set ${code("url")} and set ${code("state")} to ${code("posted")} for the issue in known-findings.json.`);
const inReview = (aging.review ?? []).map((item) => item.label);
if (inReview.length) todo.push(`Post ${issueList(inReview)}. ${inReview.length === 1 ? "It has" : "They have"} gone ${aging.reviewAfterDays ?? 7} days without being posted. The dates runs start to fail are below.`);
if (stale.length) todo.push(`Delete ${plural(stale.length, "stale entry", "stale entries")} from known-findings.json, ${stale.map((e) => code(e.id)).join(", ")}. A stale entry was checked and matched nothing, so its fix has probably merged. Delete an issue once it has no entries.`);
if (reviewItems.length) todo.push(`Read the ${plural(reviewItems.length, "item")} under Review needed.`);
// The coming dates of every issue still being counted.
const coming = new Map();
for (const label of Object.keys(issues)) {
  const issue = issues[label];
  if (!["counting", "review"].includes(issue.status)) continue;
  for (const [date, what] of [[issue.reviewOn, "Listed under Review needed"], [issue.failOn, "Fails the run"]]) {
    if (!date || date <= today) continue;
    const key = `${date}|${what}`;
    coming.set(key, [...(coming.get(key) ?? []), label]);
  }
}
const comingRows = [...coming].sort(([a], [b]) => a.localeCompare(b)).map(([key, labels]) => { const [date, what] = key.split("|"); return [text(date), text(what), issueList(labels)]; });
add(heading("What to do"));
if (todo.length) add(list(todo));
if (comingRows.length) {
  add(para(todo.length ? "Then post these issues before they reach their dates." : "Post these issues before they reach their dates."));
  add(table(["Date", "What happens", "Issues"], comingRows));
}
for (const item of waiting) add(para(`${issueCell(item.label)} is on hold since ${text(item.since)}. ${text(item.reason)}.`));
if (!todo.length && !comingRows.length && !waiting.length) add(para("Nothing. No new finding, no blocked check, and no known issue needs posting yet."));
if (summary.result === "pass") {
  const claims = reports["sentence-claims"]?.counts?.claims;
  add(para(`A pass covers what the checks read. It does not cover prose beyond ${Number.isInteger(claims) ? `the ${plural(claims, "sentence claim")}` : "the sentence claims"}, screenshots, or whether code samples compile.`));
}

// One row per check, with what it read.
const checked = (check) => {
  const c = reports[check]?.counts;
  if (!c) return "no report";
  if (check === "links") return `${count(c.outsideLinks)} outside links, ${count(c.sectionLinksChecked)} section links`;
  if (check === "source-paths") return plural(c.found ?? 0, "module use");
  if (check === "versions") return plural(c.found ?? 0, "package version use");
  if (check === "version-agreement") return `${plural(c.found ?? 0, "version use")} on ${plural(c.pages ?? 0, "page")}`;
  if (check === "lists") return `${plural(c.lists ?? 0, "list")}, ${plural(c.inCode ?? 0, "value")} in the code`;
  if (check === "sentence-claims") return plural(c.claims ?? 0, "claim");
  if (check === "commands") return `${plural(c.values ?? 0, "value")} in ${plural(c.commands ?? 0, "command")}`;
  return "";
};
const countBy = (items, check) => items.filter((item) => item.check === check).length;
add(heading("Checks"));
add(table(["Check", "Result", "Checked", "New", "Known"], Object.entries(summary.checks ?? {}).map(([check, result]) => [
  checkName(check), result === "pass" ? "pass" : `<b>${text(result)}</b>`, text(checked(check)), String(countBy(news, check)), String(countBy(known, check)),
])));

if (news.length) {
  add(heading(`New findings (${news.length})`));
  add(para("Each fails the run. Page links open the docs source at the checked commit, or the live page for links."));
  add(table(["Check", "Page", "Found", "Problem"], news.map((item) => {
    const claim = item.check === "sentence-claims" ? claimDetail(item) : null;
    return [checkName(item.check), pageCell(item.page, item.lines ?? []), claim?.value ?? valueCell(item.value), claim?.compared ?? problemOf(item)];
  })));
}

if (blocked.length || notRun.length) {
  add(heading("Blocked"));
  const items = [...notRun.map((line) => `Not run, ${text(line)}.`)];
  for (const check of blocked) for (const reason of blockedReasons(check)) items.push(`<b>${checkName(check)}</b>. ${reason}`);
  add(list(items));
}

if (reviewItems.length) {
  add(heading("Review needed"));
  add(list(reviewItems.slice(0, ROWS).concat(reviewItems.length > ROWS ? [`And ${reviewItems.length - ROWS} more. The full list is in summary.json.`] : [])));
}

if (stale.length) {
  add(heading(`Stale entries (${stale.length})`));
  add(table(["Entry", "Issue", "Check", "Page", "Value"], stale.map((e) => [code(e.id), issueCell(e.issue), checkName(e.check), pageCell(e.page), valueCell(e.value)])));
}

// Known findings, one group per issue, with its cause and fix.
if (known.length || unjudged.length) {
  const parts = [para("ISSUE labels name local drafts until the issue is posted. A posted issue links to GitHub.")];
  for (const label of knownLabels) {
    const issue = issues[label];
    const rows = known.filter((item) => item.issue === label);
    if (!issue) {
      parts.push(para(`<b>${code(label)}</b>. This issue is not in the issues list of known-findings.json.`));
    } else {
      const state = issue.state === "posted" ? "Posted" : "Not posted";
      const status = issue.status === "waiting" ? ` On hold since ${text(issue.hold?.since)}. ${text(issue.hold?.reason)}.`
        : issue.status === "overdue" ? " Overdue, so every run fails until it is posted."
        : "";
      parts.push(para(`<b>${issueCell(label)}. ${text(issue.title)}.</b> ${state}, added ${text(issue.added)}.${status}`));
      parts.push(list([
        issue.cause ? `Caused by ${text(issue.cause)}.` : "Cause has not been checked.",
        issue.fix ? `Fix. ${text(issue.fix)}.` : "Fix. Not written yet. See the draft.",
      ]));
    }
    parts.push(table(["Check", "Page", "Found", "Problem"], rows.map((item) => [checkName(item.check), pageCell(item.page, item.lines ?? []), valueCell(item.value), problemOf(item)])));
  }
  if (unjudged.length) {
    parts.push(para(`<b>Not checked this run (${unjudged.length})</b>. These known entries were neither found nor stale, so the count above leaves them out.`));
    parts.push(table(["Issue", "Entry", "Check", "Page", "Value"], unjudged.map((e) => [issueCell(e.issue), code(e.id), checkName(e.check), pageCell(e.page), valueCell(e.value)])));
  } else {
    parts.push(para("Every known entry was checked this run."));
  }
  add(folded(`Known findings, ${known.length} in ${plural(knownLabels.length, "issue")}. They fail the run only when their issue is overdue.`, parts));
}

// Worth a look, and Not compared, with the items behind each count.
// A versions row matches on its package and version. A version agreement note
// matches on its own text, since one line can hold notes for two pins.
const trackedNote = (check, page, line, key) => {
  const hit = tracked.find((t) => t.check === check && t.page === page && t.line === line && (check === "versions" ? t.value === key : t.note === key));
  return hit ? `Tracked in ${issueCell(hit.issue)}` : null;
};
const look = [], skipped = [];
const links = reports.links;
const usedOn = (r) => (r.usedOn ?? []).map((p) => pageCell(p)).join(", ");
if (links?.redirected?.length) look.push(["Links redirected to another host", "Before changing a link, open where it lands and confirm it is the same content.", ["Link", "Lands on", "Used on"], links.redirected.map((r) => [valueCell(r.url), valueCell(r.finalUrl), usedOn(r)])]);
const behind = (reports.versions?.results ?? []).filter((r) => r.verdict === "behind");
if (behind.length) look.push(["Versions behind the latest on Maven Central", "The latest version is not always the right one. Check the versions table before changing a pin.", ["Page", "Package", "Page names", "Latest", "Note"], behind.map((r) => {
  const value = `${r.group}:${r.artifact}:${r.version}`;
  return [pageCell(r.file, [r.line]), code(`${r.group}:${r.artifact}`), code(r.version), code(r.latest), trackedNote("versions", r.file, r.line, value) ?? "Not tracked in an issue. Check compatibility before changing it"];
})]);
if (reports["version-agreement"]?.information?.length) look.push(["Version agreement notes", null, ["Page", "Note"], reports["version-agreement"].information.map((r) => {
  const note = trackedNote("version-agreement", r.file, r.line, r.note);
  return [pageCell(r.file, [r.line]), `${text(r.note)}${note ? `. ${note}` : ""}`];
})]);
const covered = (reports.lists?.lists ?? []).flatMap((l) => (l.covered ?? []).map((r) => ({ ...r, id: l.id })));
if (covered.length) look.push(["List values accepted through a parent path", "The page lists the parent path, which covers the value in the code.", ["List", "Value in the code", "Parent on the page"], covered.map((r) => [code(r.id), code(r.value), code(r.parent)])]);

if (links?.blocked?.length) skipped.push(["Links not judged, the site refused or failed", null, ["Link", "Answer", "Used on"], links.blocked.map((r) => [valueCell(r.url), code(r.status), usedOn(r)])]);
if (links?.unreachable?.length) skipped.push(["Links not reached, network error", null, ["Link", "Error", "Used on"], links.unreachable.map((r) => [valueCell(r.url), code(r.error), usedOn(r)])]);
// Only versions the mirror listed. A version it did not list is under Blocked
// or Review needed instead.
const mirrored = new Map();
for (const r of reports.versions?.results ?? []) {
  if (r.verdict !== "published" || r.registry !== "Google mirror") continue;
  const pkg = `${r.group}:${r.artifact}`;
  const entry = mirrored.get(pkg) ?? { why: r.centralError, versions: new Set() };
  entry.versions.add(r.version);
  mirrored.set(pkg, entry);
}
if (mirrored.size) skipped.push(["Versions confirmed only on the Google mirror of Maven Central", "The mirror shows each version was published. Whether it is the latest was not compared.", ["Package", "Versions confirmed", "Maven Central answered"], [...mirrored].map(([pkg, e]) => [code(pkg), [...e.versions].map(code).join(", "), text(e.why)])]);
const builtIn = (reports.commands?.results ?? []).filter((r) => r.verdict === "information");
if (builtIn.length) skipped.push(["Commands with nothing to compare", null, ["Page", "Command", "Why"], builtIn.map((r) => [pageCell(r.file, [r.line]), code(r.command), text(r.why)])]);
if (reports["source-paths"]?.skipped?.length) skipped.push(["Gradle modules skipped on pages listed under skip", null, ["Page", "Module"], reports["source-paths"].skipped.map((r) => [pageCell(r.file, [r.line]), code(r.module)])]);
// Some reports give only a count of what they skipped.
const skippedCounts = [];
const addCount = (n, words) => { if (Number.isInteger(n) && n > 0) skippedCounts.push([n, words(n)]); };
addCount(links?.counts?.skipped, (n) => `${plural(n, "link")} to local or example hosts`);
addCount(reports.versions?.counts?.skipped, (n) => `${plural(n, "Maven block")} without a literal version, in the package versions check`);
// notChecked counts pins a table error kept from being compared. They are
// under Blocked or Review needed, not here.
addCount(reports["version-agreement"]?.counts?.skipped, (n) => `${plural(n, "version use")} with no rule in the versions table`);

const section = ([title, advice, head, rows]) => `<p><b>${title} (${rows.length})</b>${advice ? ` ${advice}` : ""}</p>\n${table(head, rows)}`;
const size = (groups) => groups.reduce((n, [, , , rows]) => n + rows.length, 0);
if (look.length) add(folded(`Worth a look (${size(look)}). Nothing here fails the run.`, look.map(section)));
const unreadCount = blocked.length + partlyRead.length;
if (skipped.length || skippedCounts.length) {
  const parts = skipped.map(section);
  if (skippedCounts.length) parts.push(para(`Also skipped, counted in the reports only. ${skippedCounts.map(([, words]) => text(words)).join(". ")}.`));
  if (unreadCount) parts.push(para(`Items the checks could not read are under ${blocked.length ? "Blocked" : "Review needed"}, not here.`));
  add(folded(`Not compared (${size(skipped) + skippedCounts.reduce((n, [k]) => n + k, 0)}). The checks skipped these, so a pass says nothing about them.`, parts));
}
const missingReports = Object.keys(reports).filter((check) => reports[check] == null && !blocked.includes(check));
if (missingReports.length) add(para(`No readable report for ${missingReports.map(checkName).join(", ")}, so its details are not shown.`));

finish(para(`The reports are in ${text(ARTIFACT)}${RUN_URL ? ` on ${link(RUN_URL, "the run page")}` : ""}. Start with summary.json for every finding and run-output.txt for each check's own output.`));
