import type { App } from "obsidian";

import { hashText } from "./text-hash";
import type { ObsidianContextFile, ObsidianSelectionContext } from "./obsidian-context-bridge";

/**
 * PDF selection support for the Hermes Console note-context bridge.
 *
 * Obsidian renders PDFs with its bundled pdf.js viewer. Every rendered page is a
 * `div.page[data-page-number]` containing a `div.textLayer` whose spans hold the
 * real page text (visually transparent, `cursor: text`, selectable). A PDF leaf
 * therefore exposes `file` and `containerEl` but no `editor`, so the
 * Markdown-only capture path never produces a candidate for it.
 *
 * This module reads the *DOM* selection instead of a CodeMirror editor, maps it
 * onto the surrounding `div.page`, and returns the very same
 * `ObsidianSelectionContext` shape the bridge already writes — so the
 * Hermes-side consumer keeps working unchanged.
 */

/** Page metadata attached to a PDF selection (absent on Markdown selections). */
export type ObsidianPdfSelectionMeta = {
  /** 1-based number of the page the selection starts on. */
  pageFrom: number;
  /** 1-based number of the page the selection ends on. */
  pageTo: number;
  /** Number of pages the selection spans. */
  pageCount: number;
  /** Total pages of the document when the viewer reported them. */
  totalPages: number | null;
};

/** Minimal DOM surface needed to read a selection; keeps tests DOM-free. */
export type DomNodeLike = {
  nodeType?: number;
  textContent?: string | null;
  parentElement?: DomNodeLike | null;
  closest?: (selector: string) => DomNodeLike | null;
  contains?: (node: DomNodeLike) => boolean;
  getAttribute?: (name: string) => string | null;
  ownerDocument?: DomDocumentLike | null;
};

export type DomRangeLike = {
  collapsed: boolean;
  commonAncestorContainer: DomNodeLike;
  startContainer: DomNodeLike;
  endContainer: DomNodeLike;
  toString: () => string;
  cloneContents?: () => { textContent?: string | null };
};

export type DomSelectionLike = {
  rangeCount: number;
  isCollapsed?: boolean;
  toString: () => string;
  getRangeAt: (index: number) => DomRangeLike;
};

export type DomDocumentLike = {
  getSelection?: () => DomSelectionLike | null;
};

type FileLike = {
  path: string;
  name?: string;
  basename?: string;
  extension?: string;
};

type PdfViewLike = {
  file?: FileLike;
  containerEl?: DomNodeLike;
  getViewType?: () => string;
};

type AppLike = App & {
  workspace?: { activeLeaf?: { view?: unknown } | null };
};

export type PdfCandidate = {
  file: FileLike;
  container: DomNodeLike;
};

/** Is this vault file a PDF? Mirrors the Markdown check in the bridge module. */
export function isPdfFile(file: FileLike | null | undefined): boolean {
  if (!file?.path) return false;
  if (file.extension) return file.extension.toLowerCase() === "pdf";
  return file.path.toLowerCase().endsWith(".pdf");
}

/**
 * Return the active leaf when it is a PDF view, else null.
 *
 * `getViewType()` is "pdf" for Obsidian's built-in PDF viewer. The extension
 * check is a fallback for views that do not report a type.
 */
export function findActivePdfCandidate(app: App): PdfCandidate | null {
  const view = (app as AppLike).workspace?.activeLeaf?.view;
  if (!view || typeof view !== "object") return null;
  const candidate = view as unknown as PdfViewLike;
  if (!candidate.file || !candidate.containerEl) return null;
  if (!isPdfFile(candidate.file)) return null;
  const viewType = typeof candidate.getViewType === "function" ? candidate.getViewType() : "";
  if (viewType && viewType !== "pdf") return null;
  return { file: candidate.file, container: candidate.containerEl };
}

/**
 * Read the live PDF text selection and convert it to bridge context.
 *
 * Returns null when there is no PDF leaf, no non-collapsed selection, or when
 * the selection lies outside the PDF's own container (for example a selection in
 * the sidebar or in the console terminal).
 *
 * Args:
 *   app: Obsidian app instance (only `workspace.activeLeaf` is touched).
 *   vaultPath: absolute vault root, used to fill in `file.absolutePath`.
 *   now: unused injection point kept out on purpose - the payload builder
 *     owns timestamps.
 *
 * Usage:
 *   const context = readObsidianPdfSelection(app, vaultPath);
 *
 * Demo (shape, with a two-span selection on page 84):
 *   { type: "selection", file: { path: "p.pdf", ... }, range: { from: { line: 83, column: 0 }, to: { line: 83, column: 0 } },
 *     selectedText: "5.3.1 基于位置的阻抗控制恒力打磨", lineCount: 1, charCount: 18, hash: "1a2b3c4d5e6f7a8b",
 *     pdf: { pageFrom: 84, pageTo: 84, pageCount: 1, totalPages: 90 } }
 */
