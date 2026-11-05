#!/usr/bin/env python3
"""CAISO V4: a bounded, reproducible forecast using current free price data.

No network calls or missing-source dependency. A newly declared information lag
is applied identically to historical features, training labels and future input.
Previously examined historical periods remain developmental comparisons.
"""
from __future__ import annotations

import os
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')

import argparse
import csv
import gzip
import hashlib
import json
import math
import platform
import shutil
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import forecast_pipeline as fp
from build_strategy_input import build_input, simulation

ROOT = Path(__file__).resolve().parents[1]
VERSION = 'caiso-current-data-4.0.0'
CANDIDATES = [
    {'id': 'zero_spread', 'label': '零价差／DA 14 日均值', 'family': 'baseline', 'params': {}, 'complexity': 0},
    {'id': 'mean14', 'label': '同小时 14 日均值', 'family': 'baseline', 'params': {'windowDays': 14}, 'complexity': 1},
    {'id': 'median14', 'label': '同小时 14 日中位数', 'family': 'robust_location', 'params': {'windowDays': 14}, 'complexity': 2},
    {'id': 'shrink14', 'label': '14 日中位数／价差收缩 50%', 'family': 'shrinkage', 'params': {'windowDays': 14, 'spreadMultiplier': .5}, 'complexity': 3},
    {'id': 'seasonal7', 'label': '上周同小时', 'family': 'baseline', 'params': {'lagDays': 7}, 'complexity': 4},
    {'id': 'ridge56', 'label': 'Ridge · 56 日窗', 'family': 'ridge', 'params': {'windowDays': 56, 'alpha': 100}, 'complexity': 5},
    {'id': 'ridge_all', 'label': 'Ridge · 全部可用历史', 'family': 'ridge', 'params': {'windowDays': None, 'alpha': 100}, 'complexity': 6},
    {'id': 'hgb112', 'label': '浅层提升树 · 112 日窗', 'family': 'hist_gradient_boosting', 'params': {'windowDays': 112, 'max_iter': 60, 'max_leaf_nodes': 7, 'min_samples_leaf': 72, 'learning_rate': .05, 'l2_regularization': 20}, 'complexity': 7},
]
BY_ID = {c['id']: c for c in CANDIDATES}
BASELINES = {'da': 'mean14', 'spread': 'zero_spread'}
SAMPLE_COUNT_MEANING = 'sampleCount 是截点前可用训练标签总行数，不等于每个候选的拟合行数；滑动窗实际行数见 method.fitAudit.trainingRowsByCandidate，统计基线只使用指定同节点同小时窗口。'


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    os.replace(temporary, path)


def load_archive(path: Path) -> tuple[dict, str]:
    raw = path.read_bytes()
    payload = json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)
    if payload['rows'] and isinstance(payload['rows'][0], list):
        rows = [dict(zip(payload['fields'], row, strict=True)) for row in payload['rows']]
    else:
        rows = payload['rows']
    archive = {'schemaVersion': 1, 'id': 'v4-current-free-prices',
               'name': '当前可取得的 OASIS DA/FMM 小时价格',
               'nodes': sorted({r['node'] for r in rows}), 'rows': rows,
               'startDate': min(r['localDate'] for r in rows),
               'endDate': max(r['localDate'] for r in rows),
               'fetchedAt': payload.get('generatedAt'), 'sources': payload.get('sources', [])}
    archive['digest'] = fp.digest({'nodes': archive['nodes'], 'rows': rows})
    return archive, hashlib.sha256(raw).hexdigest()


