// Checks docker compose, npm, pnpm and yarn commands in shell code blocks
// against the repository they run in.
//
//   node tools/qa/check-commands.mjs [report directory] [targets file]
//
// command-targets.json names each page's repository and starting folder. Every
// file of one repository is read at one commit of its default branch, found
// with git ls-remote. A page in a test targets file may set readFrom to a
// local folder that stands for the repository root.
//
// The documented commands are never run. The check runs only git, to fetch
// the files, and docker compose config, which reads them and starts nothing.
// Docker's flags and the command's result are not checked.
//
// What each command must have:
// - docker compose: every -f file. Then `docker compose config`, run on a
//   sparse checkout of the repository at that commit, must accept the files,
//   list every --profile the command names, and list every service it names.
//   Compose applies its own rules for default files, overrides, merging and
//   variables. It needs the docker CLI with Compose, and no Docker daemon.
// - npm, pnpm, yarn: package.json in the folder, and every script the command
//   runs in its scripts, with npm's start and restart fallbacks. The tool
//   named in the packageManager field, when set.
// Built-in commands such as pnpm install are information. Docker's own flags
// are not checked.
//
// Verdicts per value: found, missing (fails), blocked, information. Blocked
// means the check could not decide: a source not read, a cd it does not
// follow, an option that picks another package, a wrapper such as sudo -E, a
// name pnpm or yarn may run as a dependency's binary, an error from
// docker compose config other than a missing file, or no docker CLI. A blocked value fails the run as "could not decide", so an
// unread form never passes. A page with these commands that is not in the
// targets file fails as not mapped.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { toolsRoot } from "../scripts/shared.mjs";
import { request, sourcePages, writeReport } from "./lib.mjs";

const targetsFile = process.argv[3] ?? join(toolsRoot, "qa", "command-targets.json");
const targets = JSON.parse(readFileSync(targetsFile, "utf8"));

const SHELLS = new Set(["sh", "shell", "bash", "zsh", "console"]);
const NO_PROJECT = new Set(["version", "ls", "help"]);
const ONE_SERVICE = new Set(["run", "exec"]);
// Options known to take no value. With any other option, the check cannot
// tell a service name from an option value, so services are blocked.
const COMPOSE_FLAGS = new Set(["-d", "--detach", "--build", "--no-build", "--force-recreate", "--no-recreate", "--no-deps",
  "--remove-orphans", "--abort-on-container-exit", "--quiet-pull", "--ignore-buildable", "--ignore-pull-failures",
  "--include-deps", "-q", "--quiet", "-a", "--all", "--wait", "--no-start", "--always-recreate-deps", "-V",
  "--renew-anon-volumes", "--rm", "-T", "--no-TTY", "-f", "--follow", "--timestamps", "--no-color", "--services"]);
const BUILTINS = {
  npm: new Set(["install", "i", "ci", "add", "uninstall", "remove", "rm", "update", "up", "audit", "exec", "init",
    "create", "link", "ln", "list", "ls", "outdated", "pack", "publish", "prune", "rebuild", "config", "cache", "view",
    "info", "help", "version", "login", "logout", "whoami", "doctor", "dedupe", "fund", "explain", "why", "query"]),
  pnpm: new Set(["add", "install", "i", "update", "up", "upgrade", "remove", "rm", "uninstall", "un", "link", "ln",
    "unlink", "import", "rebuild", "rb", "prune", "fetch", "install-test", "it", "patch", "patch-commit", "audit",
    "list", "ls", "outdated", "why", "licenses", "exec", "dlx", "create", "init", "env", "setup", "store", "server",
    "publish", "pack", "config", "c", "bin", "root", "doctor", "deploy", "dedupe", "self-update", "approve-builds",
    "ignored-builds", "help", "cat-file", "cat-index", "find-hash"]),
  yarn: new Set(["install", "add", "remove", "upgrade", "up", "init", "dlx", "exec", "workspaces", "workspace", "info",
    "why", "set", "config", "cache", "plugin", "node", "npm", "pack", "link", "unlink", "constraints", "dedupe",
    "explain", "patch", "rebuild", "search", "version", "bin", "create", "global", "help", "login", "logout",
    "outdated", "publish", "tag", "upgrade-interactive", "audit", "autoclean", "check", "import", "licenses", "list"]),
};
const SCRIPT_ALIASES = { npm: { t: "test", tst: "test", start: "start", stop: "stop", restart: "restart", test: "test" } };

