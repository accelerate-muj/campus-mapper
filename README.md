# Campus Mapper

A lightweight, no-backend campus mapping tool for Manipal University Jaipur. Anyone can open it, trace buildings on satellite imagery, and submit their additions as a pull request — a GitHub Action handles the rest. No server, no database, no login. Git is the backend.

## What It Does

**Trace and name every building.** Draw building footprints point-by-point on satellite imagery, tag them by category (Academic, Hostel, Dining, Sports, Admin, etc.), name them, and add floor labels. Buildings aren't anonymous polygons — they carry identity.

**Navigate between places.** Trace walking paths that form a connected network. The route finder snaps to real entry points (doors, gates, track edges) and runs bidirectional Dijkstra over the path graph. Falls back to straight-line if a place is too far from any path.

**Two sites, one map.** College and Hostel are separate views, each with their own boundary, buildings, and path network. Switch between them with a single tap.

**Contribute without friction.** Click Contribute → draw a building or drop a landmark → the JSON preview appears → click Submit PR. A GitHub Issue is pre-filled with the data. A GitHub Action parses it, places the entry in the correct `data/` file, and opens a PR automatically. No manual file editing needed.

**View vs Edit mode.** In view mode, buildings render as small colored dots — clean and uncluttered. Open the Contribute menu and everything switches to edit mode: full polygons, walking paths, and entry markers become visible and interactive.

## Architecture

```
index.html          — HTML shell, controls, modals
style.css           — All styling (panels, modals, kanban, mobile)
mapData.js          — Committed source of truth (BAKED_DATA)
app.js              — Leaflet init, drawing tools, routing, UI logic
data/               — Per-site JSON files (auto-managed by GitHub Action)
.github/workflows/  — Contribution processing Action
```

No build step. Double-click `index.html` to run it locally — works offline, no CORS issues.

## Features

### Drawing Tools
- **Boundary** — Rotatable rectangle aligned to campus orientation. Locked to prevent accidental panning outside the site.
- **Buildings** — Click-to-place polygon tracing. Undo points, close by clicking first point or hitting Finish. Name and categorize in a modal after drawing.
- **Landmarks** — Drop named points (courts, blocks, gates). Each can be expanded into a full building trace with one click.
- **Entry Points** — Place real door/gate locations separate from the building centroid. Supports separate points, connected lines, and closed loops (e.g., stadium tracks).
- **Walking Paths** — Trace path segments that snap to existing endpoints within 15m, forming one connected graph. Click existing paths to delete them.

### Routing
- Bidirectional Dijkstra over the traced path network
- Best entry-point pairing (tests all entrance combinations, picks the shortest total walk)
- Densified entry lines so routing treats traced loops as valid entry ground
- Automatic component stitching — disconnected path fragments get bridged with straight-line gaps flagged in the result
- Straight-line fallback when places are too far from any path

### Map Controls
- **Compass lock** — Fix the bearing so the map always loads at the same rotation
- **Zoom lock** — Lock zoom to a specific level per site (click the badge to set/unlock)
- **Boundary mask** — SVG cutout hides everything outside the drawn boundary
- **Site toggle** — College / Hostel with independent boundaries and views

### Sidebar
- **Kanban building list** — Buildings grouped by category with colored headers
- **Landmark trace queue** — Pending landmarks shown with expand buttons to start tracing
- **Directions** — From/To dropdowns with route display (distance, heading, walk time)

### Mobile
- Collapsible bottom-sheet panel
- Touch-friendly hit targets
- Full-width contribute menu
- Drawing toolbars at bottom of screen

## How to Contribute

### Automated Flow (Recommended)
1. Open the map, click **Contribute**
2. Choose **Add Building**, **Add Landmark**, or **Edit Paths**
3. Draw on the map, fill in details
4. Click **Submit PR** in the preview modal
5. A GitHub Issue opens pre-filled with the JSON — click Submit
6. The Action auto-creates a PR with the file change

### Manual Flow
1. Draw on the map, copy the JSON from the preview
2. Open the relevant `data/` file in the repo
3. Add the entry to the correct array
4. Commit and open a PR

## Data Structure

All map data lives in `mapData.js` as `window.BAKED_DATA`:

```javascript
{
  college: { boundary: [[lat,lng], ...], locked: true, finalized: true, zoomLocked: null },
  hostel:  { boundary: [[lat,lng], ...], locked: true, finalized: true, zoomLocked: null },
  buildings: [
    { id, name, site, category, points: [[lat,lng], ...], landmarkId, entry: { points, connected, closed }, floor }
  ],
  landmarks: [
    { id, name, lat, lng, resolved, entry, category, floor }
  ],
  paths: [
    { id, name, site, points: [[lat,lng], ...] }
  ],
  compass: { bearing: 0, locked: true }
}
```

## What's Still Ahead

- **Merge-friendly format** — One file per building (keyed by ID) instead of one monolithic JSON array, so concurrent PRs don't conflict
- **Verification layer** — Review process or trusted-maintainer model for curating contributions at scale
- **Irregular boundaries** — Polygon boundaries instead of rectangles only
- **Search** — Filter buildings by name in the sidebar
- **Imagery freshness** — Mechanism to refresh or supplement satellite tiles
- **Multi-user testing** — Stress-tested with actual concurrent contributors and real device diversity
