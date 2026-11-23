// Checks the sentence claims in sentence-claims.json. Each claim is a quote on
// a page and one rule that its source files can decide.
//
//   node tools/qa/check-sentence-claims.mjs [report directory] [claims file]
//
// The claims file defaults to sentence-claims.json beside this script. Another
// file is for tests. A claim in a test file may set readFrom to a local folder,
// and its source files are then read from there instead of GitHub.
//
// A list-count claim reads no repository. It compares the number its quote
// states with the rows of a list's column on the same page.
//
// Verdicts, one per claim:
// - match: the quote is on the page and the source agrees with it.
// - mismatch: the source says something else. Fails.
// - quote gone: the quote is no longer on the rendered page. Fails, because
//   the claim no longer describes the page and needs upkeep.
// - blocked: the commit or a source could not be read, the source uses a form
//   this reader does not follow, or the claim itself is broken, such as a rule
//   value the quote does not contain.
// A file with no claims counts as blocked, so an empty file cannot pass.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteRoot, toolsRoot } from "../scripts/shared.mjs";
import { pageColumn, request, writeReport } from "./lib.mjs";

const claimsFile = process.argv[3] ?? join(toolsRoot, "qa", "sentence-claims.json");
// list-count claims name a list in list-targets.json, or in listsFile for tests.
const { claims } = JSON.parse(readFileSync(claimsFile, "utf8"));

