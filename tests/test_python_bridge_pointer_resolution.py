"""Resolution-order tests for the Hermes-side Obsidian context bridge.

Covers the vault-independent **pointer file** and the diagnostics that replaced
the silent no-op:

  env var -> pointer file -> cwd scan -> legacy ``~/wiki`` path

plus the structured "no context + reason" result of ``obsidian_context()``.

Run:
    python3 tests/test_python_bridge_pointer_resolution.py -v
"""

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT.parent) not in sys.path:
    sys.path.insert(0, str(ROOT.parent))


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)])
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_bridge(
    vault: Path,
    selected_text: str,
    *,
    age_ms: int = 0,
    attach: bool = True,
    config_dir: str = ".obsidian",
) -> Path:
    now_ms = int(time.time() * 1000) - age_ms
    path = vault / config_dir / "hermes" / "context.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "source": "lean-obsidian-terminal",
                "vaultPath": str(vault),
                "bridgePath": str(path),
                "updatedAt": "2026-10-23T09:40:00.000Z",
                "updateTimestamp": now_ms,
                "submitSequence": 1,
                "attach": {"enabled": attach},
                "terminal": {"id": "terminal-2", "title": "Hermes 1"},
                "context": {
                    "type": "selection",
                    "source": "active",
                    "file": {"path": "note.md", "absolutePath": str(vault / "note.md")},
                    "range": {"from": {"line": 0, "column": 0}, "to": {"line": 0, "column": 5}},
                    "lineCount": 1,
                    "charCount": len(selected_text),
                    "hash": "hash",
                    "selectedText": selected_text,
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def write_pointer(pointer_path: Path, entries) -> Path:
    pointer_path.parent.mkdir(parents=True, exist_ok=True)
    pointer_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "source": "hermes-console",
                "updatedAt": "2026-10-23T09:40:00.000Z",
                "entries": entries,
            }
        ),
        encoding="utf-8",
    )
    return pointer_path


def pointer_entry(vault: Path, *, updated_at: int, config_dir: str = ".obsidian"):
    return {
        "vaultPath": str(vault),
        "configDir": config_dir,
        "tabId": "terminal-2",
        "tabTitle": "Hermes 1",
        "bridgePath": str(vault / config_dir / "hermes" / "context.json"),
        "updatedAt": "2026-10-23T09:40:00.000Z",
        "updateTimestamp": updated_at,
        "submitSequence": 1,
    }


class BridgePointerResolutionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.home = self.root / "home"
        self.home.mkdir(parents=True, exist_ok=True)
        self.pointer = self.home / ".config" / "hermes-console" / "bridge.json"

        self.mod = load_module(ROOT / "hermes" / "__init__.py", f"bridge_resolution_{id(self)}")

        self._env = dict(os.environ)
        self._cwd = os.getcwd()
        os.environ.pop("OBSIDIAN_CONTEXT_BRIDGE_PATH", None)
        os.environ.pop("XDG_CONFIG_HOME", None)
        os.environ["HOME"] = str(self.home)
        os.chdir(self.root)

    def tearDown(self):
        os.chdir(self._cwd)
        os.environ.clear()
        os.environ.update(self._env)
        self._tmp.cleanup()

    # ---------------------------------------------------------------- path rules
    def test_pointer_path_matches_the_obsidian_half(self):
        self.assertEqual(
            self.mod._bridge_pointer_path(env={}, home=str(self.home)),
            self.home / ".config" / "hermes-console" / "bridge.json",
        )
        self.assertEqual(
            self.mod._bridge_pointer_path(env={"XDG_CONFIG_HOME": "/xdg"}, home=str(self.home)),
            Path("/xdg") / "hermes-console" / "bridge.json",
        )

    def test_env_var_wins(self):
        bridge = self.root / "V.vault" / ".obsidian" / "hermes" / "context.json"
        os.environ["OBSIDIAN_CONTEXT_BRIDGE_PATH"] = str(bridge)
        resolved, source, _ = self.mod._resolve_bridge_path()
        self.assertEqual(source, "env")
        self.assertEqual(resolved, bridge)

    def test_pointer_file_is_used_when_the_env_var_is_missing(self):
        vault = self.root / "V.vault"
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=1_000)])
        resolved, source, _ = self.mod._resolve_bridge_path()
        self.assertEqual(source, "pointer")
        self.assertEqual(resolved, vault / ".obsidian" / "hermes" / "context.json")

    def test_pointer_file_newest_entry_wins(self):
        older, newer = self.root / "Old.vault", self.root / "New.vault"
        write_pointer(
            self.pointer,
            [pointer_entry(older, updated_at=1_000), pointer_entry(newer, updated_at=2_000)],
        )
        resolved, source, _ = self.mod._resolve_bridge_path()
        self.assertEqual(source, "pointer")
        self.assertEqual(resolved, newer / ".obsidian" / "hermes" / "context.json")

    def test_corrupt_pointer_file_degrades_quietly(self):
        self.pointer.parent.mkdir(parents=True, exist_ok=True)
        self.pointer.write_text("{ half", encoding="utf-8")
        self.assertIsNone(self.mod._pointer_bridge_path(self.pointer))

    def test_cwd_scan_finds_the_vault(self):
        vault = self.root / "V.vault"
        write_bridge(vault, "from cwd")
        os.chdir(vault)
        resolved, source, _ = self.mod._resolve_bridge_path()
        self.assertEqual(source, "cwd")
        self.assertEqual(resolved, vault / ".obsidian" / "hermes" / "context.json")

    def test_cwd_scan_finds_a_sibling_vault(self):
        # The "several vaults under one parent folder" layout, per-vault config dir.
        sibling = self.root / "Sibling.vault"
        write_bridge(sibling, "from sibling", config_dir="_obsidian")
        os.chdir(self.root / "home")
        resolved, source, _ = self.mod._resolve_bridge_path()
        self.assertEqual(source, "cwd")
        self.assertEqual(resolved, sibling / "_obsidian" / "hermes" / "context.json")

    def test_legacy_wiki_path_is_the_last_resort(self):
        legacy = self.home / "wiki" / ".obsidian" / "hermes" / "context.json"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("{}", encoding="utf-8")
        resolved, source, _ = self.mod._resolve_bridge_path()
        self.assertEqual(source, "legacy")
        self.assertEqual(resolved, legacy)

    # ------------------------------------------------------------- diagnostics
    def test_unset_bridge_path_is_reported_with_a_hint(self):
        # Exercise the real path (pre_llm_call -> _read_and_consume), not just the
        # reader: the precise reason must survive the empty-payload branch.
        self.assertIsNone(self.mod._read_and_consume())
        self.assertEqual(self.mod._last_diagnosis["reason"], "bridge_path_unset")

        result = self.mod._obsidian_context()
        self.assertIsNone(result["context"])
        self.assertEqual(result["reason"], "bridge_path_unset")
        self.assertEqual(result["bridge_source"], None)
        self.assertTrue(result["hint"])
        self.assertTrue(result["checked_paths"])

    def test_stale_payload_is_reported(self):
        vault = self.root / "V.vault"
        write_bridge(vault, "old selection", age_ms=10 * 60 * 1000)
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=int(time.time() * 1000))])
        self.assertIsNone(self.mod._read_and_consume())
        self.assertEqual(self.mod._obsidian_context()["reason"], "payload_stale")

    def test_attach_disabled_is_reported(self):
        vault = self.root / "V.vault"
        write_bridge(vault, "ignored", attach=False)
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=int(time.time() * 1000))])
        self.assertIsNotNone(self.mod._read_and_consume())
        result = self.mod._obsidian_context()
        self.assertIsNone(result["context"])
        self.assertEqual(result["reason"], "attach_disabled")

    def test_repeated_turn_reports_already_consumed(self):
        vault = self.root / "V.vault"
        write_bridge(vault, "hello")
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=int(time.time() * 1000))])
        self.assertIsNotNone(self.mod._read_and_consume())
        # The same payload is never injected twice...
        self.assertIsNone(self.mod._read_and_consume())
        self.assertEqual(self.mod._last_diagnosis["reason"], "payload_already_consumed")
        # ...but an accepted selection stays readable through the tool for the
        # freshness window, which is why the reason lives in the diagnosis only.
        self.assertEqual(self.mod._obsidian_context()["text"], "hello")

    def test_tool_handler_returns_a_json_string(self):
        # Hermes plugin tools must return strings (tools/registry.py); the
        # wrapper is what the host calls, so it has to serialize every shape.
        self.assertIsNone(self.mod._read_and_consume())
        parsed = json.loads(self.mod._obsidian_context_json())
        self.assertIsNone(parsed["context"])
        self.assertEqual(parsed["reason"], "bridge_path_unset")

        vault = self.root / "V.vault"
        write_bridge(vault, "json string path")
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=int(time.time() * 1000))])
        self.mod._read_and_consume()
        serialized = self.mod._obsidian_context_json()
        self.assertIsInstance(serialized, str)
        self.assertEqual(json.loads(serialized)["text"], "json string path")

    # ----------------------------------------------------------- end to end
    def test_selection_reaches_obsidian_context_through_the_pointer_file(self):
        vault = self.root / "V.vault"
        write_bridge(vault, "pointer-delivered selection")
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=int(time.time() * 1000))])

        accepted = self.mod._read_and_consume()
        self.assertIsNotNone(accepted)
        self.assertIn("pointer-delivered selection", accepted["injection"])

        context = self.mod._obsidian_context()
        self.assertEqual(context["text"], "pointer-delivered selection")
        self.assertEqual(self.mod._last_diagnosis["bridge_source"], "pointer")

    def test_root_mirror_behaves_the_same(self):
        root_mod = load_module(ROOT / "__init__.py", f"bridge_resolution_root_{id(self)}")
        vault = self.root / "V.vault"
        write_bridge(vault, "root mirror selection")
        write_pointer(self.pointer, [pointer_entry(vault, updated_at=int(time.time() * 1000))])
        self.assertIsNotNone(root_mod._read_and_consume())
        self.assertEqual(root_mod._obsidian_context()["text"], "root mirror selection")


if __name__ == "__main__":
    unittest.main()
