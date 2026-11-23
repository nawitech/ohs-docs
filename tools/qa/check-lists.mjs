// Checks lists that must match the code. For each list in list-targets.json, reads every value
// from the source files and every value in one table column on the page, then
// compares the two lists in both directions.
//
//   node tools/qa/check-lists.mjs [report directory] [targets file]
//
// The targets file defaults to list-targets.json beside this script. Another
// file is for tests. A list in a test file may set readFrom to a local folder,
// and the source files are then read from there instead of GitHub.
//
// The other checks test values a page already names. This one also finds a
// value the code added that no page mentions, such as a new Portal screen.
//
// Fails: a value in the code that is not on the page, or a value on the page
// that is not in the code. Information: a path that is its parent plus one
// parameter, such as /resources/:resourceType, when the parent is on the page.
// Blocked: the commit or a source that cannot be read, a route the reader
// cannot read for sure (built from a variable, relative, nested or an index
// route), a table or column that cannot be found, or an empty list on either
// side. A blocked list compares nothing, because a partial list would report
// false differences or hide real ones.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteRoot, toolsRoot } from "../scripts/shared.mjs";
import { pageColumn, request, writeReport } from "./lib.mjs";

const targets = JSON.parse(readFileSync(process.argv[3] ?? join(toolsRoot, "qa", "list-targets.json"), "utf8"));

