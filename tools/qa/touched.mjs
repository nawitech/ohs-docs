// Works out which pages a pull request touches, for the pull request run of the
// docs checks. It reads git only.
//
//   node tools/qa/touched.mjs [--base <commit>] [--head <commit>] [--since <commit>] > touched.json
//
// head is the pull request's merge commit, HEAD by default. base is the base
// branch commit the merge was made on, HEAD^1 by default, the merge commit's
// first parent.
//
// A page is touched when the pull request adds, changes or renames its
// Markdown file under docs/, or adds, changes or removes its entry in one of
// the four targets files. Every page is touched when the pull request changes
// a file that can change results on any page, such as the versions table, the
// route contract, the site's code or the checks.
//
// --since is the commit of main's latest scheduled run. touched.mjs then also
// lists the pages main changed from that commit to base, the same way. run.mjs
// does not excuse a finding on a page main changed since that run, because the
// run's findings no longer describe that page. If the commit cannot be read,
// sinceOk is false and nothing is excused.
//
// For main, a page it deleted or renamed counts as changed too, under its old
// path and its new one, with the routes it had at both commits.
//
// Removing a page does not touch it. Targets entries the pull request removes
// while their page stays are listed under removed, for a person to confirm.
// A targets entry the pull request adds or changes, or leaves behind when it
// removes the page, can name a page that does not exist after the pull request.
// Such entries are listed under missingPages, and run.mjs fails on them.
import { spawnSync } from "node:child_process";
import { repositoryRoot } from "../scripts/shared.mjs";
import { routeOfSlug, slugOf } from "./lib.mjs";

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const head = option("--head", "HEAD");
const base = option("--base", "HEAD^1");
const since = option("--since", null);

const git = (...args) => spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (commit, path) => {
  const run = git("show", `${commit}:${path}`);
  return run.status === 0 ? run.stdout : null;
};
// A page file, not a folder or the repository root, which git also finds.
const pageAt = (commit, path) => isPage(path) && git("cat-file", "-t", `${commit}:${path}`).stdout.trim() === "blob";
const fail = (message) => {
  console.error(`Error: ${message}`);
  process.exit(1);
};

const TARGETS = ["tools/qa/gradle-targets.json", "tools/qa/list-targets.json", "tools/qa/sentence-claims.json", "tools/qa/command-targets.json"];
const EVERY_PAGE = ["docs/fhir-foundations/versions.md", "tools/routes.json", "docusaurus.config.js", "sidebars.js", "package.json", "package-lock.json"];
const everyPage = (path) => EVERY_PAGE.includes(path) || ["src/", "static/", "tools/scripts/"].some((folder) => path.startsWith(folder))
  || (path.startsWith("tools/qa/") && !TARGETS.includes(path));
const isPage = (path) => path.startsWith("docs/") && /\.mdx?$/.test(path);

// Each changed path as { status, path, from }, from git diff with renames.
function changes(from, to) {
  const run = git("diff", "--name-status", "--find-renames", "-z", from, to);
  if (run.status !== 0) fail(`git diff ${from} ${to} failed, ${run.stderr.trim().split("\n")[0]}`);
  const parts = run.stdout.split("\0").filter((part) => part !== "");
  const out = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) out.push({ status: status[0], from: parts[i++], path: parts[i++] });
    else out.push({ status, path: parts[i++] });
  }
  return out;
}

// The targets entries that differ between two commits. Keyed files compare by
// page, lists and claims by id. Any other top-level change, a file that is not
// valid JSON, or a list or claim whose id is missing or used twice, makes
// every page count.
const KEYED = { "tools/qa/gradle-targets.json": ["pages", "skip"], "tools/qa/command-targets.json": ["pages"] };
const LISTED = { "tools/qa/list-targets.json": ["lists", "list"], "tools/qa/sentence-claims.json": ["claims", "claim"] };
const parseTargets = (commit, file) => {
  const text = show(commit, file);
  if (text === null) return {};
  try { return JSON.parse(text); } catch { return null; }
};
function targetsDiff(from, to, file) {
  const a = parseTargets(from, file), b = parseTargets(to, file);
  if (!a || !b) return { everyPage: `${file} is not valid JSON` };
  const changed = new Set(), removed = [];
  const known = ["about", ...(KEYED[file] ?? []), ...(LISTED[file] ? [LISTED[file][0]] : [])];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!known.includes(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return { everyPage: `${file} changed its ${key}` };
  }
  for (const key of KEYED[file] ?? []) {
    const before = a[key] ?? {}, after = b[key] ?? {};
    for (const page of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[page]) === JSON.stringify(after[page])) continue;
      changed.add(page);
      if (!(page in after)) removed.push({ file, kind: `${key} entry`, id: page, page });
    }
  }
  if (LISTED[file]) {
    const [key, kind] = LISTED[file];
    for (const data of [a, b]) {
      const ids = (Array.isArray(data[key]) ? data[key] : []).map((entry) => entry?.id);
      if (ids.some((id) => typeof id !== "string")) return { everyPage: `${file} has a ${kind} without an id` };
      const twice = ids.find((id, at) => ids.indexOf(id) !== at);
      if (twice !== undefined) return { everyPage: `${file} has two ${kind}s with id ${twice}` };
    }
    const byId = (list) => new Map((Array.isArray(list) ? list : []).map((entry) => [entry?.id, entry]));
    const before = byId(a[key]), after = byId(b[key]);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(id), now = after.get(id);
      if (JSON.stringify(old) === JSON.stringify(now)) continue;
      for (const entry of [old, now]) if (entry && typeof entry.page === "string") changed.add(entry.page);
      if (!now) removed.push({ file, kind, id, page: old.page });
    }
  }
  return { changed, removed };
}