class CurrentHistory(fp.MarketHistory):
    def __init__(self, archive: dict, information_delay_days: int = 2):
        if information_delay_days < 2:
            raise ValueError('At least two complete PT days of information delay are required')
        super().__init__(archive)
        self.delay = information_delay_days
        self.regime_dates = sorted({(r['localDate'], r.get('marketRegime', 'unspecified')) for r in self.rows})

    def same_hour(self, row, target, window):
        values = [self.value(fp.shifted(row['localDate'], -lag), row['node'], row['localHour'], target)
                  for lag in range(self.delay, self.delay + window)]
        return [v for v in values if math.isfinite(v)]

    def features(self, row):
        day, node, hour = row['localDate'], row['node'], row['localHour']
        d = date.fromisoformat(day)
        hour_number = int(hour[:2])
        features = {f'node_{n}': float(node == n) for n in self.nodes}
        features.update({f'hour_{h:02d}': float(h == hour_number) for h in range(24)})
        features.update({f'weekday_{w}': float(w == d.weekday()) for w in range(7)})
        # Pure calendar inputs. Regime marker comes from the supplied price
        # archive; it does not introduce any uncollected market forecast.
        features.update(annual_sin=math.sin(2 * math.pi * d.timetuple().tm_yday / 365.25),
                        annual_cos=math.cos(2 * math.pi * d.timetuple().tm_yday / 365.25),
                        weekend=float(d.weekday() >= 5))
        prior_regimes = [regime for regime_day, regime in self.regime_dates if regime_day <= day]
        regime = prior_regimes[-1] if prior_regimes else 'unspecified'
        features['post_dame_archive_marker'] = float(regime.startswith('post_'))
        lags = sorted({self.delay, self.delay + 1, max(7, self.delay), max(14, self.delay), max(28, self.delay)})
        for target in ('da', 'spread'):
            for lag in lags:
                features[f'{target}_lag{lag}'] = self.value(fp.shifted(day, -lag), node, hour, target)
            for window in (7, 14, 28):
                values = self.same_hour(row, target, window)
                features[f'{target}_mean{window}'] = float(np.mean(values)) if values else np.nan
                features[f'{target}_median{window}'] = float(np.median(values)) if values else np.nan
                features[f'{target}_std{window}'] = float(np.std(values, ddof=1)) if len(values) > 1 else np.nan
            prior = self.daily.get((fp.shifted(day, -self.delay), node), [])
            values = [r['dam' if target == 'da' else 'spread'] for r in prior]
            features[f'{target}_prior_day_mean'] = float(np.mean(values)) if values else np.nan
            features[f'{target}_prior_day_std'] = float(np.std(values, ddof=1)) if len(values) > 1 else np.nan
            for other in self.nodes:
                features[f'{target}_cross_hub_{other}'] = self.value(fp.shifted(day, -self.delay), other, hour, target)
        if not self.feature_names:
            self.feature_names = list(features)
        if list(features) != self.feature_names:
            raise ValueError('Feature order changed')
        return np.array(list(features.values()), dtype=float)

    def baseline_value(self, row, candidate, target):
        values = self.same_hour(row, target, 14)
        if not values:
            raise ValueError('No prior same-hour values')
        if candidate == 'zero_spread' and target == 'spread':
            return 0.
        if candidate == 'seasonal7':
            value = self.value(fp.shifted(row['localDate'], -max(7, self.delay)), row['node'], row['localHour'], target)
            if math.isfinite(value):
                return value
        if candidate in ('median14', 'shrink14'):
            return float(np.median(values)) * (.5 if candidate == 'shrink14' and target == 'spread' else 1.)
        return float(np.mean(values))


def complete_history(history: CurrentHistory) -> None:
    if history.excluded:
        raise ValueError('Incomplete DA/FMM labels in supplied archive')
    count = (date.fromisoformat(history.dates[-1]) - date.fromisoformat(history.dates[0])).days + 1
    if count != len(history.dates):
        raise ValueError('Price archive has missing dates')
    for day in history.dates:
        expected = {(r['node'], r['startUtc']) for r in fp.hours_for_day(day, history.nodes)}
        observed = {(r['node'], r['startUtc']) for r in history.rows if r['localDate'] == day}
        if expected != observed:
            raise ValueError('Incomplete hub/hour coverage: ' + day)


def chronological_splits(end: str, delay: int) -> dict:
    holdout = {'startDate': fp.shifted(end, -27), 'endDate': end, 'days': 28}
    calibration_end = fp.shifted(holdout['startDate'], -delay)
    calibration = {'startDate': fp.shifted(calibration_end, -27), 'endDate': calibration_end, 'days': 28}
    validation_end = fp.shifted(calibration['startDate'], -delay)
    validation = {'startDate': fp.shifted(validation_end, -41), 'endDate': validation_end, 'days': 42}
    purges = [fp.shifted(validation_end, i) for i in range(1, delay)]
    purges += [fp.shifted(calibration_end, i) for i in range(1, delay)]
    return {'validation': validation, 'calibration': calibration, 'holdout': holdout, 'purgedDates': purges}


