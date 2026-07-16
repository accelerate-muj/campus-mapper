#!/usr/bin/env node
'use strict';

/**
 * Entry point for .github/workflows/process-contribution.yml.
 *
 * Reads the untrusted issue body from ISSUE_BODY, hands it to the pure parser
 * for validation, appends the result to the derived data/ file, and reports
 * back through step outputs.
 *
 * All parsing and validation lives in contribution-parser.js; this file only
 * does I/O, so the rules it depends on can be tested without a runner.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const parser = require('./contribution-parser.js');

const { ContributionError, DATA_DIR, parseContribution } = parser;

/** Belt-and-braces: proves the derived path really does land inside data/. */
function resolveInsideDataDir(repoRoot, targetFile) {
  const dataRoot = path.resolve(repoRoot, DATA_DIR);
  const resolved = path.resolve(repoRoot, targetFile);

  if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep)) {
    throw new ContributionError('Refusing to write outside ' + DATA_DIR + '/: ' + targetFile);
  }
  return resolved;
}

function appendEntity(absolutePath, entity) {
  let items = [];

  if (fs.existsSync(absolutePath)) {
    const existing = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    if (!Array.isArray(existing)) throw new ContributionError(absolutePath + ' does not contain a JSON array.');
    items = existing;
  }

  if (items.some((item) => item && item.id === entity.id)) {
    throw new ContributionError('An entry with id "' + entity.id + '" already exists in this file.');
  }

  items.push(entity);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(items, null, 2) + '\n', 'utf8');

  return items.length;
}

/**
 * Writes a step output. Uses the delimiter form for anything multi-line, which
 * is what stops a crafted value from forging additional outputs.
 */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = String(value);

  if (!file) {
    console.log(key + '=' + text);
    return;
  }

  if (/[\r\n]/.test(text)) {
    const delimiter = 'ghadelim_' + crypto.randomBytes(16).toString('hex');
    fs.appendFileSync(file, key + '<<' + delimiter + '\n' + text + '\n' + delimiter + '\n');
  } else {
    fs.appendFileSync(file, key + '=' + text + '\n');
  }
}

function main() {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();

  try {
    const result = parseContribution(process.env.ISSUE_BODY);
    const absolutePath = resolveInsideDataDir(repoRoot, result.targetFile);
    const count = appendEntity(absolutePath, result.entity);

    ['type', 'site', 'category', 'id', 'name', 'targetFile', 'branch'].forEach((key) => setOutput(key, result[key]));
    setOutput('count', count);
    setOutput('success', 'true');

    console.log('Added ' + result.type + ' "' + result.name + '" to ' + result.targetFile + ' (' + count + ' entries).');
  } catch (error) {
    if (!(error instanceof ContributionError)) throw error;

    setOutput('success', 'false');
    setOutput('error', error.message);
    console.error('Rejected: ' + error.message);
  }
}

if (require.main === module) main();

module.exports = { appendEntity, resolveInsideDataDir, setOutput };
