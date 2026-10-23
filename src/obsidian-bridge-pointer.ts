import type { App } from "obsidian";

import { resolveObsidianContextBridgePath } from "./obsidian-context-bridge";

/**
 * Bridge **pointer** file: a vault-independent address book for bridge files.
 *
 * The per-vault bridge file (`<vault>/<configDir>/hermes/context.json`) is only
 * reachable by the Hermes process when that process inherited the PTY
 * environment, because the Obsidian half passes the path through
 * `OBSIDIAN_CONTEXT_BRIDGE_PATH`. Any process boundary in between (a Hermes
 * gateway running as a service, a container, a remote backend, a cron/webhook
 * turn) drops that variable, and a hard-coded fallback cannot know which vault
 * the user is working in.
 *
 * This file closes that gap: the Obsidian half writes the currently active
 * vault's bridge path to a **fixed** location under the user's config home, so
 * a Hermes-side reader can discover it without any inherited environment and
 * without per-user configuration.
 *
 * Layout:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "source": "hermes-console",
 *   "updatedAt": "2026-10-23T09:40:00.000Z",
 *   "entries": [
 *     {
 *       "vaultPath": "/abs/path/to/vault",
 *       "configDir": ".obsidian",
 *       "tabId": "terminal-2",
 *       "tabTitle": "Hermes 1",
 *       "bridgePath": "/abs/path/to/vault/.obsidian/hermes/context.json",
 *       "updatedAt": "2026-10-23T09:40:00.000Z",
 *       "updateTimestamp": 1792744486400,
 *       "submitSequence": 15
 *     }
 *   ]
 * }
 * ```
 *
 * Keyed by `vaultPath` (one entry per vault: the bridge file itself is
 * per-vault, not per-tab), ordered newest first, capped at
 * {@link BRIDGE_POINTER_MAX_ENTRIES}. Writes are atomic (tmp + rename) so a
 * reader never observes a half-written file; every read is defensive, so a
 * missing or corrupt pointer file simply degrades to "no pointer available".
 */

export const OBSIDIAN_BRIDGE_POINTER_SCHEMA_VERSION = 1;
export const OBSIDIAN_BRIDGE_POINTER_SOURCE = "hermes-console";
export const BRIDGE_POINTER_MAX_ENTRIES = 16;
export const BRIDGE_POINTER_DIR_NAME = "hermes-console";
export const BRIDGE_POINTER_FILE_NAME = "bridge.json";

export type ObsidianBridgePointerEntry = {
  /** Absolute vault root the bridge file belongs to. Entry key. */
  vaultPath: string;
  /** Vault config folder (Obsidian's `vault.configDir`), e.g. `.obsidian`. */
  configDir: string;
  /** Terminal tab that most recently refreshed this entry. */
  tabId: string;
  tabTitle: string;
  /** Absolute path of `<vault>/<configDir>/hermes/context.json`. */
  bridgePath: string;
  updatedAt: string;
  updateTimestamp: number;
  submitSequence: number;
};

export type ObsidianBridgePointerFile = {
  schemaVersion: 1;
  source: "hermes-console";
  updatedAt: string;
  entries: ObsidianBridgePointerEntry[];
};

/**
 * Where the pointer file lives: the user's config home, i.e. outside any vault
 * and outside Hermes' home, so both halves can compute it independently.
 *
 * `$XDG_CONFIG_HOME/hermes-console/bridge.json`, falling back to
 * `~/.config/hermes-console/bridge.json`. The Hermes-side reader implements the
 * exact same rule (see `hermes/__init__.py::_resolve_bridge_path`), which is
 * the only contract between the two halves.
 *
 * `TMPDIR`-style overrides are deliberately not read: an override that only one
 * side knows about would silently stop working, which is the very failure this
 * module exists to remove.
 */
export function resolveBridgePointerPath(opts: {
  env?: Record<string, string | undefined>;
  home?: string;
} = {}): string {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const home = opts.home ?? getRuntimeRequire()("os").homedir();
  const xdgConfigHome = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome = xdgConfigHome.length > 0 ? xdgConfigHome : joinPath(home, ".config");
  return joinPath(configHome, BRIDGE_POINTER_DIR_NAME, BRIDGE_POINTER_FILE_NAME);
}

/** Pointer entry for the vault `app` is currently running in. */
export function buildBridgePointerEntry(opts: {
  app: App;
  tabId: string;
  tabTitle: string;
  submitSequence: number;
  now?: Date;
}): ObsidianBridgePointerEntry {
  const now = opts.now ?? new Date();
  const vaultPath = getVaultBasePath(opts.app);
  const configDir = readConfigDir(opts.app);
  return {
    vaultPath,
    configDir,
    tabId: opts.tabId,
    tabTitle: opts.tabTitle,
    bridgePath: resolveObsidianContextBridgePath(opts.app),
    updatedAt: now.toISOString(),
    updateTimestamp: now.getTime(),
    submitSequence: opts.submitSequence,
  };
}

/**
 * Insert or replace `entry` (keyed by `vaultPath`), newest first, capped at
 * `maxEntries`. Pure function: callers own persistence.
 */
