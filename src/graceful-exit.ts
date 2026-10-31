/**
 * Graceful PTY teardown helpers.
 *
 * Closing a console tab used to end it with a bare `pty.kill()` — an external
 * SIGHUP. The Hermes CLI only stamps its gateway session rows as ended when it
 * exits through its own exit command (`/quit` or Ctrl+D →
 * `session.detach {end_reason:'tui_shutdown'}`). An external signal skips that
 * path, so every used-then-closed tab left its session stuck `idle`.
 *
 * Ctrl+D is sent only when hook status confirms Hermes itself is the
 * foreground program and idle. A missing or stale status, a busy turn, and
 * any other foreground program (shell, vim, Python, …) keep the immediate
 * hard kill. Unknown is not safe: EOF can submit buffered input.
 *
 * Hermes ignores Ctrl+D while the composer holds an unsent draft. The grace
 * timer then hard-kills, which does not stamp the gateway session — the same
 * outcome as the old close — and the draft is discarded. See
 * `GRACEFUL_EXIT_REFUSED_NOTICE`.
 *
 * The grace timer must not call `kill()` after the child has already exited.
 * node-pty keeps the old pid, and the kernel may have reused it.
 */

/** The terminal-EOF byte; Ink reports it as Ctrl+D and shells as EOF. */
export const CTRL_D = "\u0004";

/**
 * How long to wait between Ctrl+D and the fallback hard kill.
 *
 * The Hermes TUI's own exit close is capped at 1.5 s internally and its
 * failsafe is 4 s; 4 s here covers both. If the process is still alive then,
 * Ctrl+D was ignored (typically an unsent draft) or the process is wedged.
 */
export const GRACEFUL_EXIT_GRACE_MS = 4000;

/**
 * Shown when Ctrl+D did not end the process and the grace timer force-kills.
 * Hermes ignores Ctrl+D on an unsent draft, and the fallback kill does not
 * write `tui_shutdown`, so the gateway row can stay listed.
 */
export const GRACEFUL_EXIT_REFUSED_NOTICE =
  "Hermes did not exit on Ctrl+D. It ignores Ctrl+D when the composer has an unsent draft, so the terminal was force-killed and this gateway session may still be listed.";

export interface GracefulExitDecision {
  /** Whether the graceful-exit-before-kill setting is on. */
  gracefulHermesExit: boolean;
  /**
   * `false` is a confirmed idle reading. `true` is busy.
   * `null` or `undefined` means the hook status is missing or stale.
   */
  hermesBusy: boolean | null | undefined;
  /**
   * True only when the status pid is the foreground Hermes process.
   * Anything else, including null/undefined, is not safe to send Ctrl+D to.
   */
  hermesForeground: boolean | null | undefined;
}

/**
 * Ctrl+D is safe only for a confirmed idle foreground Hermes.
 * A busy turn is hard-killed immediately, which does not preserve the turn;
 * it keeps the previous termination behavior. Missing and stale statuses are
 * not treated as idle.
 */
export function shouldUseGracefulExitDecision(opts: GracefulExitDecision): boolean {
  return opts.gracefulHermesExit === true
    && opts.hermesBusy === false
    && opts.hermesForeground === true;
}

const HERMES_BASENAME = /^hermes(\.exe)?$/i;

/** True when a comm or cmdline token's basename is the Hermes executable. */
export function commandLooksLikeHermes(command: string | null | undefined): boolean {
  if (!command) return false;
  const tokens = command.replace(/\0/g, " ").trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const base = token.split(/[/\\]/).pop() ?? "";
    return HERMES_BASENAME.test(base);
  });
}

export interface UnixProcessInfo {
  pid: number;
  alive: boolean;
  pgrp: number | null;
  /** Foreground process group of this process's controlling terminal. */
  tpgid: number | null;
  command: string;
}

/**
 * Hermes is the foreground program when its pid is the terminal's foreground
 * process-group leader and its command is Hermes. A shell at the prompt, vim,
 * or Python fails this even if a leftover status file still says idle.
 */
