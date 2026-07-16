const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const body = process.env.ISSUE_BODY;
const issueNum = process.env.ISSUE_NUMBER;

function comment(msg) {
  try {
    const safe = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
    execSync('gh issue comment ' + issueNum + ' --body "' + safe + '"', { encoding: 'utf8' });
  } catch (e) {
    console.log('Failed to comment: ' + e.message);
  }
}

if (!body) {
  console.log('No issue body found');
  process.exit(0);
}

const typeMatch = body.match(/\*\*Type:\*\*\s*(\w+)/);
const siteMatch = body.match(/\*\*Site:\*\*\s*(\w+)/);
const catMatch = body.match(/\*\*Category:\*\*\s*(\w+)/);
const fileMatch = body.match(/\*\*File:\*\*\s*`([^`]+)`/);
const jsonMatch = body.match(/```json\n([\s\S]*?)\n```/);

const type = typeMatch ? typeMatch[1] : null;
const site = siteMatch ? siteMatch[1] : 'college';
const category = catMatch ? catMatch[1] : 'other';
const filePath = fileMatch ? fileMatch[1] : null;

console.log('Parsed type=' + type + ' site=' + site + ' category=' + category + ' filePath=' + filePath);

if (!type || !['building', 'landmark', 'path'].includes(type)) {
  console.log('Invalid or missing type: ' + type);
  comment('Could not process this contribution. Invalid or missing type: `' + (type || 'none') + '`.');
  process.exit(0);
}

if (!jsonMatch) {
  console.log('No JSON found in issue body');
  comment('Could not process this contribution. No JSON code block found.');
  process.exit(0);
}

let data;
try {
  data = JSON.parse(jsonMatch[1]);
} catch (e) {
  console.log('Invalid JSON: ' + e.message);
  comment('Could not process this contribution. Invalid JSON: ' + e.message);
  process.exit(0);
}

let targetFile;
if (filePath) {
  targetFile = filePath;
} else if (type === 'building') {
  targetFile = 'data/' + site + '/buildings/' + category + '.json';
} else if (type === 'landmark') {
  targetFile = 'data/' + site + '/landmarks.json';
} else {
  targetFile = 'data/' + site + '/paths.json';
}

console.log('Target file: ' + targetFile);

let items = [];
if (fs.existsSync(targetFile)) {
  try {
    items = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    if (!Array.isArray(items)) items = [];
  } catch (e) {
    items = [];
  }
}

items.push(data);
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(items, null, 2) + '\n');
console.log('Wrote ' + items.length + ' items to ' + targetFile);

const itemName = data.name || 'Unnamed';
let branch = 'contribution/' + type + '/' + itemName;
branch = branch.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').substring(0, 50);

const git = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: 'inherit' });
git('git config user.name "github-actions[bot]"');
git('git config user.email "github-actions[bot]@users.noreply.github.com"');
git('git checkout -b ' + branch);
git('git add ' + targetFile);
git('git commit -m "Add ' + type + ': ' + itemName + ' (' + site + ')"');
git('git push origin ' + branch);

const prTitle = 'Add ' + type + ': ' + itemName;
const prBody = 'Automated PR from issue #' + issueNum + '.\n\nAdds **' + itemName + '** to `' + targetFile + '`.\n\nCloses #' + issueNum;
git('gh pr create --title "' + prTitle.replace(/"/g, '\\"') + '" --body "' + prBody.replace(/"/g, '\\"') + '" --head ' + branch + ' --base main');

comment('Contribution processed!\n\n- **Item:** ' + itemName + ' (' + type + ')\n- **File:** `' + targetFile + '`\n- **Branch:** `' + branch + '`\n\nA pull request has been created automatically. Maintainer will review and merge.');
console.log('Done.');
