export const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

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
