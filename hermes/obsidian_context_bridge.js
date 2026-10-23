"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;
const INLINE_SELECTION_LIMIT = 4000;
const LARGE_SELECTION_PREVIEW_LIMIT = 500;

/**
 * Bridge pointer file: `$XDG_CONFIG_HOME/hermes-console/bridge.json`, written by
 * the Obsidian half (see src/obsidian-bridge-pointer.ts).
 *
 * The per-vault bridge file is only reachable when the Hermes process inherited
 * the PTY environment (`OBSIDIAN_CONTEXT_BRIDGE_PATH`). Any process boundary in
 * between — a gateway/service, a container, a remote backend, a cron turn —
 * drops it, so the pointer file publishes the active vault's bridge path at a
 * fixed location instead. This module mirrors the Python implementation
 * (`hermes/__init__.py::_resolve_bridge_path`) so the two stay in step.
 */
const BRIDGE_POINTER_SCHEMA_VERSION = 1;
const BRIDGE_POINTER_DIR_NAME = "hermes-console";
const BRIDGE_POINTER_FILE_NAME = "bridge.json";
const VAULT_CONFIG_DIR_NAMES = [".obsidian", "_obsidian"];
const MAX_DIRS_SCANNED = 64;
const MAX_CHECKED_PATHS_REPORTED = 8;

const NO_CONTEXT_HINT =
  "No Obsidian context in this turn. Press Enter in Hermes Console with the tab's " +
  "'Send context to Hermes' toggle on; if reason is bridge_path_unset, set " +
  "OBSIDIAN_CONTEXT_BRIDGE_PATH (see docs/hermes-obsidian-context-bridge.md).";

class ObsidianHermesBridge {
  constructor(opts = {}) {
    this.explicitBridgePath = (opts.bridgePath || "").trim();
    this.bridgePath = this.explicitBridgePath;
    this.maxAgeMs = opts.maxAgeMs || DEFAULT_MAX_AGE_MS;
    this.now = opts.now || (() => Date.now());
    this.latestSubmitSequence = 0;
    this.latestUpdateTimestamp = 0;
    this.acceptedPayloadKeys = new Set();
    this.latestContext = null;
    this.lastDiagnosis = {
      reason: "no_turn_yet",
      detail: "",
      bridgePath: null,
      bridgeSource: null,
      checkedPaths: [],
    };
  }

  pre_llm_call(turn) {
    const accepted = this.readAndConsume();
    const injection = accepted ? accepted.injection : "";
    if (injection) injectIntoTurn(turn, injection);
    return injection;
  }

  readAndConsume() {
    const resolution = resolveBridgePathSync(this.explicitBridgePath);
    this.bridgePath = resolution.path || this.explicitBridgePath;
    this.rememberBridgeSource(resolution);
    if (!resolution.path) {
      // Keep the precise reason (`bridge_path_unset`) instead of letting the
      // generic empty-payload branch overwrite it.
      this.latestContext = null;
      this.rememberReason("bridge_path_unset");
      return null;
    }
    return this.consume(readPayloadSync(resolution.path));
  }

  rememberBridgeSource(resolution) {
    this.lastDiagnosis.bridgePath = resolution.path || null;
    this.lastDiagnosis.bridgeSource = resolution.source || null;
    this.lastDiagnosis.checkedPaths = (resolution.checked || []).slice(0, MAX_CHECKED_PATHS_REPORTED);
  }

  rememberReason(reason, detail = "") {
    this.lastDiagnosis.reason = reason;
    this.lastDiagnosis.detail = detail;
  }

  consume(payload) {
    if (!payload) {
      this.latestContext = null;
      this.rememberReason("no_payload");
      return null;
    }

    if (!isValidPayload(payload)) {
      this.rememberReason("payload_invalid");
      return null;
    }

    const updated = payload.updateTimestamp || Date.parse(payload.updatedAt);
    if (!this.isTimestampFresh(updated)) {
      this.rememberReason("payload_stale");
      return null;
    }
    if (updated < this.latestUpdateTimestamp) {
      this.rememberReason("payload_older_than_accepted");
      return null;
    }

    const payloadKey = getPayloadFreshnessKey(payload, updated);
    if (this.acceptedPayloadKeys.has(payloadKey)) {
      this.rememberReason("payload_already_consumed");
      return null;
    }

    this.latestSubmitSequence = payload.submitSequence;
    this.latestUpdateTimestamp = updated;
    this.acceptedPayloadKeys.add(payloadKey);
    if (this.acceptedPayloadKeys.size > 128) {
      const oldest = this.acceptedPayloadKeys.values().next().value;
      if (oldest) this.acceptedPayloadKeys.delete(oldest);
    }

    const attachEnabled = Boolean(payload.attach.enabled);
    this.latestContext = attachEnabled ? payload.context : null;
    if (!attachEnabled) this.rememberReason("attach_disabled");
    else if (!this.latestContext) this.rememberReason("no_context_in_payload");
    else this.rememberReason("ok");

    return {
      payload,
      context: this.latestContext,
      injection: formatObsidianContextForHermesTurn(payload),
    };
  }

