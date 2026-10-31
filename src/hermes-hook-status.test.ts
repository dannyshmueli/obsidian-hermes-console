import { afterEach, describe, expect, it } from "vitest";

import { readHermesHookBusyStatus, readHermesHookExitStatus } from "./hermes-hook-status";

const TAB = "terminal-1";

function withStatusFile(readFileSync: (path: string, encoding: string) => string): void {
  (globalThis as { window?: { require: (id: string) => unknown } }).window = {
    require: (id: string) => {
      if (id !== "fs") throw new Error(id);
      return { readFileSync };
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("readHermesHookExitStatus", () => {
  it("returns null busy for an empty path without reading", () => {
    expect(readHermesHookExitStatus("", TAB)).toEqual({ busy: null, pid: null });
    expect(readHermesHookBusyStatus("", TAB)).toBeNull();
  });

  it("returns null busy when the status file is missing", () => {
    withStatusFile(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: null, pid: null });
    expect(readHermesHookBusyStatus("/tmp/terminal-1.json", TAB)).toBeNull();
  });

  it("returns null busy for a stale idle payload that has no pid or timestamp", () => {
    const raw = JSON.stringify({
      schema: 1,
      source: "hermes-obsidian-status",
      tabId: TAB,
      state: "idle",
    });
    withStatusFile(() => raw);
    // The spinner helper still treats a bare idle state as not busy.
    expect(readHermesHookBusyStatus("/tmp/terminal-1.json", TAB)).toBe(false);
    // The close decision must not: this reading cannot prove a live Hermes.
    expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: null, pid: null });
  });

  it("returns null busy when the timestamp or pid is unusable", () => {
    for (const extra of [{ updatedAtMs: 0, pid: 42 }, { updatedAtMs: 10, pid: 1.5 }, { updatedAtMs: 10, pid: -3 }]) {
      const raw = JSON.stringify({
        schema: 1,
        source: "hermes-obsidian-status",
        tabId: TAB,
        state: "idle",
        ...extra,
      });
      withStatusFile(() => raw);
      expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: null, pid: null });
    }
  });

  it("returns idle or busy only for a fresh payload with a pid", () => {
    const idle = JSON.stringify({
      schema: 1,
      source: "hermes-obsidian-status",
      tabId: TAB,
      state: "idle",
      pid: 42,
      updatedAtMs: 1_700_000_000_000,
    });
    withStatusFile(() => idle);
    expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: false, pid: 42 });
    expect(readHermesHookBusyStatus("/tmp/terminal-1.json", TAB)).toBe(false);

    const busy = JSON.stringify({
      schema: 1,
      source: "hermes-obsidian-status",
      tabId: TAB,
      state: "busy",
      pid: 42,
      updatedAtMs: 1_700_000_000_000,
    });
    withStatusFile(() => busy);
    expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: true, pid: 42 });
    expect(readHermesHookBusyStatus("/tmp/terminal-1.json", TAB)).toBe(true);
  });

  it("returns null busy for the wrong tab or invalid JSON", () => {
    const raw = JSON.stringify({
      schema: 1,
      source: "hermes-obsidian-status",
      tabId: "other",
      state: "idle",
      pid: 42,
      updatedAtMs: 10,
    });
    withStatusFile(() => raw);
    expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: null, pid: null });
    withStatusFile(() => "{");
    expect(readHermesHookExitStatus("/tmp/terminal-1.json", TAB)).toEqual({ busy: null, pid: null });
    expect(readHermesHookBusyStatus("/tmp/terminal-1.json", TAB)).toBeNull();
  });
});
