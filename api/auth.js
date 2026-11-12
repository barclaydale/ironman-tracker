import { passcodeOk } from './_lib/auth.js';

// POST /api/auth { passcode } -> 200 when it unlocks editing, 401 otherwise
export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.EDIT_PASSCODE) return res.status(500).json({ error: 'EDIT_PASSCODE is not set on the server' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (passcodeOk(body.passcode)) return res.status(200).json({ ok: true });
  await new Promise((r) => setTimeout(r, 600)); // slow down guessing
  return res.status(401).json({ error: 'Wrong passcode' });
}
