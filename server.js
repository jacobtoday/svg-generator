/**
 * Vector Studio — secure backend proxy for the Quiver SVG API,
 * with a Postgres-persisted brand kit applied server-side.
 *
 * The Quiver API key NEVER reaches the browser. End users call /api/generate
 * with just a prompt; the server attaches the saved brand style and forwards
 * to https://api.quiver.ai.
 *
 * Required env:
 *   QUIVERAI_API_KEY   your sk_live_... key (server-side only)
 * For brand-kit persistence:
 *   DATABASE_URL       Postgres connection string (Railway provides this)
 * Optional:
 *   PORT (default 3000), QUIVER_MODEL (arrow-1.1), MAX_IMAGES (5)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = global.__TEST_PG__ || require("pg"); // __TEST_PG__ lets tests inject pg-mem

const app = express();
app.use(express.json({ limit: "25mb" })); // base64 reference images can be large

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.QUIVERAI_API_KEY;
const QUIVER_BASE = "https://api.quiver.ai/v1";
const DEFAULT_MODEL = process.env.QUIVER_MODEL || "arrow-1.1";
const MAX_IMAGES = clampInt(process.env.MAX_IMAGES, 5, 1, 16);
const KIT_ID = "default"; // one kit per deploy

if (!API_KEY) console.warn("[warn] QUIVERAI_API_KEY is not set. /api/generate returns 503 until configured.");

/* ------------------------------------------------------------------ *
 * Postgres — single-row brand kit store. Degrades gracefully if there
 * is no DATABASE_URL (generation still works, just without a saved kit).
 * ------------------------------------------------------------------ */
const pool = makePool(process.env.DATABASE_URL);
let dbReady = initDb();

function makePool(url) {
  if (!url) return null;
  // Railway's internal network and localhost don't use SSL; public hosts do.
  const internal = /localhost|127\.0\.0\.1|railway\.internal/.test(url);
  return new Pool({
    connectionString: url,
    ssl: internal ? false : { rejectUnauthorized: false },
  });
}

async function initDb() {
  if (!pool) {
    console.warn("[warn] DATABASE_URL not set — brand kit persistence is disabled.");
    return false;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brand_kits (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    console.log("[ok] Brand kit table ready.");
    return true;
  } catch (err) {
    console.error("[error] Could not initialise Postgres:", err.message);
    return false;
  }
}

async function getKit() {
  if (!pool) return null;
  try {
    await dbReady;
    const { rows } = await pool.query("SELECT data FROM brand_kits WHERE id = $1", [KIT_ID]);
    return rows.length ? rows[0].data : null;
  } catch (err) {
    console.error("[error] getKit:", err.message);
    return null;
  }
}

async function saveKit(data) {
  if (!pool) throw new Error("no_db");
  await dbReady;
  await pool.query(
    `INSERT INTO brand_kits (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
    [KIT_ID, data]
  );
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */
const RL_MAX = 18;
const RL_WINDOW_MS = 60000;
let rlHits = [];
function rateLimitOk() {
  const now = Date.now();
  rlHits = rlHits.filter((t) => now - t < RL_WINDOW_MS);
  if (rlHits.length >= RL_MAX) return false;
  rlHits.push(now);
  return true;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripData = (s) => {
  const i = (s || "").indexOf(",");
  return i >= 0 ? s.slice(i + 1) : s;
};

async function quiver(pathname, { method = "GET", body } = {}, attempt = 0) {
  const res = await fetch(`${QUIVER_BASE}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
    const waitMs = Number.isNaN(retryAfter) ? 800 * 2 ** attempt : retryAfter * 1000;
    await sleep(waitMs);
    return quiver(pathname, { method, body }, attempt + 1);
  }
  return res;
}

function normalizeError(data, status) {
  const code = data && data.code;
  const map = {
    invalid_request: "Something about that request wasn't valid. Adjust and try again.",
    invalid_api_key: "The image service rejected the server's credentials.",
    unauthorized: "The image service rejected the server's credentials.",
    insufficient_credits: "This account is out of image credits. Top up to continue.",
    account_frozen: "The image account is frozen and can't create images right now.",
    model_not_found: "That image model isn't available.",
    rate_limit_exceeded: "The image service is busy. Wait a moment and try again.",
    weekly_limit_exceeded: "Weekly image limit reached for this account.",
    upstream_error: "The image service had a problem. Try again shortly.",
    internal_error: "The image service had a problem. Try again shortly.",
  };
  return { error: map[code] || (data && data.message) || "The image service returned an error.", code: code || undefined, status };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
app.get("/api/config", (req, res) => {
  res.json({
    ready: Boolean(API_KEY),
    defaultModel: DEFAULT_MODEL,
    maxImages: MAX_IMAGES,
    persistence: Boolean(pool),
  });
});

app.get("/api/models", async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: "Server is missing its API key." });
  try {
    const r = await quiver("/models");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(normalizeError(data, r.status));
    res.json(data);
  } catch {
    res.status(502).json({ error: "Could not reach the image service." });
  }
});