export function isConfirmedForegroundHermes(
  shell: UnixProcessInfo | null | undefined,
  hermes: UnixProcessInfo | null | undefined,
): boolean {
  if (!shell?.alive || !hermes?.alive) return false;
  if (shell.tpgid == null || shell.tpgid <= 0) return false;
  if (hermes.pid <= 0 || hermes.pgrp == null || hermes.pgrp <= 0) return false;
  // The foreground program is the process-group leader (pid == pgrp).
  if (hermes.pid !== hermes.pgrp) return false;
  if (hermes.pgrp !== shell.tpgid) return false;
  return commandLooksLikeHermes(hermes.command);
}

/** Parse `/proc/<pid>/stat`. `comm` may contain spaces and parentheses. */
export function parseProcStat(contents: string): { pgrp: number | null; tpgid: number | null } | null {
  const end = contents.lastIndexOf(")");
  if (end < 0) return null;
  const fields = contents.slice(end + 1).trim().split(/\s+/);
  // After comm: state ppid pgrp session tty_nr tpgid
  if (fields.length < 6) return null;
  const pgrp = Number(fields[2]);
  const tpgid = Number(fields[5]);
  if (!Number.isInteger(pgrp) || !Number.isInteger(tpgid)) return null;
  return { pgrp, tpgid };
}

/** Parse `ps -o pid=,pgid=,tpgid=,command=` output (one process). */
export function parsePsSnapshot(
  output: string,
): { pid: number; pgrp: number | null; tpgid: number | null; command: string } | null {
  const line = output.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0);
  if (!line) return null;
  const match = /^(\d+)\s+(-?\d+)\s+(-?\d+)\s*(.*)$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const pgrp = Number(match[2]);
  const tpgid = Number(match[3]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    pgrp: Number.isInteger(pgrp) ? pgrp : null,
    tpgid: Number.isInteger(tpgid) ? tpgid : null,
    command: (match[4] ?? "").trim(),
  };
}

export interface ProcessInfoDeps {
  platform?: NodeJS.Platform;
  readFile?: (filePath: string) => string;
  runPs?: (pid: number) => string;
}

/**
 * Read a live process. Returns null when the process is gone, the platform
 * cannot confirm a foreground group (Windows), or the read fails. Callers
 * treat null as "not a confirmed foreground Hermes".
 */
export function readUnixProcessInfo(pid: number, deps: ProcessInfoDeps = {}): UnixProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return null;
  if (platform === "linux") return readProcFs(pid, deps.readFile ?? defaultReadFile);
  if (platform === "darwin") return readDarwinPs(pid, deps.runPs ?? defaultRunPs);
  return null;
}

function readProcFs(pid: number, readFile: (filePath: string) => string): UnixProcessInfo | null {
  let stat: string;
  try {
    stat = readFile(`/proc/${pid}/stat`);
  } catch {
    return null;
  }
  const parsed = parseProcStat(stat);
  if (!parsed) return null;
  let command = "";
  try {
    command = readFile(`/proc/${pid}/cmdline`).replace(/\0/g, " ").trim();
  } catch {
    command = "";
  }
  if (!command) {
    try {
      command = readFile(`/proc/${pid}/comm`).trim();
    } catch {
      command = "";
    }
  }
  return { pid, alive: true, pgrp: parsed.pgrp, tpgid: parsed.tpgid, command };
}

function readDarwinPs(pid: number, runPs: (pid: number) => string): UnixProcessInfo | null {
  let output: string;
  try {
    output = runPs(pid);
  } catch {
    return null;
  }
  const parsed = parsePsSnapshot(output);
  if (!parsed || parsed.pid !== pid) return null;
  return {
    pid,
    alive: true,
    pgrp: parsed.pgrp,
    tpgid: parsed.tpgid,
    command: parsed.command,
  };
}

function defaultReadFile(filePath: string): string {
  const fs = window.require("fs") as { readFileSync: (path: string, encoding: string) => string };
  return fs.readFileSync(filePath, "utf8");
}

function defaultRunPs(pid: number): string {
  const childProcess = window.require("child_process") as {
    execFileSync: (command: string, args: string[], options: { encoding: "utf8" }) => string;
  };
  return childProcess.execFileSync(
    "ps",
    ["-p", String(pid), "-o", "pid=,pgid=,tpgid=,command="],
    { encoding: "utf8" },
  );
}
