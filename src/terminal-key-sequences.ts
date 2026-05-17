export const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

export type TerminalEnterHandlingStep =
  | { type: "write-obsidian-context-bridge"; attachEnabled: boolean }
  | { type: "allow-default-submit" }
  | { type: "write-pty-sequence"; sequence: string };

/**
 * Return the PTY byte sequence for keyboard events that xterm.js does not
 * encode well enough for terminal TUIs by default.
 */
export function getPtySequenceForKeyboardEvent(e: Pick<KeyboardEvent, "type" | "key" | "shiftKey">): string | null {
  if (e.type === "keydown" && e.shiftKey && e.key === "Enter") {
    // CSI u modified-key encoding: Enter (13) + Shift modifier (2).
    // TUIs such as prompt_toolkit/Claude-style prompts can distinguish this
    // from plain Enter and insert a newline without submitting.
    return SHIFT_ENTER_SEQUENCE;
  }

  return null;
}

export function shouldWriteObsidianContextBridgeBeforeSubmit(
  e: Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
): boolean {
  return (
    e.type === "keydown" &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey
  );
}

export function shouldCaptureObsidianContextBeforeSubmit(
  e: Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  enabled: boolean,
): boolean {
  return enabled && shouldWriteObsidianContextBridgeBeforeSubmit(e);
}

export function getTerminalEnterHandlingPlan(
  e: Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  attachEnabled: boolean,
): TerminalEnterHandlingStep[] {
  if (shouldWriteObsidianContextBridgeBeforeSubmit(e)) {
    return [
      { type: "write-obsidian-context-bridge", attachEnabled },
      { type: "allow-default-submit" },
    ];
  }

  const sequence = getPtySequenceForKeyboardEvent(e);
  return sequence ? [{ type: "write-pty-sequence", sequence }] : [];
}
