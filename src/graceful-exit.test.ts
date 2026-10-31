import { describe, expect, it } from "vitest";

import {
  CTRL_D,
  GRACEFUL_EXIT_GRACE_MS,
  GRACEFUL_EXIT_REFUSED_NOTICE,
  commandLooksLikeHermes,
  isConfirmedForegroundHermes,
  parseProcStat,
  parsePsSnapshot,
  readUnixProcessInfo,
  shouldUseGracefulExitDecision,
  type UnixProcessInfo,
} from "./graceful-exit";

const SHELL_PID = 100;
const HERMES_PID = 200;

function proc(overrides: Partial<UnixProcessInfo> & Pick<UnixProcessInfo, "pid">): UnixProcessInfo {
  return {
    alive: true,
    pgrp: overrides.pid,
    tpgid: overrides.pid,
    command: "hermes",
    ...overrides,
  };
}

describe("shouldUseGracefulExitDecision", () => {
  it("sends Ctrl+D only when the setting is on, Hermes is idle, and Hermes is foreground", () => {
    expect(shouldUseGracefulExitDecision({
      gracefulHermesExit: true,
      hermesBusy: false,
      hermesForeground: true,
    })).toBe(true);
  });

  it("keeps the hard kill while a Hermes turn is running", () => {
    expect(shouldUseGracefulExitDecision({
      gracefulHermesExit: true,
      hermesBusy: true,
      hermesForeground: true,
    })).toBe(false);
  });

  it("keeps the hard kill when the setting is off", () => {
    expect(shouldUseGracefulExitDecision({
      gracefulHermesExit: false,
      hermesBusy: false,
      hermesForeground: true,
    })).toBe(false);
  });

  it("treats a missing hook status (null) as not safe", () => {
    expect(shouldUseGracefulExitDecision({
      gracefulHermesExit: true,
      hermesBusy: null,
      hermesForeground: true,
    })).toBe(false);
  });

  it("treats a missing hook status (undefined) as not safe", () => {
    expect(shouldUseGracefulExitDecision({
      gracefulHermesExit: true,
      hermesBusy: undefined,
      hermesForeground: true,
    })).toBe(false);
  });

  it("does not send Ctrl+D when foreground Hermes is unconfirmed", () => {
    for (const hermesForeground of [false, null, undefined]) {
      expect(shouldUseGracefulExitDecision({
        gracefulHermesExit: true,
        hermesBusy: false,
        hermesForeground,
      })).toBe(false);
    }
  });
});

describe("constants", () => {
  it("sends the terminal EOF byte (Ctrl+D)", () => {
    expect(CTRL_D).toBe("\u0004");
  });

  it("grace window covers the TUI's own 1.5s detach flight plus failsafe", () => {
    expect(GRACEFUL_EXIT_GRACE_MS).toBeGreaterThanOrEqual(4000);
  });

  it("documents that an unsent draft makes the grace-period kill leave the session listed", () => {
    expect(GRACEFUL_EXIT_REFUSED_NOTICE).toMatch(/unsent draft/i);
    expect(GRACEFUL_EXIT_REFUSED_NOTICE).toMatch(/force-killed/i);
    expect(GRACEFUL_EXIT_REFUSED_NOTICE).toMatch(/may still be listed/i);
  });
});

describe("commandLooksLikeHermes", () => {
  it("matches the Hermes executable and not a shell, vim, or Python", () => {
    expect(commandLooksLikeHermes("hermes")).toBe(true);
    expect(commandLooksLikeHermes("/usr/local/bin/hermes")).toBe(true);
    expect(commandLooksLikeHermes("hermes --resume abc")).toBe(true);
    expect(commandLooksLikeHermes("C:\\Tools\\hermes.exe")).toBe(true);
    expect(commandLooksLikeHermes("bash")).toBe(false);
    expect(commandLooksLikeHermes("-bash")).toBe(false);
    expect(commandLooksLikeHermes("vim")).toBe(false);
    expect(commandLooksLikeHermes("python")).toBe(false);
    expect(commandLooksLikeHermes("/usr/bin/python3")).toBe(false);
    expect(commandLooksLikeHermes("node /opt/hermes/dist/cli.js")).toBe(false);
    expect(commandLooksLikeHermes("")).toBe(false);
    expect(commandLooksLikeHermes(null)).toBe(false);
  });
});