  obsidian_context() {
    if (this.latestContext && !this.isTimestampFresh(this.latestUpdateTimestamp)) {
      this.latestContext = null;
      this.rememberReason("stale");
    }
    if (!this.latestContext) {
      return {
        context: null,
        reason: this.lastDiagnosis.reason,
        detail: this.lastDiagnosis.detail,
        bridge_path: this.lastDiagnosis.bridgePath,
        bridge_source: this.lastDiagnosis.bridgeSource,
        checked_paths: this.lastDiagnosis.checkedPaths.slice(),
        hint: NO_CONTEXT_HINT,
      };
    }
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

function bridgePointerPathSync(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const xdg = (env.XDG_CONFIG_HOME || "").trim();
  const configHome = xdg ? xdg : path.join(home, ".config");
  return path.join(configHome, BRIDGE_POINTER_DIR_NAME, BRIDGE_POINTER_FILE_NAME);
}

function pointerBridgePathSync(pointerPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (!raw || raw.schemaVersion !== BRIDGE_POINTER_SCHEMA_VERSION) return null;
    const entries = (raw.entries || []).filter(
      (entry) => entry && typeof entry.bridgePath === "string" && entry.bridgePath,
    );
    if (entries.length === 0) return null;
    let newest = entries[0];
    for (const entry of entries) {
      if ((entry.updateTimestamp || 0) > (newest.updateTimestamp || 0)) newest = entry;
    }
    return newest.bridgePath;
  } catch {
    return null;
  }
}

function cwdBridgeCandidatesSync(cwd) {
  let here;
  try {
    here = path.resolve(cwd || process.cwd());
  } catch {
    return [];
  }

  const ancestors = [];
  let current = here;
  for (let depth = 0; depth < 8; depth++) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates = [];
  for (const base of ancestors) {
    for (const configDir of VAULT_CONFIG_DIR_NAMES) {
      candidates.push(path.join(base, configDir, "hermes", "context.json"));
    }
  }

  let scanned = 0;
  for (const base of ancestors.slice(0, 3)) {
    let children = [];
    try {
      children = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (scanned >= MAX_DIRS_SCANNED) break;
      scanned += 1;
      if (!child.isDirectory() || !child.name.endsWith(".vault")) continue;
      for (const configDir of VAULT_CONFIG_DIR_NAMES) {
        candidates.push(path.join(base, child.name, configDir, "hermes", "context.json"));
      }
    }
  }
  return candidates;
}

/**
 * Locate the bridge file: `{path, source, checked}`.
 *
 * Order: an explicitly configured path, `OBSIDIAN_CONTEXT_BRIDGE_PATH`, the
 * pointer file, a cwd-derived scan, then the historical `~/wiki` fallback.
 */
function resolveBridgePathSync(explicitPath, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const checked = [];

  const fromOption = (explicitPath || "").trim();
  if (fromOption) {
    checked.push(fromOption);
    return { path: fromOption, source: "option", checked };
  }

  const fromEnv = (env.OBSIDIAN_CONTEXT_BRIDGE_PATH || "").trim();
  if (fromEnv) {
    checked.push(fromEnv);
    return { path: fromEnv, source: "env", checked };
  }

  const pointer = bridgePointerPathSync({ env, home });
  checked.push(pointer);
  const fromPointer = pointerBridgePathSync(pointer);
  if (fromPointer) return { path: fromPointer, source: "pointer", checked };

  const existing = [];
  for (const candidate of cwdBridgeCandidatesSync(opts.cwd)) {
    checked.push(candidate);
    try {
      if (fs.existsSync(candidate)) existing.push(candidate);
    } catch {
      // unreadable candidate: skip
    }
  }
  if (existing.length > 0) {
    let newest = existing[0];
    let newestMtime = mtimeOf(newest);
    for (const candidate of existing.slice(1)) {
      const candidateMtime = mtimeOf(candidate);
      if (candidateMtime > newestMtime) {
        newest = candidate;
        newestMtime = candidateMtime;
      }
    }
    return { path: newest, source: "cwd", checked };
  }

  const legacy = path.join(home, "wiki", ".obsidian", "hermes", "context.json");
  checked.push(legacy);
  try {
    if (fs.existsSync(legacy)) return { path: legacy, source: "legacy", checked };
  } catch {
    // ignore
  }

  return { path: null, source: null, checked };
}

function mtimeOf(candidate) {
  try {
    return fs.statSync(candidate).mtimeMs;
  } catch {
    return 0;
  }
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

function safeJsonForSystemInjection(value) {
  return JSON.stringify(value).replace(/[<>]/g, (char) => (char === "<" ? "\\u003c" : "\\u003e"));
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
  bridgePointerPathSync,
  pointerBridgePathSync,
  resolveBridgePathSync,
};
