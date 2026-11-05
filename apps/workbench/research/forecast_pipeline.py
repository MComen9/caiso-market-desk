#!/usr/bin/env python3
"""Reproducible CAISO hourly price study and real forward forecast.

Historical predictions are reconstructed today. They are never stamped with a
fictional historical issue time. Every feature and training label obeys a
conservative two-complete-PT-day delay. Model selection, uncertainty calibration,
and the final holdout use disjoint periods with a one-day purge between them.

Run from the repository root:
    python research/forecast_pipeline.py
    python research/forecast_pipeline.py --forecast-date 2026-10-30

No order submission, hosted model service, account access, or network requests.
The only inputs are explicitly supplied archived data files.
"""
from __future__ import annotations

import os
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")

import argparse
import csv
import hashlib
import json
import math
import platform
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import sklearn
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
PT = ZoneInfo("America/Los_Angeles")
UTC = timezone.utc
SEED = 42
PIPELINE_VERSION = "caiso-price-forecast-1.0.0"
SELECTION_AVAILABLE_FROM = "2026-10-08"
SPLITS = {
    "validation": {"startDate": "2026-09-25", "endDate": "2026-10-06", "days": 12},
    "calibration": {"startDate": "2026-10-08", "endDate": "2026-10-13", "days": 6},
    "holdout": {"startDate": "2026-10-15", "endDate": "2026-10-28", "days": 14},
    "purgedDates": ["2026-10-07", "2026-10-14"],
}
CANDIDATES = [
    {"id": "zero_spread", "label": "零价差基线", "family": "baseline", "params": {"daWindowDays": 14, "spreadConstant": 0}, "complexity": 0},
    {"id": "seasonal_7d", "label": "上周同小时", "family": "baseline", "params": {"lagDays": 7}, "complexity": 1},
    {"id": "mean_7d", "label": "同小时 7 日均值", "family": "baseline", "params": {"windowDays": 7}, "complexity": 2},
    {"id": "mean_14d", "label": "同小时 14 日均值", "family": "baseline", "params": {"windowDays": 14}, "complexity": 3},
    {"id": "mean_28d", "label": "同小时 28 日均值", "family": "baseline", "params": {"windowDays": 28}, "complexity": 4},
    {"id": "ridge_10", "label": "Ridge · α=10", "family": "ridge", "params": {"alpha": 10}, "complexity": 5},
    {"id": "ridge_100", "label": "Ridge · α=100", "family": "ridge", "params": {"alpha": 100}, "complexity": 6},
    {"id": "hgb_7", "label": "梯度提升树 · 7 叶", "family": "hist_gradient_boosting", "params": {"max_leaf_nodes": 7, "max_iter": 80, "learning_rate": 0.05, "min_samples_leaf": 32, "l2_regularization": 10}, "complexity": 7},
    {"id": "extra_trees_24", "label": "Extra Trees · 叶最少 24 样本", "family": "extra_trees", "params": {"n_estimators": 64, "max_depth": 6, "min_samples_leaf": 24, "max_features": 1.0}, "complexity": 8},
]
BY_ID = {c["id"]: c for c in CANDIDATES}


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamps require an explicit UTC offset")
    return parsed.astimezone(UTC)


def shifted(day: str, delta: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=delta)).isoformat()


def decision_cutoff(day: str) -> str:
    previous = date.fromisoformat(day) - timedelta(days=1)
    return iso(datetime.combine(previous, time(9, 55), PT))


def hours_for_day(day: str, nodes: list[str]) -> list[dict[str, Any]]:
    d = date.fromisoformat(day)
    start = datetime.combine(d, time(), PT).astimezone(UTC)
    end = datetime.combine(d + timedelta(days=1), time(), PT).astimezone(UTC)
    out: list[dict[str, Any]] = []
    while start < end:
        local = start.astimezone(PT)
        offset = local.strftime("%z")
        for node in nodes:
            out.append({"node": node, "startUtc": iso(start), "endUtc": iso(start + timedelta(hours=1)),
                        "localDate": day, "localHour": local.strftime("%H:%M"),
                        "utcOffset": offset[:3] + ":" + offset[3:]})
        start += timedelta(hours=1)
    return out


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def split_for(day: str) -> str:
    for key in ("validation", "calibration", "holdout"):
        interval = SPLITS[key]
        if interval["startDate"] <= day <= interval["endDate"]:
            return key
    return "purge" if day in SPLITS["purgedDates"] else "warmup"


