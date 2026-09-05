// Sahiix Edge Proxy — stdlib-only HTTP edge proxy.
//
// Routes:
//   GET  /health                 public, { ok, version, uptime_s }
//   POST /wati/webhook           WATI inbound; { from, text } — admin commands, non-admin ignored
//   GET  /admin/governance/rules admin JWT only — list block rules
//   POST /admin/governance/rules admin JWT only — create block rule
//   POST /*                      authenticated proxy to SAHIIX_API_BASE (rate-limited, governed)
//   OPTIONS *                     CORS preflight -> 204
//   anything else                 404 JSON
//
// Auth: Authorization: Bearer <HS256 JWT>. Claims: sub (userId),
// tier (free|standard|pro|enterprise), role (user|admin). Verified with AUTH_SECRET.
// Missing / malformed / bad-signature / expired token -> 401.
//
// Rate limits (per userId, per minute, file-backed in RATE_LIMIT_KV_PATH):
// free 20, standard 100, pro 500, enterprise 5000. Exhausted -> 429 +
// Retry-After / X-RateLimit-Remaining headers.
//
// Governance (rules.json in GOVERNANCE_KV_PATH): block rules matching userId,
// path prefix ("/v1/admin/*" style) and/or AND-ed conditions. Admin role bypasses.

import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const VERSION = "0.2.1";
export const TIER_LIMITS: Record<string, number> = {
  free: 20,
  standard: 100,
  pro: 500,
  enterprise: 5000,
};
export type Tier = "free" | "standard" | "pro" | "enterprise";
const TIERS: Tier[] = ["free", "standard", "pro", "enterprise"];

export interface Claims {
  sub: string;
  tier: Tier;
  role: string;
}

export interface ProxyConfig {
  port: number;
  apiBase: string;
  authSecret: string;
  rateKv: string;
  govKv: string;
  adminNumbers: string[];
}

// Minimal .env loader (stdlib only). PM2's ecosystem `env_file` is not a real
// PM2 option, so the app must load .env itself or production runs with empty
// secrets. Real environment variables always win; missing file is fine.
export function loadDotEnv(dotPath?: string): void {
  const candidates = [
    dotPath,
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", ".env"),
  ].filter((p): p is string => !!p);
  for (const f of candidates) {
    let raw = "";
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      if (!k || process.env[k] !== undefined) continue;
      let v = t.slice(eq + 1).trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      process.env[k] = v;
    }
    return;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return {
    port: Number(env.PORT ?? 8787),
    apiBase: env.SAHIIX_API_BASE ?? "https://api.sahiix.com",
    authSecret: env.AUTH_SECRET ?? "",
    rateKv: env.RATE_LIMIT_KV_PATH ?? path.join(os.homedir(), ".sahiix-proxy", "kv", "ratelimit"),
    govKv: env.GOVERNANCE_KV_PATH ?? path.join(os.homedir(), ".sahiix-proxy", "kv", "governance"),
    adminNumbers: (env.ADMIN_NUMBERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// ─── JWT (HS256, no dependencies) ────────────────────────────────────────────
function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

export function signJwt(
  sub: string,
  tier: Tier,
  role: string,
  secret: string,
  expiresInS = 3600,
): string {
  const header = b64urlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(
    Buffer.from(
      JSON.stringify({ sub, tier, role, exp: Math.floor(Date.now() / 1000) + expiresInS }),
    ),
  );
  const sig = b64urlEncode(
    crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): Claims | null {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8")) as unknown;
    payload = JSON.parse(b64urlDecode(p).toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: string }).alg !== "HS256" ||
    typeof payload !== "object" ||
    payload === null
  ) {
    return null;
  }
  const pl = payload as { sub?: unknown; tier?: unknown; role?: unknown; exp?: unknown };
  const expect = b64urlEncode(crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest());
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (typeof pl.exp === "number" && pl.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof pl.sub !== "string" || !pl.sub) return null;
  const tier: Tier = TIERS.includes(pl.tier as Tier) ? (pl.tier as Tier) : "free";
  return { sub: pl.sub, tier, role: typeof pl.role === "string" ? pl.role : "user" };
}

// ─── Rate limiting (file-backed per-minute counters) ─────────────────────────

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
}

function minuteKey(d: Date): string {
  return d.toISOString().slice(0, 16).replace(/[-:T]/g, "");
}

export function checkRateLimit(rateKv: string, userId: string, tier: Tier): RateResult {
  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.free ?? 20;
  const now = new Date();
  const retryAfter = 60 - now.getSeconds();
  // userId is attacker-influenced (JWT sub claim): never interpolate raw into a
  // path — hash it so traversal strings like ../../x stay inside rateKv.
  const safeId = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32);
  try {
    fs.mkdirSync(rateKv, { recursive: true });
    const f = path.join(rateKv, `${safeId}-${minuteKey(now)}.count`);
    let count = 0;
    try {
      count = Number(fs.readFileSync(f, "utf8")) || 0;
    } catch {
      count = 0;
    }
    count += 1;
    fs.writeFileSync(f, String(count));
    if (count > limit) return { allowed: false, limit, remaining: 0, retryAfter };
    return { allowed: true, limit, remaining: limit - count, retryAfter: 0 };
  } catch {
    return { allowed: true, limit, remaining: limit, retryAfter: 0 }; // fail open
  }
}

