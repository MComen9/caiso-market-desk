#!/usr/bin/env python3
"""Build a distinct decision-order input and independently replay all fixed V3 cases."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import decision_strategy as ds

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT/'public/data/forecast-lab/v3'
OUTPUT = ROOT/'research/output-v3'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.'+path.name+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8')
    temporary.replace(path)


def main():
    report = json.loads((PUBLIC/'report.json').read_text())
    plan_bytes = (PUBLIC/'decision-plans.json').read_bytes()
    source = json.loads(plan_bytes)
    price_bytes = (ROOT/'data/strategy-history-expanded.json').read_bytes()
    prices = json.loads(price_bytes)
    if hashlib.sha256(price_bytes).hexdigest() != report['sample']['priceInputSha256']:
        raise ValueError('Frozen prices differ from V3 model input')
    if source['experimentVersion'] != report['experimentVersion'] or source['protocolDigest'] != report['protocol']['designDigest']:
        raise ValueError('Plan/report/protocol versions differ')
    if source['classification'] != 'historical_decision_reconstruction' or report['forward']['status'] != 'not_generated':
        raise ValueError('V3 release must be explicitly historical, with no forged forward batch')
    dates = sorted({plan['date'] for plan in source['plans']})
    nodes = report['sample']['nodes']
    actuals = [row for row in prices['rows'] if row['localDate'] in set(dates) and row['node'] in nodes]
    price_index = {(row['node'],row['startUtc']):row for row in actuals}
    if len(price_index) != len(actuals):
        raise ValueError('Duplicate actual-price row')
    clean_plans = []
    order_fields = ('node','startUtc','endUtc','localDate','localHour','utcOffset','side','mwh','quote',
                    'predictedNetPayoffPerSubmittedMWh','trainingFeePerMWh')
    for plan in source['plans']:
        orders = []
        for order in plan['orders']:
            actual = price_index[(order['node'],order['startUtc'])]
            if order['actualDa'] != actual['dam'] or order['actualFmm'] != actual['fmm']:
                raise ValueError('Model diagnostic prices differ from independent archive')
            orders.append({field:order[field] for field in order_fields})
        clean_plans.append({**{field:plan[field] for field in ('policyId','date','decisionAsOfUtc','trainingEndUtc','latestLabelDate')},
                            'orders':orders})
    data = {'schemaVersion':1,'inputKind':'frozen_decision_plans',
            'meta':{'classification':'historical_decision_reconstruction','experimentVersion':source['experimentVersion'],
                    'generatedAt':source['generatedAt'],'preparedAt':ds.iso(datetime.now(timezone.utc)),
                    'protocolDigest':source['protocolDigest'],'sourceForecastDigest':source['sourceForecastDigest'],
                    'sourcePlanSha256':hashlib.sha256(plan_bytes).hexdigest(),'priceArchiveDigest':prices['digest'],
                    'trainingFeePerMWh':source['trainingFeePerMWh'],
                    'expectedValueMeaning':'Estimated net payoff per submitted MWh at training fee=1, including zero for unfilled actions; not a price spread or probability.',
                    'warnings':['V3只输出历史开发决策，未生成新的事前预测。','调费用只重计原订单收益，不重新选信号或分配电量。']},
            'nodes':nodes,'dates':dates,'policyIds':[policy['id'] for policy in report['policies']],
            'constraints':source['constraints'],
            'actuals':[{key:row[key] for key in ('node','startUtc','endUtc','dam','fmm','paired','fmmCount')} for row in actuals],
            'plans':clean_plans}
    data['meta']['inputDigest'] = ds.input_digest(data)
    ds.validate(data)
    write(OUTPUT/'decision-plan-input.json',data)
    (PUBLIC/'decision-plan-input.json').write_bytes((OUTPUT/'decision-plan-input.json').read_bytes())
    checks = []
    replayed_orders = 0
    metrics_fields = ('netPnl','grossPnl','fees','plannedMWh','filledMWh','trades','noSignalDays','maxDrawdown','winRate','days')
    for window in report['windows']:
        for policy in data['policyIds']:
            for fee in report['feesPerMWh']:
                result = ds.replay(data,policy,fee,window['startDate'],window['endDate'])
                reference = next(row for row in report['results'] if row['windowId']==window['id'] and row['policyId']==policy and row['feePerMWh']==fee)
                for field in metrics_fields:
                    a,b = result['metrics'][field],reference[field]
                    if (a is None)!=(b is None) or a is not None and abs(a-b)>1e-6:
                        raise ValueError(f'Independent replay differs: {window["id"]}/{policy}/fee{fee}/{field}: {a} vs {b}')
                original = {(p['date']):p for p in source['plans'] if p['policyId']==policy}
                for day in result['days']:
                    expected_orders = original[day['date']]['orders']
                    if len(day['orders']) != len(expected_orders):
                        raise ValueError('Order count changed in replay')
                    for actual,expected in zip(day['orders'],expected_orders):
                        if actual['filled'] != expected['filled'] or abs(actual['grossPnl']-expected['grossPnl'])>1e-7 or abs(actual['netPnl']-expected['netPnlByFee'][str(fee)])>1e-7:
                            raise ValueError('Per-order independent settlement differs')
                        replayed_orders += 1
                checks.append({'windowId':window['id'],'policyId':policy,'feePerMWh':fee,'matches':True,
                               **result['metrics']})
                if fee == 1 and policy == report['defaultPolicyId']:
                    write(OUTPUT/f'{window["id"]}-ridge-replay.json',result)
    verification = {'schemaVersion':1,'engineVersion':ds.VERSION,'verifiedAt':ds.iso(datetime.now(timezone.utc)),
                    'experimentVersion':source['experimentVersion'],'inputDigest':data['meta']['inputDigest'],
                    'sourcePlanSha256':data['meta']['sourcePlanSha256'],'cases':len(checks),
                    'perOrderComparisons':replayed_orders,'allMetricsMatch':True,
                    'frozenOrdersReusedAcrossFees':True,'classification':'independent_historical_replay',
                    'checks':checks}
    write(PUBLIC/'replay-verification.json',verification)
    write(OUTPUT/'replay-verification.json',verification)
    (PUBLIC/'decision_strategy.py').write_bytes((ROOT/'research/decision_strategy.py').read_bytes())
    print(json.dumps({'input':str(PUBLIC/'decision-plan-input.json'),'experimentVersion':source['experimentVersion'],
                      'days':len(dates),'actualRows':len(actuals),'plans':len(clean_plans),'cases':len(checks),
                      'perOrderComparisons':replayed_orders,'allMetricsMatch':True},ensure_ascii=False))


if __name__ == '__main__':
    main()
