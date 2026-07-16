const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const body = process.env.ISSUE_BODY;
const issueNum = process.env.ISSUE_NUMBER;
const repo = 'accelerate-muj/campus-mapper';

const VALID_SITES = ['college', 'hostel'];
const VALID_TYPES = ['building', 'landmark', 'path'];
const VALID_BUILDING_CATEGORIES = ['academic', 'sports', 'dining', 'admin', 'other'];
const MUJ_BOUNDS = { latMin: 26.835, latMax: 26.855, lngMin: 75.555, lngMax: 75.575 };

function run(cmd) {
  console.log('> ' + cmd);
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    console.log('  ERROR: ' + (e.stderr || e.message).toString().slice(0, 500));
    return null;
  }
}

function comment(msg) {
  const tmpFile = '/tmp/_comment_' + Date.now() + '.md';
  fs.writeFileSync(tmpFile, msg);
  run('gh issue comment ' + issueNum + ' --body-file ' + tmpFile);
  try { fs.unlinkSync(tmpFile); } catch(e) {}
}

function fail(msg) {
  console.log('FAIL: ' + msg);
  comment('Could not process this contribution.\n\n**Reason:** ' + msg);
  process.exit(0);
}

function isValidCoord(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat > MUJ_BOUNDS.latMin && lat < MUJ_BOUNDS.latMax &&
    lng > MUJ_BOUNDS.lngMin && lng < MUJ_BOUNDS.lngMax;
}

function validateLandmark(d) {
  if (!d.name || typeof d.name !== 'string' || d.name.trim().length === 0) return 'Landmark missing `name`';
  if (!isValidCoord(d.lat, d.lng)) return 'Landmark coordinates out of MUJ campus bounds (' + d.lat + ', ' + d.lng + ')';
  if (d.entry !== null && d.entry !== undefined) {
    if (!d.entry.points || !Array.isArray(d.entry.points) || d.entry.points.length === 0)
      return 'Landmark entry must have a non-empty `points` array';
  }
  return null;
}

function validatePath(d) {
  if (!d.name || typeof d.name !== 'string' || d.name.trim().length === 0) return 'Path missing `name`';
  if (!d.points || !Array.isArray(d.points) || d.points.length < 2) return 'Path needs at least 2 points';
  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (!Array.isArray(p) || p.length !== 2) return 'Path point ' + i + ' must be [lat, lng]';
    if (!isValidCoord(p[0], p[1])) return 'Path point ' + i + ' out of MUJ campus bounds (' + p[0] + ', ' + p[1] + ')';
  }
  return null;
}

function validateBuilding(d) {
  if (!d.name || typeof d.name !== 'string' || d.name.trim().length === 0) return 'Building missing `name`';
  if (!d.points || !Array.isArray(d.points) || d.points.length < 3) return 'Building polygon needs at least 3 points';
  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (!Array.isArray(p) || p.length !== 2) return 'Building point ' + i + ' must be [lat, lng]';
    if (!isValidCoord(p[0], p[1])) return 'Building point ' + i + ' out of MUJ campus bounds';
  }
  return null;
}

function isAllowedFile(fp) {
  if (!fp.startsWith('data/')) return false;
  const parts = fp.split('/');
  if (parts.length < 3) return false;
  const site = parts[1];
  if (!VALID_SITES.includes(site)) return false;
  return true;
}

if (!body) { console.log('No issue body'); process.exit(0); }

const normalizedBody = body.replace(/\\n/g, '\n').replace(/\\r/g, '\r');

const typeMatch = normalizedBody.match(/\*\*Type:\*\*\s*(\w+)/);
const siteMatch = normalizedBody.match(/\*\*Site:\*\*\s*(\w+)/);
const catMatch = normalizedBody.match(/\*\*Category:\*\*\s*(\w+)/);
const fileMatch = normalizedBody.match(/\*\*File:\*\*\s*`([^`]+)`/);
const jsonMatch = normalizedBody.match(/```json\n([\s\S]*?)\n```/);

const type = typeMatch ? typeMatch[1].toLowerCase() : null;
const site = siteMatch ? siteMatch[1].toLowerCase() : 'college';
const category = catMatch ? catMatch[1].toLowerCase() : 'other';
const filePath = fileMatch ? fileMatch[1] : null;

console.log('type=' + type + ' site=' + site + ' category=' + category);

if (!type || !VALID_TYPES.includes(type)) {
  fail('Invalid type `' + (type || 'none') + '`. Must be: ' + VALID_TYPES.join(', '));
}
if (!VALID_SITES.includes(site)) {
  fail('Invalid site `' + site + '`. Must be: ' + VALID_SITES.join(', '));
}
if (type === 'building' && !VALID_BUILDING_CATEGORIES.includes(category)) {
  fail('Invalid building category `' + category + '`. Must be: ' + VALID_BUILDING_CATEGORIES.join(', '));
}
if (!jsonMatch) {
  fail('No JSON code block found in issue body.');
}

let data;
try { data = JSON.parse(jsonMatch[1]); } catch (e) {
  fail('Invalid JSON — ' + e.message);
}

let targetFile;
if (filePath) {
  if (!isAllowedFile(filePath)) {
    fail('File path `' + filePath + '` is not allowed. Must be under `data/<site>/`.');
  }
  targetFile = filePath;
} else if (type === 'building') {
  targetFile = 'data/' + site + '/buildings/' + category + '.json';
} else if (type === 'landmark') {
  targetFile = 'data/' + site + '/landmarks.json';
} else {
  targetFile = 'data/' + site + '/paths.json';
}

console.log('target=' + targetFile);

const validators = { landmark: validateLandmark, path: validatePath, building: validateBuilding };
const validationError = validators[type](data);
if (validationError) {
  fail(validationError);
}

if (!data.id) {
  data.id = type.substring(0, 2) + '_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  console.log('Auto-generated id=' + data.id);
}

let items = [];
if (fs.existsSync(targetFile)) {
  try { items = JSON.parse(fs.readFileSync(targetFile, 'utf8')); if (!Array.isArray(items)) items = []; }
  catch (e) { items = []; }
}

const duplicate = items.find(function(existing) {
  return existing.name && data.name && existing.name.toLowerCase() === data.name.toLowerCase();
});
if (duplicate) {
  fail('An item named `' + data.name + '` already exists in `' + targetFile + '`.');
}

items.push(data);
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(items, null, 2) + '\n');
console.log('Wrote ' + items.length + ' items to ' + targetFile);

const itemName = data.name || 'Unnamed';
let branch = 'contribution/' + type + '/' + itemName;
branch = branch.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').substring(0, 50);

run('git config user.name "github-actions[bot]"');
run('git config user.email "github-actions[bot]@users.noreply.github.com"');
run('git checkout -b ' + branch);
run('git add ' + targetFile);
run('git commit -m "Add ' + type + ': ' + itemName + ' (' + site + ')"');
run('git push origin ' + branch);

const prTitle = 'Add ' + type + ': ' + itemName + ' (Closes #' + issueNum + ')';
const prLink = 'https://github.com/' + repo + '/compare/main...' + branch + '?expand=1&title=' + encodeURIComponent(prTitle);

comment('Contribution processed!\n\n' +
  '- **Item:** ' + itemName + ' (' + type + ')\n' +
  '- **Site:** ' + site + '\n' +
  '- **File:** `' + targetFile + '`\n' +
  '- **Branch:** `' + branch + '`\n\n' +
  '[**Click here to create a Pull Request**](' + prLink + ')\n\n' +
  'The data is ready on the `' + branch + '` branch. You can create the PR yourself by clicking the link above — no need to wait for a maintainer.');

console.log('Done.');