class MarketHistory:
    """UTC records plus same-wall-hour groups; DST folds count as one day."""

    def __init__(self, archive: dict[str, Any]):
        self.archive = archive
        self.nodes = sorted(archive["nodes"])
        self.rows: list[dict[str, Any]] = []
        self.by_key: dict[tuple[str, str], dict[str, Any]] = {}
        self.groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
        self.daily: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        self.excluded = 0
        for original in archive["rows"]:
            row = dict(original)
            start, end = parse_utc(row["startUtc"]), parse_utc(row["endUtc"])
            if end - start != timedelta(hours=1):
                raise ValueError("Archive row is not an exact UTC hour")
            local = start.astimezone(PT)
            if local.date().isoformat() != row["localDate"] or local.strftime("%H:%M") != row["localHour"]:
                raise ValueError("Archive local/UTC time mismatch")
            row["startUtc"], row["endUtc"] = iso(start), iso(end)
            key = (row["node"], row["startUtc"])
            if key in self.by_key:
                raise ValueError("Duplicate node / UTC hour")
            if not (finite(row.get("dam")) and finite(row.get("fmm")) and row.get("paired") is True and row.get("fmmCount") == 4):
                self.excluded += 1
                continue
            row["spread"] = row["fmm"] - row["dam"]
            self.rows.append(row)
            self.by_key[key] = row
            self.groups[(row["localDate"], row["node"], row["localHour"])].append(row)
            self.daily[(row["localDate"], row["node"])].append(row)
        self.rows.sort(key=lambda r: (r["startUtc"], r["node"]))
        self.dates = sorted({r["localDate"] for r in self.rows})
        if not self.dates:
            raise ValueError("No complete DA / FMM hourly observations")
        self.feature_names: list[str] = []

    def value(self, day: str, node: str, hour: str, target: str) -> float:
        group = self.groups.get((day, node, hour), [])
        return float(np.mean([r["dam" if target == "da" else "spread"] for r in group])) if group else float("nan")

    def same_hour(self, row: dict[str, Any], target: str, window: int) -> list[float]:
        values = [self.value(shifted(row["localDate"], -lag), row["node"], row["localHour"], target) for lag in range(2, window + 2)]
        return [v for v in values if math.isfinite(v)]

    def features(self, row: dict[str, Any]) -> np.ndarray:
        day, node, hour = row["localDate"], row["node"], row["localHour"]
        hour_number, weekday = int(hour[:2]), date.fromisoformat(day).weekday()
        features: dict[str, float] = {}
        for known in self.nodes:
            features[f"node_{known}"] = float(node == known)
        for h in range(24):
            features[f"hour_{h:02d}"] = float(hour_number == h)
        for w in range(7):
            features[f"weekday_{w}"] = float(weekday == w)
        for target in ("da", "spread"):
            for lag in (2, 3, 7, 14):
                features[f"{target}_lag{lag}"] = self.value(shifted(day, -lag), node, hour, target)
            for window in (7, 14, 28):
                values = self.same_hour(row, target, window)
                features[f"{target}_same_hour_mean{window}"] = float(np.mean(values)) if values else float("nan")
                features[f"{target}_same_hour_std{window}"] = float(np.std(values, ddof=1)) if len(values) > 1 else float("nan")
            prior_day = self.daily.get((shifted(day, -2), node), [])
            values = [r["dam" if target == "da" else "spread"] for r in prior_day]
            features[f"{target}_prior_day_mean"] = float(np.mean(values)) if values else float("nan")
            features[f"{target}_prior_day_std"] = float(np.std(values, ddof=1)) if len(values) > 1 else float("nan")
            for other_node in self.nodes:
                features[f"{target}_cross_hub_lag2_{other_node}"] = self.value(shifted(day, -2), other_node, hour, target)
        # Missing lag14 in the early training period is imputed using that fit's
        # training rows only, not by looking ahead or dropping another two weeks.
        if not self.feature_names:
            self.feature_names = list(features)
        if list(features) != self.feature_names:
            raise AssertionError("Feature schema changed")
        return np.asarray(list(features.values()), dtype=float)

    def baseline(self, row: dict[str, Any], candidate: str, target: str) -> float:
        if candidate == "zero_spread" and target == "spread":
            return 0.0
        if candidate == "seasonal_7d":
            value = self.value(shifted(row["localDate"], -7), row["node"], row["localHour"], target)
            if math.isfinite(value):
                return value
        window = 14 if candidate in ("zero_spread", "seasonal_7d") else int(candidate.split("_")[1][:-1])
        values = self.same_hour(row, target, window)
        if not values:
            raise ValueError("No causal baseline history")
        return float(np.mean(values))


