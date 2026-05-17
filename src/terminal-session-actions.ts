export type TerminalCloseButtonAction = "confirm-close";
export type TerminalProcessState = "running" | "idle" | "exited" | "unknown";

export function getCloseButtonAction(): TerminalCloseButtonAction {
  return "confirm-close";
}

export function getCloseConfirmationMessage(terminalTitle: string): string {
  return `Close terminal "${terminalTitle}"? This will stop the running Hermes/session process.`;
}

export function isDestructiveKillConfirmed(
  terminalTitle: string,
  confirmation: string | null | undefined,
): boolean {
  return confirmation === terminalTitle;
}

export function processStateRequiresDestructiveConfirmation(state: TerminalProcessState): boolean {
  return state !== "exited";
}

export function shouldBlockTerminalViewClose(sessionCount: number, workspaceCloseAuthorized: boolean): boolean {
  return sessionCount > 0 && !workspaceCloseAuthorized;
}

export function getTerminalViewCloseBlockedMessage(): string {
  return "Hermes Console kept open. Close Hermes tabs individually, or use the Close Hermes Console command.";
}
