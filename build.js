#!/usr/bin/env node
// build.js — Combines data/ folder into mapData.js
// Usage: node build.js

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, 'data');
var OUT_FILE = path.join(__dirname, 'mapData.js');

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return readJSON(filePath);
}

var compass = readJSON(path.join(DATA_DIR, 'compass.json'));
var result = { college: {}, hostel: {}, buildings: [], landmarks: [], paths: [], compass: compass };

['college', 'hostel'].forEach(function(site) {
  var siteDir = path.join(DATA_DIR, site);
  var boundary = readJSON(path.join(siteDir, 'boundary.json'));
  result[site] = { boundary: boundary.boundary, locked: boundary.locked, finalized: boundary.finalized };

  // Buildings
  var buildingsDir = path.join(siteDir, 'buildings');
  if (fs.existsSync(buildingsDir)) {
    fs.readdirSync(buildingsDir).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
      var category = f.replace('.json', '');
      var items = readArray(path.join(buildingsDir, f));
      items.forEach(function(b) {
        if (!b.site) b.site = site;
        if (!b.category) b.category = category;
        result.buildings.push(b);
      });
    });
  }

  // Landmarks
  var landmarksFile = path.join(siteDir, 'landmarks.json');
  var landmarks = readArray(landmarksFile);
  result.landmarks = result.landmarks.concat(landmarks);

  // Paths
  var pathsFile = path.join(siteDir, 'paths.json');
  var paths = readArray(pathsFile);
  result.paths = result.paths.concat(paths);
});

var output = 'window.BAKED_DATA = ' + JSON.stringify(result, null, 2) + ';\n';
fs.writeFileSync(OUT_FILE, output, 'utf8');
console.log('Built mapData.js from data/ (' + result.buildings.length + ' buildings, ' + result.landmarks.length + ' landmarks, ' + result.paths.length + ' paths)');