// The commit each repository's default branch points at, so every file of one
// list is read at the same commit and the report records it. git ls-remote
// needs no API token and has no API rate limit. If it fails, the list is
// blocked, because files read at HEAD one by one could come from different
// commits.
const commits = new Map();
function commitOf(repository) {
  if (commits.has(repository)) return commits.get(repository);
  const run = spawnSync("git", ["ls-remote", `https://github.com/${repository}.git`, "HEAD"], { encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const sha = run.status === 0 ? run.stdout.match(/^([0-9a-f]{40})\tHEAD$/m)?.[1] ?? null : null;
  commits.set(repository, sha);
  return sha;
}

// Comments are blanked out first, so a commented-out route does not count.
// String literals are skipped while scanning, so "//" or "/*" inside a string
// is not taken for a comment. Newlines are kept, so line numbers stay right.
function blankComments(code) {
  let out = "", i = 0;
  while (i < code.length) {
    const c = code[i], next = code[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") { out += " "; i += 1; }
    } else if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else { out += c; i += 1; }
  }
  return out;
}
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

// Route paths in React Router code, as object keys (path: "/x") or JSX
// attributes (path="/x", path={"/x"}), with any quote style. A path the reader
// cannot be sure of is an error, so the list is blocked, not passed:
// - a path from a variable or a template literal with ${}, unless the source
//   names that expression in allowDynamic, such as route.path in a loop over a
//   list read elsewhere
// - a relative path, which belongs to a parent route
// - a children array or an index route, which this reader does not follow
function routePaths(text, file, allowDynamic = []) {
  const found = [], errors = [];
  for (const match of text.matchAll(/\bpath\s*(?::|=)\s*/g)) {
    const rest = text.slice(match.index + match[0].length);
    const line = lineAt(text, match.index);
    const literal = rest.match(/^\{?\s*(['"`])((?:(?!\1)[^\\$\n])*)\1/);
    if (literal) {
      const value = literal[2];
      if (value.startsWith("/") || value === "*") found.push({ value, file, line });
      else errors.push(`${file}:${line} has the relative path "${value}", which this reader does not follow`);
      continue;
    }
    const expression = rest.match(/^\{?\s*([A-Za-z_$][\w$.]*)/)?.[1];
    if (expression && allowDynamic.includes(expression)) continue;
    errors.push(`${file}:${line} has a path this reader cannot read: ${rest.slice(0, 40).split("\n")[0]}`);
  }
  for (const match of text.matchAll(/\bchildren\s*:\s*\[|<Route\b[^>]*\sindex\b|\bindex\s*:\s*true/g))
    errors.push(`${file}:${lineAt(text, match.index)} has nested or index routes, which this reader does not follow`);
  return { found, errors };
}

const lists = [];
for (const target of targets.lists) {
  const errors = [];
  const sha = target.readFrom ? "local" : commitOf(target.repository);
  if (!sha) errors.push(`commit of ${target.repository} not read, git ls-remote failed`);

  // Code side.
  const sources = [];
  const code = [];
  for (const source of sha ? target.sources : []) {
    const url = target.readFrom ? join(target.readFrom, source.file) : `https://raw.githubusercontent.com/${target.repository}/${sha}/${source.file}`;
    try {
      const response = target.readFrom ? new Response(readFileSync(url, "utf8")) : await request(url);
      if (!response.ok) { errors.push(`${source.file} not read, status ${response.status}`); sources.push({ ...source, url, error: `status ${response.status}` }); continue; }
      const { found, errors: unread } = routePaths(blankComments(await response.text()), source.file, source.allowDynamic);
      errors.push(...unread);
      if (found.length === 0) errors.push(`${source.file} read, but no route path was found`);
      sources.push({ ...source, url, found: found.length });
      code.push(...found);
    } catch (error) {
      const reason = String(error.cause?.code ?? error.message);
      errors.push(`${source.file} not read, ${reason}`);
      sources.push({ ...source, url, error: reason });
    }
  }
  const ignored = code.filter((item) => target.ignore?.includes(item.value));
  const codeValues = code.filter((item) => !target.ignore?.includes(item.value));

  // Page side.
  let pageValues = [];
  try {
    const column = pageColumn(readFileSync(join(siteRoot, target.page), "utf8"), target.heading, target.column);
    if (column.error) errors.push(`${target.page}: ${column.error}`);
    else pageValues = column.values;
  } catch (error) {
    errors.push(`${target.page} not read, ${error.message}`);
  }
  if (pageValues.length === 0 && !errors.some((error) => error.startsWith(target.page))) errors.push(`${target.page}: the "${target.column}" column is empty`);

  // Compare, unless a side could not be read. A partial list would report
  // false differences.
  const onPage = new Set(pageValues.map((item) => item.value));
  const inCode = new Set(codeValues.map((item) => item.value));
  let missingFromPage = [], goneFromCode = [], covered = [];
  if (errors.length === 0) {
    for (const item of codeValues) {
      if (onPage.has(item.value)) continue;
      // Covered only when the path is its parent plus exactly one parameter.
      const parent = item.value.match(/^(\/.*)\/:[A-Za-z_]\w*$/)?.[1] ?? null;
      if (parent && onPage.has(parent)) covered.push({ ...item, parent });
      else missingFromPage.push(item);
    }
    goneFromCode = pageValues.filter((item) => !inCode.has(item.value));
  }
  lists.push({
    id: target.id, name: target.name, page: target.page, repository: target.repository, commit: sha ?? "unknown",
    sources, errors, code: codeValues, ignored, onPage: pageValues, missingFromPage, goneFromCode, covered,
  });
}

for (const list of lists) {
  for (const error of list.errors) console.log(`blocked  ${list.id}  ${error}`);
  for (const item of list.missingFromPage) console.log(`not on page  ${list.id}  ${item.value}  in ${item.file}:${item.line}, missing from ${list.page}`);
  for (const item of list.goneFromCode) console.log(`not in code  ${list.id}  ${item.value}  on ${list.page}:${item.line}, not in ${list.repository} at ${list.commit.slice(0, 7)}`);
  for (const item of list.covered) console.log(`note  ${list.id}  ${item.value} is covered by ${item.parent} on the page`);
  console.log(`${list.id}: ${list.code.length} in code at ${list.commit.slice(0, 7)} (${list.ignored.length} ignored), ${list.onPage.length} on the page. ` +
    `${list.missingFromPage.length} not on the page, ${list.goneFromCode.length} not in the code, ${list.covered.length} covered by a parent.`);
}

const sum = (key) => lists.reduce((total, list) => total + list[key].length, 0);
await writeReport("lists.json", {
  counts: { lists: lists.length, inCode: sum("code"), onPage: sum("onPage"), missingFromPage: sum("missingFromPage"), goneFromCode: sum("goneFromCode"), covered: sum("covered"), errors: sum("errors") },
  lists,
});
// A blocked list also exits 1, so the script never passes on its own when it
// compared nothing.
if (sum("missingFromPage") + sum("goneFromCode") + sum("errors") > 0) process.exitCode = 1;