def phase(day, splits):
    return next((key for key in ('validation', 'calibration', 'holdout')
                 if splits[key]['startDate'] <= day <= splits[key]['endDate']), 'purge')


def estimator(candidate):
    if candidate['family'] not in ('ridge', 'hist_gradient_boosting'):
        return None
    params = {k: v for k, v in candidate['params'].items() if k != 'windowDays'}
    if candidate['family'] == 'ridge':
        return Pipeline([('impute', SimpleImputer(strategy='median', keep_empty_features=True)),
                         ('scale', StandardScaler()), ('model', Ridge(**params))])
    return Pipeline([('impute', SimpleImputer(strategy='median', keep_empty_features=True)),
                     ('model', HistGradientBoostingRegressor(**params, early_stopping=False, random_state=42))])


def select_candidate(validation_metrics, target):
    best = min(row['validation'][target]['mae'] for row in validation_metrics)
    eligible = [row for row in validation_metrics if row['validation'][target]['mae'] <= best * 1.01 + 1e-12]
    return min(eligible, key=lambda row: BY_ID[row['id']]['complexity'])['id']


def metrics(records, candidate=None):
    result = {}
    for target, actual, predicted in [('da', 'actualDa', 'predictedDa'), ('spread', 'actualSpread', 'predictedSpread')]:
        values = [r['predictions'][candidate][target] if candidate else r[predicted] for r in records]
        result[target] = fp.metric([r[actual] for r in records], values, spread=target == 'spread')
    return result


