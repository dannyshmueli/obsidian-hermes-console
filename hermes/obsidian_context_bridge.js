"use strict";

const fs = require("fs");

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;
const INLINE_SELECTION_LIMIT = 4000;
const LARGE_SELECTION_PREVIEW_LIMIT = 500;

class ObsidianHermesBridge {
  constructor(opts = {}) {
    this.bridgePath = opts.bridgePath || process.env.OBSIDIAN_CONTEXT_BRIDGE_PATH || "";
    this.maxAgeMs = opts.maxAgeMs || DEFAULT_MAX_AGE_MS;
    this.now = opts.now || (() => Date.now());
    this.latestSubmitSequence = 0;
    this.latestUpdateTimestamp = 0;
    this.acceptedPayloadKeys = new Set();
    this.latestContext = null;
  }

  pre_llm_call(turn) {
    const accepted = this.readAndConsume();
    const injection = accepted ? accepted.injection : "";
    if (injection) injectIntoTurn(turn, injection);
    return injection;
  }

  readAndConsume() {
    return this.consume(readPayloadSync(this.bridgePath));
  }

  consume(payload) {
    if (!payload) {
      this.latestContext = null;
      return null;
    }

    if (!isValidPayload(payload)) return null;

    const updated = payload.updateTimestamp || Date.parse(payload.updatedAt);
    if (!this.isTimestampFresh(updated)) return null;
    if (updated < this.latestUpdateTimestamp) return null;

    const payloadKey = getPayloadFreshnessKey(payload, updated);
    if (this.acceptedPayloadKeys.has(payloadKey)) return null;

    this.latestSubmitSequence = payload.submitSequence;
    this.latestUpdateTimestamp = updated;
    this.acceptedPayloadKeys.add(payloadKey);
    if (this.acceptedPayloadKeys.size > 128) {
      const oldest = this.acceptedPayloadKeys.values().next().value;
      if (oldest) this.acceptedPayloadKeys.delete(oldest);
    }
    this.latestContext = payload.attach.enabled ? payload.context : null;

    return {
      payload,
      context: this.latestContext,
      injection: formatObsidianContextForHermesTurn(payload),
    };
  }

  obsidian_context() {
    if (this.latestContext && !this.isTimestampFresh(this.latestUpdateTimestamp)) {
      this.latestContext = null;
      return null;
    }
    if (!this.latestContext) return null;
    if (this.latestContext.type === "selection") {
      return { ...this.latestContext, text: this.latestContext.selectedText };
    }
    return this.latestContext;
  }

  isTimestampFresh(updated) {
    return Number.isFinite(updated) && this.now() - updated <= this.maxAgeMs;
  }
}

function createObsidianHermesBridge(opts) {
  const bridge = new ObsidianHermesBridge(opts);
  return {
    pre_llm_call: (turn) => bridge.pre_llm_call(turn),
    obsidian_context: () => bridge.obsidian_context(),
    consume: (payload) => bridge.consume(payload),
    readAndConsume: () => bridge.readAndConsume(),
    bridge,
  };
}

function readPayloadSync(bridgePath) {
  if (!bridgePath) return null;
  try {
    return JSON.parse(fs.readFileSync(bridgePath, "utf8"));
  } catch {
    return null;
  }
}

function isValidPayload(payload) {
  return Boolean(
    payload &&
    payload.schemaVersion === SCHEMA_VERSION &&
    payload.source === "lean-obsidian-terminal" &&
    typeof payload.updatedAt === "string" &&
    typeof payload.submitSequence === "number" &&
    payload.attach &&
    typeof payload.attach.enabled === "boolean",
  );
}

function formatObsidianContextForHermesTurn(payload) {
  if (!payload.attach.enabled || !payload.context) return "";

  const context = payload.context;
  if (context.type === "selection") {
    const common = [
      '<obsidian_context type="selection">',
      "instruction: Treat this Obsidian selection as the primary object of the user's request. If the user says this/selection/selected text, operate on this block directly; do not search the repo or inspect bridge files unless required.",
      `file: ${context.file.path}`,
      `absolute_path: ${context.file.absolutePath}`,
      `range: ${formatRange(context.range)}`,
      `line_count: ${context.lineCount}`,
      `char_count: ${context.charCount}`,
      `hash: ${context.hash}`,
    ];

    if (context.selectedText.length <= INLINE_SELECTION_LIMIT) {
      return [
        ...common,
        "selected_text:",
        "```markdown",
        context.selectedText,
        "```",
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
    '<obsidian_context type="cursor">',
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

function getPayloadFreshnessKey(payload, updated) {
  const context = payload.context;
  let contextKey = "none";
  if (context && context.type === "selection") {
    contextKey = `selection:${context.file.path}:${context.hash}:${context.charCount}`;
  } else if (context && context.type === "cursor") {
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

function injectIntoTurn(turn, injection) {
  if (!turn) return;
  if (Array.isArray(turn)) {
    turn.push({ role: "system", content: injection });
    return;
  }
  if (Array.isArray(turn.messages)) {
    turn.messages.push({ role: "system", content: injection });
    return;
  }
  if (typeof turn.add_system_message === "function") {
    turn.add_system_message(injection);
    return;
  }
  if (typeof turn.addSystemMessage === "function") {
    turn.addSystemMessage(injection);
  }
}

function formatRange(range) {
  return `${range.from.line + 1}:${range.from.column}-${range.to.line + 1}:${range.to.column}`;
}

function clipText(text, limit) {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

module.exports = {
  ObsidianHermesBridge,
  createObsidianHermesBridge,
  formatObsidianContextForHermesTurn,
  readPayloadSync,
};
