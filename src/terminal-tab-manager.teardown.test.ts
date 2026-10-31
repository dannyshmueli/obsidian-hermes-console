import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // @ts-expect-error xterm UMD checks self during import; tests run in Node.
  globalThis.self = globalThis;
});

import { CTRL_D, GRACEFUL_EXIT_GRACE_MS, GRACEFUL_EXIT_REFUSED_NOTICE, type UnixProcessInfo } from "./graceful-exit";
import type { HermesHookExitStatus } from "./hermes-hook-status";
import { DEFAULT_SETTINGS, type TerminalPluginSettings } from "./settings";
import { TerminalTabManager, type TerminalSession } from "./terminal-tab-manager";
import { TerminalNoteContextState } from "./terminal-note-context-state";

const SHELL_PID = 100;
const HERMES_PID = 200;

interface FakePty {
  pid: number;
  hasExited: boolean;
  killCount: number;
  written: string[];
  write: (data: string) => void;
  kill: () => void;
}

interface Harness {
  sessions: TerminalSession[];
  activeId: string | null;
  gracePending: TerminalSession[];
  settings: TerminalPluginSettings;
  noteContextState: TerminalNoteContextState;
  onTabsEmpty: () => void;
  renderTabBar: () => void;
  requestSaveLayout: () => void;
  readHookExitStatus: (filePath: string, tabId: string) => HermesHookExitStatus | undefined;
  readProcess: (pid: number) => UnixProcessInfo | null;
  notify: (message: string) => void;
  closeTab: (id: string) => void;
  destroyAll: (saveToRecents?: boolean) => void;
  confirmAndKillTab: (id: string) => void;
  forceCloseTab: (id: string) => void;
  handlePtyExit: (session: TerminalSession) => void;
  writePtyOutput: (session: TerminalSession, data: string) => void;
}

function fakePty(pid = SHELL_PID): FakePty {
  const pty: FakePty = {
    pid,
    hasExited: false,
    killCount: 0,
    written: [],
    write(data: string) {
      pty.written.push(data);
    },
    kill() {
      pty.killCount += 1;
      pty.hasExited = true;
    },
  };
  return pty;
}

function idleStatus(pid: number | null = HERMES_PID): HermesHookExitStatus {
  return { busy: false, pid };
}

function foregroundHermes(pid: number): UnixProcessInfo | null {
  if (pid === SHELL_PID) {
    return { pid: SHELL_PID, alive: true, pgrp: SHELL_PID, tpgid: HERMES_PID, command: "bash" };
  }
  if (pid === HERMES_PID) {
    return { pid: HERMES_PID, alive: true, pgrp: HERMES_PID, tpgid: HERMES_PID, command: "/usr/local/bin/hermes" };
  }
  return null;
}

function makeSession(id: string, pty: FakePty, hooks: Partial<TerminalSession> = {}): TerminalSession {
  const disposed = { disposed: false, outputDetachedAtDispose: false };
  const session = {
    id,
    name: `Hermes ${id}`,
    color: "",
    cwd: "/tmp",
    pinned: false,
    removedFromTabs: false,
    hermesBusy: false,
    hermesHookStatusPath: `/tmp/${id}.json`,
    hermesHookStatus: { statusMtimeMs: 0, pollTimer: null, watchHandle: null },
    parserDisposables: [],
    autocomplete: null,
    pty,
    terminal: {
      dispose() {
        disposed.disposed = true;
        disposed.outputDetachedAtDispose = session.ptyOutputDetached === true;
      },
      write(_data: string) {
        throw new Error("PTY output reached a live terminal.write");
      },
    },
    containerEl: { remove() {} },
    dragLabel: { remove() {} },
    ptyExited: false,
    graceKillTimer: null,
    ptyKillRequested: false,
    tornDown: false,
    ptyOutputDetached: false,
    disposeProbe: disposed,
    ...hooks,
  };
  return session as unknown as TerminalSession & { disposeProbe: { disposed: boolean; outputDetachedAtDispose: boolean } };
}

function makeManager(
  sessions: TerminalSession[],
  options: {
    graceful?: boolean;
    status?: HermesHookExitStatus | undefined;
    useRealStatusReader?: boolean;
    readProcess?: (pid: number) => UnixProcessInfo | null;
    notices?: string[];
  } = {},
): Harness {
  const manager = Object.create(TerminalTabManager.prototype) as Harness;
  manager.sessions = sessions;
  manager.activeId = sessions[0]?.id ?? null;
  manager.gracePending = [];
  manager.noteContextState = new TerminalNoteContextState();
  manager.settings = {
    ...DEFAULT_SETTINGS,
    persistBuffer: false,
    gracefulHermesExit: options.graceful ?? true,
  };
  manager.onTabsEmpty = () => undefined;
  manager.renderTabBar = () => undefined;
  manager.requestSaveLayout = () => undefined;
  manager.notify = (message: string) => {
    options.notices?.push(message);
  };
  manager.readProcess = options.readProcess ?? (() => null);
  if (!options.useRealStatusReader) {
    const status = options.status === undefined && !("status" in options)
      ? idleStatus()
      : options.status;
    manager.readHookExitStatus = () => status;
  }
  return manager;
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: TimerHandler, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    confirm: () => true,
    prompt: () => null,
  };
  (globalThis as { activeDocument?: { querySelector: () => null } }).activeDocument = {
    querySelector: () => null,
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { activeDocument?: unknown }).activeDocument;
});

