#!/usr/bin/env python3
"""Replay the frozen V4 simulation with maintained source; no training/network."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "published" / "forecast-lab" / "v4"
RUNNER = ROOT / "apps" / "workbench" / "research" / "trading_strategy.py"


def main():
    assert RUNNER.is_file(), "Maintained strategy runner is missing"
    result = {}
    with tempfile.TemporaryDirectory(prefix="caiso-v4-replay-") as tmp:
        for label, input_name, expected_name, extra in [
            ("forward", "embedded-data.json", "forward-plan.json", ["--date", "2026-10-31"]),
            ("development", "holdout-input.json", "holdout-simulation.json", []),
        ]:
            output = Path(tmp) / f"{label}.json"
            command = [sys.executable, str(RUNNER), "--data", str(DATA / input_name),
                       "--strategy", "normal", "--k", "0.5", "--fee-per-mwh", "1",
                       "--output", str(output), *extra]
            run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=90)
            if run.returncode:
                raise RuntimeError(f"{label} replay failed: {run.stderr[-1800:]}")
            actual = json.loads(output.read_text(encoding="utf-8"))
            expected = json.loads((DATA / expected_name).read_text(encoding="utf-8"))
            for key in ("day", "backtest", "config", "inputDigest", "forecastGeneratedAt"):
                assert actual[key] == expected[key], f"{label}: changed frozen field {key}"
            result[label] = {"matchesFrozenResult": True, "status": actual["day"]["status"],
                             "historicalPnl": actual["backtest"]["total"]}
    assert result["forward"]["status"] == "forecast_only"
    print(json.dumps({"ok": True, "trainingRun": False, "replays": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
