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

The kit is stored in Postgres and applied **server-side** on every generation, so end
users only send a prompt. The Brand kit editor is open (no login).

## Deploy on Railway (dashboard + GitHub website — no terminal)

1. In **GitHub**, create a repo and upload these files (keep `index.html` inside a
   `public/` folder). Use the repo's **Add file → Upload files** button.
2. In **Railway**, New Project → **Deploy from GitHub repo** → pick the repo.
3. Add a **PostgreSQL** database: in the project, **New → Database → PostgreSQL**.
   Railway sets `DATABASE_URL` automatically.
4. On the app service → **Variables**, add:
   - `QUIVERAI_API_KEY` = your Quiver key
   - `DATABASE_URL` = reference the Postgres service's `DATABASE_URL` variable
5. **Settings → Networking → Generate Domain.**

The `brand_kits` table is created automatically on first boot — no migration step.

## Reskin for a new client (the whole job)

Edit one block at the top of `public/index.html` (do it in the GitHub website — open the
file, click the pencil ✏️, change these lines, Commit):

```js
window.THEME = {
  brandName: "Acme Co.",
  logoUrl: "https://.../acme-logo.svg",  // or "" to use the wordmark
  tagline: "On-brand graphics in seconds",
  accent: "#E2552B",                     // the one colour that defines the skin
  accentInk: "#FFFFFF",
};
```

For each client, duplicate the repo and give it its own Railway project with its own
`QUIVERAI_API_KEY`. One project per client keeps each inside their own Quiver rate limit
(20 req/60s is **per organisation**) and bills to their own account.

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
public/index.html    The whole app (UI, brand-kit editor, generate) + THEME block
package.json
.env.example
```
