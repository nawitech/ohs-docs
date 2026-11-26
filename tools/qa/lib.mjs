// Helpers shared by the QA checks. Node, and js-yaml from the site's packages
// for front matter, the parser Docusaurus uses.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { outputRoot, pathExists, readJson, siteRoot, toolsRoot, writeJson } from "../scripts/shared.mjs";

// Reports go to the directory given as the first argument, or to build/qa.
export const reportDirectory = process.argv[2] ?? join(outputRoot, "qa");

export async function writeReport(name, report) {
  const path = join(reportDirectory, name);
  await writeJson(path, { checkedAt: new Date().toISOString(), ...report });
  console.log(`Report written to ${path}.`);
}

// Every page in the route contract, read from the production build.
export async function builtPages() {
  if (!(await pathExists(outputRoot))) throw new Error("Build output is missing; run `npm run check:build` first.");
  const pages = [];
  for (const route of (await readJson(`${toolsRoot}/routes.json`)).routes) {
    const relative = route.path.slice("/ohs-docs/".length);
    pages.push({ route: route.path, html: await readFile(join(outputRoot, relative, "index.html"), "utf8") });
  }
  return pages;
}

// A page's slug from its front matter, read as YAML the way Docusaurus reads
// it, or null when it has none, it is not a string, or the YAML is not valid.
export function slugOf(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!front) return null;
  let data;
  try { data = yaml.load(front[1]); } catch { return null; }
  return data && typeof data === "object" && typeof data.slug === "string" ? data.slug : null;
}

// The route Docusaurus gives a page with an absolute slug, under the site's
// /ohs-docs/ base. A slug without a leading / is resolved against the page's
// folder, so it gets null here, and the caller reports it.
export const routeOfSlug = (slug) => !slug?.startsWith("/") ? null : slug === "/" ? "/ohs-docs/" : `/ohs-docs${slug.replace(/\/+$/, "")}/`;

// Every Markdown file under docs/, .md and .mdx, with its path relative to the
// repository. A file or folder whose name starts with _ is a partial, which
// Docusaurus does not publish as a page but another page can import. Partials
// are included with partial true, so checks of content still read them.
export async function sourcePages(directory = join(siteRoot, "docs"), inPartial = false) {
  const pages = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const partial = inPartial || entry.name.startsWith("_");
    if (entry.isDirectory()) pages.push(...(await sourcePages(path, partial)));
    else if (/\.mdx?$/.test(entry.name)) pages.push({ file: path.slice(siteRoot.length + 1), text: await readFile(path, "utf8"), partial });
  }
  return pages;
}

// A temporary failure is tried three times. The caller decides what a status means.
export async function request(url, method = "GET") {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(25000),
        headers: { "user-agent": "ohs-docs-qa-check", accept: "text/html,*/*" },
      });
      if (response.status < 500 && ![408, 425, 429].includes(response.status)) return response;
      lastError = new Error(`status ${response.status}`);
      if (attempt === 3) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  throw lastError;
}

export async function inBatches(items, size, work) {
  const results = [];
  for (let index = 0; index < items.length; index += size)
    results.push(...(await Promise.all(items.slice(index, index + size).map(work))));
  return results;
}

// Every dev.ohs package version named on the pages, in Gradle form
// (group:artifact:version) and in Maven XML <dependency> blocks. Shared by
// check-versions.mjs and check-version-agreement.mjs, so both see the same pins.
// A Maven block without a literal version, such as one using a property, is
// skipped and counted.
export async function packageUses() {
  let linesScanned = 0, xmlSkipped = 0;
  const used = [];
  for (const { file, text } of await sourcePages()) {
    text.split("\n").forEach((line, index) => {
      if (!line.includes("dev.ohs.")) return;
      linesScanned += 1;
      for (const [, group, artifact, version] of line.matchAll(/(dev\.ohs\.[a-z.]+):([A-Za-z0-9_.-]+):([0-9][A-Za-z0-9_.-]*)/g))
        used.push({ file, line: index + 1, group, artifact, version });
    });
    for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const block = match[1];
      const group = block.match(/<groupId>\s*(dev\.ohs\.[a-z.]+)\s*<\/groupId>/)?.[1];
      if (!group) continue;
      const artifact = block.match(/<artifactId>\s*([A-Za-z0-9_.-]+)\s*<\/artifactId>/)?.[1];
      const version = block.match(/<version>\s*([0-9][A-Za-z0-9_.-]*)\s*<\/version>/)?.[1];
      if (!artifact || !version) { xmlSkipped += 1; continue; }
      const line = text.slice(0, match.index).split("\n").length + block.slice(0, block.indexOf("<version>")).split("\n").length - 1;
      used.push({ file, line, group, artifact, version, form: "maven xml" });
    }
  }
  return { used, linesScanned, xmlSkipped };
}

// Cells of one table row. An escaped pipe stays inside its cell.
export const cellsOf = (line) => line.replace(/\\\|/g, "\u0000").split("|").slice(1, -1).map((cell) => cell.replace(/\u0000/g, "|").trim());
// The value in a cell: the first code span, else a link's text, else the text.
export const valueOf = (cell) => cell.match(/`([^`]+)`/)?.[1].trim() ?? cell.match(/\[([^\]]+)\]\([^)]*\)/)?.[1].trim() ?? cell.trim();

// The values in one column of every table under a "## " heading, up to the
// next heading, with their lines. A table without that column is skipped.
export function pageColumn(text, heading, column) {
  // HTML and MDX comments do not render, so a table inside one is not read.
  // Newlines stay, so line numbers still match the file.
  const lines = text.replace(/<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}/g, (comment) => comment.replace(/[^\n]/g, " ")).split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return { error: `No "## ${heading}" heading` };
  let end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  if (end < 0) end = lines.length;
  const values = [];
  let tables = 0, withColumn = 0;
  for (let i = start + 1; i < end; i += 1) {
    if (!lines[i].startsWith("|") || (i > 0 && lines[i - 1].startsWith("|"))) continue;
    tables += 1;
    const index = cellsOf(lines[i]).indexOf(column);
    if (index < 0) continue;
    withColumn += 1;
    for (let row = i + 2; row < end && lines[row].startsWith("|"); row += 1) {
      const value = valueOf(cellsOf(lines[row])[index] ?? "");
      if (value) values.push({ value, line: row + 1 });
    }
  }
  if (tables === 0) return { error: `No table under "## ${heading}"` };
  if (withColumn === 0) return { error: `No "${column}" column in the tables under "## ${heading}"` };
  return { values };
}
