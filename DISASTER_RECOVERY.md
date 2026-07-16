# Disaster Recovery & Rollback Plan

## What can actually go wrong here

Most disaster recovery plans are about restoring data from backups. This
project has no database, no server, no user accounts, and no uploads. Every
byte of state is committed to Git and cloned onto every contributor's machine.

That changes the shape of the problem. **The data is not the fragile part — the
distribution and the automation are.** This plan covers what is genuinely at
risk, and deliberately does not invent procedures for infrastructure that
doesn't exist.

| Asset | Where it lives | Real risk |
|---|---|---|
| Map data (`data/`, `mapData.js`) | Git, on every clone | Very low. Recoverable from any clone. |
| Site code | Git | Very low. |
| Satellite imagery | Esri ArcGIS (third party) | **Moderate.** Not ours; can change terms or break. |
| Leaflet / Font Awesome | unpkg / cdnjs | **Moderate.** Outside our control. |
| The GitHub Action | GitHub | Moderate. Can be abused or break. |
| The repo itself | GitHub | Low, but single-point-of-failure. |

## Recovery time objectives

These are honest, not aspirational. This is a student project, not a
production service.

| Scenario | RTO | RPO |
|---|---|---|
| Bad merge to `main` | Minutes | Zero — it's a revert |
| Repo deleted / account lost | Hours | Zero if any clone exists |
| CDN outage | Hours (pin swap) | N/A |
| Tile provider gone | Days (needs a decision) | N/A |
| Malicious PR merged | Minutes | Zero |

## Backups

**The primary backup is every clone.** Git is a distributed database; each
`git clone` is a full copy of the entire history. If the GitHub repo vanished
today, anyone who has cloned it can restore it completely with `git push` to a
new remote. This is not a slogan — it is why no backup cron job is specified
here. Adding one would be theatre.

What *is* worth doing:

1. **Ensure more than one person has a clone.** This is the entire backup
   strategy. A repo with one contributor and no forks has a real single point
   of failure, and it is a social problem rather than a technical one.
2. **Enable branch protection on `main`** so history cannot be force-pushed
   away. A force-push that rewrites history is the one Git operation that can
   actually destroy work.
3. **Mirror periodically**, if you want belt and braces:

```bash
# A complete, restorable copy including all refs.
git clone --mirror https://github.com/accelerate-muj/campus-mapper.git
cd campus-mapper.git
git remote update --prune          # run periodically to refresh

# To restore to a new home:
git push --mirror https://github.com/<new-owner>/campus-mapper.git
```

The KML file (`Manipal University Jaipur - Combined.kml`) is the original
survey export and is the only artifact that could not be trivially recreated by
tracing again. It is committed. Keep it that way.

## Rollback procedures

### A bad change reached `main`

The site is served as static files from the repo, so rollback is a revert.

```bash
git checkout main
git pull
git revert --no-edit <bad-sha>     # for a range: git revert --no-edit A^..B
git push
```

Prefer `revert` over `reset --hard` on a shared branch. Reverting is additive
and safe; resetting rewrites history that others already have.

If a *merge commit* is the problem:

```bash
git revert --no-edit -m 1 <merge-sha>
```

### The map renders but shows nothing / looks broken

Almost always one of three things, in order of likelihood:

1. **`mapData.js` is out of sync with `data/`.** CI checks this, but a direct
   push to `main` can bypass it. Fix: `node build.js` and commit.
2. **An SRI hash doesn't match its file.** The browser silently refuses to run
   the script and the map never initialises. Check the browser console for an
   integrity error. Fix: regenerate the hash (see CONTRIBUTING) or temporarily
   revert the version bump.
3. **A CDN or the tile provider is down.** Check the Network tab for failures
   against `unpkg.com` or `server.arcgisonline.com`.

### Bad map data merged (wrong building, garbage geometry)

```bash
git revert --no-edit <sha>   # then regenerate
node build.js
git add mapData.js && git commit -m "chore: rebuild mapData.js after revert"
```

There is no cache to purge and no database migration to unwind. This is the
upside of the whole design.

## Incident: the contribution Action is abused

The Action runs on input from any GitHub user while holding `contents: write`.
Its known injection vectors are closed and regression-tested, but assume one
day something gets through.

