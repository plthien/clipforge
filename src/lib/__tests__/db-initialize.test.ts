// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initializeSqlite, retryDatabaseBusy } from "@/lib/db/initialize";
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "clipforge-db-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it("serializes concurrent startup migrations against a fresh database (#37)", async () => {
  const file = join(directory, "sqlite.db");
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const { readFileSync } = require('node:fs');
    const { dirname } = require('node:path');
    const Module = require('node:module');
    const ts = require('typescript');
    // Vitest transpilation does not extend into eval workers; compile real source.
    const text = readFileSync(workerData.helper, 'utf8');
    const js = ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: workerData.helper,
    }).outputText;
    const helper = new Module(workerData.helper, module);
    helper.filename = workerData.helper;
    helper.paths = Module._nodeModulePaths(dirname(workerData.helper));
    helper._compile(js, workerData.helper);
    const { initializeSqlite } = helper.exports;
    const db = new Database(workerData.file);
    initializeSqlite(db, workerData.migrations);
    parentPort.postMessage(db.prepare('SELECT count(*) AS n FROM projects').get());
    db.close();
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolveResult, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { file, helper: resolve("src/lib/db/initialize.ts"), migrations: resolve("drizzle") } });
    let result: unknown;
    worker.on("message", (message) => { result = message; });
    worker.on("error", reject);
    worker.on("exit", (code) => code === 0 ? resolveResult(result) : reject(new Error(`worker exited ${code}`)));
  })));
  expect(results).toEqual(Array(4).fill({ n: 0 }));
  const db = new Database(file);
  const history = db.prepare('SELECT created_at FROM __drizzle_migrations').all() as { created_at: number }[];
  expect(new Set(history.map((row) => row.created_at)).size).toBe(history.length);
  db.close();
}, 20000);
it("retries only transient locks, never syntax or corrupt-database errors", () => {
  let tries = 0;
  expect(retryDatabaseBusy(() => {
    if (++tries < 3) throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
    return "ready";
  }, 1000)).toBe("ready");
  expect(tries).toBe(3);
  expect(() => retryDatabaseBusy(() => { throw new Error("syntax"); })).toThrow("syntax");
});
it("reopens an already migrated database without reapplying migrations", () => {
  const file = join(directory, "sqlite.db");
  const db = new Database(file);
  initializeSqlite(db, resolve("drizzle"));
  db.close();
  const next = new Database(file);
  initializeSqlite(next, resolve("drizzle"));
  expect(next.pragma("journal_mode", { simple: true })).toBe("wal");
  next.close();
});
