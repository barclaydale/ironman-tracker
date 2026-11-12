import { createHash, timingSafeEqual } from 'node:crypto';

// One shared edit passcode (EDIT_PASSCODE env var). Reads are public.
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();

export function passcodeOk(given) {
  const want = process.env.EDIT_PASSCODE;
  return !!want && timingSafeEqual(digest(given), digest(want));
}

// Sends the error response and returns false when the caller can't edit
export function requireEditor(req, res) {
  if (!process.env.EDIT_PASSCODE) {
    res.status(500).json({ error: 'EDIT_PASSCODE is not set on the server' });
    return false;
  }
  if (!passcodeOk(req.headers['x-edit-passcode'])) {
    res.status(401).json({ error: 'Passcode required' });
    return false;
  }
  return true;
}
