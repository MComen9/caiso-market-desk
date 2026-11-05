#!/usr/bin/env python3
"""Meaningful leakage, chronology, data, and produced-artifact checks."""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forecast_pipeline as fp


class ForecastPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = (fp.ROOT / "data/strategy-history.json").read_bytes()
        cls.archive = json.loads(cls.raw)
        cls.history = fp.MarketHistory(cls.archive)

    def test_features_ignore_target_and_unavailable_recent_actuals(self):
        target = fp.hours_for_day("2026-10-20", self.history.nodes)[12]
        before = self.history.features(target)
        changed = copy.deepcopy(self.archive)
        for row in changed["rows"]:
            if row["localDate"] >= "2026-10-19":
                row["dam"] += 10000
                row["fmm"] -= 5000
        after = fp.MarketHistory(changed).features(target)
        np.testing.assert_equal(before, after)

    def test_features_do_respond_to_eligible_lag(self):
        target = fp.hours_for_day("2026-10-20", self.history.nodes)[12]
        changed = copy.deepcopy(self.archive)
        for row in changed["rows"]:
            if row["localDate"] == "2026-10-18" and row["node"] == target["node"]:
                row["dam"] += 10
        self.assertFalse(np.array_equal(self.history.features(target), fp.MarketHistory(changed).features(target)))

    def test_selection_never_reads_holdout(self):
        values = [
            {"id": "mean_7d", "validation": {"da": {"mae": 10}}, "holdout": {"da": {"mae": 99999}}},
            {"id": "ridge_10", "validation": {"da": {"mae": 9.95}}, "holdout": {"da": {"mae": 0}}},
        ]
        self.assertEqual(fp.choose_candidate(values, "da")["id"], "mean_7d")
        values[0]["holdout"]["da"]["mae"] = 0
        values[1]["holdout"]["da"]["mae"] = 99999
        self.assertEqual(fp.choose_candidate(values, "da")["id"], "mean_7d")

    def test_calibration_excludes_future_and_holdout(self):
        records = []
        for day in ("2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"):
            for hour in range(24):
                records.append({"node": "n", "localDate": day, "actualSpread": float(hour) if day <= "2026-10-13" else 100000,
                                "predictions": {"m": {"spread": 0}}})
        result = fp.residual_calibration(records, "n", "spread", "m", "2026-10-15", fixed_calibration=True)
        self.assertEqual(result["n"], 48)
        self.assertLess(result["upper"], 25)
        later = fp.residual_calibration(records, "n", "spread", "m", "2026-10-30", fixed_calibration=True)
        self.assertEqual(result, later)

    def test_dst_hours_and_cutoffs(self):
        self.assertEqual(len(fp.hours_for_day("2026-03-08", ["n"])), 23)
        fall = fp.hours_for_day("2026-11-01", ["n"])
        self.assertEqual(len(fall), 25)
        repeated = [r for r in fall if r["localHour"] == "01:00"]
        self.assertEqual(len({r["startUtc"] for r in repeated}), 2)
        self.assertEqual({r["utcOffset"] for r in repeated}, {"-07:00", "-08:00"})
        self.assertEqual(fp.decision_cutoff("2026-10-30"), "2026-10-29T16:55:00.000Z")
        self.assertEqual(fp.decision_cutoff("2026-11-02"), "2026-11-01T17:55:00.000Z")

    def test_future_date_respects_real_clock(self):
        before = datetime(2026, 10, 29, 16, 54, tzinfo=timezone.utc)
        after = datetime(2026, 10, 29, 16, 55, tzinfo=timezone.utc)
        self.assertEqual(fp.future_date(before, "2026-10-28"), "2026-10-30")
        self.assertEqual(fp.future_date(after, "2026-10-28"), "2026-10-31")

    def test_forward_input_requires_complete_d_minus_two(self):
        fp.require_fresh_history(self.history, "2026-10-30")
        with self.assertRaisesRegex(ValueError, "2026-10-29"):
            fp.require_fresh_history(self.history, "2026-10-31")
        with self.assertRaisesRegex(ValueError, "will not be imputed"):
            fp.require_fresh_history(self.history, "2026-11-15")

    def test_forward_input_rejects_one_missing_latest_hub_hour(self):
        incomplete = copy.deepcopy(self.archive)
        index = next(i for i, row in enumerate(incomplete["rows"]) if row["localDate"] == "2026-10-28")
        incomplete["rows"][index]["paired"] = False
        with self.assertRaisesRegex(ValueError, "1/72"):
            fp.require_fresh_history(fp.MarketHistory(incomplete), "2026-10-30")

    def test_zero_negative_and_missing_are_distinct(self):
        tiny = copy.deepcopy(self.archive)
        tiny["rows"] = tiny["rows"][:3]
        tiny["rows"][0].update(dam=0.0, fmm=-2.0)
        tiny["rows"][1].update(dam=-5.0, fmm=0.0)
        tiny["rows"][2].update(dam=None)
        parsed = fp.MarketHistory(tiny)
        self.assertEqual(len(parsed.rows), 2)
        self.assertEqual(parsed.excluded, 1)
        self.assertEqual([r["spread"] for r in parsed.rows], [-2, 5])

    def test_duplicate_hours_rejected(self):
        duplicate = copy.deepcopy(self.archive)
        duplicate["rows"].append(copy.deepcopy(duplicate["rows"][0]))
        with self.assertRaises(ValueError):
            fp.MarketHistory(duplicate)

    def test_direction_metric_does_not_credit_zero_signal(self):
        result = fp.metric([-1, 1, 0], [0, 0, 0], spread=True)
        self.assertEqual(result["signAccuracy"], 0)
        self.assertEqual(result["signalRate"], 0)
        self.assertIsNone(result["conditionalSignAccuracy"])

    def test_real_artifacts_have_honest_time_provenance(self):
        folder = fp.ROOT / "public/data/forecast-lab"
        if not (folder / "report.json").exists():
            self.skipTest("Run the full pipeline before artifact checks")
        report = json.loads((folder / "report.json").read_text())
        forward = json.loads((folder / "forecast-forward.json").read_text())
        history = json.loads((folder / "forecast-history.json").read_text())
        self.assertEqual(report["sample"]["inputSha256"], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(report["sample"]["rows"], 4032)
        self.assertEqual(len(history["points"]), 14 * 72)
        for point in history["points"]:
            self.assertEqual(point["issuedAt"], report["generatedAt"])
            self.assertGreater(point["issuedAt"], point["decisionAsOfUtc"])
            self.assertLessEqual(point["trainingEndUtc"], point["decisionAsOfUtc"])
            self.assertEqual(point["calibrationCount"], 144)
        for point in forward["points"]:
            self.assertLess(point["issuedAt"], point["decisionAsOfUtc"])
            self.assertLess(point["issuedAt"], point["startUtc"])
            self.assertLessEqual(point["trainingEndUtc"], point["issuedAt"])
            self.assertIsNone(point["actualDa"])
            self.assertIsNone(point["actualFmm"])
            self.assertEqual(point["calibrationCount"], 144)
        self.assertEqual(len(forward["points"]), len(fp.hours_for_day(report["forecast"]["targetDate"], self.history.nodes)))
        for audit in report["method"]["fitAudit"]:
            self.assertEqual(audit["latestLabelDate"], fp.shifted(audit["targetDate"], -2))
            self.assertLessEqual(audit["trainingEndUtc"], audit["decisionAsOfUtc"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