export function readObsidianPdfSelection(
  app: App,
  vaultPath: string,
): ObsidianSelectionContext | null {
  const candidate = findActivePdfCandidate(app);
  if (!candidate) return null;

  const doc = candidate.container.ownerDocument;
  const selection = doc?.getSelection?.() ?? null;
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!range || range.collapsed) return null;
  if (!containerContains(candidate.container, range.commonAncestorContainer)) return null;

  const selectedText = extractPdfSelectionText(selection, range);
  if (!selectedText) return null;

  const pageFrom = pageNumberOf(range.startContainer) ?? pageNumberOf(range.endContainer) ?? 1;
  const pageTo = pageNumberOf(range.endContainer) ?? pageFrom;
  const lineCount = Math.max(1, pageTo - pageFrom + 1);

  return {
    type: "selection",
    source: "active",
    file: buildContextFile(candidate.file, vaultPath),
    // Pages are mapped onto the bridge's line-based range so the existing
    // formatter keeps working; `pdf` carries the real page numbers.
    range: {
      from: { line: pageFrom - 1, column: 0 },
      to: { line: pageTo - 1, column: 0 },
    },
    selectedText,
    lineCount,
    charCount: selectedText.length,
    hash: hashText(selectedText),
    pdf: {
      pageFrom,
      pageTo,
      pageCount: lineCount,
      totalPages: totalPages(candidate.container),
    },
  };
}

/**
 * Extract the selected text, preferring a source that survives CSS.
 *
 * Obsidian's PDF chrome sets `user-select: none` on the elements above the text
 * layer, and Chromium then reports an EMPTY `Selection.toString()` for a
 * selection inside it even though the range is intact. Falling back to the
 * Range API (`toString()` / `cloneContents().textContent`) is therefore not
 * optional - a naive `String(window.getSelection())` implementation captures
 * nothing.
 */
export function extractPdfSelectionText(
  selection: DomSelectionLike,
  range: DomRangeLike,
): string {
  const candidates = [
    safeCall(() => selection.toString()),
    safeCall(() => range.toString()),
    safeCall(() => range.cloneContents?.()?.textContent ?? null),
  ];
  for (const candidate of candidates) {
    const normalized = normalizePdfText(candidate);
    if (normalized) return normalized;
  }
  return "";
}

/**
 * Collapse pdf.js text-run whitespace into single spaces.
 *
 * The text layer is a set of absolutely positioned runs: hard line breaks, page
 * headers and hyphenation all arrive as separate runs, so the extracted text
 * needs normalising before it is worth spending context on.
 */
export function normalizePdfText(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function containerContains(container: DomNodeLike, node: DomNodeLike): boolean {
  if (container === node) return true;
  if (typeof container.contains === "function") {
    try {
      return container.contains(node);
    } catch {
      return false;
    }
  }
  // Containment cannot be established (bare DOM stub): refuse rather than
  // attach a selection belonging to some other view.
  return false;
}

/** 1-based page number of the `div.page` an element sits in, else null. */
function pageNumberOf(node: DomNodeLike | null | undefined): number | null {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element || typeof element.closest !== "function") return null;
  const page = element.closest(".page");
  const raw = page?.getAttribute?.("data-page-number") ?? null;
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/** Total pages when the viewer exposes its page containers, else null. */
function totalPages(container: DomNodeLike): number | null {
  const query = (container as { querySelectorAll?: (selector: string) => ArrayLike<unknown> })
    .querySelectorAll;
  if (typeof query !== "function") return null;
  try {
    return query.call(container, ".page").length || null;
  } catch {
    return null;
  }
}

function buildContextFile(file: FileLike, vaultPath: string): ObsidianContextFile {
  const name = file.name ?? file.path.split("/").pop() ?? file.path;
  return {
    path: file.path,
    absolutePath: joinPath(vaultPath, file.path),
    name,
    basename: file.basename ?? name.replace(/\.[a-z0-9]+$/i, ""),
  };
}

function joinPath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return "";
  const first = filtered[0].replace(/[\\/]+$/g, "");
  const rest = filtered.slice(1).map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [first, ...rest].filter(Boolean).join("/");
}

function safeCall<T>(fn: () => T): string | null {
  try {
    const value = fn();
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
