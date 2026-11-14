import { store } from './_lib/store.js';
import { requireEditor } from './_lib/auth.js';

// GET    /api/calendar?event=<id>   -> text/calendar feed (public; subscribe to it in Google Calendar)
// PUT    /api/calendar?event=<id>   { sessions }   replace the schedule copy (passcode)
// DELETE /api/calendar?event=<id>                  delete it (passcode)
//
// The plan itself lives in the page, so the page uploads a plain-text copy of the
// schedule ({ id, date, title, desc, done, log }) whenever it changes.

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 900_000;
const MAX_SESSIONS = 2000;

export default async function handler(req, res) {
  try {
    const id = req.query.event;
    if (!id || !ID.test(id)) return res.status(400).json({ error: 'Bad event id' });
    const key = `calendar:${id}`;
    const db = await store();

    if (req.method === 'GET') {
      const [list, doc] = await Promise.all([db.get('events'), db.get(key)]);
      const ev = (list?.events || []).find((e) => e.id === id);
      if (!ev) return res.status(404).json({ error: 'No such event' });
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
      const site = `${proto}://${host}/#event=${encodeURIComponent(id)}`;
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.setHeader('content-disposition', `inline; filename="${id}.ics"`);
      res.setHeader('cache-control', 'public, max-age=300');
      res.statusCode = 200;
      return res.end(buildIcs(ev, doc, site));
    }

    res.setHeader('cache-control', 'no-store');
    if (!requireEditor(req, res)) return;

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const ok =
        Array.isArray(body.sessions) &&
        body.sessions.length <= MAX_SESSIONS &&
        body.sessions.every((s) => s && typeof s.id === 'string' && DATE.test(s.date) && typeof s.title === 'string');
      if (!ok) return res.status(400).json({ error: 'Expected { sessions: [{ id, date, title, ... }] }' });
      if (JSON.stringify(body.sessions).length > MAX_BYTES) return res.status(413).json({ error: 'Calendar too large' });
      const updatedAt = new Date().toISOString();
      await db.set(key, { sessions: body.sessions, updatedAt });
      return res.status(200).json({ ok: true, updatedAt });
    }

    if (req.method === 'DELETE') {
      await db.del(key);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function buildIcs(ev, doc, site) {
  const stamp = icsStamp(doc?.updatedAt || new Date().toISOString());
  // Before the page has uploaded a schedule, the feed still shows race day
  const sessions = doc?.sessions?.length
    ? doc.sessions
    : [{ id: 'race-day', date: ev.raceDate, title: ev.name, desc: ev.location || '' }];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Training Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(ev.name)} training`,
    // Hints for Apple/Outlook; Google refreshes on its own schedule
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const s of sessions) {
    if (!DATE.test(s.date)) continue;
    const isRace = s.id === 'race-day';
    const summary = (s.done ? '✓ ' : '') + (isRace ? '🏁 ' : '') + String(s.title);
    const desc = [s.done && s.log ? 'Done: ' + s.log : s.done ? 'Done' : '', String(s.desc || ''), site]
      .filter(Boolean)
      .join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsText(s.id)}@${ev.id}.training-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${s.date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${nextDay(s.date)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(desc)}`,
      `URL:${site}`,
      'TRANSP:TRANSPARENT', // all-day workouts shouldn't mark you busy
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function nextDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
// RFC 5545: lines over 75 octets continue on the next line after a space
function fold(line) {
  const out = [];
  let cur = '',
    bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