/* Public: just enough for the "kit active" chip — no images, no style leaked. */
app.get("/api/brand/status", async (req, res) => {
  const kit = await getKit();
  res.json({ exists: Boolean(kit), name: (kit && kit.name) || "" });
});

/* Load the full kit for editing. */
app.get("/api/brand", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Persistence is disabled. Set DATABASE_URL and redeploy." });
  const kit = await getKit();
  res.json({ kit: kit || null });
});

/* Save the kit. */
app.put("/api/brand", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Persistence is disabled. Set DATABASE_URL and redeploy." });
  const kit = req.body && req.body.kit;
  if (!kit || typeof kit !== "object") {
    return res.status(400).json({ error: "Missing brand kit data." });
  }
  try {
    await saveKit(kit);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Couldn't save the brand kit." });
  }
});

/* Generate 1–5 SVGs. Public callers get the stored brand style applied
 * server-side. The brand editor may pass preview instructions/references to test an
 * unsaved kit. */
app.post("/api/generate", async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ error: "Server is missing its API key. Set QUIVERAI_API_KEY and redeploy." });
  }
  const { prompt, n = 1, model = DEFAULT_MODEL, preview, instructions: pvInstructions, references: pvReferences } = req.body || {};

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return res.status(400).json({ error: "Add a description of what you want to create." });
  }
  if (!rateLimitOk()) {
    return res.status(429).json({ error: "Lots of requests right now. Wait a few seconds and try again." });
  }

  const count = clampInt(n, 1, 1, MAX_IMAGES);
  const payload = { model, prompt: prompt.trim(), n: count, stream: false };

  // A preview request (the brand editor's test mark) uses the inline kit being
  // edited; everyone else gets the saved kit applied server-side.
  if (preview) {
    if (pvInstructions && String(pvInstructions).trim()) payload.instructions = String(pvInstructions).trim();
    if (Array.isArray(pvReferences) && pvReferences.length) payload.references = pvReferences.slice(0, 4);
  } else {
    const kit = await getKit();
    if (kit) {
      if (kit.instructions && String(kit.instructions).trim()) payload.instructions = String(kit.instructions).trim();
      if (Array.isArray(kit.refs) && kit.refs.length) {
        payload.references = kit.refs.slice(0, 4).map((r) => ({ base64: stripData(r.data) }));
      }
    }
  }

  try {
    const r = await quiver("/svgs/generations", { method: "POST", body: payload });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(normalizeError(data, r.status));
    res.json({ id: data.id, credits: data.credits, images: (data.data || []).map((d) => d.svg).filter(Boolean) });
  } catch {
    res.status(502).json({ error: "Could not reach the image service. Try again." });
  }
});

/* ------------------------------------------------------------------ *
 * Frontend
 * ------------------------------------------------------------------ */
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX = fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
  ? path.join(PUBLIC_DIR, "index.html")
  : path.join(__dirname, "index.html");

if (!fs.existsSync(INDEX)) {
  console.error("[error] index.html not found in ./public or the project root. The page will 404 until it's added.");
} else {
  console.log("[ok] Serving frontend from " + INDEX);
}

app.use(express.static(PUBLIC_DIR));
app.get("*", (req, res) => {
  res.sendFile(INDEX, (err) => {
    if (err) res.status(404).send("Frontend not found. index.html is missing from this deploy.");
  });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Vector Studio running on http://localhost:${PORT}`));
}

module.exports = { app, dbReady: () => dbReady };
