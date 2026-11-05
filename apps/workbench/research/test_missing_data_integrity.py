"""Offline regressions for observed OASIS coverage and publication-audit failures.

Run with: python -m unittest discover -s research -p test_missing_data_integrity.py -v
Fixtures and receipts use temporary directories; no market requests or model writes.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import gzip
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import build_missing_data as build
import fetch_missing_data as fetch


def utc_text(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def capture_dataset(dataset, fields, rows, **metadata):
    return {'dataset': dataset, 'fields': fields, 'rows': rows, **metadata}


def reports_for(data):
    def read(dataset):
        if dataset in data:
            yield {'id': 'fixture-' + dataset, 'dataset': dataset}, data[dataset]
    return read


def archive_bytes(members):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


class Response(io.BytesIO):
    status = 200
    headers = {}


class MappingIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # A complete 14-day fixture with exactly one applicable peak node per hour.
        # The fixture calendar is explicit; this does not reproduce WECC peak rules.
        cls.data = {'peak_calendar': [], 'cb_tradable_dam': [], 'cb_tradable_fmm': []}
        reference = []
        first = datetime(2026, 10, 15, 7, tzinfo=timezone.utc)
        for hour in range(336):
            start = first + timedelta(hours=hour)
            peak = 'ON' if 8 <= hour % 24 < 20 else 'OFF'
            cls.data['peak_calendar'].append({
                'INTERVALSTARTTIME_GMT': utc_text(start), 'PEAK_FLAG': peak,
            })
            for hub in ('NP15', 'SP15', 'ZP26'):
                research_node = f'TH_{hub}_GEN-APND'
                tradable_node = f'TH_{hub}_GEN_{peak}PEAK-APND'
                for market, minutes, count, value_field, report in (
                    ('DAM', 60, 1, 'MW', 'cb_tradable_dam'),
                    ('FMM', 15, 4, 'PRC', 'cb_tradable_fmm'),
                ):
                    for step in range(count):
                        interval = start + timedelta(minutes=step * minutes)
                        cls.data[report].append({
                            'LMP_TYPE': 'LMP', 'NODE': tradable_node,
                            'MARKET_RUN_ID': 'DAM' if market == 'DAM' else 'RTPD',
                            'INTERVALSTARTTIME_GMT': utc_text(interval),
                            'INTERVALENDTIME_GMT': utc_text(interval + timedelta(minutes=minutes)),
                            value_field: '42.25',
                        })
                        reference.append({'market': market, 'node': research_node,
                                          'startUtc': utc_text(interval), 'lmp': 42.25})
        cls.reference = gzip.compress(json.dumps({'rows': reference}).encode())

    def run_mapping(self, data):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / 'price-components-180d.json.gz').write_bytes(self.reference)
            with patch.object(build, 'OUT', output), \
                    patch.object(build, 'read_reports', reports_for(data)), \
                    patch.object(build, 'save_dataset', side_effect=capture_dataset):
                return build.tradable_node_mapping()

    def test_deleted_native_interval_is_incomplete_even_when_remaining_prices_match(self):
        complete = self.run_mapping(self.data)
        self.assertTrue(complete['complete'])
        self.assertTrue(complete['mappingVerified'])
        self.assertEqual(len(complete['rows']), 5040)
        damaged = deepcopy(self.data)
        del damaged['cb_tradable_fmm'][0]
        result = self.run_mapping(damaged)
        self.assertFalse(result['complete'])
        self.assertEqual(result['missingSourceIntervals'], 1)
        self.assertEqual(result['missingTradablePrices'], 0)
        self.assertEqual(result['maximumPriceDifference'], 0)
        self.assertFalse(result['mappingVerified'])
        self.assertNotEqual(result['classification'], 'sample_verified_node_and_price_mapping')

    def test_null_tradable_price_does_not_pass_by_omitting_its_difference(self):
        damaged = deepcopy(self.data)
        damaged['cb_tradable_fmm'][0]['PRC'] = ''
        result = self.run_mapping(damaged)
        self.assertEqual(len(result['rows']), 5040)
        self.assertEqual(result['missingSourceIntervals'], 0)
        self.assertEqual(result['missingTradablePrices'], 1)
        self.assertFalse(result['complete'])
        self.assertFalse(result['mappingVerified'])
        self.assertNotEqual(result['classification'], 'sample_verified_node_and_price_mapping')

    def test_equal_price_does_not_hide_a_calendar_node_conflict(self):
        damaged = deepcopy(self.data)
        row = damaged['cb_tradable_dam'][0]
        row['NODE'] = row['NODE'].replace('_OFFPEAK', '_ONPEAK')
        result = self.run_mapping(damaged)
        self.assertFalse(result['mappingVerified'])
        self.assertEqual(result['peakMappingMismatches'], 1)
        self.assertEqual(result['maximumPriceDifference'], 0)
        records = [dict(zip(result['fields'], values)) for values in result['rows']]
        conflicts = [value for value in records if value['mappingStatus'] == 'calendar_conflict']
        self.assertEqual(len(conflicts), 1)
        self.assertFalse(conflicts[0]['calendarNodeMatch'])
        self.assertTrue(conflicts[0]['priceMatchesReference'])

    def test_complete_coverage_does_not_verify_a_conflicting_price_mapping(self):
        damaged = deepcopy(self.data)
        damaged['cb_tradable_fmm'][0]['PRC'] = '43.25'
        result = self.run_mapping(damaged)
        self.assertTrue(result['complete'])
        self.assertEqual(result['pricesBeyondTolerance'], 1)
        self.assertEqual(result['maximumPriceDifference'], 1)
        self.assertFalse(result['mappingVerified'])
        self.assertNotEqual(result['classification'], 'sample_verified_node_and_price_mapping')

    def test_wrong_market_or_native_interval_is_rejected(self):
        faults = [
            ({'MARKET_RUN_ID': 'DAM'}, 'market mismatch'),
            ({'INTERVALENDTIME_GMT': '2026-10-15T07:30:00.000Z'}, 'duration/alignment'),
            ({'INTERVALSTARTTIME_GMT': '2026-10-15T07:01:00.000Z',
              'INTERVALENDTIME_GMT': '2026-10-15T07:16:00.000Z'}, 'duration/alignment'),
        ]
        for changes, message in faults:
            with self.subTest(changes=changes):
                damaged = deepcopy(self.data)
                damaged['cb_tradable_fmm'][0].update(changes)
                with self.assertRaisesRegex(ValueError, message):
                    self.run_mapping(damaged)


class EdamIntegrityTests(unittest.TestCase):
    def test_issuances_are_distinct_from_rows_and_days_do_not_prove_hourly_coverage(self):
        records = []
        first = datetime(2026, 5, 2, 7, tzinfo=timezone.utc)
        for day in range(180):
            start = first + timedelta(days=day)
            # One daily message at D-1 09:00 PT, with 24 target-hour observations.
            message = utc_text(start - timedelta(hours=15))
            for hour in range(24):
                interval = start + timedelta(hours=hour)
                records.append({
                    'INTERVAL_START_GMT': utc_text(interval),
                    'INTERVAL_END_GMT': utc_text(interval + timedelta(hours=1)),
                    'BAA_GRP_ID': 'CISO', 'SOLAR': '0', 'WIND': '1234.5',
                    '_SOURCE_MESSAGE_TIME': message, '_SOURCE_FILE': f'day-{day}.xml',
                })

        for fault in ('none', 'missing_hour', 'null_value'):
            with self.subTest(fault=fault):
                values = deepcopy(records)
                if fault == 'missing_hour':
                    del values[5]
                elif fault == 'null_value':
                    values[5]['SOLAR'] = ''
                with patch.object(build, 'read_reports', reports_for({'edam_history': values})), \
                        patch.object(build, 'save_dataset', side_effect=capture_dataset):
                    result = build.edam_history()
                self.assertEqual(result['cisoDays'], 180)
                self.assertEqual(result['messageCount'], 180)
                self.assertEqual(result['cisoMessageCountBeforeCutoff'], 180)
                self.assertEqual(result['cisoRowsBeforeCutoff'], len(values))
                self.assertEqual(result['expectedCisoHours'], 4320)
                self.assertEqual(result['missingCisoHours'], int(fault == 'missing_hour'))
                self.assertEqual(result['missingCisoValues'], int(fault == 'null_value'))
                self.assertEqual(result['hourlyCoverageComplete'], fault == 'none')
                self.assertEqual(result['modelStatus'], 'not_integrated')


class AcquisitionIntegrityTests(unittest.TestCase):
    def acquire_response(self, raw):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            opener = Mock()
            opener.open.return_value = Response(raw)
            spec = fetch.request_spec('test_report', date(2026, 5, 2), date(2026, 5, 3),
                                      group='EDAM_WND_SLR_FORECAST_GRP', resultformat='5')
            with patch.object(fetch, 'CACHE', cache), \
                    patch.object(fetch.urllib.request, 'build_opener', return_value=opener), \
                    patch.object(fetch.time, 'sleep'):
                receipt, _ = fetch.acquire(spec, last_request=0)
            opener.open.assert_called_once()
            saved = json.loads((cache / (spec['id'] + '.json')).read_text())
            self.assertEqual(receipt, saved)
            self.assertEqual((cache / receipt['rawFile']).read_bytes(), raw)
            return receipt

    def test_http_200_xml_error_is_not_success_plain_or_inside_zip(self):
        error = (b'<m:OASISReport xmlns:m="urn:oasis"><m:ERROR>'
                 b'<m:ERR_CODE>1000</m:ERR_CODE><m:ERR_DESC>No data returned</m:ERR_DESC>'
                 b'</m:ERROR></m:OASISReport>')
        responses = {
            'plain_xml': error,
            'zipped_xml': archive_bytes({'error.xml': error}),
            'csv_plus_error': archive_bytes({'partial.csv': 'A,B\n1,2\n', 'error.xml': error}),
        }
        for kind, raw in responses.items():
            with self.subTest(kind=kind):
                receipt = self.acquire_response(raw)
                self.assertEqual(receipt['httpStatus'], 200)
                self.assertEqual(receipt['status'], 'unavailable')
                self.assertEqual(receipt['error']['code'], '1000')
                self.assertNotIn('rowCount', receipt)

    def test_edam_interval_alias_is_audited_without_inventing_publication_time(self):
        xml = '''<EDAMWindAndSolarForecast xmlns="http://www.caiso.com/soa/EDAMWindAndSolarForecast_v1.xsd">
          <MessageHeader><TimeDate>2026-05-01T16:05:31Z</TimeDate></MessageHeader>
          <REPORT_DATA><INTERVAL_START_GMT>2026-05-02T07:00:00Z</INTERVAL_START_GMT>
            <INTERVAL_END_GMT>2026-05-02T08:00:00Z</INTERVAL_END_GMT>
            <BAA_GRP_ID>CISO</BAA_GRP_ID><SOLAR>0</SOLAR><WIND>1234.5</WIND></REPORT_DATA>
          <REPORT_DATA><INTERVAL_START_GMT>2026-05-02T08:00:00Z</INTERVAL_START_GMT>
            <INTERVAL_END_GMT>2026-05-02T09:00:00Z</INTERVAL_END_GMT>
            <BAA_GRP_ID>CISO</BAA_GRP_ID><SOLAR>0</SOLAR><WIND>1234.5</WIND></REPORT_DATA>
        </EDAMWindAndSolarForecast>'''
        receipt = self.acquire_response(archive_bytes({'edam.xml': xml}))
        self.assertEqual(receipt['status'], 'downloaded')
        self.assertEqual(receipt['rowCount'], 2)
        self.assertEqual(receipt['firstIntervalUtc'], '2026-05-02T07:00:00Z')
        self.assertEqual(receipt['lastIntervalUtc'], '2026-05-02T08:00:00Z')
        self.assertIn('_SOURCE_MESSAGE_TIME', receipt['sourcePublishFields'])
        self.assertIsNone(receipt['publishTimeUtc'])
        self.assertEqual(receipt['vintageEvidence'], 'current_download_only')
        self.assertEqual(receipt['sampleRows'][0]['_SOURCE_MESSAGE_TIME'], '2026-05-01T16:05:31Z')


class TimeBoundaryTests(unittest.TestCase):
    def test_pt_day_request_boundaries_include_dst_short_and_long_days(self):
        cases = [
            (date(2026, 3, 8), '20260308T08:00-0000', '20260309T07:00-0000'),
            (date(2025, 11, 2), '20251102T07:00-0000', '20251103T08:00-0000'),
        ]
        for day, first, last in cases:
            with self.subTest(day=day):
                spec = fetch.request_spec('dst', day, day + timedelta(days=1), query='PRC_LMP')
                self.assertEqual(spec['parameters']['startdatetime'], first)
                self.assertEqual(spec['parameters']['enddatetime'], last)

    def test_hourly_price_grid_preserves_dst_fold_gap_and_regime_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'data/strategy-history-expanded.json').write_text('{"rows":[]}')
            with patch.object(build, 'ROOT', root), \
                    patch.object(build, 'read_reports', reports_for({})), \
                    patch.object(build, 'save_dataset', side_effect=capture_dataset):
                result = build.price_archive()
        rows = [dict(zip(result['fields'], row)) for row in result['rows']]
        np15 = [row for row in rows if row['node'] == 'TH_NP15_GEN-APND']
        fall = [row for row in np15 if row['localDate'] == '2025-11-02']
        spring = [row for row in np15 if row['localDate'] == '2026-03-08']
        self.assertEqual(len(fall), 25)
        repeated = [row for row in fall if row['localHour'] == '01:00']
        self.assertEqual([row['startUtc'] for row in repeated],
                         ['2025-11-02T08:00:00.000Z', '2025-11-02T09:00:00.000Z'])
        self.assertEqual([row['utcOffset'] for row in repeated], ['-07:00', '-08:00'])
        self.assertEqual(len(spring), 23)
        self.assertNotIn('02:00', [row['localHour'] for row in spring])
        for day, regime in [('2026-04-30', 'pre_DAME_2026_05_01'),
                            ('2026-05-01', 'post_DAME_2026_05_01')]:
            self.assertEqual({row['marketRegime'] for row in np15 if row['localDate'] == day}, {regime})


if __name__ == '__main__':
    unittest.main()
