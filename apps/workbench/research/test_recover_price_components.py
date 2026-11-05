"""Boundary tests for recovered native OASIS intervals; not market performance."""
from copy import deepcopy
import unittest

from recover_price_components import component_identity, merge_record, normalize_record


def fixture():
    return {'node': 'TH_NP15_GEN-APND', 'startUtc': '2026-10-28T07:00:00.000Z',
            'endUtc': '2026-10-28T07:15:00.000Z', 'localDate': '2026-10-28',
            'localHour': '00:00', 'utcOffset': '-07:00', 'minutes': 15, 'hourEnding': 1,
            'price': -5, 'components': {'MCE': 5, 'MCC': -10, 'MCL': 0, 'MGHG': 0}, 'quality': 'ok'}


class RecoveryTests(unittest.TestCase):
    def test_conflicting_duplicate_rejected_and_exact_duplicate_provenance_retained(self):
        row = normalize_record('FMM', fixture())
        records = {}
        self.assertFalse(merge_record(records, row, 'source-a', '2026-10-29T09:00:00.000Z'))
        self.assertTrue(merge_record(records, deepcopy(row), 'source-b', '2026-10-29T10:00:00.000Z'))
        stored = next(iter(records.values()))
        self.assertEqual(stored['sourceReportIds'], ['source-a', 'source-b'])
        changed = deepcopy(row)
        changed['components']['MCC'] = -11
        with self.assertRaisesRegex(ValueError, 'Conflicting duplicate'):
            merge_record(records, changed, 'source-c', '2026-10-29T11:00:00.000Z')

    def test_missing_component_is_not_zero_or_complete_identity(self):
        source = fixture()
        del source['components']['MGHG']
        row = normalize_record('FMM', source)
        self.assertIsNone(row['components']['MGHG'])
        self.assertIsNone(component_identity(row))
        self.assertEqual(row['components']['MCC'], -10)
        self.assertEqual(row['components']['MCL'], 0)
        self.assertEqual(row['lmp'], -5)

    def test_dst_fold_native_intervals_remain_distinct(self):
        a, b = fixture(), fixture()
        a.update(startUtc='2026-11-01T08:00:00.000Z', endUtc='2026-11-01T08:15:00.000Z',
                 localDate='2026-11-01', localHour='01:00', utcOffset='-07:00')
        b.update(startUtc='2026-11-01T09:00:00.000Z', endUtc='2026-11-01T09:15:00.000Z',
                 localDate='2026-11-01', localHour='01:00', utcOffset='-08:00')
        records = {}
        for name, source in [('a', a), ('b', b)]:
            merge_record(records, normalize_record('FMM', source), name, '2026-11-02T12:00:00.000Z')
        self.assertEqual(len(records), 2)
        b['utcOffset'] = '-07:00'
        with self.assertRaisesRegex(ValueError, 'PT labels'):
            normalize_record('FMM', b)


if __name__ == '__main__':
    unittest.main()
