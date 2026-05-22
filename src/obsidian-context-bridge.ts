import type { App } from "obsidian";

export const OBSIDIAN_CONTEXT_BRIDGE_SCHEMA_VERSION = 1;
export const INLINE_SELECTION_LIMIT = 4_000;
export const LARGE_SELECTION_PREVIEW_LIMIT = 500;
export const CURSOR_CONTEXT_CHAR_LIMIT = 2_000;
export const DEFAULT_CONTEXT_MAX_AGE_MS = 2 * 60 * 1000;

type EditorPositionLike = { line: number; ch: number };

type EditorLike = {
  getSelection?: () => string;
  somethingSelected?: () => boolean;
  listSelections?: () => Array<{ anchor: EditorPositionLike; head: EditorPositionLike }>;
  getCursor?: (side?: "from" | "to" | "head" | "anchor") => EditorPositionLike;
  getLine?: (line: number) => string;
  lineCount?: () => number;
  lastLine?: () => number;
};

type FileLike = {
  path: string;
  name?: string;
  basename?: string;
  extension?: string;
};

type AppLike = App & {
  vault?: {
    configDir?: string;
    adapter?: { getBasePath?: () => string };
    getAbstractFileByPath?: (path: string) => unknown;
  };
  workspace?: {
    activeLeaf?: { view?: unknown } | null;
    activeEditor?: unknown;
    getActiveFile?: () => FileLike | null;
  };
};

type MarkdownCandidateSource = "active" | "cached";

type MarkdownCandidate = {
  file: FileLike;
  editor: EditorLike;
  source: MarkdownCandidateSource;
};

export type ObsidianContextFile = {
  path: string;
  absolutePath: string;
  name: string;
  basename: string;
};

export type ObsidianContextPosition = {
  line: number;
  column: number;
};

export type ObsidianContextLine = {
  line: number;
  text: string;
};

export type ObsidianSelectionContext = {
  type: "selection";
  source: MarkdownCandidateSource;
  file: ObsidianContextFile;
  range: {
    from: ObsidianContextPosition;
    to: ObsidianContextPosition;
  };
  selectedText: string;
  lineCount: number;
  charCount: number;
  hash: string;
};

export type ObsidianCursorContext = {
  type: "cursor";
  source: MarkdownCandidateSource;
  file: ObsidianContextFile;
  cursor: ObsidianContextPosition;
  currentLine: string;
  beforeLines: ObsidianContextLine[];
  afterLines: ObsidianContextLine[];
  charCount: number;
  truncated: boolean;
};

export type ObsidianBridgeContext = ObsidianSelectionContext | ObsidianCursorContext;

export type ObsidianContextAttachState = {
  enabled: boolean;
};

export type ObsidianContextBridgePayload = {
  schemaVersion: 1;
  source: "lean-obsidian-terminal";
  vaultPath: string;
  bridgePath: string;
  updatedAt: string;
  updateTimestamp: number;
  submitSequence: number;
  attach: ObsidianContextAttachState;
  terminal: {
    id: string;
    title: string;
  };
  context: ObsidianBridgeContext | null;
};

export type AcceptedObsidianContext = {
  payload: ObsidianContextBridgePayload;
  context: ObsidianBridgeContext | null;
  injection: string;
};

export type ObsidianContextToolResult =
  | (ObsidianSelectionContext & { text: string })
  | ObsidianCursorContext
  | null;

export class ObsidianContextTracker {
  private cached: MarkdownCandidate | null = null;

  rememberFromApp(app: App): void {
    const candidate = findActiveMarkdownCandidate(app as AppLike);
    if (candidate && isFileAvailable(app as AppLike, candidate.file)) {
      this.cached = candidate;
    }
  }

  getCandidate(app: App): MarkdownCandidate | null {
    const appLike = app as AppLike;
    const active = findActiveMarkdownCandidate(appLike);
    if (active && isFileAvailable(appLike, active.file)) {
      this.cached = active;
      return active;
    }

    if (this.cached && isFileAvailable(appLike, this.cached.file)) {
      return { ...this.cached, source: "cached" };
    }

    this.cached = null;
    return null;
  }
}

