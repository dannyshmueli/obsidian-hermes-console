import { describe, expect, it } from "vitest";

import {
  buildObsidianContextBridgePayload,
  describeObsidianContextHeaderDetails,
  describeObsidianContextForHeader,
  ObsidianContextTracker,
  OBSIDIAN_CONTEXT_BRIDGE_SCHEMA_VERSION,
  type ObsidianContextBridgePayload,
} from "./obsidian-context-bridge";
import {
  findActivePdfCandidate,
  isPdfFile,
  normalizePdfText,
  readObsidianPdfSelection,
  type DomSelectionLike,
} from "./obsidian-pdf-context";
import { countWords } from "./text-stats";

/**
 * These fakes reproduce the DOM shape Obsidian's pdf.js viewer exposes, as
 * measured live in Obsidian 1.14.4: the leaf has `file` + `containerEl` and no
 * `editor`; the text lives in `div.page[data-page-number] > div.textLayer`;
 * and `Selection.toString()` returns "" because the viewer chrome sets
 * `user-select: none` above the text layer, while `Range.toString()` still
 * yields the text.
 */

const PDF_PATH = "papers/基于力位混合控制的焊缝打磨机械臂运动控制研究_朱坤.pdf";
const PDF_TEXT = "5.3.1 基于位置的阻抗控制恒力打磨";

type PageElementFake = {
  nodeType: number;
  getAttribute: (name: string) => string | null;
};

const pageElement = (pageNumber: number | null): PageElementFake => ({
  nodeType: 1,
  getAttribute: (name: string) =>
    name === "data-page-number" && pageNumber !== null ? String(pageNumber) : null,
});

const textNode = (pageNumber: number | null) => {
  const page = pageElement(pageNumber);
  return {
    nodeType: 3,
    parentElement: {
      nodeType: 1,
      closest: (selector: string) => (selector === ".page" ? page : null),
    },
  };
};

const textLayerElement = (pageNumber: number | null) => {
  const page = pageElement(pageNumber);
  return {
    nodeType: 1,
    closest: (selector: string) => (selector === ".page" ? page : null),
  };
};

const makeRange = (opts: {
  text: string;
  startPage?: number | null;
  endPage?: number | null;
  collapsed?: boolean;
  commonAncestorInside?: boolean;
}) => {
  const startPage = opts.startPage === undefined ? 84 : opts.startPage;
  const endPage = opts.endPage === undefined ? startPage : opts.endPage;
  return {
    collapsed: opts.collapsed ?? false,
    commonAncestorContainer: textLayerElement(opts.commonAncestorInside === false ? -1 : startPage),
    startContainer: textNode(startPage),
    endContainer: textNode(endPage),
    toString: () => opts.text,
    cloneContents: () => ({ textContent: opts.text }),
  };
};

const makeSelection = (range: ReturnType<typeof makeRange> | null, opts: { text?: string } = {}): DomSelectionLike => ({
  rangeCount: range ? 1 : 0,
  isCollapsed: range ? range.collapsed : true,
  toString: () => opts.text ?? "",
  getRangeAt: () => {
    if (!range) throw new Error("no range");
    return range;
  },
});

const makeApp = (opts: {
  selection?: DomSelectionLike | null;
  contains?: boolean;
  viewType?: string;
  totalPages?: number;
  existing?: boolean;
}) => {
  const container = {
    nodeType: 1,
    contains: () => opts.contains ?? true,
    querySelectorAll: (selector: string) =>
      selector === ".page" ? new Array(opts.totalPages ?? 90).fill(null) : [],
    ownerDocument: { getSelection: () => opts.selection ?? null },
  };
  const view = {
    file: {
      path: PDF_PATH,
      name: PDF_PATH.split("/").pop(),
      basename: "基于力位混合控制的焊缝打磨机械臂运动控制研究_朱坤",
      extension: "pdf",
    },
    containerEl: container,
    getViewType: () => opts.viewType ?? "pdf",
  };
  return {
    vault: {
      configDir: ".obsidian",
      adapter: { getBasePath: () => "/vault" },
      getAbstractFileByPath: (path: string) => (opts.existing === false ? null : { path }),
    },
    workspace: { activeLeaf: { view } },
  } as never;
};

