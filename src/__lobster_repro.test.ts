import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("lobster spawn repro", () => {
  it("spawns fake lobster", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-repro-"));
    const bin = path.join(dir, "lobster");
    await fs.writeFile(bin, '#!/usr/bin/env node\nprocess.stdout.write("ok");\n', { mode: 0o755 });

    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;

    const which = await new Promise<{ code: number | null; out: string; err: string }>(
      (resolve, reject) => {
        const child = spawn("which", ["lobster"], {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (d) => {
          out += String(d);
        });
        child.stderr?.on("data", (d) => {
          err += String(d);
        });
        child.once("error", (e) => reject(e));
        child.once("exit", (code) => resolve({ code, out, err }));
      },
    );
    expect(which.code).toBe(0);
    expect(which.out.trim()).toBe(bin);

    const result = await new Promise<{ code: number | null; out: string; err: string }>(
      (resolve, reject) => {
        const child = spawn("lobster", ["run", "--mode", "tool", "noop"], {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (d) => {
          out += String(d);
        });
        child.stderr?.on("data", (d) => {
          err += String(d);
        });
        child.once("error", (e) => {
          reject(e);
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `timeout out=${out} err=${err} path=${process.env.PATH} node_options=${process.env.NODE_OPTIONS ?? ""}`,
            ),
          );
        }, 1200);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, out, err });
        });
      },
    );

    process.env.PATH = oldPath;
    expect(result.code).toBe(0);
    expect(result.out).toContain("ok");
  }, 10_000);

  it("spawns node directly", async () => {
    const result = await new Promise<{ code: number | null; out: string; err: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["-e", 'process.stdout.write("node-ok")'], {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (d) => {
          out += String(d);
        });
        child.stderr?.on("data", (d) => {
          err += String(d);
        });
        child.once("error", (e) => reject(e));
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`node timeout out=${out} err=${err}`));
        }, 1200);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, out, err });
        });
      },
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("node-ok");
  });
});
