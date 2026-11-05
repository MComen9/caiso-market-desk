"""Targeted tests for V4 information-lag, split and selection contracts."""
import copy
import unittest

import numpy as np

import current_data_pipeline as cp
import forecast_pipeline as fp


def fixture(start='2026-08-01', days=65):
    rows = []
    for i in range(days):
        day = fp.shifted(start, i)
        for row in fp.hours_for_day(day, ['TH_NP15_GEN-APND']):
            hour = int(row['localHour'][:2])
            rows.append({**row, 'dam': 10+i+hour, 'fmm': 12+i+hour,
                         'fmmCount': 4, 'paired': True, 'marketRegime': 'post_DAME_2026_05_01'})
    return {'nodes': ['TH_NP15_GEN-APND'], 'rows': rows}


class CurrentDataContractTest(unittest.TestCase):
    def test_changes_after_declared_lag_do_not_change_features(self):
        source = fixture()
        day = '2026-10-03'
        target = fp.hours_for_day(day, source['nodes'])[12]
        for delay in (2, 3):
            before = cp.CurrentHistory(source, delay)
            changed = copy.deepcopy(source)
            for row in changed['rows']:
                if row['localDate'] > fp.shifted(day, -delay):
                    row['dam'] += 100000
                    row['fmm'] -= 90000
            after = cp.CurrentHistory(changed, delay)
            np.testing.assert_allclose(before.features(target), after.features(target), equal_nan=True)
            for candidate in ('zero_spread', 'mean14', 'median14', 'shrink14', 'seasonal7'):
                self.assertEqual(before.baseline_value(target, candidate, 'da'), after.baseline_value(target, candidate, 'da'))
                self.assertEqual(before.baseline_value(target, candidate, 'spread'), after.baseline_value(target, candidate, 'spread'))

    def test_d3_does_not_use_d2_price(self):
        source = fixture()
        target = fp.hours_for_day('2026-10-03', source['nodes'])[0]
        before = cp.CurrentHistory(source, 3)
        changed = copy.deepcopy(source)
        for row in changed['rows']:
            if row['localDate'] == '2026-10-01':
                row['dam'] = 999999
        after = cp.CurrentHistory(changed, 3)
        np.testing.assert_allclose(before.features(target), after.features(target), equal_nan=True)

    def test_split_gaps_respect_both_information_delays(self):
        for delay in (2, 3):
            splits = cp.chronological_splits('2026-10-29', delay)
            self.assertEqual(splits['holdout']['days'], 28)
            self.assertEqual(splits['calibration']['endDate'], fp.shifted(splits['holdout']['startDate'], -delay))
            self.assertEqual(splits['validation']['endDate'], fp.shifted(splits['calibration']['startDate'], -delay))
            self.assertEqual(len(splits['purgedDates']), 2*(delay-1))

    def test_selection_does_not_read_final_evaluation(self):
        records = [{'id': 'mean14', 'validation': {'da': {'mae': 10}}, 'holdout': {'da': {'mae': .01}}},
                   {'id': 'ridge56', 'validation': {'da': {'mae': 9}}, 'holdout': {'da': {'mae': 99999}}}]
        self.assertEqual(cp.select_candidate(records, 'da'), 'ridge56')
        records[0]['holdout']['da']['mae'], records[1]['holdout']['da']['mae'] = 999999, 0
        self.assertEqual(cp.select_candidate(records, 'da'), 'ridge56')

    def test_dst_day_is_not_forced_to_24_hours(self):
        archive = fixture('2025-11-01', 3)
        history = cp.CurrentHistory(archive, 2)
        cp.complete_history(history)
        self.assertEqual(len(history.daily[('2025-11-02', 'TH_NP15_GEN-APND')]), 25)

    def test_missing_hour_fails_archive_validation(self):
        archive = fixture(days=3)
        archive['rows'].pop()
        with self.assertRaisesRegex(ValueError, 'Incomplete hub/hour'):
            cp.complete_history(cp.CurrentHistory(archive))


if __name__ == '__main__':
    unittest.main()
