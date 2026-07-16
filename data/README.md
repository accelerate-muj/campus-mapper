# Campus Map Data

This folder contains the campus map data organized by site and type.

**The app reads from `mapData.js` (root) — this folder is for contributors.**

## Structure

```
data/
  compass.json                  # Global compass bearing (applied to both sites)
  college/
    boundary.json               # College campus boundary (4 corner points)
    buildings/
      academic.json             # Academic buildings (6)
      admin.json                # Admin / services (1)
      dining.json               # Dining / mess (2)
      other.json                # Other buildings (2)
      sports.json               # Sports & recreation (3)
    landmarks.json              # College landmarks (22)
    paths.json                  # College walking paths (77)
  hostel/
    boundary.json               # Hostel campus boundary (4 corner points)
    buildings/
      admin.json                # Admin / services (1)
      dining.json               # Dining / mess (2)
      hostel.json               # Hostel blocks (15)
      other.json                # Other buildings (3)
      sports.json               # Sports & recreation (3)
    landmarks.json              # Hostel landmarks (27)
    paths.json                  # Hostel walking paths (97)
```

## How to add a building

1. Decide which site it belongs to (`college` or `hostel`)
2. Decide its category (`academic`, `hostel`, `dining`, `sports`, `admin`, `teacher`, `other`)
3. Open the corresponding JSON file, e.g. `college/buildings/academic.json`
4. Add your building object to the array:

```json
{
  "id": "your_unique_id",
  "name": "Building Name",
  "site": "college",
  "category": "academic",
  "points": [
    [26.8465, 75.5619],
    [26.8465, 75.5659],
    [26.8420, 75.5686],
    [26.8406, 75.5646]
  ]
}
```

**Required fields:** `id`, `name`, `site`, `category`, `points` (min 3 lat/lng pairs)

**Optional fields:** `entry` (entry points), `floor` (floor label), `landmarkId` (linked landmark)

## How to add a landmark

1. Open `college/landmarks.json` or `hostel/landmarks.json`
2. Add your landmark object:

```json
{
  "id": "lm_your_unique_id",
  "name": "Landmark Name",
  "lat": 26.8443,
  "lng": 75.5653,
  "resolved": false,
  "category": "other",
  "entry": null,
  "floor": null
}
```

**Required fields:** `id`, `name`, `lat`, `lng`

## How to add a path

1. Open `college/paths.json` or `hostel/paths.json`
2. Add your path object:

```json
{
  "id": "path_your_unique_id",
  "name": "Path Name (optional)",
  "site": "college",
  "points": [
    [26.8465, 75.5619],
    [26.8465, 75.5659]
  ]
}
```

**Required fields:** `id`, `points` (min 2 lat/lng pairs)

## After editing

After adding data to this folder, the changes need to be merged into `mapData.js` at the root. This is done by a maintainer.