// Every file of one repository is read at one commit.
const commits = new Map();
function commitOf(repository, url = `https://github.com/${repository}.git`) {
  if (commits.has(repository)) return commits.get(repository);
  const run = spawnSync("git", ["ls-remote", url, "HEAD"],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const sha = run.status === 0 ? run.stdout.match(/^([0-9a-f]{40})\tHEAD$/m)?.[1] ?? null : null;
  commits.set(repository, sha);
  return sha;
}

// { text } when read, { absent } on 404, { error } when the check cannot tell.
const files = new Map();
async function readSource(target, path) {
  if (target.readFrom) {
    try {
      return { commit: "local", text: readFileSync(join(target.readFrom, path), "utf8") };
    } catch (error) {
      return error.code === "ENOENT" ? { commit: "local", absent: true } : { error: `${path} not read, ${error.code ?? error.message}` };
    }
  }
  const sha = commitOf(target.repository);
  if (!sha) return { error: `commit of ${target.repository} not read, git ls-remote failed` };
  const key = `${target.repository}/${sha}/${path}`;
  if (!files.has(key)) {
    try {
      const response = await request(`https://raw.githubusercontent.com/${key}`);
      files.set(key, response.ok ? { commit: sha, text: await response.text() }
        : response.status === 404 ? { commit: sha, absent: true } : { error: `${path} not read, status ${response.status}` });
    } catch (error) {
      files.set(key, { error: `${path} not read, ${error.cause?.code ?? error.message}` });
    }
  }
  return files.get(key);
}

// One shell line as commands of words. Quotes, escapes, comments, the
// separators ; && || | & and redirections are read the way a shell reads them,
// outside quotes only. A word with $ or a backtick outside single quotes is
// marked dynamic, so it is never compared as a plain name. A here-document
// delimiter is returned, so its body is skipped.
function splitShell(line) {
  const commands = [[]];
  const heredocs = [];
  let word = null, quote = null, skipNext = null;
  const endWord = () => {
    if (word === null) return;
    if (skipNext === "heredoc") heredocs.push(word.text);
    else if (!skipNext) commands.at(-1).push(word);
    skipNext = null;
    word = null;
  };
  const add = (ch, dynamic = false, quoted = false) => {
    word ??= { text: "", dynamic: false, quoted: false };
    word.text += ch;
    word.dynamic ||= dynamic;
    word.quoted ||= quoted;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = null; else add(ch, false, true); continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < line.length) add(line[++i], false, true);
      else add(ch, ch === "$" || ch === "`", true);
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; word ??= { text: "", dynamic: false, quoted: true }; continue; }
    if (ch === "\\") { if (i + 1 < line.length) add(line[++i]); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    if (ch === "#" && word === null) break;
    if (ch === ";" || ch === "|" || ch === "&") {
      if (ch === "&" && line[i + 1] === ">") { endWord(); i += line[i + 2] === ">" ? 2 : 1; skipNext = "target"; continue; }
      endWord();
      if ((ch === "|" || ch === "&") && line[i + 1] === ch) i += 1;
      commands.push([]);
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A file descriptor number right before the operator belongs to it.
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null;
      else endWord();
      if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
        i += line[i + 2] === "-" ? 2 : 1;
        skipNext = "heredoc";
        continue;
      }
      while (line[i + 1] === ">" || line[i + 1] === "<" || line[i + 1] === "&" || line[i + 1] === "|") i += 1;
      if (/\d|-/.test(line[i + 1] ?? "") && line[i] === "&") { i += 1; continue; }
      skipNext = "target";
      continue;
    }
    add(ch, ch === "$" || ch === "`");
  }
  endWord();
  return { commands: commands.filter((c) => c.length), heredocs, open: quote !== null };
}

