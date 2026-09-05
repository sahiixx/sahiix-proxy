import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadDotEnv } from "../src/index";

describe("dotenv loader", () => {
  test("loads file, real env wins, comments skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-"));
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, "# comment\nDOT_A=hello\nDOT_B=\"quoted value\"\nDOT_C='single'\nEMPTY=\n");
    delete process.env.DOT_A;
    delete process.env.DOT_B;
    process.env.DOT_C = "real-wins";
    loadDotEnv(f);
    expect(process.env.DOT_A).toBe("hello");
    expect(process.env.DOT_B).toBe("quoted value");
    expect(process.env.DOT_C).toBe("real-wins");
    expect(process.env.EMPTY).toBe("");
    delete process.env.DOT_A;
    delete process.env.DOT_B;
    delete process.env.DOT_C;
    delete process.env.EMPTY;
  });

  test("missing file is a no-op", () => {
    expect(() => loadDotEnv("/nonexistent-xyz/.env")).not.toThrow();
  });
});
