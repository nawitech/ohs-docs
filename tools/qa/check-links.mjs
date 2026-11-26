// Opens every outside link in the built site, and checks that every link to a
// page section points at a heading that exists.
//
//   npm run check:build && node tools/qa/check-links.mjs [report directory]
//
// A link is broken when its destination is gone. A sign-in wall, a rate limit
// or a server error is reported as blocked, and a network error as
// unreachable, because each stops the check without proving the link is wrong. A redirect to another host is
// reported as information. A link to a page below a site's root that redirects
// to the root, such as https://example.com/ or https://example.com/en/, fails as
// redirected to root, because sites send readers there when a page is gone. An answer of 200 does not prove the destination holds
// what the link text promises. That part is reviewed by a person.
import { builtPages, inBatches, request, routeOfSlug, slugOf, sourcePages, writeReport } from "./lib.mjs";

// QA_LINKS_ALLOW_LOOPBACK=1 is for tests only. It lets a test page link to a
// local server on 127.0.0.1.
const skippedHosts = process.env.QA_LINKS_ALLOW_LOOPBACK === "1"
  ? /^(localhost|0\.0\.0\.0|example\.(org|com)|[a-z-]+)$/i
  : /^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(org|com)|[a-z-]+)$/i;
// A server error such as 503 or Cloudflare's 522, a request timeout (408) or a
// refused early request (425) says the site could not answer, not that the
// page is gone, so each is blocked too.
const blockedStatuses = new Set([401, 403, 408, 425, 429, 999]);
const isBlockedStatus = (status) => blockedStatuses.has(status) || (status >= 500 && status <= 599);

const pages = await builtPages();
const htmlByRoute = new Map(pages.map((page) => [page.route, page.html]));

// This check reads only the pages in tools/routes.json. A docs page missing
// from it would never have its links read, so each one fails. The route comes
// from the page's slug, which must start with /. A partial is not a page.
const notInRoutes = [], relativeSlugs = [];
for (const { file, text, partial } of await sourcePages()) {
  if (partial) continue;
  const slug = slugOf(text);
  const route = routeOfSlug(slug);
  if (!route) relativeSlugs.push({ file, slug });
  else if (!htmlByRoute.has(route)) notInRoutes.push({ file, route });
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Accept quoted and unquoted attribute values, such as id="join" and id=join.
// A site's home page is its root, or a root with one language folder, such as
// /en, /pt-br/ or /zh-Hant/. Language folders use the ISO 639-1 codes plus fil,
// so a page such as /go is not taken for one. index.html means its folder.
const LANGUAGES = new Set("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu fil".split(" "));
// Script codes seen in language folders, such as zh-Hant.
const SCRIPTS = new Set(["hans", "hant", "latn", "cyrl", "arab", "deva"]);
const isLocale = (segment) => {
  const [language, region, extra] = segment.toLowerCase().split(/[-_]/);
  return extra === undefined && LANGUAGES.has(language) && (region === undefined || /^([a-z]{2}|\d{3})$/.test(region) || SCRIPTS.has(region));
};
const isRootPath = (path) => {
  const parts = path.replace(/\/index\.html?$/i, "/").split("/").filter(Boolean);
  return parts.length === 0 || (parts.length === 1 && isLocale(parts[0]));
};
// A query that only tracks the visit still means the home page. Any other
// query, such as ?page=article, may pick a page of its own.
const isHome = (url) => isRootPath(url.pathname) && [...url.searchParams.keys()].every((key) => /^(utm_\w+|ref|source|lang|hl|locale)$/i.test(key));
// A redirect to a sign-in page is a wall, not a missing page.
const signIn = /(^|[/?&=._-])(login|log-in|signin|sign-in|sign_in|auth|oauth|sso)([/?&=._-]|$)/i;
// The verdict for one answer. A fragment is not part of response.url, so a
// site that routes pages by #fragment cannot be judged here.
function landing(address, response) {
  if (!response.ok) return isBlockedStatus(response.status) ? "blocked" : "broken";
  const from = new URL(address), to = new URL(response.url);
  if (to.href !== from.href && signIn.test(to.pathname + to.search) && !signIn.test(from.pathname + from.search)) return "blocked";
  return !isRootPath(from.pathname) && isHome(to) ? "redirected to root" : "ok";
}
const hasId = (html, id) => new RegExp(`(?:id|name)=(["']?)${escape(id)}\\1(?=[\\s>/]|$)`).test(html);

const outside = new Map();
const missingSections = [];
let anchorsScanned = 0, skippedLinks = 0, sectionLinksChecked = 0;
for (const { route, html } of pages) {
  for (const [, raw] of html.matchAll(/<a\s[^>]*?href="([^"]+)"/g)) {
    anchorsScanned += 1;
    const href = raw.replaceAll("&amp;", "&");
    if (/^https?:\/\//.test(href)) {
      if (skippedHosts.test(new URL(href).hostname)) {
        skippedLinks += 1;
        continue;
      }
      if (!outside.has(href)) outside.set(href, []);
      outside.get(href).push(route);
    } else if (href.includes("#")) {
      const [path, id] = href.split("#");
      if (!id || id.startsWith("__docusaurus")) continue;
      const target = path === "" ? html : htmlByRoute.get(path);
      if (target) sectionLinksChecked += 1;
      if (target && !hasId(target, decodeURIComponent(id))) missingSections.push({ page: route, link: href });
    }
  }
}

