import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  ObsidianContextBridgeConsumer,
  ObsidianContextTracker,
  buildObsidianContextBridgePayload,
  describeObsidianContextForHeader,
  formatObsidianContextForHermesTurn,
} from "./obsidian-context-bridge";

type Pos = { line: number; ch: number };

const mdFile = (path: string) => ({
  path,
  name: path.split("/").pop() ?? path,
  basename: (path.split("/").pop() ?? path).replace(/\.md$/, ""),
  extension: "md",
});

const makeEditor = (
  lines: string[],
  opts: { selection?: string; from?: Pos; to?: Pos; cursor?: Pos } = {},
) => {
  const from = opts.from ?? { line: 0, ch: 0 };
  const to = opts.to ?? from;
  const cursor = opts.cursor ?? to;
  return {
    lineCount: () => lines.length,
    lastLine: () => lines.length - 1,
    getLine: (line: number) => lines[line] ?? "",
    getSelection: () => opts.selection ?? "",
    somethingSelected: () => Boolean(opts.selection),
    listSelections: () => [{ anchor: from, head: to }],
    getCursor: (side?: "from" | "to" | "head" | "anchor") => {
      if (side === "from" || side === "anchor") return from;
      if (side === "to" || side === "head") return to;
      return cursor;
    },
  };
};

const makeApp = (
  active: { file: ReturnType<typeof mdFile>; editor: ReturnType<typeof makeEditor> } | null,
  existingPaths: string[] = active ? [active.file.path] : [],
) => ({
  vault: {
    configDir: ".obsidian",
    adapter: { getBasePath: () => "/vault" },
    getAbstractFileByPath: (path: string) =>
      existingPaths.includes(path) ? (active?.file ?? mdFile(path)) : null,
  },
  workspace: {
    activeLeaf: active ? { view: active } : null,
    getActiveFile: () => active?.file ?? null,
  },
} as unknown as App);

