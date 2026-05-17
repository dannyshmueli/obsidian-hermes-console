import { FuzzySuggestModal, Notice } from "obsidian";
import type TerminalPlugin from "./main";
import type { RecentSession, SavedTab } from "./session-state";
import type { CreateTabOpts } from "./terminal-tab-manager";
import { openTabOrView } from "./terminal-opener";
import {
  scanHermesSessions,
  getVaultBasePath,
  type HermesSessionEntry,
} from "./hermes-sessions";

/**
 * Push a closed tab onto the recents ring buffer, trimmed to the configured max.
 * Called from TerminalTabManager via the onSessionClose callback.
 */
export async function pushRecentSession(plugin: TerminalPlugin, tab: SavedTab): Promise<void> {
  const max = plugin.settings.recentSessionsMax;
  if (max <= 0) return;

  const entry: RecentSession = { ...tab, closedAt: Date.now() };
  plugin.settings.recentSessions.unshift(entry);
  if (plugin.settings.recentSessions.length > max) {
    plugin.settings.recentSessions.splice(max);
  }
  await plugin.saveSettings();
}

/** Open the closed-terminal-tab rescue picker. This restores scrollback, not Hermes state. */
export async function openRecentTerminalSessionPicker(plugin: TerminalPlugin): Promise<void> {
  const recents = plugin.settings.recentSessions;

  if (recents.length === 0) {
    new Notice("No closed terminal tabs to restore.");
    return;
  }

  const items: RecentSession[] = [...recents].sort((a, b) => b.closedAt - a.closedAt);
  new RecentTerminalSessionPicker(plugin, items).open();
}

/**
 * Open the Hermes CLI session picker.
 * Shows live `hermes sessions list` entries only, then starts a fresh terminal tab
 * with `hermes --resume <session-id>`. It does not replay terminal scrollback.
 */
export async function openHermesSessionPicker(plugin: TerminalPlugin): Promise<void> {
  if (!plugin.settings.enableClaudeIntegration) {
    new Notice("Hermes session integration is disabled in settings.");
    return;
  }

  let hermesEntries: HermesSessionEntry[] = [];
  hermesEntries = await scanHermesSessions(plugin.settings.claudeSessionsMax);

  if (hermesEntries.length === 0) {
    new Notice("No recent Hermes sessions to restore.");
    return;
  }

  new HermesSessionPicker(plugin, hermesEntries).open();
}

export type RestoreSessionItem =
  | { kind: "hermes"; entry: HermesSessionEntry }
  | { kind: "terminal"; session: RecentSession };

/**
 * Open one restore picker from the command palette. User sees one door; choosing an item
 * still dispatches to the correct backend action.
 */
export async function openRestoreSessionPicker(plugin: TerminalPlugin): Promise<void> {
  const hermesEntries = plugin.settings.enableClaudeIntegration
    ? await scanHermesSessions(plugin.settings.claudeSessionsMax)
    : [];
  const items = createRestoreSessionItems(hermesEntries, plugin.settings.recentSessions);

  if (items.length === 0) {
    new Notice("No terminal tabs or Hermes sessions to restore.");
    return;
  }

  new RestoreSessionPicker(plugin, items).open();
}

export function createRestoreSessionItems(
  hermesEntries: HermesSessionEntry[],
  terminalSessions: RecentSession[]
): RestoreSessionItem[] {
  const items: RestoreSessionItem[] = [];
  items.push(...hermesEntries.map((entry) => ({ kind: "hermes" as const, entry })));
  items.push(
    ...[...terminalSessions]
      .sort((a, b) => b.closedAt - a.closedAt)
      .map((session) => ({ kind: "terminal" as const, session }))
  );
  return items;
}

export function getRestoreSessionItemText(item: RestoreSessionItem, now = Date.now()): string {
  if (item.kind === "hermes") {
    const title = item.entry.title || `(${item.entry.sessionId.slice(0, 8)})`;
    const when = item.entry.lastActive || "unknown";
    return `Hermes session: ${title} — ${item.entry.preview || "no preview"} (${when})`;
  }

  const age = relativeTime(now - item.session.closedAt);
  return `Closed terminal tab: ${item.session.name} - ${item.session.cwd} (${age})`;
}

