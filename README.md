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

**Brand styling** is captured once in the in-app **Brand kit** flow:
- up to 4 sample images → sent as Quiver `references`
- palette + style choices → compiled into the Quiver `instructions` string

Both ride along with every prompt automatically, so client prompts stay short and on-brand.

## Run locally

```bash
npm install
export QUIVERAI_API_KEY="sk_live_..."   # never commit this
npm start                               # http://localhost:3000
```

## Deploy to Railway

1. Push this folder to a repo and create a Railway service from it.
2. Add a service variable `QUIVERAI_API_KEY` = your Quiver key.
3. Deploy. Railway runs `npm start` and serves on its assigned `PORT` automatically.

Optional variables: `QUIVER_MODEL` (default `arrow-1.1`), `MAX_IMAGES` (default `5`).

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
- **Brand kit storage:** saved in the browser's `localStorage`, with Export/Import for portability.
  For a shared/multi-user client, promote this to a Postgres row or a baked `brand.json` the server
  serves — the kit is already a plain JSON object, so it's a small change.
- **Security:** SVGs returned by the API are rendered inside sandboxed iframes, so any stray markup
  can't touch the page. The key only ever lives in server env.

## Files

```
server.js            Express proxy + static host + rate-limit backoff
public/index.html    The whole app (UI, brand-kit flow, generate) + THEME block
package.json
.env.example
```