def calibrate(records, node, hour, target, candidate):
    bucket = int(hour[:2]) // 6
    eligible = [r for r in records if r['node'] == node and int(r['localHour'][:2]) // 6 == bucket]
    level = 'hub_6hour_bucket'
    if len(eligible) < 48:
        eligible = [r for r in records if r['node'] == node]
        level = 'hub'
    if len(eligible) < 48:
        raise ValueError('Insufficient out-of-sample calibration residuals')
    actual = 'actualDa' if target == 'da' else 'actualSpread'
    residual = np.asarray([r[actual] - r['predictions'][candidate][target] for r in eligible])
    return {'sigma': float(np.std(residual, ddof=1)), 'lower': float(np.quantile(residual, .1)),
            'upper': float(np.quantile(residual, .9)), 'n': len(residual), 'level': level,
            'startDate': min(r['localDate'] for r in eligible), 'endDate': max(r['localDate'] for r in eligible)}


def run(input_path: Path, output: Path, forecast_date: str | None = None,
        information_delay_days: int | None = None, evaluation_only: bool = False) -> dict:
    archive, input_sha = load_archive(input_path)
    now = datetime.now(timezone.utc)
    target_day = forecast_date or fp.future_date(now, archive['endDate'])
    minimum_delay = max(2, (date.fromisoformat(target_day) - date.fromisoformat(archive['endDate'])).days)
    delay = information_delay_days if information_delay_days is not None else minimum_delay
    if delay < minimum_delay:
        raise ValueError('Declared delay requires a more recent complete day than the supplied archive')
    if not evaluation_only and fp.parse_utc(fp.decision_cutoff(target_day)) <= now:
        raise ValueError('Target research cutoff has passed; choose a future target or --evaluation-only')
    history = CurrentHistory(archive, delay)
    complete_history(history)
    required = fp.shifted(target_day, -delay)
    if required not in history.dates:
        raise ValueError('Declared-lag latest complete day is absent: ' + required)
    splits = chronological_splits(history.dates[-1], delay)
    if splits['validation']['startDate'] < fp.shifted(history.dates[0], 84):
        raise ValueError('Need at least 84 warmup days before the fixed comparison')
    output.mkdir(parents=True, exist_ok=True)
    design = {'version': VERSION, 'targetDate': target_day, 'inputSha256': input_sha,
              'candidates': CANDIDATES, 'informationDelayDays': delay, 'splits': splits,
              'classification': 'previously_seen_development_comparison',
              'selection': 'Separate DA/spread validation MAE; within 1% prefer lower declared complexity; evaluation metrics and strategy PnL never select models.',
              'calibration': 'Fixed 28-day chronological calibration for evaluation; latest 28 eligible daily-origin residual days for future, grouped by hub and six-hour bucket.',
              'strategy': {'strat': 'normal', 'k': .5, 'dailyMWh': 12, 'feePerMWh': 1,
                           'quoteOffset': 10, 'feesAreScenarioNotCompleteSettlement': True},
              'missingSources': 'Excluded from this version; no procurement, accounts or paid service dependency.'}
    protocol_path = output / 'protocol.json'
    if protocol_path.exists():
        protocol = json.loads(protocol_path.read_text())
        if protocol['design'] != design:
            raise ValueError('Frozen V4 protocol differs; use a new output directory for a changed experiment')
    else:
        protocol = {'schemaVersion': 4, 'frozenAt': fp.iso(now), 'designDigest': fp.digest(design), 'design': design}
        write_json(protocol_path, protocol)
    version = VERSION + '+' + protocol['designDigest'][:12]
    rows = [r for r in history.rows if r['localDate'] >= fp.shifted(history.dates[0], 28 + delay - 2)]
    matrix = np.vstack([history.features(r) for r in rows])
    row_dates = np.asarray([r['localDate'] for r in rows])
    labels = {'da': np.asarray([r['dam'] for r in rows]), 'spread': np.asarray([r['spread'] for r in rows])}
    eval_days = [day for day in history.dates if day >= splits['validation']['startDate']]
    records, fit_audit, final_states = [], [], {}
    all_days = eval_days + ([] if evaluation_only else [target_day])
    future_raw = []
    for day_index, day in enumerate(all_days):
        is_forward = day == target_day and not evaluation_only
        target_rows = fp.hours_for_day(day, history.nodes)
        x = np.vstack([history.features(r) for r in target_rows])
        latest = fp.shifted(day, -delay)
        common_mask = row_dates <= latest
        training_end = max(r['endUtc'] for r in rows if r['localDate'] <= latest)
        if training_end > fp.decision_cutoff(day):
            raise AssertionError('Training labels exceed research cutoff')
        predicted, fit_counts = {}, {}
        for candidate in CANDIDATES:
            identifier = candidate['id']
            predicted[identifier] = {}
            window = candidate['params'].get('windowDays')
            mask = common_mask & (row_dates >= fp.shifted(latest, -(window - 1))) if window and candidate['family'] in ('ridge', 'hist_gradient_boosting') else common_mask
            fit_counts[identifier] = int(mask.sum()) if candidate['family'] in ('ridge', 'hist_gradient_boosting') else None
            for target in ('da', 'spread'):
                model = estimator(candidate)
                if model is None:
                    predicted[identifier][target] = [history.baseline_value(r, identifier, target) for r in target_rows]
                else:
                    model.fit(matrix[mask], labels[target][mask])
                    predicted[identifier][target] = model.predict(x).tolist()
                    if is_forward:
                        final_states[f'{identifier}_{target}'] = fp.export_fitted(model, candidate, history.feature_names)
        targets = []
        for i, row in enumerate(target_rows):
            actual = history.by_key[(row['node'], row['startUtc'])] if not is_forward else None
            targets.append({**row, 'actualDa': actual['dam'] if actual else None,
                            'actualFmm': actual['fmm'] if actual else None, 'actualSpread': actual['spread'] if actual else None,
                            'predictions': {c['id']: {t: float(predicted[c['id']][t][i]) for t in ('da', 'spread')} for c in CANDIDATES},
                            'decisionAsOfUtc': fp.decision_cutoff(day), 'trainingEndUtc': training_end,
                            'latestLabelDate': latest, 'sampleCount': int(common_mask.sum()),
                            'split': 'forward' if is_forward else phase(day, splits)})
        if is_forward:
            future_raw = targets
        else:
            records.extend(targets)
        fit_audit.append({'targetDate': day, 'latestLabelDate': latest, 'trainingEndUtc': training_end,
                          'trainingRowsByCandidate': fit_counts, 'decisionAsOfUtc': fp.decision_cutoff(day),
                          'informationDelayDays': delay})
        if day_index % 10 == 0 or is_forward:
            print(f'V4 daily-origin {day_index+1}/{len(all_days)} | {day} | D-{delay} | {int(common_mask.sum())} available labels', flush=True)

    candidate_metrics = []
    for candidate in CANDIDATES:
        result = {k: candidate[k] for k in ('id', 'label', 'family', 'params')}
        for stage in ('validation', 'calibration', 'holdout'):
            result[stage] = metrics([r for r in records if r['split'] == stage], candidate['id'])
        candidate_metrics.append(result)
    chosen = {t: select_candidate(candidate_metrics, t) for t in ('da', 'spread')}
    print('V4 validation-only selection: ' + json.dumps(chosen), flush=True)
    generated = fp.iso(datetime.now(timezone.utc))
    if not evaluation_only and fp.parse_utc(generated) >= fp.parse_utc(fp.decision_cutoff(target_day)):
        raise ValueError('Run crossed forward cutoff; no forward result was published')
    fixed_calibration = [r for r in records if r['split'] == 'calibration']
    forward_calibration_end = fp.shifted(target_day, -delay)
    forward_calibration = [r for r in records if fp.shifted(forward_calibration_end, -27) <= r['localDate'] <= forward_calibration_end]

    def enrich(row, forward=False):
        da = row['predictions'][chosen['da']]['da']
        spread = row['predictions'][chosen['spread']]['spread']
        cal_rows = forward_calibration if forward else fixed_calibration
        cal = {t: calibrate(cal_rows, row['node'], row['localHour'], t, chosen[t]) for t in ('da', 'spread')}
        if max(r['localDate'] for r in cal_rows) > fp.shifted(row['localDate'], -delay):
            raise ValueError('Calibration outcome exceeds declared information delay')
        point = {k: v for k, v in row.items() if k != 'predictions'}
        point.update(predictedDa=da, predictedSpread=spread, predictedFmm=da+spread,
                     sigma=cal['spread']['sigma'], calibrationCount=cal['spread']['n'],
                     calibrationStartDate=cal['spread']['startDate'], calibrationEndDate=cal['spread']['endDate'],
                     calibrationLevel=cal['spread']['level'], issuedAt=generated, modelVersion=version,
                     selectionEligibleAtAsOf=True,
                     selectionAvailableForTargetFrom=splits['calibration']['startDate'],
                     informationDelayDays=delay,
                     classification='forward_forecast' if forward else 'historical_reconstruction')
        for t, center in [('da', da), ('spread', spread)]:
            point[t+'Low80'] = float(center + cal[t]['lower'])
            point[t+'High80'] = float(center + cal[t]['upper'])
        return point

    evaluated = [enrich(r) for r in records if r['split'] == 'holdout']
    future = [enrich(r, True) for r in future_raw]
    selected_metrics = metrics(evaluated)
    eval_raw = [r for r in records if r['split'] == 'holdout']
    baseline_metrics = {t: metrics(eval_raw, BASELINES[t])[t] for t in ('da', 'spread')}
    metrics_by_id = {r['id']: r for r in candidate_metrics}
    selections = {}
    for target in ('da', 'spread'):
        validation_mae = metrics_by_id[chosen[target]]['validation'][target]['mae']
        base_mae = metrics_by_id[BASELINES[target]]['validation'][target]['mae']
        selections[target] = {'id': chosen[target], 'label': BY_ID[chosen[target]]['label'],
                              'validationMae': validation_mae, 'baselineMae': base_mae,
                              'improvementPct': 100 * (base_mae - validation_mae) / base_mae if base_mae else 0}

    def bundle(points, label):
        payload = {'schemaVersion': 4, 'modelVersion': version, 'generatedAt': generated,
                   'classification': 'forward_forecast' if label == 'forward' else 'historical_reconstruction',
                   'name': f'V4 当前数据预测 · {target_day}' if label == 'forward' else 'V4 已见历史开发评估',
                   'source': 'OASIS 当前免费价格档案；V4 固定候选逐日前推',
                   'informationDelayDays': delay, 'points': points}
        payload['digest'] = fp.digest(payload)
        payload['id'] = 'v4-' + label + '-' + payload['digest'][:16]
        return payload

    forward_bundle = bundle(future, 'forward')
    history_bundle = bundle(evaluated, 'development')
    all_bundle = bundle(records, 'candidate-diagnostics')
    all_bundle['classification'] = 'candidate_diagnostics_not_strategy_input'
    all_bundle['digest'] = fp.digest({k: v for k, v in all_bundle.items() if k not in ('digest', 'id')})
    all_bundle['id'] = 'v4-diagnostics-' + all_bundle['digest'][:16]

    historical_input = build_input(history_bundle, archive, reconstructed=True)
    historical_input['meta'].update(informationDelayDays=delay, evaluationClass='previously_seen_development',
                                    actualsThrough=archive['endDate'], defaultFeePerMWh=1)
    historical_sim = simulation(historical_input, 1.)
    historical_zero = simulation(historical_input, 0.)
    forward_input, forward_sim = None, None
    if future:
        forward_input = build_input(forward_bundle, archive)
        forward_input['meta'].update(informationDelayDays=delay, actualsThrough=archive['endDate'],
                                     defaultFeePerMWh=1, excludedSourcesDoNotBlock=True)
        for records_by_node in forward_input['forecastProvenance'].values():
            for provenance in records_by_node:
                if provenance:
                    provenance.update(informationDelayDays=delay, inputThrough=required)
        forward_sim = simulation(forward_input, 1.)

    def compact_sim(result):
        return {key: result['backtest'][key] for key in ('total', 'maxdd', 'ndays', 'evaluatedDays', 'incompleteDays', 'noSignalDays', 'winRate', 'perMWh', 'filled', 'totalTrades', 'totGross', 'fees')}

    simulation_summary = {'schemaVersion': 4, 'engineVersion': historical_sim['engineVersion'],
                          'generatedAt': historical_sim['generatedAt'], 'forecastDate': target_day,
                          'forecastDigest': forward_bundle['digest'], 'historyDigest': history_bundle['digest'],
                          'classification': '研究模拟；固定 $1/MWh 费用情景，非完整结算净收益',
                          'developmentClass': 'previously_seen_development', 'defaultFeePerMWh': 1,
                          'config': (forward_sim or historical_sim)['config'],
                          'forward': {k: forward_sim['day'][k] for k in ('date', 'status', 'pnl', 'expected', 'gross', 'unallocatedMWh', 'forecastHours', 'expectedHours')} if forward_sim else None,
                          'forwardStatus': 'ready' if future else 'evaluation_only',
                          'holdout': compact_sim(historical_sim),
                          'grossScenario': compact_sim(historical_zero),
                          'feeSensitivity1PerMWh': {k: historical_sim['backtest'][k] for k in ('total', 'maxdd', 'filled', 'fees')},
                          'days': [{k: day[k] for k in ('date', 'status', 'pnl', 'gross', 'filled', 'fees')} for day in historical_sim['backtest']['days']],
                          'warnings': ['费用固定为每模拟成交 MWh 1 美元，仅用于统一比较；未计入的市场结算项不视为零。',
                                       '计划由预测、固定门槛与预算生成；未来真实成交和收益均未知。',
                                       '按报价与真实 DA 交叉推算历史成交；三个研究枢纽输入不等于已验证的可执行订单。']}
    daily = []
    for day in sorted({p['localDate'] for p in evaluated}):
        m = metrics([p for p in evaluated if p['localDate'] == day])
        daily.append({'date': day, 'daMae': m['da']['mae'], 'spreadMae': m['spread']['mae'], 'signAccuracy': m['spread']['signAccuracy']})
    interval_metrics = {'calibrationDays': 28}
    for target, actual in [('da', 'actualDa'), ('spread', 'actualSpread')]:
        interval_metrics[target+'Coverage80'] = float(np.mean([p[target+'Low80'] <= p[actual] <= p[target+'High80'] for p in evaluated]))
        interval_metrics[target+'MeanWidth80'] = float(np.mean([p[target+'High80'] - p[target+'Low80'] for p in evaluated]))
    warnings = ['本轮只使用已取得的完整 DA/FMM 价格与日历；天气、预测历史版本、FRP 和账户数据不作为本版本前置条件。',
                f'特征及训练标签统一截止 D−{delay}；历史为今天从当前价格档案重建，不能证明当时原始发行版本。',
                '最后28天中包含已在先前实验查看过的历史，属于开发评估，不能称全新独立留出。',
                '区间为逐日前推残差的经验10%／90%分位数；实际覆盖率另行报告，不代表获利概率。',
                '未来实际价格与实际收益保持为空；固定费用情景不等于完整市场结算。']
    report = {'schemaVersion': 4, 'experimentId': 'current-data-'+protocol['designDigest'][:16],
              'modelVersion': version, 'generatedAt': generated,
              'classification': 'developmental_reconstruction_and_forward_forecast',
              'evaluationLabel': '已见历史开发评估',
              'sample': {'startDate': history.dates[0], 'endDate': history.dates[-1], 'days': len(history.dates),
                         'rows': len(history.rows), 'nodes': history.nodes, 'inputSha256': input_sha,
                         'archiveDigest': archive['digest'], 'sourceFetchedAt': archive.get('fetchedAt'), 'excludedRows': history.excluded},
              'splits': splits, 'selectedModels': selections, 'candidates': candidate_metrics,
              'holdout': {'classification': 'previously_seen_development_comparison', 'selected': selected_metrics,
                          'baseline': baseline_metrics, 'daily': daily,
                          'byNode': [{'node': node, **metrics([p for p in evaluated if p['node'] == node])} for node in history.nodes],
                          'intervals': interval_metrics,
                          'fmm': fp.metric([p['actualFmm'] for p in evaluated], [p['predictedFmm'] for p in evaluated])},
              'forecast': {'targetDate': target_day, 'issuedAt': generated if future else None,
                           'decisionAsOfUtc': fp.decision_cutoff(target_day), 'trainingThrough': required,
                           'trainingEndUtc': future[0]['trainingEndUtc'] if future else None,
                           'rows': len(future), 'status': 'before_cutoff' if future else 'evaluation_only',
                           'reason': None, 'url': '/data/forecast-lab/v4/forecast-forward.json'},
              'method': {'selectionRule': '仅比较42日验证期的MAE；距最小误差1%以内优先简单候选，DA与价差分别选型，不按最终评估或模拟收益换模型。',
                         'featureDelayDays': delay, 'seed': 42, 'featureNames': history.feature_names,
                         'calibration': '开发评估使用独立28日校准期；未来使用最近28个已知日的样本外残差，按枢纽与6小时段估计区间。',
                         'training': '8个固定候选，逐日截断重训；Ridge56、全历史Ridge和112日浅层提升树的预处理仅在各自训练窗拟合。',
                         'sampleCountMeaning': SAMPLE_COUNT_MEANING,
                         'fitAudit': fit_audit, 'protocolDigest': protocol['designDigest'],
                         'protocolFrozenAt': protocol['frozenAt']},
              'executionScope': {'mode': 'current_free_data', 'procurementRequired': False,
                                 'blockingMissingSources': [], 'included': ['完整 DAM/FMM 小时价格', '滞后价格与价差统计', '枢纽与日历'],
                                 'excluded': ['未证明历史发行时点的官方预测', '天气历史面板', 'FRP结算补项', '私有账户与完整拓扑'],
                                 'currentDataThrough': archive['endDate'], 'informationDelayDays': delay},
              'featureAudit': [{'source': 'OASIS DAM/FMM价格', 'status': 'included', 'reason': f'{len(history.dates)}个完整PT日、{len(history.rows):,}节点小时；每小时FMM由完整四段构成。'},
                               {'source': '价格与价差历史统计、日历', 'status': 'included', 'reason': f'D−{delay}起滞后值、滚动统计、跨枢纽、星期/小时/年周期；无目标日实际值。'},
                               {'source': '天气／官方预测／FRP／账户等', 'status': 'out_of_scope', 'reason': '本版本不依赖这些来源；不采购、不等待、不用虚构值填充。'}],
              'warnings': warnings,
              'sources': [{'title': 'CAISO OASIS', 'url': 'https://oasis.caiso.com/mrioasis/logon.do'},
                          {'title': 'scikit-learn 时间序列滞后特征示例', 'url': 'https://scikit-learn.org/stable/auto_examples/applications/plot_time_series_lagged_features.html'}],
              'artifacts': {k: '/data/forecast-lab/v4/'+name for k, name in {'forward': 'forecast-forward.json', 'history': 'forecast-history.json', 'walkForward': 'all-walk-forward.json', 'csv': 'predictions.csv', 'models': 'models.json'}.items()},
              'promotionGate': {'status': 'research_only', 'approvedForTrading': False,
                                'passedBaselineChecks': all(selected_metrics[t]['mae'] <= baseline_metrics[t]['mae'] for t in ('da', 'spread'))}}
    data_audit = {'schemaVersion': 4, 'generatedAt': generated, 'inputSha256': input_sha,
                  'archiveDigest': archive['digest'], 'completeDays': len(history.dates), 'rows': len(history.rows),
                  'startDate': history.dates[0], 'endDate': history.dates[-1], 'informationDelayDays': delay,
                  'excludedRows': history.excluded, 'duplicateNodeHours': 0,
                  'forwardPoints': len(future), 'forwardActualsNull': all(p[k] is None for p in future for k in ('actualDa', 'actualFmm', 'actualSpread')),
                  'allTrainingEndsBeforeCutoff': all(a['trainingEndUtc'] <= a['decisionAsOfUtc'] for a in fit_audit),
                  'splits': splits, 'sources': archive['sources'],
                  'environment': {'python': platform.python_version(), 'numpy': np.__version__, 'sklearn': sklearn.__version__}}
    outputs = {'report.json': report, 'forecast-forward.json': forward_bundle, 'forecast-history.json': history_bundle,
               'all-walk-forward.json': all_bundle, 'data-audit.json': data_audit,
               'models.json': {'modelVersion': version, 'selected': chosen, 'features': history.feature_names,
                               'states': final_states, 'protocolDigest': protocol['designDigest']},
               'holdout-input.json': historical_input, 'holdout-simulation.json': historical_sim,
               'holdout-zero-fee-simulation.json': historical_zero,
               'holdout-fee-1-sensitivity.json': historical_sim, 'simulation-summary.json': simulation_summary}
    if forward_input:
        outputs.update({'embedded-data.json': forward_input, 'forward-plan.json': forward_sim})
    for name, payload in outputs.items():
        write_json(output / name, payload)
    if input_path.resolve() != (output / 'input-price-history.json.gz').resolve():
        if input_path.suffix == '.gz':
            shutil.copyfile(input_path, output / 'input-price-history.json.gz')
        else:
            (output / 'input-price-history.json.gz').write_bytes(gzip.compress(input_path.read_bytes(), mtime=0))
    csv_fields = ['node', 'startUtc', 'endUtc', 'localDate', 'localHour', 'utcOffset', 'predictedDa', 'predictedFmm', 'predictedSpread', 'sigma', 'daLow80', 'daHigh80', 'spreadLow80', 'spreadHigh80', 'actualDa', 'actualFmm', 'actualSpread', 'issuedAt', 'decisionAsOfUtc', 'trainingEndUtc', 'informationDelayDays', 'modelVersion', 'classification']
    with (output / 'predictions.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=csv_fields, extrasaction='ignore')
        writer.writeheader(); writer.writerows(evaluated + future)
    with (output / 'forward-predictions.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=csv_fields, extrasaction='ignore')
        writer.writeheader(); writer.writerows(future)
    shutil.copyfile(ROOT / 'research/trading_strategy.py', output / 'trading_strategy.py')
    print(json.dumps({'modelVersion': version, 'targetDate': target_day, 'rows': len(future), 'delayDays': delay,
                      'selected': chosen, 'evaluation': selected_metrics, 'baseline': baseline_metrics,
                      'forwardPlannedMWh': forward_sim['day']['gross'] if forward_sim else None,
                      'simulationFee1Pnl': historical_sim['backtest']['total']}, ensure_ascii=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    available_inputs = [ROOT / 'public/data/current-inputs/price-history-current.json.gz',
                        ROOT / 'public/data/forecast-lab/v4/input-price-history.json.gz',
                        ROOT / 'public/data/data-gaps/price-history-365d.json.gz']
    default_input = next((path for path in available_inputs if path.exists()), available_inputs[1])
    parser.add_argument('--input', type=Path, default=default_input)
    parser.add_argument('--output', type=Path, default=ROOT / 'public/data/forecast-lab/v4')
    parser.add_argument('--forecast-date')
    parser.add_argument('--information-delay-days', type=int)
    parser.add_argument('--evaluation-only', action='store_true')
    args = parser.parse_args()
    run(args.input, args.output, args.forecast_date, args.information_delay_days, args.evaluation_only)


if __name__ == '__main__':
    main()
