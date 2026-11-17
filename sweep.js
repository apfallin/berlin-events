// Postponement/cancellation sweep for berlin-events.
// Reads index.html, finds events in the next WINDOW days that have an official
// link, fetches each page and checks the event's own status:
//  - keywords (verschoben/abgesagt/cancelled...) count only NEAR the event
//    title on the page (venue pages list many events);
//  - if the title is not on the page at all: soft "title-not-found" alert;
//  - unreachable pages (4xx / fetch errors) are flagged.
// Writes alerts.md for the weekly Vibe task (or Andrea) to review manually.
'use strict';
const fs = require('fs');

const WINDOW_DAYS = parseInt(process.env.SWEEP_WINDOW || '14', 10);
const TODAY = new Date();
TODAY.setUTCHours(0, 0, 0, 0);
const MAX = new Date(TODAY.getTime() + WINDOW_DAYS * 86400000);

const KEYWORDS = [
  'verschoben auf', 'verschoben', 'verlegt auf', 'ersatztermin', 'neuer termin',
  'findet nicht statt', 'abgesagt', 'cancelled', 'canceled', 'postponed', 'rescheduled'
];
const PROXIMITY = 300; // chars before/after a title occurrence to scan

function decodeEsc(s) { return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function norm(s) { return decodeEsc(s).toLowerCase().replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }

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

// Standalone-word check: reject keyword glued to a longer word (hideCancelledAppointments).
function standalone(text, kw, i) {
  const before = i > 0 ? text[i - 1] : ' ';
  const after = text[i + kw.length] || ' ';
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

function scanRegion(low, from, to) {
  const region = low.slice(Math.max(0, from), to);
  const hits = [];
  for (const kw of KEYWORDS) {
    let i = region.indexOf(kw);
    while (i !== -1) {
      const abs = Math.max(0, from) + i;
      if (standalone(low, kw, abs)) {
        const t = low.slice(Math.max(0, abs - 60), abs + kw.length + 80).replace(/\s+/g, ' ');
        hits.push({ kw, snippet: t });
        break; // one hit per keyword per region is enough
      }
      i = region.indexOf(kw, i + kw.length);
    }
  }
  return hits;
}

// Event-SPECIFIC page: URL points at this event (has /event/ etc. or a date in it).
// Only those get a "title-not-found" alert; generic venue/calendar pages never do
// (their titles are often JS-rendered or formatted differently - too noisy).
const STRICT_EVENT = /\/(event|events|veranstaltung|veranstaltungen|konzert|konzerte|show|shows|gig)s?\/|\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2}/;

function checkPage(ev, body) {
  const strict = STRICT_EVENT.test(ev.link);
  const low = norm(body);
  const candidates = [norm(ev.title)];
  const head = decodeEsc(ev.title).split(' + ')[0];
  if (norm(head) !== candidates[0]) candidates.push(norm(head));
  for (const cand of candidates) {
    if (!cand || cand.length < 4) continue;
    let pos = low.indexOf(cand);
    const found = pos !== -1;
    const hits = [];
    while (pos !== -1 && hits.length === 0) {
      hits.push(...scanRegion(low, pos - PROXIMITY, pos + cand.length + PROXIMITY));
      pos = low.indexOf(cand, pos + cand.length);
    }
    if (hits.length) return hits.map(h => ({ type: 'keyword: ' + h.kw, detail: h.snippet }));
    if (found) return []; // title on page, clean neighborhood
  }
  if (strict) return [{ type: 'title-not-found', detail: 'event title not on its own event page (removed or renamed?)' }];
  return []; // generic venue/calendar page without the title: stay silent
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 berlin-events-sweep/1.1', 'Accept': 'text/html,*/*' } });
  } finally { clearTimeout(t); }
}

async function check(ev) {
  const out = { ...ev, problems: [] };
  let res = null, body = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetchWithTimeout(ev.link, 20000);
      body = await res.text();
      break;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 3000)); }
  }
  if (!res) { out.problems.push({ type: 'fetch-error', detail: String(lastErr && lastErr.message || lastErr).slice(0, 120) }); return out; }
  if (res.status >= 400) { out.problems.push({ type: 'http-' + res.status, detail: 'page unreachable' }); return out; }
  out.problems.push(...checkPage(ev, body));
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
    alerts.length === 0 ? '**No alerts** - every linked event page reachable, titles present, no status keywords near the titles.' : `${alerts.length} alert(s) - verify each on the official page before changing data:`
  ];
  for (const a of alerts) {
    lines.push('', `- **${a.date} - ${a.title}** @${a.venue}  `, `  ${a.link}`);
    for (const p of a.problems) lines.push(`  - [${p.type}] ${p.detail}`);
  }
  lines.push('', '(keyword = reschedule/cancellation wording near the event title; title-not-found can be a JS-rendered page; always verify manually)', '');
  fs.writeFileSync('alerts.md', lines.join('\n'));
  console.log('alerts:', alerts.length);
})().catch(e => { console.error('SWEEP FAILED:', e.message); process.exit(1); });
