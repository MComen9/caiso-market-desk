"""Boundary tests for the V3 historical actuals collector; synthetic values only."""
from datetime import date
import unittest

from v3_data_audit import assemble, expected_hours, iso, normalize, parse, query_url


class FundamentalsBoundaries(unittest.TestCase):
    def test_dst_hours_remain_unique(self):
        for start, end, expected in [(date(2026, 3, 8), date(2026, 3, 9), 23),
                                     (date(2026, 11, 1), date(2026, 11, 2), 25)]:
            hours = list(expected_hours(start, end))
            self.assertEqual(len(hours), expected)
            self.assertEqual(len(set(map(iso, hours))), expected)
        self.assertIn('20261102T08%3A00-0000', query_url('load', date(2026, 11, 1), date(2026, 11, 2)))

    def test_conflicting_duplicates_remain_missing(self):
        row = {'MARKET_RUN_ID': 'ACTUAL', 'INTERVALSTARTTIME_GMT': '2026-05-02T07:00:00Z',
               'INTERVALENDTIME_GMT': '2026-05-02T08:00:00Z', 'TAC_AREA_NAME': 'CA ISO-TAC', 'MW': '100'}
        values, stats = normalize([row, dict(row), {**row, 'MW': '101'}, {**row, 'MW': '100'}],
                                  'load', date(2026, 5, 2), date(2026, 5, 3))
        self.assertIsNone(next(iter(values.values())))
        self.assertEqual(stats['conflictingDuplicates'], 1)
        self.assertEqual(stats['identicalDuplicates'], 1)

    def test_region_scope_zero_and_negative_values(self):
        stamp = '2026-05-02T07:00:00.000Z'
        base = {'MARKET_RUN_ID': 'ACTUAL', 'INTERVALSTARTTIME_GMT': stamp,
                'INTERVALENDTIME_GMT': '2026-05-02T08:00:00Z', 'RENEWABLE_TYPE': 'Solar'}
        records = [{**base, 'TRADING_HUB': hub, 'MW': value} for hub, value in
                   [('NP15', '-7.5'), ('SP15', '0'), ('ZP26', '10'), ('AVA', '99999')]]
        values, stats = normalize(records, 'renewables', date(2026, 5, 2), date(2026, 5, 3))
        for hub in ['NP15', 'SP15', 'ZP26']:
            values[(stamp, hub, 'wind')] = 0.
        row = assemble(date(2026, 5, 2), date(2026, 5, 3), {(stamp, 'CA ISO-TAC', 'load'): 100.}, values)[0]
        self.assertEqual(row['solarMw'], 2.5)
        self.assertEqual(row['windMw'], 0.)
        self.assertEqual(row['netLoadMw'], 97.5)
        self.assertEqual(stats['otherAreaOrResourceRows'], 1)
        self.assertEqual(stats['negativeValues'], 1)
        self.assertIsNone(row['publishTimeUtc'])

    def test_missing_component_does_not_become_zero(self):
        stamp = '2026-05-02T07:00:00.000Z'
        renewables = {(stamp, hub, resource): 1. for hub in ['NP15', 'SP15', 'ZP26']
                      for resource in ['solar', 'wind']}
        del renewables[(stamp, 'ZP26', 'wind')]
        row = assemble(date(2026, 5, 2), date(2026, 5, 3), {(stamp, 'CA ISO-TAC', 'load'): 100.}, renewables)[0]
        self.assertEqual(row['solarMw'], 3.)
        self.assertIsNone(row['windMw'])
        self.assertIsNone(row['netLoadMw'])
        self.assertEqual(row['quality'], 'missing')
        with self.assertRaises(ValueError):
            parse('2026-05-02T07:00:00')


if __name__ == '__main__':
    unittest.main()