// ─── Governance rules ────────────────────────────────────────────────────────

export interface Condition {
  field: "path" | "userId" | "tier";
  op: "equals" | "startsWith";
  value: string;
}

export interface GovRule {
  id: string;
  action: "block";
  userId?: string;
  path?: string;
  conditions?: Condition[];
  createdAt: string;
}

export interface RuleCtx {
  userId: string;
  path: string;
  tier: string;
}

export function rulesFile(govKv: string): string {
  return path.join(govKv, "rules.json");
}

export function loadRules(govKv: string): GovRule[] {
  try {
    const raw = fs.readFileSync(rulesFile(govKv), "utf8");
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as GovRule[]) : [];
  } catch {
    return [];
  }
}

export function saveRules(govKv: string, rules: GovRule[]): void {
  fs.mkdirSync(govKv, { recursive: true });
  fs.writeFileSync(rulesFile(govKv), JSON.stringify(rules, null, 2));
}

function pathMatches(pattern: string, actual: string): boolean {
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // keep trailing slash
    return actual === pattern.slice(0, -2) || actual.startsWith(prefix);
  }
  return actual === pattern;
}

export function matchRule(rule: GovRule, ctx: RuleCtx): boolean {
  if (rule.userId && rule.userId !== ctx.userId) return false;
  if (rule.path && !pathMatches(rule.path, ctx.path)) return false;
  for (const c of rule.conditions ?? []) {
    const actual = c.field === "path" ? ctx.path : c.field === "userId" ? ctx.userId : ctx.tier;
    if (c.op === "equals" ? actual !== c.value : !actual.startsWith(c.value)) return false;
  }
  return true;
}

export function findBlock(govKv: string, ctx: RuleCtx): GovRule | null {
  for (const r of loadRules(govKv)) {
    if (r.action === "block" && matchRule(r, ctx)) return r;
  }
  return null;
}