class RestoreSessionPicker extends FuzzySuggestModal<RestoreSessionItem> {
  private plugin: TerminalPlugin;
  private items: RestoreSessionItem[];

  constructor(plugin: TerminalPlugin, items: RestoreSessionItem[]) {
    super(plugin.app);
    this.plugin = plugin;
    this.items = items;
    this.setPlaceholder("Pick a terminal tab or Hermes session to restore…");
  }

  getItems(): RestoreSessionItem[] {
    return this.items;
  }

  getItemText(item: RestoreSessionItem): string {
    return getRestoreSessionItemText(item);
  }

  onChooseItem(item: RestoreSessionItem): void {
    if (item.kind === "hermes") {
      void restoreHermes(this.plugin, item.entry);
      return;
    }

    void restoreRecentTerminal(this.plugin, item.session);
  }
}

class RecentTerminalSessionPicker extends FuzzySuggestModal<RecentSession> {
  private plugin: TerminalPlugin;
  private items: RecentSession[];

  constructor(plugin: TerminalPlugin, items: RecentSession[]) {
    super(plugin.app);
    this.plugin = plugin;
    this.items = items;
    this.setPlaceholder("Pick a closed terminal tab to restore…");
  }

  getItems(): RecentSession[] {
    return this.items;
  }

  getItemText(s: RecentSession): string {
    const age = relativeTime(Date.now() - s.closedAt);
    return `${s.name} - ${s.cwd} (${age})`;
  }

  onChooseItem(session: RecentSession): void {
    void restoreRecentTerminal(this.plugin, session);
  }
}

class HermesSessionPicker extends FuzzySuggestModal<HermesSessionEntry> {
  private plugin: TerminalPlugin;
  private items: HermesSessionEntry[];

  constructor(plugin: TerminalPlugin, items: HermesSessionEntry[]) {
    super(plugin.app);
    this.plugin = plugin;
    this.items = items;
    this.setPlaceholder("Pick a Hermes session to resume…");
  }

  getItems(): HermesSessionEntry[] {
    return this.items;
  }

  getItemText(s: HermesSessionEntry): string {
    const title = s.title || `(${s.sessionId.slice(0, 8)})`;
    const when = s.lastActive || "unknown";
    return `${title} — ${s.preview || "no preview"} (${when})`;
  }

  onChooseItem(entry: HermesSessionEntry): void {
    void restoreHermes(this.plugin, entry);
  }
}

/**
 * Restore a recent terminal session: create a tab (or open a view) with the saved state.
 * Consumes the entry from recents — closing the tab again will re-add it.
 */
async function restoreRecentTerminal(plugin: TerminalPlugin, session: RecentSession): Promise<void> {
  const idx = plugin.settings.recentSessions.findIndex(
    (s) => s.closedAt === session.closedAt && s.name === session.name
  );
  if (idx >= 0) {
    plugin.settings.recentSessions.splice(idx, 1);
    await plugin.saveSettings();
  }

  const opts = createRecentTerminalRestoreTabOptions(session);
  await openTabOrView(plugin, opts);
}

export function createRecentTerminalRestoreTabOptions(session: RecentSession): CreateTabOpts {
  return {
    name: session.name,
    color: session.color,
    cwd: session.cwd,
    bufferSerial: session.bufferSerial,
    restored: true,
  };
}

/** Restore a Hermes session by running `hermes --resume <id>` in a new tab. */
async function restoreHermes(plugin: TerminalPlugin, entry: HermesSessionEntry): Promise<void> {
  await openTabOrView(plugin, createHermesResumeTabOptions(plugin, entry));
}

export function createHermesResumeTabOptions(plugin: TerminalPlugin, entry: HermesSessionEntry): CreateTabOpts {
  return {
    name: `Hermes ${entry.sessionId.slice(0, 8)}`,
    color: "",
    cwd: getVaultBasePath(plugin),
    resumeCommand: `hermes --resume ${entry.sessionId}`,
  };
}

export function relativeTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec <= 1 ? "just now" : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
