import { describe, expect, it } from "vitest";
import {
  getCloseButtonAction,
  getCloseConfirmationMessage,
  getTerminalViewCloseBlockedMessage,
  isDestructiveKillConfirmed,
  processStateRequiresDestructiveConfirmation,
  shouldBlockTerminalViewClose,
} from "./terminal-session-actions";

describe("terminal session safety actions", () => {
  it("uses confirmed close for the normal tab close button", () => {
    expect(getCloseButtonAction()).toBe("confirm-close");
  });

  it("warns that closing a terminal stops the underlying process", () => {
    expect(getCloseConfirmationMessage("Hermes wiki")).toBe(
      'Close terminal "Hermes wiki"? This will stop the running Hermes/session process.',
    );
  });

  it("requires exact terminal title confirmation for destructive kill", () => {
    expect(isDestructiveKillConfirmed("Hermes wiki", "Hermes wiki")).toBe(true);
    expect(isDestructiveKillConfirmed("Hermes wiki", "hermes wiki")).toBe(false);
    expect(isDestructiveKillConfirmed("Hermes wiki", " Hermes wiki ")).toBe(false);
  });

  it("treats running, idle, and unknown process states as dangerous", () => {
    expect(processStateRequiresDestructiveConfirmation("running")).toBe(true);
    expect(processStateRequiresDestructiveConfirmation("idle")).toBe(true);
    expect(processStateRequiresDestructiveConfirmation("unknown")).toBe(true);
    expect(processStateRequiresDestructiveConfirmation("exited")).toBe(false);
  });

  it("blocks workspace-level terminal view close while sessions exist unless authorized", () => {
    expect(shouldBlockTerminalViewClose(2, false)).toBe(true);
    expect(shouldBlockTerminalViewClose(1, true)).toBe(false);
    expect(shouldBlockTerminalViewClose(0, false)).toBe(false);
  });

  it("explains how to close the whole Hermes Console intentionally", () => {
    expect(getTerminalViewCloseBlockedMessage()).toBe(
      "Hermes Console kept open. Close Hermes tabs individually, or use the Close Hermes Console command.",
    );
  });
});
