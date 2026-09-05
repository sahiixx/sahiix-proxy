import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, signJwt, type ProxyConfig, type Tier } from "../src/index";

const SECRET = "e2e-test-secret-32-chars-minimum!!";
const ADMIN_PHONE = "+971500000001";

let origin: http.Server;
let proxy: http.Server;
let proxyBase = "";
let cfg: ProxyConfig;

function listen0(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

// Fake upstream: echoes received proxy headers; /boom returns 502.
function startOrigin(): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url === "/boom") {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "boom" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          path: req.url,
          user: req.headers["x-proxy-user"] ?? null,
          tier: req.headers["x-proxy-tier"] ?? null,
          reqId: req.headers["x-request-id"] ?? null,
          body,
        }),
      );
    });
  });
  return listen0(server).then((port) => ({ server, base: `http://127.0.0.1:${port}` }));
}

function token(sub: string, tier: Tier = "free", role = "user"): string {
  return signJwt(sub, tier, role, SECRET);
}

async function call(
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers["Content-Type"] = "text/plain";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${proxyBase}${p}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    /* non-json */
  }
  return { status: res.status, headers: res.headers, json, text };
}

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sahiix-e2e-"));
  const { server, base } = await startOrigin();
  origin = server;
  cfg = {
    port: 0,
    apiBase: base,
    authSecret: SECRET,
    rateKv: path.join(tmp, "rate"),
    govKv: path.join(tmp, "gov"),
    adminNumbers: [ADMIN_PHONE],
  };
  proxy = createServer(cfg);
  proxyBase = `http://127.0.0.1:${await listen0(proxy)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => origin.close(() => r()));
});

describe("authentication", () => {
  test("missing auth -> 401", async () => {
    const r = await call("POST", "/proxy", { body: { a: 1 } });
    expect(r.status).toBe(401);
  });

  test("malformed Bearer -> 401", async () => {
    const r = await call("POST", "/proxy", {
      body: { a: 1 },
      headers: { Authorization: "Bearer" },
    });
    expect(r.status).toBe(401);
    const r2 = await call("POST", "/proxy", {
      body: { a: 1 },
      headers: { Authorization: "Token abc" },
    });
    expect(r2.status).toBe(401);
  });

  test("valid JWT -> proxied to origin", async () => {
    const r = await call("POST", "/proxy", {
      token: token("e2e-auth-user"),
      body: { hello: "world" },
    });
    expect(r.status).toBe(200);
    const j = r.json as { ok: boolean; user: string; tier: string };
    expect(j.ok).toBe(true);
    expect(j.user).toBe("e2e-auth-user");
    expect(j.tier).toBe("free");
  });
});

describe("rate limiting", () => {
  test("free tier exhaustion: 20 ok then 429 with headers", async () => {
    const t = token("e2e-rate-user");
    for (let i = 0; i < 20; i++) {
      const r = await call("POST", "/proxy", { token: t, body: {} });
      expect(r.status).toBe(200);
    }
    const over = await call("POST", "/proxy", { token: t, body: {} });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect(over.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  test("higher tier allows more than 20", async () => {
    const t = token("e2e-pro-user", "pro");
    for (let i = 0; i < 25; i++) {
      const r = await call("POST", "/proxy", { token: t, body: {} });
      expect(r.status).toBe(200);
      if (i === 0) expect(r.headers.get("x-ratelimit-remaining")).toBeTruthy();
    }
  });
});

describe("governance", () => {
  test("block rule by userId -> 403", async () => {
    const admin = token("e2e-admin", "enterprise", "admin");
    const mk = await call("POST", "/admin/governance/rules", {
      token: admin,
      body: { userId: "e2e-blocked-user" },
    });
    expect(mk.status).toBe(201);
    const r = await call("POST", "/proxy", { token: token("e2e-blocked-user"), body: {} });
    expect(r.status).toBe(403);
  });

  test("admin bypasses block rule", async () => {
    const admin = token("e2e-admin2", "enterprise", "admin");
    await call("POST", "/admin/governance/rules", {
      token: admin,
      body: { userId: "e2e-admin2" },
    });
    const r = await call("POST", "/proxy", { token: admin, body: {} });
    expect(r.status).toBe(200);
  });

  test("path rule blocks /v1/admin/* for free tier", async () => {
    const admin = token("e2e-admin", "enterprise", "admin");
    const mk = await call("POST", "/admin/governance/rules", {
      token: admin,
      body: { path: "/v1/admin/*" },
    });
    expect(mk.status).toBe(201);
    const blocked = await call("POST", "/v1/admin/stats", { token: token("e2e-path-user"), body: {} });
    expect(blocked.status).toBe(403);
  });

  test("multi-condition AND: free blocked, pro passes", async () => {
    const admin = token("e2e-admin", "enterprise", "admin");
    await call("POST", "/admin/governance/rules", {
      token: admin,
      body: {
        conditions: [
          { field: "path", op: "startsWith", value: "/v1/cond" },
          { field: "tier", op: "equals", value: "free" },
        ],
      },
    });
    const free = await call("POST", "/v1/cond/x", { token: token("e2e-cond-free"), body: {} });
    expect(free.status).toBe(403);
    const pro = await call("POST", "/v1/cond/x", { token: token("e2e-cond-pro", "pro"), body: {} });
    expect(pro.status).toBe(200);
  });
});

describe("wati webhook", () => {
  test("/status from admin -> proxy health", async () => {
    const r = await call("POST", "/wati/webhook", {
      body: { from: ADMIN_PHONE, text: "/status" },
    });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
  });

  test("/rule list -> rule count", async () => {
    const r = await call("POST", "/wati/webhook", {
      body: { from: ADMIN_PHONE, text: "/rule list" },
    });
    expect(r.status).toBe(200);
    expect(typeof (r.json as { count: number }).count).toBe("number");
  });

  test("/block creates rule in KV", async () => {
    const r = await call("POST", "/wati/webhook", {
      body: { from: ADMIN_PHONE, text: "/block e2e-wati-blocked" },
    });
    expect(r.status).toBe(200);
    const gated = await call("POST", "/proxy", { token: token("e2e-wati-blocked"), body: {} });
    expect(gated.status).toBe(403);
  });

  test("non-admin number ignored", async () => {
    const r = await call("POST", "/wati/webhook", {
      body: { from: "+971599999999", text: "/block e2e-should-not-block" },
    });
    expect(r.status).toBe(200);
    expect((r.json as { ignored: boolean }).ignored).toBe(true);
    const gated = await call("POST", "/proxy", { token: token("e2e-should-not-block"), body: {} });
    expect(gated.status).toBe(200);
  });
});

describe("admin api", () => {
  test("GET rules: 200 admin, 403 user, 401 anonymous", async () => {
    const admin = token("e2e-admin", "enterprise", "admin");
    expect((await call("GET", "/admin/governance/rules", { token: admin })).status).toBe(200);
    expect((await call("GET", "/admin/governance/rules", { token: token("e2e-regular") })).status).toBe(403);
    expect((await call("GET", "/admin/governance/rules")).status).toBe(401);
  });

  test("POST rule created", async () => {
    const admin = token("e2e-admin", "enterprise", "admin");
    const r = await call("POST", "/admin/governance/rules", {
      token: admin,
      body: { userId: "e2e-adminapi-user" },
    });
    expect(r.status).toBe(201);
    expect((r.json as { rule: { userId: string } }).rule.userId).toBe("e2e-adminapi-user");
  });
});

describe("cors", () => {
  test("preflight -> 204 with ACAO", async () => {
    const r = await call("OPTIONS", "/proxy");
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("actual responses include ACAO", async () => {
    const r = await call("POST", "/proxy", { token: token("e2e-cors-user"), body: {} });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("proxy headers", () => {
  test("origin sees X-Proxy-User/Tier, client gets X-Request-ID", async () => {
    const r = await call("POST", "/proxy", { token: token("e2e-hdr-user", "standard"), body: {} });
    expect(r.status).toBe(200);
    const j = r.json as { user: string; tier: string; reqId: string };
    expect(j.user).toBe("e2e-hdr-user");
    expect(j.tier).toBe("standard");
    expect(j.reqId).toBeTruthy();
    expect(r.headers.get("x-request-id")).toBe(j.reqId);
  });
});

describe("errors", () => {
  test("unknown route -> 404", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
  });

  test("upstream 502 passed through", async () => {
    const r = await call("POST", "/boom", { token: token("e2e-502-user"), body: {} });
    expect(r.status).toBe(502);
    expect((r.json as { error: string }).error).toBe("boom");
  });

  test("invalid JSON webhook -> 400", async () => {
    const r = await call("POST", "/wati/webhook", { rawBody: "{not json" });
    expect(r.status).toBe(400);
  });
});
