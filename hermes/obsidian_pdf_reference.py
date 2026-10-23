"""``@pdf:`` context reference — pull PDF pages out of the Obsidian vault on demand.

Why this exists
---------------
The Obsidian side of this repo can only send a *selection*: a few hundred
characters, captured on ``selectionchange``, injected into the current user
message. That injection is ephemeral and capped (Hermes spills a
``pre_llm_call`` payload past ``hooks.output_spill.max_chars``, default 10 kB),
so "put the whole PDF in the prompt" is not a thing that can work.

A context reference is the mechanism Hermes provides for the other half of that
problem: the prompt carries a *pointer* (``@pdf:paper.pdf:84-86``) and the text
is expanded on demand, inside Hermes' own request pipeline, where the budget is
accounted (``injected_tokens``) instead of being smuggled in every turn.

Measured contract (Hermes 0.22.4, see ``agent/context_references.py``)
---------------------------------------------------------------------
* Plugin prefixes are matched by ``_PLUGIN_REFERENCE_PATTERN`` and the value is
  passed to :meth:`expand` **verbatim** - unlike ``@file:path:1-2``, the
  ``:84-86`` suffix is *not* split off for plugins, so this module parses it.
* The host does **not** truncate what a provider returns; it only adds a
  ``📌 @pdf:… (N tokens)`` header. The size cap below is therefore ours to keep.
* At most 16 references are expanded per message.
* Built-in prefixes (``diff``/``file``/``folder``/``git``/``staged``/``url``)
  are reserved; ``pdf`` is free.

Text comes from ``pdftotext`` (poppler), which keeps line structure - measured
against this vault's thesis PDF, page 84:

    5 焊缝打磨实验验证与结果分析
    5.3.1 基于位置的阻抗控制恒力打磨实验
    实验打磨工件选用如图 5.7 所示的形貌明显、凸起较高的焊接构件…

which is cleaner than the pdf.js selection path, whose spans run together
("辽宁工业大学硕士学位论文76" + "5.3.1" → "论文765.3.1"). The two paths are
complementary: the selection is the precise target, ``@pdf:`` is the wide,
readable body.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

PREFIX = "pdf"
DESCRIPTION = "@pdf:<file.pdf>[:page|from-to] — PDF pages from the vault"

# One reference should never be able to eat the window; the host will not cap us.
DEFAULT_MAX_PAGES = int(os.environ.get("OBSIDIAN_PDF_REF_MAX_PAGES", "10"))
DEFAULT_MAX_CHARS = int(os.environ.get("OBSIDIAN_PDF_REF_MAX_CHARS", "12000"))
# pdftotext on a local file is fast; a hang here would stall the whole turn.
SUBPROCESS_TIMEOUT_S = 20.0

_PAGE_SUFFIX = re.compile(r"^(?P<path>.+?):(?P<first>\d+)(?:-(?P<last>\d+))?$")
_LIST_CACHE_TTL_S = 30.0
_list_cache: tuple[float, Path, list[str]] | None = None


# --------------------------------------------------------------------------- vault


def bridge_path() -> Path | None:
    """Bridge file Hermes Console writes, from the env var it exports.

    Usage:
        bridge_path()  # => Path('/…/vault/.obsidian/hermes/context.json')

    Demo:
        With OBSIDIAN_CONTEXT_BRIDGE_PATH unset (a plain shell) this returns None.
    """
    raw = os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH", "").strip()
    return Path(raw) if raw else None


def read_bridge_payload() -> dict | None:
    """Parsed bridge payload, or None when absent/unreadable.

    The payload carries ``vaultPath`` (authoritative, written by the Obsidian
    plugin) and the latest ``context`` - which is what makes ``@pdf:current``
    possible without the user typing a filename.

    Usage:
        read_bridge_payload()["vaultPath"]  # => '/home/…/Hybrid产业研究笔记.vault'

    Demo:
        The live file today contains schemaVersion 1, source
        'lean-obsidian-terminal' and context.type 'cursor'.
    """
    path = bridge_path()
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def find_vault_root() -> Path | None:
    """Absolute vault root, or None when nothing tells us where the vault is.

    Order: explicit ``OBSIDIAN_PDF_VAULT_ROOT`` override → the bridge payload's
    ``vaultPath`` → the bridge file's own location (``…/<configDir>/hermes/
    context.json`` → up three levels).

    Usage:
        find_vault_root()  # => PosixPath('/home/poincare/…/Hybrid产业研究笔记.vault')

    Demo:
        Resolved live from OBSIDIAN_CONTEXT_BRIDGE_PATH; verified to be the
        same directory the Obsidian plugin reports as its vaultPath.
    """
    override = os.environ.get("OBSIDIAN_PDF_VAULT_ROOT", "").strip()
    if override:
        candidate = Path(override).expanduser()
        if candidate.is_dir():
            return candidate
    payload = read_bridge_payload()
    if payload and isinstance(payload.get("vaultPath"), str) and payload["vaultPath"]:
        candidate = Path(payload["vaultPath"])
        if candidate.is_dir():
            return candidate
    bridge = bridge_path()
    if bridge is not None:
        candidate = bridge.parent.parent.parent
        if candidate.is_dir():
            return candidate
    return None


def resolve_in_vault(target: str, vault: Path) -> Path | None:
    """Resolve ``target`` under ``vault``, refusing anything that escapes it.

    Args:
        target: vault-relative path as typed after ``@pdf:`` (may be quoted by
            the user; the host already strips the quotes before we see it).
        vault: absolute vault root.

    Usage:
        resolve_in_vault("96-…/朱坤.pdf", vault)  # => PosixPath('/…/朱坤.pdf')

    Demo:
        resolve_in_vault("../../etc/passwd", vault) is None - containment is
        checked after resolution, so ``..`` (or an absolute path) cannot reach
        outside the vault.
    """
    cleaned = target.strip().strip("\"'`")
    if not cleaned:
        return None
    candidate = Path(cleaned)
    if not candidate.is_absolute():
        candidate = vault / candidate
    try:
        resolved = candidate.resolve()
    except Exception:
        return None
    try:
        # commonpath, not startswith: /vault-evil must not pass as /vault.
        if os.path.commonpath([str(resolved), str(vault.resolve())]) != str(vault.resolve()):
            return None
    except ValueError:  # different drives / mixed absolute-relative
        return None
    return resolved if resolved.is_file() else None


def list_vault_pdfs(vault: Path, *, limit: int = 200) -> list[str]:
    """Vault-relative PDF paths, cheapest-first, cached for a few seconds.

    Args:
        vault: absolute vault root.
        limit: stop after this many PDFs (a completion menu never needs more).

    Usage:
        list_vault_pdfs(vault)[:3]

    Demo:
        Measured on this vault: 5 PDFs (theses + a payslip), returned as
        '96-机器人业界robot_career/…/朱坤.pdf' style relative paths.
    """
    global _list_cache
    now = time.monotonic()
    if _list_cache is not None:
        stamped, cached_vault, cached = _list_cache
        if cached_vault == vault and now - stamped < _LIST_CACHE_TTL_S:
            return cached
    found: list[str] = []
    skip = {".obsidian", ".trash", ".git", "node_modules"}
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in skip]
        for name in files:
            if name.lower().endswith(".pdf"):
                try:
                    found.append(str((Path(root) / name).relative_to(vault)))
                except ValueError:
                    continue
                if len(found) >= limit:
                    _list_cache = (now, vault, sorted(found))
                    return _list_cache[2]
    found.sort()
    _list_cache = (now, vault, found)
    return found


# ------------------------------------------------------------------------ reading


def page_count(pdf: Path) -> int | None:
    """Total pages via ``pdfinfo``, or None when it cannot be read.

    Usage:
        page_count(pdf)  # => 90

    Demo:
        Measured on '…/基于力位混合控制的焊缝打磨机械臂运动控制研究_朱坤.pdf'
        → 90. Both the autocomplete meta column and page-range validation use
        it, so a wrong value would silently clip a request.
    """
    exe = shutil.which("pdfinfo")
    if exe is None:
        return None
    try:
        out = subprocess.run(
            [exe, str(pdf)], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S
        ).stdout
    except Exception:
        return None
    match = re.search(r"^Pages:\s+(\d+)\s*$", out, re.MULTILINE)
    return int(match.group(1)) if match else None


def extract_pages(pdf: Path, first: int | None, last: int | None) -> str:
    """Page text via ``pdftotext``; empty string on any failure.

    Args:
        pdf: file to read.
        first: 1-based first page, or None for the whole document.
        last: 1-based last page (inclusive), or None for ``first`` only.

    Usage:
        extract_pages(pdf, 84, 84)   # one page
        extract_pages(pdf, 80, 90)   # a range

    Demo:
        extract_pages(pdf_zhukun, 84, 84) starts with
        '5 焊缝打磨实验验证与结果分析' and preserves the paragraph breaks -
        this is the measured output the module docstring quotes.
    """
    exe = shutil.which("pdftotext")
    if exe is None:
        return ""
    cmd = [exe]
    if first is not None:
        cmd += ["-f", str(first)]
        cmd += ["-l", str(last if last is not None else first)]
    cmd += [str(pdf), "-"]  # trailing '-' = write to stdout
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S
        )
    except Exception:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout or ""


def cap_text(text: str, limit: int) -> tuple[str, bool]:
    """Trim to ``limit`` characters, cutting on a line boundary when possible.

    Returns:
        ``(text, truncated)`` - the caller must say so in the output, because a
        silently short answer looks like "the PDF says nothing here".

    Usage:
        cap_text("a\\nb\\nc", 3)  # => ('a\\n', True)

    Demo:
        cap_text("x" * 10, 5) == ("xxxxx", True).
    """
    if limit <= 0 or len(text) <= limit:
        return text, False
    head = text[:limit]
    newline = head.rfind("\n")
    if newline > limit * 0.5:  # keep whole lines when that costs little
        head = head[: newline + 1]
    return head, True


# --------------------------------------------------------------------- target spec


def parse_target(target: str, vault: Path) -> tuple[Path, int | None, int | None] | str:
    """Turn ``@pdf:``'s target into ``(pdf, first_page, last_page)`` or an error string.

    Grammar (all optional page parts are 1-based, inclusive):
        current              the PDF the bridge payload last saw
        current:85-90        that PDF, page range
        paper.pdf            whole document (capped)
        paper.pdf:84         one page
        paper.pdf:84-86      a range

    Args:
        target: raw text after ``@pdf:`` as the host passed it (still carrying
            any ``:84-86`` suffix - plugin references are not split for us).
        vault: absolute vault root.

    Usage:
        parse_target("paper.pdf:84-86", vault)  # => (PosixPath('…/paper.pdf'), 84, 86)

    Demo:
        The whole-string-first rule matters for odd filenames: if a file really
        is named 'report:12' the path lookup wins over the page suffix.
    """
    raw = target.strip().strip("\"'`")
    if not raw:
        return "empty target"

    # Form 1: the path as typed resolves (handles ':' inside a filename).
    direct = resolve_in_vault(raw, vault)
    if direct is not None:
        return direct, None, None

    # Form 2: 'path.pdf:84' / 'path.pdf:84-86' - suffix parsed here, not by the host.
    match = _PAGE_SUFFIX.match(raw)
    if match:
        inner = match.group("path")
        first = int(match.group("first"))
        last = int(match.group("last")) if match.group("last") else first
        if last < first:
            first, last = last, first
        if inner.strip().lower() == "current":
            resolved = _current_pdf(vault)
            if resolved is None:
                return "no PDF in the bridge payload yet - open one and select text, or name the file"
            return resolved, first, last
        resolved = resolve_in_vault(inner, vault)
        if resolved is None:
            return f"no such PDF in the vault: {inner}"
        return resolved, first, last

    # Form 3: 'current'
    if raw.lower() == "current":
        resolved = _current_pdf(vault)
        if resolved is None:
            return "no PDF in the bridge payload yet - open one and select text, or name the file"
        return resolved, None, None

    return f"no such PDF in the vault: {raw}"


def _current_pdf(vault: Path) -> Path | None:
    """PDF the last bridge payload referred to (from a selection), else None."""
    payload = read_bridge_payload()
    context = (payload or {}).get("context") or {}
    file_info = context.get("file") or {}
    path = file_info.get("path")
    if isinstance(path, str) and path.lower().endswith(".pdf"):
        return resolve_in_vault(path, vault)
    return None


def build_reference_text(
    pdf: Path,
    vault: Path,
    first: int | None,
    last: int | None,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> str:
    """Full expansion text for one ``@pdf:`` reference (never raises).

    Args:
        pdf: resolved file inside the vault.
        vault: vault root, used to render the vault-relative path.
        first: requested first page, or None for the whole document.
        last: requested last page, or None.
        max_pages: refuse to read more than this many pages in one reference.
        max_chars: output ceiling (the host will not truncate for us).

    Usage:
        build_reference_text(pdf, vault, 84, 86)

    Demo:
        For the thesis PDF with (84, 84) the output starts with
        ``# 朱坤.pdf — page 84 of 90`` followed by the page text.
    """
    try:
        rel = pdf.relative_to(vault)
    except ValueError:
        rel = pdf
    total = page_count(pdf)

    first_page = 1 if first is None else max(1, first)
    # Unknown page count (pdfinfo missing): read a window rather than guessing one
    # page, and let pdftotext stop at the end of the document.
    fallback_last = first_page + max_pages - 1 if total is None else total
    last_page = fallback_last if last is None else last
    if total is not None:
        first_page = min(first_page, total)
        last_page = min(last_page, total)
    if last_page < first_page:
        return f"@pdf:{rel}: empty page range ({first_page}-{last_page})"

    requested = last_page - first_page + 1
    note = ""
    if requested > max_pages:
        last_page = first_page + max_pages - 1
        requested = max_pages
        note = (
            f"\n\n[only the first {max_pages} pages of the requested range were read; "
            f"ask for another window to continue]"
        )

    text = extract_pages(pdf, first_page, last_page)
    if not text.strip():
        if total is None:
            return f"@pdf:{rel}: no text layer found (scanned PDF? pdftotext/pdfinfo missing?)"
        return f"@pdf:{rel}: pages {first_page}-{last_page} yielded no text (scanned PDF without a text layer?)"

    text = text.strip("\n")
    text, truncated = cap_text(text, max_chars)
    if truncated:
        note += (
            f"\n\n[truncated at {max_chars} characters - the request was pages "
            f"{first_page}-{last_page}; narrow it for the rest]"
        )

    header = f"# {rel} — pages {first_page}-{last_page}"
    if total is not None:
        header += f" of {total}"
    return f"{header}\n\n{text}{note}"


# ----------------------------------------------------------------------- provider


def _provider_class():
    """Build the provider class against Hermes' real base class, or None.

    Kept lazy so this module imports cleanly for tests (and for the vault's
    manual-install copy) even where ``agent.context_references`` is absent.

    Usage:
        cls = _provider_class()

    Demo:
        Inside Hermes this returns a concrete subclass; in a bare python3 shell
        without ~/.hermes/hermes-agent on sys.path it returns None.
    """
    try:
        from agent.context_references import ContextCompletionItem, ContextReferenceProvider
    except Exception:
        return None

    class ObsidianPdfReferenceProvider(ContextReferenceProvider):
        prefix = PREFIX
        description = DESCRIPTION

        async def autocomplete(self, query: str, *, limit: int = 10):
            vault = find_vault_root()
            if vault is None:
                return []
            items = []
            if "current".startswith(query.strip().lower()) or not query.strip():
                current = _current_pdf(vault)
                if current is not None:
                    items.append(
                        ContextCompletionItem(
                            text="current",
                            display="current (the PDF you are reading)",
                            meta=str(current.name),
                        )
                    )
            needle = query.strip().lower()
            for rel in list_vault_pdfs(vault):
                haystack = rel.lower()
                if needle and needle not in haystack:
                    continue
                pdf = vault / rel
                pages = page_count(pdf)
                items.append(
                    ContextCompletionItem(
                        text=rel,
                        display=rel,
                        meta=f"{pages}p" if pages else "",
                    )
                )
                if len(items) >= limit:
                    break
            return items

        async def expand(self, target: str):
            vault = find_vault_root()
            if vault is None:
                return (
                    "@pdf: cannot tell where the vault is - open Hermes Console in Obsidian once "
                    "(it exports OBSIDIAN_CONTEXT_BRIDGE_PATH), or set OBSIDIAN_PDF_VAULT_ROOT."
                )
            parsed = parse_target(target, vault)
            if isinstance(parsed, str):
                return f"@pdf:{target}: {parsed}"
            pdf, first, last = parsed
            return build_reference_text(pdf, vault, first, last)

    return ObsidianPdfReferenceProvider


def register_pdf_reference(ctx) -> bool:
    """Register ``@pdf:`` on a Hermes plugin context. False when unavailable.

    Registration is purely runtime (no manifest key exists for context
    references), and a second provider with the same prefix is rejected by the
    host - so this is safe to call from both ``__init__.py`` copies.

    Args:
        ctx: the ``PluginContext`` handed to the plugin's ``register(ctx)``.

    Usage:
        register_pdf_reference(ctx)

    Demo:
        Returns True inside Hermes; returns False (without raising) in an
        environment where agent.context_references cannot be imported, which is
        what keeps the rest of the plugin working there.
    """
    provider_class = _provider_class()
    if provider_class is None:
        return False
    try:
        ctx.register_context_reference(provider_class())
    except Exception:
        return False
    return True
