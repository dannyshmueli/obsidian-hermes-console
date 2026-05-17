import { Notice, FileSystemAdapter } from "obsidian";
import type TerminalPlugin from "./main";
import { openTabOrView } from "./terminal-opener";

export interface HermesSessionEntry {
  sessionId: string;
  title: string;
  preview: string;
  lastActive: string;
}

export async function scanHermesSessions(max: number): Promise<HermesSessionEntry[]> {
  const childProcess = window.require("child_process") as typeof import("child_process");
  const output = await new Promise<string>((resolve) => {
    childProcess.execFile("hermes", ["sessions", "list", "--limit", String(max)], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      resolve(stdout ?? "");
    });
  });
  return parseHermesSessionsList(output).slice(0, max);
}

export function parseHermesSessionsList(output: string): HermesSessionEntry[] {
  const entries: HermesSessionEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("Title") || line.startsWith("─")) continue;

    const idMatch = line.match(/(bg_[0-9a-f_]+|\d{8}_\d{6}_[0-9a-f]{6})\s*$/i);
    if (!idMatch) continue;

    const sessionId = idMatch[1];
    const beforeId = line.slice(0, idMatch.index).trimEnd();
    const activeMatch = beforeId.match(/\s+(just now|\d+s ago|\d+m ago|\d+h ago|\d+d ago|yesterday)$/i);
    const lastActive = activeMatch?.[1] ?? "";
    const beforeActive = activeMatch ? beforeId.slice(0, activeMatch.index).trimEnd() : beforeId;

    // `hermes sessions list` is fixed-width: title ~= 32 chars, preview ~= 40 chars.
    const title = beforeActive.slice(0, 32).trim() || "—";
    const preview = beforeActive.slice(32).trim();
    entries.push({ sessionId, title, preview, lastActive });
  }
  return entries;
}

export async function resumeHermesSession(plugin: TerminalPlugin, sessionId: string): Promise<void> {
  if (!plugin.settings.enableClaudeIntegration) {
    new Notice("Hermes session integration is disabled in settings.");
    return;
  }

  if (!/^(bg_[0-9a-f_]+|\d{8}_\d{6}_[0-9a-f]{6})$/i.test(sessionId)) {
    new Notice("Invalid Hermes session ID.");
    return;
  }

  await openTabOrView(plugin, {
    name: `Hermes ${sessionId.slice(0, 8)}`,
    color: "",
    cwd: getVaultBasePath(plugin),
    resumeCommand: `hermes --resume ${sessionId}`,
  });
}

export function getVaultBasePath(plugin: TerminalPlugin): string {
  const adapter = plugin.app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  return "";
}
