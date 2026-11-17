// Postponement/cancellation sweep for berlin-events.
// Reads index.html, finds events in the next WINDOW days that have an official
// link, fetches each page and scans it for reschedule/cancellation keywords.
// Writes alerts.md for the weekly Vibe task (or Andrea) to review manually.
'use strict';
const fs = require('fs');

const WINDOW_DAYS = parseInt(process.env.SWEEP_WINDOW || '14', 10);
const TODAY = new Date();
TODAY.setUTCHours(0, 0, 0, 0);
const MAX = new Date(TODAY.getTime() + WINDOW_DAYS * 86400000);

const KEYWORDS = [
  'verschoben auf', 'verschoben', 'verlegt auf', 'verschoben.',
  'abgesagt', 'ersatztermin', 'neuer termin', 'findet nicht statt',
  'cancelled', 'canceled', 'postponed', 'rescheduled'
];

function parseEvents(html) {
  const m = html.match(/const EVENTS = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error('EVENTS block not found');
  const rows = [];
  for (const line of m[1].split('\n')) {
    if (!/^\s*\{ date: "/.test(line)) continue;
    const f = (name) => {
      const r = line.match(new RegExp(name + ': "([^"]*)"'));
      return r ? r[1] : null;
    };
    rows.push({ date: f('date'), title: f('title'), venue: f('venue'), link: f('link') });
  }
  return rows;
}

function inWindow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return !isNaN(d) && d >= TODAY && d <= MAX;
}

function scan(text) {
  const low = text.toLowerCase();
  const hits = [];
  for (const kw of KEYWORDS) {
    const i = low.indexOf(kw);
    if (i !== -1) hits.push({ kw, snippet: text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' ').trim() });
  }
  return hits;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 berlin-events-sweep/1.0', 'Accept': 'text/html,*/*' } });
  } finally { clearTimeout(t); }
}

async function check(ev) {
  const out = { ...ev, problems: [] };
  let res = null, body = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await fetchWithTimeout(ev.link, 20000);
      body = await res.text();
      break;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 3000)); }
  }
  if (!res) { out.problems.push({ type: 'fetch-error', detail: String(lastErr && lastErr.message || lastErr).slice(0, 120) }); return out; }
  if (res.status >= 400) { out.problems.push({ type: 'http-' + res.status, detail: 'page unreachable' }); return out; }
  for (const h of scan(body)) out.problems.push({ type: 'keyword: ' + h.kw, detail: h.snippet });
  return out;
}

(async () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const rows = parseEvents(html);
  const linked = rows.filter(r => r.link && /^https?:\/\//.test(r.link) && inWindow(r.date));
  const unlinked = rows.filter(r => !(r.link && /^https?:\/\//.test(r.link)) && inWindow(r.date));
  const targets = linked;
  console.log(`events total: ${rows.length}, with link in next ${WINDOW_DAYS} days: ${targets.length} (unlinked, not checked: ${unlinked.length})`);
  const alerts = [];
  const CONC = 8;
  for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    const results = await Promise.all(batch.map(check));
    for (const r of results) if (r.problems.length) alerts.push(r);
  }
  alerts.sort((a, b) => (a.date < b.date ? -1 : 1));
  const lines = [
    '# Postponement / cancellation sweep',
    '',
    `Run: ${new Date().toISOString()} | window: next ${WINDOW_DAYS} days | checked: ${targets.length} linked events | not checked (no link): ${unlinked.length}`,
    '',
    alerts.length === 0 ? '**No alerts** - no keyword hits, no unreachable pages.' : `${alerts.length} alert(s) - verify each on the official page before changing data:`
  ];
  for (const a of alerts) {
    lines.push('', `- **${a.date} - ${a.title}** @${a.venue}  `, `  ${a.link}`);
    for (const p of a.problems) lines.push(`  - [${p.type}] ${p.detail}`);
  }
  lines.push('', '(Keywords like "verschoben/abgesagt" can appear for OTHER events listed on the same page - always verify.)', '');
  fs.writeFileSync('alerts.md', lines.join('\n'));
  console.log('alerts:', alerts.length);
})().catch(e => { console.error('SWEEP FAILED:', e.message); process.exit(1); });
