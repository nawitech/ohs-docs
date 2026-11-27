# Docs checks, how to use them

The docs checks compare facts on the OHS docs pages with the code, packages and sites they describe. Two workflows in `ohs-foundation/ohs-docs` run the same seven checks on every page. One runs on each pull request, and fails on findings on the pages the pull request touches, unless they count as already on main. The other runs on a schedule against `main`, and fails on every problem until the page is fixed. A fork of `ohs-docs` runs them too, on its own pages.

## Two triggers

| Item | Pull request | Schedule |
| --- | --- | --- |
| Workflow | [`docs-checks-pr.yml`](../../.github/workflows/docs-checks-pr.yml) | [`docs-checks.yml`](../../.github/workflows/docs-checks.yml) |
| Starts | On each pull request, from a branch or from a fork | Monday, Wednesday and Friday at 06:17 UTC, and by hand with "Run workflow" |
| Pages checked | The pull request's merge commit, every page | `main`, every page |
| Fails on | A finding on a page the pull request touches, unless it counts as already on main. An item a check could not read on a touched page. A targets entry that names a page that does not exist | Every finding. Every blocked check |
| Does not fail on | Findings on other pages. Findings on a touched page that count as already on main | Nothing. There is no list of known findings |
| Compared with | The nearest earlier run of `docs-checks.yml` on the base branch, usually `main`, with a usable artifact, up to 10 runs back | The nearest earlier run of `docs-checks.yml` on `main` with a usable artifact, up to 10 runs back |
| Artifact | `docs-checks-pr-<pull request number>-<attempt>`, kept for 14 days | `docs-checks-<run number>`, kept for 90 days |
| Time limit | 15 minutes | 20 minutes. A run takes about 2 minutes |

A pull request run checks every page, so its summary also shows the findings it does not fail on. The scheduled run keeps every problem in view, so a finding on a page nobody edits still fails a run. A run started by hand on another branch checks that branch, and compares with earlier runs on it.

## What each trigger catches

The pull request run catches problems a pull request adds to the pages it touches, before it merges. This works the same for a pull request to `ohs-docs` `main` and to a fork's `main`. Three limits apply.

- A failed run does not block the merge by itself. GitHub shows a failed check, and the pull request can still be merged. To block merges, a maintainer makes "Docs checks on pull requests" a required status check in the branch protection rules for `main`. The workflows do not set this.
- A problem a pull request causes on a page it does not touch does not fail it. For example, removing a heading breaks a section link on another page. The summary lists the finding under Not touched by this pull request, and the next scheduled run fails on it.
- A change outside the docs needs no docs pull request. When a code repository renames a module, or a new package version is published, only the scheduled run finds the page that is now wrong.

The scheduled run finds every problem on `main`, including the ones these limits miss.

## Where they run

Both workflows are in `.github/workflows/` in `ohs-foundation/ohs-docs`, next to two others. [`checks.yml`](../../.github/workflows/checks.yml) runs `npm run gates` on each pull request, and [`deploy.yml`](../../.github/workflows/deploy.yml) publishes the site on each push to `main`. The check scripts are the other 16 files in this folder, `tools/qa`. Each workflow checks out the repository it runs in, so the pages, the scripts and the workflows come from one commit.

Both workflows read only. They need no secrets and post nothing. GitHub asks a maintainer to approve the first pull request run for a first-time contributor. Nothing else needs approval. The workflow token reads earlier runs, so both have actions read. Nobody runs them locally. The commands check needs the Docker CLI with the Compose plugin, which the runner has. It does not need the Docker daemon.

### In a fork

A fork of `ohs-docs` has the same workflow files, and runs them on its own pages. A pull request from a fork to `ohs-docs` runs in `ohs-docs`, not in the fork.

| Item | In `ohs-docs` | In a fork of `ohs-docs` |
| --- | --- | --- |
| Workflows run | Always | Only after the fork's owner enables Actions in the fork's Actions tab. GitHub runs no workflow in a new fork until then |
| Scheduled run checks | `main` of `ohs-docs` | The fork's own `main` |
| Pull request run | On each pull request to `ohs-docs`, from a branch or from a fork | On each pull request opened in the fork |
| Compared with | Earlier runs on `ohs-docs` `main` | Earlier runs on the fork's `main`. Until the fork's first scheduled run, nothing counts as already on main |
| `deploy.yml` | Publishes the site on each push to `main` | Also runs on each push to the fork's `main`. Disable it in the fork unless the fork publishes its own site |

