import { FileSystemAdapter, Plugin, TFolder, WorkspaceLeaf, addIcon, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./constants";
import { TerminalView } from "./terminal-view";
import { TerminalSettingTab, DEFAULT_SETTINGS, type TerminalPluginSettings } from "./settings";
import { BinaryManager } from "./binary-manager";
import { ThemeRegistry } from "./theme-registry";
import { openRestoreSessionPicker } from "./recent-sessions";
import { resumeHermesSession } from "./hermes-sessions";
import type { SavedViewState } from "./session-state";
import type { TerminalTabManager } from "./terminal-tab-manager";
import { ObsidianContextTracker } from "./obsidian-context-bridge";
import {
  HERMES_ICON_ID,
  HERMES_ICON_SVG,
  HERMES_MARK_ICON_ID,
  HERMES_MARK_ICON_SVG,
  HERMES_SETTINGS_ICON_ID,
  HERMES_SETTINGS_ICON_SVG,
} from "./hermes-icon";

export default class TerminalPlugin extends Plugin {
  settings: TerminalPluginSettings = DEFAULT_SETTINGS;
  binaryManager!: BinaryManager;
  themeRegistry!: ThemeRegistry;
  obsidianContextTracker!: ObsidianContextTracker;
  private ribbonEl: HTMLElement | null = null;
  private themeObserver: MutationObserver | null = null;
  private contextRefreshRaf: number | null = null;

  async onload(): Promise<void> {
    addIcon(HERMES_ICON_ID, HERMES_ICON_SVG);
    addIcon(HERMES_MARK_ICON_ID, HERMES_MARK_ICON_SVG);
    addIcon(HERMES_SETTINGS_ICON_ID, HERMES_SETTINGS_ICON_SVG);
    await this.loadSettings();
    this.obsidianContextTracker = new ObsidianContextTracker();
    this.obsidianContextTracker.rememberFromApp(this.app);

    // Initialize binary manager
    const path = window.require("path") as typeof import("path");
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const pluginDir = path.join(
      adapter.getBasePath(),
      this.app.vault.configDir, "plugins", this.manifest.id
    );
    this.binaryManager = new BinaryManager(pluginDir);
    this.binaryManager.checkInstalled();

    // Theme registry — loads optional themes.json from the plugin folder
    this.themeRegistry = new ThemeRegistry(pluginDir);
    await this.themeRegistry.load();

    // Register the terminal view
    this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
      return new TerminalView(leaf, this);
    });

    // Ribbon icon
    this.ribbonEl = this.addRibbonIcon(this.settings.ribbonIcon, "Open Hermes terminal", () => {
      void this.activateTerminal();
    });

    // Commands
    this.addCommand({
      id: "open-terminal",
      name: "Open Hermes terminal",
      callback: () => void this.activateTerminal(),
    });

    this.addCommand({
      id: "close-terminal",
      name: "Close Hermes terminal",
      callback: () => this.closeTerminal(),
    });

    this.addCommand({
      id: "new-terminal-tab",
      name: "New Hermes terminal tab",
      callback: () => this.newTab(),
    });

    this.addCommand({
      id: "toggle-terminal",
      name: "Toggle Hermes terminal",
      callback: () => this.toggleTerminal(),
    });

    this.addCommand({
      id: "open-terminal-split",
      name: "Open Hermes terminal in new pane",
      callback: () => void this.openTerminalInNewPane(),
    });

    this.addCommand({
      id: "open-terminal-here",
      name: "Open Hermes terminal in current file's directory",
      checkCallback: (checking) => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void this.openTerminalHere();
        return true;
      },
    });

    this.addCommand({
      id: "restore-terminal-or-hermes-session",
      name: "Restore terminal or Hermes session",
      callback: () => void openRestoreSessionPicker(this),
    });

    // Tab navigation commands
    this.addCommand({
      id: "next-terminal-tab",
      name: "Next terminal tab",
      callback: () => this.navigateTerminalTab(1),
    });

    this.addCommand({
      id: "prev-terminal-tab",
      name: "Previous terminal tab",
      callback: () => this.navigateTerminalTab(-1),
    });

    this.addCommand({
      id: "first-terminal-tab",
      name: "Go to first terminal tab",
      callback: () => {
        const mgr = this.getActiveTabManager();
        if (!mgr) return;
        mgr.switchToIndex(0);
      },
    });

    this.addCommand({
      id: "last-terminal-tab",
      name: "Go to last terminal tab",
      callback: () => {
        const mgr = this.getActiveTabManager();
        if (!mgr) return;
        mgr.switchToIndex(mgr.getSessions().length - 1);
      },
    });

    for (let i = 1; i <= 8; i++) {
      this.addCommand({
        id: `terminal-tab-${i}`,
        name: `Go to terminal tab ${i}`,
        callback: () => {
          const mgr = this.getActiveTabManager();
          if (!mgr) return;
          mgr.switchToIndex(i - 1);
        },
      });
    }

    // URI handler for external resume links. The plugin does not generate
    // any session-list note or write Hermes session metadata into the vault.
    this.registerObsidianProtocolHandler("lean-terminal", (params) => {
      if (params.resume) {
        void resumeHermesSession(this, params.resume);
      } else if (params.cwd) {
        void this.openTerminalAt(decodeURIComponent(params.cwd));
      }
    });

    // Settings tab
    this.addSettingTab(new TerminalSettingTab(this.app, this));

    // Flush any pending layout save before Obsidian quits. Without this, a
    // typed-then-quickly-quit scenario loses the last few seconds of activity
    // because Obsidian's requestSaveLayout is debounced.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshObsidianContextHeadersSoon();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshObsidianContextHeadersSoon();
      })
    );

    // Obsidian's public `editor-change` event tracks document edits, not every
    // cursor/selection move. Use DOM selection/keyboard/pointer notifications to
    // refresh the live header as the user selects text or moves the caret in a
    // Markdown editor. The actual payload is still captured live on Enter.
    this.registerDomEvent(activeDocument, "selectionchange", () => this.refreshObsidianContextHeadersSoon());
    this.registerDomEvent(activeDocument, "keyup", () => this.refreshObsidianContextHeadersSoon());
    this.registerDomEvent(activeDocument, "pointerup", () => this.refreshObsidianContextHeadersSoon());

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, abstractFile) => {
        const vaultRelDir = abstractFile instanceof TFolder
          ? abstractFile.path
          : abstractFile.parent?.path ?? "";
        const pathMod = window.require("path") as typeof import("path");
        const adapter = this.app.vault.adapter as FileSystemAdapter;
        const cwd = vaultRelDir
          ? pathMod.join(adapter.getBasePath(), vaultRelDir)
          : adapter.getBasePath();
        menu.addItem((item) =>
          item
            .setTitle("Open Hermes terminal here")
            .setIcon("terminal")
            .onClick(() => void this.openTerminalAt(cwd))
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("quit", () => {
        this.authorizeTerminalViewCloses();
        void this.app.workspace.requestSaveLayout.run();
      })
    );

    // Keep terminal themes in sync with Obsidian's dark/light mode toggle.
    // Only fires when the dark/light class actually flips, not on every class change.
    let lastDark = activeDocument.body.classList.contains("theme-dark");
    this.themeObserver = new MutationObserver(() => {
      const isDark = activeDocument.body.classList.contains("theme-dark");
      if (isDark === lastDark) return;
      lastDark = isDark;
      this.updateTheme();
    });
    this.themeObserver.observe(activeDocument.body, { attributes: true, attributeFilter: ["class"] });
  }

  onunload(): void {
    if (this.contextRefreshRaf !== null) {
      window.cancelAnimationFrame(this.contextRefreshRaf);
      this.contextRefreshRaf = null;
    }
    this.themeObserver?.disconnect();
    this.themeObserver = null;

    // Detach after a tick to avoid disrupting the settings modal
    window.setTimeout(() => {
      this.authorizeTerminalViewCloses();
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    }, 0);
  }

  async activateTerminal(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    let leaf: WorkspaceLeaf | null;
    switch (this.settings.defaultLocation) {
      case "right":
        leaf = this.app.workspace.getRightLeaf(false);
        break;
      case "tab":
        leaf = this.app.workspace.getLeaf("tab");
        break;
      case "split-right":
        leaf = this.app.workspace.getLeaf("split", "vertical");
        break;
      default: // "bottom"
        leaf = this.app.workspace.getLeaf("split", "horizontal");
        break;
    }

    if (leaf) {
      const savedState = this.settings.lastViewState;
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: true,
        state: (savedState ?? {}) as Record<string, unknown>,
      });
      void this.app.workspace.revealLeaf(leaf);

      if (savedState) {
        this.settings.lastViewState = undefined;
        void this.saveSettings();
      }
    }
  }

  private authorizeTerminalViewCloses(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
      (leaf.view as TerminalView).allowNextWorkspaceClose();
    }
  }

  closeTerminal(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (leaves.length > 0) {
      const view = leaves[0].view as TerminalView;
      const state = view.getState();
      if (Array.isArray(state.tabs) && state.tabs.length > 0 && typeof state.activeIndex === "number") {
        this.settings.lastViewState = state as unknown as SavedViewState;
        void this.saveSettings();
      }
    }
    this.authorizeTerminalViewCloses();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
  }

  toggleTerminal(): void {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (existing.length > 0) {
      this.closeTerminal();
    } else {
      void this.activateTerminal();
    }
  }

  private newTab(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (leaves.length > 0) {
      const view = leaves[0].view as TerminalView;
      view.createNewTab();
    } else {
      // Open terminal first, then it auto-creates a tab
      void this.activateTerminal();
    }
  }

  async openTerminalInNewPane(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("split", "horizontal");
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  private getActiveTabManager(): TerminalTabManager | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (!leaves.length) return null;
    return (leaves[0].view as TerminalView).getTabManager() ?? null;
  }

  private navigateTerminalTab(delta: -1 | 1): void {
    const mgr = this.getActiveTabManager();
    if (!mgr) return;
    const count = mgr.getSessions().length;
    if (count < 2) return;
    const next = ((mgr.getActiveIndex() + delta) + count) % count;
    mgr.switchToIndex(next);
  }

  private getActiveFileDirCwd(): string | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const path = window.require("path") as typeof import("path");
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const vaultRelDir = file.parent?.path ?? "";
    return vaultRelDir
      ? path.join(adapter.getBasePath(), vaultRelDir)
      : adapter.getBasePath();
  }

  private async openTerminalAt(cwd: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (existing.length > 0) {
      const view = existing[0].view as TerminalView;
      void this.app.workspace.revealLeaf(existing[0]);
      view.createNewTab({ cwd });
      return;
    }

    let leaf: WorkspaceLeaf | null;
    switch (this.settings.defaultLocation) {
      case "right":       leaf = this.app.workspace.getRightLeaf(false); break;
      case "tab":         leaf = this.app.workspace.getLeaf("tab"); break;
      case "split-right": leaf = this.app.workspace.getLeaf("split", "vertical"); break;
      default:            leaf = this.app.workspace.getLeaf("split", "horizontal"); break;
    }
    if (!leaf) return;

    await leaf.setViewState({
      type: VIEW_TYPE_TERMINAL,
      active: true,
      state: { tabs: [{ name: "Hermes 1", color: "", cwd }], activeIndex: 0, runStartupCommand: true },
    });
    void this.app.workspace.revealLeaf(leaf);
  }

  private async openTerminalHere(): Promise<void> {
    const cwd = this.getActiveFileDirCwd();
    if (!cwd) return;
    await this.openTerminalAt(cwd);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<TerminalPluginSettings>);
    // Migrate the old generic Lucide icon to the Hermes-specific caduceus/wing
    // mark, while preserving any custom icon name the user entered manually.
    if (this.settings.ribbonIcon === "bot-message-square") {
      this.settings.ribbonIcon = DEFAULT_SETTINGS.ribbonIcon;
    }
    // tabColors is the only array in settings. Object.assign is shallow,
    // so on a fresh install (data.json has no tabColors) the merged
    // settings would share the reference with DEFAULT_SETTINGS, and any
    // push/filter mutation would leak into the module-level default.
    // Deep-clone here so the default array stays immutable.
    this.settings.tabColors = this.settings.tabColors.map((c) => ({ ...c }));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  updateTerminalBackgrounds(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      const view = leaf.view as TerminalView;
      view.updateBackgroundColor();
    }
  }

  updateTabBarPosition(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      (leaf.view as TerminalView).applyTabBarPosition();
    }
  }

  updateIcon(name: string): void {
    const safeName = name || "terminal";
    if (this.ribbonEl) setIcon(this.ribbonEl, safeName);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
      // tabHeaderInnerIconEl is undocumented but stable across Obsidian versions
      const iconEl = (leaf as WorkspaceLeaf & { tabHeaderInnerIconEl?: HTMLElement }).tabHeaderInnerIconEl;
      if (iconEl) setIcon(iconEl, safeName);
    }
  }

  updateCopyOnSelect(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      const view = leaf.view as TerminalView;
      view.updateCopyOnSelect();
    }
  }

  updateTheme(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      (leaf.view as TerminalView).getTabManager()?.updateTheme();
    }
  }

  updateLineHeight(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      (leaf.view as TerminalView).updateLineHeight();
    }
  }

  private refreshObsidianContextHeadersSoon(): void {
    if (this.contextRefreshRaf !== null) return;
    this.contextRefreshRaf = window.requestAnimationFrame(() => {
      this.contextRefreshRaf = null;
      this.obsidianContextTracker.rememberFromApp(this.app);
      this.updateObsidianContextHeaders();
    });
  }

  updateObsidianContextHeaders(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      (leaf.view as TerminalView).updateObsidianContextHeader();
    }
  }
}
