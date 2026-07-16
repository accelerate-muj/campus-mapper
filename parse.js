#!/usr/bin/env node
// parse.js — Splits mapData.js into data/ folder structure
// Usage: node parse.js

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, 'data');
var SRC_FILE = path.join(__dirname, 'mapData.js');

// Parse mapData.js
var raw = fs.readFileSync(SRC_FILE, 'utf8');
var match = raw.match(/window\.BAKED_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
if (!match) { console.error('Could not parse mapData.js'); process.exit(1); }
var D = JSON.parse(match[1]);

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function normBoundary(b) {
  if (!b) return null;
  if (b.length === 2) {
    var sw = b[0], ne = b[1];
    return [[sw[0],sw[1]],[sw[0],ne[1]],[ne[0],ne[1]],[ne[0],sw[1]]];
  }
  return b;
}

function ptInPoly(lat, lng, corners) {
  var inside = false;
  for (var i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    var xi = corners[i][1], yi = corners[i][0];
    var xj = corners[j][1], yj = corners[j][0];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// Compass
writeJSON(path.join(DATA_DIR, 'compass.json'), D.compass || { bearing: 0, locked: false });

var sites = ['college', 'hostel'];

sites.forEach(function(site) {
  var siteDir = path.join(DATA_DIR, site);

  // Boundary
  writeJSON(path.join(siteDir, 'boundary.json'), {
    boundary: D[site].boundary,
    locked: D[site].locked,
    finalized: D[site].finalized
  });

  // Buildings by category
  var catDir = path.join(siteDir, 'buildings');
  var catBuildings = {};

  (D.buildings || []).forEach(function(b) {
    if ((b.site || 'college') !== site) return;
    var cat = b.category || 'other';
    if (!catBuildings[cat]) catBuildings[cat] = [];
    catBuildings[cat].push(b);
  });

  // Remove old category files
  if (fs.existsSync(catDir)) {
    fs.readdirSync(catDir).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
      fs.unlinkSync(path.join(catDir, f));
    });
  }

  Object.keys(catBuildings).sort().forEach(function(cat) {
    writeJSON(path.join(catDir, cat + '.json'), catBuildings[cat]);
  });

  // Landmarks — assign to the site whose boundary they're inside
  var corners = normBoundary(D[site].boundary);
  var siteLandmarks = (D.landmarks || []).filter(function(lm) {
    if (!corners) return site === 'college';
    return ptInPoly(lm.lat, lm.lng, corners);
  });
  writeJSON(path.join(siteDir, 'landmarks.json'), siteLandmarks);

  // Paths
  var sitePaths = (D.paths || []).filter(function(p) {
    return (p.site || 'college') === site;
  });
  writeJSON(path.join(siteDir, 'paths.json'), sitePaths);
});

console.log('Parsed mapData.js into data/ folder structure.');
