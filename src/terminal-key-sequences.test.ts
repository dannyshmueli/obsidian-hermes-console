import { describe, expect, it } from "vitest";
import {
  getTerminalEnterHandlingPlan,
  getPtySequenceForKeyboardEvent,
  SHIFT_ENTER_SEQUENCE,
  shouldCaptureObsidianContextBeforeSubmit,
  shouldWriteObsidianContextBridgeBeforeSubmit,
} from "./terminal-key-sequences";

const keyEvent = (
  overrides: Partial<Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">>,
) => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
} as Pick<KeyboardEvent, "type" | "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">);

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

describe("shouldCaptureObsidianContextBeforeSubmit", () => {
  it("captures context on plain Enter when the bridge is enabled", () => {
    expect(shouldCaptureObsidianContextBeforeSubmit(keyEvent({}), true)).toBe(true);
  });

  it("does not capture context when the bridge toggle is off", () => {
    expect(shouldCaptureObsidianContextBeforeSubmit(keyEvent({}), false)).toBe(false);
  });

  it("does not treat Shift+Enter as submit context capture", () => {
    expect(shouldCaptureObsidianContextBeforeSubmit(keyEvent({ shiftKey: true }), true)).toBe(false);
  });

  it("does not capture modified Enter variants", () => {
    expect(shouldCaptureObsidianContextBeforeSubmit(keyEvent({ ctrlKey: true }), true)).toBe(false);
    expect(shouldCaptureObsidianContextBeforeSubmit(keyEvent({ altKey: true }), true)).toBe(false);
    expect(shouldCaptureObsidianContextBeforeSubmit(keyEvent({ metaKey: true }), true)).toBe(false);
  });
});

describe("shouldWriteObsidianContextBridgeBeforeSubmit", () => {
  it("writes a bridge marker for plain Enter even when attach is disabled", () => {
    expect(shouldWriteObsidianContextBridgeBeforeSubmit(keyEvent({}))).toBe(true);
  });

  it("does not write a bridge marker for Shift+Enter", () => {
    expect(shouldWriteObsidianContextBridgeBeforeSubmit(keyEvent({ shiftKey: true }))).toBe(false);
  });
});

describe("getTerminalEnterHandlingPlan", () => {
  it("orders bridge writes before allowing plain Enter to submit", () => {
    expect(getTerminalEnterHandlingPlan(keyEvent({}), true)).toEqual([
      { type: "write-obsidian-context-bridge", attachEnabled: true },
      { type: "allow-default-submit" },
    ]);
  });

  it("writes an explicit disabled marker before plain Enter submits when attach is off", () => {
    expect(getTerminalEnterHandlingPlan(keyEvent({}), false)).toEqual([
      { type: "write-obsidian-context-bridge", attachEnabled: false },
      { type: "allow-default-submit" },
    ]);
  });

  it("keeps Shift+Enter on the PTY path without any bridge write", () => {
    expect(getTerminalEnterHandlingPlan(keyEvent({ shiftKey: true }), true)).toEqual([
      { type: "write-pty-sequence", sequence: SHIFT_ENTER_SEQUENCE },
    ]);
  });
});
