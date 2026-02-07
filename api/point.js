// /api/point.js
import { put, head } from "@vercel/blob";

const MAX_BODY_BYTES = 220_000;

// punti massimi per serie (stake/wd/nw) + eventi
const MAX_POINTS = 2400;
const MAX_EVENTS = 1200;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!/^inj[a-z0-9]{20,80}$/i.test(s)) return "";
  return s;
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function toStr(x, maxLen = 200) {
  const s = String(x ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function sanitizeEvent(e) {
  const ts = toNum(e?.ts) || Date.now();
  const kind = toStr(e?.kind || e?.type || "event", 32); // withdraw | unstake | reward | compound | price | tx | info...
  const title = toStr(e?.title || kind, 64);
  const detail = toStr(e?.detail || e?.desc || "", 220);

  // value può essere INJ, USD o % (dipende da kind). il client decide.
  const value = toNum(e?.value);

  // dir: "up" | "down" | "" (per eventi prezzo)
  const dir = toStr(e?.dir || "", 8);

  // status: "pending" | "ok" | "err" | "done"
  const status = toStr(e?.status || "done", 12);

  // id stabile: se il client lo passa lo usiamo; altrimenti generiamo uno deterministico-ish
  const id = toStr(e?.id || `${ts}:${kind}:${title}`.replace(/\s+/g, "_"), 120);

  return { id, ts, kind, title, detail, value, dir, status };
}

function sanitizePayload(p) {
  // ✅ v:2 per compatibilità
  const out = {
    v: 2,
    t: Date.now(),
    stake: { labels: [], data: [], moves: [], types: [] },
    wd: { labels: [], values: [], times: [] },
    nw: { times: [], usd: [], inj: [] },
    events: []
  };

  if (p?.stake) {
    out.stake.labels = clampArray(p.stake.labels, MAX_POINTS).map((x) => toStr(x, 48));
    out.stake.data = clampArray(p.stake.data, MAX_POINTS).map(toNum);
    out.stake.moves = clampArray(p.stake.moves, MAX_POINTS).map(toNum);
    out.stake.types = clampArray(p.stake.types, MAX_POINTS).map((x) => toStr(x, 40));

    const n = out.stake.data.length;
    out.stake.labels = out.stake.labels.slice(-n);
    out.stake.moves = out.stake.moves.slice(-n);
    out.stake.types = out.stake.types.slice(-n);
    while (out.stake.moves.length < n) out.stake.moves.unshift(0);
    while (out.stake.types.length < n) out.stake.types.unshift("Stake update");
  }

  if (p?.wd) {
    out.wd.labels = clampArray(p.wd.labels, MAX_POINTS).map((x) => toStr(x, 48));
    out.wd.values = clampArray(p.wd.values, MAX_POINTS).map(toNum);
    out.wd.times = clampArray(p.wd.times, MAX_POINTS).map(toNum);

    const n = out.wd.values.length;
    out.wd.labels = out.wd.labels.slice(-n);
    out.wd.times = out.wd.times.slice(-n);
    while (out.wd.times.length < n) out.wd.times.unshift(0);
  }

  if (p?.nw) {
    out.nw.times = clampArray(p.nw.times, MAX_POINTS).map(toNum);
    out.nw.usd = clampArray(p.nw.usd, MAX_POINTS).map(toNum);
    out.nw.inj = clampArray(p.nw.inj, MAX_POINTS).map(toNum);

    const n = out.nw.times.length;
    out.nw.usd = out.nw.usd.slice(-n);
    out.nw.inj = out.nw.inj.slice(-n);
    while (out.nw.usd.length < n) out.nw.usd.unshift(0);
    while (out.nw.inj.length < n) out.nw.inj.unshift(0);
  }

  // ✅ EVENTS (dedup + clamp)
  if (Array.isArray(p?.events)) {
    const cleaned = p.events.map(sanitizeEvent);

    // dedup per id (tengo l’ultima occorrenza)
    const map = new Map();
    for (const ev of cleaned) map.set(ev.id, ev);

    // ordino per ts crescente
    const arr = Array.from(map.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));

    out.events = clampArray(arr, MAX_EVENTS);
  }

  out.t = Date.now();
  return out;
}

async function readBlobTextByPathname(pathname) {
  try {
    // ✅ Lettura stabile: head(pathname) -> url certo -> fetch contenuto
    const meta = await head(pathname); // se non esiste, throw
    const resp = await fetch(meta.url, { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

async function readRawBody(req) {
  // Se Vercel ha già parsato il body (alcune config), usalo
  if (req?.body != null) {
    if (typeof req.body === "string") return req.body;
    try {
      return JSON.stringify(req.body);
    } catch {
      return "";
    }
  }

  let raw = "";
  let tooLarge = false;

  await new Promise((resolve) => {
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        raw = "";
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", resolve);
  });

  if (tooLarge) return null; // segnale "troppo grande"
  return raw;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const address = normalizeAddr(req.query?.address);
    if (!address) return json(res, 400, { ok: false, error: "Invalid address" });

    const prefix = `inj-points/${address}/`;
    const pathname = `${prefix}data.json`;

    if (req.method === "GET") {
      const txt = await readBlobTextByPathname(pathname);
      if (!txt) return json(res, 200, { ok: true, data: null });

      let data = null;
      try {
        data = JSON.parse(txt);
      } catch {
        data = null;
      }
      return json(res, 200, { ok: true, data });
    }

    if (req.method === "POST") {
      const raw = await readRawBody(req);

      if (raw === null) return json(res, 413, { ok: false, error: "Body too large" });
      if (!raw) return json(res, 400, { ok: false, error: "Empty body" });

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json(res, 400, { ok: false, error: "Invalid JSON" });
      }

      const clean = sanitizePayload(parsed);

      // ✅ FIX Cloud Sync: allowOverwrite true, altrimenti dal 2° salvataggio fallisce
      const blob = await put(pathname, JSON.stringify(clean), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true
      });

      return json(res, 200, { ok: true, url: blob?.url || null, t: clean.t });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
}
