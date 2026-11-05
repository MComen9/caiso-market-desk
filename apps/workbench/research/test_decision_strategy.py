"""Boundary tests for the independent frozen-decision replay contract."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest

import decision_strategy as ds


def fixture(day='2026-10-28'):
    hours = ds.day_hours(day)
    latest = (datetime.fromisoformat(day)-timedelta(days=2)).date().isoformat()
    orders = [{'node':'NP15', 'startUtc':start, 'endUtc':end, 'side':side, 'mwh':2.,
               'quote':-1. if side=='INC' else 1., 'predictedNetPayoffPerSubmittedMWh':3.,
               'trainingFeePerMWh':1.} for (start,end),side in zip(hours,('INC','DEC'))]
    value = {'schemaVersion':1, 'inputKind':'frozen_decision_plans',
             'meta':{'classification':'historical_decision_reconstruction', 'experimentVersion':'synthetic-test',
                     'generatedAt':ds.iso(ds.timestamp(hours[-1][1])+timedelta(hours=3))},
             'dates':[day], 'nodes':['NP15'], 'policyIds':['ridge_payoff'],
             'constraints':{'dailyMWh':12., 'perCellMWh':2., 'perNodeMWh':6., 'maxCells':12, 'tieFill':False},
             'actuals':[{'node':'NP15', 'startUtc':start, 'endUtc':end, 'dam':0., 'fmm':-2.,
                         'paired':True, 'fmmCount':4} for start,end in hours],
             'plans':[{'policyId':'ridge_payoff', 'date':day, 'decisionAsOfUtc':ds.iso(ds.cutoff(day)),
                       'trainingEndUtc':ds.day_hours(latest)[-1][1], 'latestLabelDate':latest, 'orders':orders}]}
    value['meta']['inputDigest'] = ds.input_digest(value)
    return value


def reseal(value):
    value['meta']['inputDigest'] = ds.input_digest(value)
    return value


class ReplayTests(unittest.TestCase):
    def test_zero_negative_prices_and_fixed_orders_fee_sensitivity(self):
        data = fixture()
        before = deepcopy(data)
        one, two = ds.replay(data,'ridge_payoff',1), ds.replay(data,'ridge_payoff',2)
        self.assertEqual(one['metrics']['netPnl'],-4.)
        self.assertEqual(one['metrics']['filledMWh'],4.)
        self.assertEqual(two['metrics']['netPnl']-one['metrics']['netPnl'],-4.)
        self.assertEqual(data,before)

    def test_equal_quote_excluded_and_missing_price_not_zero(self):
        data = fixture()
        data['plans'][0]['orders'][0]['quote'] = 0.
        result = ds.replay(reseal(data),'ridge_payoff')
        self.assertEqual(result['days'][0]['orders'][0]['status'],'tie_excluded')
        self.assertEqual(result['days'][0]['orders'][0]['fees'],0.)
        data['actuals'][1]['fmm'] = None
        result = ds.replay(reseal(data),'ridge_payoff')
        self.assertIsNone(result['metrics']['netPnl'])
        self.assertIsNone(result['days'][0]['orders'][1]['netPnl'])

    def test_duplicate_action_and_volume_caps_rejected(self):
        data = fixture()
        data['plans'][0]['orders'].append(deepcopy(data['plans'][0]['orders'][0]))
        with self.assertRaisesRegex(ValueError,'duplicates'):
            ds.replay(reseal(data),'ridge_payoff')
        data = fixture()
        data['plans'][0]['orders'][0]['mwh'] = 3
        with self.assertRaisesRegex(ValueError,'per-cell'):
            ds.replay(reseal(data),'ridge_payoff')

    def test_digest_and_unavailable_labels_rejected(self):
        data = fixture()
        data['plans'][0]['orders'][0]['quote'] += 1
        with self.assertRaisesRegex(ValueError,'digest'):
            ds.replay(data,'ridge_payoff')
        data = fixture()
        data['plans'][0]['latestLabelDate'] = '2026-10-27'
        with self.assertRaisesRegex(ValueError,'unavailable'):
            ds.replay(reseal(data),'ridge_payoff')

    def test_future_plan_cannot_claim_historical_result(self):
        data = fixture()
        data['meta']['generatedAt'] = '2026-10-28T10:00:00.000Z'
        with self.assertRaisesRegex(ValueError,'had not ended'):
            ds.replay(reseal(data),'ridge_payoff')
        data = fixture()
        data['meta']['classification'] = 'forward_decision_plan'
        with self.assertRaisesRegex(ValueError,'no forward batch'):
            ds.replay(reseal(data),'ridge_payoff')

    def test_calendar_dates_reject_times_and_invalid_labels(self):
        data = fixture()
        data['dates'] = ['2026-10-28T12:00:00']
        with self.assertRaisesRegex(ValueError,'calendar date'):
            ds.replay(reseal(data),'ridge_payoff')
        data = fixture()
        data['plans'][0]['latestLabelDate'] = '2026-09-99'
        with self.assertRaisesRegex(ValueError,'calendar date'):
            ds.replay(reseal(data),'ridge_payoff')

    def test_dst_hours_and_completed_zero_plan(self):
        for day,expected in [('2026-03-08',23),('2026-11-01',25)]:
            data = fixture(day)
            data['plans'][0]['orders'] = []
            result = ds.replay(reseal(data),'ridge_payoff')
            self.assertEqual(result['days'][0]['expectedActualHours'],expected)
            self.assertEqual(result['metrics']['netPnl'],0.)
            self.assertEqual(result['metrics']['noSignalDays'],1)
            self.assertIsNone(result['metrics']['winRate'])


if __name__ == '__main__':
    unittest.main()
