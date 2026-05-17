export interface StartupCommandTabOptions {
  cwd?: string;
  restored?: boolean;
  bufferSerial?: string;
  resumeCommand?: string;
}

export function shouldRunStartupCommandForTab(opts?: StartupCommandTabOptions): boolean {
  return !opts?.restored && opts?.bufferSerial === undefined && !opts?.resumeCommand;
}