export function buildObsidianContextBridgePayload(opts: {
  app: App;
  tracker: ObsidianContextTracker;
  submitSequence: number;
  terminalId: string;
  terminalTitle: string;
  attachEnabled?: boolean;
  now?: Date;
}): ObsidianContextBridgePayload {
  const now = opts.now ?? new Date();
  const app = opts.app as AppLike;
  const vaultPath = getVaultBasePath(app);
  const attachEnabled = opts.attachEnabled ?? true;
  const candidate = attachEnabled ? opts.tracker.getCandidate(opts.app) : null;
  const context = candidate ? buildContextFromCandidate(candidate, vaultPath) : null;

  return {
    schemaVersion: OBSIDIAN_CONTEXT_BRIDGE_SCHEMA_VERSION,
    source: "lean-obsidian-terminal",
    vaultPath,
    bridgePath: resolveObsidianContextBridgePath(opts.app),
    updatedAt: now.toISOString(),
    updateTimestamp: now.getTime(),
    submitSequence: opts.submitSequence,
    attach: {
      enabled: attachEnabled,
    },
    terminal: {
      id: opts.terminalId,
      title: opts.terminalTitle,
    },
    context,
  };
}

export function resolveObsidianContextBridgePath(app: App): string {
  const appLike = app as AppLike;
  const vaultPath = getVaultBasePath(appLike);
  const configDir = appLike.vault?.configDir || ".obsidian";
  return joinPath(vaultPath, configDir, "hermes", "context.json");
}

export function writeObsidianContextBridgePayloadSync(
  payload: ObsidianContextBridgePayload,
  bridgePath = payload.bridgePath,
): void {
  // Direct Node fs access is intentional here: the bridge file lives in the
  // vault config folder so the Hermes CLI process can read selected-note context
  // outside Obsidian's plugin runtime. Path is always resolved from this vault.
  const fs = getRuntimeRequire()("fs") as typeof import("fs");
  const path = getRuntimeRequire()("path") as typeof import("path");
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.writeFileSync(bridgePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function readObsidianContextBridgePayloadSync(
  bridgePath: string,
): ObsidianContextBridgePayload | null {
  try {
    // Direct Node fs access is intentional here: this mirrors the Hermes-side
    // bridge reader for tests/debugging and only reads the explicit bridge file
    // path created from the active vault config directory.
    const fs = getRuntimeRequire()("fs") as typeof import("fs");
    return parseObsidianContextBridgePayload(fs.readFileSync(bridgePath, "utf8"));
  } catch {
    return null;
  }
}

export function parseObsidianContextBridgePayload(raw: string): ObsidianContextBridgePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ObsidianContextBridgePayload>;
    if (parsed.schemaVersion !== OBSIDIAN_CONTEXT_BRIDGE_SCHEMA_VERSION) return null;
    if (parsed.source !== "lean-obsidian-terminal") return null;
    if (typeof parsed.submitSequence !== "number") return null;
    if (typeof parsed.updatedAt !== "string") return null;
    if (typeof parsed.updateTimestamp !== "number") {
      parsed.updateTimestamp = Date.parse(parsed.updatedAt);
    }
    if (!parsed.attach || typeof parsed.attach.enabled !== "boolean") return null;
    return parsed as ObsidianContextBridgePayload;
  } catch {
    return null;
  }
}

function safeJsonForSystemInjection(value: string): string {
  return JSON.stringify(value).replace(/[<>]/g, (char) => (char === "<" ? "\\u003c" : "\\u003e"));
}

export function formatObsidianContextForHermesTurn(
  payload: ObsidianContextBridgePayload,
): string {
  if (!payload.attach.enabled) return "";
  const context = payload.context;
  if (!context) return "";

  if (context.type === "selection") {
    const range = formatRange(context.range);
    const common = [
      `<obsidian_context type="selection">`,
      "instruction: Treat this Obsidian selection as the primary object of the user's request. If the user says this/selection/selected text, operate on this block directly; do not search the repo or inspect bridge files unless required.",
      `file: ${context.file.path}`,
      `absolute_path: ${context.file.absolutePath}`,
      `range: ${range}`,
      `line_count: ${context.lineCount}`,
      `char_count: ${context.charCount}`,
      `hash: ${context.hash}`,
    ];

    if (context.selectedText.length <= INLINE_SELECTION_LIMIT) {
      return [
        ...common,
        `selected_text_json: ${safeJsonForSystemInjection(context.selectedText)}`,
        "</obsidian_context>",
      ].join("\n");
    }

    return [
      ...common,
      `selected_text_preview: ${clipText(context.selectedText, LARGE_SELECTION_PREVIEW_LIMIT)}`,
      "Full selected text is available for this current turn by calling obsidian_context().",
      "</obsidian_context>",
    ].join("\n");
  }

  const lines = [
    ...context.beforeLines,
    { line: context.cursor.line, text: context.currentLine },
    ...context.afterLines,
  ];
  return [
    `<obsidian_context type="cursor">`,
    "instruction: Treat this Obsidian cursor context as the user's active note location. If the user says this/current line/nearby text, use this context directly before searching files.",
    `file: ${context.file.path}`,
    `absolute_path: ${context.file.absolutePath}`,
    `cursor: ${context.cursor.line + 1}:${context.cursor.column}`,
    `current_line: ${context.currentLine}`,
    "surrounding_lines:",
    ...lines.map((line) => `${line.line + 1}: ${line.text}`),
    "</obsidian_context>",
  ].join("\n");
}

