# Vector Studio

A white-label tool that turns a text prompt into 1–5 brand-styled SVGs, powered by the
[Quiver API](https://docs.quiver.ai). Built to be reskinned and deployed once per client.

## How it works

```
Browser ──▶  /api/generate (your server)  ──▶  api.quiver.ai
                 │ holds QUIVERAI_API_KEY
                 │ clamps n to 1–5, attaches brand style, handles rate limits
```

The browser never sees the API key. It calls your own `/api/*` routes; the server attaches the
bearer token and forwards to Quiver.

**Brand styling** is captured once in the in-app **Brand kit** flow (admin-only):
- up to 4 sample images → sent as Quiver `references`
- palette + style choices → compiled into the Quiver `instructions` string

The kit is stored in Postgres and applied **server-side** on every generation, so end
users only send a prompt — they can't see or change the brand style. Editing the kit
requires `ADMIN_TOKEN`.

## Run locally

```bash
npm install
export QUIVERAI_API_KEY="sk_live_..."   # never commit this
export DATABASE_URL="postgresql://..."  # optional; enables saving the brand kit
export ADMIN_TOKEN="a-long-random-string"
npm start                               # http://localhost:3000
```

## Deploy to Railway

1. Push this folder to a repo and create a Railway service from it.
2. **Add a Postgres database** to the project (New → Database → PostgreSQL). Railway
   exposes its connection string as `DATABASE_URL`.
3. On the app service, add variables:
   - `QUIVERAI_API_KEY` = your Quiver key
   - `DATABASE_URL` = reference the Postgres service's `DATABASE_URL`
   - `ADMIN_TOKEN` = a long random string (your brand-kit password)
4. Deploy. On boot the server creates the `brand_kits` table automatically.
5. Settings → Networking → Generate Domain.

The table is created on first boot — no migration step needed.

## Reskin for a new client (the whole job)

Edit one block at the top of `public/index.html`:

```js
window.THEME = {
  brandName: "Acme Co.",
  logoUrl: "https://.../acme-logo.svg",  // or "" to use the wordmark
  tagline: "On-brand graphics in seconds",
  accent: "#E2552B",                     // the one colour that defines the skin
  accentInk: "#FFFFFF",
};
```

Then give that client their own deploy with their own `QUIVERAI_API_KEY`. One deploy per client
keeps each one inside their own Quiver rate limit (20 req/60s is **per organisation**) and bills
to their own account.

## Notes worth knowing

- **Billing:** Quiver charges `n × svg_generate` credits per generation, so 5 images costs 5×.
  Surface this to clients if they're cost-sensitive.
- **Rate limit:** 20 requests / 60s per Quiver org. The server keeps a soft cap (18/60s) and backs
  off on 429s. If you ever run many server instances behind one key, move that limiter to Redis.
- **Brand kit storage:** saved in Postgres (`brand_kits` table, one `default` row) and
  applied server-side. Export/Import JSON is still available in the editor for backups or
  moving a kit between deploys.
- **Security:** SVGs returned by the API are rendered inside sandboxed iframes, so any stray markup
  can't touch the page. The key only ever lives in server env.

## Files

```
server.js            Express proxy + Postgres brand kit + static host
public/index.html    The whole app (UI, admin brand-kit editor, generate) + THEME block
package.json
.env.example
```