describe("buildObsidianContextBridgePayload", () => {
  it("writes an explicit fresh null context when no Markdown editor is valid", () => {
    const payload = buildObsidianContextBridgePayload({
      app: makeApp(null),
      tracker: new ObsidianContextTracker(),
      submitSequence: 1,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.context).toBeNull();
    expect(payload.attach.enabled).toBe(true);
    expect(payload.submitSequence).toBe(1);
    expect(payload.updatedAt).toBe("2026-05-16T12:00:00.000Z");
  });

  it("writes an explicit disabled attach marker without captured context", () => {
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Private.md"),
        editor: makeEditor(["secret"], {
          selection: "secret",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 6 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 2,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      attachEnabled: false,
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.attach.enabled).toBe(false);
    expect(payload.context).toBeNull();
    expect(formatObsidianContextForHermesTurn(payload)).toBe("");
  });

  it("captures selection context before cursor context", () => {
    const file = mdFile("Folder/Note.md");
    const app = makeApp({
      file,
      editor: makeEditor(["before", "alpha", "beta", "after"], {
        selection: "alpha\nbeta",
        from: { line: 1, ch: 0 },
        to: { line: 2, ch: 4 },
      }),
    });

    const payload = buildObsidianContextBridgePayload({
      app,
      tracker: new ObsidianContextTracker(),
      submitSequence: 3,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.context?.type).toBe("selection");
    if (payload.context?.type !== "selection") throw new Error("expected selection context");
    expect(payload.context.file.path).toBe("Folder/Note.md");
    expect(payload.context.file.absolutePath).toBe("/vault/Folder/Note.md");
    expect(payload.context.range).toEqual({
      from: { line: 1, column: 0 },
      to: { line: 2, column: 4 },
    });
    expect(payload.context.selectedText).toBe("alpha\nbeta");
    expect(payload.context.lineCount).toBe(2);
    expect(payload.context.hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("falls back to active cursor context with surrounding file lines capped", () => {
    const longLine = "x".repeat(2500);
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Long.md"),
        editor: makeEditor(["one", "two", longLine, "four", "five"], {
          cursor: { line: 2, ch: 10 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 4,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.context?.type).toBe("cursor");
    if (payload.context?.type !== "cursor") throw new Error("expected cursor context");
    expect(payload.context.cursor).toEqual({ line: 2, column: 10 });
    expect(payload.context.beforeLines.map((line) => line.text)).toEqual(["one", "two"]);
    expect(payload.context.afterLines.map((line) => line.text)).toEqual(["four", "five"]);
    expect(payload.context.currentLine.length).toBeLessThanOrEqual(2000);
    expect(payload.context.charCount).toBeLessThanOrEqual(2000);
    expect(payload.context.truncated).toBe(true);
  });

  it("caps total cursor context when surrounding lines are huge", () => {
    const hugeBefore = "b".repeat(5000);
    const hugeAfter = "a".repeat(5000);
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Surrounding.md"),
        editor: makeEditor([hugeBefore, "current", hugeAfter], {
          cursor: { line: 1, ch: 3 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 5,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.context?.type).toBe("cursor");
    if (payload.context?.type !== "cursor") throw new Error("expected cursor context");
    expect(payload.context.currentLine).toBe("current");
    expect(payload.context.charCount).toBeLessThanOrEqual(2000);
    expect(
      payload.context.beforeLines.reduce((sum, line) => sum + line.text.length, 0) +
      payload.context.currentLine.length +
      payload.context.afterLines.reduce((sum, line) => sum + line.text.length, 0),
    ).toBe(payload.context.charCount);
    expect(payload.context.truncated).toBe(true);
  });

  it("uses the cached Markdown editor when the terminal has focus", () => {
    const tracker = new ObsidianContextTracker();
    const remembered = {
      file: mdFile("Remembered.md"),
      editor: makeEditor(["cached line"], { cursor: { line: 0, ch: 6 } }),
    };
    tracker.rememberFromApp(makeApp(remembered));

    const payload = buildObsidianContextBridgePayload({
      app: makeApp(null, ["Remembered.md"]),
      tracker,
      submitSequence: 6,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.context?.type).toBe("cursor");
    expect(payload.context?.file.path).toBe("Remembered.md");
    expect(payload.context?.source).toBe("cached");
  });

  it("rejects deleted cached Markdown context and writes null", () => {
    const tracker = new ObsidianContextTracker();
    const remembered = {
      file: mdFile("Deleted.md"),
      editor: makeEditor(["stale"], { cursor: { line: 0, ch: 1 } }),
    };
    tracker.rememberFromApp(makeApp(remembered));

    const payload = buildObsidianContextBridgePayload({
      app: makeApp(null, []),
      tracker,
      submitSequence: 7,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(payload.context).toBeNull();
  });
});

describe("ObsidianContextBridgeConsumer", () => {
  it("injects normal selections inline once and exposes full text through obsidian_context", () => {
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Inline.md"),
        editor: makeEditor(["alpha", "beta"], {
          selection: "alpha\nbeta",
          from: { line: 0, ch: 0 },
          to: { line: 1, ch: 4 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 10,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const consumer = new ObsidianContextBridgeConsumer({
      now: () => Date.parse("2026-05-16T12:00:01.000Z"),
    });

    const accepted = consumer.consume(payload);

    expect(accepted?.injection).toContain("Treat this Obsidian selection as the primary object");
    expect(accepted?.injection).toContain("alpha\nbeta");
    expect(consumer.obsidian_context()).toMatchObject({
      type: "selection",
      selectedText: "alpha\nbeta",
    });
    expect(consumer.consume(payload)).toBeNull();
  });

  it("uses a preview plus obsidian_context hint for large selections", () => {
    const selectedText = "0123456789".repeat(450);
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Large.md"),
        editor: makeEditor([selectedText], {
          selection: selectedText,
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: selectedText.length },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 11,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    const injection = formatObsidianContextForHermesTurn(payload);

    expect(injection).toContain("Large.md");
    expect(injection).toContain("operate on this block directly");
    expect(injection).toContain("obsidian_context()");
    expect(injection).toContain(selectedText.slice(0, 500));
    expect(injection).not.toContain(selectedText);
  });

  it("returns full large selections through obsidian_context after preview injection", () => {
    const selectedText = "large-selection\n".repeat(350);
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Large.md"),
        editor: makeEditor([selectedText], {
          selection: selectedText,
          from: { line: 0, ch: 0 },
          to: { line: 349, ch: 0 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 12,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const consumer = new ObsidianContextBridgeConsumer({
      now: () => Date.parse("2026-05-16T12:00:01.000Z"),
    });

    consumer.consume(payload);

    expect(consumer.obsidian_context()).toMatchObject({
      type: "selection",
      text: selectedText,
    });
  });

  it("returns richer cursor/file context through obsidian_context", () => {
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Cursor.md"),
        editor: makeEditor(["before", "current", "after"], {
          cursor: { line: 1, ch: 3 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 13,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const consumer = new ObsidianContextBridgeConsumer({
      now: () => Date.parse("2026-05-16T12:00:01.000Z"),
    });

    consumer.consume(payload);

    expect(consumer.obsidian_context()).toMatchObject({
      type: "cursor",
      file: { path: "Cursor.md", absolutePath: "/vault/Cursor.md" },
      cursor: { line: 1, column: 3 },
      currentLine: "current",
      beforeLines: [{ line: 0, text: "before" }],
      afterLines: [{ line: 2, text: "after" }],
    });
  });

  it("clears accepted context when a fresh null marker is consumed", () => {
    const consumer = new ObsidianContextBridgeConsumer({
      now: () => Date.parse("2026-05-16T12:00:01.000Z"),
    });
    const selectionPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Inline.md"),
        editor: makeEditor(["alpha"], {
          selection: "alpha",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 5 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 14,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const nullPayload = buildObsidianContextBridgePayload({
      app: makeApp(null),
      tracker: new ObsidianContextTracker(),
      submitSequence: 15,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.500Z"),
    });

    consumer.consume(selectionPayload);
    const acceptedNull = consumer.consume(nullPayload);

    expect(acceptedNull?.injection).toBe("");
    expect(consumer.obsidian_context()).toBeNull();
    expect(consumer.consume(selectionPayload)).toBeNull();
  });

  it("clears accepted context when a fresh disabled attach marker is consumed", () => {
    const consumer = new ObsidianContextBridgeConsumer({
      now: () => Date.parse("2026-05-16T12:00:01.000Z"),
    });
    const selectionPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Inline.md"),
        editor: makeEditor(["alpha"], {
          selection: "alpha",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 5 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 18,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const disabledPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Inline.md"),
        editor: makeEditor(["secret"], {
          selection: "secret",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 6 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 19,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      attachEnabled: false,
      now: new Date("2026-05-16T12:00:00.500Z"),
    });

    consumer.consume(selectionPayload);
    const acceptedDisabled = consumer.consume(disabledPayload);

    expect(acceptedDisabled?.injection).toBe("");
    expect(acceptedDisabled?.context).toBeNull();
    expect(consumer.obsidian_context()).toBeNull();
  });

  it("accepts a newer timestamp when submit sequence resets after reload", () => {
    let now = Date.parse("2026-05-16T12:00:01.000Z");
    const consumer = new ObsidianContextBridgeConsumer({ now: () => now });
    const firstPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("BeforeReload.md"),
        editor: makeEditor(["before"], {
          selection: "before",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 6 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 20,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const resetPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("AfterReload.md"),
        editor: makeEditor(["after"], {
          selection: "after",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 5 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 1,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.500Z"),
    });

    consumer.consume(firstPayload);
    now = Date.parse("2026-05-16T12:00:01.500Z");
    const accepted = consumer.consume(resetPayload);

    expect(accepted?.injection).toContain("AfterReload.md");
    expect(consumer.obsidian_context()).toMatchObject({
      type: "selection",
      selectedText: "after",
    });
  });

  it("accepts a distinct same-timestamp payload from another manager but rejects exact duplicates", () => {
    const consumer = new ObsidianContextBridgeConsumer({
      now: () => Date.parse("2026-05-16T12:00:01.000Z"),
    });
    const firstPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("ManagerOne.md"),
        editor: makeEditor(["one"], {
          selection: "one",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 3 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 1,
      terminalId: "terminal-1",
      terminalTitle: "Hermes 1",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const secondPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("ManagerTwo.md"),
        editor: makeEditor(["two"], {
          selection: "two",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 3 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 1,
      terminalId: "terminal-2",
      terminalTitle: "Hermes 2",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(consumer.consume(firstPayload)?.injection).toContain("ManagerOne.md");
    expect(consumer.consume(firstPayload)).toBeNull();
    expect(consumer.consume(secondPayload)?.injection).toContain("ManagerTwo.md");
    expect(consumer.obsidian_context()).toMatchObject({
      type: "selection",
      selectedText: "two",
    });
  });

  it("rejects stale bridge payloads", () => {
    const consumer = new ObsidianContextBridgeConsumer({
      maxAgeMs: 1000,
      now: () => Date.parse("2026-05-16T12:00:05.000Z"),
    });
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Old.md"),
        editor: makeEditor(["old"], { cursor: { line: 0, ch: 0 } }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 16,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(consumer.consume(payload)).toBeNull();
    expect(consumer.obsidian_context()).toBeNull();
  });

  it("does not return previously accepted context after the freshness window", () => {
    let now = Date.parse("2026-05-16T12:00:01.000Z");
    const consumer = new ObsidianContextBridgeConsumer({
      maxAgeMs: 1000,
      now: () => now,
    });
    const payload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Fresh.md"),
        editor: makeEditor(["fresh"], {
          selection: "fresh",
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 5 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 17,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.500Z"),
    });

    consumer.consume(payload);
    now = Date.parse("2026-05-16T12:00:02.000Z");

    expect(consumer.obsidian_context()).toBeNull();
  });
});

describe("describeObsidianContextForHeader", () => {
  it("reports off, no-context, selection, and cursor states", () => {
    const selectionPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Header.md"),
        editor: makeEditor(["one", "two"], {
          selection: "one\ntwo",
          from: { line: 0, ch: 0 },
          to: { line: 1, ch: 3 },
        }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 20,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });
    const cursorPayload = buildObsidianContextBridgePayload({
      app: makeApp({
        file: mdFile("Cursor.md"),
        editor: makeEditor(["line"], { cursor: { line: 0, ch: 2 } }),
      }),
      tracker: new ObsidianContextTracker(),
      submitSequence: 21,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    });

    expect(describeObsidianContextForHeader(false, selectionPayload)).toBe("OFF");
    expect(describeObsidianContextForHeader(true, null)).toBe("ON - no active terminal");
    expect(describeObsidianContextForHeader(true, buildObsidianContextBridgePayload({
      app: makeApp(null),
      tracker: new ObsidianContextTracker(),
      submitSequence: 22,
      terminalId: "terminal-1",
      terminalTitle: "Hermes",
      now: new Date("2026-05-16T12:00:00.000Z"),
    }))).toBe("ON · No Markdown context");
    expect(describeObsidianContextForHeader(true, selectionPayload)).toBe("ON · Selection: 2 lines from Header.md");
    expect(describeObsidianContextForHeader(true, cursorPayload)).toBe("ON · Cursor: Cursor.md:1");
  });
});