describe("isPdfFile", () => {
  it("accepts pdf extensions case-insensitively and falls back to the path", () => {
    expect(isPdfFile({ path: "a.pdf", extension: "pdf" })).toBe(true);
    expect(isPdfFile({ path: "a.PDF" })).toBe(true);
    expect(isPdfFile({ path: "a.md", extension: "md" })).toBe(false);
    expect(isPdfFile(null)).toBe(false);
  });
});

describe("normalizePdfText", () => {
  it("collapses pdf.js text-run whitespace", () => {
    expect(normalizePdfText("  辽宁工业大学硕士学位论文76\n5.3.1  基于位置  ")).toBe(
      "辽宁工业大学硕士学位论文76 5.3.1 基于位置",
    );
    expect(normalizePdfText("")).toBe("");
    expect(normalizePdfText(null)).toBe("");
  });
});

describe("findActivePdfCandidate", () => {
  it("finds a pdf leaf and refuses non-pdf views", () => {
    expect(findActivePdfCandidate(makeApp({}))).not.toBeNull();
    expect(findActivePdfCandidate(makeApp({ viewType: "markdown" }))).toBeNull();
  });
});

describe("readObsidianPdfSelection", () => {
  it("reads the DOM selection, maps it onto a page and normalizes the text", () => {
    const app = makeApp({ selection: makeSelection(makeRange({ text: PDF_TEXT })) });
    const context = readObsidianPdfSelection(app, "/vault");

    expect(context).not.toBeNull();
    expect(context!.type).toBe("selection");
    expect(context!.source).toBe("active");
    expect(context!.selectedText).toBe(PDF_TEXT);
    expect(context!.charCount).toBe(PDF_TEXT.length);
    expect(context!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(context!.pdf).toEqual({ pageFrom: 84, pageTo: 84, pageCount: 1, totalPages: 90 });
    // Pages map onto the bridge's line-based range (0-based line, column 0).
    expect(context!.range).toEqual({ from: { line: 83, column: 0 }, to: { line: 83, column: 0 } });
    expect(context!.file.path).toBe(PDF_PATH);
    expect(context!.file.absolutePath).toBe(`/vault/${PDF_PATH}`);
    expect(context!.file.basename).toBe("基于力位混合控制的焊缝打磨机械臂运动控制研究_朱坤");
  });

  it("falls back to the Range API when Selection.toString() is empty (measured Obsidian behaviour)", () => {
    const app = makeApp({
      selection: makeSelection(makeRange({ text: PDF_TEXT }), { text: "" }),
    });
    const context = readObsidianPdfSelection(app, "/vault");

    expect(context!.selectedText).toBe(PDF_TEXT);
  });

  it("spans several pages when the selection crosses page boundaries", () => {
    const app = makeApp({
      selection: makeSelection(
        makeRange({ text: "第一页末尾 第二页开头", startPage: 82, endPage: 84 }),
      ),
    });
    const context = readObsidianPdfSelection(app, "/vault");

    expect(context!.pdf).toEqual({ pageFrom: 82, pageTo: 84, pageCount: 3, totalPages: 90 });
    expect(context!.lineCount).toBe(3);
  });

  it("ignores collapsed selections, empty selections and selections outside the PDF view", () => {
    expect(readObsidianPdfSelection(makeApp({ selection: null }), "/vault")).toBeNull();
    expect(
      readObsidianPdfSelection(
        makeApp({ selection: makeSelection(makeRange({ text: PDF_TEXT, collapsed: true })) }),
        "/vault",
      ),
    ).toBeNull();
    expect(
      readObsidianPdfSelection(
        makeApp({ selection: makeSelection(makeRange({ text: "   " })) }),
        "/vault",
      ),
    ).toBeNull();
    expect(
      readObsidianPdfSelection(
        makeApp({ selection: makeSelection(makeRange({ text: PDF_TEXT })), contains: false }),
        "/vault",
      ),
    ).toBeNull();
  });
});

describe("ObsidianContextTracker with a PDF selection", () => {
  const payloadContext = (app: never, tracker: ObsidianContextTracker, now: Date) =>
    buildObsidianContextBridgePayload({
      app,
      tracker,
      submitSequence: 7,
      terminalId: "terminal-2",
      terminalTitle: "Researcher",
      now,
    });

  it("keeps the snapshot after focus moves to the console terminal", () => {
    const app = makeApp({ selection: makeSelection(makeRange({ text: PDF_TEXT })) });
    const tracker = new ObsidianContextTracker();

    tracker.rememberFromApp(app);
    // The user clicked into the console terminal: the PDF is no longer active,
    // so a live read now yields nothing - the snapshot is what survives.
    (app as { workspace: { activeLeaf: unknown } }).workspace.activeLeaf = {
      view: { containerEl: { nodeType: 1 }, getViewType: () => "terminal-view" },
    };

    expect(tracker.getPdfSnapshot(app)).not.toBeNull();
    const payload = payloadContext(app, tracker, new Date("2026-10-22T09:00:00.000Z"));
    expect(payload.context).not.toBeNull();
    expect(payload.context!.type).toBe("selection");
    expect((payload.context as { selectedText: string }).selectedText).toBe(PDF_TEXT);
    expect(payload.schemaVersion).toBe(OBSIDIAN_CONTEXT_BRIDGE_SCHEMA_VERSION);
    expect(payload.attach.enabled).toBe(true);
  });

  it("drops the snapshot when the PDF file is gone", () => {
    const app = makeApp({ selection: makeSelection(makeRange({ text: PDF_TEXT })) });
    const tracker = new ObsidianContextTracker();
    tracker.rememberFromApp(app);

    const missing = makeApp({ existing: false });
    (missing as { workspace: unknown }).workspace = (app as { workspace: unknown }).workspace;
    expect(tracker.getPdfSnapshot(missing)).toBeNull();
  });
});

describe("describeObsidianContextHeaderDetails for PDF selections", () => {
  const payload = (pdf: { pageFrom: number; pageTo: number; pageCount: number; totalPages: number | null }) =>
    ({
      schemaVersion: 1,
      source: "lean-obsidian-terminal",
      vaultPath: "/vault",
      bridgePath: "/vault/.obsidian/hermes/context.json",
      updatedAt: "2026-10-22T09:00:00.000Z",
      updateTimestamp: Date.parse("2026-10-22T09:00:00.000Z"),
      submitSequence: 1,
      attach: { enabled: true },
      terminal: { id: "terminal-2", title: "Researcher" },
      context: {
        type: "selection",
        source: "active",
        file: { path: PDF_PATH, absolutePath: `/vault/${PDF_PATH}`, name: "朱坤.pdf", basename: "朱坤" },
        range: { from: { line: 83, column: 0 }, to: { line: 83, column: 0 } },
        selectedText: PDF_TEXT,
        lineCount: 1,
        charCount: PDF_TEXT.length,
        hash: "aaaaaaaaaaaaaaaa",
        pdf,
      },
    }) as ObsidianContextBridgePayload;

  it("labels a single page and a page span", () => {
    expect(
      describeObsidianContextHeaderDetails(true, payload({ pageFrom: 84, pageTo: 84, pageCount: 1, totalPages: 90 })),
    ).toEqual({ file: "朱坤.pdf", context: `PDF p.84 (${countWords(PDF_TEXT)} words)` });
    expect(
      describeObsidianContextHeaderDetails(true, payload({ pageFrom: 82, pageTo: 84, pageCount: 3, totalPages: 90 }))
        .context,
    ).toBe(`PDF p.82-84 (${countWords(PDF_TEXT)} words)`);
    expect(
      describeObsidianContextForHeader(
        true,
        payload({ pageFrom: 82, pageTo: 84, pageCount: 3, totalPages: 90 }),
      ),
    ).toBe(`PDF p.82-84 朱坤.pdf (${countWords(PDF_TEXT)}w)`);
  });
});
