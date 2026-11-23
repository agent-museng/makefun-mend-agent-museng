// runner.ts — the make.fun environment runner for mend.
//
// When MAKEFUN_ENV_URL is set, main.ts hands over to this module.
// The runner fetches the check list from the environment server,
// runs main.ts once per check in a fresh directory (without the
// environment variable, 10 seconds per check), and posts the results
// back. Checks run one at a time, in the order listed.
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_FILES_PER_RESULT = 64;
const CHECK_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 20;

interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

interface CheckResult {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

function readTree(root: string): Record<string, string> {
  const outMap: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel === "" ? e.name : rel + "/" + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, p);
      } else if (e.isFile()) {
        try {
          outMap[p] = fs.readFileSync(full, "utf8");
        } catch {
          // unreadable: skip
        }
      }
    }
  };
  walk(root, "");
  return outMap;
}

function httpJson(
  url: string,
  method: string,
  body: string | null,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers:
          body === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function runOne(check: Check, mainPath: string): Promise<CheckResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-check-"));
  try {
    for (const [p, content] of Object.entries(check.files)) {
      const full = path.join(dir, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const child = spawn(process.execPath, [mainPath, ...check.argv], {
      cwd: dir,
      env: env as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on("data", (c: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        const take = Math.min(c.length, MAX_STDOUT_BYTES - stdoutBytes);
        stdoutChunks.push(c.subarray(0, take));
        stdoutBytes += take;
      }
    });
    child.stderr.on("data", () => {
      // stderr is not reported; discard it.
    });
    if (check.stdin !== null) {
      child.stdin.write(check.stdin);
    }
    child.stdin.end();
    const exitCode = await new Promise<number>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve(124);
        }
      }, CHECK_TIMEOUT_MS);
      child.on("close", (code: number | null) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(code === null ? 1 : code);
        }
      });
      child.on("error", () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(1);
        }
      });
    });
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const files = readTree(dir);
    const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    const capped: Record<string, string> = {};
    for (const name of names.slice(0, MAX_FILES_PER_RESULT)) capped[name] = files[name];
    return { id: check.id, exit: exitCode, stdout, files: capped };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

export async function run(envUrl: string): Promise<number> {
  const base = envUrl.replace(/\/$/, "");
  let listText: string;
  try {
    const res = await httpJson(base + "/checks", "GET", null);
    if (res.status !== 200) {
      process.stderr.write(`GET /checks failed: ${res.status} ${res.text}\n`);
      return 1;
    }
    listText = res.text;
  } catch (err) {
    process.stderr.write(`GET /checks error: ${String(err)}\n`);
    return 1;
  }
  let checks: Check[];
  try {
    const parsed = JSON.parse(listText) as { checks: Check[] };
    checks = parsed.checks;
    if (!Array.isArray(checks)) throw new Error("no checks array");
  } catch (err) {
    process.stderr.write(`bad /checks body: ${String(err)}\n`);
    return 1;
  }
  const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runOne(check, mainPath));
  }
  for (let start = 0; start < results.length; start += BATCH_SIZE) {
    const batch = results.slice(start, start + BATCH_SIZE);
    const body = JSON.stringify({ results: batch });
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await httpJson(base + "/results", "POST", body);
        if (res.status === 200) {
          ok = true;
        } else {
          process.stderr.write(`POST /results failed (${res.status}): ${res.text}\n`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      } catch (err) {
        process.stderr.write(`POST /results error: ${String(err)}\n`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (!ok) return 1;
  }
  return 0;
}