export function makeRule(input: {
  userId?: unknown;
  path?: unknown;
  conditions?: unknown;
}): GovRule | null {
  const userId = typeof input.userId === "string" && input.userId ? input.userId : undefined;
  const rulePath = typeof input.path === "string" && input.path ? input.path : undefined;
  const conditions = Array.isArray(input.conditions)
    ? (input.conditions as Condition[]).filter(
        (c) =>
          c &&
          (c.field === "path" || c.field === "userId" || c.field === "tier") &&
          (c.op === "equals" || c.op === "startsWith") &&
          typeof c.value === "string",
      )
    : [];
  if (!userId && !rulePath && conditions.length === 0) return null;
  return {
    id: `rule-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    action: "block",
    ...(userId ? { userId } : {}),
    ...(rulePath ? { path: rulePath } : {}),
    ...(conditions.length > 0 ? { conditions } : {}),
    createdAt: new Date().toISOString(),
  };
}

// ─── WATI webhook commands ───────────────────────────────────────────────────

export type WatiCmd =
  | { cmd: "status" }
  | { cmd: "rule_list" }
  | { cmd: "block"; userId: string }
  | { cmd: "unknown"; text: string };

export function parseWatiCommand(text: string): WatiCmd | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (t === "/status") return { cmd: "status" };
  if (t === "/rule list") return { cmd: "rule_list" };
  const m = t.match(/^\/block\s+(\S+)$/);
  if (m) return { cmd: "block", userId: m[1] as string };
  return { cmd: "unknown", text: t };
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Request-ID");
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  obj: unknown,
  extra: Record<string, string> = {},
): void {
  setCors(res);
  res.setHeader("X-Proxy-Version", VERSION);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const MAX_BODY = 1_048_576;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function forward(
  cfg: ProxyConfig,
  targetPath: string,
  body: string,
  claims: Claims,
  reqId: string,
): Promise<{ status: number; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetPath, cfg.apiBase);
    const lib = target.protocol === "https:" ? https : http;
    const timer = setTimeout(() => reject(new Error("upstream timeout")), 10_000);
    const up = lib.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Proxy-User": claims.sub,
          "X-Proxy-Tier": claims.tier,
          "X-Request-ID": reqId,
          ...(cfg.authSecret ? { Authorization: `Bearer ${cfg.authSecret}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 502,
            text: Buffer.concat(chunks).toString("utf8"),
            contentType: (res.headers["content-type"] as string) ?? "application/json",
          });
        });
      },
    );
    up.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    up.write(body);
    up.end();
  });
}

function requireAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: ProxyConfig,
): Claims | null {
  const h = req.headers.authorization ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/);
  const claims = m ? verifyJwt(m[1] as string, cfg.authSecret) : null;
  if (!claims) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return null;
  }
  return claims;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: ProxyConfig,
  startedAt: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const reqId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  const rid = { "X-Request-ID": reqId };

  if (req.method === "OPTIONS") {
    setCors(res);
    res.setHeader("X-Proxy-Version", VERSION);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(
      res,
      200,
      { ok: true, version: VERSION, uptime_s: (Date.now() - startedAt) / 1000 },
      rid,
    );
    return;
  }

  // WATI inbound webhook
  if (req.method === "POST" && url.pathname === "/wati/webhook") {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req)) as unknown;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" }, rid);
      return;
    }
    const p = (typeof payload === "object" && payload !== null ? payload : {}) as {
      from?: unknown;
      text?: unknown;
      body?: unknown;
      message?: unknown;
    };
    if (typeof p.from !== "string" || !p.from) {
      sendJson(res, 400, { ok: false, error: "missing from" }, rid);
      return;
    }
    const rawText = p.text ?? p.body ?? p.message;
    if (typeof rawText !== "string") {
      sendJson(res, 400, { ok: false, error: "missing text" }, rid);
      return;
    }
    if (!cfg.adminNumbers.includes(p.from)) {
      sendJson(res, 200, { ok: true, ignored: true }, rid);
      return;
    }
    const cmd = parseWatiCommand(rawText);
    if (!cmd) {
      sendJson(res, 400, { ok: false, error: "empty command" }, rid);
      return;
    }
    if (cmd.cmd === "status") {
      sendJson(
        res,
        200,
        {
          ok: true,
          version: VERSION,
          uptime_s: (Date.now() - startedAt) / 1000,
          rules: loadRules(cfg.govKv).length,
        },
        rid,
      );
      return;
    }
    if (cmd.cmd === "rule_list") {
      const rules = loadRules(cfg.govKv);
      sendJson(res, 200, { ok: true, count: rules.length, rules }, rid);
      return;
    }
    if (cmd.cmd === "block") {
      const rule: GovRule = {
        id: `rule-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
        action: "block",
        userId: cmd.userId,
        createdAt: new Date().toISOString(),
      };
      const rules = loadRules(cfg.govKv);
      rules.push(rule);
      saveRules(cfg.govKv, rules);
      sendJson(res, 200, { ok: true, rule }, rid);
      return;
    }
    sendJson(res, 200, { ok: true, ignored: true, reason: "unknown command" }, rid);
    return;
  }

  // Admin governance API
  if (url.pathname === "/admin/governance/rules") {
    const claims = requireAuth(req, res, cfg);
    if (!claims) return;
    if (claims.role !== "admin") {
      sendJson(res, 403, { ok: false, error: "forbidden" }, rid);
      return;
    }
    if (req.method === "GET") {
      const rules = loadRules(cfg.govKv);
      sendJson(res, 200, { ok: true, count: rules.length, rules }, rid);
      return;
    }
    if (req.method === "POST") {
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(req)) as unknown;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" }, rid);
        return;
      }
      const rule = makeRule((typeof payload === "object" && payload !== null ? payload : {}) as {
        userId?: unknown;
        path?: unknown;
        conditions?: unknown;
      });
      if (!rule) {
        sendJson(res, 400, { ok: false, error: "rule needs userId, path, or conditions" }, rid);
        return;
      }
      const rules = loadRules(cfg.govKv);
      rules.push(rule);
      saveRules(cfg.govKv, rules);
      sendJson(res, 201, { ok: true, rule }, rid);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" }, rid);
    return;
  }

  // Authenticated proxy: POST any non-reserved path
  if (req.method === "POST") {
    const claims = requireAuth(req, res, cfg);
    if (!claims) return;
    const rate = checkRateLimit(cfg.rateKv, claims.sub, claims.tier);
    const rateHeaders = {
      ...rid,
      "X-RateLimit-Limit": String(rate.limit),
      "X-RateLimit-Remaining": String(rate.remaining),
    };
    if (!rate.allowed) {
      sendJson(res, 429, { ok: false, error: "rate limited" }, {
        ...rateHeaders,
        "Retry-After": String(rate.retryAfter),
      });
      return;
    }
    if (
      claims.role !== "admin" &&
      findBlock(cfg.govKv, { userId: claims.sub, path: url.pathname, tier: claims.tier })
    ) {
      sendJson(res, 403, { ok: false, error: "blocked by governance" }, rateHeaders);
      return;
    }
    let body = "";
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e) }, rateHeaders);
      return;
    }
    try {
      const up = await forward(cfg, url.pathname + url.search, body || "{}", claims, reqId);
      setCors(res);
      res.setHeader("X-Proxy-Version", VERSION);
      res.setHeader("X-Request-ID", reqId);
      res.setHeader("X-RateLimit-Limit", String(rate.limit));
      res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
      res.writeHead(up.status, { "Content-Type": up.contentType });
      res.end(up.text);
    } catch (e) {
      sendJson(res, 502, { ok: false, error: String(e) }, rateHeaders);
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" }, rid);
}

export function createServer(cfg: ProxyConfig): http.Server {
  const startedAt = Date.now();
  try {
    fs.mkdirSync(cfg.rateKv, { recursive: true });
    fs.mkdirSync(cfg.govKv, { recursive: true });
  } catch {
    /* best effort */
  }
  return http.createServer((req, res) => {
    void handle(req, res, cfg, startedAt).catch(() => {
      try {
        sendJson(res, 500, { ok: false, error: "internal" });
      } catch {
        /* socket gone */
      }
    });
  });
}

if (require.main === module) {
  loadDotEnv();
  const cfg = loadConfig();
  createServer(cfg).listen(cfg.port, () => {
    console.log(`sahiix-proxy v${VERSION} listening on :${cfg.port}`);
  });
}