async function check([url, usedOn]) {
  const result = { url, usedOn: [...new Set(usedOn)] };
  try {
    const address = url.split("#")[0];
    let response = await request(address, "HEAD");
    if (response.status >= 400) response = await request(address, "GET");
    result.status = response.status;
    result.finalUrl = response.url;
    result.verdict = landing(address, response);

    const section = url.split("#")[1];
    if (result.verdict === "ok" && section) {
      // Read the page body only from a successful answer. A sign-in wall or rate
      // limit on this second request is blocked, not a missing section.
      // The second answer is judged the same way, because it can redirect
      // somewhere the first did not.
      const page = await request(address, "GET");
      result.status = page.status;
      result.finalUrl = page.url;
      result.verdict = landing(address, page);
      if (result.verdict === "ok") {
        let body = await page.text();
        // HL7 implementation guides serve a short page that picks a language
        // with a script. A browser follows it, so read the English page once.
        if (!hasId(body, section) && body.includes("lang-redirects.js")) {
          const english = address.replace(/\/([^/]*)$/, "/en/$1");
          const translated = await request(english, "GET");
          result.readFrom = english;
          result.verdict = landing(english, translated);
          result.status = translated.status;
          result.finalUrl = translated.url;
          // A section that could not be read proves nothing about it.
          if (result.verdict === "ok") body = await translated.text();
        }
        if (result.verdict === "ok" && !hasId(body, section) && !hasId(body, `user-content-${section}`)) result.verdict = "section not found";
      }
    }
    result.hostChanged = new URL(result.finalUrl).hostname !== new URL(url).hostname;
  } catch (error) {
    result.verdict = "unreachable";
    result.error = String(error.cause?.code ?? error.message);
  }
  return result;
}

const results = await inBatches([...outside], 6, check);
const pick = (verdict) => results.filter((result) => result.verdict === verdict);
const redirected = pick("ok").filter((result) => result.hostChanged);
const where = (routes) => (routes.length > 3 ? `${routes.slice(0, 3).join(", ")} and ${routes.length - 3} more` : routes.join(", "));
for (const result of results.filter((result) => result.verdict !== "ok"))
  console.log(`${result.verdict}  ${result.status ?? result.error}  ${result.url}  on ${where(result.usedOn)}`);
for (const result of redirected) console.log(`redirected  ${result.url}  to ${result.finalUrl}  on ${where(result.usedOn)}`);
for (const missing of missingSections) console.log(`section missing  ${missing.link}  on ${missing.page}`);
for (const page of notInRoutes) console.log(`not in tools/routes.json  ${page.route}  from ${page.file}`);
for (const page of relativeSlugs) console.log(`slug does not start with /  ${page.slug ?? "no slug"}  in ${page.file}`);
const counts = {
  anchorsScanned,
  outsideLinks: results.length,
  sectionLinksChecked,
  skipped: skippedLinks,
  ok: pick("ok").length - redirected.length,
  redirected: redirected.length,
  broken: pick("broken").length,
  sectionNotFound: pick("section not found").length,
  redirectedToRoot: pick("redirected to root").length,
  missingPageSections: missingSections.length,
  blocked: pick("blocked").length,
  unreachable: pick("unreachable").length,
  notInRoutes: notInRoutes.length,
  relativeSlugs: relativeSlugs.length,
};
console.log(
  `Scanned ${anchorsScanned} links, found ${results.length} distinct outside links and ${sectionLinksChecked} links to a page section, ` +
    `skipped ${skippedLinks} to local or example hosts.`,
);
console.log(
  `Fail: ${counts.broken} broken, ${counts.redirectedToRoot} redirected to a site's root, ${counts.sectionNotFound} outside sections not found, ${counts.missingPageSections} page sections missing, ` +
    `${counts.notInRoutes} pages not in tools/routes.json, ${counts.relativeSlugs} slugs not starting with /. ` +
    `Information: ${counts.redirected} redirected, ${counts.blocked} blocked, ${counts.unreachable} unreachable.`,
);
if (results.length === 0) console.log("Found no outside links. The extractor may be broken, so this check counts as blocked.");

await writeReport("links.json", {
  counts,
  broken: pick("broken"),
  sectionNotFound: pick("section not found"),
  redirectedToRoot: pick("redirected to root"),
  missingSections,
  notInRoutes,
  relativeSlugs,
  redirected,
  blocked: pick("blocked"),
  unreachable: pick("unreachable"),
  ok: pick("ok").map((result) => result.url),
});
if (counts.broken + counts.redirectedToRoot + counts.sectionNotFound + counts.missingPageSections + counts.notInRoutes + counts.relativeSlugs > 0) process.exitCode = 1;