## What a pass proves

The checks cover facts with a fixed shape and a single source, such as a module name in `settings.gradle.kts`, a version on Maven Central, or a port in a Compose file. A scheduled pass means the run found no finding and no check was blocked. A pull request pass means the same for the pages the pull request touches, apart from findings main already had. Blocked links were not judged.

A pass does not mean the page is right. Prose, screenshots and code samples are not checked. The gaps table below lists what the checks miss.

No documented command is run. The commands check reads `package.json` and runs `docker compose config`, which reads Compose files and starts nothing.

## The prose rule

No check reads prose. A sentence about behaviour is checked only when it is stored as a claim in [`tools/qa/sentence-claims.json`](sentence-claims.json).

- Each claim quotes a sentence or part of one, and names the source that proves one value in it. The source is usually one file. It can be a Compose file read with its `.env` file, or a table on the same page.
- Each claim's `tests` field says what is proved, and `notTested` says what is not.
- Claims are added one at a time.
- A second person confirms that the claim's rule tests the sentence.

## The seven checks

| Check | Reads on the page | Compares against | Fails when | Shown, does not fail |
| --- | --- | --- | --- | --- |
| Links | Every outside link and section link in the built site | The destination over the web, the headings on the target page, and `tools/routes.json` | 404 or similar, a missing section, a deep link that lands on the site's home page, a page missing from `tools/routes.json`, or a slug that does not start with `/` | Redirects to another host. Blocked answers (401, 403, 408, 425, 429, 999, and 500 to 599). Network errors. A section after `#` that holds `:` or `/`, or starts with `!`, which a script on the page reads |
| Gradle modules | Module names in `./gradlew` commands | `settings.gradle.kts` of the repository named in `gradle-targets.json` | The module is not included, or the page is not mapped | Nothing |
| Package versions | Every `dev.ohs` package | Published versions on Maven Central. When Maven Central refuses or gives a bad answer, Google's mirror of it | Maven Central has no such version or package. The mirror never gives not found, because it can be behind. A version it does not list is not checked | Behind the latest version. Versions confirmed on the mirror, which shows a version was published but not whether it is the latest |
| Version agreement | The version each page names for a library | The Current versions and Pairing tables in [`docs/fhir-foundations/versions.md`](../../docs/fhir-foundations/versions.md) | A page names a different version, or the table contradicts itself | A different artifact of the same library |
| Lists that match the code | Screen addresses in the Path column of the Portal screens table | Every route in the Portal code, listed in `list-targets.json` | A route is only in the code, or only on the page | A path that is a listed parent plus one parameter |
| Sentence claims | Quoted sentences in `sentence-claims.json` | One rule per claim, reading the source at one commit | The source has another value, or the quote is gone from the page | Nothing |
| Commands | `docker compose`, `npm`, `pnpm` and `yarn` lines in shell code blocks | The repository and folder in `command-targets.json`, read with `docker compose config` and `package.json`. A `cd` into a folder of that repository is followed | A Compose file, profile, service, `package.json`, script or folder is missing, the package manager differs, or the page is not mapped | Built-in commands such as `pnpm install` |

A check that finds nothing to compare, or cannot read its source, is blocked. A blocked check fails a scheduled run, so a broken check cannot pass unnoticed. Blocked links are the exception. They are listed under Not compared.

"Lists that match the code" is the only check that notices code additions no page mentions. Today it has one list, the Portal routes. Each new list needs its own reader in `check-lists.mjs` and an entry in `list-targets.json`.

## Pages a pull request touches

[`tools/qa/touched.mjs`](touched.mjs) compares the merge commit with its first parent, the base branch commit. A page is touched when the pull request does one of these.

- Adds, changes or renames its `.md` or `.mdx` file under `docs/`.
- Adds, changes or removes its entry in `gradle-targets.json`, `command-targets.json`, `list-targets.json` or `sentence-claims.json`.

A finding counts for a touched page when it names the page's file or its route.

Every page counts as touched when the pull request changes one of these.

