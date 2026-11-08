/**
 * Cache de lecture du journal et maintenance des bornes en mode `off`.
 * Les tests utilisent un répertoire de données isolé, sans réseau.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import {
  compactCallsLog,
  logCall,
  readAllCallsLog,
  readCallsLog,
  type CallLogEntry,
} from "../src/llm/calls-log.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => {
  env.cleanup();
});

function logFile(): string {
  return join(env.dir, "calls.jsonl");
}

function entry(callId: string, ts = new Date().toISOString()): CallLogEntry {
  return {
    ts,
    callId,
    service: "chat",
    attempt: 0,
    provider: "p1",
    model: "model-a",
    result: "ok",
    durationMs: 10,
  };
}

function seed(entries: CallLogEntry[]): void {
  writeFileSync(logFile(), `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`, { mode: 0o600 });
}

function rawEntries(): CallLogEntry[] {
  if (!existsSync(logFile())) return [];
  return readFileSync(logFile(), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CallLogEntry);
}

describe("journal d'appels — cache de lecture", () => {
  it("renvoie des copies distinctes et invalide le cache après un append", () => {
    seed([entry("one"), entry("two")]);

    const first = readAllCallsLog();
    const second = readAllCallsLog();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);

    // Un appelant peut trier son tableau sans modifier le contenu caché.
    first.reverse();
    expect(readAllCallsLog().map((item) => item.callId)).toEqual(["one", "two"]);

    logCall(entry("three"));
    const afterAppend = readAllCallsLog();
    expect(afterAppend).toHaveLength(3);
    expect(afterAppend.map((item) => item.callId)).toEqual(["one", "two", "three"]);
  });
});

describe("journal d'appels — maintenance en mode off", () => {
  it("la purge d'ÂGE s'applique hors du chemin d'écriture (timer de rétention → compactCallsLog)", () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_CALLS_LOG_MODE: "off", SWITCHY_CALLS_LOG_RETENTION_DAYS: "1" });
    const now = Date.now();
    seed([
      entry("old", new Date(now - 2 * 86_400_000).toISOString()),
      entry("fresh", new Date(now - 60_000).toISOString()),
    ]);

    // Le chemin d'écriture n'ajoute rien et NE purge PAS l'âge (compaction
    // complète interdite à chaque tentative) : c'est `compactCallsLog` —
    // appelée par le timer de rétention — qui purge.
    logCall(entry("not-logged", new Date(now).toISOString()));
    expect(rawEntries().map((item) => item.callId)).toEqual(["old", "fresh"]);

    compactCallsLog(now);
    expect(rawEntries().map((item) => item.callId)).toEqual(["fresh"]);
  });

  it("applique la borne de nombre sans journaliser le nouvel appel", () => {
    env.cleanup();
    env = makeTestEnv({
      SWITCHY_CALLS_LOG_MODE: "off",
      SWITCHY_CALLS_LOG_MAX_ENTRIES: "3",
      SWITCHY_CALLS_LOG_RETENTION_DAYS: "0",
    });
    seed(["one", "two", "three", "four", "five"].map((callId) => entry(callId)));

    logCall(entry("not-logged"));

    const entries = rawEntries();
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries.map((item) => item.callId)).toEqual(["four", "five"]);
  });
});

describe("journal d'appels — non-régression", () => {
  it("conserve append + compaction et renvoie toujours les entrées récentes d'abord", () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_CALLS_LOG_MAX_ENTRIES: "3", SWITCHY_CALLS_LOG_RETENTION_DAYS: "0" });
    seed(["one", "two", "three"].map((callId) => entry(callId)));

    logCall(entry("four"));

    expect(rawEntries().map((item) => item.callId)).toEqual(["three", "four"]);
    const page = readCallsLog({ limit: 10 });
    expect(page.total).toBe(2);
    expect(page.entries.map((item) => item.callId)).toEqual(["four", "three"]);
    // Le tri décroissant de la pagination ne doit pas inverser le cache.
    expect(readAllCallsLog().map((item) => item.callId)).toEqual(["three", "four"]);
  });
});
