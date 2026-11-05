#!/usr/bin/env python3
"""Bridge v2 research forecasts to the existing simulator without changing v1.

The Oct15–28 comparison window is explicitly previously seen development data.
Three signal thresholds and two fee assumptions are frozen before this v2 run;
this script reports every scenario and does not select a profit-maximizing winner.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from build_strategy_input import build_input, digest
from trading_strategy import StrategyEngine, VERSION, iso

ROOT = Path(__file__).resolve().parents[1]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    os.replace(temporary, path)


def subset_bundle(bundle: dict, start: str, end: str) -> dict:
    result = deepcopy(bundle)
    result['points'] = [point for point in result['points'] if start <= point['localDate'] <= end]
    if not result['points']:
        raise ValueError('No forecasts in the declared development comparison window')
    result['parentDigest'] = bundle['digest']
    result['digest'] = digest({'parentDigest': bundle['digest'], 'startDate': start, 'endDate': end,
                               'points': result['points']})
    result['id'] = 'v2-development-' + result['digest'][:16]
    result['name'] = 'V2 已见开发窗口 · ' + start + ' 至 ' + end
    result['evaluationClass'] = 'previously_seen_development'
    return result


def calculate(data: dict, profile: dict, fee: float = 0.) -> dict:
    engine = StrategyEngine(data)
    engine.state.update(strat=profile['strat'], k=profile['k'], feePerMWh=fee)
    config = engine.get_config()
    day, backtest = engine.sim_day(engine.state['di'], config), engine.sim_all(config)
    executed_at = iso(datetime.now(timezone.utc))
    return {'engineVersion': VERSION, 'generatedAt': executed_at, 'executedAt': executed_at,
            'forecastGeneratedAt': data['meta']['generatedAt'], 'inputDigest': data['meta']['inputDigest'],
            'classification': data['meta']['classification'], 'config': config,
            'day': day, 'backtest': backtest}


def compact_metrics(result: dict) -> dict:
    return {key: result['backtest'][key] for key in ('total', 'maxdd', 'ndays', 'evaluatedDays',
             'incompleteDays', 'noSignalDays', 'winRate', 'perMWh', 'filled', 'totalTrades', 'totGross', 'fees')}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--forecast-directory', type=Path, default=ROOT/'public/data/forecast-lab/v2')
    parser.add_argument('--prices', type=Path, default=ROOT/'data/strategy-history-expanded.json')
    parser.add_argument('--output-directory', type=Path, default=ROOT/'research/output-v2')
    args = parser.parse_args()
    source, output = args.forecast_directory, args.output_directory
    report = json.loads((source/'report.json').read_text())
    archive = json.loads(args.prices.read_text())
    protocol = json.loads((ROOT/'research/optimization-strategy-protocol.json').read_text())
    if report['sample']['archiveDigest'] != archive['digest']:
        raise ValueError('Archive changed since fitting; use the exact archived training input')
    bundle = json.loads((source/'forecast-history.json').read_text())
    forward_bundle = json.loads((source/'forecast-forward.json').read_text())
    if report['modelVersion'] != bundle['modelVersion'] or report['modelVersion'] != forward_bundle['modelVersion']:
        raise ValueError('Model version mismatch')
    window = protocol['developmentWindow']
    selected = subset_bundle(bundle, window['startDate'], window['endDate'])
    history = build_input(selected, archive, reconstructed=True)
    history['meta']['evaluationClass'] = 'previously_seen_development'
    history['meta']['warnings'].append('Oct15–28 已在上一轮看过；本次结果属于开发比较，不能重新称为独立留出。')
    if len(history['meta']['dates']) != 14:
        raise ValueError('The fixed comparison requires all 14 declared days')
    full_history = build_input(bundle, archive, reconstructed=True)
    full_history['meta']['evaluationClass'] = 'chronological_reconstruction'
    profile = next(p for p in protocol['profiles'] if p['id'] == protocol['defaultProfile'])
    base = calculate(history, profile)
    fee = calculate(history, profile, 1.)
    expanded = calculate(full_history, profile, 1.)
    forward = build_input(forward_bundle, archive) if forward_bundle['points'] else None
    plan = calculate(forward, profile) if forward else None
    products = {'holdout-input.json': history, 'development-forecast.json': selected,
                'holdout-simulation.json': base, 'holdout-fee-1-sensitivity.json': fee,
                'rolling-input.json': full_history, 'rolling-simulation-fee-1.json': expanded}
    if forward:
        products.update({'embedded-data.json': forward, 'forward-plan.json': plan})
    else:
        # These are reproducible generated artifacts. Keep no stale forward input
        # at the current-version URL when the new run has no eligible forecast.
        for directory in (source, output):
            for name in ('embedded-data.json', 'forward-plan.json'):
                (directory/name).unlink(missing_ok=True)
    for name, value in products.items():
        write_json(output/name, value)
        write_json(source/name, value)
    versions = {'v1': json.loads((ROOT/'public/data/forecast-lab/holdout-input.json').read_text()), 'v2': history}
    rows = []
    for model, data in versions.items():
        if data['meta']['dates'] != history['meta']['dates']:
            raise ValueError('Comparison models must share identical target dates')
        if data['hours'] != history['hours'] or set(data['series']) != set(history['series']):
            raise ValueError('Comparison models must share identical UTC hours and nodes')
        for node in history['series']:
            if any(old is None or new is None or old[0:3] != new[0:3]
                   for old, new in zip(data['series'][node], history['series'][node])):
                raise ValueError('Comparison models must share identical observed DA/FMM prices')
        for item in protocol['profiles']:
            for charge in protocol['feesPerMWh']:
                result = calculate(data, item, charge)
                values = result['backtest']
                if values['incompleteDays']:
                    raise ValueError('Cannot compare a partially evaluated strategy')
                rows.append({'model': model, 'modelVersion': data['meta']['modelVersion'],
                             'profileId': item['id'], 'label': item['label'], 'strategy': item['strat'],
                             'k': max(item['k'], 1.5) if item['strat'] == 'high_conf' else item['k'],
                             'feePerMWh': charge, 'netPnl': values['total'], 'maxDrawdown': values['maxdd'],
                             'filledMWh': values['filled'], 'plannedMWh': values['totGross'],
                             'trades': values['totalTrades'], 'noSignalDays': values['noSignalDays'],
                             'days': values['ndays']})
    comparison = {'schemaVersion': 1, 'generatedAt': iso(datetime.now(timezone.utc)),
                  'classification': 'development_comparison', 'window': window, 'protocol': protocol,
                  'rows': rows, 'selection': 'none',
                  'warnings': ['所有预先规定的门槛与费用场景并列展示；没有根据本窗口净收益选择赢家。',
                               '更少交易会降低收益和损失的机会；零交易零损益不代表预测能力改善。']}
    write_json(source/'strategy-comparison.json', comparison)
    write_json(output/'strategy-comparison.json', comparison)
    summary = {'schemaVersion': 2, 'engineVersion': VERSION, 'generatedAt': iso(datetime.now(timezone.utc)),
               'executedAt': max(x['executedAt'] for x in (base, fee, expanded, *([plan] if plan else []))),
               'forecastGeneratedAt': forward_bundle['generatedAt'],
               'classification': '第二轮研究模拟；已见开发窗口比较，前向实绩待验证',
               'evaluationClass': 'previously_seen_development', 'evaluationWindow': window,
               'forecastDate': report['forecast']['targetDate'], 'forecastDigest': forward_bundle['digest'],
               'historyDigest': selected['digest'], 'fullHistoryDigest': bundle['digest'],
               'config': (plan or base)['config'],
               'forward': {key: plan['day'][key] for key in ('date', 'status', 'pnl', 'expected', 'gross',
                          'unallocatedMWh', 'forecastHours', 'expectedHours')} if plan else None,
               'forwardStatus': 'ready' if plan else 'awaiting_eligible_forecast',
               'holdout': compact_metrics(base),
               'feeSensitivity1PerMWh': {key: fee['backtest'][key] for key in ('total', 'maxdd', 'filled', 'fees')},
               'rolling': {'startDate': full_history['meta']['dates'][0], 'endDate': full_history['meta']['dates'][-1],
                           'feePerMWh': 1, 'metrics': compact_metrics(expanded)},
               'days': [{key: day[key] for key in ('date', 'status', 'pnl', 'gross', 'filled', 'fees',
                         'forecastHours', 'expectedHours')} for day in base['backtest']['days']],
               'warnings': ['本轮运行前固定三种信号门槛；默认策略保持原 normal k=0.5，未按已见窗口收益选型。',
                            'Oct15–28 是已见开发样本；扩展历史的滚动重建同样不能替代事前归档实绩。',
                            '费用敏感性未覆盖完整市场成本；未来实际价格与盈亏保持为空。']}
    write_json(source/'simulation-summary.json', summary)
    write_json(output/'simulation-summary.json', summary)
    print(json.dumps({'modelVersion': report['modelVersion'], 'forwardPoints': len(forward_bundle['points']),
                      'forwardMWh': summary['forward']['gross'] if plan else None,
                      'developmentPnL': summary['holdout']['total'],
                      'developmentFee1PnL': summary['feeSensitivity1PerMWh']['total'],
                      'comparisonScenarios': len(rows)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
