export interface StartupCommandTabOptions {
  cwd?: string;
  restored?: boolean;
  bufferSerial?: string;
  resumeCommand?: string;
}

export function shouldRunStartupCommandForTab(opts?: StartupCommandTabOptions): boolean {
  return !opts?.restored && opts?.bufferSerial === undefined && !opts?.resumeCommand;
}

/**
 * Builds the input gate for lazy startup: the injected startup command waits for the user's
 * first keystroke instead of firing on shell-ready or the 2 s fallback timer, so a tab that is
 * opened and left untouched never launches anything — no Hermes boot cost and no empty
 * "(Untitled)" session row in Hermes (dannyshmueli/obsidian-hermes-console#10).
 *
 * The returned function is consulted by the tab's onData pipe before any keystroke reaches the
 * PTY. The first call is the start gesture: the command is written immediately (by then the
 * shell is interactive by definition, so no readiness race) and the gesture keystroke is
 * swallowed; every later call passes input through unchanged.
 */
export function createLazyStartupGate(writeCommand: () => void): (data: string) => boolean {
  let launched = false;

  return (_data: string): boolean => {
    if (launched) return true;
    launched = true;
    writeCommand();
    return false;
  };
}