export type ObsidianContextHeaderDetails = {
  file: string;
  context: string;
};

export function describeObsidianContextHeaderDetails(
  enabled: boolean,
  payload: ObsidianContextBridgePayload | null,
): ObsidianContextHeaderDetails {
  if (!enabled) return { file: "OFF", context: "note context disabled" };
  if (!payload) return { file: "No active terminal", context: "open a terminal tab" };
  if (!payload.attach.enabled) return { file: "OFF", context: "note context disabled" };
  if (!payload.context) return { file: "No Markdown context", context: "focus an Obsidian note" };
  if (payload.context.type === "selection") {
    const fromLine = payload.context.range.from.line + 1;
    const toLine = payload.context.range.to.line + 1;
    return {
      file: payload.context.file.name,
      context: `selected lines ${fromLine}-${toLine} (${payload.context.lineCount}L)`,
    };
  }
  return {
    file: payload.context.file.name,
    context: `cursor line ${payload.context.cursor.line + 1}`,
  };
}

export function describeObsidianContextForHeader(
  enabled: boolean,
  payload: ObsidianContextBridgePayload | null,
): string {
  if (!enabled) return "OFF";
  if (!payload) return "No active terminal";
  if (!payload.attach.enabled) return "OFF";
  if (!payload.context) return "No Markdown context";
  if (payload.context.type === "selection") {
    return `SEL ${payload.context.lineCount}L ${payload.context.file.name}:${payload.context.range.from.line + 1}-${payload.context.range.to.line + 1}`;
  }
  return `CUR ${payload.context.file.name}:${payload.context.cursor.line + 1}`;
}

export class ObsidianContextBridgeConsumer {
  private latestSubmitSequence = 0;
  private latestContext: ObsidianBridgeContext | null = null;
  private latestUpdateTimestamp = 0;
  private acceptedPayloadKeys = new Set<string>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: { maxAgeMs?: number; now?: () => number } = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_CONTEXT_MAX_AGE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  consume(payload: ObsidianContextBridgePayload | null): AcceptedObsidianContext | null {
    if (!payload) {
      this.latestContext = null;
      return null;
    }

    const updated = payload.updateTimestamp || Date.parse(payload.updatedAt);
    if (!this.isTimestampFresh(updated)) return null;
    if (updated < this.latestUpdateTimestamp) return null;

    const payloadKey = getPayloadFreshnessKey(payload, updated);
    if (this.acceptedPayloadKeys.has(payloadKey)) return null;

    this.latestSubmitSequence = payload.submitSequence;
    this.latestUpdateTimestamp = updated;
    this.acceptedPayloadKeys.add(payloadKey);
    if (this.acceptedPayloadKeys.size > 128) {
      const oldest = this.acceptedPayloadKeys.values().next().value as string | undefined;
      if (oldest) this.acceptedPayloadKeys.delete(oldest);
    }
    this.latestContext = payload.attach.enabled ? payload.context : null;

    return {
      payload,
      context: this.latestContext,
      injection: formatObsidianContextForHermesTurn(payload),
    };
  }

  obsidian_context(): ObsidianContextToolResult {
    if (this.latestContext && !this.isTimestampFresh(this.latestUpdateTimestamp)) {
      this.latestContext = null;
      return null;
    }
    if (!this.latestContext) return null;
    if (this.latestContext.type === "selection") {
      return {
        ...this.latestContext,
        text: this.latestContext.selectedText,
      };
    }
    return this.latestContext;
  }

  private isTimestampFresh(updated: number): boolean {
    if (!Number.isFinite(updated)) return false;
    return this.now() - updated <= this.maxAgeMs;
  }
}

function buildContextFromCandidate(
  candidate: MarkdownCandidate,
  vaultPath: string,
): ObsidianBridgeContext | null {
  const selection = readSelection(candidate, vaultPath);
  if (selection) return selection;
  return readCursor(candidate, vaultPath);
}

