// Sahiix Edge Proxy - minimal working entrypoint (stdlib only).
// GET  /health -> { ok, uptime, version }
// POST /proxy   -> forwards JSON body to SAHIIX_API_BASE (Bearer AUTH_SECRET)
//                 with a best-effort file-backed rate-limit counter.
// Env (see termux/install.sh .env template): SAHIIX_API_BASE, AUTH_SECRET,
// WATI_API_KEY, WATI_BASE_URL, ADMIN_NUMBERS, RATE_LIMIT_KV_PATH,
// GOVERNANCE_KV_PATH, PORT.

import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const API_BASE = process.env.SAHIIX_API_BASE ?? "https://api.sahiix.com";
const AUTH_SECRET = process.env.AUTH_SECRET ?? "";
const RATE_LIMIT_KV = process.env.RATE_LIMIT_KV_PATH ?? "";
const GOVERNANCE_KV = process.env.GOVERNANCE_KV_PATH ?? "";
const VERSION = "0.1.0";
const startedAt = Date.now();

function ensureDir(p: string): void {
  if (!p) return;
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* best effort */
  }
}

ensureDir(RATE_LIMIT_KV);
ensureDir(GOVERNANCE_KV);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function forwardJson(body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL("/proxy", API_BASE);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(AUTH_SECRET ? { Authorization: `Bearer ${AUTH_SECRET}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Best-effort per-minute counter in RATE_LIMIT_KV_PATH (file-backed).
function bumpRateCounter(): number {
  if (!RATE_LIMIT_KV) return 0;
  try {
    const key = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const f = path.join(RATE_LIMIT_KV, `${key}.count`);
    const cur = Number(fs.readFileSync(f, "utf8") || 0) + 1;
    fs.writeFileSync(f, String(cur));
    return cur;
  } catch {
    return 0;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, version: VERSION, uptime_s: (Date.now() - startedAt) / 1000 }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/proxy") {
    bumpRateCounter();
    try {
      const body = await readBody(req);
      const upstream = await forwardJson(body || "{}");
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(upstream.text);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`sahiix-proxy v${VERSION} listening on :${PORT}`);
});