- `docs/fhir-foundations/versions.md`, `tools/routes.json`, `docusaurus.config.js`, `sidebars.js`, `package.json` or `package-lock.json`.
- Any file under `src/`, `static/` or `tools/scripts/`.
- Any file under `tools/qa/` other than the four targets files.
- A top-level key in a targets file other than `about` and its entries.

Every page also counts when a targets file is not valid JSON, or has a list or claim whose id is missing or used twice, at either commit, even if `main` already had the problem. It counts too when a touched page has no slug that starts with `/`, or when `touched.mjs` fails. A valid change to a list or claim id touches only the pages of the old and new entries.

Removing a page does not touch it. When the pull request removes a targets entry and its page stays, the summary asks a person to confirm the removal. A targets entry the pull request adds or changes, or leaves behind when it removes the page, can name a page that does not exist. That fails the run. An entry that was already broken on `main` does not fail the pull request.

## How a pull request run decides

The run compares its findings with the nearest earlier run of `docs-checks.yml` on the base branch that has a usable artifact. A finding on a touched page counts as already on main, and does not fail the run, when all of these hold.

- That run had a finding with the same check, page and value.
- That run checked the commit it ran on. A run on `main` does.
- `touched.mjs` read the commit that run checked, and found that `main` has not changed the page, its targets entry or a file that affects every page since.

If any of these is unknown, nothing counts as already on main. The run fails on every finding on a touched page.

The run also fails when a check could not read an item on a touched page, or an item that belongs to no page. A blocked site or a slow registry usually clears on a rerun. A check that failed without a finding, or did not run, fails the run too.

A link on a touched page that a site refused does not fail the run. The summary asks for it to be opened by hand before merging.

The workflow runs on `pull_request`, never `pull_request_target`. A pull request from a fork gets a read-only token and no secrets. The pull request's own code runs in the job, so it can change its own result. Maintainer review of `tools/qa`, the package files and the workflows guards against that. GitHub asks a maintainer to approve the first run for a first-time contributor, and runs nothing for a pull request with a merge conflict.

## What to do with a failed run

For a pull request run, follow these steps.

1. Open the Docs checks on pull requests run from the pull request's checks.
2. Read the headline. It names each reason, such as "1 finding on pages this pull request touches, 13 on other pages".
3. Do each item under What to do.
4. Fix each finding under On touched pages. If the check is wrong, fix the check or its targets file in the same pull request.
5. Push. The run starts again.

Findings under Already on main and Not touched by this pull request are not the pull request's to fix.

For a scheduled run, follow these steps.

1. Open the run page in the Actions tab.
2. Read the headline. It names each reason the run failed, such as "14 findings, 1 new compared with run 6".
3. Do each item under What to do.
4. Start with the new findings. For each, open the page and the source.
5. If the problem is real, fix the page in a pull request to `main`. If the fix needs a decision or more work, post a GitHub issue for it.
6. If the check is wrong, fix the check or its targets file in `tools/qa`.

A finding fails every scheduled run until its fix is merged into `main`. A finding with a posted issue still fails the run. The run cannot know which issue covers it.

## Reading a report

Each run page shows a job summary, written by [`tools/qa/job-summary.mjs`](job-summary.mjs) from the reports. It is meant to be enough to act on without opening the files. In order, a scheduled run's summary has these parts. Empty parts are left out.

1. The headline. A passing run says "No findings". A failing run names every reason, such as "14 findings, 1 new compared with run 6, 1 check blocked". The reasons are findings, a check that failed without a finding, blocked checks, checks that did not run, and unknown changed pages. A run that stopped early says "Docs checks did not finish".
2. The docs commit checked, and the commit the checks came from, both linked on GitHub.
3. The comparison. "Compared with run 6 on 2026-11-24", or "No earlier run to compare with", or "Comparison unavailable" with the reason. If the earlier run could not read every item in a check, or did not run a check, a line says a finding in that check may show as new when it is not.
4. What to do. Blocked checks with each reason, checks that did not run, items the checks could not settle, then one line about the findings.
5. A table with each check's result, what it checked, such as "83 outside links, 1,749 section links", its findings, and how many are new. The New column is left out when nothing was compared.
6. New findings, then the findings also found in the earlier run, folded. With no comparison, one Findings table. Each row has the check, the page with a link to its source lines or live page, and the finding with its problem, such as "answers 404" or "versions.md expects 2.0.0-alpha05". A version agreement finding also shows the latest version on Maven Central and the note for its line. For a sentence claim, the row shows the quoted sentence, the value it states, and the value the source has.
7. Folded, Worth a look. Redirects to another host, versions behind the latest that are not findings, version agreement notes, and list values accepted through a parent path.
8. Folded, Not compared. What the checks skipped, so a pass says nothing about it. Blocked and unreachable links, link sections a script on the page reads, versions confirmed only on the mirror, commands with nothing to compare, skipped modules, and counts of skipped links, Maven blocks and pins with no rule.

