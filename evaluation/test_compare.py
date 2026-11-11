import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("compare", Path(__file__).with_name("compare.py"))
compare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compare)


class ComparisonTests(unittest.TestCase):
    def test_openrouter_cost_retains_raw_value_without_claiming_catalog_or_billing(self):
        with tempfile.TemporaryDirectory() as root:
            session = Path(root) / "12345678-1234-1234-1234-123456789abc.jsonl"
            session.write_text(json.dumps({"type": "message", "message": {
                "role": "assistant", "provider": "openrouter", "model": "example",
                "usage": {"input": 2, "output": 3, "cost": {"total": 0.25}},
            }}) + "\n")
            actual = compare.usage(Path(root))
            self.assertEqual(actual["rawUsageCostTotal"], 0.25)
            self.assertIsNone(actual["catalogEstimatedCost"])
            self.assertIsNone(actual["providerBilledCost"])
            self.assertEqual(actual["costRecords"][0]["provenance"], "ambiguous")

    @unittest.skipUnless(os.name == "posix", "Unix permissions")
    def test_run_output_is_private_under_public_umask(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source"
            source.mkdir()
            template = root / "template"
            template.mkdir()
            (template / "models.json").write_text("{}")
            corpus = root / "corpus.json"
            corpus.write_text('{"cases": []}')
            original = compare.CORPUS
            old_umask = os.umask(0o022)
            try:
                compare.CORPUS = corpus
                output = root / "output"
                compare.run(argparse.Namespace(source=source, agent_template=template,
                                               output=output, cases=None, repetitions=1))
                self.assertEqual(output.stat().st_mode & 0o777, 0o700)
                self.assertEqual((output / "corpus.json").stat().st_mode & 0o777, 0o600)
                self.assertEqual((output / "blinded.json").stat().st_mode & 0o777, 0o600)
            finally:
                compare.CORPUS = original
                os.umask(old_umask)

    def test_completed_run_with_missing_peer_evidence_cannot_be_compared(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source"
            source.mkdir()
            template = root / "template"
            template.mkdir()
            (template / "models.json").write_text("{}")
            corpus = root / "corpus.json"
            corpus.write_text('{"cases": [{"id": "case", "head": "revision"}]}')
            args = argparse.Namespace(source=source, agent_template=template,
                                      output=root / "output", cases=None, repetitions=1,
                                      work_dir=root)
            old_umask = os.umask(0o022)
            try:
                with patch.object(compare, "CORPUS", corpus), \
                     patch.object(compare, "command", return_value="revision"), \
                     patch.object(compare, "run_variant", side_effect=[
                         {"status": "completed", "evidenceSha256": "hash"},
                         {"status": "incomplete"}]):
                    with self.assertRaisesRegex(RuntimeError, "shared evidence unavailable"):
                        compare.run(args)
            finally:
                os.umask(old_umask)


if __name__ == "__main__":
    unittest.main()
