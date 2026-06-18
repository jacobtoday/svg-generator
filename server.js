/**
 * Vector Studio — secure backend proxy for the Quiver SVG API.
 *
 * The Quiver API key NEVER reaches the browser. The frontend talks only to
 * this server's /api/* routes; this server attaches the bearer token and
 * forwards to https://api.quiver.ai.
 *
 * Required env:
 *   QUIVERAI_API_KEY   your sk_live_... key (server-side only)
 * Optional env:
 *   PORT               default 3000
 *   QUIVER_MODEL       default model id, default "arrow-1.1"
 *   MAX_IMAGES         hard ceiling on images per request, default 5
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "25mb" })); // base64 reference images can be large

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.QUIVERAI_API_KEY;
const QUIVER_BASE = "https://api.quiver.ai/v1";
const DEFAULT_MODEL = process.env.QUIVER_MODEL || "arrow-1.1";
const MAX_IMAGES = clampInt(process.env.MAX_IMAGES, 5, 1, 16);

if (!API_KEY) {
  console.warn(
    "[warn] QUIVERAI_API_KEY is not set. /api/generate will return 503 until it is configured."
  );
}

/* ------------------------------------------------------------------ *
 * Soft rate limiter
 * Quiver allows 20 requests / 60s per ORGANISATION. We keep a small
 * margin so a burst of clients doesn't trip 429s. This is a single
 * in-process token bucket — fine for one-deploy-per-client. If you run
 * many workers behind one key, move this to Redis.
 * ------------------------------------------------------------------ */
const RL_MAX = 18;
const RL_WINDOW_MS = 60_000;
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

/**
 * Call Quiver with bearer auth, retrying on 429/5xx with backoff that
 * respects the Retry-After header.
 */
async function quiver(pathname, { method = "GET", body } = {}, attempt = 0) {
  const res = await fetch(`${QUIVER_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
    const waitMs = Number.isNaN(retryAfter)
      ? 800 * 2 ** attempt
      : retryAfter * 1000;
    await sleep(waitMs);
    return quiver(pathname, { method, body }, attempt + 1);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * Public config — lets the frontend know it's wired up correctly
 * (never exposes the key itself).
 * ------------------------------------------------------------------ */
app.get("/api/config", (req, res) => {
  res.json({
    ready: Boolean(API_KEY),
    defaultModel: DEFAULT_MODEL,
    maxImages: MAX_IMAGES,
  });
});

/* List models + their per-model credit pricing (svg_generate). */
app.get("/api/models", async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: "Server is missing its API key." });
  try {
    const r = await quiver("/models");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(normalizeError(data, r.status));
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Could not reach the image service." });
  }
});

/* The one route that matters: generate 1–5 SVGs. */
app.post("/api/generate", async (req, res) => {
  if (!API_KEY) {
    return res
      .status(503)
      .json({ error: "Server is missing its API key. Set QUIVERAI_API_KEY and redeploy." });
  }

  const {
    prompt,
    n = 1,
    model = DEFAULT_MODEL,
    instructions,
    references,
  } = req.body || {};

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return res.status(400).json({ error: "Add a description of what you want to create." });
  }

  if (!rateLimitOk()) {
    return res.status(429).json({
      error: "Lots of requests right now. Wait a few seconds and try again.",
    });
  }

  const count = clampInt(n, 1, 1, MAX_IMAGES);

  // references may be [{base64}], [{url}], or ["https://..."] — pass as-is,
  // capped to what Arrow 1.1 accepts.
  const refs = Array.isArray(references) ? references.slice(0, 4) : undefined;

  const payload = {
    model,
    prompt: prompt.trim(),
    n: count,
    stream: false,
  };
  if (instructions && String(instructions).trim()) {
    payload.instructions = String(instructions).trim();
  }
  if (refs && refs.length) payload.references = refs;

  try {
    const r = await quiver("/svgs/generations", { method: "POST", body: payload });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json(normalizeError(data, r.status));
    }

    // Return only what the client needs: the SVG markup + cost.
    res.json({
      id: data.id,
      credits: data.credits,
      images: (data.data || []).map((d) => d.svg).filter(Boolean),
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach the image service. Try again." });
  }
});

/* Map Quiver's error codes to plain, end-user friendly messages. */
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
  return {
    error: map[code] || data.message || "The image service returned an error.",
    code: code || undefined,
    status,
  };
}

/* Serve the frontend. Works whether index.html sits in ./public or at the
 * project root, and complains loudly if it's missing entirely. */
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX = fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
  ? path.join(PUBLIC_DIR, "index.html")
  : path.join(__dirname, "index.html");

if (!fs.existsSync(INDEX)) {
  console.error(
    "[error] index.html not found in ./public or the project root. " +
      "The page will 404 until it's added. Expected: " + path.join(PUBLIC_DIR, "index.html")
  );
} else {
  console.log("[ok] Serving frontend from " + INDEX);
}

app.use(express.static(PUBLIC_DIR)); // serves ./public assets when that folder exists
app.get("*", (req, res) => {
  res.sendFile(INDEX, (err) => {
    if (err) res.status(404).send("Frontend not found. index.html is missing from this deploy.");
  });
});

app.listen(PORT, () => {
  console.log(`Vector Studio running on http://localhost:${PORT}`);
});