// Shell code blocks, including fences inside block quotes and list items.
// Lines are joined across a backslash at the end. Here-document bodies are
// skipped. Each command keeps the line it ends on.
function commandsOf(text) {
  const found = [];
  const lines = text.split("\n");
  let fence = null, block = 0, heredoc = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!fence) {
      const open = raw.match(/^(\s*(?:>\s?)*\s*(?:[-*+]\s+|\d+[.)]\s+)?)(`{3,}|~{3,})\s*([\w-]*)/);
      if (open) { fence = { mark: open[2], quoted: open[1].includes(">"), shell: SHELLS.has(open[3].toLowerCase()) }; block += 1; heredoc = []; }
      continue;
    }
    const line = fence.quoted ? raw.replace(/^\s*(>\s?)+/, "") : raw;
    if (line.trim().startsWith(fence.mark) && line.trim().replace(/[`~]/g, "") === "") { fence = null; continue; }
    if (!fence.shell) continue;
    if (heredoc.length) {
      if (line.trim() === heredoc[0]) heredoc.shift();
      continue;
    }
    let full = line, last = index;
    while (/\\\s*$/.test(full) && last + 1 < lines.length) {
      const next = lines[++last];
      full = full.replace(/\\\s*$/, " ") + (fence.quoted ? next.replace(/^\s*(>\s?)+/, "") : next);
    }
    index = last;
    const parsed = splitShell(full.replace(/^\s*\$\s+/, ""));
    heredoc.push(...parsed.heredocs);
    for (const w of parsed.commands) found.push({ line: index + 1, block, w, command: w.map((x) => x.text).join(" "), unclosed: parsed.open });
  }
  return found;
}

const TOOL_WORDS = new Set(["npm", "pnpm", "yarn", "docker-compose"]);
// Leading VAR=value words are kept apart as assignments, because Compose reads
// some of them, such as COMPOSE_FILE. A plain sudo is dropped. Anything else in
// front of a checked tool, such as sudo -E or time, is not followed.
function normalise(w) {
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i].text)) i += 1;
  const assignments = w.slice(0, i).map((word) => ({ name: word.text.split("=")[0], value: word.text.slice(word.text.indexOf("=") + 1), dynamic: word.dynamic }));
  if (w[i]?.text === "sudo" && w[i + 1] && !w[i + 1].text.startsWith("-")) i += 1;
  return Object.assign(w.slice(i), { assignments });
}
const isChecked = (w) => w.length && ((w[0].text === "docker" && w[1]?.text === "compose") || TOOL_WORDS.has(w[0].text));
const mentionsTool = (w) => w.some((x, i) => TOOL_WORDS.has(x.text) || (x.text === "docker" && w[i + 1]?.text === "compose"));

// Compose. Services are read only for subcommands whose operands are services.
const SERVICE_SUBS = new Set(["up", "down", "start", "stop", "restart", "pull", "push", "build", "create", "rm", "logs",
  "kill", "pause", "unpause", "ps", "top", "images", "events", "config", "watch", "wait"]);
const FIRST_IS_SERVICE = new Set(["run", "exec", "port"]);