// Quotes match exactly, ignoring only spaces and letter case. HTML and MDX
// comments are removed from the page first, because they do not render.
const normal = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
const rendered = (page) => page.replace(/<!--[\s\S]*?-->/g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

// Every source of one repository is read at one commit, recorded in the report.
const commits = new Map();
function commitOf(repository) {
  if (commits.has(repository)) return commits.get(repository);
  const run = spawnSync("git", ["ls-remote", `https://github.com/${repository}.git`, "HEAD"],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const sha = run.status === 0 ? run.stdout.match(/^([0-9a-f]{40})\tHEAD$/m)?.[1] ?? null : null;
  commits.set(repository, sha);
  return sha;
}

const files = new Map();
async function sourceText(claim, path) {
  const { repository } = claim.source;
  if (claim.readFrom) {
    try {
      return { commit: "local", text: readFileSync(join(claim.readFrom, path), "utf8") };
    } catch (error) {
      return { error: `${path} not read, ${error.code ?? error.message}` };
    }
  }
  const sha = commitOf(repository);
  if (!sha) return { error: `commit of ${repository} not read, git ls-remote failed` };
  const key = `${repository}/${sha}/${path}`;
  if (!files.has(key)) {
    try {
      const response = await request(`https://raw.githubusercontent.com/${key}`);
      files.set(key, response.ok ? { commit: sha, text: await response.text() } : { error: `${path} not read, status ${response.status}` });
    } catch (error) {
      files.set(key, { error: `${path} not read, ${error.cause?.code ?? error.message}` });
    }
  }
  return files.get(key);
}

// The value of one key in a .env file. The key must be set exactly once. A
// value in quotes must close on its line and have nothing after it but a
// comment. An unquoted value must be plain, with no quotes, spaces or $. Any
// other form is blocked rather than guessed. Multiline quoted values of other
// keys are skipped, so text inside them is never read as an assignment.
function envValue(text, key) {
  const values = [];
  let open = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (open) {
      if (line.includes(open)) open = null;
      continue;
    }
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const [, name, raw] = match;
    const value = raw.trim();
    const quote = value.match(/^(['"])/)?.[1];
    if (name !== key) {
      if (quote && value.indexOf(quote, 1) < 0) open = quote;
      continue;
    }
    if (quote) {
      const close = value.indexOf(quote, 1);
      if (close < 0) return { blocked: `${key} has a multiline value, which this reader does not follow` };
      if (!/^\s*(#.*)?$/.test(value.slice(close + 1))) return { blocked: `${key} has text after its quoted value: ${value}` };
      values.push(value.slice(1, close));
    } else {
      const plain = value.replace(/\s+#.*$/, "").trim();
      if (/["'$\s]/.test(plain)) return { blocked: `${key} has a value this reader cannot read: ${value}` };
      values.push(plain);
    }
  }
  if (values.length > 1) return { blocked: `${key} is set ${values.length} times` };
  if (values.length === 0) return { found: null, why: `${key} is not set` };
  return { found: values[0] };
}

// The ports one Compose service publishes, read with a YAML parser, so
// anchors, merge keys and flow lists work as Compose reads them. Each port is
// host, target and protocol. A host port from ${VAR} is resolved from the
// claim's envFile. A port range, or a variable with no envFile, is blocked.
let yaml;
async function composePorts(claim, text) {
  try {
    yaml ??= (await import("js-yaml")).default;
  } catch {
    return { blocked: "js-yaml is not installed. It comes with the docs' npm ci" };
  }
  let doc;
  try {
    doc = yaml.load(text);
  } catch (error) {
    return { blocked: `${claim.source.path} is not valid YAML, ${error.reason ?? error.message}` };
  }
  const service = doc?.services?.[claim.rule.service];
  if (!doc?.services) return { blocked: `${claim.source.path} has no top-level services` };
  if (!service) return { found: [], why: `no service ${claim.rule.service}` };
  const env = claim.rule.envFile ? await sourceText(claim, claim.rule.envFile) : null;
  if (env?.error) return { blocked: env.error };
  const resolve = (value) => {
    const variable = String(value).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}$/)?.[1];
    if (!variable) return String(value).includes("$") ? { blocked: `a host port this reader cannot read: ${value}` } : { value: String(value) };
    if (!env) return { blocked: `the host port ${value} is a variable, and the rule names no envFile` };
    const result = envValue(env.text, variable);
    if (result.blocked) return { blocked: result.blocked };
    if (result.found === null) return { blocked: `${variable} is not set in ${claim.rule.envFile}` };
    return { value: result.found };
  };
  const ports = [];
  for (const entry of service.ports ?? []) {
    let host, target, protocol = "tcp";
    if (typeof entry === "object" && entry !== null) {
      [host, target, protocol] = [entry.published, entry.target, entry.protocol ?? "tcp"];
    } else {
      // [IP:]HOST:TARGET[/PROTOCOL], or TARGET alone. An IPv6 address is in
      // brackets. Variables keep their braces, so they never split.
      const match = String(entry).trim().match(/^(?:(\[[^\]]+\]|[0-9]{1,3}(?:\.[0-9]{1,3}){3}):)?(.+?)(?:\/(tcp|udp))?$/);
      const parts = match ? match[2].split(/:(?![^{]*\})/) : [];
      if (!match || parts.length > 2 || parts.some((part) => !part)) return { blocked: `service ${claim.rule.service} publishes ${entry}, a form this reader cannot read` };
      [host, target] = parts.length === 2 ? parts : [undefined, parts[0]];
      protocol = match[3] ?? "tcp";
    }
    if (host === undefined || host === null) continue;
    if (/-/.test(String(host).replace(/\$\{[^}]*\}/g, "")) || /-/.test(String(target)))
      return { blocked: `service ${claim.rule.service} publishes the range ${entry}, which this reader does not follow` };
    const resolved = resolve(host);
    if (resolved.blocked) return { blocked: resolved.blocked };
    ports.push({ host: resolved.value, target: String(target), protocol });
  }
  return { found: ports };
}

// A count written as a word from one to twenty, or as digits.
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const countOf = (value) => (/^\d+$/.test(value) ? Number(value) : NUMBER_WORDS.indexOf(value.toLowerCase()));

// list-count: the number the quote states must equal the rows in the list's
// column on the same page. The page is the only source, so no commit is read.
function listCount(claim, pageText) {
  const listsFile = claim.listsFile ?? join(toolsRoot, "qa", "list-targets.json");
  let list;
  try {
    list = JSON.parse(readFileSync(listsFile, "utf8")).lists.find((item) => item.id === claim.rule.list);
  } catch (error) {
    return { blocked: `${listsFile} not read, ${error.message}` };
  }
  if (!list) return { blocked: `no list ${claim.rule.list} in ${listsFile}` };
  if (list.page !== claim.page) return { blocked: `list ${list.id} is on ${list.page}, not on ${claim.page}` };
  const stated = countOf(claim.rule.value);
  if (stated < 0) return { blocked: `${claim.rule.value} is not a number this check reads` };
  const column = pageColumn(pageText, list.heading, list.column);
  if (column.error) return { blocked: column.error };
  const rows = column.values.length;
  const repeated = column.values.filter((item, i) => column.values.findIndex((other) => other.value === item.value) !== i);
  if (repeated.length) return { blocked: `the ${list.column} column repeats ${repeated.map((item) => item.value).join(", ")}, so the rows do not count distinct values` };
  return { found: String(rows), match: rows === stated, why: `the ${list.column} column under "${list.heading}" has ${rows} rows` };
}

const results = [];
for (const claim of claims) {
  const base = { id: claim.id, page: claim.page, quote: claim.quote, source: claim.source, rule: claim.rule };
  // The claim itself must be sound before anything is judged.
  // The value must be a whole word in the quote, so 7 does not match 17.
  const word = normal(claim.rule.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, "u").test(normal(claim.quote))) {
    results.push({ ...base, verdict: "blocked", why: `the rule value ${claim.rule.value} is not in the quote` });
    continue;
  }
  let pageText;
  try {
    pageText = readFileSync(join(siteRoot, claim.page), "utf8");
  } catch (error) {
    results.push({ ...base, verdict: "blocked", why: `${claim.page} not read, ${error.message}` });
    continue;
  }
  if (claim.rule.kind === "list-count") {
    const quoteFound = normal(rendered(pageText)).includes(normal(claim.quote));
    const result = listCount(claim, pageText);
    let verdict = result.blocked ? "blocked" : result.match ? "match" : "mismatch";
    let why = result.blocked ?? (result.match ? null : result.why);
    if (!quoteFound && verdict !== "blocked") [verdict, why] = ["quote gone", `the quote is not on ${claim.page}${why ? `, and ${why}` : ""}`];
    results.push({ ...base, commit: "page", observed: result.found, verdict, why });
    continue;
  }
  const source = await sourceText(claim, claim.source.path);
  if (source.error) {
    results.push({ ...base, verdict: "blocked", why: source.error });
    continue;
  }
  const quoteFound = normal(rendered(pageText)).includes(normal(claim.quote));
  let verdict, why, observed;
  if (claim.rule.kind === "env-value") {
    const result = envValue(source.text, claim.rule.key);
    if (result.blocked) [verdict, why] = ["blocked", result.blocked];
    else {
      observed = result.found;
      [verdict, why] = observed === claim.rule.value ? ["match", null] : ["mismatch", result.why ?? `${claim.rule.key} is ${observed}`];
    }
  } else if (claim.rule.kind === "compose-port") {
    // The service must publish the host port, over TCP, to the rule's target
    // port when the rule names one.
    const result = await composePorts(claim, source.text);
    if (result.blocked) [verdict, why] = ["blocked", result.blocked];
    else {
      observed = result.found.map((port) => `${port.host}:${port.target}/${port.protocol}`);
      const hit = result.found.some((port) => port.host === claim.rule.value && port.protocol === "tcp" &&
        (!claim.rule.target || port.target === claim.rule.target));
      [verdict, why] = hit ? ["match", null]
        : ["mismatch", result.why ?? `service ${claim.rule.service} publishes ${observed.length ? observed.join(", ") : "no host port"}`];
    }
  } else {
    [verdict, why] = ["blocked", `unknown rule kind ${claim.rule.kind}`];
  }
  // A quote that left the page fails, unless the source could not be judged.
  if (!quoteFound && verdict !== "blocked") [verdict, why] = ["quote gone", `the quote is not on ${claim.page}${why ? `, and ${why}` : ""}`];
  results.push({ ...base, commit: source.commit, observed, verdict, why });
}

const pick = (verdict) => results.filter((result) => result.verdict === verdict);
for (const result of results.filter((result) => result.verdict !== "match"))
  console.log(`${result.verdict}  ${result.id}  ${result.why}  ${result.page}`);
console.log(`Checked ${results.length} claims. ${pick("match").length} match, ${pick("mismatch").length} mismatch, ` +
  `${pick("quote gone").length} quote gone, ${pick("blocked").length} blocked.`);
if (claims.length === 0) console.log("Found no claims. This check counts as blocked.");

await writeReport("sentence-claims-check.json", {
  counts: { claims: claims.length, match: pick("match").length, mismatch: pick("mismatch").length, quoteGone: pick("quote gone").length, blocked: pick("blocked").length },
  claimsFile, results,
});
if (pick("mismatch").length + pick("quote gone").length + pick("blocked").length > 0 || claims.length === 0) process.exitCode = 1;
