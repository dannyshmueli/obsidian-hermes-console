import { describe, expect, it, vi } from "vitest";

import { createLazyStartupGate } from "./startup-command";

describe("createLazyStartupGate", () => {
  it("stays idle while the tab is untouched — no keystroke, no launch", () => {
    const write = vi.fn();

    createLazyStartupGate(write);

    expect(write).not.toHaveBeenCalled();
  });

  it("swallows the first keystroke and fires the command exactly once", () => {
    const write = vi.fn();
    const gate = createLazyStartupGate(write);

    expect(gate("\r")).toBe(false);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("passes input through after the command fired and never re-fires it", () => {
    const write = vi.fn();
    const gate = createLazyStartupGate(write);

    gate("\r");

    expect(gate("x")).toBe(true);
    expect(gate("\r")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
