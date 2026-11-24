// Checks that every dev.ohs package version named on a page exists on Maven
// Central, and reports where a page is behind the latest version.
//
//   node tools/qa/check-versions.mjs [report directory]
//
// A version or package that does not exist fails the check. Being behind the
// latest version is reported and does not fail it. When Maven Central cannot be
// reached for a package, its uses are "source unreachable", reported apart from
// a failure, because nothing was proved about the page.
//
// Maven Central often answers GitHub's shared runners with 429, too many
// requests. When it answers 429, 5xx or not at all, the check asks Google's
// mirror of Maven Central for the same metadata file. The mirror can be a few
// hours behind, so a package or version the mirror lacks is "source
// unreachable", never "not found", and a version it lists is "published", with
// no latest or behind verdict. Each result names the registry that answered and
// what Maven Central said.
//
// QA_MAVEN_URL and QA_MAVEN_MIRROR_URL are for tests only. They point the check
// at local servers.
import { packageUses, request, writeReport } from "./lib.mjs";

const CENTRAL = process.env.QA_MAVEN_URL ?? "https://repo1.maven.org/maven2";
const MIRROR = process.env.QA_MAVEN_MIRROR_URL ?? "https://maven-central.storage-download.googleapis.com/maven2";

const { used, linesScanned, xmlSkipped } = await packageUses();

// 404 means the registry has no such package. A 200 counts only when its body
// is complete artifact metadata for the same group and artifact, and the answer
// came from the registry asked, not a redirect elsewhere. Anything else, or a
// network error, means the source could not be read.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function metadata(base, group, artifact) {
  const url = `${base}/${group.replaceAll(".", "/")}/${artifact}/maven-metadata.xml`;
  try {
    const response = await request(url);
    const host = new URL(response.url || url).host;
    if (host !== new URL(base).host) return { state: "unreachable", error: `redirected to ${host}` };
    if (response.status === 404) return { state: "absent" };
    if (!response.ok) return { state: "unreachable", error: `status ${response.status}` };
    // Comments are removed first, so a version inside a comment does not count.
    // Versions are read only from the <versions> list. Metadata without that
    // list, or with an empty one, is incomplete, so it never proves absence.
    const xml = (await response.text()).replace(/<!--[\s\S]*?-->/g, "");
    const list = xml.match(/<versioning>[\s\S]*<versions>([\s\S]*?)<\/versions>[\s\S]*<\/versioning>/)?.[1];
    const versions = [...(list ?? "").matchAll(/<version>([^<]+)<\/version>/g)].map(([, version]) => version.trim());
    const complete = /<metadata[\s>][\s\S]*<\/metadata>\s*$/.test(xml) && versions.length > 0;
    const same = new RegExp(`<groupId>\\s*${escapeRe(group)}\\s*</groupId>`).test(xml) && new RegExp(`<artifactId>\\s*${escapeRe(artifact)}\\s*</artifactId>`).test(xml);
    if (!complete || !same) return { state: "unreachable", error: complete ? "metadata for another package" : "incomplete metadata" };
    return { state: "read", versions, latest: xml.match(/<latest>([^<]+)<\/latest>/)?.[1]?.trim() ?? null };
  } catch (error) {
    return { state: "unreachable", error: String(error.cause?.code ?? error.message) };
  }
}

// Each package records what Maven Central said and, when asked, what the mirror
// said, so a report can show both.
const published = new Map();
for (const { group, artifact } of used) {
  const key = `${group}:${artifact}`;
  if (published.has(key)) continue;
  const central = await metadata(CENTRAL, group, artifact);
  if (central.state !== "unreachable") { published.set(key, { ...central, registry: "Maven Central" }); continue; }
  const mirror = await metadata(MIRROR, group, artifact);
  const mirrorAnswer = mirror.state === "read" ? "read" : mirror.state === "absent" ? "no such package" : mirror.error;
  published.set(key, { ...mirror, state: mirror.state === "read" ? "read" : "unreachable", registry: "Google mirror", centralError: central.error, mirrorAnswer });
}

const describe = (source, missing) =>
  `Maven Central answered ${source.centralError}. The Google mirror ${missing ? `does not list ${missing}, and may be behind` : source.mirrorAnswer === "no such package" ? "has no such package, and may be behind" : `answered ${source.mirrorAnswer}`}`;

const results = used.map((use) => {
  const source = published.get(`${use.group}:${use.artifact}`);
  const from = { registry: source.registry, ...(source.centralError ? { centralError: source.centralError, mirrorAnswer: source.mirrorAnswer } : {}) };
  if (source.state === "unreachable")
    return { ...use, latest: null, verdict: "source unreachable", ...from, error: source.centralError ? describe(source) : source.error };
  if (source.registry === "Google mirror") {
    // The mirror confirms a version was published. It cannot prove absence, and
    // its latest may be stale, so it gives no latest or behind verdict.
    if (!source.versions.includes(use.version))
      return { ...use, latest: null, verdict: "source unreachable", ...from, missingOnMirror: use.version, error: describe(source, use.version) };
    return { ...use, latest: null, mirrorLatest: source.latest, verdict: "published", ...from };
  }
  if (source.state === "absent") return { ...use, latest: null, verdict: "package not found", ...from };
  if (!source.versions.includes(use.version)) return { ...use, latest: source.latest, verdict: "version not found", ...from };
  // Without a latest in the metadata, only publication is confirmed.
  const verdict = !source.latest ? "published" : use.version === source.latest ? "latest" : "behind";
  return { ...use, latest: source.latest, verdict, ...from };
});

const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
for (const result of results.filter((result) => !["latest", "published"].includes(result.verdict)))
  console.log(`${result.verdict}  ${result.group}:${result.artifact}:${result.version}  latest ${result.latest}  ${result.file}:${result.line}${result.error ? `  ${result.error}` : ""}`);
const failed = results.filter((result) => result.verdict.endsWith("not found"));
console.log(
  `Scanned ${linesScanned} lines naming dev.ohs, found ${used.length} package versions, skipped ${xmlSkipped} Maven blocks without a literal version. ` +
    `${failed.length} do not exist, ${count("behind")} are behind the latest, ${count("source unreachable")} could not be checked.`,
);
if (used.length === 0) console.log("Found no package versions. The extractor may be broken, so this check counts as blocked.");

// A package read from the mirror counts here only for the versions it confirmed.
const confirmed = results.filter((result) => result.verdict === "published" && result.registry === "Google mirror");
const fromMirror = [...new Set(confirmed.map((result) => `${result.group}:${result.artifact}`))];
const confirmedVersions = [...new Set(confirmed.map((r) => `${r.group}:${r.artifact}:${r.version}`))];
if (confirmedVersions.length) console.log(`Confirmed ${confirmedVersions.length} versions on the Google mirror, because Maven Central did not answer: ${confirmedVersions.join(", ")}. They are "published", with no latest or behind verdict.`);
await writeReport("versions.json", { counts: { linesScanned, found: used.length, skipped: xmlSkipped, fromMirror: fromMirror.length }, results });
if (failed.length > 0) process.exitCode = 1;
