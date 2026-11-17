// Commit alerts.md via the GitHub contents API (no git push, cf. cryptpad-cache commit.js).
// Retries each API call - transient runner network errors must not fail the sweep.
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path, opts, tries) {
  let lastErr = null;
  for (let i = 1; i <= (tries || 3); i++) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, opts);
      return r;
    } catch (e) {
      lastErr = e;
      console.log(`api call ${path} attempt ${i} failed: ${e.message}`);
      await sleep(3000 * i);
    }
  }
  throw lastErr;
}

(async () => {
  const content = fs.readFileSync('alerts.md', 'utf8');
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const base = { message: 'Postponement sweep ' + new Date().toISOString(), branch: BRANCH, content: b64 };

  let r = await api('alerts.md', { headers, method: 'GET' }, 4);
  if (r.status === 200) {
    const cur = await r.json();
    const existing = Buffer.from(cur.content || '', cur.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    if (existing === content) { console.log('alerts.md unchanged'); return; }
    r = await api('alerts.md', { headers: { ...headers, 'Content-Type': 'application/json' }, method: 'PUT', body: JSON.stringify({ ...base, sha: cur.sha }) }, 3);
  } else if (r.status === 404) {
    r = await api('alerts.md', { headers: { ...headers, 'Content-Type': 'application/json' }, method: 'PUT', body: JSON.stringify(base) }, 3);
  } else {
    throw new Error('GET alerts.md -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  }
  if (r.status >= 300) throw new Error('PUT alerts.md -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
  console.log('alerts.md updated (status ' + r.status + ')');
})().catch(e => { console.error('COMMIT FAILED:', e.message); process.exit(1); });
