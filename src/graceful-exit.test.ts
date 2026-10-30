import { describe, expect, it } from "vitest";

import {
  CTRL_D,
  GRACEFUL_EXIT_GRACE_MS,
  shouldUseGracefulExitDecision,
} from "./graceful-exit";

describe("shouldUseGracefulExitDecision", () => {
  it("uses the graceful exit when the setting is on and Hermes is not busy", () => {
    expect(
      shouldUseGracefulExitDecision({ gracefulHermesExit: true, hermesBusy: false })
    ).toBe(true);
  });

  it("keeps the hard kill while a Hermes turn is running (Ctrl+D would abort it)", () => {
    expect(
      shouldUseGracefulExitDecision({ gracefulHermesExit: true, hermesBusy: true })
    ).toBe(false);
  });

  it("keeps the hard kill when the setting is off", () => {
    expect(
      shouldUseGracefulExitDecision({ gracefulHermesExit: false, hermesBusy: false })
    ).toBe(false);
  });

  it("treats unknown/stale hook statuses (null) like not busy after parsing", () => {
    // readHermesHookBusyStatus returns null while no status file exists yet;
    // terminal-tab-manager passes `session.hermesBusy`, which is false there.
    expect(
      shouldUseGracefulExitDecision({ gracefulHermesExit: true, hermesBusy: false })
    ).toBe(true);
  });
});

describe("constants", () => {
  it("sends the terminal EOF byte (Ctrl+D), not a literal packet", () => {
    expect(CTRL_D).toBe("\u0004");
  });

  it("grace window covers the TUI's own 1.5s detach flight plus failsafe", () => {
    expect(GRACEFUL_EXIT_GRACE_MS).toBeGreaterThanOrEqual(4000);
  });
});
