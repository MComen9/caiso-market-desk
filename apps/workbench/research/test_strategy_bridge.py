#!/usr/bin/env python3
"""Synthetic regression fixtures, never published as observed market history."""
import json
import sys
import unittest
from copy import deepcopy
from datetime import timedelta
from pathlib import Path

from build_strategy_input import build_input, simulation
from trading_strategy import STRATEGIES, StrategyEngine, decision_as_of, hours_for_date, iso, parse_time


NODES = ["TH_NP15_GEN-APND", "TH_SP15_GEN-APND", "TH_ZP26_GEN-APND"]


def fixture(day="2026-10-20", reconstructed=True):
    hours = hours_for_date(day)
    cutoff = parse_time(decision_as_of(day))
    points, actuals = [], []
    for node in NODES:
        for index, hour in enumerate(hours):
            points.append({**hour, "node": node, "predictedDa": 40., "predictedSpread": 8 + index / 10,
                           "sigma": 10., "issuedAt": "2026-10-29T16:00:00Z" if reconstructed else iso(cutoff - timedelta(minutes=10)),
                           "decisionAsOfUtc": iso(cutoff), "trainingEndUtc": iso(cutoff - timedelta(days=1)),
                           "modelVersion": "SYNTHETIC-TEST-ONLY", "sampleCount": 100, "calibrationCount": 30})
            actuals.append({**hour, "node": node, "dam": 40., "fmm": 50., "fmmCount": 4, "paired": True})
    archive = {"rows": actuals, "endDate": day if reconstructed else "2026-10-28", "digest": "synthetic-archive"}
    bundle = {"points": points, "generatedAt": "2026-10-29T16:00:00Z", "modelVersion": "SYNTHETIC-TEST-ONLY", "digest": "synthetic-model"}
    return build_input(bundle, archive, reconstructed), bundle, archive


def plan(engine):
    return [{key: cell[key] for key in ("n", "startUtc", "side", "quote", "qty")} for cell in engine.build_alloc(0, engine.get_config())]