A pull request run's summary differs in these parts.

- The headline counts findings on touched pages, then already on main, then on other pages, such as "No findings on pages this pull request touches, 5 already on main, 9 on other pages".
- A line names the pull request, the base branch and the merge commit. The comparison line names the run it was compared with and lists the touched pages, or says why every page counts.
- What to do lists checks to rerun, targets entries that name a missing page, removed checks to confirm, and links to open by hand, refused or with a section a script reads.
- The checks table has a To fix here column instead of New.
- The findings come in three groups. On touched pages, then folded, Already on main and Not touched by this pull request.

A finding is the same as one in the earlier run when its check, page and value are equal. Line numbers are not compared. So a finding that moves to another line is not new, and a finding that went away and came back is new. There is no list of fixed findings. A count can drop because a site was blocked or a check changed, not only because a page was fixed.

Text from pages and sources is shown as plain text, cut to 300 characters, and only http and https addresses become links. Tables and lists stop at 50 rows and say how many more there are. The summary stays under GitHub's size limit for one step.

If the summary script fails, or its output is too large, the run page shows `fallback.txt` instead, a few plain sentences with the result and every reason.

Read the summary first. Open a check's report only for detail the summary leaves out, such as the full list when a table stops at 50 rows.

| File | Holds |
| --- | --- |
| `summary.json` | Result, the reasons it failed, every finding marked new or not, blocked and partly read checks, and the run compared with. A pull request run adds the touched pages and marks each finding touched and already on main |
| `links.json`, `source-paths.json`, `versions.json`, `version-agreement.json`, `lists.json`, `sentence-claims-check.json`, `commands.json` | One report per check |
| `run-output.txt` | The lines printed by `run.mjs` |
| `fallback.txt` | The plain sentences shown if the summary script fails |
| `job-summary.md` | The job summary as Markdown |
| `status.txt` | Present only when the checks did not run |
| `inputs/touched.json`, `inputs/compare/` | Pull request runs only. The touched pages, and the run the findings were compared with |

When GitHub or Maven Central has an outage, links show as blocked, and fewer findings may be listed. Maven Central often answers GitHub's runners with 429, too many requests. The versions check then reads Google's mirror at `maven-central.storage-download.googleapis.com`. A version the mirror lists counts as published. A version it does not list is not checked, because the mirror can be a few hours behind. An unread version fails a scheduled run. If another version already failed the check, its result stays fail, and the unread versions are listed under What to do. A pull request run fails only when the unread version is on a touched page. Rerun before drawing conclusions.

## How the comparison works

A workflow step runs before the checks. It reads up to 10 completed runs of `docs-checks.yml` that started before this run. The scheduled run reads runs on `main`. The pull request run reads runs on the pull request's base branch. For each, newest first, it downloads the artifact, and checks its `summary.json` with [`tools/qa/compare.mjs`](compare.mjs). It uses the first one that passes. A run whose artifact is missing, expired, too large or not valid is skipped.

The step writes `comparison.json` from GitHub's run data, never from the artifact. It uses only the earlier run's findings, its docs commit, and its lists of checks that were blocked, partly read or not run. The earlier result and counts are never used. If the step fails, the run goes on with no comparison. A scheduled run's result stays the same. A pull request run then counts nothing as already on main.

## Gaps