describe("isConfirmedForegroundHermes", () => {
  const shell = proc({ pid: SHELL_PID, pgrp: SHELL_PID, tpgid: HERMES_PID, command: "bash" });
  const hermes = proc({ pid: HERMES_PID, pgrp: HERMES_PID, tpgid: HERMES_PID, command: "/usr/bin/hermes" });

  it("confirms Hermes when it is the foreground process-group leader", () => {
    expect(isConfirmedForegroundHermes(shell, hermes)).toBe(true);
  });

  it("rejects a shell, vim, or Python in the foreground", () => {
    const shellPrompt = proc({ pid: SHELL_PID, pgrp: SHELL_PID, tpgid: SHELL_PID, command: "bash" });
    const backgroundHermes = proc({ pid: HERMES_PID, pgrp: HERMES_PID, tpgid: SHELL_PID, command: "hermes" });
    expect(isConfirmedForegroundHermes(shellPrompt, backgroundHermes)).toBe(false);

    for (const command of ["vim", "python"]) {
      const leader = proc({ pid: 300, pgrp: 300, tpgid: 300, command });
      const shellWatching = proc({ pid: SHELL_PID, pgrp: SHELL_PID, tpgid: 300, command: "bash" });
      expect(isConfirmedForegroundHermes(shellWatching, leader)).toBe(false);
    }
  });

  it("rejects a dead, missing, or non-leader process and a terminal with no foreground group", () => {
    expect(isConfirmedForegroundHermes(null, hermes)).toBe(false);
    expect(isConfirmedForegroundHermes(shell, null)).toBe(false);
    expect(isConfirmedForegroundHermes(shell, undefined)).toBe(false);
    expect(isConfirmedForegroundHermes(shell, { ...hermes, alive: false })).toBe(false);
    expect(isConfirmedForegroundHermes({ ...shell, tpgid: -1 }, hermes)).toBe(false);
    expect(isConfirmedForegroundHermes(shell, { ...hermes, pid: 201, pgrp: HERMES_PID })).toBe(false);
  });
});

describe("process table parsing", () => {
  it("parses /proc stat when comm contains spaces and parentheses", () => {
    expect(parseProcStat("55 (tmux: client) S 1 55 55 0 77 0\n")).toEqual({ pgrp: 55, tpgid: 77 });
    expect(parseProcStat("200 (hermes) S 100 200 100 34816 200 0")).toEqual({ pgrp: 200, tpgid: 200 });
    expect(parseProcStat("nope")).toBeNull();
  });

  it("parses ps pid/pgid/tpgid/command lines", () => {
    expect(parsePsSnapshot("  200 200 200 /usr/local/bin/hermes\n")).toEqual({
      pid: 200,
      pgrp: 200,
      tpgid: 200,
      command: "/usr/local/bin/hermes",
    });
    expect(parsePsSnapshot("  100 100 -1 bash\n")).toEqual({
      pid: 100,
      pgrp: 100,
      tpgid: -1,
      command: "bash",
    });
    expect(parsePsSnapshot("")).toBeNull();
  });

  it("reads a Linux process from /proc and refuses Windows", () => {
    const info = readUnixProcessInfo(HERMES_PID, {
      platform: "linux",
      readFile: (filePath: string) => {
        if (filePath === `/proc/${HERMES_PID}/stat`) return "200 (hermes) S 100 200 100 0 200 0";
        if (filePath === `/proc/${HERMES_PID}/cmdline`) return "/usr/bin/hermes\0--resume\0abc";
        throw new Error(`unexpected ${filePath}`);
      },
    });
    expect(info).toMatchObject({ pid: HERMES_PID, alive: true, pgrp: 200, tpgid: 200, command: "/usr/bin/hermes --resume abc" });
    expect(readUnixProcessInfo(HERMES_PID, {
      platform: "linux",
      readFile: () => { throw new Error("ENOENT"); },
    })).toBeNull();
    expect(readUnixProcessInfo(HERMES_PID, { platform: "win32", readFile: () => "ignored" })).toBeNull();
    expect(readUnixProcessInfo(0)).toBeNull();
  });

  it("reads a macOS process from ps", () => {
    const info = readUnixProcessInfo(HERMES_PID, {
      platform: "darwin",
      runPs: () => "200 200 200 /opt/homebrew/bin/hermes\n",
    });
    expect(info).toMatchObject({ pid: 200, pgrp: 200, tpgid: 200, command: "/opt/homebrew/bin/hermes" });
    expect(readUnixProcessInfo(HERMES_PID, {
      platform: "darwin",
      runPs: () => { throw new Error("ps failed"); },
    })).toBeNull();
  });
});
