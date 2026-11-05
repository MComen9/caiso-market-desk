#!/usr/bin/env python3
"""Adversarial checks for the new selector, calibration and output contract."""
import copy
import hashlib
import json
import unittest
from pathlib import Path

import numpy as np
import optimization_pipeline as op
import forecast_pipeline as fp


def synthetic_records():
    records=[]
    for day in range(1,21):
        for hour in range(24):
            actual=float((hour%7)-3)
            predictions={identifier:{'da':actual+2+(index%3), 'spread':actual+index/10}
                         for index,identifier in enumerate(op.IDS)}
            records.append({'localDate':f'2026-10-{day:02d}','localHour':f'{hour:02d}:00','node':'n',
                            'actualDa':actual,'actualSpread':actual,'predictedDa':actual-1,
                            'predictedSpread':actual-2,'predictions':predictions})
    return records


class OptimizationTests(unittest.TestCase):
    def test_selector_does_not_read_d_minus_one_or_future(self):
        records=synthetic_records();before=op.select_weights(records,'2026-10-16','spread')
        changed=copy.deepcopy(records)
        for row in changed:
            if row['localDate']>='2026-10-15':
                row['actualSpread']=1e9
                row['predictions']['zero']['spread']=-1e9
        self.assertEqual(before,op.select_weights(changed,'2026-10-16','spread'))
        self.assertEqual(before[1]['endDate'],'2026-10-14')

    def test_selector_reacts_to_eligible_error(self):
        records=synthetic_records();before=op.select_weights(records,'2026-10-16','spread')
        for row in records:
            if '2026-10-01'<=row['localDate']<='2026-10-14': row['predictions']['zero']['spread']=1e8
        self.assertNotEqual(before[0],op.select_weights(records,'2026-10-16','spread')[0])

    def test_selector_preserves_baseline_and_sum(self):
        for target in ('da','spread'):
            weights,_=op.select_weights(synthetic_records(),'2026-10-16',target)
            self.assertAlmostEqual(sum(weights.values()),1.)
            self.assertGreaterEqual(weights[op.BASELINE[target]],.2)
            self.assertTrue(all(0<=v<=1 for v in weights.values()))

    def test_selector_uses_baseline_during_warmup(self):
        weights,audit=op.select_weights(synthetic_records(),'2026-10-07','spread')
        self.assertEqual(weights,{'zero':1.})
        self.assertTrue(audit['fallback'])

    def test_calibration_never_reads_unavailable_errors(self):
        records=synthetic_records();before=op.calibrate(records,'2026-10-16','n','18:00','spread')
        for row in records:
            if row['localDate']>='2026-10-15': row['actualSpread']=1e9
        self.assertEqual(before,op.calibrate(records,'2026-10-16','n','18:00','spread'))
        self.assertEqual(before['n'],84)
        self.assertEqual(before['level'],'hour_bucket')

    def test_small_bucket_falls_back_or_is_missing(self):
        records=synthetic_records()
        self.assertEqual(op.calibrate(records,'2026-10-06','n','00:00','spread')['level'],'node')
        self.assertIsNone(op.calibrate(records,'2026-10-03','n','00:00','spread')['sigma'])

    def test_robust_locations_ignore_target_actuals(self):
        archive=json.loads((fp.ROOT/'data/strategy-history.json').read_text())
        row=fp.hours_for_day('2026-10-20',archive['nodes'])[20]
        before=op.location_forecast(fp.MarketHistory(archive),row,'spread')
        for actual in archive['rows']:
            if actual['localDate']>='2026-10-19': actual['fmm']+=1e8
        self.assertEqual(before,op.location_forecast(fp.MarketHistory(archive),row,'spread'))

    def test_published_outputs_reconcile(self):
        if not (op.OUT/'report.json').exists(): self.skipTest('Run pipeline first')
        report=json.loads((op.OUT/'report.json').read_text())
        protocol=json.loads((op.OUT/'protocol.json').read_text())
        history=json.loads((op.OUT/'forecast-history.json').read_text())
        forward=json.loads((op.OUT/'forecast-forward.json').read_text())
        self.assertEqual(protocol['designDigest'],fp.digest(protocol['design']))
        self.assertEqual(report['optimization']['protocolFrozenAt'],protocol['frozenAt'])
        raw=(fp.ROOT/'data/strategy-history-expanded.json').read_bytes()
        self.assertEqual(report['sample']['inputSha256'],hashlib.sha256(raw).hexdigest())
        self.assertFalse(report['promotionGate']['approvedForTrading'])
        self.assertEqual(history['digest'],fp.digest(history['points']))
        self.assertEqual(forward['digest'],fp.digest(forward['points']))
        self.assertTrue(all(p['issuedAt']==report['generatedAt'] for p in history['points']+forward['points']))
        for audit in report['method']['fitAudit']:
            self.assertLessEqual(audit['trainingEndUtc'],audit['decisionAsOfUtc'])
            self.assertEqual(audit['selector']['da']['endDate'],fp.shifted(audit['targetDate'],-2))
            self.assertLessEqual(audit['ridgeTrainingRows']['ridge28'],28*24*3)
            self.assertLessEqual(audit['ridgeTrainingRows']['ridge56'],56*24*3)
        if forward['points']:
            self.assertEqual(len(forward['points']),72)
            self.assertEqual(len({(p['node'],p['startUtc']) for p in forward['points']}),72)
            for point in forward['points']:
                self.assertLess(point['issuedAt'],point['decisionAsOfUtc'])
                self.assertIsNone(point['actualDa']);self.assertIsNone(point['actualFmm'])
        for target,key in [('da','predictedDa'),('spread','predictedSpread')]:
            values=[p for p in json.loads((op.OUT/'all-walk-forward.json').read_text())['points'] if '2026-10-15'<=p['localDate']<='2026-10-28']
            actual='actualDa' if target=='da' else 'actualSpread'
            mae=np.mean([abs(p[actual]-p[key]) for p in values])
            self.assertAlmostEqual(mae,report['optimization']['comparison']['v2'][target]['mae'])


if __name__=='__main__': unittest.main(verbosity=2)
