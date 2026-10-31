/**
 * Locks in the DEFAULT_SETTINGS surface used by the teardown decision, so the
 * shipped install (fresh data.json without the key) gets the graceful exit.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "./settings";

describe("gracefulHermesExit default", () => {
  it("defaults to true — a used tab's session must not leak by default", () => {
    expect(DEFAULT_SETTINGS.gracefulHermesExit).toBe(true);
  });
});
