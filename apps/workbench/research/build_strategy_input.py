#!/usr/bin/env python3
"""Convert trained-model outputs into the uploaded simulator's JSON contract.

The forward file is directly readable by the user's original trading_strategy.py.
The historical file is for the maintained runner: it explicitly denotes research
reconstruction and retains real generatedAt separately from decisionAsOfUtc.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from trading_strategy import STRATEGIES, StrategyEngine, VERSION, decision_as_of, finite, hours_for_date, iso, parse_time

ROOT = Path(__file__).resolve().parents[1]


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def build_input(bundle: dict, archive: dict, reconstructed: bool = False) -> dict:
    points = bundle["points"]
    if not points:
        raise ValueError("预测批次没有数据")
    dates = sorted({parse_time(point["startUtc"]).astimezone(ZoneInfo("America/Los_Angeles")).date().isoformat() for point in points})
    hours = [hour for day in dates for hour in hours_for_date(day)]
    nodes = sorted({point["node"] for point in points})
    point_index = {}
    for point in points:
        if point.get("selectionEligibleAtAsOf") is False:
            raise ValueError("该历史预测早于模型选型可用时间，仅可用于调参诊断，不能进入本策略检验输入")
        key = point["node"], parse_time(point["startUtc"])
        if key in point_index:
            raise ValueError("预测节点/UTC 小时重复")
        for field in ("predictedDa", "predictedSpread"):
            if not finite(point.get(field)):
                raise ValueError(f"预测 {field} 缺失或非法")
        if point.get("sigma") is not None and (not finite(point["sigma"]) or point["sigma"] < 0):
            raise ValueError("sigma 非法")
        point_index[key] = point
    actual_index = {}
    for row in archive["rows"]:
        key = row["node"], parse_time(row["startUtc"])
        if key in actual_index:
            raise ValueError("实际价格档案中节点/UTC 小时重复；需先完成去重或冲突处理")
        actual_index[key] = row
    series, provenance = {}, {}
    for node in nodes:
        series[node], provenance[node] = [], []
        for hour in hours:
            key = node, parse_time(hour["startUtc"])
            point = point_index.get(key)
            if point is None:
                series[node].append(None)
                provenance[node].append(None)
                continue
            actual = actual_index.get(key) if reconstructed else None
            dam = actual["dam"] if actual and finite(actual.get("dam")) else None
            fmm = actual["fmm"] if actual and actual.get("paired") and actual.get("fmmCount") == 4 and finite(actual.get("fmm")) else None
            series[node].append([hour["startUtc"], dam, fmm, point["predictedSpread"], point["predictedDa"], point.get("sigma"), point["modelVersion"]])
            provenance[node].append({"issuedAt": point["issuedAt"], "generatedAt": bundle["generatedAt"],
                                     "decisionAsOfUtc": point.get("decisionAsOfUtc", decision_as_of(hour["localDate"])),
                                     "trainingEndUtc": point["trainingEndUtc"], "modelVersion": point["modelVersion"],
                                     "sampleCount": point.get("sampleCount"), "calibrationCount": point.get("calibrationCount"),
                                     "selectionEligibleAtAsOf": point.get("selectionEligibleAtAsOf"),
                                     "selectionAvailableForTargetFrom": point.get("selectionAvailableForTargetFrom"),
                                     "reconstructed": reconstructed})
    data = {
        "meta": {"schemaVersion": 2, "classification": "historical_reconstruction" if reconstructed else "forward_forecast",
                 "dates": dates, "ndays": len(dates), "hist_end": archive["endDate"], "today": dates[-1],
                 "total_mwh": 12, "dp": 10, "generatedAt": bundle["generatedAt"],
                 "inputDigest": digest({"forecastDigest": bundle["digest"], "archiveDigest": archive["digest"]}),
                 "forecastDigest": bundle["digest"], "archiveDigest": archive["digest"],
                 "modelVersion": bundle["modelVersion"], "timeZone": "America/Los_Angeles",
                 "selectionMode": "manual", "selectedNodes": nodes,
                 "legacyNodeStatistics": "strat 中的 n/win/ev/pf=0 仅是旧 CLI 结构占位，表示未估计，不能解释为历史胜率或收益；维护版显式手选全部三个枢纽。",
                 "legacyCompatibility": "仅前向、正常 24 小时日可由原始脚本读取；历史重建与 DST 日使用随附维护版。",
                 "warnings": ["未来小时的实际 DA/FMM 保留 null；预期损益不是已实现收益。",
                              "sigma 是历史逐时样本外残差尺度，不是已保证覆盖率或胜率。",
                              "小时 FMM 是完整四个 15 分钟价格的简单平均；未建模全部结算项。",
                              "历史重建预测现在才生成，decisionAsOfUtc 仅表示算法的信息截点，issuedAt 保留实际生成时间。"]},
        "nodes": [{"k": node, "name": node.replace("TH_", "").replace("_GEN-APND", ""), "statsAvailable": False,
                   "strat": {strategy: {"n": 0, "win": 0, "ev": 0, "pf": 0} for strategy in STRATEGIES}} for node in nodes],
        "hours": hours, "series": series, "forecastProvenance": provenance,
    }
    # Constructing the maintained engine checks alignment, missing-value and time contracts.
    engine = StrategyEngine(data)
    if sum(engine._forecast_eligible(node, i) for node in nodes for i in range(len(hours))) != len(points):
        raise ValueError("至少一条预测未满足声明的信息截点或未来发布时间约束")
    return data


def simulation(data: dict, fee: float = 0.) -> dict:
    engine = StrategyEngine(data)
    engine.state["feePerMWh"] = fee
    cfg = engine.get_config()
    day = engine.sim_day(engine.state["di"], cfg)
    backtest = engine.sim_all(cfg)
    executed_at = iso(datetime.now(timezone.utc))
    return {"engineVersion": VERSION, "classification": data["meta"]["classification"],
            "generatedAt": executed_at, "executedAt": executed_at,
            "forecastGeneratedAt": data["meta"]["generatedAt"], "inputDigest": data["meta"]["inputDigest"],
            "config": cfg, "day": day, "backtest": backtest}


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forecast-directory", default=str(ROOT / "public/data/forecast-lab"))
    parser.add_argument("--prices", default=str(ROOT / "data/strategy-history.json"))
    parser.add_argument("--output-directory", default=str(ROOT / "research/output"))
    args = parser.parse_args()
    source, output = Path(args.forecast_directory), Path(args.output_directory)
    archive = json.loads(Path(args.prices).read_text())
    forward = build_input(json.loads((source / "forecast-forward.json").read_text()), archive)
    history = build_input(json.loads((source / "forecast-history.json").read_text()), archive, reconstructed=True)
    plan, backtest = simulation(forward), simulation(history)
    sensitivity = simulation(history, 1.)
    for name, payload in (("embedded-data.json", forward), ("holdout-input.json", history),
                          ("forward-plan.json", plan), ("holdout-simulation.json", backtest),
                          ("holdout-fee-1-sensitivity.json", sensitivity)):
        write_json(output / name, payload)
    # Browser downloads use the same generated bytes; no second calculation.
    for name in ("embedded-data.json", "holdout-input.json", "forward-plan.json", "holdout-simulation.json", "holdout-fee-1-sensitivity.json"):
        (source / name).write_bytes((output / name).read_bytes())
    base = backtest["backtest"]
    summary = {"schemaVersion": 1, "engineVersion": VERSION, "generatedAt": iso(datetime.now(timezone.utc)),
               "executedAt": max(result["executedAt"] for result in (plan, backtest, sensitivity)),
               "forecastGeneratedAt": forward["meta"]["generatedAt"],
               "classification": "研究模拟；未下单、未结算", "forecastDate": forward["meta"]["today"],
               "forecastDigest": forward["meta"]["forecastDigest"], "historyDigest": history["meta"]["forecastDigest"],
               "config": plan["config"], "forward": {key: plan["day"][key] for key in ("date", "status", "pnl", "expected", "gross", "unallocatedMWh", "forecastHours", "expectedHours")},
               "holdout": {key: base[key] for key in ("total", "maxdd", "ndays", "evaluatedDays", "incompleteDays", "noSignalDays", "winRate", "perMWh", "filled", "totalTrades", "totGross", "fees")},
               "feeSensitivity1PerMWh": {key: sensitivity["backtest"][key] for key in ("total", "maxdd", "filled", "fees")},
               "days": [{key: day[key] for key in ("date", "status", "pnl", "gross", "filled", "fees", "forecastHours", "expectedHours")} for day in base["days"]],
               "warnings": ["策略参数固定在检验集之前，不以检验集收益调参。", "零费用主口径另附固定 1 美元/MWh 费用敏感性；不代表完整市场成本。", "历史回测基于现在重建的预测，不是当时归档业绩。"]}
    write_json(source / "simulation-summary.json", summary)
    print(json.dumps({"output": str(output), "date": summary["forecastDate"], "plannedMWh": summary["forward"]["gross"],
                      "holdoutPnL": summary["holdout"]["total"], "fee1PnL": summary["feeSensitivity1PerMWh"]["total"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
