import { App, FileSystemAdapter } from "obsidian";

export interface HermesHookStatusState {
  statusMtimeMs: number;
  pollTimer: number | null;
  watchHandle: { close: () => void } | null;
}

interface HermesHookStatusPayload {
  schema?: number;
  source?: string;
  tabId?: string;
  state?: string;
  pid?: number;
  updatedAtMs?: number;
}

export interface HermesHookExitStatus {
  /** `false` idle, `true` busy, `null` missing or stale. */
  busy: boolean | null;
  pid: number | null;
}

const UNKNOWN_EXIT_STATUS: HermesHookExitStatus = { busy: null, pid: null };

export function resolveHermesHookStatusDir(app: App): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    const pathMod = window.require("path") as { join: (...parts: string[]) => string };
    return pathMod.join(adapter.getBasePath(), ".obsidian", "hermes", "runtime");
  }
  return "";
}

export function hermesHookStatusFilePath(statusDir: string, tabId: string): string {
  if (!statusDir) return "";
  const pathMod = window.require("path") as { join: (...parts: string[]) => string };
  return pathMod.join(statusDir, `${tabId}.json`);
}

export function createHermesHookStatusState(): HermesHookStatusState {
  return {
    statusMtimeMs: 0,
    pollTimer: null,
    watchHandle: null,
  };
}

function readStatusPayload(filePath: string, tabId: string): HermesHookStatusPayload | null {
  if (!filePath) return null;
  try {
    const fs = window.require("fs") as {
      readFileSync: (path: string, encoding: string) => string;
    };
    return parseHermesHookStatusPayload(fs.readFileSync(filePath, "utf8"), tabId);
  } catch {
    return null;
  }
}

function parseHermesHookStatusPayload(raw: string, tabId: string): HermesHookStatusPayload | null {
  try {
    const payload = JSON.parse(raw) as HermesHookStatusPayload;
    if (!payload || typeof payload !== "object") return null;
    if (
      payload.schema !== 1
      || payload.source !== "hermes-obsidian-status"
      || payload.tabId !== tabId
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function readHermesHookBusyStatus(filePath: string, tabId: string): boolean | null {
  const payload = readStatusPayload(filePath, tabId);
  if (!payload) return null;
  if (payload.state === "busy") return true;
  if (payload.state === "idle") return false;
  return null;
}

/**
 * Status used to decide a graceful Ctrl+D. Idle/busy is returned only with a
 * positive pid and a timestamp, so a partial or stale file is `busy: null`
 * rather than a cached "not busy".
 */
export function readHermesHookExitStatus(filePath: string, tabId: string): HermesHookExitStatus {
  const payload = readStatusPayload(filePath, tabId);
  if (!payload) return UNKNOWN_EXIT_STATUS;
  const updatedAtMs = payload.updatedAtMs;
  const fresh = typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs) && updatedAtMs > 0;
  const pid = typeof payload.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
    ? payload.pid
    : null;
  if (!fresh || pid == null) return UNKNOWN_EXIT_STATUS;
  if (payload.state === "busy") return { busy: true, pid };
  if (payload.state === "idle") return { busy: false, pid };
  return UNKNOWN_EXIT_STATUS;
}
