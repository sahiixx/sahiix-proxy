import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  signJwt,
  verifyJwt,
  checkRateLimit,
  loadRules,
  saveRules,
  matchRule,
  makeRule,
  parseWatiCommand,
  type GovRule,
} from "../src/index";

const SECRET = "unit-test-secret-32-chars-minimum!";

describe("jwt", () => {
  test("sign then verify returns claims", () => {
    const token = signJwt("u1", "pro", "user", SECRET);
    expect(verifyJwt(token, SECRET)).toEqual({ sub: "u1", tier: "pro", role: "user" });
  });

  test("wrong secret fails", () => {
    const token = signJwt("u1", "free", "user", SECRET);
    expect(verifyJwt(token, "other-secret-32-chars-minimum!!!")).toBeNull();
  });

  test("malformed tokens fail", () => {
    expect(verifyJwt("", SECRET)).toBeNull();
    expect(verifyJwt("abc", SECRET)).toBeNull();
    expect(verifyJwt("a.b", SECRET)).toBeNull();
    expect(verifyJwt("a.b.c.d", SECRET)).toBeNull();
  });

  test("expired token fails", () => {
    const token = signJwt("u1", "free", "user", SECRET, -10);
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  test("unknown tier falls back to free", () => {
    const token = signJwt("u1", "ultra" as never, "user", SECRET);
    expect(verifyJwt(token, SECRET)?.tier).toBe("free");
  });
});

describe("rate limit", () => {
  test("free tier allows 20 then blocks 21st", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    let last = checkRateLimit(dir, "u-free", "free"); // 1st of 20
    for (let i = 2; i <= 20; i++) {
      last = checkRateLimit(dir, "u-free", "free");
      expect(last.allowed).toBe(true);
    }
    expect(last.remaining).toBe(0);
    const over = checkRateLimit(dir, "u-free", "free");
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
    expect(over.retryAfter).toBeGreaterThan(0);
  });

  test("higher tiers get higher limits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    expect(checkRateLimit(dir, "u", "enterprise").limit).toBe(5000);
    expect(checkRateLimit(dir, "u", "pro").limit).toBe(500);
    expect(checkRateLimit(dir, "u", "standard").limit).toBe(100);
  });

  test("malicious userId cannot escape kv dir", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rl-parent-"));
    const dir = path.join(parent, "kv");
    const evil = "../../evil-escape";
    const r = checkRateLimit(dir, evil, "free");
    expect(r.allowed).toBe(true);
    const written = fs.readdirSync(dir);
    expect(written.length).toBe(1);
    expect(path.resolve(dir, written[0] as string).startsWith(path.resolve(dir))).toBe(true);
    expect(fs.existsSync(path.join(parent, "evil-escape"))).toBe(false);
    expect(written[0]).not.toContain("..");
  });
});

describe("governance rules", () => {
  test("userId block matches only that user", () => {
    const rule: GovRule = {
      id: "r1",
      action: "block",
      userId: "bad",
      createdAt: new Date().toISOString(),
    };
    expect(matchRule(rule, { userId: "bad", path: "/proxy", tier: "free" })).toBe(true);
    expect(matchRule(rule, { userId: "good", path: "/proxy", tier: "free" })).toBe(false);
  });

  test("path wildcard matches prefix", () => {
    const rule: GovRule = {
      id: "r2",
      action: "block",
      path: "/v1/admin/*",
      createdAt: new Date().toISOString(),
    };
    expect(matchRule(rule, { userId: "u", path: "/v1/admin/stats", tier: "free" })).toBe(true);
    expect(matchRule(rule, { userId: "u", path: "/v1/admin", tier: "free" })).toBe(true);
    expect(matchRule(rule, { userId: "u", path: "/v1/public", tier: "free" })).toBe(false);
  });

  test("multi-condition AND logic", () => {
    const rule: GovRule = {
      id: "r3",
      action: "block",
      conditions: [
        { field: "path", op: "startsWith", value: "/v1/" },
        { field: "tier", op: "equals", value: "free" },
      ],
      createdAt: new Date().toISOString(),
    };
    expect(matchRule(rule, { userId: "u", path: "/v1/x", tier: "free" })).toBe(true);
    expect(matchRule(rule, { userId: "u", path: "/v1/x", tier: "pro" })).toBe(false);
    expect(matchRule(rule, { userId: "u", path: "/v2/x", tier: "free" })).toBe(false);
  });

  test("rules persist to disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-"));
    expect(loadRules(dir)).toEqual([]);
    const rule: GovRule = {
      id: "r9",
      action: "block",
      userId: "x",
      createdAt: new Date().toISOString(),
    };
    saveRules(dir, [rule]);
    expect(loadRules(dir)).toEqual([rule]);
  });

  test("makeRule rejects empty input", () => {
    expect(makeRule({})).toBeNull();
    expect(makeRule({ userId: "u" })?.action).toBe("block");
  });
});

describe("wati commands", () => {
  test("parses status / rule list / block", () => {
    expect(parseWatiCommand("/status")).toEqual({ cmd: "status" });
    expect(parseWatiCommand("/rule list")).toEqual({ cmd: "rule_list" });
    expect(parseWatiCommand("/block bad-user")).toEqual({ cmd: "block", userId: "bad-user" });
  });

  test("empty and unknown", () => {
    expect(parseWatiCommand("")).toBeNull();
    expect(parseWatiCommand("   ")).toBeNull();
    expect(parseWatiCommand("hello")?.cmd).toBe("unknown");
  });
});
