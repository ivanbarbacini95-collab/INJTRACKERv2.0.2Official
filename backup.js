// /api/backup.js
import { put, head } from "@vercel/blob";

const MAX_BODY_BYTES = 950_000; // allow larger snapshots than /api/point

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function normalizeAddr(a) {
  const s = String(a || "").trim().toLowerCase();
  if (!/^inj[a-z0-9]{20,80}$/.test(s)) return "";
  return s;
}

async function readBody(req) {
  return await new Promise((resolve) => {
    let size = 0;
    let buf = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        try { req.destroy(); } catch {}
        return;
      }
      buf += chunk.toString("utf8");
    });
    req.on("end", () => resolve(buf));
    req.on("error", () => resolve(""));
  });
}

async function readBlobTextByPathname(pathname) {
  try {
    const meta = await head(pathname);
    const url = meta?.url;
    if (!url) return "";
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
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

    const pathname = `inj-backup/${address}/latest.json`;

    if (req.method === "GET") {
      const txt = await readBlobTextByPathname(pathname);
      if (!txt) return json(res, 200, { ok: true, data: null });

      let data = null;
      try { data = JSON.parse(txt); } catch { data = null; }
      return json(res, 200, { ok: true, data });
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) return json(res, 413, { ok: false, error: "Body too large" });
      if (!raw) return json(res, 400, { ok: false, error: "Empty body" });

      let snap = null;
      try { snap = JSON.parse(raw); } catch { snap = null; }
      if (!snap || typeof snap !== "object") return json(res, 400, { ok: false, error: "Invalid JSON" });

      if (String(snap.address || "").toLowerCase() !== address) {
        return json(res, 400, { ok: false, error: "Address mismatch" });
      }

      // very light validation
      if (!snap.payload || typeof snap.payload !== "object") {
        return json(res, 400, { ok: false, error: "Missing payload" });
      }

      snap.t = Number(snap.t || Date.now());
      snap.v = Number(snap.v || 1);

      const blob = await put(pathname, JSON.stringify(snap), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true
      });

      return json(res, 200, { ok: true, url: blob?.url || "" });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Server error" });
  }
}