def estimator(candidate: dict[str, Any]) -> Pipeline | None:
    family, params = candidate["family"], candidate["params"]
    if family == "baseline":
        return None
    if family == "ridge":
        return Pipeline([("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
                         ("scale", StandardScaler()), ("model", Ridge(**params))])
    if family == "hist_gradient_boosting":
        # No random validation subset or early stopping: chronological evaluation
        # is performed explicitly by the outer daily-origin loop.
        model = HistGradientBoostingRegressor(**params, random_state=SEED, early_stopping=False)
    elif family == "extra_trees":
        model = ExtraTreesRegressor(**params, random_state=SEED, n_jobs=1)
    else:
        raise ValueError(f"Unknown candidate family {family}")
    return Pipeline([("impute", SimpleImputer(strategy="median", keep_empty_features=True)), ("model", model)])


def metric(actual: list[float] | np.ndarray, predicted: list[float] | np.ndarray, *, spread: bool = False) -> dict[str, Any]:
    y, p = np.asarray(actual, dtype=float), np.asarray(predicted, dtype=float)
    if len(y) != len(p) or not len(y) or not np.all(np.isfinite(y)) or not np.all(np.isfinite(p)):
        raise ValueError("Metrics require matched finite non-empty arrays")
    error = p - y
    result = {"mae": float(np.mean(np.abs(error))), "rmse": float(np.sqrt(np.mean(error ** 2))),
              "bias": float(np.mean(error)), "n": len(y)}
    if spread:
        nonzero = np.abs(y) > 1e-12
        active = np.abs(p) > 1e-12
        result.update(signAccuracy=float(np.mean(np.sign(y[nonzero]) == np.sign(p[nonzero]))) if np.any(nonzero) else None,
                      signalRate=float(np.mean(active)),
                      conditionalSignAccuracy=float(np.mean(np.sign(y[nonzero & active]) == np.sign(p[nonzero & active]))) if np.any(nonzero & active) else None)
    return result


def choose_candidate(candidate_metrics: list[dict[str, Any]], target: str) -> dict[str, Any]:
    best = min(c["validation"][target]["mae"] for c in candidate_metrics)
    # A predeclared one-percent tolerance prefers a simpler candidate when the
    # validation loss difference is small; the holdout is never examined here.
    eligible = [c for c in candidate_metrics if c["validation"][target]["mae"] <= best * 1.01 + 1e-12]
    return min(eligible, key=lambda c: BY_ID[c["id"]]["complexity"])


def residual_calibration(records: list[dict[str, Any]], node: str, target: str, model_id: str,
                         decision_day: str, *, fixed_calibration: bool) -> dict[str, Any]:
    latest = shifted(decision_day, -2)
    chosen = [r for r in records if r["node"] == node and r["localDate"] <= latest]
    if fixed_calibration:
        chosen = [r for r in chosen if SPLITS["calibration"]["startDate"] <= r["localDate"] <= SPLITS["calibration"]["endDate"]]
    else:
        # For tuning records only, use already observed rolling-origin residuals.
        chosen = [r for r in chosen if r["localDate"] >= shifted(decision_day, -16)]
    if len(chosen) < 24:
        return {"n": len(chosen), "sigma": None, "lower": None, "upper": None, "bias": None}
    actual_key = "actualDa" if target == "da" else "actualSpread"
    errors = np.asarray([r[actual_key] - r["predictions"][model_id][target] for r in chosen])
    return {"n": len(errors), "sigma": float(np.std(errors, ddof=1)),
            "lower": float(np.quantile(errors, 0.10)), "upper": float(np.quantile(errors, 0.90)),
            "bias": float(np.mean(errors))}


def export_fitted(model: Pipeline | None, candidate: dict[str, Any], feature_names: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {"id": candidate["id"], "family": candidate["family"], "params": candidate["params"], "featureNames": feature_names}
    if model is None:
        out["implementation"] = "MarketHistory.baseline; uses explicit lagged values from the archived training input"
        return out
    out["imputerMedian"] = model.named_steps["impute"].statistics_.tolist()
    fitted = model.named_steps["model"]
    if "scale" in model.named_steps:
        out["scalerMean"] = model.named_steps["scale"].mean_.tolist()
        out["scalerScale"] = model.named_steps["scale"].scale_.tolist()
    if isinstance(fitted, Ridge):
        out["coef"] = fitted.coef_.tolist()
        out["intercept"] = float(fitted.intercept_)
    elif isinstance(fitted, ExtraTreesRegressor):
        out["featureImportance"] = fitted.feature_importances_.tolist()
        out["trees"] = [{"childrenLeft": t.tree_.children_left.tolist(), "childrenRight": t.tree_.children_right.tolist(),
                         "feature": t.tree_.feature.tolist(), "threshold": t.tree_.threshold.tolist(),
                         "value": t.tree_.value[:, 0, 0].tolist()} for t in fitted.estimators_]
    elif isinstance(fitted, HistGradientBoostingRegressor):
        out["baselinePrediction"] = fitted._baseline_prediction.tolist()
        out["trees"] = [[{name: value.item() for name, value in zip(tree.nodes.dtype.names, node)}
                          for node in tree.nodes] for stage in fitted._predictors for tree in stage]
        out["note"] = "Numeric-threshold tree state for inspection; canonical replay refits via this versioned Python pipeline. No pickle deserialization is used."
    return out


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


def future_date(now: datetime, latest_complete: str) -> str:
    target = max(now.astimezone(PT).date() + timedelta(days=1), date.fromisoformat(latest_complete) + timedelta(days=2))
    while parse_utc(decision_cutoff(target.isoformat())) <= now:
        target += timedelta(days=1)
    return target.isoformat()


def require_fresh_history(history: MarketHistory, target_day: str) -> None:
    """Fail closed if any required D−2 hub/hour is absent or incomplete.

    A later eligible auction date is not permission to impute a missing most
    recent complete day from stale archives. Older optional lag features may
    still be imputed inside training, as declared by the frozen protocol.
    """
    required_day = shifted(target_day, -2)
    expected = hours_for_day(required_day, history.nodes)
    missing = [r for r in expected if (r["node"], r["startUtc"]) not in history.by_key]
    if missing:
        raise ValueError(
            f"Stale or incomplete forecast input: target {target_day} requires a complete "
            f"D−2 PT day {required_day} for every hub/hour; {len(missing)}/{len(expected)} "
            f"required DA/FMM pairs are missing. Latest archived date is {history.dates[-1]}. "
            "Update the archived data and declare the new research protocol before generating "
            "another forward forecast. Missing recent-day inputs will not be imputed. "
            "Existing frozen forecast/strategy inputs remain replayable without retraining."
        )


def promotion_gate(report: dict[str, Any]) -> dict[str, Any]:
    """Research diagnostics, never an automatic authorization to trade."""
    comparisons = []
    for target, label in (("da", "日前价格"), ("spread", "FMM−DA 价差")):
        selected = report["holdout"]["selected"][target]["mae"]
        baseline = report["holdout"]["baseline"][target]["mae"]
        comparisons.append({"target": target, "label": label, "selectedMae": selected, "baselineMae": baseline,
                            "improvementPct": (baseline - selected) / baseline * 100 if baseline else 0,
                            "passed": selected <= baseline})
    passed = all(c["passed"] for c in comparisons)
    return {"status": "needs_prospective_validation" if passed else "research_only", "passedBaselineChecks": passed,
            "approvedForTrading": False, "comparisons": comparisons,
            "summary": "仍须未来样本验证，未批准用于实际交易。" if passed else "未通过留出集基线检查；仅供研究。模型选择仍冻结，不用已看过的测试窗更换赢家。",
            "intervalNote": "标称 80% 区间的实际测试覆盖率仅为 DA {:.2f}%、价差 {:.2f}%；不能把它表述为已保证的 80% 置信度。".format(
                report["holdout"]["intervals"]["daCoverage80"] * 100, report["holdout"]["intervals"]["spreadCoverage80"] * 100)}


def run(input_path: Path, output_dir: Path, forecast_date: str | None = None) -> dict[str, Any]:
    raw = input_path.read_bytes()
    input_sha = hashlib.sha256(raw).hexdigest()
    archive = json.loads(raw)
    history = MarketHistory(archive)
    required = {"2026-09-03", "2026-10-28"}
    if not required.issubset(history.dates):
        raise ValueError("This frozen study requires the declared Sep3–Oct28 archive; change the protocol explicitly for a different date range")
    now_start = datetime.now(UTC)
    target_day = forecast_date or future_date(now_start, history.dates[-1])
    if target_day <= history.dates[-1]:
        raise ValueError("Forward target must follow the last archived actual date")
    if parse_utc(decision_cutoff(target_day)) <= now_start:
        raise ValueError("Forward decision cutoff already passed; choose a later target, never backdate issuedAt")
    require_fresh_history(history, target_day)
    # Cache all causal feature rows. Only >=7 days of lag history is required;
    # longer-lag missing features are imputed inside each daily training fit.
    training_rows = [r for r in history.rows if r["localDate"] >= shifted(history.dates[0], 7)]
    matrix = np.vstack([history.features(r) for r in training_rows])
    y_all = {"da": np.asarray([r["dam"] for r in training_rows]), "spread": np.asarray([r["spread"] for r in training_rows])}
    row_dates = np.asarray([r["localDate"] for r in training_rows])
    evaluation_dates = [d for d in history.dates if d >= "2026-09-17"]
    records: list[dict[str, Any]] = []
    fit_audit = []
    for index, day in enumerate(evaluation_dates):
        latest = shifted(day, -2)
        train_mask = row_dates <= latest
        train_n = int(np.sum(train_mask))
        rows = [r for r in history.rows if r["localDate"] == day]
        x_test = np.vstack([history.features(r) for r in rows])
        target_predictions: dict[str, dict[str, list[float]]] = {}
        for candidate in CANDIDATES:
            prediction = {}
            for target in ("da", "spread"):
                model = estimator(candidate)
                if model is None:
                    prediction[target] = [history.baseline(r, candidate["id"], target) for r in rows]
                else:
                    model.fit(matrix[train_mask], y_all[target][train_mask])
                    prediction[target] = model.predict(x_test).tolist()
            target_predictions[candidate["id"]] = prediction
        train_end = max(r["endUtc"] for r in training_rows if r["localDate"] <= latest)
        assert train_end <= decision_cutoff(day)
        for j, row in enumerate(rows):
            records.append({**{k: row[k] for k in ("node", "startUtc", "endUtc", "localDate", "localHour", "utcOffset")},
                            "actualDa": row["dam"], "actualFmm": row["fmm"], "actualSpread": row["spread"],
                            "decisionAsOfUtc": decision_cutoff(day), "trainingEndUtc": train_end,
                            "sampleCount": train_n, "split": split_for(day),
                            "predictions": {c["id"]: {t: target_predictions[c["id"]][t][j] for t in ("da", "spread")} for c in CANDIDATES}})
        fit_audit.append({"targetDate": day, "latestLabelDate": latest, "trainingEndUtc": train_end,
                          "trainingRows": train_n, "trainingDays": len(set(row_dates[train_mask])), "decisionAsOfUtc": decision_cutoff(day)})
        if index % 5 == 0 or index == len(evaluation_dates) - 1:
            print(f"Daily expanding fits {index+1}/{len(evaluation_dates)} · {day} · {train_n} training rows", flush=True)

    candidate_metrics = []
    for candidate in CANDIDATES:
        result = {k: candidate[k] for k in ("id", "label", "family", "params")}
        for phase in ("validation", "calibration", "holdout"):
            selected = [r for r in records if r["split"] == phase]
            result[phase] = {
                "da": metric([r["actualDa"] for r in selected], [r["predictions"][candidate["id"]]["da"] for r in selected]),
                "spread": metric([r["actualSpread"] for r in selected], [r["predictions"][candidate["id"]]["spread"] for r in selected], spread=True),
            }
        candidate_metrics.append(result)
    # The selection function has access exclusively to validation metrics.
    selected_models = {t: choose_candidate(candidate_metrics, t) for t in ("da", "spread")}
    chosen_ids = {t: c["id"] for t, c in selected_models.items()}
    version_payload = {"pipeline": PIPELINE_VERSION, "source": input_sha, "selected": chosen_ids, "splits": SPLITS, "seed": SEED,
                       "features": history.feature_names, "candidates": CANDIDATES}
    model_version = PIPELINE_VERSION + "+" + digest(version_payload)[:12]
    print("Validation-only selection: " + json.dumps(chosen_ids), flush=True)

    # Final fit uses all complete available labels that satisfy the new cutoff.
    latest = shifted(target_day, -2)
    final_mask = row_dates <= latest
    future_rows = hours_for_day(target_day, history.nodes)
    future_x = np.vstack([history.features(r) for r in future_rows])
    future_predictions, final_models = {}, {}
    for target in ("da", "spread"):
        candidate = BY_ID[chosen_ids[target]]
        model = estimator(candidate)
        if model is None:
            future_predictions[target] = [history.baseline(r, candidate["id"], target) for r in future_rows]
        else:
            model.fit(matrix[final_mask], y_all[target][final_mask])
            future_predictions[target] = model.predict(future_x).tolist()
        final_models[target] = export_fitted(model, candidate, history.feature_names)
    training_end = max(r["endUtc"] for r in training_rows if r["localDate"] <= latest)
    generated_at = iso(datetime.now(UTC))
    if parse_utc(generated_at) >= parse_utc(decision_cutoff(target_day)):
        raise ValueError("Run crossed the forward cutoff; rerun for the next eligible day. Output not written.")

    def enrich(row: dict[str, Any], *, forward: bool = False, position: int = 0) -> dict[str, Any]:
        day = row["localDate"]
        fixed_calibration = day >= SPLITS["holdout"]["startDate"]
        calibrations = {t: residual_calibration(records, row["node"], t, chosen_ids[t], day, fixed_calibration=fixed_calibration) for t in ("da", "spread")}
        da = future_predictions["da"][position] if forward else row["predictions"][chosen_ids["da"]]["da"]
        spread = future_predictions["spread"][position] if forward else row["predictions"][chosen_ids["spread"]]["spread"]
        da_cal, spread_cal = calibrations["da"], calibrations["spread"]
        return {**{k: row[k] for k in ("node", "startUtc", "endUtc", "localDate", "localHour", "utcOffset")},
                "predictedDa": da, "predictedSpread": spread, "predictedFmm": da + spread, "sigma": spread_cal["sigma"],
                "issuedAt": generated_at, "decisionAsOfUtc": decision_cutoff(day), "modelVersion": model_version,
                "trainingEndUtc": training_end if forward else row["trainingEndUtc"],
                "sampleCount": int(np.sum(final_mask)) if forward else row["sampleCount"],
                "calibrationCount": spread_cal["n"],
                "daLow80": da + da_cal["lower"] if da_cal["lower"] is not None else None,
                "daHigh80": da + da_cal["upper"] if da_cal["upper"] is not None else None,
                "spreadLow80": spread + spread_cal["lower"] if spread_cal["lower"] is not None else None,
                "spreadHigh80": spread + spread_cal["upper"] if spread_cal["upper"] is not None else None,
                "actualDa": None if forward else row["actualDa"], "actualFmm": None if forward else row["actualFmm"],
                "actualSpread": None if forward else row["actualSpread"],
                "split": "forward" if forward else row["split"],
                "selectionEligibleAtAsOf": day >= SELECTION_AVAILABLE_FROM,
                "selectionAvailableForTargetFrom": SELECTION_AVAILABLE_FROM,
                "classification": "forward_forecast" if forward else "historical_reconstruction"}

    enriched = [enrich(r) for r in records]
    holdout_points = [r for r in enriched if r["split"] == "holdout"]
    forward_points = [enrich(row, forward=True, position=i) for i, row in enumerate(future_rows)]
    # Important: candidate results in calibration or holdout are descriptive only.
    # Nothing below changes chosen_ids, hyperparameters, or the calibration set.
    held = [r for r in records if r["split"] == "holdout"]
    selected_holdout = {t: selected_models[t]["holdout"][t] for t in ("da", "spread")}
    metric_by_id = {c["id"]: c for c in candidate_metrics}
    baseline_ids = {"da": "mean_14d", "spread": "zero_spread"}
    selected_summary = {}
    for target in ("da", "spread"):
        selected = selected_models[target]
        base = metric_by_id[baseline_ids[target]]["validation"][target]["mae"]
        chosen = selected["validation"][target]["mae"]
        selected_summary[target] = {"id": selected["id"], "label": selected["label"], "validationMae": chosen,
                                    "baselineMae": base, "improvementPct": (base - chosen) / base * 100 if base else 0}
    interval_metrics = {
        "daCoverage80": float(np.mean([p["daLow80"] <= p["actualDa"] <= p["daHigh80"] for p in holdout_points])),
        "spreadCoverage80": float(np.mean([p["spreadLow80"] <= p["actualSpread"] <= p["spreadHigh80"] for p in holdout_points])),
        "daMeanWidth80": float(np.mean([p["daHigh80"] - p["daLow80"] for p in holdout_points])),
        "spreadMeanWidth80": float(np.mean([p["spreadHigh80"] - p["spreadLow80"] for p in holdout_points])),
        "calibrationDays": SPLITS["calibration"]["days"],
    }
    daily = []
    for day in sorted({r["localDate"] for r in held}):
        values = [r for r in held if r["localDate"] == day]
        dm = metric([r["actualDa"] for r in values], [r["predictions"][chosen_ids["da"]]["da"] for r in values])
        sm = metric([r["actualSpread"] for r in values], [r["predictions"][chosen_ids["spread"]]["spread"] for r in values], spread=True)
        daily.append({"date": day, "daMae": dm["mae"], "spreadMae": sm["mae"], "signAccuracy": sm["signAccuracy"]})
    by_node = []
    for node in history.nodes:
        values = [r for r in held if r["node"] == node]
        by_node.append({"node": node,
                        "da": metric([r["actualDa"] for r in values], [r["predictions"][chosen_ids["da"]]["da"] for r in values]),
                        "spread": metric([r["actualSpread"] for r in values], [r["predictions"][chosen_ids["spread"]]["spread"] for r in values], spread=True)})
    warnings = [
        "历史预测在本次运行中重建，issuedAt 是本次实际生成时间；decisionAsOfUtc 仅为回放截点，不能证明预测当时已存在。",
        "56 天、3 个高度相关枢纽不足以覆盖年度季节、极端事件和长期市场变化；4,032 行并非 4,032 个独立日样本。",
        "OASIS 历史价格可能修订；归档未提供原始发布时刻，采用 D−2 完整日规则仍不能消除事后修订风险。",
        "测试窗只用于最终报告；观察到测试结果后继续调参，需要新的未来留出期。该研究不声称已证实稳定交易收益。",
        "sigma 是单节点独立校准期的预测残差标准差；80% 区间是经验残差 10%/90% 分位，并非分布无关或已保证覆盖率。",
        "负荷、风光与 Outlook 当前只有 2 日快照且缺少历史发布批次；未作为这次价格模型的训练输入。",
        "本次离线训练与发布不会自动定时运行；新增历史与前瞻验证后应重跑并保留版本。",
        "完整滚动文件中 Oct8 以前的已选模型记录用于参数选择与诊断；当时尚未完成模型选择，不能将其作为冻结模型后的样本外业绩。",
    ]
    report = {
        "schemaVersion": 1, "experimentId": "forecast-study-" + digest(version_payload)[:16], "modelVersion": model_version,
        "generatedAt": generated_at, "classification": "historical_reconstruction_and_forward_forecast",
        "sample": {"startDate": history.dates[0], "endDate": history.dates[-1], "days": len(history.dates),
                   "rows": len(history.rows), "nodes": history.nodes, "inputSha256": input_sha,
                   "archiveDigest": archive.get("digest"), "excludedRows": history.excluded,
                   "negativeDaRows": sum(r["dam"] < 0 for r in history.rows), "sourceFetchedAt": archive.get("fetchedAt")},
        "splits": SPLITS, "selectedModels": selected_summary, "candidates": candidate_metrics,
        "holdout": {"selected": selected_holdout,
                    "baseline": {t: metric_by_id[baseline_ids[t]]["holdout"][t] for t in ("da", "spread")},
                    "daily": daily, "byNode": by_node, "intervals": interval_metrics,
                    "constantIncDirectionAccuracy": float(np.mean([r["actualSpread"] < 0 for r in held])),
                    "constantDecDirectionAccuracy": float(np.mean([r["actualSpread"] > 0 for r in held]))},
        "forecast": {"targetDate": target_day, "issuedAt": generated_at, "decisionAsOfUtc": decision_cutoff(target_day),
                     "trainingThrough": max(r["localDate"] for r in training_rows if r["localDate"] <= latest),
                     "trainingEndUtc": training_end, "rows": len(forward_points), "status": "before_cutoff",
                     "url": "/data/forecast-lab/forecast-forward.json"},
        "method": {"selectionRule": "DA 与价差分别最小化验证期 MAE；距最优 MAE 1% 内按预先固定复杂度顺序选择较简单模型。测试指标不参与选择。",
                   "featureDelayDays": 2, "seed": SEED, "featureNames": history.feature_names,
                   "calibration": "每枢纽使用 2026-10-08 至 2026-10-13 的真实滚动样本外残差，固定到测试及本次前瞻预测；sigma 为样本标准差，区间用 10%/90% 经验分位。",
                   "training": "每天扩展窗口重新拟合；目标日 D 仅使用 PT 日期 <=D−2 的完整价格标签和特征；缺失值中位数及 Ridge 标准化只拟合当日训练集。最早训练特征日 Sep10，最早滚动预测日 Sep17。",
                   "parameterOptimization": "预先声明 9 个候选配置，含 7/14/28 日窗口、Ridge α=10/100 与两类受限复杂度树模型；不在留出集搜索。",
                   "sampleCountMeaning": "每条预测 sampleCount 是该日候选模型共同可用的监督训练小时行数；基线实际使用同节点同小时窗口。",
                   "selectionAvailableForTargetFrom": SELECTION_AVAILABLE_FROM,
                   "versions": {"python": platform.python_version(), "numpy": np.__version__, "scikitLearn": sklearn.__version__},
                   "fitAudit": fit_audit},
        "featureAudit": [
            {"source": "OASIS DAM + 完整四段 FMM", "status": "included", "reason": "56 日配对价格；滞后、同小时均值/波动、跨枢纽滞后及日历。真实零值与负值保留。"},
            {"source": "OASIS 负荷 / 风光预测", "status": "excluded", "reason": "本地仅 Oct28–29 快照，缺少覆盖训练窗且能证明决策前可用的发布批次。"},
            {"source": "Today’s Outlook", "status": "excluded", "reason": "仅两日快照、不同口径与小时内数据，无法支撑当前 56 日无前视训练。"},
            {"source": "GridStatus", "status": "excluded", "reason": "未配置 API Key；没有可用于本次实验的已获取数据。"},
            {"source": "RTD 5 分钟价格", "status": "excluded", "reason": "发布快照 7 日，本地去重归档共 8 日；与目标 56 日不齐，且本次策略结算研究目标是 FMM−DA。"},
        ],
        "warnings": warnings,
        "sources": [{"title": "scikit-learn · Lagged features for time series forecasting", "url": "https://scikit-learn.org/stable/auto_examples/applications/plot_time_series_lagged_features.html"},
                    {"title": "scikit-learn · Ridge", "url": "https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.Ridge.html"},
                    {"title": "scikit-learn · HistGradientBoostingRegressor", "url": "https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.HistGradientBoostingRegressor.html"}],
        "artifacts": {"forward": "/data/forecast-lab/forecast-forward.json", "history": "/data/forecast-lab/forecast-history.json",
                      "walkForward": "/data/forecast-lab/all-walk-forward.json", "csv": "/data/forecast-lab/predictions.csv",
                      "models": "/data/forecast-lab/models.json"},
    }
    report["promotionGate"] = promotion_gate(report)
    metadata = {"selectedModels": chosen_ids, "inputSha256": input_sha, "calibrationStart": SPLITS["calibration"]["startDate"],
                "calibrationEnd": SPLITS["calibration"]["endDate"], "featureDelayDays": 2, "pipelineVersion": PIPELINE_VERSION,
                "selectionAvailableForTargetFrom": SELECTION_AVAILABLE_FROM,
                "earlySelectedPointsAreTuningOnly": True}
    def bundle(points: list[dict[str, Any]], label: str, forward: bool) -> dict[str, Any]:
        return {"schemaVersion": 1, "id": "model-forecast-" + label + "-" + digest(points)[:16],
                "name": ("模型前瞻预测 · " + target_day) if forward else "模型历史重建 · " + label,
                "source": "CAISO 本地价格模型 · 仅 OASIS 归档训练", "modelVersion": model_version,
                "createdAt": generated_at, "generatedAt": generated_at, "digest": digest(points),
                "classification": "forward_forecast" if forward else "historical_reconstruction",
                "metadata": metadata, "points": points, "warnings": warnings}
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "report.json", report)
    write_json(output_dir / "forecast-forward.json", bundle(forward_points, "forward", True))
    write_json(output_dir / "forecast-history.json", bundle(holdout_points, "holdout", False))
    write_json(output_dir / "all-walk-forward.json", bundle(enriched, "walk-forward", False))
    write_json(output_dir / "candidate-predictions.json", {"modelVersion": model_version, "generatedAt": generated_at, "points": records})
    write_json(output_dir / "models.json", {"schemaVersion": 1, "modelVersion": model_version, "generatedAt": generated_at,
                                          "inputSha256": input_sha, "trainingEndUtc": training_end,
                                          "trainingRows": int(np.sum(final_mask)), "targets": final_models,
                                          "reproduceCommand": "python research/forecast_pipeline.py --forecast-date " + target_day,
                                          "protocol": version_payload})
    with (output_dir / "predictions.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(forward_points[0]))
        writer.writeheader()
        writer.writerows(holdout_points + forward_points)
    print(json.dumps({"output": str(output_dir), "selectedModels": chosen_ids, "holdout": selected_holdout,
                      "intervals": interval_metrics, "forecast": report["forecast"]}, ensure_ascii=False, indent=2), flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data/strategy-history.json")
    parser.add_argument("--output", type=Path, default=ROOT / "public/data/forecast-lab")
    parser.add_argument("--forecast-date", help="PT date; defaults to the earliest still-open next delivery day")
    args = parser.parse_args()
    run(args.input, args.output, args.forecast_date)


if __name__ == "__main__":
    main()
