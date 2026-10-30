import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The module under test reaches Node built-ins through the runtime `require`
// (Obsidian's Electron renderer has no ESM loader). In a vitest ESM process
// there is no ambient `require`, so provide one.
vi.stubGlobal("require", createRequire(import.meta.url));

import type { App } from "obsidian";

import {
  BRIDGE_POINTER_MAX_ENTRIES,
  buildBridgePointerEntry,
  parseBridgePointerFile,
  readBridgePointerFileSync,
  recordBridgePointerEntrySync,
  removeBridgePointerEntrySync,
  resolveBridgePointerPath,
  upsertBridgePointerEntry,
  writeBridgePointerFileSync,
} from "./obsidian-bridge-pointer";
import type { ObsidianBridgePointerEntry, ObsidianBridgePointerFile } from "./obsidian-bridge-pointer";

const entry = (overrides: Partial<ObsidianBridgePointerEntry> = {}): ObsidianBridgePointerEntry => ({
  vaultPath: "/vaults/one",
  configDir: ".obsidian",
  tabId: "terminal-2",
  tabTitle: "Hermes 1",
  bridgePath: "/vaults/one/.obsidian/hermes/context.json",
  updatedAt: "2026-10-23T09:40:00.000Z",
  updateTimestamp: Date.parse("2026-10-23T09:40:00.000Z"),
  submitSequence: 15,
  ...overrides,
});

describe("resolveBridgePointerPath", () => {
  it("defaults to ~/.config/hermes-console/bridge.json", () => {
    expect(resolveBridgePointerPath({ env: {}, home: "/home/u" })).toBe(
      path.join("/home/u", ".config", "hermes-console", "bridge.json"),
    );
  });

  it("honours XDG_CONFIG_HOME", () => {
    expect(resolveBridgePointerPath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/u" })).toBe(
      path.join("/xdg", "hermes-console", "bridge.json"),
    );
  });

  it("ignores a blank XDG_CONFIG_HOME", () => {
    expect(resolveBridgePointerPath({ env: { XDG_CONFIG_HOME: "   " }, home: "/home/u" })).toBe(
      path.join("/home/u", ".config", "hermes-console", "bridge.json"),
    );
  });
});

describe("upsertBridgePointerEntry", () => {
  it("creates a file from nothing", () => {
    const file = upsertBridgePointerEntry(null, entry());
    expect(file.schemaVersion).toBe(1);
    expect(file.source).toBe("hermes-console");
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].bridgePath).toBe("/vaults/one/.obsidian/hermes/context.json");
  });

  it("replaces the entry for the same vault (one entry per vault)", () => {
    const first = upsertBridgePointerEntry(null, entry({ submitSequence: 15 }));
    const second = upsertBridgePointerEntry(
      first,
      entry({ submitSequence: 16, tabId: "terminal-3", tabTitle: "Hermes 2" }),
    );
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].submitSequence).toBe(16);
    expect(second.entries[0].tabId).toBe("terminal-3");
  });

  it("orders entries newest first", () => {
    const older = entry({ vaultPath: "/vaults/old", updateTimestamp: 1_000, updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = entry({ vaultPath: "/vaults/new", updateTimestamp: 2_000, updatedAt: "2026-01-02T00:00:00.000Z" });
    const file = upsertBridgePointerEntry(upsertBridgePointerEntry(null, older), newer);
    expect(file.entries.map((candidate) => candidate.vaultPath)).toEqual(["/vaults/new", "/vaults/old"]);
    expect(file.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("caps the number of entries", () => {
    let file: ObsidianBridgePointerFile | null = null;
    for (let index = 0; index < BRIDGE_POINTER_MAX_ENTRIES + 4; index++) {
      file = upsertBridgePointerEntry(
        file,
        entry({
          vaultPath: `/vaults/${index}`,
          bridgePath: `/vaults/${index}/.obsidian/hermes/context.json`,
          updateTimestamp: index,
          updatedAt: new Date(index).toISOString(),
        }),
      );
    }
    expect(file?.entries).toHaveLength(BRIDGE_POINTER_MAX_ENTRIES);
    // Newest kept, oldest evicted.
    expect(file?.entries[0].vaultPath).toBe(`/vaults/${BRIDGE_POINTER_MAX_ENTRIES + 3}`);
    expect(file?.entries.map((candidate) => candidate.vaultPath)).not.toContain("/vaults/0");
  });
});

describe("parseBridgePointerFile", () => {
  it("round-trips a document", () => {
    const raw = JSON.stringify(upsertBridgePointerEntry(null, entry()), null, 2);
    const parsed = parseBridgePointerFile(raw);
    expect(parsed?.entries[0].vaultPath).toBe("/vaults/one");
    expect(parsed?.entries[0].updateTimestamp).toBe(Date.parse("2026-10-23T09:40:00.000Z"));
  });

  it("rejects malformed JSON, wrong schemaVersion and foreign sources", () => {
    expect(parseBridgePointerFile("{not json")).toBeNull();
    expect(parseBridgePointerFile(JSON.stringify({ schemaVersion: 2, source: "hermes-console", entries: [] }))).toBeNull();
    expect(parseBridgePointerFile(JSON.stringify({ schemaVersion: 1, source: "someone-else", entries: [] }))).toBeNull();
  });

  it("drops entries that are missing required fields", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      source: "hermes-console",
      updatedAt: "2026-10-23T09:40:00.000Z",
      entries: [entry(), { vaultPath: "/vaults/broken" }, null],
    });
    const parsed = parseBridgePointerFile(raw);
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.entries[0].vaultPath).toBe("/vaults/one");
  });
});