function getPayloadFreshnessKey(payload: ObsidianContextBridgePayload, updated: number): string {
  const context = payload.context;
  let contextKey = "none";
  if (context?.type === "selection") {
    contextKey = `selection:${context.file.path}:${context.hash}:${context.charCount}`;
  } else if (context?.type === "cursor") {
    contextKey = `cursor:${context.file.path}:${context.cursor.line}:${context.cursor.column}:${context.charCount}`;
  }

  return [
    updated,
    payload.submitSequence,
    payload.terminal.id,
    payload.attach.enabled ? "on" : "off",
    contextKey,
  ].join("|");
}

function readSelection(
  candidate: MarkdownCandidate,
  vaultPath: string,
): ObsidianSelectionContext | null {
  const selectedText = candidate.editor.getSelection?.() ?? "";
  const hasSelection = candidate.editor.somethingSelected?.() ?? selectedText.length > 0;
  if (!hasSelection || selectedText.length === 0) return null;

  const selection = candidate.editor.listSelections?.()[0];
  const from = selection ? minPosition(selection.anchor, selection.head) : candidate.editor.getCursor?.("from");
  const to = selection ? maxPosition(selection.anchor, selection.head) : candidate.editor.getCursor?.("to");
  if (!from || !to) return null;

  return {
    type: "selection",
    source: candidate.source,
    file: buildContextFile(candidate.file, vaultPath),
    range: {
      from: { line: from.line, column: from.ch },
      to: { line: to.line, column: to.ch },
    },
    selectedText,
    lineCount: Math.max(1, to.line - from.line + 1),
    charCount: selectedText.length,
    hash: hashText(selectedText),
  };
}

function readCursor(candidate: MarkdownCandidate, vaultPath: string): ObsidianCursorContext | null {
  const editor = candidate.editor;
  if (!editor.getCursor || !editor.getLine) return null;
  const totalLines = getEditorLineCount(editor);
  if (totalLines <= 0) return null;

  const rawCursor = editor.getCursor();
  const cursorLine = clamp(rawCursor.line, 0, totalLines - 1);
  const cursorColumn = Math.max(0, rawCursor.ch);
  const capped = capCursorContextLines({
    beforeLines: lineWindow(editor, Math.max(0, cursorLine - 2), cursorLine - 1),
    currentLine: editor.getLine(cursorLine),
    afterLines: lineWindow(editor, cursorLine + 1, Math.min(totalLines - 1, cursorLine + 2)),
    limit: CURSOR_CONTEXT_CHAR_LIMIT,
  });

  return {
    type: "cursor",
    source: candidate.source,
    file: buildContextFile(candidate.file, vaultPath),
    cursor: { line: cursorLine, column: cursorColumn },
    currentLine: capped.currentLine,
    beforeLines: capped.beforeLines,
    afterLines: capped.afterLines,
    charCount: capped.charCount,
    truncated: capped.truncated,
  };
}

function capCursorContextLines(opts: {
  beforeLines: ObsidianContextLine[];
  currentLine: string;
  afterLines: ObsidianContextLine[];
  limit: number;
}): Pick<ObsidianCursorContext, "beforeLines" | "currentLine" | "afterLines" | "charCount" | "truncated"> {
  const allLines = [
    ...opts.beforeLines.map((line) => ({ region: "before" as const, line })),
    { region: "current" as const, line: { line: -1, text: opts.currentLine } },
    ...opts.afterLines.map((line) => ({ region: "after" as const, line })),
  ];
  const rawCharCount = allLines.reduce((sum, entry) => sum + entry.line.text.length, 0);
  if (rawCharCount <= opts.limit) {
    return {
      beforeLines: opts.beforeLines,
      currentLine: opts.currentLine,
      afterLines: opts.afterLines,
      charCount: rawCharCount,
      truncated: false,
    };
  }

  const allocations = new Array(allLines.length).fill(0) as number[];
  const baseBudget = Math.floor(opts.limit / Math.max(1, allLines.length));
  let remaining = opts.limit;

  for (let index = 0; index < allLines.length; index++) {
    const allowed = Math.min(allLines[index].line.text.length, baseBudget);
    allocations[index] = allowed;
    remaining -= allowed;
  }

  for (const index of cursorContextPriorityIndexes(opts.beforeLines.length, opts.afterLines.length)) {
    if (remaining <= 0) break;
    const rawLength = allLines[index].line.text.length;
    const extra = Math.min(rawLength - allocations[index], remaining);
    allocations[index] += extra;
    remaining -= extra;
  }

  const beforeLines: ObsidianContextLine[] = [];
  const afterLines: ObsidianContextLine[] = [];
  let currentLine = "";
  let charCount = 0;
  let truncated = false;

  for (let index = 0; index < allLines.length; index++) {
    const entry = allLines[index];
    const clipped = clipText(entry.line.text, allocations[index]);
    charCount += clipped.length;
    if (clipped.length < entry.line.text.length) truncated = true;
    if (entry.region === "before") {
      if (clipped || entry.line.text.length === 0) beforeLines.push({ ...entry.line, text: clipped });
    } else if (entry.region === "after") {
      if (clipped || entry.line.text.length === 0) afterLines.push({ ...entry.line, text: clipped });
    } else {
      currentLine = clipped;
    }
  }

  return { beforeLines, currentLine, afterLines, charCount, truncated };
}

