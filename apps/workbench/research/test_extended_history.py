"""Synthetic contract checks for extended-history normalization, not market performance."""
import unittest
from copy import deepcopy
from datetime import date, timedelta

from fetch_extended_history import NODES, PT, expected_hours, iso, normalize_pair


def fixture(day):
    responses = {}
    for market, minutes in [('DAM', 60), ('FMM', 15)]:
        intervals = []
        for hour in expected_hours(day, day):
            for node in NODES:
                for slot in range(60 // minutes):
                    ts = hour + timedelta(minutes=slot * minutes)
                    local = ts.astimezone(PT)
                    intervals.append({'node': node, 'startUtc': iso(ts), 'endUtc': iso(ts + timedelta(minutes=minutes)),
                                      'localDate': local.date().isoformat(), 'localHour': local.strftime('%H:%M'),
                                      'quality': 'ok', 'price': 0.0 if market == 'DAM' else -4.0 + slot})
        responses[market] = {'ok': True, 'market': market, 'request': {'startDate': str(day), 'endDate': str(day)},
                             'intervals': intervals}
    return responses


class ExtendedHistoryTests(unittest.TestCase):
    def test_dst_utc_hours(self):
        for day, hours in [(date(2026, 3, 8), 23), (date(2026, 11, 1), 25)]:
            rows = list(expected_hours(day, day))
            self.assertEqual(len(rows), hours)
            self.assertEqual(len(set(rows)), hours)
            data = fixture(day)
            out = normalize_pair(data['DAM'], data['FMM'], day, day)
            self.assertEqual(len(out), hours * 3)
            self.assertTrue(all(row['paired'] for row in out))

    def test_zero_and_negative_prices(self):
        day = date(2026, 5, 2)
        data = fixture(day)
        row = normalize_pair(data['DAM'], data['FMM'], day, day)[0]
        self.assertEqual(row['dam'], 0.0)
        self.assertEqual(row['fmm'], -2.5)
        self.assertEqual(row['fmmCount'], 4)
        self.assertTrue(row['paired'])

    def test_missing_and_duplicate_slot_never_partial_mean(self):
        day = date(2026, 5, 2)
        for duplicate in [False, True]:
            data = fixture(day)
            if duplicate:
                data['FMM']['intervals'].append(deepcopy(data['FMM']['intervals'][0]))
            else:
                data['FMM']['intervals'].pop(0)
            row = normalize_pair(data['DAM'], data['FMM'], day, day)[0]
            self.assertIsNone(row['fmm'])
            self.assertEqual(row['fmmCount'], 3)
            self.assertFalse(row['paired'])

    def test_reject_wrong_date_range(self):
        day = date(2026, 5, 2)
        data = fixture(day)
        data['DAM']['request']['startDate'] = '2026-05-01'
        with self.assertRaises(ValueError):
            normalize_pair(data['DAM'], data['FMM'], day, day)

    def test_reject_wrong_duration_or_local_timestamp(self):
        day = date(2026, 5, 2)
        data = fixture(day)
        data['FMM']['intervals'][0]['endUtc'] = data['FMM']['intervals'][0]['startUtc']
        with self.assertRaises(ValueError):
            normalize_pair(data['DAM'], data['FMM'], day, day)
        data = fixture(day)
        data['FMM']['intervals'][0]['localDate'] = '2026-05-01'
        with self.assertRaises(ValueError):
            normalize_pair(data['DAM'], data['FMM'], day, day)


if __name__ == '__main__':
    unittest.main()