| Kind of failure | Example | Why the checks miss it | Can it be added |
| --- | --- | --- | --- |
| Prose about behaviour | A Portal page describing old screens | No rule reads prose. Only stored claims are checked | One sentence claim at a time |
| Counts not tied to a checked list | A sentence such as "the four libraries" | Only the Portal screens count is a claim | Yes, once its list is checked |
| Other lists | Compose services, environment variables, feature flags | `list-targets.json` holds only the Portal routes | Yes, one list at a time |
| Paths in text and commands | `cd reference-app` on a page with only Gradle commands, or a file named in a sentence | Only linked files, `compose -f` files and `cd` folders on pages in `command-targets.json` are opened | Yes, medium effort |
| Gradle task names | `installDebug` | Plugins create tasks when Gradle runs | Only by running Gradle |
| Command line flags | Options on `java`, `mvn` and `docker run` lines | Each tool defines its own flags | Only with a reader per tool |
| Code samples | A Kotlin snippet that no longer compiles | Nothing compiles the samples | Only by building them |
| Screenshots | A screen that has changed | Nothing compares images | Not planned |
| Links to sites that refuse scripts | A real 404 on a site that answers scripts with 403 | Blocked links are listed under Not compared, and never fail | Partly. Check them by hand now and then |
| A link that stays blocked | A page that always answers 500 or 503 | Each run reports it as blocked, which never fails | Yes. Flag links blocked in several runs in a row. The comparison reads only one earlier run |
| Redirects to an unrelated page | A link that lands on another page of the same site | Only a redirect to the home page fails. A redirect within the same host is not reported | Partly. Report same-host redirects for a person to read |
| Pages that say not found with a 200 answer | A site's not found page at the old address | The check reads the status, not the text | Partly. Look for a not found title |
| An outage page with a 200 answer on a section link | `/guide#install` answers 200 with "Temporarily unavailable" | The section is missing from that page, so the run fails as "section not found" | Partly. Only for known outage page text |
| A versions table that falls behind releases | A new `fhir-engine` release ships, and `versions.md` still names the old one | Every page agrees with `versions.md`, and every version exists on Maven Central. A version behind the latest is shown under Worth a look and never fails | Yes, small. Fail when a row in the Current versions table is older than the latest release. Whether alpha and beta releases count is a choice to make |
| Docs written for a release | A page about a tagged release while `main` has moved on | Every check reads the default branch | Yes, small. Let a target name a tag |
| A pull request merged with a failed check | A page with a new broken link merges anyway | GitHub does not block a merge on a failed check unless it is required | Yes. Make "Docs checks on pull requests" a required status check on `main` |
| A pull request that breaks a page it does not touch | A heading removed from a touched page breaks a section link on another page | Only touched pages fail a pull request. The finding shows under Not touched by this pull request | The next scheduled run fails on it |

## Keeping it running

- GitHub disables the schedule of a public repository after 60 days without activity. Check before day 50 in a quiet repository or fork.
- Make "Docs checks on pull requests" a required status check in the branch protection rules for `main`, so a failed run blocks the merge. A fork that wants the same must set it in the fork.
- Add each new page with Gradle, `docker compose` or `npm` commands to its targets file. Otherwise the check fails it as not mapped.
- When `versions.md` lists a new library, add its artifact to `familyOf` in `check-version-agreement.mjs`. Until then, the version agreement check cannot read the table and judges no versions.
- When a scheduled run fails, GitHub can notify the person who last changed the workflow's schedule, by email, on the web or not at all, as set in their notification settings for Actions. While findings remain, every scheduled run fails.
- Review every pull request that changes `tools/qa`, the package files or the workflows. Such a pull request runs its own version of the checks.
- In a fork, enable Actions to run the checks, and disable `deploy.yml` unless the fork publishes its own site.

## Where AI fits

The checks use no AI. Only scripts fail a run.

The first AI step needs no CI change. A maintainer runs an agent locally on each new finding. It triages the finding as real or a check error, finds the commit that changed the value, drafts the issue, and drafts a docs fix on a branch with the gates run. A person reviews both, posts the issue and merges the fix.

These rules apply to any later AI step.

- AI output never fails a run. It goes under Review needed.
- Each AI note names the page line and the source file it used.
- A person confirms every finding, claim and fix. A second person confirms each new claim's rule.
- Fixes go only on branches. A fix to another repository's code goes in the issue as a suggestion.
- In CI, it treats issue text and upstream files as input, never as instructions, and the job that runs code has no write token.

The cost per run is not estimated. AI in CI needs an API key and maintainer agreement.
