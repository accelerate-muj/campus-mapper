# Contributing

Most contributions are map data, and you don't need to touch code or clone anything to make one.

## Adding to the map (no setup)

1. Open the map and click **Contribute**
2. Choose **Add Landmark**, **Add Building**, or **Add Path**
3. Draw, then fill in the name and category
4. Click **Submit PR** — a GitHub Issue opens, pre-filled with your JSON
5. Submit the issue. A bot validates it and opens a pull request.

If the bot rejects your contribution it comments with the exact reason (bad
coordinates, a duplicate id, a name that's too long). Edit the issue body and
reopen it, or ask a maintainer.

### What the bot checks

Your entry must have a unique `id`, a `name`, and valid coordinates:
`points` must be `[lat, lng]` pairs within range (at least 3 for a building, 2
for a path). Unknown fields are dropped rather than saved. The full rule set
lives in `.github/scripts/contribution-parser.js` and every rule has a test.

## Working on the code

There is no build step, no bundler, and no dependencies. Clone it and open
`index.html`.

```bash
git clone https://github.com/accelerate-muj/campus-mapper.git
cd campus-mapper
# then just open index.html
```

### Running the tests

Either open `tests/index.html` in a browser, or:

```bash
node tests/run.js
```

There is no `npm install`, because there is no `package.json`. That is
deliberate — see "Project conventions" below.

**No Node installed?** You don't need it. Either open `tests/index.html` in a
browser — the suite runs there, against the same harness and the same test
files — or use Docker:

```bash
# From the repo root. Runs the same command CI runs, on the same Node version.
docker run --rm -v "$(pwd):/app" -w /app node:20-slim node tests/run.js

# PowerShell:
docker run --rm -v "${PWD}:/app" -w /app node:20-slim node tests/run.js
```

The `-v` mount is the part that matters: without it the container cannot see
your files, and `node tests/run.js` will report that it can't find the file.

The other two checks CI runs:

```bash
docker run --rm -v "$(pwd):/app" -w /app node:20-slim node .github/scripts/validate-data.js
docker run --rm -v "$(pwd):/app" -w /app node:20-slim node build.js
```

One caveat when regenerating `mapData.js` from a Linux container on Windows:
the container writes LF endings, so Git may briefly show the file as modified
with an empty diff. That is `.gitattributes` doing its job — the content is
unchanged. `git checkout -- mapData.js` clears it if the sync check already
passes.

CI runs the same suite, plus a validation pass over every committed `data/`
entry, on every push and pull request.

### Project layout

Pure logic lives in `src/` — no DOM, no Leaflet, no shared state. That is what
makes it testable. If you are adding logic that is *arithmetic or algorithmic*,
it belongs in `src/` with a test. If it touches the map or the DOM, it belongs
in `app.js`.

## Project conventions

**No build step.** You must be able to double-click `index.html` and have it
run. This rules out ES modules (`file://` blocks them), TypeScript, and
bundlers. Everything loads as a plain `<script>`, and modules attach to a
global via a small UMD wrapper. If you're tempted to add a toolchain, that's a
discussion to have in an issue first — it trades away the property that makes
this project approachable to students who have never used npm.

**No dependencies.** The four CDN assets (Leaflet, leaflet-rotate, Font
Awesome) are the entire dependency surface. Keep it that way.

**`mapData.js` is generated.** `data/` is the source of truth. After editing
`data/` by hand, run `node build.js` and commit both. CI fails a PR where they
disagree.

**Formatting.** Two-space indent, LF line endings, UTF-8. `.editorconfig`
enforces this in most editors with nothing to install.

## Bumping a CDN dependency

Third-party assets are pinned to an exact version and carry a Subresource
Integrity hash, so a swapped or compromised CDN file is rejected by the browser
instead of executed.

**If you change a version, you must regenerate its hash, or the asset silently
stops loading.** The failure looks like the map simply not appearing.

To generate one:

```bash
curl -s https://unpkg.com/leaflet@1.9.4/dist/leaflet.js \
  | openssl dgst -sha384 -binary \
  | openssl base64 -A
```

Then update both the `src`/`href` and the `integrity` attribute, and keep
`crossorigin="anonymous"` — SRI is not enforced without it. Hashes appear in
`index.html` and `verify/index.html`; Leaflet is loaded by both, so update them
together.

## Security

The contribution workflow processes input that any GitHub user can author,
while holding write access to the repo. If you touch
`.github/workflows/process-contribution.yml` or the scripts it calls, two rules
are non-negotiable:

1. **Never put `${{ ... }}` inside a `run:` block.** GitHub substitutes the
   expression before the shell parses the script, so a crafted building name
   becomes executable code. Pass values through `env:` instead — the runner
   assigns those directly and the shell only ever sees a variable reference.
2. **Never write to a path that came from the issue.** Derive it from validated
   parts. The `**File:**` line in the issue body is ignored on purpose.

Both rules have regression tests in `tests/contribution-parser.test.js` that
name the vulnerability they pin. If you find yourself editing those tests to
make a change pass, stop — that is the test doing its job.

Found a security issue? Please open a private report rather than a public issue.

## Colours and theming

**Never put a raw colour in `style.css` outside the two theme blocks.** Every
colour resolves through a token in `:root`. If you need a new one, add it to
`:root` *and* to `:root[data-theme="light"]` — a token defined in only one
place silently inherits the dark value in light mode, and something becomes
unreadable.

Check contrast when you pick a value. `--accent` is a live example of why:
the dark-theme teal `#4fb3a9` is only ~2.4:1 on white, so light mode uses a
darker teal chosen by measuring it against all four surfaces it lands on. A
first attempt at that colour looked perfectly fine and failed AA in two places.
Aim for 4.5:1 for normal text.

Dark is the default (`:root`); light is the override. `data-theme` is set on
`<html>` by a small inline script in the `<head>` — it must run before first
paint, or light-mode users see a flash of dark on every load.

## Accessibility

The map is the product, and it has to work for everyone using it.

- Every interactive control needs an accessible name. A `placeholder` is not a
  label.
- If state is shown with colour, it also needs to be in ARIA (`aria-pressed`,
  `aria-selected`, `aria-expanded`) and kept in sync in JS.
- Emoji and icons inside a labelled control are decorative — wrap them in
  `aria-hidden="true"` or a screen reader reads "wastebasket Delete Path".
- Anything the user is expected to notice appearing (a route result, a status
  change) belongs in an `aria-live` region.

## Commit messages

Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `ci:`, `test:`,
`chore:`. Include a scope where it helps (`fix(a11y):`, `fix(security):`).
Explain *why* in the body — the diff already shows what.