function parseCompose(w) {
  const args = w[0].text === "docker-compose" ? w.slice(1) : w.slice(2);
  const parsed = { fileArgs: [], profiles: [], envFiles: [], services: [] };
  let i = 0;
  for (; i < args.length && args[i].text.startsWith("-"); i += 1) {
    const [flag, inline] = args[i].text.split(/=(.*)/s);
    const takesValue = ["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory", "--progress", "--parallel", "--ansi"].includes(flag);
    if (!takesValue) return { blocked: `compose option ${flag}, which this check does not read` };
    const value = inline !== undefined ? { text: inline, dynamic: args[i].dynamic } : args[++i];
    if (!value) return { blocked: `compose option ${flag} has no value` };
    if (value.dynamic) return { blocked: `compose option ${flag} uses a variable` };
    if (flag === "--project-directory") return { blocked: "--project-directory, which this check does not follow" };
    if ((flag === "-f" || flag === "--file") && value.text === "-") return { blocked: "-f -, a compose file read from standard input" };
    if (flag === "-f" || flag === "--file") parsed.fileArgs.push(value.text);
    if (flag === "--profile") parsed.profiles.push(value.text);
    if (flag === "--env-file") parsed.envFiles.push(value.text);
    if (flag === "-p" || flag === "--project-name") parsed.projectName = value.text;
  }
  parsed.sub = args[i]?.text;
  if (!parsed.sub) return { none: true };
  if (NO_PROJECT.has(parsed.sub)) return { noProject: parsed.sub };
  const operands = [];
  let unreadOption = null;
  for (const word of args.slice(i + 1)) {
    if (word.text === "--") break;
    if (word.text.startsWith("-")) {
      if (!word.text.includes("=") && !COMPOSE_FLAGS.has(word.text)) unreadOption ??= word.text;
      if (operands.length && FIRST_IS_SERVICE.has(parsed.sub)) break;
      continue;
    }
    operands.push(word);
    if (FIRST_IS_SERVICE.has(parsed.sub)) break;
  }
  if (!operands.length) return parsed;
  if (!SERVICE_SUBS.has(parsed.sub) && !FIRST_IS_SERVICE.has(parsed.sub)) parsed.servicesBlocked = `the operands of ${parsed.sub}, which this check does not read`;
  else if (unreadOption) parsed.servicesBlocked = `option ${unreadOption} before a service name, which this check cannot read`;
  else if (operands.some((word) => word.dynamic)) parsed.servicesBlocked = "a service name uses a variable";
  else parsed.services = operands.map((word) => word.text);
  return parsed;
}

// Compose itself reads each repository, so the check follows Compose's own
// rules for default files, parent folders, override files, merging, profiles
// and variables. Every repository is fetched once, as a shallow sparse
// checkout at the commit git ls-remote gave, into a folder with the
// repository's own name. `docker compose config` parses the files and
// contacts no Docker daemon. DOCKER_HOST points at nothing and HOME at an
// empty folder, so nothing is started and no personal settings are read.
//
// Repository content is not trusted. Before Compose runs, every file it will
// read is found by following include and extends, and each must be inside the
// checkout, with no link out of it and no variable or remote address in its
// path. Their folders are added to the sparse checkout.
const workRoot = mkdtempSync(join(tmpdir(), "docs-checks-compose-"));
process.on("exit", () => rmSync(workRoot, { recursive: true, force: true }));
const emptyHome = join(workRoot, "home");
mkdirSync(emptyHome);
const checkouts = new Map();
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args) => spawnSync("git", args, { encoding: "utf8", timeout: 180000, env: gitEnv });

