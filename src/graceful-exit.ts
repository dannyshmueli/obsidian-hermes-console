/**
 * Graceful PTY teardown helpers.
 *
 * Why this exists: closing a console tab used to end it with a bare
 * `pty.kill()` — an external SIGHUP. The Hermes CLI (an Ink/React TUI) only
 * stamps its gateway session rows as ended when it exits *through its own
 * exit command* (`/quit` or Ctrl+D, which send
 * `session.detach {end_reason:'tui_shutdown'}`); an external signal kill
 * skips that path entirely (`ui-tui/src/entry.tsx` installs no signal
 * handler for cleanup, and `GatewayClient.kill()` is explicitly
 * "(detach only)"). Every used-then-closed tab therefore left its Hermes
 * session stuck in the live session list as `idle` forever.
 *
 * Sending the terminal EOF byte (Ctrl+D, `\x04`) into the PTY before falling
 * back to `kill()` routes the child through its own graceful-exit code path,
 * which is exactly what the close button already looks like to the user.
 * See upstream issue #12 for the measured A/B (EOF → row stamped
 * `tui_shutdown`; SIGHUP → row leaks).
 *
 * Px typing note: pure helpers live here so vitest can exercise them without
 * the Obsidian/Electron globals required by terminal-tab-manager.
 */

/** The terminal-EOF byte; Ink reports it as Ctrl+D and shells as EOF. */
export const CTRL_D = "\u0004";

/**
 * How long to wait between sending EOF and the guaranteed hard kill.
 *
 * The Hermes TUI's own exit close is capped at 1.5 s internally (its deferred
 * detach race) and `setupGracefulExit`'s failsafe is 4 s; 4 s here covers
 * both. A plain shell exits on EOF instantly, so the fallback is only for
 * processes wedged on a foreground job or an untracked busy state.
 */
export const GRACEFUL_EXIT_GRACE_MS = 4000;

export interface GracefulExitDecision {
  /** Whether the graceful-exit-before-kill setting is on. */
  gracefulHermesExit: boolean;
  /** True while an embedded Hermes turn is actively running (hook status). */
  hermesBusy: boolean;
}

/**
 * EOF-before-kill is skipped while a Hermes turn is running: Ctrl+D would
 * abort that turn mid-stream, and the caller wants a hard, in-line kill
 * instead (same as today's behaviour). `null`/stale hook statuses read as
 * not-busy, which is safe: the TUI itself refuses Ctrl+D over an unsent
 * draft, and the hard-kill fallback still runs after the grace window.
 */
export function shouldUseGracefulExitDecision(opts: GracefulExitDecision): boolean {
  return opts.gracefulHermesExit && !opts.hermesBusy;
}
