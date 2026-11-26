// Writes the job summary for a docs checks run, from the reports that run.mjs
// and the checks wrote.
//
//   node tools/qa/job-summary.mjs <reports folder> > summary.md
//
// Every finding fails the run. The headline names every reason the run did not
// pass, and how many findings are new compared with the earlier run that
// run.mjs compared with. What to do comes first. Then the new findings, then
// the ones also found in the earlier run, folded. With no comparison, one
// Findings table. Worth a look and Not compared are folded at the end.
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
// and GITHUB_SHA the commit the checks themselves came from, when summary.json
// does not give it. Without either, the summary says that commit is not known.
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
// Messages from the checks, stderr and reports are shown as prose, which has
// no colons, semicolons or em dashes. Each becomes a comma. A colon inside a
// word, as in https://, stays.
const prose = (value) => text(oneLine(value).replace(/\s*[;\u2014]\s*/g, ", ").replace(/:(\s+|$)/g, ",$1"));
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

const findings = summary.findings ?? [];
const blocked = summary.blocked ?? [];
const review = summary.reviewNeeded ?? [];
const notRun = summary.notRun ?? [];
const exits = summary.exits ?? {};
const comparison = summary.comparison ?? { status: "unavailable", reason: "summary.json does not say" };
const compared = comparison.status === "compared";
const runName = compared ? `run ${comparison.runNumber}` : null;
const news = findings.filter((item) => item.new === true);
const also = findings.filter((item) => item.new === false);
// A pull request run. run.mjs marked each finding touched and onMain.
const pr = summary.failOn === "touched" && summary.touched && typeof summary.touched === "object" ? summary.touched : null;
const PR_NUMBER = /^[1-9][0-9]*$/.test(process.env.PR_NUMBER ?? "") ? process.env.PR_NUMBER : null;
const BASE = /^[\w./-]+$/.test(process.env.BASE_REF ?? "") ? process.env.BASE_REF : "main";
const toFix = pr ? findings.filter((item) => item.touched && !item.onMain) : [];
const onMain = pr ? findings.filter((item) => item.touched && item.onMain) : [];
const otherPages = pr ? findings.filter((item) => !item.touched) : [];