function checkoutFor(target, folders) {
  if (target.readFrom) return { dir: target.readFrom, commit: "local" };
  let entry = checkouts.get(target.repository);
  if (!entry) {
    // cloneFrom is for tests only. It names a local repository to fetch from.
    const url = target.cloneFrom ?? `https://github.com/${target.repository}.git`;
    const sha = commitOf(target.repository, url);
    if (!sha) entry = { error: `commit of ${target.repository} not read, git ls-remote failed` };
    else {
      const [owner, name] = target.repository.split("/");
      const dir = join(workRoot, owner, name);
      mkdirSync(join(workRoot, owner), { recursive: true });
      const steps = [["init", "-q", dir], ["-C", dir, "remote", "add", "origin", url],
        ["-C", dir, "sparse-checkout", "set", "--cone"], ["-C", dir, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", sha],
        ["-C", dir, "checkout", "-q", sha]];
      const failed = steps.map((step) => git(step)).find((run) => run.status !== 0);
      entry = failed ? { error: `checkout of ${target.repository} failed, ${(failed.stderr || failed.error?.message || "").trim().split("\n")[0]}` } : { dir, commit: sha, folders: new Set() };
    }
    checkouts.set(target.repository, entry);
  }
  if (entry.error) return entry;
  const add = [...new Set(folders)].filter((folder) => folder !== "." && !entry.folders.has(folder));
  if (add.length) {
    const run = git(["-C", entry.dir, "sparse-checkout", "add", ...add]);
    if (run.status !== 0) return { error: `sparse checkout of ${add.join(", ")} failed, ${run.stderr.trim().split("\n")[0]}` };
    for (const folder of add) entry.folders.add(folder);
  }
  return entry;
}

const DEFAULT_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml",
  "compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];

// The files Compose will read for one command, with the folders they need.
// It returns an error for a path that leaves the checkout, a link out of it,
// a path built from a variable, or a remote include.
let yaml;
async function composeFiles(root, folder, files, envFiles) {
  yaml ??= (await import("js-yaml")).default;
  const realRoot = realpathSync(root);
  const inside = (abs) => {
    const real = realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + sep);
  };
  const queue = files.length ? files.map((item) => item.path) : [];
  if (!files.length) {
    for (let dir = folder; ; dir = posix.dirname(dir)) {
      for (const name of DEFAULT_FILES) if (existsSync(join(root, dir, name))) queue.push(posix.join(dir, name));
      if (dir === "." || dir === "/") break;
    }
  }
  const other = [...envFiles.map((item) => item.path), posix.join(folder, ".env")];
  const dirs = new Set(), seen = new Set();
  const refer = (from, ref) => {
    if (typeof ref !== "string") return { error: `${from} names a file in a form this check does not read` };
    if (/:\/\//.test(ref) || /^oci:/.test(ref)) return { error: `${from} includes the remote file ${ref}` };
    if (/[$`]/.test(ref)) return { error: `${from} names a file with a variable, ${ref}` };
    const path = posix.normalize(posix.join(posix.dirname(from), ref));
    if (ref.startsWith("/") || path.startsWith("..")) return { error: `${from} names ${ref}, which is outside the repository` };
    dirs.add(posix.dirname(path));
    return { path };
  };
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    if (!inside(abs)) return { error: `${rel} is a link to a file outside the repository` };
    let doc;
    try {
      doc = yaml.load(readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    for (const entry of [].concat(doc?.include ?? [])) {
      const paths = typeof entry === "string" ? [entry] : [].concat(entry?.path ?? []);
      for (const ref of paths) {
        const result = refer(rel, ref);
        if (result.error) return result;
        queue.push(result.path);
      }
      for (const ref of typeof entry === "object" && entry ? [].concat(entry.env_file ?? [], entry.project_directory ?? []) : []) {
        const result = refer(rel, ref);
        if (result.error) return result;
        other.push(result.path);
      }
    }
    for (const service of Object.values(doc?.services ?? {})) {
      if (service?.extends?.file === undefined) continue;
      const result = refer(rel, service.extends.file);
      if (result.error) return result;
      queue.push(result.path);
    }
  }
  for (const rel of other) if (existsSync(join(root, rel)) && !inside(join(root, rel))) return { error: `${rel} is a link to a file outside the repository` };
  return { dirs };
}

// The variables Compose sees: none from the job, only the command's own
// literal assignments. Docker's own settings stay fixed.
// The Compose plugin is found once through the docker CLI, which needs no
// daemon for this, and then run directly. Running it directly lets HOME and
// DOCKER_CONFIG point at an empty folder and still find the plugin.
const FIXED = new Set(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "HOME", "PATH"]);
const NO_DAEMON = "unix:///nonexistent-docs-checks.sock";
let composePlugin;
function pluginPath() {
  if (composePlugin !== undefined) return composePlugin;
  const run = spawnSync("docker", ["info", "--format", '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}'],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, DOCKER_HOST: NO_DAEMON } });
  composePlugin = run.error ? null : run.stdout.trim().split("\n")[0] || null;
  return composePlugin;
}
function compose(cwd, args, root, assignments) {
  const plugin = pluginPath();
  if (!plugin) return { error: "Docker with the Compose plugin is not installed" };
  const env = { PATH: process.env.PATH, HOME: emptyHome, DOCKER_CONFIG: join(emptyHome, ".docker"), DOCKER_HOST: NO_DAEMON };
  for (const { name, value } of assignments) if (!FIXED.has(name)) env[name] = value;
  const run = spawnSync(plugin, args, { cwd, encoding: "utf8", timeout: 60000, env });
  if (run.error) return { error: run.error.message };
  const message = run.stderr.split("\n").filter((line) => line.trim() && !line.includes("level=warning")).join(" ").split(`${root}/`).join("").trim();
  return run.status === 0 ? { lines: run.stdout.split("\n").map((line) => line.trim()).filter(Boolean) } : { failed: message || `exit ${run.status}` };
}

async function checkCompose(target, folder, parsed, assignments) {
  const out = [];
  const push = (kind, name, verdict, why) => out.push({ kind, value: `${kind} ${name}`, verdict, why });
  if (parsed.blocked) { push("compose command", parsed.sub ?? "options", "blocked", parsed.blocked); return out; }
  if (parsed.none) return out;
  if (parsed.noProject) { push("compose command", parsed.noProject, "information", "needs no compose file"); return out; }
  const names = (why) => {
    for (const name of parsed.profiles) push("profile", name, "blocked", why);
    for (const name of parsed.services) push("service", name, "blocked", why);
    if (parsed.servicesBlocked) push("services", parsed.sub, "blocked", parsed.servicesBlocked);
  };
  const inRepo = (file) => {
    const path = posix.normalize(posix.join(folder, file));
    return file.startsWith("/") || path.startsWith("..") ? null : path;
  };
  const files = parsed.fileArgs.map((file) => ({ file, path: inRepo(file) }));
  const envFiles = parsed.envFiles.map((file) => ({ file, path: inRepo(file) }));
  const what = files.length ? files.map((item) => item.path).join(" and ") : `default in ${folder}`;
  const stop = (why) => {
    for (const item of files) push("compose file", item.path, "blocked", why);
    if (!files.length) push("compose file", what, "blocked", why);
    names(why);
    return out;
  };
  const outside = [...files, ...envFiles].find((item) => !item.path);
  if (outside) return stop(`${outside.file} is outside the repository`);
  const dynamic = assignments.find((item) => item.dynamic);
  if (dynamic) return stop(`the command sets ${dynamic.name} from a variable`);
  let checkout = checkoutFor(target, [folder, ...[...files, ...envFiles].map((item) => posix.dirname(item.path))]);
  if (checkout.error) return stop(checkout.error);
  // A named file that is not in the repository fails on its own. Compose
  // would stop at the first one, so each is checked here.
  let missing = false;
  for (const item of files) {
    if (existsSync(join(checkout.dir, item.path))) continue;
    push("compose file", item.path, "missing", `no ${item.path} in ${target.repository}`);
    missing = true;
  }
  if (missing) { names("a compose file is missing"); return out; }
  // Fetch the folders of every file Compose will read, until nothing new.
  for (let round = 0; ; round += 1) {
    let found;
    try {
      found = await composeFiles(checkout.dir, folder, files, envFiles);
    } catch (error) {
      return stop(error.code === "ERR_MODULE_NOT_FOUND" ? "js-yaml is not installed" : `the compose files were not read, ${error.message}`);
    }
    if (found.error) return stop(found.error);
    const fresh = [...found.dirs].filter((dir) => dir !== "." && !checkout.folders?.has(dir));
    if (!fresh.length || target.readFrom) break;
    if (round === 4) return stop("include and extends go more than five levels deep");
    checkout = checkoutFor(target, fresh);
    if (checkout.error) return stop(checkout.error);
  }
  const cwd = join(checkout.dir, folder);
  const global = [...(parsed.projectName ? ["-p", parsed.projectName] : []), ...parsed.fileArgs.flatMap((file) => ["-f", file]),
    ...parsed.envFiles.flatMap((file) => ["--env-file", file])];
  const active = parsed.profiles.flatMap((name) => ["--profile", name]);
  const profiles = compose(cwd, [...global, ...active, "config", "--no-env-resolution", "--profiles"], checkout.dir, assignments);
  const problem = profiles.error ?? profiles.failed;
  if (problem) {
    if (!files.length && !assignments.some((item) => item.name === "COMPOSE_FILE") && /^no configuration file provided: not found$/i.test(problem)) {
      push("compose file", what, "missing", `Compose found no compose file in ${folder} or above`);
      names("no compose file");
      return out;
    }
    return stop(`docker compose config stopped, ${problem.slice(0, 300)}`);
  }
  for (const item of files) push("compose file", item.path, "found", null);
  if (!files.length) push("compose file", what, "found", "Compose found a default file");
  const known = new Set(profiles.lines);
  for (const name of parsed.profiles) {
    if (name === "*") push("profile", name, "information", "selects every profile");
    else known.has(name) ? push("profile", name, "found", null) : push("profile", name, "missing", `Compose lists no profile ${name}`);
  }
  if (parsed.services.length) {
    const services = compose(cwd, [...global, "--profile", "*", "config", "--no-env-resolution", "--services"], checkout.dir, assignments);
    if (services.error || services.failed) names(`docker compose config stopped, ${(services.error ?? services.failed).slice(0, 300)}`);
    else for (const name of parsed.services)
      services.lines.includes(name) ? push("service", name, "found", null) : push("service", name, "missing", `Compose lists no service ${name}`);
  }
  if (parsed.servicesBlocked) push("services", parsed.sub, "blocked", parsed.servicesBlocked);
  return out;
}

// npm, pnpm and yarn. Options that pick another package or folder are
// blocked. A name these tools might also run as a dependency's binary is
// blocked when no script has it, because the check cannot see installed
// binaries.
const ELSEWHERE = /^(-w|--workspace|--workspaces|-ws|--prefix|--filter|-F|-C|--dir|-r|--recursive|--include-workspace-root|--global|-g)(=|$)/;
async function checkPackage(target, folder, w) {
  const out = [];
  const push = (kind, name, verdict, why) => out.push({ kind, value: `${kind} ${name}`, verdict, why });
  const tool = w[0].text;
  const rest = w.slice(1);
  const end = rest.findIndex((word) => word.text === "--");
  const own = end < 0 ? rest : rest.slice(0, end);
  const elsewhere = own.find((word) => ELSEWHERE.test(word.text));
  if (elsewhere) { push("package command", `${tool} ${own[0]?.text ?? ""}`.trim(), "blocked", `option ${elsewhere.text} picks another package or folder`); return out; }
  if (rest[0]?.text.startsWith("-")) { push("package command", tool, "blocked", `option ${rest[0].text} before the command, which this check does not read`); return out; }
  if (rest[0]?.dynamic) { push("package command", tool, "blocked", "the command uses a variable"); return out; }
  const sub = rest[0]?.text ?? (tool === "yarn" ? "install" : "help");
  if (tool === "yarn" && (sub === "workspace" || sub === "workspaces")) { push("package command", `yarn ${sub}`, "blocked", "it runs in another package"); return out; }
  // What the command runs: a script, a built-in, or something the check does not know.
  let script = null, mode = null;
  if (["run", "run-script", "rum", "urn"].includes(sub) && tool !== "yarn" || (tool === "yarn" && sub === "run")) {
    const next = rest[1];
    if (!next || next === rest[end]) { push("package command", `${tool} ${sub}`, "information", "lists scripts"); }
    else if (next.text.startsWith("-")) { push("package command", `${tool} ${sub}`, "blocked", `option ${next.text} before the script name, which this check does not read`); return out; }
    else { script = next; mode = tool === "yarn" ? "or-binary" : "script"; }
  } else if (tool === "npm" && ["test", "t", "tst", "start", "stop", "restart"].includes(sub)) {
    script = { text: { t: "test", tst: "test" }[sub] ?? sub }; mode = "npm-lifecycle";
  } else if (BUILTINS[tool].has(sub)) {
    push("package command", `${tool} ${sub}`, "information", "built in, not a script");
  } else if (tool === "npm") {
    push("package command", `npm ${sub}`, "blocked", "not a known npm command"); return out;
  } else {
    script = rest[0]; mode = "or-binary";
  }
  if (script?.dynamic) { push("script", script.text, "blocked", "the script name uses a variable"); return out; }
  if (script && tool === "pnpm" && /^\/.*\/$/.test(script.text)) { push("script", script.text, "blocked", "a pattern that selects scripts, which this check does not read"); return out; }
  const ifPresent = own.some((word) => word.text === "--if-present");
  const path = posix.normalize(posix.join(folder, "package.json"));
  const source = await readSource(target, path);
  if (source.error) { push("package.json", path, "blocked", source.error); return out; }
  if (source.absent) { push("package.json", path, "missing", `no ${path} in ${target.repository}`); return out; }
  let pkg;
  try {
    pkg = JSON.parse(source.text);
  } catch {
    push("package.json", path, "blocked", `found, but ${path} is not valid JSON`);
    return out;
  }
  const manager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
  if (manager && manager !== tool) push("package manager", tool, "missing", `${path} sets packageManager to ${pkg.packageManager}`);
  if (!script) return out;
  const has = (name) => pkg.scripts && Object.hasOwn(pkg.scripts, name);
  if (has(script.text)) { push("script", script.text, "found", null); return out; }
  if (ifPresent) { push("script", script.text, "information", "absent, and --if-present allows that"); return out; }
  if (mode === "npm-lifecycle" && (script.text === "start" || script.text === "restart")) {
    // npm start runs node server.js without a start script. npm restart runs
    // stop and start without a restart script.
    if (has("start")) { push("script", script.text, "found", "npm falls back to the start script"); return out; }
    const server = await readSource(target, posix.join(folder, "server.js"));
    if (server.error) { push("script", script.text, "blocked", server.error); return out; }
    if (!server.absent) { push("script", script.text, "found", "npm runs server.js by default"); return out; }
  }
  if (mode === "or-binary") push("script", script.text, "blocked", `no script ${script.text}, and ${tool} may run a dependency's binary of that name, which this check cannot see`);
  else push("script", script.text, "missing", `${path} has no script ${script.text}`);
  return out;
}

const results = [];
let commandCount = 0;
for (const { file, text } of await sourcePages()) {
  const target = targets.pages[file];
  let folder = target?.folder ?? ".";
  let currentBlock = null, cdBlocked = null;
  for (const c of commandsOf(text)) {
    if (c.block !== currentBlock) { currentBlock = c.block; folder = target?.folder ?? "."; cdBlocked = null; }
    const w = normalise(c.w);
    if (w[0]?.text === "cd") {
      const to = w[1]?.text?.replace(/^\.\//, "").replace(/\/$/, "");
      if (target && to === target.repository.split("/")[1] && !w[1].dynamic) { folder = "."; cdBlocked = null; }
      else cdBlocked = `cd ${w[1]?.text ?? ""}`.trim();
      continue;
    }
    const checked = isChecked(w);
    if (!checked && !mentionsTool(c.w)) continue;
    commandCount += 1;
    const base = { file, line: c.line, command: c.command };
    if (!target) { results.push({ ...base, kind: "command", value: c.command, verdict: "not mapped", why: "page not in command-targets.json" }); continue; }
    const where = { ...base, repository: target.repository, folder };
    if (!checked || c.unclosed) {
      results.push({ ...where, kind: "command", value: `command ${c.command}`, verdict: "blocked", why: c.unclosed ? "a quote is not closed on this line" : "a form this check does not read, such as a wrapper before the tool" });
      continue;
    }
    const checks = w[0].text === "docker" || w[0].text === "docker-compose"
      ? await checkCompose(target, folder, parseCompose(w), w.assignments)
      : await checkPackage(target, folder, w);
    for (const check of checks) {
      const verdict = cdBlocked && check.verdict !== "information" ? "blocked" : check.verdict;
      const why = cdBlocked && check.verdict !== "information" ? `after ${cdBlocked}, which this check does not follow` : check.why;
      results.push({ ...where, ...check, verdict, why });
    }
  }
}

const commitsRead = Object.fromEntries([...commits].map(([repository, sha]) => [repository, sha]));
const pick = (verdict) => results.filter((result) => result.verdict === verdict);
for (const r of results.filter((r) => !["found", "information"].includes(r.verdict)))
  console.log(`${r.verdict}  ${r.value}  ${r.why}  ${r.file}:${r.line}`);
const counts = { commands: commandCount, values: results.length, found: pick("found").length, missing: pick("missing").length,
  notMapped: pick("not mapped").length, blocked: pick("blocked").length, information: pick("information").length };
console.log(`Checked ${counts.values} values in ${counts.commands} commands. ${counts.found} found, ${counts.missing} missing, ${counts.notMapped} not mapped, ` +
  `${counts.blocked} blocked, ${counts.information} information.`);
if (counts.commands === 0) console.log("Found no commands. This check counts as blocked.");

await writeReport("commands.json", { counts, targetsFile, commits: commitsRead, results });
if (counts.missing + counts.notMapped + counts.blocked > 0 || counts.commands === 0) process.exitCode = 1;
