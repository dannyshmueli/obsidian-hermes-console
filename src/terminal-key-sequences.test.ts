import { describe, expect, it } from "vitest";
import { getPtySequenceForKeyboardEvent, SHIFT_ENTER_SEQUENCE } from "./terminal-key-sequences";

const keyEvent = (overrides: Partial<Pick<KeyboardEvent, "type" | "key" | "shiftKey">>) => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  ...overrides,
} as Pick<KeyboardEvent, "type" | "key" | "shiftKey">);

describe("getPtySequenceForKeyboardEvent", () => {
  it("encodes Shift+Enter as modified Enter instead of a raw linefeed", () => {
    const sequence = getPtySequenceForKeyboardEvent(keyEvent({ shiftKey: true }));

    expect(sequence).toBe(SHIFT_ENTER_SEQUENCE);
    expect(sequence).not.toBe("\n");
    expect(sequence).not.toBe("\r");
  });

  it("does not override plain Enter", () => {
    expect(getPtySequenceForKeyboardEvent(keyEvent({ shiftKey: false }))).toBeNull();
  });

  it("only handles keydown events", () => {
    expect(getPtySequenceForKeyboardEvent(keyEvent({ type: "keyup", shiftKey: true }))).toBeNull();
  });
});