export function upsertBridgePointerEntry(
  file: ObsidianBridgePointerFile | null,
  entry: ObsidianBridgePointerEntry,
  opts: { maxEntries?: number } = {},
): ObsidianBridgePointerFile {
  const maxEntries = opts.maxEntries ?? BRIDGE_POINTER_MAX_ENTRIES;
  const kept = (file?.entries ?? []).filter((candidate) => candidate.vaultPath !== entry.vaultPath);
  const entries = [entry, ...kept]
    .sort((a, b) => b.updateTimestamp - a.updateTimestamp)
    .slice(0, Math.max(1, maxEntries));
  return {
    schemaVersion: OBSIDIAN_BRIDGE_POINTER_SCHEMA_VERSION,
    source: OBSIDIAN_BRIDGE_POINTER_SOURCE,
    updatedAt: entry.updatedAt,
    entries,
  };
}

/** Drop the entry for `vaultPath` (vault closed / unloaded). Returns the rest. */
export function removeBridgePointerEntry(
  file: ObsidianBridgePointerFile | null,
  vaultPath: string,
): ObsidianBridgePointerFile | null {
  if (!file) return null;
  const entries = file.entries.filter((entry) => entry.vaultPath !== vaultPath);
  if (entries.length === file.entries.length) return file;
  return { ...file, entries };
}

export function parseBridgePointerFile(raw: string): ObsidianBridgePointerFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ObsidianBridgePointerFile>;
    if (parsed?.schemaVersion !== OBSIDIAN_BRIDGE_POINTER_SCHEMA_VERSION) return null;
    if (parsed.source !== OBSIDIAN_BRIDGE_POINTER_SOURCE) return null;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(isBridgePointerEntry)
      : [];
    return {
      schemaVersion: OBSIDIAN_BRIDGE_POINTER_SCHEMA_VERSION,
      source: OBSIDIAN_BRIDGE_POINTER_SOURCE,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      entries,
    };
  } catch {
    return null;
  }
}

/** Newest entry first; `null` when the pointer file is absent or unusable. */
export function readBridgePointerFileSync(pointerPath = resolveBridgePointerPath()): ObsidianBridgePointerFile | null {
  try {
    // Direct Node fs access, mirroring the bridge writer: the pointer file lives
    // outside the vault on purpose, so Obsidian's vault adapter cannot reach it.
    const fs = getRuntimeRequire()("fs") as typeof import("fs");
    return parseBridgePointerFile(fs.readFileSync(pointerPath, "utf8"));
  } catch {
    return null;
  }
}

export function writeBridgePointerFileSync(
  file: ObsidianBridgePointerFile,
  pointerPath = resolveBridgePointerPath(),
): void {
  const fs = getRuntimeRequire()("fs") as typeof import("fs");
  const path = getRuntimeRequire()("path") as typeof import("path");
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  // Atomic replace: a Hermes reader may poll this file at any moment, and a
  // truncated JSON document would read as "no pointer" and lose the vault.
  const tmpPath = `${pointerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, pointerPath);
}

/**
 * Read → upsert → write, with every failure swallowed.
 *
 * This runs on the Enter path, so it must never break prompt submission: a
 * pointer file that cannot be written only costs the environment-independent
 * discovery path, not the feature itself.
 */
export function recordBridgePointerEntrySync(
  entry: ObsidianBridgePointerEntry,
  opts: { pointerPath?: string; maxEntries?: number } = {},
): boolean {
  try {
    const pointerPath = opts.pointerPath ?? resolveBridgePointerPath();
    const merged = upsertBridgePointerEntry(readBridgePointerFileSync(pointerPath), entry, opts);
    writeBridgePointerFileSync(merged, pointerPath);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort pruning when a vault is closed. */
export function removeBridgePointerEntrySync(
  vaultPath: string,
  opts: { pointerPath?: string } = {},
): boolean {
  if (!vaultPath) return false;
  try {
    const pointerPath = opts.pointerPath ?? resolveBridgePointerPath();
    const current = readBridgePointerFileSync(pointerPath);
    const pruned = removeBridgePointerEntry(current, vaultPath);
    if (!pruned || pruned === current) return false;
    writeBridgePointerFileSync(pruned, pointerPath);
    return true;
  } catch {
    return false;
  }
}

function isBridgePointerEntry(value: unknown): value is ObsidianBridgePointerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ObsidianBridgePointerEntry>;
  return (
    typeof entry.vaultPath === "string" &&
    entry.vaultPath.length > 0 &&
    typeof entry.configDir === "string" &&
    typeof entry.tabId === "string" &&
    typeof entry.tabTitle === "string" &&
    typeof entry.bridgePath === "string" &&
    entry.bridgePath.length > 0 &&
    typeof entry.updatedAt === "string" &&
    typeof entry.updateTimestamp === "number" &&
    Number.isFinite(entry.updateTimestamp) &&
    typeof entry.submitSequence === "number"
  );
}

function readConfigDir(app: App): string {
  const configDir = (app as App & { vault?: { configDir?: string } }).vault?.configDir;
  return typeof configDir === "string" && configDir.length > 0 ? configDir : ".obsidian";
}

function getVaultBasePath(app: App): string {
  try {
    const adapter = (app as App & { vault?: { adapter?: { getBasePath?: () => string } } }).vault?.adapter;
    return adapter?.getBasePath?.() || "";
  } catch {
    return "";
  }
}

function joinPath(...parts: string[]): string {
  const path = getRuntimeRequire()("path") as typeof import("path");
  return path.join(...parts.filter((part) => part.length > 0));
}

function getRuntimeRequire(): NodeRequire {
  const winRequire = typeof window !== "undefined"
    ? (window as unknown as { require?: NodeRequire }).require
    : undefined;
  if (winRequire) return winRequire;
  return require;
}