// Why each blocked check could not decide, read from its own report and from
// how the check exited.
function blockedReasons(check) {
  const r = reports[check];
  const listed = findings.some((item) => item.check === check);
  const reasons = exits[check] ? [`${prose(sentence(exits[check]))}.${listed ? " Its findings are still listed below." : ""}`] : [];
  if (r === null || r === undefined) return reasons.length ? reasons : [r === null ? "It wrote no report in this run. Read the job log for its error." : "Its report could not be read. Read the job log."];
  const group = (items, key) => { const m = new Map(); for (const item of items) { const k = key(item); m.set(k, [...(m.get(k) ?? []), item]); } return [...m]; };
  if (check === "links") {
    if (r.counts?.outsideLinks === 0) reasons.push("It found no outside links in the build, so the link reader may be broken.");
  } else if (check === "source-paths") {
    for (const [source, items] of group(r.unreachable ?? [], (i) => `${i.checkedAgainst} answered ${i.error}`))
      reasons.push(`${prose(source)}. ${plural(items.length, "module use")} not checked, on ${items.map((i) => pageCell(i.file, [i.line])).join(", ")}.`);
    if (r.counts?.found === 0) reasons.push("It found no Gradle module names on the pages.");
  } else if (check === "versions") {
    // Group by what each source answered, then list the packages and versions.
    const unreachable = (r.results ?? []).filter((i) => i.verdict === "source unreachable");
    const cause = (i) => i.centralError
      ? `Maven Central answered ${i.centralError}. ${i.missingOnMirror ? "The Google mirror does not list these versions, and may be behind" : i.mirrorAnswer === "no such package" ? "The Google mirror has no such package, and may be behind" : `The Google mirror answered ${i.mirrorAnswer}`}`
      : `Maven Central answered ${i.error}`;
    for (const [reason, items] of group(unreachable, cause)) {
      const uses = [...new Set(items.map((i) => `${i.group}:${i.artifact}:${i.version}`))];
      reasons.push(`${prose(reason)}. ${plural(uses.length, "version")} not checked, ${uses.map(code).join(", ")}.${/429/.test(reason) ? " 429 means too many requests, and usually clears on a rerun." : ""}`);
    }
    if (r.counts?.found === 0) reasons.push("It found no dev.ohs packages on the pages.");
  } else if (check === "version-agreement") {
    for (const error of r.tableErrors ?? []) reasons.push(`The versions table was not read. ${prose(sentence(error))}.`);
    if (r.counts?.found === 0) reasons.push("It found no library versions on the pages.");
  } else if (check === "lists") {
    for (const l of r.lists ?? []) for (const error of l.errors ?? []) reasons.push(`${code(l.id)} not compared. ${prose(sentence(error))}.`);
    if (r.counts?.lists === 0) reasons.push("list-targets.json has no lists.");
  } else if (check === "sentence-claims") {
    for (const i of (r.results ?? []).filter((i) => i.verdict === "blocked")) reasons.push(`${code(i.id)} on ${pageCell(i.page)} not checked. ${prose(sentence(i.why))}.`);
    if (r.counts?.claims === 0) reasons.push("sentence-claims.json has no claims.");
  } else if (check === "commands") {
    for (const i of (r.results ?? []).filter((i) => i.verdict === "blocked")) reasons.push(`${code(i.value)} on ${pageCell(i.file, [i.line])} not checked. ${prose(sentence(i.why))}.`);
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
  return r.verdict === "quote gone"
    ? `${code(r.quote)}. The quote is no longer on the rendered page. ${prose(r.why ?? "")}`
    : `${code(r.quote)}. The sentence states ${code(r.rule?.value)}. ${text(source)} has ${code(r.observed ?? "nothing")}. ${prose(r.why ?? "")}`;
};

// A version agreement finding also shows the latest version on Maven Central
// and the note for its line, from the versions and version agreement reports.
const pinOf = (item) => {
  const m = String(item.value).match(/^([^:\s]+):([^:\s]+):(\S+)$/);
  return m ? { group: m[1], artifact: m[2], version: m[3] } : null;
};
const extras = (item) => {
  if (item.check !== "version-agreement") return "";
  const pin = pinOf(item);
  if (!pin) return "";
  const lines = item.lines ?? [];
  const parts = [];
  const latest = (reports.versions?.results ?? []).find((r) => r.file === item.page && lines.includes(r.line) && r.group === pin.group && r.artifact === pin.artifact && r.version === pin.version && r.latest);
  if (latest) parts.push(`Latest on Maven Central ${code(latest.latest)}.`);
  for (const r of reports["version-agreement"]?.information ?? [])
    if (r.file === item.page && lines.includes(r.line) && (r.note.startsWith(`${pin.artifact} `) || r.note.startsWith(`names ${pin.artifact} `))) parts.push(`${prose(sentence(r.note))}.`);
  return parts.length ? ` ${parts.join(" ")}` : "";
};
const findingCell = (item) => {
  if (item.check === "sentence-claims") { const claim = claimDetail(item); if (claim) return claim; }
  return `${valueCell(item.value)}, ${prose(item.problem ?? item.source ?? "")}.${extras(item)}`;
};
const findingRows = (items) => items.map((item) => [checkName(item.check), pageCell(item.page, item.lines ?? []), findingCell(item)]);

// Headline. It names every reason the run did not pass.
const CHECK_WORDS = { claims: "claims", "page-symbols": "page symbols" };
const reasonText = (r) => {
  if (r.reason === "findings") return `${plural(r.count, "finding")}${runName && Number.isInteger(r.new) ? `, ${r.new || "none"} new compared with ${runName}` : ""}`;
  if (r.reason === "failed") return `${(r.checks ?? []).map((check) => CHECK_WORDS[check] ?? CHECK_NAMES[check]?.toLowerCase() ?? check).join(" and ")} failed`;
  if (r.reason === "blocked") return `${plural((r.checks ?? []).length, "check")} blocked`;
  if (r.reason === "not run") return `${plural(r.count, "check")} did not run`;
  if (r.reason === "no selection") return "the changed pages are unknown";
  if (r.reason === "touched") return `${plural(r.count, "finding")} on pages this pull request touches`;
  if (r.reason === "unread") return `${plural((r.checks ?? []).length, "check")} could not read every item`;
  if (r.reason === "missing page") return `${plural(r.count, "targets entry", "targets entries")} ${r.count === 1 ? "names" : "name"} a page that does not exist`;
  return r.text ?? r.reason;
};
const reasons = (summary.failReasons ?? []).map(reasonText);
if (summary.result !== "pass" && !reasons.length) reasons.push("the checks failed");
if (pr) {
  if (!reasons.length) reasons.push(summary.result === "pass" ? "no findings on pages this pull request touches" : "the checks failed");
  if (onMain.length) reasons.push(`${onMain.length} already on ${BASE}`);
  if (otherPages.length) reasons.push(`${otherPages.length} on other pages`);
  if (!compared) reasons.push(`not compared with ${BASE}`);
}
const lead = reasons.length ? reasons.join(", ") : "no findings";
add(`## ${prose(sentence(lead))}`);

// Where the run looked. The checks' own commit is the fork commit GitHub ran.
const SHA = oneLine(summary.checksCommit ?? process.env.GITHUB_SHA ?? "");
const toolsRepo = oneLine(process.env.GITHUB_REPOSITORY ?? "");
const toolsAt = /^[0-9a-f]{40}$/.test(SHA) && /^[\w.-]+\/[\w.-]+$/.test(toolsRepo)
  ? ` with checks from ${code(toolsRepo)} at ${link(`${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${toolsRepo}/commit/${SHA}`, code(SHA.slice(0, 7)))}`
  : ". The commit of the checks themselves is not known";
if (pr) add(para(`Checked the merge of ${PR_NUMBER ? `pull request ${link(`https://github.com/${DOCS_REPO}/pull/${PR_NUMBER}`, text(`#${PR_NUMBER}`))}` : "this pull request"} into ${code(BASE)}, at ${code(commit)}, with the checks it holds, ${text(String(summary.checkedAt ?? "").replace("T", " ").slice(0, 16))} UTC.`));
else add(para(`Checked ${code(DOCS_REPO)} at ${commitUrl ? link(commitUrl, code(commit)) : code(commit)}${toolsAt}, ${text(String(summary.checkedAt ?? "").replace("T", " ").slice(0, 16))} UTC.`));

// What the findings were compared with.
const day = (value) => text(String(value ?? "").slice(0, 10));
if (pr) {
  const runUrl = /^[\w.-]+\/[\w.-]+$/.test(toolsRepo) && compared ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${toolsRepo}/actions/runs/${comparison.runId}` : null;
  const parts = [];
  if (compared) parts.push(`Compared with ${text(BASE)}'s ${runUrl ? link(runUrl, text(runName)) : text(runName)} on ${day(comparison.createdAt)}.`);
  else parts.push(`Not compared with ${text(BASE)}, ${prose(comparison.status === "none" ? `${BASE} has no earlier run` : comparison.reason ?? "no reason given")}. Every finding on a touched page counts.`);
  if (compared && pr.noWaiver) parts.push(`No finding counts as already on ${text(BASE)}, because ${prose(pr.noWaiver)}.`);
  const files = Array.isArray(pr.files) ? pr.files : [];
  parts.push(pr.all ? `This pull request changes files that affect every page, ${prose((pr.reasons ?? []).slice(0, 5).join(", ") || "for a reason not given")}.` : `This pull request touches ${plural(files.length, "page")}${files.length ? `, ${files.slice(0, 10).map((f) => pageCell(f)).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}` : ""}.`);
  add(para(parts.join(" ")));
} else if (compared) {
  const runUrl = /^[\w.-]+\/[\w.-]+$/.test(toolsRepo) ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${toolsRepo}/actions/runs/${comparison.runId}` : null;
  add(para(`Compared with ${runUrl ? link(runUrl, text(runName)) : text(runName)} on ${day(comparison.createdAt)}.`));
  // A finding in a check the earlier run could not fully read may show as new
  // when it is not.
  const incomplete = [...new Set([...(comparison.blocked ?? []), ...(comparison.partial ?? [])])];
  const earlierNotRun = comparison.notRun ?? [];
  if (incomplete.length || earlierNotRun.length) {
    const parts = [];
    if (incomplete.length) parts.push(`${text(runName)} could not read everything in ${incomplete.map(checkName).join(", ")}`);
    if (earlierNotRun.length) parts.push(`${text(runName)} did not run ${earlierNotRun.map(code).join(", ")}`);
    add(para(`${sentence(parts.join(", and "))}. A finding in ${incomplete.length + earlierNotRun.length === 1 ? "that check" : "those checks"} may show as new when it is not.`));
  }
} else if (comparison.status === "none") {
  add(para("No earlier run to compare with."));
} else {
  add(para(`Comparison unavailable, ${prose(comparison.reason ?? "no reason given")}. Every finding is listed once.`));
}
add(para("A pass covers only the listed checks. Other prose, screenshots and whether code samples compile are not checked."));

// What to do, in the order a person should do it.
// A check that failed on one item can still have others it could not read.
// It is not blocked then, so their reasons go under What to do as review items.
const unreadItems = {
  versions: (r) => (r?.results ?? []).some((i) => i.verdict === "source unreachable"),
  "source-paths": (r) => (r?.unreachable ?? []).length > 0,
  "version-agreement": (r) => (r?.tableErrors ?? []).length > 0,
};
// The checks whose reasons go under the rerun item. In a pull request run,
// only checks that failed it. The others' reasons stay review items.
const unreadFail = pr ? [...new Set((summary.failReasons ?? []).find((r) => r.reason === "unread")?.checks ?? [])] : [];
const rerun = pr ? unreadFail : blocked;
const partlyRead = Object.keys(unreadItems).filter((check) => !rerun.includes(check) && unreadItems[check](reports[check]));
// run.mjs starts most Review needed lines with a check label and a colon. The
// summary shows the check's name in bold and the rest as a sentence.
const LINE_NAMES = { select: "Changed pages", "page symbols": "Page symbols" };
const reviewLine = (line) => {
  const m = oneLine(line).match(/^([a-z][a-z -]*): (.+)$/);
  if (!m) return prose(line);
  const check = REVIEW_LABELS[`${m[1]}:`] ?? Object.keys(CHECK_NAMES).find((key) => key === m[1] || key === m[1].replaceAll(" ", "-"));
  const name = check ? checkName(check) : text(LINE_NAMES[m[1]] ?? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}`);
  // An id or a path keeps its case. Every line ends with a full stop.
  const rest = /^[^\s]*[/.]/.test(m[2]) ? m[2] : sentence(m[2]);
  return `<b>${name}</b>. ${prose(rest)}${/[.!?]$/.test(oneLine(rest)) ? "" : "."}`;
};
const otherReview = review.filter((line) => {
  const label = Object.keys(REVIEW_LABELS).find((l) => line.startsWith(l));
  const check = label ? REVIEW_LABELS[label] : Object.keys(CHECK_NAMES).find((key) => line.startsWith(`${key}:`));
  return !(check && (rerun.includes(check) || partlyRead.includes(check)));
});
// Each item is HTML. Reasons from blockedReasons are escaped already.
const reviewItems = [
  ...partlyRead.flatMap((check) => blockedReasons(check).map((reason) => `<b>${checkName(check)}</b>. Some items not checked. ${reason}`)),
  ...otherReview.map((line) => reviewLine(line)),
];
const todo = [];
if (notRun.length) todo.push(`Fix the run. Not run ${notRun.map(code).join(", ")}.`);
if (pr) {
  if (unreadFail.length) {
    const why = unreadFail.flatMap((check) => blockedReasons(check).map((reason) => `<b>${checkName(check)}</b>. ${reason}`));
    todo.push(`Rerun the workflow. ${unreadFail.map(checkName).join(", ")} could not read every item on the pages this pull request touches, or did not finish. A blocked site or a slow registry usually clears on a rerun. If it does not, fix the cause.${list(why.slice(0, ROWS))}`);
  }
} else if (blocked.length) {
  const why = blocked.flatMap((check) => blockedReasons(check).map((reason) => `<b>${checkName(check)}</b>. ${reason}`));
  todo.push(`Rerun the workflow. ${plural(blocked.length, "check")} could not decide, ${blocked.map(checkName).join(", ")}. If a rerun is blocked again, fix the cause.${list(why.slice(0, ROWS))}`);
}
const failedOther = (summary.failReasons ?? []).find((r) => r.reason === "failed");
if (failedOther) todo.push(`Read run-output.txt for ${failedOther.checks.map(checkName).join(" and ")}. ${failedOther.checks.length === 1 ? "It" : "They"} failed without a finding this summary can list.`);
if (reviewItems.length) todo.push(`Read ${plural(reviewItems.length, "item")} the checks could not settle.${list(reviewItems.slice(0, ROWS).concat(reviewItems.length > ROWS ? [`And ${reviewItems.length - ROWS} more. The full list is in summary.json.`] : []))}`);
const missingPages = pr && Array.isArray(pr.missingPages) ? pr.missingPages : [];
if (missingPages.length) todo.push(`Fix each targets entry that names a page that does not exist. Point it at the page, or remove it if the page is gone.${list(missingPages.slice(0, ROWS).map((entry) => `${entry.id ? code(entry.id) : "An entry without an id"}, ${prose(entry.kind)} in ${code(String(entry.file ?? "").split("/").pop())}, names ${entry.page ? code(entry.page) : "no page"}.`))}`);
const removed = pr && Array.isArray(pr.removed) ? pr.removed : [];
if (removed.length) todo.push(`Confirm each check this pull request removes. Its page stays, so the removal must be meant, for example a claim whose sentence was reworded.${list(removed.slice(0, ROWS).map((entry) => `${code(entry.id)}, ${prose(entry.kind)} in ${code(String(entry.file ?? "").split("/").pop())}, for ${pageCell(entry.page)}.`))}`);
const refused = pr ? [...(reports.links?.blocked ?? []), ...(reports.links?.unreachable ?? [])].filter((r) => (r.usedOn ?? []).some((page) => pr.all || (pr.routes ?? []).includes(page))) : [];
if (refused.length) todo.push(`Open each link by hand before merging. ${plural(refused.length, "link")} on the pages this pull request touches could not be judged. ${refused.length === 1 ? "It is" : "They are"} under Not compared.`);
if (pr) {
  if (toFix.length) todo.push(`Fix each finding on the pages this pull request touches. If a check is wrong, fix the check. Findings already on ${text(BASE)}, and on other pages, are not this pull request's to fix.`);
} else if (findings.length) todo.push(`${news.length ? `Start with the ${plural(news.length, "new finding")}. ` : ""}Fix each finding in the docs, or post a GitHub issue if it needs a decision. If a check is wrong, fix the check instead.`);
if (todo.length) {
  add(heading("What to do"));
  add(list(todo));
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
if (pr) add(table(["Check", "Result", "Checked", "Findings", "To fix here"], Object.entries(summary.checks ?? {}).map(([check, result]) => [
  checkName(check), result === "pass" ? "pass" : `<b>${text(result)}</b>`, text(checked(check)), String(countBy(findings, check)), String(countBy(toFix, check)),
])));
else add(table(["Check", "Result", "Checked", "Findings", ...(compared ? ["New"] : [])], Object.entries(summary.checks ?? {}).map(([check, result]) => [
  checkName(check), result === "pass" ? "pass" : `<b>${text(result)}</b>`, text(checked(check)), String(countBy(findings, check)), ...(compared ? [String(countBy(news, check))] : []),
])));
if (pr) {
  const changed = toFix.filter((item) => item.new === false && item.changedOnMain).length;
  if (unreadFail.length === 0 && Object.values(summary.checks ?? {}).includes("blocked")) add(para(`A check marked blocked could not read some items, but none on the pages this pull request touches. The next scheduled run on ${text(BASE)} reads them again.`));
  if (changed) add(para(`${plural(changed, "finding")} below ${changed === 1 ? "was" : "were"} in ${text(BASE)}'s run, but ${text(BASE)} changed ${changed === 1 ? "its page" : "their pages"} since, so ${changed === 1 ? "it counts" : "they count"} here.`));
}

const FINDING_HEAD = ["Check", "Page", "Finding"];
if (pr) {
  if (toFix.length) {
    add(heading(`On touched pages (${toFix.length})`));
    add(table(FINDING_HEAD, findingRows(toFix)));
  }
  if (onMain.length) add(folded(`Already on ${text(BASE)} (${onMain.length})`, [table(FINDING_HEAD, findingRows(onMain))]));
  if (otherPages.length) add(folded(`Not touched by this pull request (${otherPages.length})`, [table(FINDING_HEAD, findingRows(otherPages))]));
} else if (compared) {
  if (news.length) {
    add(heading(`New compared with ${text(runName)} (${news.length})`));
    add(table(FINDING_HEAD, findingRows(news)));
  }
  if (also.length) add(folded(`Also found in ${text(runName)} (${also.length})`, [table(FINDING_HEAD, findingRows(also))]));
} else if (findings.length) {
  add(heading(`Findings (${findings.length})`));
  add(table(FINDING_HEAD, findingRows(findings)));
}

// Worth a look, and Not compared, with the items behind each count.
const look = [], skipped = [];
const links = reports.links;
const usedOn = (r) => (r.usedOn ?? []).map((p) => pageCell(p)).join(", ");
if (links?.redirected?.length) look.push(["Links redirected to another host", "Before changing a link, open where it lands and confirm it is the same content.", ["Link", "Lands on", "Used on"], links.redirected.map((r) => [valueCell(r.url), valueCell(r.finalUrl), usedOn(r)])]);
// A version behind the latest that is also a finding shows its latest version
// in the finding, so it is left out here.
const inFinding = (file, line, value) => findings.some((item) => item.page === file && item.value === value && (item.lines ?? []).includes(line));
const behind = (reports.versions?.results ?? []).filter((r) => r.verdict === "behind" && !inFinding(r.file, r.line, `${r.group}:${r.artifact}:${r.version}`));
if (behind.length) look.push(["Versions behind the latest on Maven Central", "The latest version is not always the right one. Check the versions table and compatibility before changing a version.", ["Page", "Package", "Page names", "Latest"], behind.map((r) => [pageCell(r.file, [r.line]), code(`${r.group}:${r.artifact}`), code(r.version), code(r.latest)])]);
// A note on a line with a finding is shown in the finding.
const noteInFinding = (r) => findings.some((item) => item.check === "version-agreement" && item.page === r.file && (item.lines ?? []).includes(r.line) && pinOf(item) && (r.note.startsWith(`${pinOf(item).artifact} `) || r.note.startsWith(`names ${pinOf(item).artifact} `)));
const notes = (reports["version-agreement"]?.information ?? []).filter((r) => !noteInFinding(r));
if (notes.length) look.push(["Version agreement notes", null, ["Page", "Note"], notes.map((r) => [pageCell(r.file, [r.line]), prose(r.note)])]);
const covered = (reports.lists?.lists ?? []).flatMap((l) => (l.covered ?? []).map((r) => ({ ...r, id: l.id })));
if (covered.length) look.push(["List values accepted through a parent path", "The page lists the parent path, which covers the value in the code.", ["List", "Value in the code", "Parent on the page"], covered.map((r) => [code(r.id), code(r.value), code(r.parent)])]);

const onTouched = (r) => pr && (r.usedOn ?? []).some((page) => pr.all || (pr.routes ?? []).includes(page));
const touchedNote = (r) => (onTouched(r) ? " On a touched page, open it by hand before merging." : "");
if (links?.blocked?.length) skipped.push(["Links not judged, the site refused or failed", links.blocked.map((r) => `${valueCell(r.url)}, answered ${code(r.status)}, used on ${usedOn(r)}.${touchedNote(r)}`)]);
if (links?.unreachable?.length) skipped.push(["Links not reached, network error", links.unreachable.map((r) => `${valueCell(r.url)}, ${code(r.error)}, used on ${usedOn(r)}.${touchedNote(r)}`)]);
// Only versions the mirror listed. A version it did not list is under What to do instead.
const mirrored = new Map();
for (const r of reports.versions?.results ?? []) {
  if (r.verdict !== "published" || r.registry !== "Google mirror") continue;
  const pkg = `${r.group}:${r.artifact}`;
  const entry = mirrored.get(pkg) ?? { why: r.centralError, versions: new Set() };
  entry.versions.add(r.version);
  mirrored.set(pkg, entry);
}
if (mirrored.size) skipped.push(["Versions confirmed only on the Google mirror of Maven Central. Whether each is the latest was not compared", [...mirrored].map(([pkg, e]) => `${code(pkg)}, ${[...e.versions].map(code).join(", ")}. Maven Central answered ${prose(e.why)}.`)]);
const builtIn = (reports.commands?.results ?? []).filter((r) => r.verdict === "information");
if (builtIn.length) skipped.push(["Commands with nothing to compare", builtIn.map((r) => `${pageCell(r.file, [r.line])}, ${code(r.command)}, ${prose(r.why)}.`)]);
if (reports["source-paths"]?.skipped?.length) skipped.push(["Gradle modules skipped on pages listed under skip", reports["source-paths"].skipped.map((r) => `${pageCell(r.file, [r.line])}, ${code(r.module)}.`)]);
// Some reports give only a count of what they skipped.
const skippedCounts = [];
const addCount = (n, words) => { if (Number.isInteger(n) && n > 0) skippedCounts.push([n, words(n)]); };
addCount(links?.counts?.skipped, (n) => `${plural(n, "link")} to local or example hosts`);
addCount(reports.versions?.counts?.skipped, (n) => `${plural(n, "Maven block")} without a literal version, in the package versions check`);
// notChecked counts pins a table error kept from being compared. They are
// under What to do, not here.
addCount(reports["version-agreement"]?.counts?.skipped, (n) => `${plural(n, "version use")} with no rule in the versions table`);

const lookSection = ([title, advice, head, rows]) => `<p><b>${title} (${rows.length})</b>${advice ? ` ${advice}` : ""}</p>\n${table(head, rows)}`;
const skipSection = ([title, rows]) => `<p><b>${title} (${rows.length})</b></p>\n${list(rows.slice(0, ROWS).concat(rows.length > ROWS ? [`And ${rows.length - ROWS} more. The full list is in the reports.`] : []))}`;
if (look.length) add(folded(`Worth a look (${look.reduce((n, [, , , rows]) => n + rows.length, 0)}). Nothing here fails the run.`, look.map(lookSection)));
if (skipped.length || skippedCounts.length) {
  const parts = skipped.map(skipSection);
  if (skippedCounts.length) parts.push(para(`Also skipped, counted in the reports only. ${skippedCounts.map(([, words]) => text(words)).join(". ")}.`));
  if (blocked.length || partlyRead.length) parts.push(para("Items the checks could not read are under What to do, not here."));
  add(folded(`Not compared (${skipped.reduce((n, [, rows]) => n + rows.length, 0) + skippedCounts.reduce((n, [k]) => n + k, 0)}). The checks skipped these, so a pass says nothing about them.`, parts));
}
const missingReports = Object.keys(reports).filter((check) => reports[check] == null && !blocked.includes(check));
if (missingReports.length) add(para(`No readable report for ${missingReports.map(checkName).join(", ")}, so its details are not shown.`));

finish(para(`Reports are in ${text(ARTIFACT)}${RUN_URL ? ` on ${link(RUN_URL, "the run page")}` : ""}. Findings are in summary.json. Check output is in run-output.txt.`));
