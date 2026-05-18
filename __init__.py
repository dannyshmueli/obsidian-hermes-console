"""Hermes plugin: consume Obsidian context bridge files written by Hermes Console.

The Obsidian plugin writes JSON to:
  <vault>/.obsidian/hermes/context.json
and launches terminal shells with OBSIDIAN_CONTEXT_BRIDGE_PATH pointing there.

Hermes invokes pre_llm_call once per user turn. This plugin reads the bridge
file just-in-time and returns ephemeral context for the current user message.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .hermes.obsidian_status_bridge import (
    _on_session_end as _status_on_session_end,
    _post_llm_call as _status_post_llm_call,
    _pre_llm_call as _status_pre_llm_call,
)

SCHEMA_VERSION = 1
DEFAULT_MAX_AGE_MS = 2 * 60 * 1000
INLINE_SELECTION_LIMIT = 4_000
LARGE_SELECTION_PREVIEW_LIMIT = 500

_latest_update_timestamp = 0
_accepted_payload_keys: set[str] = set()
_latest_context: Optional[Dict[str, Any]] = None


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
        return None
    if not _latest_context:
        return None
    if _latest_context.get("type") == "selection":
        return {**_latest_context, "text": _latest_context.get("selectedText", "")}
    return _latest_context


def _read_and_consume():
    return _consume(_read_payload())


def _read_payload():
    bridge_path = os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH", "").strip()
    if not bridge_path:
        default_path = Path.home() / "wiki" / ".obsidian" / "hermes" / "context.json"
        bridge_path = str(default_path) if default_path.exists() else ""
    if not bridge_path:
        return None
    try:
        return json.loads(Path(bridge_path).read_text(encoding="utf-8"))
    except Exception:
        return None


def _consume(payload):
    global _latest_update_timestamp, _latest_context

    if not payload:
        _latest_context = None
        return None
    if not _is_valid_payload(payload):
        return None

    updated = payload.get("updateTimestamp") or _parse_iso_ms(payload.get("updatedAt"))
    if not _is_timestamp_fresh(updated):
        return None
    if updated < _latest_update_timestamp:
        return None

    payload_key = _payload_freshness_key(payload, updated)
    if payload_key in _accepted_payload_keys:
        return None

    _latest_update_timestamp = updated
    _accepted_payload_keys.add(payload_key)
    if len(_accepted_payload_keys) > 128:
        _accepted_payload_keys.pop()

    _latest_context = payload.get("context") if payload.get("attach", {}).get("enabled") else None
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
