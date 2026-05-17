import { FileSystemAdapter, ItemView, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./constants";
import { TerminalTabManager, type TabManagerOptions, type CreateTabOpts } from "./terminal-tab-manager";
import { pushRecentSession } from "./recent-sessions";
import type TerminalPlugin from "./main";
import type { SavedViewState } from "./session-state";
import { HERMES_MARK_ICON_ID } from "./hermes-icon";
import {
  getTerminalViewCloseBlockedMessage,
  shouldBlockTerminalViewClose,
} from "./terminal-session-actions";

function formatCwdHint(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export class TerminalView extends ItemView {
  private plugin: TerminalPlugin;
  private tabManager: TerminalTabManager | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private viewContainer: HTMLElement | null = null;
  private originalLeafDetach: WorkspaceLeaf["detach"] | null = null;
  private workspaceCloseAuthorized = false;
  /**
   * State passed to setState() before onOpen() has constructed the tab manager.
   * Applied in onOpen() once the manager is ready.
   */
  private pendingState: ParsedTerminalViewState | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TERMINAL;
  }

  getDisplayText(): string {
    return "Hermes Terminal";
  }

  getIcon(): string {
    return this.plugin.settings.ribbonIcon;
  }

  // async: satisfies ItemView.onOpen() → Promise<void>; no actual async work here
  async onOpen(): Promise<void> {
    this.installWorkspaceCloseGuard();

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("terminal-view-container");
    this.viewContainer = container;
    this.applyTabBarPosition();

    // Determine CWD — vault root
    let cwd: string;
    try {
      cwd = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    } catch {
      cwd = process.cwd();
    }

    const shellEl = container.createDiv({ cls: "terminal-shell" });
    const shellHeaderEl = shellEl.createDiv({ cls: "terminal-shell-header" });

    const brandEl = shellHeaderEl.createDiv({ cls: "terminal-shell-brand" });
    const brandIconEl = brandEl.createSpan({ cls: "terminal-shell-brand-icon" });
    setIcon(brandIconEl, HERMES_MARK_ICON_ID);
    brandEl.createSpan({ cls: "terminal-shell-wordmark", text: "HERMES" });

    shellHeaderEl.createDiv({ cls: "terminal-shell-divider" });

    const contextHeaderEl = shellHeaderEl.createDiv({ cls: "terminal-context-header" });

    const cwdHintEl = shellHeaderEl.createDiv({
      cls: "terminal-shell-cwd",
      text: `cwd ${formatCwdHint(cwd)}`,
    });
    cwdHintEl.title = cwd;

    const settingsButton = shellHeaderEl.createEl("button", {
      cls: "terminal-shell-settings-button",
    });
    settingsButton.type = "button";
    settingsButton.title = "Open Hermes terminal settings";
    settingsButton.setAttribute("aria-label", "Open Hermes terminal settings");
    setIcon(settingsButton, "sliders-horizontal");
    settingsButton.addEventListener("click", () => this.openSettingsTab());

    const shellBodyEl = shellEl.createDiv({ cls: "terminal-shell-body" });
    const tabBarEl = shellBodyEl.createDiv({ cls: "terminal-tab-bar" });
    const mainAreaEl = shellBodyEl.createDiv({ cls: "terminal-main-area" });

    // Terminal host (all session containers go here)
    const terminalHostEl = mainAreaEl.createDiv({ cls: "terminal-host" });

    // Resolve plugin directory for native module loading
    const path = window.require("path") as typeof import("path");
    const pluginDir = path.join(
      (this.plugin.app.vault.adapter as FileSystemAdapter).getBasePath(),
      this.plugin.app.vault.configDir, "plugins", this.plugin.manifest.id
    );

    // Create tab manager and first terminal
    const tabManagerOpts: TabManagerOptions = {
      app: this.app,
      tabBarEl,
      contextHeaderEl,
      terminalHostEl,
      settings: this.plugin.settings,
      cwd,
      pluginDir,
      binaryManager: this.plugin.binaryManager,
      themeRegistry: this.plugin.themeRegistry,
      onTabsEmpty: () => this.leaf.detach(),
      requestSaveLayout: () => { void this.app.workspace.requestSaveLayout(); },
      onSessionClose: (tab) => { void pushRecentSession(this.plugin, tab); },
      contextTracker: this.plugin.obsidianContextTracker,
      saveSettings: () => this.plugin.saveSettings(),
    };
    this.tabManager = new TerminalTabManager(tabManagerOpts);

    if (this.pendingState) {
      // setState already fired (edge case) — apply its state
      this.applyPendingState();
    } else if (!parseSavedViewState(this.leaf.getViewState().state)) {
      // No saved state incoming — create a default tab.
      // (If saved state IS incoming, setState will fire next and own tab creation.)
      this.tabManager.createTab();
    }

    // Resize observer for auto-fit
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.tabManager?.fitActive();
      }, 50);
    });
    this.resizeObserver.observe(terminalHostEl);

    // Periodic save: every 10s, if terminal output happened since the last check,
    // trigger requestSaveLayout. This replaces per-chunk save calls that caused
    // input lag under heavy output (e.g. Claude streaming). Quit still flushes
    // via main.ts's workspace.on("quit") → requestSaveLayout.run().
    this.registerInterval(
      window.setInterval(() => {
        if (this.tabManager?.consumeOutputDirty()) {
          void this.app.workspace.requestSaveLayout();
        }
      }, 10000)
    );
  }

  private openSettingsTab(): void {
    const setting = (this.app as typeof this.app & {
      setting?: {
        open?: () => void;
        openTabById?: (id: string) => void;
      };
    }).setting;

    try {
      setting?.open?.();
      setting?.openTabById?.(this.plugin.manifest.id);
    } catch (err) {
      console.error("Terminal: failed to open Hermes terminal settings", err);
    }
  }

  // async: satisfies ItemView.onClose() → Promise<void>; no actual async work here
  async onClose(): Promise<void> {
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.restoreWorkspaceCloseGuard();
    this.tabManager?.destroyAll();
    this.tabManager = null;
  }

  allowNextWorkspaceClose(): void {
    this.workspaceCloseAuthorized = true;
  }

  private installWorkspaceCloseGuard(): void {
    if (this.originalLeafDetach) return;

    const original = this.leaf.detach.bind(this.leaf) as WorkspaceLeaf["detach"];
    this.originalLeafDetach = original;
    this.leaf.detach = ((...args: Parameters<WorkspaceLeaf["detach"]>) => {
      const sessionCount = this.tabManager?.getSessions().length ?? 0;
      if (shouldBlockTerminalViewClose(sessionCount, this.workspaceCloseAuthorized)) {
        new Notice(getTerminalViewCloseBlockedMessage());
        return Promise.resolve();
      }
      return original(...args);
    }) as WorkspaceLeaf["detach"];
  }

  private restoreWorkspaceCloseGuard(): void {
    if (!this.originalLeafDetach) return;
    this.leaf.detach = this.originalLeafDetach;
    this.originalLeafDetach = null;
  }

  createNewTab(opts?: CreateTabOpts): void {
    this.tabManager?.createTab(opts);
  }

  getTabManager(): TerminalTabManager | null {
    return this.tabManager;
  }

  updateBackgroundColor(): void {
    this.tabManager?.updateBackgroundColor();
  }

  updateCopyOnSelect(): void {
    this.tabManager?.updateCopyOnSelect();
  }

  updateLineHeight(): void {
    this.tabManager?.updateLineHeight();
  }

  updateObsidianContextHeader(): void {
    this.tabManager?.updateObsidianContextHeader();
  }

  applyTabBarPosition(): void {
    if (!this.viewContainer) return;
    this.viewContainer.removeClass("terminal-tabs-left");
    this.viewContainer.removeClass("terminal-tabs-right");
    const pos = this.plugin.settings.tabBarPosition;
    if (pos === "left") this.viewContainer.addClass("terminal-tabs-left");
    else if (pos === "right") this.viewContainer.addClass("terminal-tabs-right");
  }

  getState(): Record<string, unknown> {
    if (!this.tabManager) {
      // Before onOpen runs (or after onClose): hand back any pending state we still have
      return this.pendingState
        ? { tabs: this.pendingState.tabs, activeIndex: this.pendingState.activeIndex }
        : {};
    }
    const state: SavedViewState = {
      tabs: this.tabManager.serializeSessions(),
      activeIndex: this.tabManager.getActiveIndex(),
    };
    return { ...state };
  }

  // async: satisfies View.setState() → Promise<void>; restore is synchronous
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    result.history = false;
    const parsed = parseSavedViewState(state);
    if (!parsed) return;

    this.pendingState = parsed;
    if (!this.tabManager) return;

    // setState is authoritative: if any tabs exist (e.g. a default tab created
    // by onOpen before the getViewState peek detected incoming state), replace them.
    // Pass saveToRecents=false — the default tab had no user activity.
    if (this.tabManager.getSessions().length > 0) {
      this.tabManager.destroyAll(false);
    }
    this.applyPendingState();
  }

  private applyPendingState(): void {
    const state = this.pendingState;
    if (!state || !this.tabManager) return;
    this.pendingState = null;

    for (const tab of state.tabs) {
      this.tabManager.createTab({
        name: tab.name,
        color: tab.color,
        cwd: tab.cwd,
        bufferSerial: tab.bufferSerial,
        resumeCommand: tab.resumeCommand,
        pinned: tab.pinned,
        restored: !state.runStartupCommand,
      });
    }

    if (state.activeIndex >= 0) {
      this.tabManager.switchToIndex(state.activeIndex);
    }
  }
}

/**
 * Validate and narrow an unknown state value to SavedViewState.
 * Returns null for missing, malformed, or empty state.
 */
interface ParsedTerminalViewState extends SavedViewState {
  /**
   * Transient view-state hint used by explicit "open here" launches. Workspace
   * restore state does not include it, so restored tabs remain startup-safe.
   */
  runStartupCommand?: boolean;
}

function parseSavedViewState(state: unknown): ParsedTerminalViewState | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Partial<ParsedTerminalViewState>;
  if (!Array.isArray(s.tabs) || s.tabs.length === 0) return null;
  const activeIndex = typeof s.activeIndex === "number" ? s.activeIndex : 0;
  return { tabs: s.tabs, activeIndex, runStartupCommand: s.runStartupCommand === true };
}
