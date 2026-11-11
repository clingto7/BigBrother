#!/usr/bin/env python3
"""Replay historical review ranges through the product's range boundary."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid


CORPUS = Path(__file__).with_name("corpus.json")


def command(*args, cwd=None, timeout=120):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout.strip()


def slug(path):
    return re.sub(r"[^a-z0-9]+", "-", str(path).lower()).strip("-")


def usage(agent_dir):
    totals = {key: 0 for key in ("requests", "input", "cacheRead", "cacheWrite", "output")}
    estimate = 0.0
    priced_requests = 0
    raw_cost = 0.0
    raw_cost_requests = 0
    ambiguous_cost = False
    cost_records = []
    session_ids = []
    for path in sorted(agent_dir.rglob("*.jsonl")):
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", path.stem):
            continue
        session_ids.append(path.stem)
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = row.get("message", {})
            if row.get("type") != "message" or message.get("role") != "assistant":
                continue
            amount = message.get("usage")
            if not isinstance(amount, dict):
                continue
            totals["requests"] += 1
            for key in ("input", "cacheRead", "cacheWrite", "output"):
                totals[key] += amount.get(key, 0) or 0
            cost = amount.get("cost")
            total = cost.get("total") if isinstance(cost, dict) else None
            provider = message.get("provider")
            # OpenRouter may replace the catalog calculation with provider billing.
            # The session format does not retain which path produced this value.
            provenance = "ambiguous" if provider == "openrouter" else "catalogEstimate"
            if isinstance(total, (int, float)):
                raw_cost += total
                raw_cost_requests += 1
                if provenance == "catalogEstimate":
                    estimate += total
                    priced_requests += 1
            if provenance == "ambiguous":
                ambiguous_cost = True
            cost_records.append({"provider": provider, "model": message.get("model"),
                                 "rawUsageCostTotal": total, "provenance": provenance})
    totals["catalogEstimatedCost"] = estimate if not ambiguous_cost and priced_requests == totals["requests"] else None
    totals["providerBilledCost"] = None
    totals["rawUsageCostTotal"] = raw_cost if raw_cost_requests == totals["requests"] else None
    totals["costRecords"] = cost_records
    totals["sessionIds"] = session_ids
    return totals


def run_variant(args, repo, remote, base, head, branch, case, topology, output):
    command("git", "--git-dir", str(remote), "update-ref", f"refs/heads/{branch}", base)
    command("git", "reset", "--hard", base, cwd=repo)
    agent_dir = repo.parent / f"agent-{topology}"
    agent_dir.mkdir(mode=0o700)
    (agent_dir / "sessions").mkdir()
    for name in ("models.json", "settings.json", "auth.json"):
        source = args.agent_template / name
        if source.exists():
            shutil.copyfile(source, agent_dir / name)
            (agent_dir / name).chmod(0o600)
    profile = agent_dir / "big-brother" / "repos" / slug(repo) / "profile.json"
    profile.parent.mkdir(parents=True)
    names = ["requirements", "project-fit", "implementation"] if topology == "layered" else ["comprehensive"]
    profile.write_text(json.dumps({
        "version": 1, "sessionName": f"review-{case['id']}-{topology}",
        "mainModel": args.model, "intensity": "full",
        "layers": [{"name": name, "model": args.model} for name in names],
        "attemptTimeoutSeconds": args.attempt_timeout, "maxAttempts": args.max_attempts,
    }))
    socket = repo.parent / f"{topology}.sock"
    daemon_log = (output / f"{topology}-daemon.log").open("w")
    daemon = subprocess.Popen([str(args.daemon), "supervisor", "--socket", str(socket),
                               "--agent-dir", str(agent_dir)], stdout=daemon_log, stderr=subprocess.STDOUT,
                              env={**os.environ, "PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS": "0"})
    started = time.monotonic()
    result = {"case": case["id"], "topology": topology, "model": args.model,
              "intensity": "full", "base": base, "head": head,
              "status": "incomplete", "error": None, "record": None}
    try:
        while not socket.exists():
            if daemon.poll() is not None or time.monotonic() - started > 15:
                raise RuntimeError("daemon did not become ready")
            time.sleep(0.05)
        command(str(args.big_brother), "init", "--repo", str(repo), "--branch", branch,
                "--agent-dir", str(agent_dir), "--socket", str(socket), timeout=30)
        command("git", "--git-dir", str(remote), "update-ref", f"refs/heads/{branch}", head)
        deadline = time.monotonic() + args.run_timeout
        record_path = profile.parent / "records" / branch / f"{head}.json"
        state_path = profile.parent / "state.json"
        while time.monotonic() < deadline:
            command(str(args.daemon), "observer", "--socket", str(socket),
                    "--agent-dir", str(agent_dir), "--once", timeout=120)
            if record_path.exists():
                result["record"] = json.loads(record_path.read_text())
                result["status"] = "completed"
                break
            if state_path.exists():
                state = json.loads(state_path.read_text())
                branch_state = state.get("branches", {}).get(branch, {})
                if branch_state.get("lastFailure"):
                    result["status"] = "failed"
                    result["failureState"] = branch_state["lastFailure"]
                    break
            time.sleep(args.poll_interval)
        if result["status"] == "incomplete":
            result["error"] = "run deadline exceeded before a completed Review record"
        evidence = profile.parent / "evidence" / branch / f"{base}-{head}.json"
        if evidence.exists():
            body = evidence.read_bytes()
            result["evidenceSha256"] = hashlib.sha256(body).hexdigest()
            result["evidenceId"] = json.loads(body)["id"]
            shutil.copyfile(evidence, output / f"{topology}-evidence.json")
    except Exception as error:
        result["error"] = str(error)
    finally:
        result["elapsedSeconds"] = time.monotonic() - started
        daemon.terminate()
        try:
            daemon.wait(timeout=10)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait()
        # The worker's lost-supervisor monitor checks asynchronously. Give it
        # time to exit before the temporary credential-bearing tree is removed.
        time.sleep(2)
        daemon_log.close()
        result["usage"] = usage(agent_dir)
        sessions_out = output / f"{topology}-sessions"
        sessions_out.mkdir()
        for path in agent_dir.rglob("*.jsonl"):
            if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", path.stem):
                continue
            shutil.copyfile(path, sessions_out / path.name)
        (output / f"{topology}.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def run(args):
    os.umask(0o077)
    corpus = json.loads(CORPUS.read_text())
    args.source = args.source.resolve()
    available = {case["id"] for case in corpus["cases"]}
    if args.cases and not set(args.cases) <= available:
        raise ValueError(f"unknown corpus case(s): {sorted(set(args.cases) - available)}")
    if not (args.agent_template / "models.json").exists() and not (args.agent_template / "auth.json").exists():
        raise FileNotFoundError("agent template needs models.json or auth.json for the selected provider")
    args.output = args.output.resolve()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copyfile(CORPUS, args.output / "corpus.json")
    mapping = {}
    for case in corpus["cases"]:
        if args.cases and case["id"] not in args.cases:
            continue
        head = command("git", "rev-parse", f"{case['head']}^{{commit}}", cwd=args.source)
        base = command("git", "rev-parse", f"{head}^", cwd=args.source)
        for repetition in range(1, args.repetitions + 1):
            case_out = args.output / case["id"] / f"repeat-{repetition:02}"
            case_out.mkdir(parents=True)
            with tempfile.TemporaryDirectory(prefix="bb-review-", dir=args.work_dir) as root:
                root = Path(root)
                remote = root / "remote.git"
                repo = root / "repo"
                command("git", "init", "--bare", "--quiet", str(remote))
                # Historical source checkouts may themselves be shallow.
                command("git", "--git-dir", str(remote), "config", "receive.shallowUpdate", "true")
                branch = "review-eval"
                # Transfer only the historical head and its ancestors. Future fixes must
                # not be reachable through origin/main or another reference in the
                # reviewer's checkout.
                command("git", "push", "--quiet", str(remote),
                        f"{head}:refs/heads/{branch}", cwd=args.source, timeout=300)
                command("git", "--git-dir", str(remote), "update-ref", f"refs/heads/{branch}", base)
                command("git", "clone", "--quiet", "--branch", branch, str(remote), str(repo), timeout=300)
                results = [run_variant(args, repo, remote, base, head, branch, case, topology, case_out)
                           for topology in ("layered", "single")]
                hashes = [result.get("evidenceSha256") for result in results]
                if any(result["status"] == "completed" and not result.get("evidenceSha256")
                       for result in results):
                    raise RuntimeError(f"{case['id']} repetition {repetition}: completed review lacks evidence")
                if any(result["status"] == "completed" for result in results) and not all(hashes):
                    raise RuntimeError(f"{case['id']} repetition {repetition}: shared evidence unavailable for comparison: {hashes}")
                if all(hashes) and hashes[0] != hashes[1]:
                    raise RuntimeError(f"{case['id']} repetition {repetition}: shared evidence bytes differ: {hashes}")
                for result in results:
                    blind = uuid.uuid4().hex[:12]
                    mapping[blind] = {"case": case["id"], "repetition": repetition,
                                      "topology": result["topology"]}
                    record = result.get("record") or {}
                    answers = [layer.get("answer", "") for layer in record.get("layers", [])]
                    (case_out / f"{blind}-review.txt").write_text(json.dumps({
                        "assessmentText": "\n\n".join(answers), "conclusion": record.get("conclusion"),
                        "status": result["status"], "error": result["error"]}, indent=2) + "\n")
    (args.output / "blinded.json").write_text(json.dumps(mapping, indent=2) + "\n")


def score(args):
    os.umask(0o077)
    output = args.output.resolve()
    corpus = {case["id"]: case for case in json.loads((output / "corpus.json").read_text())["cases"]}
    mapping = json.loads((output / "blinded.json").read_text())
    judgments = json.loads(args.judgments.read_text())
    rows = []
    for blind, identity in mapping.items():
        case = corpus[identity["case"]]
        run_path = output / case["id"] / f"repeat-{identity['repetition']:02}" / f"{identity['topology']}.json"
        run = json.loads(run_path.read_text())
        judgment = judgments.get(blind)
        known = {defect["id"] for defect in case["defects"] if defect["severity"] == "serious"}
        if judgment and judgment.get("status") == "adjudicated" and run["status"] == "completed":
            detected = set(judgment["detectedDefectIds"])
            if not detected <= known:
                raise ValueError(f"{blind}: unknown defect id(s): {detected - known}")
            false_positives = judgment["falsePositiveCount"]
            if not isinstance(false_positives, int) or false_positives < 0:
                raise ValueError(f"{blind}: falsePositiveCount must be a nonnegative integer")
            quality = {"seriousDetected": len(detected), "seriousKnown": len(known),
                       "falsePositives": false_positives}
        else:
            quality = {"seriousDetected": None, "seriousKnown": len(known),
                       "falsePositives": None}
        rows.append({"case": case["id"], "repetition": identity["repetition"],
                     "topology": identity["topology"],
                     "status": run["status"], "quality": quality,
                     "usage": run["usage"], "elapsedSeconds": run["elapsedSeconds"]})
    summary = {}
    for topology in ("layered", "single"):
        group = [row for row in rows if row["topology"] == topology]
        graded = [row for row in group if row["quality"]["seriousDetected"] is not None]
        found = sum(row["quality"]["seriousDetected"] for row in graded)
        known = sum(row["quality"]["seriousKnown"] for row in graded)
        summary[topology] = {
            "adjudicatedRanges": len(graded),
            "incompleteOrFailedRanges": sum(row["status"] != "completed" for row in group),
            "seriousRecall": found / known if known else None,
            "seriousFound": found if graded else None,
            "seriousKnown": known if graded else None,
            "falsePositives": sum(row["quality"]["falsePositives"] for row in graded) if graded else None,
            "requests": sum(row["usage"]["requests"] for row in group),
            "input": sum(row["usage"]["input"] for row in group),
            "cacheRead": sum(row["usage"]["cacheRead"] for row in group),
            "cacheWrite": sum(row["usage"]["cacheWrite"] for row in group),
            "output": sum(row["usage"]["output"] for row in group),
            "elapsedSeconds": sum(row["elapsedSeconds"] for row in group),
            "catalogEstimatedCost": sum(row["usage"]["catalogEstimatedCost"] for row in group)
            if all(row["usage"]["catalogEstimatedCost"] is not None for row in group) else None,
            "providerBilledCost": None,
            "rawUsageCostTotal": sum(row["usage"]["rawUsageCostTotal"] for row in group)
            if all(row["usage"].get("rawUsageCostTotal") is not None for row in group) else None,
        }
    (output / "comparison.json").write_text(json.dumps({
        "quality": {name: {key: value for key, value in values.items()
                            if key not in ("requests", "input", "cacheRead", "cacheWrite",
                                           "output", "elapsedSeconds", "catalogEstimatedCost", "providerBilledCost", "rawUsageCostTotal")}
                    for name, values in summary.items()},
        "perRange": rows,
        "usage": {name: {key: value for key, value in values.items()
                          if key in ("requests", "input", "cacheRead", "cacheWrite", "output",
                                     "elapsedSeconds", "catalogEstimatedCost", "providerBilledCost", "rawUsageCostTotal")}
                  for name, values in summary.items()},
        "decision": "undetermined; inspect serious recall, false positives, failures, then cost",
    }, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    replay = commands.add_parser("run", help="perform live model replays")
    replay.add_argument("--source", type=Path, required=True)
    replay.add_argument("--agent-template", type=Path, required=True)
    replay.add_argument("--model", required=True, help="same provider/model for Prime and all reviewers")
    replay.add_argument("--big-brother", type=Path, required=True)
    replay.add_argument("--daemon", type=Path, required=True)
    replay.add_argument("--output", type=Path, required=True)
    replay.add_argument("--work-dir", type=Path)
    replay.add_argument("--run-timeout", type=int, default=2400)
    replay.add_argument("--attempt-timeout", type=int, default=1800)
    replay.add_argument("--max-attempts", type=int, default=3)
    replay.add_argument("--poll-interval", type=float, default=1)
    replay.add_argument("--repetitions", type=int, default=3)
    replay.add_argument("--case", dest="cases", action="append", help="run one named corpus case (repeatable)")
    grade = commands.add_parser("score", help="combine blinded adjudications with usage")
    grade.add_argument("--output", type=Path, required=True)
    grade.add_argument("--judgments", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "run":
        if args.repetitions < 1:
            parser.error("--repetitions must be positive")
        args.big_brother = args.big_brother.resolve()
        args.daemon = args.daemon.resolve()
        args.agent_template = args.agent_template.resolve()
        run(args)
    else:
        score(args)


if __name__ == "__main__":
    main()
