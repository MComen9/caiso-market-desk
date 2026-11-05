#!/usr/bin/env python3
"""Targeted economic-label, chronology, allocation and artifact checks."""
from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
import json
import unittest

import numpy as np
import decision_pipeline as dp
import forecast_pipeline as fp


class DecisionTests(unittest.TestCase):
    def test_payoff_includes_fill_and_cost(self):
        point={'predictedDa':40.,'actualDa':35.,'actualSpread':7.}
        self.assertEqual(dp.action_payoff(point,'DEC'),6.)
        self.assertEqual(dp.action_payoff(point,'INC'),-8.)
        point['actualDa']=25.
        self.assertEqual(dp.action_payoff(point,'INC'),0.)
        point['actualDa']=50.
        self.assertEqual(dp.action_payoff(point,'DEC'),0.)  # equal quote is not filled
        point.update(predictedDa=-10.,actualDa=-15.,actualSpread=-4.)
        self.assertEqual(dp.action_payoff(point,'INC'),3.)

    def test_exact_56_day_training_mask(self):
        dates=np.asarray([fp.shifted('2026-10-20',-lag) for lag in range(80)])
        selected=dates[dp.training_mask(dates,'2026-10-20')]
        self.assertEqual(len(selected),56)
        self.assertEqual(min(selected),'2026-08-24')
        self.assertEqual(max(selected),'2026-10-18')

    def test_unavailable_labels_cannot_change_fitted_prediction(self):
        rng=np.random.default_rng(9)
        dates=np.asarray([fp.shifted('2026-10-20',-lag) for lag in range(75)])
        x=rng.normal(size=(75,6));y=rng.normal(size=75);mask=dp.training_mask(dates,'2026-10-20')
        before=dp.model_for('ridge_payoff').fit(x[mask],y[mask]).predict(x[:1])
        y[dates>='2026-10-19']=1e12
        after=dp.model_for('ridge_payoff').fit(x[mask],y[mask]).predict(x[:1])
        np.testing.assert_array_equal(before,after)

    def test_features_ignore_d_minus_one_and_target_actuals(self):
        archive=json.loads((dp.ROOT/'data/strategy-history-expanded.json').read_text())
        fundamentals=json.loads((dp.ROOT/'data/fundamentals-history-v3.json').read_text())
        points=json.loads((dp.ROOT/'public/data/forecast-lab/v2/all-walk-forward.json').read_text())['points']
        target=[p for p in points if p['localDate']=='2026-10-20'][:6]
        before,_=dp.feature_matrix(fp.MarketHistory(archive),target,dp.Fundamentals(fundamentals))
        for r in archive['rows']:
            if r['localDate']>='2026-10-19': r['dam']+=1e9;r['fmm']-=1e9
        for r in fundamentals['rows']:
            if r['localDate']>='2026-10-19':
                for field in dp.DESIGN['fundamentalFeatures']['fields']: r[field]+=1e9
        after,_=dp.feature_matrix(fp.MarketHistory(archive),target,dp.Fundamentals(fundamentals))
        np.testing.assert_array_equal(before,after)

    def test_allocator_uses_no_actuals_and_obeys_limits(self):
        points=[{'node':'n'+str(i%3),'startUtc':f'2026-10-20T{i//3:02d}:00:00.000Z','predictedDa':40.} for i in range(72)]
        predictions=np.column_stack([np.linspace(1,20,72),np.linspace(0,12,72)])
        before=dp.allocate(points,predictions)
        changed=deepcopy(points)
        for r in changed:r.update(actualDa=-1e9,actualFmm=1e9)
        after=dp.allocate(changed,predictions)
        # Allocation may preserve the explicitly supplied extra fields, but they
        # cannot change selected keys, side, quantity or quote.
        selected=lambda rows:[(r['node'],r['startUtc'],r['side'],r['mwh'],r['quote']) for r in rows]
        self.assertEqual(selected(before),selected(after))
        self.assertLessEqual(sum(r['mwh'] for r in before),12+1e-7)
        self.assertLessEqual(len(before),12)
        self.assertTrue(all(1<=r['mwh']<=2+1e-7 for r in before))
        self.assertEqual(len({(r['node'],r['startUtc']) for r in before}),len(before))
        for node in ('n0','n1','n2'):self.assertLessEqual(sum(r['mwh'] for r in before if r['node']==node),6+1e-7)
        self.assertEqual(dp.allocate(points,np.zeros((72,2))),[])

    def test_fee_sensitivity_keeps_orders_fixed(self):
        orders=[{'node':'n','startUtc':'x','side':'DEC','quote':50,'mwh':2}]
        actual={('n','x'):{'dam':40,'fmm':45}}
        result=dp.evaluate_orders(orders,actual)[0]
        self.assertEqual(result['netPnlByFee'],{'0':10.,'1':8.,'2':6.,'5':0.})
        self.assertEqual(orders[0]['mwh'],result['mwh'])

    def test_published_artifacts_independently_reconcile(self):
        if not (dp.OUT/'report.json').exists():self.skipTest('Run V3 pipeline first')
        report=json.loads((dp.OUT/'report.json').read_text())
        artifact=json.loads((dp.OUT/'decision-plans.json').read_text())
        protocol=json.loads((dp.OUT/'protocol.json').read_text())
        self.assertEqual(protocol['designDigest'],fp.digest(protocol['design']))
        self.assertLess(protocol['frozenAt'],report['generatedAt'])
        self.assertEqual(report['sample']['priceInputSha256'],hashlib.sha256((dp.ROOT/'data/strategy-history-expanded.json').read_bytes()).hexdigest())
        self.assertEqual(report['sample']['fundamentalsInputSha256'],hashlib.sha256((dp.ROOT/'data/fundamentals-history-v3.json').read_bytes()).hexdigest())
        source=json.loads((dp.ROOT/'public/data/forecast-lab/v2/all-walk-forward.json').read_text())
        self.assertEqual(source['digest'],fp.digest(source['points']))
        actuals=fp.MarketHistory(json.loads((dp.ROOT/'data/strategy-history-expanded.json').read_text())).by_key
        for point in source['points']:
            actual=actuals[(point['node'],point['startUtc'])]
            self.assertEqual((point['actualDa'],point['actualFmm']),(actual['dam'],actual['fmm']))
        self.assertFalse(report['promotionGate']['approvedForTrading'])
        self.assertEqual(report['forward']['status'],'not_generated')
        for audit in report['fitAudit']:
            self.assertEqual(audit['latestLabelDate'],fp.shifted(audit['date'],-2))
            self.assertEqual(audit['trainingDays'],56)
            self.assertLessEqual(audit['trainingEndUtc'],audit['decisionAsOfUtc'])
        windows={w['id']:w for w in report['windows']}
        for result in report['results']:
            window=windows[result['windowId']]
            plans=[p for p in artifact['plans'] if p['policyId']==result['policyId'] and window['startDate']<=p['date']<=window['endDate']]
            gross=filled=0.
            for plan in plans:
                self.assertLessEqual(sum(o['mwh'] for o in plan['orders']),12+1e-7)
                for order in plan['orders']:
                    sign=1 if order['side']=='DEC' else -1
                    crossed=sign*(order['quote']-order['actualDa'])>1e-8
                    self.assertEqual(order['filled'],crossed)
                    if crossed:
                        gross+=order['mwh']*sign*(order['actualFmm']-order['actualDa'])
                        filled+=order['mwh']
            self.assertAlmostEqual(gross-filled*result['feePerMWh'],result['netPnl'],places=6)
            self.assertAlmostEqual(filled,result['filledMWh'],places=6)
        old=report['diagnostics']['inputAttribution']
        self.assertAlmostEqual(sum(r['contribution'] for r in old['shapley']),old['delta'],places=7)


if __name__=='__main__': unittest.main(verbosity=2)
