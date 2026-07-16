const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const body = process.env.ISSUE_BODY;
const issueNum = process.env.ISSUE_NUMBER;

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
  run('gh issue comment ' + issueNum + ' --body "' +
    msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"');
}

if (!body) { console.log('No issue body'); process.exit(0); }

const normalizedBody = body.replace(/\\n/g, '\n').replace(/\\r/g, '\r');

const typeMatch = normalizedBody.match(/\*\*Type:\*\*\s*(\w+)/);
const siteMatch = normalizedBody.match(/\*\*Site:\*\*\s*(\w+)/);
const catMatch = normalizedBody.match(/\*\*Category:\*\*\s*(\w+)/);
const fileMatch = normalizedBody.match(/\*\*File:\*\*\s*`([^`]+)`/);
const jsonMatch = normalizedBody.match(/```json\n([\s\S]*?)\n```/);

const type = typeMatch ? typeMatch[1] : null;
const site = siteMatch ? siteMatch[1] : 'college';
const category = catMatch ? catMatch[1] : 'other';
const filePath = fileMatch ? fileMatch[1] : null;

console.log('type=' + type + ' site=' + site + ' category=' + category);

if (!type || !['building', 'landmark', 'path'].includes(type)) {
  comment('Could not process: invalid type `' + (type || 'none') + '`.');
  process.exit(0);
}
if (!jsonMatch) {
  comment('Could not process: no JSON code block found.');
  process.exit(0);
}

let data;
try { data = JSON.parse(jsonMatch[1]); } catch (e) {
  comment('Could not process: invalid JSON — ' + e.message);
  process.exit(0);
}

let targetFile = filePath ||
  (type === 'building' ? 'data/' + site + '/buildings/' + category + '.json' :
   type === 'landmark' ? 'data/' + site + '/landmarks.json' :
   'data/' + site + '/paths.json');

console.log('target=' + targetFile);

let items = [];
if (fs.existsSync(targetFile)) {
  try { items = JSON.parse(fs.readFileSync(targetFile, 'utf8')); if (!Array.isArray(items)) items = []; }
  catch (e) { items = []; }
}

items.push(data);
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(items, null, 2) + '\n');
console.log('Wrote ' + items.length + ' items to ' + targetFile);

const itemName = data.name || 'Unnamed';
const commitMsg = 'Add ' + type + ': ' + itemName + ' (' + site + ')';

run('git config user.name "github-actions[bot]"');
run('git config user.email "github-actions[bot]@users.noreply.github.com"');
run('git add ' + targetFile);
run('git commit -m "' + commitMsg + '"');
run('git push origin main');

const itemNameClean = itemName.replace(/"/g, '\\"');
comment('Contribution processed!\n\n- **Item:** ' + itemName + ' (' + type + ')\n- **File:** `' + targetFile + '`\n\nMerged to `main` automatically. Check the updated map!');

console.log('Done.');
