#!/usr/bin/env node
'use strict';

/**
 * Validates every committed data/ file against the same rules the contribution
 * pipeline enforces, so bot-authored PRs and hand edits cannot drift apart.
 *
 * Run by .github/workflows/ci.yml, or directly: node .github/scripts/validate-data.js
 *
 * Deliberately reuses contribution-parser.js rather than restating the rules:
 * two copies of "what a valid building looks like" would diverge, and the copy
 * that guards untrusted input is the one that must not.
 */

const fs = require('fs');
const path = require('path');

const parser = require('./contribution-parser.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = path.join(REPO_ROOT, parser.DATA_DIR);

const errors = [];
const seenIds = new Map(); // id -> first file it appeared in

let checked = 0;

function readJson(absolutePath, relativePath) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: not valid JSON — ${error.message}`);
    return null;
  }
}

/** Ids must be unique across the whole dataset, not just within one file. */
function checkUniqueId(id, relativePath) {
  if (seenIds.has(id)) {
    errors.push(`${relativePath}: duplicate id "${id}" (already defined in ${seenIds.get(id)})`);
    return;
  }
  seenIds.set(id, relativePath);
}

function validateCollection(relativePath, type, site, categoryFromFilename) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) return;

  const items = readJson(absolutePath, relativePath);
  if (items === null) return;

  if (!Array.isArray(items)) {
    errors.push(`${relativePath}: expected a JSON array, got ${typeof items}`);
    return;
  }

  items.forEach((item, index) => {
    checked += 1;
    const where = `${relativePath}[${index}]`;

    if (typeof item !== 'object' || item === null) {
      errors.push(`${where}: expected an object`);
      return;
    }

    // build.js fills these in from the file's location when absent, so mirror
    // that here rather than demanding they be written out explicitly.
    const effectiveSite = item.site || site;
    const effectiveCategory = item.category || categoryFromFilename || 'other';

    try {
      parser.validateEntity(type, effectiveSite, effectiveCategory, item);
      if (typeof item.id === 'string') checkUniqueId(item.id, where);
    } catch (error) {
      errors.push(`${where} ("${item.name || item.id || 'unnamed'}"): ${error.message}`);
    }
  });
}

function validateBoundary(site) {
  const relativePath = `${parser.DATA_DIR}/${site}/boundary.json`;
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) return;

  const boundary = readJson(absolutePath, relativePath);
  if (boundary === null) return;

  if (!boundary.boundary) {
    errors.push(`${relativePath}: missing a "boundary" key`);
    return;
  }

  try {
    parser.validatePoints(boundary.boundary, 'building', `${relativePath} boundary`);
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
  }
}

parser.SITES.forEach((site) => {
  validateBoundary(site);

  const buildingsDir = path.join(DATA_ROOT, site, 'buildings');
  if (fs.existsSync(buildingsDir)) {
    fs.readdirSync(buildingsDir)
      .filter((file) => file.endsWith('.json'))
      .forEach((file) => {
        const category = file.replace(/\.json$/, '');

        // The filename is the category, so it must itself be a safe slug —
        // this is the same rule the contribution pipeline applies.
        if (!parser.CATEGORY_RE.test(category)) {
          errors.push(`${parser.DATA_DIR}/${site}/buildings/${file}: filename is not a valid category slug`);
        }
        validateCollection(`${parser.DATA_DIR}/${site}/buildings/${file}`, 'building', site, category);
      });
  }

  validateCollection(`${parser.DATA_DIR}/${site}/landmarks.json`, 'landmark', site, null);
  validateCollection(`${parser.DATA_DIR}/${site}/paths.json`, 'path', site, null);
});

if (errors.length) {
  console.error(`${errors.length} problem(s) found in ${parser.DATA_DIR}/:\n`);
  errors.forEach((error) => console.error(`  - ${error}`));
  process.exit(1);
}

console.log(`data/ is valid: ${checked} entries checked, ${seenIds.size} unique ids.`);
