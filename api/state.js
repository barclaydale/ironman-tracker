import { store } from './_lib/store.js';
import { requireEditor } from './_lib/auth.js';

// GET    /api/state              -> { events }      list of events (public)
// GET    /api/state?event=<id>   -> { state }       one event's training data (public)
// PUT    /api/state              { events }         replace the event list (passcode)
// PUT    /api/state?event=<id>   { state }          replace one event's data (passcode)
// DELETE /api/state?event=<id>                      delete one event's data (passcode)

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 900_000; // stay under Upstash's 1 MB request limit

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    const id = req.query.event;
    if (id != null && !ID.test(id)) return res.status(400).json({ error: 'Bad event id' });
    const key = id ? `event:${id}` : 'events';
    const db = await store();

    if (req.method === 'GET') {
      const doc = await db.get(key);
      return res
        .status(200)
        .json(id ? { state: doc?.state ?? null, updatedAt: doc?.updatedAt ?? null } : { events: doc?.events ?? null, updatedAt: doc?.updatedAt ?? null });
    }

    if (!requireEditor(req, res)) return;

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const updatedAt = new Date().toISOString();
      if (id) {
        if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state))
          return res.status(400).json({ error: 'Expected { state: {...} }' });
        if (JSON.stringify(body.state).length > MAX_BYTES) return res.status(413).json({ error: 'State too large' });
        await db.set(key, { state: body.state, updatedAt });
      } else {
        const ok =
          Array.isArray(body.events) &&
          body.events.length > 0 &&
          body.events.every((e) => e && ID.test(e.id) && typeof e.name === 'string' && DATE.test(e.raceDate) && DATE.test(e.startDate));
        if (!ok) return res.status(400).json({ error: 'Expected { events: [{ id, name, raceDate, startDate, ... }] }' });
        await db.set(key, { events: body.events, updatedAt });
      }
      return res.status(200).json({ ok: true, updatedAt });
    }

    if (req.method === 'DELETE' && id) {
      await db.del(key);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