function cursorContextPriorityIndexes(beforeCount: number, afterCount: number): number[] {
  const currentIndex = beforeCount;
  const indexes = [currentIndex];
  const maxDistance = Math.max(beforeCount, afterCount);
  for (let distance = 1; distance <= maxDistance; distance++) {
    const beforeIndex = currentIndex - distance;
    const afterIndex = currentIndex + distance;
    if (beforeIndex >= 0) indexes.push(beforeIndex);
    if (distance <= afterCount) indexes.push(afterIndex);
  }
  return indexes;
}

function findActiveMarkdownCandidate(app: AppLike): MarkdownCandidate | null {
  const activeEditor = readEditorContainer(app.workspace?.activeEditor);
  if (activeEditor) return activeEditor;

  const activeLeafView = app.workspace?.activeLeaf?.view;
  const leafEditor = readEditorContainer(activeLeafView);
  if (leafEditor) return leafEditor;

  return null;
}

function readEditorContainer(container: unknown): MarkdownCandidate | null {
  if (!container || typeof container !== "object") return null;
  const source = container as { editor?: EditorLike; file?: FileLike };
  if (!source.editor || !source.file) return null;
  if (!isMarkdownFile(source.file)) return null;
  if (!isUsableEditor(source.editor)) return null;
  return { editor: source.editor, file: source.file, source: "active" };
}

function isUsableEditor(editor: EditorLike): boolean {
  return typeof editor.getLine === "function" && (
    typeof editor.lineCount === "function" ||
    typeof editor.lastLine === "function"
  );
}

function isMarkdownFile(file: FileLike | null | undefined): file is FileLike {
  if (!file?.path) return false;
  if (file.extension) return file.extension.toLowerCase() === "md";
  return file.path.toLowerCase().endsWith(".md");
}

function isFileAvailable(app: AppLike, file: FileLike): boolean {
  const lookup = app.vault?.getAbstractFileByPath;
  if (!lookup) return true;
  return Boolean(lookup.call(app.vault, file.path));
}

function buildContextFile(file: FileLike, vaultPath: string): ObsidianContextFile {
  const name = file.name ?? file.path.split("/").pop() ?? file.path;
  return {
    path: file.path,
    absolutePath: joinPath(vaultPath, file.path),
    name,
    basename: file.basename ?? name.replace(/\.md$/i, ""),
  };
}

function getVaultBasePath(app: AppLike): string {
  try {
    return app.vault?.adapter?.getBasePath?.() || "";
  } catch {
    return "";
  }
}

function getEditorLineCount(editor: EditorLike): number {
  if (editor.lineCount) return editor.lineCount();
  if (editor.lastLine) return editor.lastLine() + 1;
  return 0;
}

function lineWindow(editor: EditorLike, from: number, to: number): ObsidianContextLine[] {
  if (!editor.getLine || to < from) return [];
  const lines: ObsidianContextLine[] = [];
  for (let line = from; line <= to; line++) {
    lines.push({ line, text: editor.getLine(line) });
  }
  return lines;
}

function minPosition(a: EditorPositionLike, b: EditorPositionLike): EditorPositionLike {
  if (a.line < b.line) return a;
  if (a.line > b.line) return b;
  return a.ch <= b.ch ? a : b;
}

function maxPosition(a: EditorPositionLike, b: EditorPositionLike): EditorPositionLike {
  if (a.line > b.line) return a;
  if (a.line < b.line) return b;
  return a.ch >= b.ch ? a : b;
}

function formatRange(range: ObsidianSelectionContext["range"]): string {
  return `${range.from.line + 1}:${range.from.column}-${range.to.line + 1}:${range.to.column}`;
}

function clipText(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function joinPath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return "";
  const first = filtered[0].replace(/[\\/]+$/g, "");
  const rest = filtered.slice(1).map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [first, ...rest].filter(Boolean).join("/");
}

function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${toHex32(h1)}${toHex32(h2)}`;
}

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function getRuntimeRequire(): NodeRequire {
  const winRequire = typeof window !== "undefined"
    ? (window as unknown as { require?: NodeRequire }).require
    : undefined;
  if (winRequire) return winRequire;
  return require;
}