class StrategyBridgeTests(unittest.TestCase):
    def test_actual_prices_never_change_plan(self):
        data, _, _ = fixture()
        first = plan(StrategyEngine(data))
        for node, rows in data["series"].items():
            for index, row in enumerate(rows):
                row[1:3] = [0, 0] if index % 3 == 0 else [None, None] if index % 3 == 1 else [-150, -50]
        self.assertEqual(first, plan(StrategyEngine(data)))

    def test_budget_node_caps_and_minimum(self):
        data, _, _ = fixture()
        engine = StrategyEngine(data)
        for strategy in ("normal", "half"):
            engine.state["strat"] = strategy
            cells = engine.build_alloc(0, engine.get_config())
            self.assertTrue(all(1 <= cell["qty"] <= 2 + 1e-8 for cell in cells))
            self.assertLessEqual(sum(cell["qty"] for cell in cells), 6 if strategy == "half" else 12)
            for node in NODES:
                self.assertLessEqual(sum(cell["qty"] for cell in cells if cell["n"] == node), 6 + 1e-8)

    def test_null_is_missing_not_zero_and_no_sharpe(self):
        data, _, _ = fixture()
        for rows in data["series"].values():
            for row in rows:
                row[2] = None
        result = simulation(data)
        self.assertIsNone(result["day"]["pnl"])
        self.assertIsNone(result["backtest"]["total"])
        self.assertGreater(result["day"]["filled"], 0)
        self.assertEqual(result["day"]["settledMWh"], 0)
        self.assertNotIn("sharpe", result["backtest"])

    def test_zero_negative_prices_preserved(self):
        data, _, _ = fixture()
        for rows in data["series"].values():
            for row in rows:
                row[1:3] = [0, -10]
        result = simulation(data)
        self.assertEqual(result["day"]["pnl"], -120)

    def test_ties_default_not_assumed_filled(self):
        data, _, _ = fixture()
        for rows in data["series"].values():
            for row in rows:
                row[1:3] = [50, 70]
        engine = StrategyEngine(data)
        first = engine.sim_day(0, engine.get_config())
        self.assertEqual(first["pnl"], 0)
        self.assertEqual(first["filled"], 0)
        engine.state["tieFill"] = True
        self.assertEqual(engine.sim_day(0, engine.get_config())["pnl"], 240)

    def test_high_conf_uses_effective_1_5(self):
        data, _, _ = fixture()
        engine = StrategyEngine(data)
        engine.state["strat"] = "high_conf"
        engine.state["k"] = .5
        self.assertEqual(engine.build_alloc(0, engine.get_config()), [])

    def test_future_has_plan_but_no_realized_profit(self):
        data, _, _ = fixture("2026-10-30", False)
        result = simulation(data)
        self.assertGreater(result["day"]["gross"], 0)
        self.assertIsNone(result["day"]["pnl"])
        self.assertIsNone(result["backtest"]["total"])
        self.assertEqual(result["day"]["status"], "forecast_only")

    def test_late_issue_rejected_and_training_time_cannot_follow_issue(self):
        _, bundle, archive = fixture("2026-10-30", False)
        bundle["points"][0]["issuedAt"] = "2026-10-29T17:00:00Z"
        with self.assertRaises(ValueError):
            build_input(bundle, archive)
        bundle["points"][0]["issuedAt"] = "2026-10-28T00:00:00Z"
        with self.assertRaises(ValueError):
            build_input(bundle, archive)

    def test_historical_generation_time_is_not_backdated(self):
        data, bundle, archive = fixture()
        record = data["forecastProvenance"][NODES[0]][0]
        self.assertEqual(record["issuedAt"], "2026-10-29T16:00:00Z")
        self.assertLess(parse_time(record["decisionAsOfUtc"]), parse_time(record["issuedAt"]))
        with self.assertRaises(ValueError):
            build_input(bundle, archive, reconstructed=False)

    def test_dst_23_25_hours(self):
        for day, count in (("2026-03-08", 23), ("2026-11-01", 25)):
            data, _, _ = fixture(day, True)
            engine = StrategyEngine(data)
            self.assertEqual(len(engine.hours), count)
            self.assertEqual(engine.sim_day(0, engine.get_config())["expectedHours"], 3 * count)
        self.assertEqual(decision_as_of("2026-11-02"), "2026-11-01T17:55:00.000Z")

    def test_fee_changes_only_net(self):
        data, _, _ = fixture()
        no_fee, fee = simulation(data), simulation(data, 1.)
        self.assertEqual(no_fee["day"]["gross"], fee["day"]["gross"])
        self.assertEqual(no_fee["day"]["pnl"] - fee["day"]["pnl"], no_fee["day"]["filled"])

    def test_no_automatic_fallback(self):
        data, _, _ = fixture()
        engine = StrategyEngine(data)
        engine.state["mode"] = "auto"
        with self.assertRaises(ValueError):
            engine.apply_auto_select()

    def test_incomplete_fmm_and_duplicate_archive_rejected(self):
        _, bundle, archive = fixture()
        for row in archive["rows"]:
            row["fmmCount"] = 3
        result = simulation(build_input(bundle, archive, True))
        self.assertIsNone(result["day"]["pnl"])
        archive["rows"].append(deepcopy(archive["rows"][0]))
        with self.assertRaises(ValueError):
            build_input(bundle, archive, True)

    def test_inputs_are_not_mutated(self):
        data, _, _ = fixture()
        before = json.dumps(data, sort_keys=True)
        simulation(data)
        self.assertEqual(before, json.dumps(data, sort_keys=True))

    def test_selected_model_did_not_exist_at_tuning_cutoff(self):
        _, bundle, archive = fixture()
        bundle["points"][0]["selectionEligibleAtAsOf"] = False
        with self.assertRaises(ValueError):
            build_input(bundle, archive, True)


if __name__ == "__main__":
    if "--export-parity" in sys.argv:
        cases = []
        for strategy in STRATEGIES:
            for variant in ("normal", "zero_negative", "missing_fmm", "tie"):
                data, bundle, archive = fixture()
                for rows in data["series"].values():
                    for row in rows:
                        if variant == "zero_negative": row[1:3] = [0, -10]
                        if variant == "missing_fmm": row[2] = None
                        if variant == "tie": row[1:3] = [50, 70]
                for row in archive["rows"]:
                    if variant == "zero_negative": row.update(dam=0, fmm=-10)
                    if variant == "missing_fmm": row.update(fmm=None, paired=False)
                    if variant == "tie": row.update(dam=50, fmm=70)
                for point in bundle["points"]:
                    point["issuedAt"] = point["decisionAsOfUtc"]
                engine = StrategyEngine(data)
                engine.state.update(strat=strategy, feePerMWh=1)
                cases.append({"strategy": strategy, "variant": variant, "bundle": bundle,
                              "actuals": archive["rows"], "python": engine.sim_day(0, engine.get_config())})
        path = Path(__file__).resolve().parents[1] / ".sites-runtime/python-parity-fixture.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cases, allow_nan=False))
        print(f"Exported {len(cases)} synthetic parity fixtures: {path}")
    else:
        unittest.main()