describe("terminal teardown", () => {
  it("sends Ctrl+D for a confirmed idle foreground Hermes and drops PTY output after dispose", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], { readProcess: foregroundHermes });
    manager.closeTab(session.id);
    const probe = (session as TerminalSession & { disposeProbe: { outputDetachedAtDispose: boolean } }).disposeProbe;
    expect(pty.written).toEqual([CTRL_D]);
    expect(pty.killCount).toBe(0);
    expect(probe.outputDetachedAtDispose).toBe(true);
    expect(session.ptyOutputDetached).toBe(true);
    manager.writePtyOutput(session, "draft warning\r\n");
    expect(session.tornDown).toBe(true);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS - 1);
    expect(pty.killCount).toBe(0);
  });

  it("does not send Ctrl+D when vim, Python, or the shell is the foreground program", () => {
    const cases: Array<{ command: string; readProcess: (pid: number) => UnixProcessInfo | null; statusPid: number }> = [
      {
        command: "vim",
        statusPid: 300,
        readProcess: (pid) => {
          if (pid === SHELL_PID) return { pid, alive: true, pgrp: SHELL_PID, tpgid: 300, command: "bash" };
          if (pid === 300) return { pid, alive: true, pgrp: 300, tpgid: 300, command: "vim" };
          return null;
        },
      },
      {
        command: "python",
        statusPid: 300,
        readProcess: (pid) => {
          if (pid === SHELL_PID) return { pid, alive: true, pgrp: SHELL_PID, tpgid: 300, command: "bash" };
          if (pid === 300) return { pid, alive: true, pgrp: 300, tpgid: 300, command: "python" };
          return null;
        },
      },
      {
        command: "bash",
        statusPid: HERMES_PID,
        readProcess: (pid) => {
          if (pid === SHELL_PID) return { pid, alive: true, pgrp: SHELL_PID, tpgid: SHELL_PID, command: "bash" };
          if (pid === HERMES_PID) return { pid, alive: true, pgrp: HERMES_PID, tpgid: SHELL_PID, command: "hermes" };
          return null;
        },
      },
    ];
    for (const entry of cases) {
      const pty = fakePty();
      const session = makeSession("terminal-1", pty, { hermesBusy: false });
      const manager = makeManager([session], {
        status: idleStatus(entry.statusPid),
        readProcess: entry.readProcess,
      });
      manager.closeTab(session.id);
      expect(pty.written, entry.command).toEqual([]);
      expect(pty.killCount, entry.command).toBe(1);
    }
  });

  it("hard-kills when hook status is null or undefined even if the cached busy flag is false", () => {
    for (const status of [undefined, { busy: null, pid: null }] as Array<HermesHookExitStatus | undefined>) {
      const pty = fakePty();
      const session = makeSession("terminal-1", pty, { hermesBusy: false });
      const manager = makeManager([session], { status, readProcess: foregroundHermes });
      manager.closeTab(session.id);
      expect(pty.written).toEqual([]);
      expect(pty.killCount).toBe(1);
    }
  });

  it("uses the real status reader so a missing or stale file is null, not a cached false", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty, { hermesBusy: false });
    const manager = makeManager([session], { useRealStatusReader: true, readProcess: foregroundHermes });
    const windowMock = (globalThis as { window: { require?: (id: string) => unknown } }).window;
    windowMock.require = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    manager.closeTab(session.id);
    expect(pty.written).toEqual([]);
    expect(pty.killCount).toBe(1);

    const stalePty = fakePty();
    const staleSession = makeSession("terminal-1", stalePty, { hermesBusy: false });
    const staleManager = makeManager([staleSession], { useRealStatusReader: true, readProcess: foregroundHermes });
    (globalThis as { window: { require: (id: string) => unknown } }).window.require = (id: string) => {
      if (id !== "fs") throw new Error(id);
      return {
        readFileSync: () => JSON.stringify({
          schema: 1,
          source: "hermes-obsidian-status",
          tabId: staleSession.id,
          state: "idle",
        }),
      };
    };
    staleManager.closeTab(staleSession.id);
    expect(stalePty.written).toEqual([]);
    expect(stalePty.killCount).toBe(1);
  });

  it("does not send Ctrl+D when the status pid is no longer a live process", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty, { hermesBusy: false });
    const manager = makeManager([session], {
      status: idleStatus(HERMES_PID),
      readProcess: () => null,
    });
    manager.closeTab(session.id);
    expect(pty.written).toEqual([]);
    expect(pty.killCount).toBe(1);
  });

  it("hard-kills immediately when graceful exit is turned off", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], {
      graceful: false,
      readProcess: foregroundHermes,
      status: idleStatus(),
    });
    manager.closeTab(session.id);
    expect(pty.written).toEqual([]);
    expect(pty.killCount).toBe(1);
  });

  it("hard-kills a busy Hermes without sending Ctrl+D", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], {
      status: { busy: true, pid: HERMES_PID },
      readProcess: foregroundHermes,
    });
    manager.closeTab(session.id);
    expect(pty.written).toEqual([]);
    expect(pty.killCount).toBe(1);
  });

  it("does not hard-kill if the process exits during the grace window", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], { readProcess: foregroundHermes });
    manager.closeTab(session.id);
    expect(pty.written).toEqual([CTRL_D]);
    manager.handlePtyExit(session);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.killCount).toBe(0);
    expect(manager.gracePending).toEqual([]);
  });

  it("does not arm a kill when Ctrl+D itself exits the process", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], { readProcess: foregroundHermes });
    pty.write = () => {
      pty.written.push(CTRL_D);
      manager.handlePtyExit(session);
    };
    manager.closeTab(session.id);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.written).toEqual([CTRL_D]);
    expect(pty.killCount).toBe(0);
  });

  it("does not kill or send Ctrl+D when teardown runs after the PTY has already exited", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], { readProcess: foregroundHermes, status: idleStatus() });
    session.ptyExited = true;
    manager.forceCloseTab(session.id);
    expect(pty.written).toEqual([]);
    expect(pty.killCount).toBe(0);
    expect(manager.sessions).toHaveLength(0);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.killCount).toBe(0);

    const livePty = fakePty();
    livePty.hasExited = true;
    const live = makeSession("terminal-2", livePty);
    const liveManager = makeManager([live], { readProcess: foregroundHermes, status: idleStatus() });
    liveManager.closeTab(live.id);
    expect(livePty.written).toEqual([]);
    expect(livePty.killCount).toBe(0);
  });

  it("kills immediately for an explicit destructive kill of an idle Hermes", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], { readProcess: foregroundHermes, status: idleStatus() });
    (globalThis as { window: { prompt: (message?: string) => string | null } }).window.prompt = () => session.name;
    manager.confirmAndKillTab(session.id);
    expect(pty.written).toEqual([]);
    expect(pty.killCount).toBe(1);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.killCount).toBe(1);
  });

  it("destroyAll kills open tabs immediately and does not send Ctrl+D", () => {
    const first = fakePty();
    const second = fakePty();
    const manager = makeManager(
      [makeSession("terminal-1", first), makeSession("terminal-2", second)],
      { readProcess: foregroundHermes, status: idleStatus() },
    );
    manager.destroyAll();
    expect(first.written).toEqual([]);
    expect(second.written).toEqual([]);
    expect(first.killCount).toBe(1);
    expect(second.killCount).toBe(1);
  });

  it("destroyAll kills a Ctrl+D grace child synchronously so unload does not leave it alive", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const notices: string[] = [];
    const manager = makeManager([session], { readProcess: foregroundHermes, notices });
    manager.closeTab(session.id);
    expect(pty.killCount).toBe(0);
    expect(manager.gracePending).toHaveLength(1);
    manager.destroyAll();
    expect(pty.killCount).toBe(1);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.killCount).toBe(1);
    expect(notices).toEqual([]);
  });

  it("force-kills when Hermes ignores Ctrl+D and reports the unsent-draft fallback", () => {
    const pty = fakePty();
    const session = makeSession("terminal-1", pty);
    const notices: string[] = [];
    const manager = makeManager([session], { readProcess: foregroundHermes, notices });
    manager.closeTab(session.id);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.written).toEqual([CTRL_D]);
    expect(pty.killCount).toBe(1);
    expect(notices).toEqual([GRACEFUL_EXIT_REFUSED_NOTICE]);
  });

  it("hard-kills immediately when Ctrl+D cannot be written and the process is still alive", () => {
    const pty = fakePty();
    pty.write = () => {
      throw new Error("EIO");
    };
    const session = makeSession("terminal-1", pty);
    const manager = makeManager([session], { readProcess: foregroundHermes });
    manager.closeTab(session.id);
    expect(pty.killCount).toBe(1);
    vi.advanceTimersByTime(GRACEFUL_EXIT_GRACE_MS);
    expect(pty.killCount).toBe(1);
  });
});
