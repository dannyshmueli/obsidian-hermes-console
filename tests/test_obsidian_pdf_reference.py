"""Tests for the ``@pdf:`` context-reference provider.

Two layers:

* pure helpers (target grammar, vault containment, caps) - run anywhere;
* integration against the real Hermes plugin API and the real vault PDF - these
  skip when ``~/.hermes/hermes-agent`` or the thesis PDF is not present, so the
  same file is meaningful on a fresh checkout.

Run:
    python3 tests/test_obsidian_pdf_reference.py -v
    ~/.hermes/hermes-agent/venv/bin/python tests/test_obsidian_pdf_reference.py -v
"""

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


MOD = load_module(ROOT / "hermes" / "obsidian_pdf_reference.py", "obsidian_pdf_reference_ut")

VAULT = Path(
    os.environ.get(
        "OBSIDIAN_TEST_VAULT",
        str(Path.home() / "Documents/Personal_Repo_Github/Hybrid产业研究笔记.vault"),
    )
)
PDF_REL = (
    "96-机器人业界robot_career/01.JD/01-CAIR-机械臂控制工程师/"
    "机械臂控制_运动规划_柔顺力控算法开发/基于力位混合控制的焊缝打磨机械臂运动控制研究_朱坤.pdf"
)
PDF = VAULT / PDF_REL
HAVE_PDF = PDF.is_file()


class TestHelpers(unittest.TestCase):
    def test_cap_text_keeps_whole_lines(self):
        self.assertEqual(MOD.cap_text("abc", 10), ("abc", False))
        text, truncated = MOD.cap_text("aaaa\nbbbb\ncccc", 12)
        self.assertTrue(truncated)
        self.assertEqual(text, "aaaa\nbbbb\n")

    def test_containment_refuses_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            (vault / "sub").mkdir(parents=True)
            (vault / "sub" / "a.pdf").write_bytes(b"%PDF-1.4\n")
            outside = Path(tmp) / "outside.pdf"
            outside.write_bytes(b"%PDF-1.4\n")

            self.assertEqual(MOD.resolve_in_vault("sub/a.pdf", vault), (vault / "sub" / "a.pdf").resolve())
            self.assertIsNone(MOD.resolve_in_vault("../outside.pdf", vault))
            self.assertIsNone(MOD.resolve_in_vault(str(outside), vault))
            self.assertIsNone(MOD.resolve_in_vault("", vault))

    def test_header_is_vault_relative_through_a_symlinked_vault_root(self):
        """The vault root is often a symlink; the prompt must not get a local path."""
        with tempfile.TemporaryDirectory() as tmp:
            real_vault = Path(tmp) / "real"
            (real_vault / "sub").mkdir(parents=True)
            (real_vault / "sub" / "paper.pdf").write_bytes(b"%PDF-1.4\n")
            linked_vault = Path(tmp) / "link"
            try:
                linked_vault.symlink_to(real_vault, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable on this filesystem")

            # resolve_in_vault resolves the file but not the root: the production path
            pdf = MOD.resolve_in_vault("sub/paper.pdf", linked_vault)
            self.assertIsNotNone(pdf)
            out = MOD.build_reference_text(pdf, linked_vault, 1, 1)
            self.assertTrue(out.startswith("@pdf:sub/paper.pdf"), out[:120])
            self.assertNotIn(str(real_vault), out)

    def test_target_grammar(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "paper.pdf").write_bytes(b"%PDF-1.4\n")

            pdf, first, last = MOD.parse_target("paper.pdf", vault)
            self.assertEqual((pdf.name, first, last), ("paper.pdf", None, None))

            pdf, first, last = MOD.parse_target("paper.pdf:84-86", vault)
            self.assertEqual((first, last), (84, 86))

            pdf, first, last = MOD.parse_target("paper.pdf:9-3", vault)
            self.assertEqual((first, last), (3, 9), "reversed ranges must be normalised")

            pdf, first, last = MOD.parse_target("`paper.pdf`:5", vault)
            self.assertEqual((first, last), (5, 5), "the host strips quotes; we tolerate leftovers")

            self.assertIsInstance(MOD.parse_target("nope.pdf", vault), str)
            self.assertIsInstance(MOD.parse_target("current", vault), str, "no bridge payload yet")

    def test_current_follows_the_bridge_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "reading.pdf").write_bytes(b"%PDF-1.4\n")
            bridge = vault / ".obsidian" / "hermes" / "context.json"
            bridge.parent.mkdir(parents=True)
            bridge.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "vaultPath": str(vault),
                        "context": {
                            "type": "selection",
                            "file": {"path": "reading.pdf"},
                            "pdf": {"pageFrom": 84, "pageTo": 85},
                        },
                    }
                ),
                encoding="utf-8",
            )
            previous = os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH")
            os.environ["OBSIDIAN_CONTEXT_BRIDGE_PATH"] = str(bridge)
            try:
                self.assertEqual(MOD.find_vault_root(), vault)
                pdf, first, last = MOD.parse_target("current:7-8", vault)
                self.assertEqual((pdf.name, first, last), ("reading.pdf", 7, 8))
                pdf, first, last = MOD.parse_target("current", vault)
                self.assertEqual((pdf.name, first, last), ("reading.pdf", None, None))
            finally:
                if previous is None:
                    os.environ.pop("OBSIDIAN_CONTEXT_BRIDGE_PATH", None)
                else:
                    os.environ["OBSIDIAN_CONTEXT_BRIDGE_PATH"] = previous