**Immediate containment — stop the bleeding first:**

1. Disable the workflow. Actions tab → "Process map contributions" → ⋯ →
   **Disable workflow**. This is faster and more reliable than pushing a fix,
   and it is reversible.
2. If a token may have been exposed: the workflow's `GITHUB_TOKEN` is
   ephemeral and scoped to the run, so it expires on its own. Rotate any
   *other* secret in the repo settings. Check whether any were added since this
   plan was written — at time of writing there are none beyond `GITHUB_TOKEN`.

**Assess:**

3. Read the run logs of the offending run *before* deleting anything.
4. `git log --author="github-actions" --since="<date>"` to see everything the
   bot did.
5. Check for branches the bot created: `git branch -r --list "origin/contribution/*"`.
6. Check for unexpected changes outside `data/` — the derived-path rule means
   the bot should be physically incapable of touching anything else. Any file
   it modified outside `data/` is the smoking gun:

```bash
git log --author="github-actions" --name-only --pretty=format:"%h %s" | sort -u
```

**Recover:**

7. Revert bot commits as above. Delete rogue branches:
   `git push origin --delete <branch>`.
8. Add a regression test in `tests/contribution-parser.test.js` reproducing the
   input that got through, *then* fix it. In that order — a fix without the
   test invites the bug back.
9. Re-enable the workflow only once the test is red-then-green.

## Dependency loss

### A CDN goes away or serves a bad file

SRI means a *tampered* file fails closed: the browser refuses to execute it and
the map doesn't load. That is the correct outcome — better a broken map than an
attacker's JavaScript on a page students trust.

If a CDN is simply gone, swap the host and regenerate the hash (the file
content is identical across unpkg/jsdelivr/cdnjs for the same package version,
so the hash usually does not even change):

```html
<!-- unpkg -->  https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
<!-- jsdelivr --> https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js
```

**The durable fix** is to vendor Leaflet into the repo (`vendor/leaflet@1.9.4/`)
and load it relatively. That removes the CDN from the trust path entirely,
makes real offline use possible, and costs ~150KB in git. If CDN availability
ever causes a real incident, do this rather than switching hosts again.

### The tile provider changes terms or disappears

This is the **most serious dependency risk in the project** and it has no quick
fix. The satellite imagery is Esri's ArcGIS World Imagery; the map is close to
useless without it, and the geometry we've traced is meaningless to a user with
no imagery underneath.

Mitigation is a decision, not a command:

- Alternative raster providers exist (Mapbox, Bing, Google) but all require an
  API key, which means a secret, which means this stops being a
  no-backend project.
- OpenStreetMap tiles are free but are not satellite imagery — you cannot trace
  buildings against them, though existing traced data still renders.
- The traced data itself is provider-independent and survives regardless. That
  is the important thing: **we would lose the ability to trace new buildings,
  not the map.**

Keep the KML and `data/` safe and this risk is bounded.

## Restoring from nothing

Worst case: the GitHub repo is gone and you have one clone on one laptop.

```bash
# 1. Confirm the clone is complete.
git fsck --full
git log --oneline | wc -l

# 2. Create a new empty repo on GitHub, then:
git remote set-url origin https://github.com/<owner>/campus-mapper.git
git push --all
git push --tags

# 3. Re-enable Pages/hosting if it was configured.
# 4. Verify: open index.html locally, confirm the map renders and a route resolves.
# 5. Run the checks before trusting it:
node tests/run.js
node .github/scripts/validate-data.js
node build.js && git diff --exit-code mapData.js
```

Step 5 is the actual proof of a good restore. If those three pass, the data is
intact and consistent — that is a stronger guarantee than "the files are there".

## Verifying this plan

A recovery plan nobody has executed is a hypothesis. The cheap version of a
drill, worth doing once:

```bash
git clone --mirror <repo> /tmp/dr-test.git
git clone /tmp/dr-test.git /tmp/dr-restore
cd /tmp/dr-restore
node tests/run.js
node .github/scripts/validate-data.js
node build.js && git diff --exit-code mapData.js
# open index.html — does the map render? does a route resolve?
```

If that works, the "restore from nothing" path works, because it is the same
path.
