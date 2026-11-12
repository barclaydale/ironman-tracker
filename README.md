# Training Tracker

Training calendar and log for multiple events (IRONMAN Florida 2026 and beyond).
Static page + two Vercel functions; data is saved per event in Upstash Redis.

## Deploy on Vercel

1. Import this GitHub repo into Vercel (Framework preset: **Other**, no build command).
2. **Storage → Marketplace → Upstash (Redis)** → create a free database and connect it
   to the project. This adds `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically.
3. **Settings → Environment Variables** → add `EDIT_PASSCODE` (your edit password).
4. Redeploy so the new variables take effect.

Anyone with the link can view; editing needs the passcode (sidebar → **Unlock**,
remembered per device).

## Moving existing data in

On the old site (or wherever your data lives): **Export**. On the Vercel site:
open the sidebar, **Unlock**, then **Import** and pick the exported
`*-raw-data.json` (or the whole `.zip`). The file knows which event it belongs to.

## Local development

```sh
npm install
npm run dev        # http://localhost:3000, passcode "dev", in-memory storage
```

Opening `ironman-training-calendar.html` directly from disk also works; it then
saves to the browser only.

## Files

- `ironman-training-calendar.html` – the app (IMFL 2026 coached plan + event layer)
- `app-shell.js` – event sidebar, cloud sync, passcode lock, import
- `training-export.js` – Export button (JSON + PDF report + Excel)
- `api/state.js`, `api/auth.js` – storage + passcode check