// Every targets entry at a commit as { file, kind, id, page, same }, where
// same is the entry's JSON, to tell whether another commit has it unchanged.
function entriesAt(commit, file) {
  const data = parseTargets(commit, file);
  if (!data) return [];
  const out = [];
  for (const key of KEYED[file] ?? []) {
    for (const [page, value] of Object.entries(data[key] ?? {})) out.push({ file, kind: `${key} entry`, id: page, page, same: JSON.stringify([key, page, value]) });
  }
  if (LISTED[file]) {
    const [key, kind] = LISTED[file];
    for (const entry of Array.isArray(data[key]) ? data[key] : []) {
      out.push({ file, kind, id: typeof entry?.id === "string" ? entry.id : null, page: typeof entry?.page === "string" ? entry.page : null, same: JSON.stringify(entry) });
    }
  }
  return out;
}

// The files a span of commits touches, the reasons every page counts, and the
// targets entries it removes. Files include deleted pages and both paths of a
// rename. For the pull request, only pages that exist after it are kept.
// routesOf then reads each file's slug at each of the given commits that has
// the file.
function touchedBetween(from, to) {
  const files = new Set(), reasons = [], removed = [];
  for (const change of changes(from, to)) {
    for (const path of [change.path, change.from].filter(Boolean)) {
      if (everyPage(path)) reasons.push(`${path} changed`);
      if (isPage(path)) files.add(path);
    }
  }
  for (const file of TARGETS) {
    const diff = targetsDiff(from, to, file);
    if (diff.everyPage) { reasons.push(diff.everyPage); continue; }
    for (const page of diff.changed) files.add(page);
    removed.push(...diff.removed);
  }
  return { files, reasons, removed };
}
const routesOf = (files, commits) => {
  const routes = new Set(), unknown = [];
  for (const file of files) {
    for (const text of commits.filter((commit) => pageAt(commit, file)).map((commit) => show(commit, file))) {
      const route = routeOfSlug(slugOf(text));
      if (route) routes.add(route);
      else unknown.push(`${file} has no slug that starts with /`);
    }
  }
  return { routes, unknown };
};

for (const commit of [head, base]) if (git("rev-parse", "--verify", "--quiet", `${commit}^{commit}`).status !== 0) fail(`commit ${commit} not found`);

const pull = touchedBetween(base, head);
// Only pages that exist after the pull request can be touched.
const files = [...pull.files].filter((file) => pageAt(head, file)).sort();
const { routes, unknown } = routesOf(files, [head]);
const reasons = [...new Set([...pull.reasons, ...unknown])];
const removed = pull.removed.filter((entry) => typeof entry.page === "string" && pageAt(head, entry.page));
// Entries after the pull request that name no page, or a page file under docs/
// that does not exist, when the pull request added or changed the entry or removed its page.
// An entry that was already broken on main is main's to fix.
const missingPages = [];
for (const file of TARGETS) {
  const before = new Set(entriesAt(base, file).map((entry) => entry.same));
  for (const { same, ...entry } of entriesAt(head, file)) {
    const changed = !before.has(same);
    const missing = entry.page === null ? changed : !pageAt(head, entry.page) && (changed || pageAt(base, entry.page));
    if (missing) missingPages.push(entry);
  }
}

const out = { all: reasons.length > 0, reasons, files, routes: [...routes].sort(), removed, missingPages, since: null, sinceOk: false, mainChangedAll: false, mainChangedReasons: [], mainChanged: { files: [], routes: [] } };

if (since) {
  out.since = since;
  // A checkout made with fetch-depth 2 may not hold the run's commit. One
  // shallow fetch gets it. Comparing two trees needs no history between them.
  const have = () => git("cat-file", "-e", `${since}^{commit}`).status === 0;
  if (!have() && /^[0-9a-f]{40}$/.test(since)) git("fetch", "--quiet", "--depth", "1", "origin", since);
  if (have()) {
    const main = touchedBetween(since, base);
    for (const entry of main.removed) if (typeof entry.page === "string") main.files.add(entry.page);
    const mainFiles = [...main.files].sort();
    const mainRoutes = routesOf(mainFiles, [base, since]);
    out.sinceOk = true;
    out.mainChangedReasons = [...new Set([...main.reasons, ...mainRoutes.unknown])];
    out.mainChangedAll = out.mainChangedReasons.length > 0;
    out.mainChanged = { files: mainFiles, routes: [...mainRoutes.routes].sort() };
  }
}

console.log(JSON.stringify(out, null, 2));