@unittest.skipUnless(HAVE_PDF, f"vault PDF not present at {PDF}")
class TestAgainstRealVaultPdf(unittest.TestCase):
    def test_page_count(self):
        self.assertEqual(MOD.page_count(PDF), 90)

    def test_extract_page_84_keeps_line_structure(self):
        text = MOD.extract_pages(PDF, 84, 84)
        self.assertIn("焊缝打磨实验验证与结果分析", text)
        self.assertIn("5.3.1", text)
        self.assertIn("50N", text.replace(" ", ""))

    def test_build_reference_text_header_and_body(self):
        out = MOD.build_reference_text(PDF, VAULT, 84, 84)
        self.assertTrue(out.startswith(f"# {PDF_REL} — pages 84-84 of 90"), out[:120])
        self.assertIn("阻抗控制恒力打磨", out)

    def test_resolved_pdf_still_prints_a_vault_relative_header(self):
        """Production order: parse_target resolves the file, then we render it."""
        pdf = MOD.resolve_in_vault(PDF_REL, VAULT)
        self.assertIsNotNone(pdf)
        out = MOD.build_reference_text(pdf, VAULT, 84, 84)
        self.assertTrue(out.startswith(f"# {PDF_REL} — pages 84-84 of 90"), out[:160])

    def test_max_pages_cap_is_announced(self):
        out = MOD.build_reference_text(PDF, VAULT, 1, 90, max_pages=3)
        self.assertIn("pages 1-3 of 90", out)
        self.assertIn("only the first 3 pages", out)

    def test_char_cap_is_announced(self):
        out = MOD.build_reference_text(PDF, VAULT, 84, 84, max_chars=200)
        self.assertIn("truncated at 200 characters", out)


class TestProviderAgainstRealHermes(unittest.TestCase):
    """The provider is only useful if Hermes' own machinery accepts it."""

    @classmethod
    def setUpClass(cls):
        hermes_root = Path.home() / ".hermes" / "hermes-agent"
        if str(hermes_root) not in sys.path:
            sys.path.insert(0, str(hermes_root))
        try:
            import agent.context_references as refs
        except Exception as exc:  # pragma: no cover - environment dependent
            raise unittest.SkipTest(f"Hermes agent package not importable: {exc}")
        cls.refs = refs

    def setUp(self):
        self.refs._context_reference_providers.clear()
        self.addCleanup(self.refs._context_reference_providers.clear)

    def _register(self):
        registered = {}
        refs = self.refs

        class Ctx:
            """Stands in for Hermes' PluginContext, whose register_context_reference()
            delegates to the module-level registry - so the fake must do the same,
            otherwise we would only be testing our own stub."""

            def register_context_reference(self, provider):
                registered["provider"] = provider
                refs.register_context_reference_provider(provider)

        ok = MOD.register_pdf_reference(Ctx())
        self.assertTrue(ok, "register_pdf_reference() returned False")
        return registered["provider"]

    def test_registration_is_visible_to_the_host(self):
        self._register()
        self.assertIn("pdf", self.refs.get_context_reference_providers())

    def test_autocomplete_lists_vault_pdfs(self):
        provider = self._register()
        self.addCleanup(self._restore_bridge_env, os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH"))
        if not HAVE_PDF:
            self.skipTest("vault PDF not present")
        previous = os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH")
        os.environ["OBSIDIAN_CONTEXT_BRIDGE_PATH"] = str(
            VAULT / ".obsidian" / "hermes" / "context.json"
        )
        try:
            items = asyncio.run(provider.autocomplete("朱坤", limit=5))
        finally:
            self._restore_bridge_env(previous)
        self.assertTrue(items, "expected at least one completion for 朱坤")
        self.assertTrue(any("朱坤" in item.text for item in items))

    def _restore_bridge_env(self, previous):
        if previous is None:
            os.environ.pop("OBSIDIAN_CONTEXT_BRIDGE_PATH", None)
        else:
            os.environ["OBSIDIAN_CONTEXT_BRIDGE_PATH"] = previous

    @unittest.skipUnless(HAVE_PDF, "vault PDF not present")
    def test_expand_through_the_real_preprocessor(self):
        self._register()
        previous = os.environ.get("OBSIDIAN_CONTEXT_BRIDGE_PATH")
        os.environ["OBSIDIAN_CONTEXT_BRIDGE_PATH"] = str(
            VAULT / ".obsidian" / "hermes" / "context.json"
        )
        try:
            result = asyncio.run(
                self.refs.preprocess_context_references_async(
                    f"总结这一段 @pdf:{PDF_REL}:84",
                    cwd=VAULT,
                    context_length=200_000,
                )
            )
        finally:
            self._restore_bridge_env(previous)

        self.assertTrue(result.expanded, "the host did not expand @pdf:")
        self.assertIn("📌", result.message)
        self.assertIn("焊缝打磨实验验证与结果分析", result.message)
        self.assertGreater(result.injected_tokens, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
