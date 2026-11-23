// Checks that every dev.ohs package version named on a page exists on Maven
// Central, and reports where a page is behind the latest version.
//
//   node tools/qa/check-versions.mjs [report directory]
//
// A version or package that does not exist fails the check. Being behind the
// latest version is reported and does not fail it. When Maven Central cannot be
// reached for a package, its uses are "source unreachable", reported apart from
// a failure, because nothing was proved about the page.
import { packageUses, request, writeReport } from "./lib.mjs";

const { used, linesScanned, xmlSkipped } = await packageUses();

// 404 means Maven Central has no such package. Anything else that is not a
// success, or a network error, means the source could not be read.
const published = new Map();
for (const { group, artifact } of used) {
  const key = `${group}:${artifact}`;
  if (published.has(key)) continue;
  const url = `https://repo1.maven.org/maven2/${group.replaceAll(".", "/")}/${artifact}/maven-metadata.xml`;
  try {
    const response = await request(url);
    if (response.status === 404) published.set(key, { state: "absent" });
    else if (!response.ok) published.set(key, { state: "unreachable", error: `status ${response.status}` });
    else {
      const xml = await response.text();
      published.set(key, {
        state: "read",
        versions: [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(([, version]) => version),
        latest: xml.match(/<latest>([^<]+)<\/latest>/)?.[1] ?? null,
      });
    }
  } catch (error) {
    published.set(key, { state: "unreachable", error: String(error.cause?.code ?? error.message) });
  }
}

const results = used.map((use) => {
  const source = published.get(`${use.group}:${use.artifact}`);
  if (source.state === "unreachable") return { ...use, latest: null, verdict: "source unreachable", error: source.error };
  if (source.state === "absent" || source.versions.length === 0) return { ...use, latest: null, verdict: "package not found" };
  const verdict = !source.versions.includes(use.version) ? "version not found" : use.version === source.latest ? "latest" : "behind";
  return { ...use, latest: source.latest, verdict };
});

const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
for (const result of results.filter((result) => result.verdict !== "latest"))
  console.log(`${result.verdict}  ${result.group}:${result.artifact}:${result.version}  latest ${result.latest}  ${result.file}:${result.line}${result.error ? `  ${result.error}` : ""}`);
const failed = results.filter((result) => result.verdict.endsWith("not found"));
console.log(
  `Scanned ${linesScanned} lines naming dev.ohs, found ${used.length} package versions, skipped ${xmlSkipped} Maven blocks without a literal version. ` +
    `${failed.length} do not exist, ${count("behind")} are behind the latest, ${count("source unreachable")} could not be checked.`,
);
if (used.length === 0) console.log("Found no package versions. The extractor may be broken, so this check counts as blocked.");

await writeReport("versions.json", { counts: { linesScanned, found: used.length, skipped: xmlSkipped }, results });
if (failed.length > 0) process.exitCode = 1;
