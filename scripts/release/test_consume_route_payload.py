#!/usr/bin/env python3
"""Portable end-to-end check of the beta consume route's packaging contract.

test_restamp.py pins the same assembler -> restamper -> verifier chain on a
synthetic ELF and therefore runs only on the Linux x86_64 CI host. This
battery drives the real chain with script payloads so the two contracts the
beta channel depends on fail on ANY POSIX dev host, not only in CI:

1. the assembler refuses to build a release set without the companion
   tools (the regression class the Big Brother archive fix closed), and
2. the restamped archive carries the beta version in its runtime version
   manifest (package.json) and passes verify_release's consume-route gate
   (`--expect-package-json`) — the version floor release.yml enforces per
   target after the restamp.

The fixture binary implements the shipped runtime version contract
(pa-cli config::version parity: the exe-adjacent package.json wins, a
compiled-in fallback otherwise) as a Python script.

Run: python3 scripts/release/test_consume_route_payload.py
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO = SCRIPTS_DIR.parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from assemble_artifacts import TARGET_ALIASES  # noqa: E402  (same release-scripts directory)
from restamp_continuous import host_target  # noqa: E402

ASSEMBLER = SCRIPTS_DIR / "assemble_artifacts.py"
BUNDLER = SCRIPTS_DIR / "bundle_catalog.py"
RESTAMPER = SCRIPTS_DIR / "restamp_continuous.py"
VERIFIER = SCRIPTS_DIR / "verify_release.py"

HOST_TARGET = host_target()

# The fixture's target. On a Darwin host the script resolver livechecks
# natively (the restamp executes it and compares the reported version); on
# a Linux host the fixture assembles a Darwin target — a foreign target
# skips the binary execution and the GLIBC gate (a script payload is not
# an ELF), and the native livecheck path stays covered by the ELF battery
# (test_restamp.py) the CI host runs.
if HOST_TARGET is not None and HOST_TARGET.endswith("apple-darwin"):
    FIXTURE_TARGET = HOST_TARGET
else:
    FIXTURE_TARGET = "x86_64-apple-darwin"
FIXTURE_ALIAS = TARGET_ALIASES[FIXTURE_TARGET]

# The runtime version resolver the shipped binary implements, as a script:
# `--version` prints the exe-adjacent package.json's version when readable,
# the compiled-in fallback otherwise.
VERSION_RESOLVER = '''#!/usr/bin/env python3
import json
import sys

if "--version" in sys.argv[1:]:
    try:
        with open("package.json", encoding="utf-8") as manifest:
            print(json.load(manifest)["version"])
    except (OSError, ValueError, KeyError):
        print("0.0.0-fallback")
'''


def run_cli(script, args, cwd=None):
    return subprocess.run([sys.executable, str(script), *args],
                          capture_output=True, text=True, cwd=cwd or REPO,
                          check=False)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipIf(HOST_TARGET is None or "-windows-" in HOST_TARGET,
                 "the script-payload fixture runs on POSIX dev hosts only")
class ConsumeRoutePayloadCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.commit = "a" * 40
        self.version = "8.8.8"
        self.beta_version = "8.8.8-beta.3"
        self.build_fixture()
        self.incoming = self.root / "incoming"
        shutil.copytree(self.artifact_dir(self.dist),
                        self.incoming / f"artifacts-{FIXTURE_TARGET}")

    def tearDown(self):
        self.tmp.cleanup()

    def build_fixture(self):
        root = self.root / "repo"
        (root / "skills").mkdir(parents=True)
        (root / "skills" / "skill.md").write_text("# skill\n")
        (root / "LICENSE").write_text("license\n")
        (root / "README.md").write_text("readme\n")
        runtime = root / "runtime"
        runtime.mkdir()
        (runtime / "pyproject.toml").write_text("[project]\nname='rlm'\n")
        (runtime / "src" / "rlm").mkdir(parents=True)
        (runtime / "src" / "rlm" / "repl.py").write_text("# fixture REPL\n")
        bin_dir = root / "bin"
        bin_dir.mkdir()
        self.binary = bin_dir / "prime-agent"
        self.binary.write_text(VERSION_RESOLVER)
        self.binary.chmod(0o755)
        self.companions = [bin_dir / "big-brother", bin_dir / "pa-daemon"]
        for companion in self.companions:
            companion.write_text("#!/bin/sh\nexit 0\n")
            companion.chmod(0o755)
        self.catalog = root / "catalog-assets"
        bundled = run_cli(BUNDLER, ["generate", "--fixture", "--out", str(self.catalog)])
        self.assertEqual(bundled.returncode, 0, bundled.stderr)
        self.dist = self.assemble(companions=True)

    def assemble(self, companions: bool, out_dir: Path = None) -> Path:
        out_dir = out_dir or self.root / f"dist-{companions}"
        args = ["--repo-root", str(self.root / "repo"), "--version", self.version,
                "--target", FIXTURE_TARGET, "--binary", str(self.binary),
                "--runtime-dir", str(self.root / "repo" / "runtime"),
                "--catalog-assets", str(self.catalog),
                "--sha", self.commit,
                "--out-dir", str(out_dir)]
        if companions:
            args += ["--big-brother-binary", str(self.companions[0]),
                     "--daemon-binary", str(self.companions[1])]
        result = run_cli(ASSEMBLER, args)
        if result.returncode:
            raise AssertionError(result.stderr)
        return out_dir

    def artifact_dir(self, out_dir: Path) -> Path:
        """The per-target layout continuous.yml uploads (the layout the
        restamp consumes)."""
        dist = out_dir / f"artifacts-{FIXTURE_TARGET}"
        dist.mkdir()
        archive = out_dir / f"prime-agent-{self.version}-{FIXTURE_ALIAS}.tar.gz"
        shutil.move(str(archive), str(dist / archive.name))
        for name in ("SHA256SUMS", "manifest.json"):
            shutil.move(str(out_dir / name), str(dist / name))
        return dist

    def test_assembly_without_companions_fails(self):
        # The mandatory-companion contract: the assembler hard-fails rather
        # than shipping a three-executive archive whose review sessions
        # cannot boot their kernel (the beta.22 user regression class).
        missing = self.root / "repo" / "bin" / "big-brother"
        missing.unlink()
        result = run_cli(ASSEMBLER, [
            "--repo-root", str(self.root / "repo"), "--version", self.version,
            "--target", FIXTURE_TARGET, "--binary", str(self.binary),
            "--runtime-dir", str(self.root / "repo" / "runtime"),
            "--catalog-assets", str(self.catalog),
            "--out-dir", str(self.root / "dist-nocompanion")])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no executable big-brother binary found", result.stderr)

    def test_the_restamped_set_carries_the_beta_version_and_passes_the_gate(self):
        out = self.root / "restamped"
        result = run_cli(RESTAMPER, [
            "--incoming", str(self.incoming), "--version", self.beta_version,
            "--expect-commit", self.commit, "--out-dir", str(out)])
        self.assertEqual(result.returncode, 0, result.stderr)
        target_dir = out / f"artifacts-{FIXTURE_TARGET}"
        archive = target_dir / f"prime-agent-{self.beta_version}-{FIXTURE_ALIAS}.tar.gz"
        self.assertTrue(archive.is_file(), "the restamped archive is renamed to the version")
        # The runtime version manifest (what the update flow and the
        # shipped `--version` read) carries the beta version, keeping the
        # continuous commit provenance.
        with tarfile.open(archive) as tar:
            package = json.load(tar.extractfile("package.json"))
        self.assertEqual(package["version"], self.beta_version)
        self.assertEqual(package["commit"], self.commit)
        # The companions ride the restamped archive with their bytes intact.
        manifest = json.loads((target_dir / "manifest.json").read_text())
        companions = {row["name"]: row["sha256"]
                      for row in manifest["binaries"][0]["companions"]}
        self.assertEqual(set(companions), {"big-brother", "pa-daemon"})
        with tarfile.open(archive) as tar:
            for name, expected in companions.items():
                member = tar.extractfile(name)
                self.assertIsNotNone(member, f"{name} missing from the archive")
                actual = hashlib.sha256(member.read()).hexdigest()
                self.assertEqual(actual, expected)
        # The release gate release.yml runs per target after the restamp:
        # the consume-route shape, at the beta version.
        verified = run_cli(VERIFIER, [
            "--dist-dir", str(target_dir), "--version", self.beta_version,
            "--target", FIXTURE_TARGET, "--expect-package-json", self.beta_version])
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn("payload, checksums, manifest", verified.stdout)

    def test_a_foreign_target_verifies_with_the_livecheck_skipped(self):
        # The per-target gate runs on ONE runner: a target this host cannot
        # execute skips only the binary execution — payload, checksums,
        # manifest, and the restamped package.json still verify. The rule
        # itself is pinned here (a foreign-Linux e2e needs a real ELF for
        # the assembler's objdump gate, which the script fixture is not):
        # Darwin targets stay executable on every Darwin host — the
        # Apple-silicon pool runs the cross-built x86_64 leg under Rosetta
        # 2 and that gate must keep firing — while a foreign-arch Linux or
        # foreign-OS target skips.
        from verify_release import binary_executable_on_host
        with mock.patch("platform.system", return_value="Darwin"), \
                mock.patch("platform.machine", return_value="arm64"):
            self.assertTrue(binary_executable_on_host("aarch64-apple-darwin"))
            self.assertTrue(binary_executable_on_host("x86_64-apple-darwin"))
            self.assertFalse(binary_executable_on_host("x86_64-unknown-linux-gnu"))
            self.assertFalse(binary_executable_on_host("aarch64-unknown-linux-gnu"))
            self.assertFalse(binary_executable_on_host("x86_64-pc-windows-msvc"))
        with mock.patch("platform.system", return_value="Linux"), \
                mock.patch("platform.machine", return_value="x86_64"):
            self.assertTrue(binary_executable_on_host("x86_64-unknown-linux-gnu"))
            self.assertFalse(binary_executable_on_host("aarch64-unknown-linux-gnu"))
            self.assertFalse(binary_executable_on_host("x86_64-apple-darwin"))
        with mock.patch("platform.system", return_value="Windows"), \
                mock.patch("platform.machine", return_value="AMD64"):
            self.assertTrue(binary_executable_on_host("x86_64-pc-windows-msvc"))
            self.assertFalse(binary_executable_on_host("x86_64-unknown-linux-gnu"))


if __name__ == "__main__":
    unittest.main()
