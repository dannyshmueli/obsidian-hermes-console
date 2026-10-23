"""Hermes plugin: consume Obsidian context bridge files written by Hermes Console.

This file intentionally mirrors the root-level Hermes plugin implementation so
`hermes plugins install dannyshmueli/obsidian-hermes-console --enable` works from
the repository root while the Obsidian manual installer can still copy files from
`hermes/` into the vault plugin directory.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .obsidian_status_bridge import (
    _on_session_end as _status_on_session_end,
    _post_llm_call as _status_post_llm_call,
    _pre_llm_call as _status_pre_llm_call,
)

SCHEMA_VERSION = 1
DEFAULT_MAX_AGE_MS = 2 * 60 * 1000
INLINE_SELECTION_LIMIT = 4_000
LARGE_SELECTION_PREVIEW_LIMIT = 500

# Bridge *pointer* file — written by the Obsidian half at a vault-independent
# location (`$XDG_CONFIG_HOME/hermes-console/bridge.json`, see
# src/obsidian-bridge-pointer.ts) so this plugin can find the current vault's
# bridge file even when the turn is served by a process that never inherited the
# PTY environment: a gateway/service, a container, a remote backend, or a
# cron/webhook-started turn.
BRIDGE_POINTER_SCHEMA_VERSION = 1
BRIDGE_POINTER_DIR_NAME = "hermes-console"
BRIDGE_POINTER_FILE_NAME = "bridge.json"
VAULT_CONFIG_DIR_NAMES = (".obsidian", "_obsidian")
MAX_DIRS_SCANNED = 64
MAX_CHECKED_PATHS_REPORTED = 8

NO_CONTEXT_HINT = (
    "No Obsidian context in this turn. Press Enter in Hermes Console with the tab's "
    "'Send context to Hermes' toggle on; if reason is bridge_path_unset, set "
    "OBSIDIAN_CONTEXT_BRIDGE_PATH (see docs/hermes-obsidian-context-bridge.md)."
)

logger = logging.getLogger("hermes.plugins.obsidian_context_bridge")

_latest_update_timestamp = 0
_accepted_payload_keys: set[str] = set()
_latest_context: Optional[Dict[str, Any]] = None

# Why the most recent read produced (or failed to produce) a context. Surfaced by
# `obsidian_context()` so "no context" is diagnosable instead of a bare None, and
# logged once per distinct reason.
_last_diagnosis: Dict[str, Any] = {
    "reason": "no_turn_yet",
    "detail": "",
    "bridge_path": None,
    "bridge_source": None,
    "checked_paths": [],
}


def register(ctx):
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_llm_call", _status_post_llm_call)
    ctx.register_hook("on_session_end", _status_on_session_end)
    ctx.register_hook("on_session_finalize", _status_on_session_end)
    ctx.register_tool(
        name="obsidian_context",
        toolset="plugin_obsidian_context_bridge",
        schema={
            "name": "obsidian_context",
            "description": "Return the latest fresh Obsidian selection or cursor context captured by Hermes Console for Obsidian.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=lambda args, **kw: _obsidian_context(),
        description="Get current Obsidian context from Hermes Console bridge",
        emoji="🪽",
    )


def _pre_llm_call(**kwargs):
    _status_pre_llm_call(**kwargs)
    accepted = _read_and_consume()
    injection = accepted.get("injection") if accepted else ""
    if not injection:
        return None
    return {"context": injection}


def _obsidian_context():
    global _latest_context
    if _latest_context and not _is_timestamp_fresh(_latest_update_timestamp):
        _latest_context = None
        _remember_reason("stale")
    if not _latest_context:
        return {
            "context": None,
            "reason": _last_diagnosis.get("reason", "no_turn_yet"),
            "detail": _last_diagnosis.get("detail", ""),
            "bridge_path": _last_diagnosis.get("bridge_path"),
            "bridge_source": _last_diagnosis.get("bridge_source"),
            "checked_paths": list(_last_diagnosis.get("checked_paths") or []),
            "hint": NO_CONTEXT_HINT,
        }
    if _latest_context.get("type") == "selection":
        return {**_latest_context, "text": _latest_context.get("selectedText", "")}
    return _latest_context


def _read_and_consume():
    global _latest_context
    payload = _read_payload()
    if payload is None:
        # `_read_payload` already recorded the precise reason (unset path,
        # unreadable file, non-object document). Returning early keeps that
        # reason instead of letting the generic "no_payload" overwrite it.
        _latest_context = None
        return None
    return _consume(payload)


def _remember_bridge_source(path, source, checked) -> None:
    """Record where the bridge file was looked for, and where it was found."""
    _last_diagnosis["bridge_path"] = str(path) if path else None
    _last_diagnosis["bridge_source"] = source
    _last_diagnosis["checked_paths"] = [str(candidate) for candidate in (checked or [])][:MAX_CHECKED_PATHS_REPORTED]


def _remember_reason(reason: str, detail: str = "") -> None:
    """Record why a context was accepted or skipped; log when the reason changes."""
    previous = _last_diagnosis.get("reason")
    _last_diagnosis["reason"] = reason
    _last_diagnosis["detail"] = detail
    if reason != "ok" and reason != previous:
        logger.info(
            "obsidian-context-bridge: no context (%s) bridge=%s",
            reason,
            _last_diagnosis.get("bridge_path"),
        )


def _bridge_pointer_path(env=None, home=None) -> Path:
    """Pointer-file location; must mirror the Obsidian half exactly."""
    source_env = os.environ if env is None else env
    home_path = Path(home) if home is not None else Path.home()
    xdg = (source_env.get("XDG_CONFIG_HOME") or "").strip()
    config_home = Path(xdg) if xdg else home_path / ".config"
    return config_home / BRIDGE_POINTER_DIR_NAME / BRIDGE_POINTER_FILE_NAME


def _pointer_bridge_path(pointer_path=None, env=None, home=None):
    """Newest ``bridgePath`` recorded in the pointer file, or None."""
    pointer = Path(pointer_path) if pointer_path is not None else _bridge_pointer_path(env, home)
    try:
        raw = json.loads(pointer.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict) or raw.get("schemaVersion") != BRIDGE_POINTER_SCHEMA_VERSION:
        return None
    entries = [
        entry
        for entry in (raw.get("entries") or [])
        if isinstance(entry, dict) and isinstance(entry.get("bridgePath"), str) and entry["bridgePath"]
    ]
    if not entries:
        return None
    newest = max(entries, key=lambda entry: entry.get("updateTimestamp") or 0)
    return newest["bridgePath"]


def _cwd_bridge_candidates(cwd=None) -> List[Path]:
    """Bridge files discoverable from the working directory.

    The Obsidian half starts Hermes with the vault as its cwd, so walking up from
    the cwd finds the active vault; sibling ``*.vault`` directories cover the
    "several vaults under one parent folder" layout. One level deep and capped:
    this runs on the prompt path and has to stay cheap.
    """
    try:
        here = Path(cwd or os.getcwd()).resolve()
    except Exception:
        return []

    candidates: List[Path] = []
    for base in (here, *here.parents):
        for config_dir in VAULT_CONFIG_DIR_NAMES:
            candidates.append(base / config_dir / "hermes" / "context.json")

    scanned = 0
    for base in (here, *here.parents[:2]):
        try:
            children = sorted(child for child in base.iterdir() if child.is_dir())
        except Exception:
            continue
        for child in children:
            if scanned >= MAX_DIRS_SCANNED:
                break
            scanned += 1
            if not child.name.endswith(".vault"):
                continue
            for config_dir in VAULT_CONFIG_DIR_NAMES:
                candidates.append(child / config_dir / "hermes" / "context.json")
    return candidates


def _legacy_bridge_path() -> Path:
    return Path.home() / "wiki" / ".obsidian" / "hermes" / "context.json"


def _resolve_bridge_path() -> Tuple[Optional[Path], Optional[str], List[Path]]:
    """Locate the bridge file: ``(path, source, checked_paths)``.

    Order: the PTY environment variable, the vault-independent pointer file, a
    cwd-derived scan, then the historical ``~/wiki`` fallback.
    """
    checked: List[Path] = []

    from_env = (os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH") or "").strip()
    if from_env:
        checked.append(Path(from_env))
        return Path(from_env), "env", checked

    pointer = _bridge_pointer_path()
    checked.append(pointer)
    from_pointer = _pointer_bridge_path(pointer)
    if from_pointer:
        return Path(from_pointer), "pointer", checked

    existing: List[Path] = []
    for candidate in _cwd_bridge_candidates():
        checked.append(candidate)
        try:
            if candidate.exists():
                existing.append(candidate)
        except OSError:
            continue
    if existing:
        try:
            newest = max(existing, key=lambda candidate: candidate.stat().st_mtime)
        except OSError:
            newest = existing[0]
        return newest, "cwd", checked

    legacy = _legacy_bridge_path()
    checked.append(legacy)
    if legacy.exists():
        return legacy, "legacy", checked

    return None, None, checked


def _read_payload():
    bridge_path, source, checked = _resolve_bridge_path()
    _remember_bridge_source(bridge_path, source, checked)
    if bridge_path is None:
        _remember_reason("bridge_path_unset")
        return None
    try:
        payload = json.loads(Path(bridge_path).read_text(encoding="utf-8"))
    except Exception as exc:
        _remember_reason("bridge_unreadable", str(exc))
        return None
    if not isinstance(payload, dict):
        _remember_reason("bridge_not_an_object")
        return None
    return payload


def _consume(payload):
    global _latest_update_timestamp, _latest_context

    if not payload:
        _latest_context = None
        _remember_reason("no_payload")
        return None
    if not _is_valid_payload(payload):
        _remember_reason("payload_invalid")
        return None

    updated = payload.get("updateTimestamp") or _parse_iso_ms(payload.get("updatedAt"))
    if not _is_timestamp_fresh(updated):
        _remember_reason("payload_stale")
        return None
    if updated < _latest_update_timestamp:
        _remember_reason("payload_older_than_accepted")
        return None

    payload_key = _payload_freshness_key(payload, updated)
    if payload_key in _accepted_payload_keys:
        _remember_reason("payload_already_consumed")
        return None

    _latest_update_timestamp = updated
    _accepted_payload_keys.add(payload_key)
    if len(_accepted_payload_keys) > 128:
        _accepted_payload_keys.pop()

    attach_enabled = bool(payload.get("attach", {}).get("enabled"))
    _latest_context = payload.get("context") if attach_enabled else None
    if not attach_enabled:
        _remember_reason("attach_disabled")
    elif _latest_context is None:
        _remember_reason("no_context_in_payload")
    else:
        _remember_reason("ok")

    return {
        "payload": payload,
        "context": _latest_context,
        "injection": _format_context(payload),
    }


def _is_valid_payload(payload):
    return bool(
        isinstance(payload, dict)
        and payload.get("schemaVersion") == SCHEMA_VERSION
        and payload.get("source") == "lean-obsidian-terminal"
        and isinstance(payload.get("updatedAt"), str)
        and isinstance(payload.get("submitSequence"), int)
        and isinstance(payload.get("attach"), dict)
        and isinstance(payload["attach"].get("enabled"), bool)
    )


def _is_timestamp_fresh(updated):
    return isinstance(updated, (int, float)) and (time.time() * 1000 - updated) <= DEFAULT_MAX_AGE_MS


def _parse_iso_ms(value):
    if not value:
        return float("nan")
    try:
        from datetime import datetime
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return float("nan")


def _format_context(payload):
    if not payload.get("attach", {}).get("enabled") or not payload.get("context"):
        return ""
    context = payload["context"]
    if context.get("type") == "selection":
        common = [
            '<obsidian_context type="selection">',
            "instruction: Treat this Obsidian selection as the primary object of the user's request. If the user says this/selection/selected text, operate on this block directly; do not search the repo or inspect bridge files unless required.",
            f"file: {context['file']['path']}",
            f"absolute_path: {context['file']['absolutePath']}",
            f"range: {_format_range(context['range'])}",
            f"line_count: {context['lineCount']}",
            f"char_count: {context['charCount']}",
            f"hash: {context['hash']}",
        ]
        selected = context.get("selectedText", "")
        if len(selected) <= INLINE_SELECTION_LIMIT:
            return "\n".join([*common, f"selected_text_json: {_safe_json_for_system_injection(selected)}", "</obsidian_context>"])
        return "\n".join([
            *common,
            f"selected_text_preview: {_clip_text(selected, LARGE_SELECTION_PREVIEW_LIMIT)}",
            "Full selected text is available for this current turn by calling obsidian_context().",
            "</obsidian_context>",
        ])

    lines = [*context.get("beforeLines", []), {"line": context["cursor"]["line"], "text": context.get("currentLine", "")}, *context.get("afterLines", [])]
    return "\n".join([
        '<obsidian_context type="cursor">',
        "instruction: Treat this Obsidian cursor context as the user's active note location. If the user says this/current line/nearby text, use this context directly before searching files.",
        f"file: {context['file']['path']}",
        f"absolute_path: {context['file']['absolutePath']}",
        f"cursor: {context['cursor']['line'] + 1}:{context['cursor']['column']}",
        f"current_line: {context.get('currentLine', '')}",
        "surrounding_lines:",
        *[f"{line['line'] + 1}: {line.get('text', '')}" for line in lines],
        "</obsidian_context>",
    ])


def _payload_freshness_key(payload, updated):
    context = payload.get("context") or {}
    context_key = "none"
    if context.get("type") == "selection":
        context_key = f"selection:{context['file']['path']}:{context.get('hash')}:{context.get('charCount')}"
    elif context.get("type") == "cursor":
        cursor = context.get("cursor", {})
        context_key = f"cursor:{context['file']['path']}:{cursor.get('line')}:{cursor.get('column')}:{context.get('charCount')}"
    return "|".join([
        str(updated),
        str(payload.get("submitSequence")),
        str(payload.get("terminal", {}).get("id", "")),
        "on" if payload.get("attach", {}).get("enabled") else "off",
        context_key,
    ])


def _format_range(range_):
    return f"{range_['from']['line'] + 1}:{range_['from']['column']}-{range_['to']['line'] + 1}:{range_['to']['column']}"


def _safe_json_for_system_injection(value):
    return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e")


def _clip_text(text, limit):
    return text if len(text) <= limit else text[:limit]