describe("pointer file I/O", () => {
  let dir: string;
  let pointerPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pointer-"));
    pointerPath = path.join(dir, "nested", "hermes-console", "bridge.json");
  });

  it("writes, creates missing parents and reads back", () => {
    writeBridgePointerFileSync(upsertBridgePointerEntry(null, entry()), pointerPath);
    expect(fs.existsSync(pointerPath)).toBe(true);
    expect(readBridgePointerFileSync(pointerPath)?.entries[0].tabId).toBe("terminal-2");
  });

  it("leaves no temp file behind (atomic replace)", () => {
    writeBridgePointerFileSync(upsertBridgePointerEntry(null, entry()), pointerPath);
    writeBridgePointerFileSync(upsertBridgePointerEntry(null, entry({ submitSequence: 99 })), pointerPath);
    const leftovers = fs.readdirSync(path.dirname(pointerPath)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(readBridgePointerFileSync(pointerPath)?.entries[0].submitSequence).toBe(99);
  });

  it("returns null for a missing or corrupt pointer file", () => {
    expect(readBridgePointerFileSync(path.join(dir, "nope.json"))).toBeNull();
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, "{ half-written", "utf8");
    expect(readBridgePointerFileSync(pointerPath)).toBeNull();
  });
});

describe("recordBridgePointerEntrySync", () => {
  let dir: string;
  let pointerPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-record-"));
    pointerPath = path.join(dir, "hermes-console", "bridge.json");
  });

  it("records the first entry and merges later ones", () => {
    expect(recordBridgePointerEntrySync(entry({ submitSequence: 15 }), { pointerPath })).toBe(true);
    expect(recordBridgePointerEntrySync(entry({ submitSequence: 16 }), { pointerPath })).toBe(true);
    const file = readBridgePointerFileSync(pointerPath);
    expect(file?.entries).toHaveLength(1);
    expect(file?.entries[0].submitSequence).toBe(16);
  });

  it("recovers from a corrupt pointer file instead of failing", () => {
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, "{ corrupt", "utf8");
    expect(recordBridgePointerEntrySync(entry(), { pointerPath })).toBe(true);
    expect(readBridgePointerFileSync(pointerPath)?.entries).toHaveLength(1);
  });

  it("keeps entries for different vaults side by side, newest first", () => {
    recordBridgePointerEntrySync(
      entry({
        vaultPath: "/vaults/a",
        bridgePath: "/vaults/a/.obsidian/hermes/context.json",
        updateTimestamp: 1_000,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      { pointerPath },
    );
    recordBridgePointerEntrySync(
      entry({
        vaultPath: "/vaults/b",
        bridgePath: "/vaults/b/.obsidian/hermes/context.json",
        updateTimestamp: 2_000,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      { pointerPath },
    );
    expect(readBridgePointerFileSync(pointerPath)?.entries.map((candidate) => candidate.vaultPath)).toEqual([
      "/vaults/b",
      "/vaults/a",
    ]);
  });
});

describe("removeBridgePointerEntrySync", () => {
  let dir: string;
  let pointerPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-prune-"));
    pointerPath = path.join(dir, "hermes-console", "bridge.json");
    recordBridgePointerEntrySync(entry({ vaultPath: "/vaults/a" }), { pointerPath });
    recordBridgePointerEntrySync(entry({ vaultPath: "/vaults/b" }), { pointerPath });
  });

  it("removes only the closed vault", () => {
    expect(removeBridgePointerEntrySync("/vaults/a", { pointerPath })).toBe(true);
    expect(readBridgePointerFileSync(pointerPath)?.entries.map((candidate) => candidate.vaultPath)).toEqual(["/vaults/b"]);
  });

  it("is a no-op for unknown vaults and empty input", () => {
    expect(removeBridgePointerEntrySync("/vaults/unknown", { pointerPath })).toBe(false);
    expect(removeBridgePointerEntrySync("", { pointerPath })).toBe(false);
    expect(readBridgePointerFileSync(pointerPath)?.entries).toHaveLength(2);
  });
});

describe("buildBridgePointerEntry", () => {
  const app = (vaultPath: string, configDir = ".obsidian") =>
    ({
      vault: { configDir, adapter: { getBasePath: () => vaultPath } },
    }) as unknown as App;

  it("derives vault, config dir and bridge path from the app", () => {
    const built = buildBridgePointerEntry({
      app: app("/vaults/shared"),
      tabId: "terminal-2",
      tabTitle: "Hermes 1",
      submitSequence: 7,
      now: new Date("2026-10-23T09:40:00.000Z"),
    });
    expect(built.vaultPath).toBe("/vaults/shared");
    expect(built.configDir).toBe(".obsidian");
    expect(built.bridgePath).toBe("/vaults/shared/.obsidian/hermes/context.json");
    expect(built.updateTimestamp).toBe(Date.parse("2026-10-23T09:40:00.000Z"));
    expect(built.submitSequence).toBe(7);
  });

  it("follows a custom vault config directory", () => {
    const built = buildBridgePointerEntry({
      app: app("/vaults/custom", "_obsidian"),
      tabId: "terminal-1",
      tabTitle: "Hermes",
      submitSequence: 1,
    });
    expect(built.bridgePath).toBe("/vaults/custom/_obsidian/hermes/context.json");
  });
});
