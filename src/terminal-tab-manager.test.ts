import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // @ts-expect-error xterm UMD checks self during import; tests run in Node.
  globalThis.self = globalThis;
});

import { getContextHeaderDestinationLabel } from "./context-header-label";
import { getContextHeaderToggleState } from "./context-header-toggle-state";
import { TerminalTabManager } from "./terminal-tab-manager";
import { TerminalNoteContextState } from "./terminal-note-context-state";

class FakeElement {
  children: FakeElement[] = [];
  attrs = new Map<string, string>();
  classes = new Set<string>();
  text = "";
  type = "";

  constructor(cls?: string) {
    if (cls) this.classes.add(cls);
  }

  empty(): void {
    this.children = [];
  }

  createEl(_tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeElement {
    const child = new FakeElement(opts?.cls);
    child.text = opts?.text ?? "";
    for (const [name, value] of Object.entries(opts?.attr ?? {})) {
      child.setAttribute(name, value);
    }
    this.children.push(child);
    return child;
  }

  createSpan(opts?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createEl("span", opts);
  }

  createDiv(opts?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createEl("div", opts);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attrs.get(name);
  }

  toggleClass(name: string, enabled: boolean): void {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }

  addClass(name: string): void {
    this.classes.add(name);
  }

  removeClass(name: string): void {
    this.classes.delete(name);
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  addEventListener(): void {
    // no-op for rendering assertions
  }
}

function getRenderedToggle(header: FakeElement): FakeElement {
  const toggle = header.children.find((child) => child.hasClass("terminal-context-toggle"));
  if (!toggle) throw new Error("context toggle was not rendered");
  return toggle;
}

function findRenderedChild(root: FakeElement, className: string): FakeElement | undefined {
  if (root.hasClass(className)) return root;
  for (const child of root.children) {
    const found = findRenderedChild(child, className);
    if (found) return found;
  }
  return undefined;
}

describe("getContextHeaderDestinationLabel", () => {
  it("uses the terminal name when present", () => {
    expect(getContextHeaderDestinationLabel("Terminal 1")).toBe("Terminal 1");
  });

  it("falls back for missing, empty, or whitespace-only names", () => {
    expect(getContextHeaderDestinationLabel(undefined)).toBe("active terminal");
    expect(getContextHeaderDestinationLabel(null)).toBe("active terminal");
    expect(getContextHeaderDestinationLabel("")).toBe("active terminal");
    expect(getContextHeaderDestinationLabel("   \t\n  ")).toBe("active terminal");
  });

  it("trims surrounding whitespace from terminal names", () => {
    expect(getContextHeaderDestinationLabel("  Claude session  ")).toBe("Claude session");
  });
});

describe("context header toggle state", () => {
  it("follows the active tab's per-session note context state when switching tabs", () => {
    const noteContextState = new TerminalNoteContextState();
    const tabs = [
      { id: "terminal-a", name: "Hermes A" },
      { id: "terminal-b", name: "Hermes B" },
    ];

    const headerForActiveTab = (activeId: string) => {
      const activeTab = tabs.find((tab) => tab.id === activeId);
      return getContextHeaderToggleState(
        activeTab?.name,
        noteContextState.isEnabled(activeId),
      );
    };

    // Toggle context on tab B only.
    noteContextState.setEnabled("terminal-b", true);

    // Switch A/B/A/B and assert the header toggle reflects each tab's state.
    expect(headerForActiveTab("terminal-a")).toMatchObject({
      ariaPressed: "false",
      className: "",
      label: "Send context to Hermes A",
    });
    expect(headerForActiveTab("terminal-b")).toMatchObject({
      ariaPressed: "true",
      className: "terminal-context-toggle--on",
      label: "Send context to Hermes B",
    });
    expect(headerForActiveTab("terminal-a")).toMatchObject({
      ariaPressed: "false",
      className: "",
      label: "Send context to Hermes A",
    });
    expect(headerForActiveTab("terminal-b")).toMatchObject({
      ariaPressed: "true",
      className: "terminal-context-toggle--on",
      label: "Send context to Hermes B",
    });
  });

  it("rerenders the visible header from the active tab when switchTab changes tabs", () => {
    const originalWindow = globalThis.window;
    (globalThis as unknown as { window: { requestAnimationFrame: (cb: () => void) => number } }).window = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 0;
      },
    };

    try {
      const noteContextState = new TerminalNoteContextState();
      const header = new FakeElement();
      const manager = Object.create(TerminalTabManager.prototype) as {
        sessions: Array<{
          id: string;
          name: string;
          removedFromTabs: boolean;
          containerEl: FakeElement;
          fitAddon: { fit: () => void };
          pty: { resize: () => void };
          terminal: { cols: number; rows: number; focus: () => void };
        }>;
        activeId: string | null;
        contextHeaderEl: FakeElement;
        noteContextState: TerminalNoteContextState;
        renderTabBar: () => void;
        onActiveChange?: () => void;
        requestSaveLayout?: () => void;
        switchTab: (id: string) => void;
      };

      manager.sessions = [
        {
          id: "terminal-a",
          name: "Hermes A",
          removedFromTabs: false,
          containerEl: new FakeElement(),
          fitAddon: { fit: () => undefined },
          pty: { resize: () => undefined },
          terminal: { cols: 80, rows: 24, focus: () => undefined },
        },
        {
          id: "terminal-b",
          name: "Hermes B",
          removedFromTabs: false,
          containerEl: new FakeElement(),
          fitAddon: { fit: () => undefined },
          pty: { resize: () => undefined },
          terminal: { cols: 80, rows: 24, focus: () => undefined },
        },
      ];
      manager.activeId = null;
      manager.contextHeaderEl = header;
      manager.noteContextState = noteContextState;
      manager.renderTabBar = () => undefined;
      noteContextState.setEnabled("terminal-b", true);

      manager.switchTab("terminal-a");
      expect(getRenderedToggle(header).getAttribute("aria-pressed")).toBe("false");
      expect(getRenderedToggle(header).hasClass("terminal-context-toggle--on")).toBe(false);

      manager.switchTab("terminal-b");
      expect(getRenderedToggle(header).getAttribute("aria-pressed")).toBe("true");
      expect(getRenderedToggle(header).hasClass("terminal-context-toggle--on")).toBe(true);

      manager.switchTab("terminal-a");
      expect(getRenderedToggle(header).getAttribute("aria-pressed")).toBe("false");
      expect(getRenderedToggle(header).hasClass("terminal-context-toggle--on")).toBe(false);

      manager.switchTab("terminal-b");
      expect(getRenderedToggle(header).getAttribute("aria-pressed")).toBe("true");
      expect(getRenderedToggle(header).hasClass("terminal-context-toggle--on")).toBe(true);
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it("renders Obsidian context details as labeled file and context rows after the toggle", () => {
    const header = new FakeElement();
    const manager = Object.create(TerminalTabManager.prototype) as {
      contextHeaderEl: FakeElement;
      getActiveSession: () => { id: string; name: string };
      isActiveNoteContextEnabled: () => boolean;
      buildObsidianContextPreviewPayload: () => unknown;
      toggleActiveNoteContextEnabled: () => boolean;
      renderContextHeader: () => void;
    };

    manager.contextHeaderEl = header;
    manager.getActiveSession = () => ({ id: "terminal-a", name: "Hermes A" });
    manager.isActiveNoteContextEnabled = () => true;
    manager.buildObsidianContextPreviewPayload = () => ({
      attach: { enabled: true },
      context: {
        type: "selection",
        file: { name: "Header.md" },
        range: { from: { line: 0 }, to: { line: 1 } },
        lineCount: 2,
      },
    });
    manager.toggleActiveNoteContextEnabled = () => true;

    manager.renderContextHeader();

    expect(header.children[0]?.hasClass("terminal-context-toggle")).toBe(true);
    const details = header.children[1];
    expect(details?.hasClass("terminal-context-details")).toBe(true);
    expect(details?.getAttribute("aria-label")).toBe("Obsidian context: file Header.md, scope selected lines 1-2 (2L)");

    const rows = details?.children ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0].hasClass("terminal-context-row")).toBe(true);
    expect(rows[0].children[0].text).toBe("file:");
    expect(rows[0].children[0].hasClass("terminal-context-row-label")).toBe(true);
    expect(rows[0].children[1].text).toBe("Header.md");
    expect(rows[0].children[1].hasClass("terminal-context-row-value")).toBe(true);
    expect(rows[1].children[0].text).toBe("scope:");
    expect(rows[1].children[1].text).toBe("selected lines 1-2 (2L)");
    expect(findRenderedChild(header, "terminal-context-status")).toBeUndefined();
  });
});
