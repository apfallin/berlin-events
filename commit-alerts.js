// Commit alerts.md via the GitHub contents API (no git push, cf. cryptpad-cache commit.js).
'use strict';
const fs = require('fs');
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = 'main';
const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'berlin-events-sweep-bot'
};
(async () => {
  const content = fs.readFileSync('alerts.md', 'utf8');
  const api = (path, opts) => fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, opts);
  let r = await api('alerts.md', { headers, method: 'GET' });
  const body = JSON.stringify({
    message: 'Postponement sweep ' + new Date().toISOString(),
    branch: BRANCH,
    content: Buffer.from(content, 'utf8').toString('base64')
  });
  if (r.status === 200) {
    const cur = await r.json();
    const existing = Buffer.from(cur.content || '', cur.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    if (existing === content) { console.log('alerts.md unchanged'); return; }
    r = await api('alerts.md', { headers: { ...headers, 'Content-Type': 'application/json' }, method: 'PUT', body: JSON.stringify({ ...body, sha: cur.sha }) });
  } else if (r.status === 404) {
    r = await api('alerts.md', { headers: { ...headers, 'Content-Type': 'application/json' }, method: 'PUT', body });
  } else {
    throw new Error('GET alerts.md -> ' + r.status);
  }
  if (r.status >= 300) throw new Error('PUT alerts.md -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  console.log('alerts.md updated');
})().catch(e => { console.error('COMMIT FAILED:', e.message); process.exit(1); });
