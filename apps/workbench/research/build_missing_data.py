#!/usr/bin/env python3
"""Build a typed, auditable data-gap delivery from public acquisition receipts.

Does not overwrite frozen models or supply unverified historical forecast vintages.
All missing observations remain null; market/area/horizon dimensions are retained.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo

from fetch_missing_data import CACHE, NODES, ROOT, atomic_json, decode, stamp

OUT = ROOT / 'public/data/data-gaps'
PT = ZoneInfo('America/Los_Angeles')
HUBS = ['NP15', 'SP15', 'ZP26']


def iso(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Timestamp must include an explicit timezone')
    return value.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def number(value):
    if value is None or str(value).strip().lower() in ('', 'null', 'nan', 'n/a'):
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Non-finite source number')
    return result


def read_reports(dataset):
    for path in sorted(CACHE.glob(dataset + '_*.json')):
        meta = json.loads(path.read_text())
        if meta.get('dataset') != dataset or meta.get('status') != 'downloaded':
            continue
        body = (CACHE / meta['rawFile']).read_bytes()
        if hashlib.sha256(body).hexdigest() != meta['sha256']:
            raise ValueError('Raw response does not match receipt: ' + path.name)
        rows, error = decode(body)
        if error:
            raise ValueError('Successful receipt contains an upstream error')
        yield meta, rows


def unique_put(values, key, value):
    if key in values and values[key] != value:
        raise ValueError('Conflicting duplicate source observation: ' + str(key))
    values[key] = value


def compact_source(meta):
    return {key: meta.get(key) for key in ['id', 'dataset', 'url', 'fetchedAt', 'sha256', 'bytes', 'rowCount']}


def save_dataset(dataset, fields, rows, **metadata):
    OUT.mkdir(parents=True, exist_ok=True)
    payload = {'schemaVersion': 1, 'dataset': dataset, 'generatedAt': stamp(),
               'fields': fields, 'rows': rows, **metadata}
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    packed = gzip.compress(raw, mtime=0)
    path = OUT / (dataset + '.json.gz')
    path.write_bytes(packed)
    summary = {'schemaVersion': 1, 'dataset': dataset, 'generatedAt': payload['generatedAt'],
               'rows': len(rows), 'fields': fields,
               'download': '/data/data-gaps/' + path.name,
               'bytes': len(packed), 'sha256': hashlib.sha256(packed).hexdigest(),
               'sampleRows': [dict(zip(fields, row)) for row in rows[:6]], **metadata}
    atomic_json(OUT / (dataset + '-audit.json'), summary)
    return summary


def forecast_panel():
    series, sources, counts = {}, [], Counter()
    fields = ['startUtc', 'endUtc', 'localDate', 'localHour', 'utcOffset',
              'loadDamMw', 'load2daMw', 'load7daMw',
              'solarNp15Mw', 'solarSp15Mw', 'solarZp26Mw',
              'windNp15Mw', 'windSp15Mw', 'windZp26Mw',
              'solarCaisoMw', 'windCaisoMw', 'netLoadDamMw', 'publishTimeUtc']
    for dataset, market, target in [('load_dam', 'DAM', 'loadDamMw'), ('load_2da', '2DA', 'load2daMw'), ('load_7da', '7DA', 'load7daMw'), ('renewables_dam', 'DAM', None)]:
        values = {}
        for meta, rows in read_reports(dataset):
            sources.append(compact_source(meta))
            for row in rows:
                counts[dataset + 'SourceRows'] += 1
                if row['MARKET_RUN_ID'] != market:
                    raise ValueError('Forecast market mismatch')
                start, end = iso(row['INTERVALSTARTTIME_GMT']), iso(row['INTERVALENDTIME_GMT'])
                if datetime.fromisoformat(end.replace('Z', '+00:00')) - datetime.fromisoformat(start.replace('Z', '+00:00')) != timedelta(hours=1):
                    raise ValueError('Forecast must use native hourly intervals')
                if dataset.startswith('load_'):
                    if row.get('TAC_AREA_NAME') != 'CA ISO-TAC':
                        continue
                    key = target
                else:
                    hub, resource = row['TRADING_HUB'], row['RENEWABLE_TYPE'].lower()
                    if hub not in HUBS or resource not in ['solar', 'wind']:
                        continue
                    key = resource + hub.title() + 'Mw'
                unique_put(values, (start, key), number(row['MW']))
                counts[dataset + 'SelectedRows'] += 1
        series.update(values)
    current = datetime(2026, 5, 2, tzinfo=PT).astimezone(timezone.utc)
    stop = datetime(2026, 10, 29, tzinfo=PT).astimezone(timezone.utc)
    rows, missing = [], Counter()
    while current < stop:
        local = current.astimezone(PT)
        data = {key: series.get((iso(current), key)) for key in fields[5:14]}
        for resource in ['solar', 'wind']:
            parts = [data[resource + hub.title() + 'Mw'] for hub in HUBS]
            data[resource + 'CaisoMw'] = sum(parts) if all(x is not None for x in parts) else None
        parts = [data['loadDamMw'], data['solarCaisoMw'], data['windCaisoMw']]
        data['netLoadDamMw'] = parts[0] - parts[1] - parts[2] if all(x is not None for x in parts) else None
        for key in fields[5:17]:
            missing[key] += data.get(key) is None
        offset = local.strftime('%z')
        row = [iso(current), iso(current + timedelta(hours=1)), local.date().isoformat(), local.strftime('%H:%M'), offset[:3] + ':' + offset[3:]]
        rows.append(row + [data.get(key) for key in fields[5:17]] + [None])
        current += timedelta(hours=1)
    return save_dataset('official-forecast-history-180d', fields, rows,
        startDate='2026-05-02', endDate='2026-10-28', timeZone='America/Los_Angeles', intervalMinutes=60,
        unit='MW', expectedHours=4320, missingByField=dict(missing), counts=dict(counts), sources=sources,
        classification='historical_forecast_values_current_vintage', modelStatus='not_integrated',
        causalReplayApproved=False, publishTimeAvailable=False,
        notes=['DAM、2DA、7DA 保留不同预测期限，不是同一预测的多个发行批次。',
               '每个目标小时的历史预测值来自当前下载版本，不能证明决策截点时已可见。',
               '净负荷是同小时DAM负荷减完整NP15/SP15/ZP26风光之和；缺项则为空。',
               '字段含零值和负值时均保留；没有插值或用实际值补预测。'])


def generic_dataset(dataset, fields, key_fields=None, numeric_fields=(), filter_fn=None, **metadata):
    rows, sources = {}, []
    for meta, records in read_reports(dataset):
        sources.append(compact_source(meta))
        for row in records:
            if filter_fn and not filter_fn(row):
                continue
            value = [number(row.get(field)) if field in numeric_fields else row.get(field) for field in fields]
            key = tuple(row.get(field) for field in (key_fields or fields))
            unique_put(rows, key, value)
    output = [rows[key] for key in sorted(rows, key=lambda key: tuple('' if x is None else str(x) for x in key))]
    return save_dataset(dataset, fields, output, sources=sources, modelStatus='not_integrated', **metadata)


def price_archive():
    """Earlier raw prices plus the immutable old hourly panel, with explicit regime tags."""
    selected, sources = {'DAM': {}, 'FMM': {}}, []
    for dataset, market, value_field, minutes in [('price_dam', 'DAM', 'MW', 60), ('price_fmm', 'FMM', 'PRC', 15)]:
        for meta, rows in read_reports(dataset):
            sources.append(compact_source(meta))
            for row in rows:
                if row.get('LMP_TYPE') != 'LMP':
                    continue
                node = row['NODE']
                if node not in NODES:
                    raise ValueError('Unexpected price node')
                a, b = iso(row['INTERVALSTARTTIME_GMT']), iso(row['INTERVALENDTIME_GMT'])
                if datetime.fromisoformat(b.replace('Z', '+00:00')) - datetime.fromisoformat(a.replace('Z', '+00:00')) != timedelta(minutes=minutes):
                    raise ValueError('Price interval mismatch')
                unique_put(selected[market], (node, a), number(row.get(value_field)))
    baseline_path = ROOT / 'data/strategy-history-expanded.json'
    baseline = json.loads(baseline_path.read_text())
    rows = []
    current = datetime(2025, 10, 29, tzinfo=PT).astimezone(timezone.utc)
    stop = datetime(2026, 5, 2, tzinfo=PT).astimezone(timezone.utc)
    while current < stop:
        local = current.astimezone(PT)
        offset = local.strftime('%z')
        for node in NODES:
            da = selected['DAM'].get((node, iso(current)))
            parts = [selected['FMM'].get((node, iso(current + timedelta(minutes=15 * i)))) for i in range(4)]
            fmm = sum(parts) / 4 if all(x is not None for x in parts) else None
            rows.append({'node': node, 'startUtc': iso(current), 'endUtc': iso(current + timedelta(hours=1)),
                         'localDate': local.date().isoformat(), 'localHour': local.strftime('%H:%M'), 'utcOffset': offset[:3] + ':' + offset[3:],
                         'dam': da, 'fmm': fmm, 'fmmCount': sum(x is not None for x in parts), 'paired': da is not None and fmm is not None})
        current += timedelta(hours=1)
    rows.extend(baseline['rows'])
    fields = ['node', 'startUtc', 'endUtc', 'localDate', 'localHour', 'utcOffset', 'dam', 'fmm', 'fmmCount', 'paired', 'marketRegime']
    output = []
    for row in sorted(rows, key=lambda x: (x['startUtc'], x['node'])):
        regime = 'post_DAME_2026_05_01' if row['localDate'] >= '2026-05-01' else 'pre_DAME_2026_05_01'
        output.append([row.get(field) for field in fields[:-1]] + [regime])
    missing = sum(not row['paired'] for row in rows)
    return save_dataset('price-history-365d', fields, output, startDate='2025-10-29', endDate='2026-10-28',
                        timeZone='America/Los_Angeles', expectedNodeHours=26280, missingHourlyPairs=missing,
                        complete=missing == 0 and len(output) == 26280,
                        baselineSha256=hashlib.sha256(baseline_path.read_bytes()).hexdigest(), sources=sources,
                        modelStatus='not_integrated', classification='historical_prices_current_vintage',
                        notes=['冻结的180日价格逐值保留，新增前185日；本轮未重训模型。',
                               '跨越2026-05-01 DAME/EDAM制度边界，必须分制度评价或加入制度标识，不可无条件混训。',
                               '仅连续四个有效FMM区间才形成小时平均；夏令时按UTC保留。'])


def tradable_node_mapping(full_history=False):
    calendar, sources, values = {}, [], {}
    for meta, rows in read_reports('peak_history' if full_history else 'peak_calendar'):
        sources.append(compact_source(meta))
        for row in rows:
            if row['PEAK_FLAG'] not in ('ON', 'OFF'):
                raise ValueError('Unknown official peak flag')
            unique_put(calendar, iso(row['INTERVALSTARTTIME_GMT']), row['PEAK_FLAG'])
    reference = json.loads(gzip.decompress((OUT / 'price-components-180d.json.gz').read_bytes()))
    prices = {(row['market'], row['node'], row['startUtc']): row['lmp'] for row in reference['rows']}
    for dataset, market, value_column in [('cb_history_dam' if full_history else 'cb_tradable_dam', 'DAM', 'MW'), ('cb_history_fmm' if full_history else 'cb_tradable_fmm', 'FMM', 'PRC')]:
        for meta, rows in read_reports(dataset):
            sources.append(compact_source(meta))
            for row in rows:
                if row['LMP_TYPE'] != 'LMP':
                    continue
                if row.get('MARKET_RUN_ID') != ('DAM' if market == 'DAM' else 'RTPD'):
                    raise ValueError('Tradable node market mismatch')
                start, end, node = iso(row['INTERVALSTARTTIME_GMT']), iso(row['INTERVALENDTIME_GMT']), row['NODE']
                a, b = datetime.fromisoformat(start.replace('Z', '+00:00')), datetime.fromisoformat(end.replace('Z', '+00:00'))
                minutes = 60 if market == 'DAM' else 15
                if b - a != timedelta(minutes=minutes) or a.minute % minutes or a.second or a.microsecond:
                    raise ValueError('Tradable node interval duration/alignment mismatch')
                value = number(row[value_column])
                unique_put(values, (market, node, start), (end, value))
    fields = ['market', 'tradableNode', 'researchNode', 'startUtc', 'endUtc', 'officialPeakFlag', 'lmp', 'researchLmp', 'difference', 'calendarNodeMatch', 'priceMatchesReference', 'mappingStatus']
    output, mismatch, missing_reference, deltas = [], 0, 0, []
    expected_keys, expected_hours = set(), set()
    current = datetime(2026, 5, 2, tzinfo=PT) if full_history else datetime(2026, 10, 15, tzinfo=PT)
    current = current.astimezone(timezone.utc)
    stop = datetime(2026, 10, 29, tzinfo=PT).astimezone(timezone.utc)
    while current < stop:
        expected_hours.add(iso(current))
        for market, minutes in [('DAM', 60), ('FMM', 15)]:
            for hub in HUBS:
                for step in range(60 // minutes):
                    expected_keys.add((market, 'TH_' + hub + '_GEN-APND', iso(current + timedelta(minutes=step * minutes))))
        current += timedelta(hours=1)
    actual_keys, missing_tradable = set(), 0
    for (market, node, start), (end, value) in sorted(values.items()):
        moment = datetime.fromisoformat(start.replace('Z', '+00:00'))
        peak = calendar.get(iso(moment.replace(minute=0)))
        if peak is None:
            raise ValueError('Missing official calendar hour')
        expected_suffix = '_' + peak + 'PEAK-APND'
        calendar_match = node.endswith(expected_suffix)
        mismatch += not calendar_match
        refnode = node.replace('_ONPEAK', '').replace('_OFFPEAK', '')
        reference_value = prices.get((market, refnode, start))
        actual_keys.add((market, refnode, start))
        missing_tradable += value is None
        missing_reference += reference_value is None
        delta = value - reference_value if value is not None and reference_value is not None else None
        if delta is not None:
            deltas.append(abs(delta))
        price_match = abs(delta) <= 0.000100001 if delta is not None else None
        row_status = 'calendar_conflict' if not calendar_match else ('missing_price' if price_match is None else ('price_conflict' if not price_match else 'consistent_sample'))
        output.append([market, node, refnode, start, end, peak, value, reference_value, delta, calendar_match, price_match, row_status])
    counts = Counter(row[0] for row in output)
    missing_intervals = len(expected_keys - actual_keys)
    unexpected_intervals = len(actual_keys - expected_keys)
    calendar_missing = len(expected_hours - set(calendar))
    duplicate_mapped = len(output) - len(actual_keys)
    complete = not any([missing_intervals, unexpected_intervals, missing_tradable, missing_reference, calendar_missing, mismatch, duplicate_mapped])
    prices_beyond_tolerance = sum(x > 0.000100001 for x in deltas)
    mapping_verified = complete and prices_beyond_tolerance == 0
    return save_dataset('tradable-node-map-180d' if full_history else 'tradable-node-map-14d', fields, output,
        startDate='2026-05-02' if full_history else '2026-10-15', endDate='2026-10-28', sources=sources, marketCounts=dict(counts),
        expectedNativeIntervals=64800 if full_history else 5040,
        officialCalendarHours=len(calendar), peakMappingMismatches=mismatch,
        complete=complete, missingSourceIntervals=missing_intervals, unexpectedSourceIntervals=unexpected_intervals,
        missingTradablePrices=missing_tradable, missingCalendarHours=calendar_missing,
        duplicateMappedIntervals=duplicate_mapped,
        mappingConflictExamples=[dict(zip(fields, row)) for row in output if not row[1].endswith('_' + row[5] + 'PEAK-APND')][:10],
        missingResearchPrices=missing_reference, maximumPriceDifference=max(deltas) if deltas else None,
        comparisonTolerance=0.0001, pricesBeyondTolerance=prices_beyond_tolerance, mappingVerified=mapping_verified,
        classification='sample_verified_node_and_price_mapping' if mapping_verified else 'incomplete_or_conflicting_node_and_price_mapping', modelStatus='not_integrated',
        rowStatusCounts=dict(Counter(row[-1] for row in output)),
        notes=['保留六个ON/OFFPEAK节点实际返回的时段，不按日历强行改名或填零；与官方日历不一致的记录标记calendar_conflict。',
               'consistent_sample只表示该行日历及价格一致，不等于账户或订单已获申报许可。',
               '价格映射核验仅对实际取得的日期有效；限额和账户资格仍须单独验证。'])


def edam_history():
    fields = ['sourceMessageTimeUtc', 'startUtc', 'endUtc', 'baa', 'solarMw', 'windMw', 'researchCutoffUtc', 'messageBeforeCutoff', 'sourceFile']
    values, sources, source_dates, messages, baas = {}, [], set(), set(), set()
    for meta, records in read_reports('edam_history'):
        sources.append(compact_source(meta))
        for row in records:
            start, end = iso(row['INTERVAL_START_GMT']), iso(row['INTERVAL_END_GMT'])
            a, b = datetime.fromisoformat(start.replace('Z', '+00:00')), datetime.fromisoformat(end.replace('Z', '+00:00'))
            if b - a != timedelta(hours=1) or a.minute or a.second or a.microsecond:
                raise ValueError('EDAM forecast must contain aligned UTC hourly intervals')
            msg = iso(row['_SOURCE_MESSAGE_TIME'])
            target = datetime.fromisoformat(start.replace('Z', '+00:00')).astimezone(PT).date()
            cutoff = datetime.combine(target - timedelta(days=1), datetime.min.time(), PT).replace(hour=9, minute=55)
            if row['BAA_GRP_ID'] == 'CISO':
                source_dates.add(str(target))
            messages.add(msg)
            baas.add(row['BAA_GRP_ID'])
            item = [msg, start, end, row['BAA_GRP_ID'], number(row.get('SOLAR')), number(row.get('WIND')), iso(cutoff), msg < iso(cutoff), row['_SOURCE_FILE']]
            unique_put(values, (msg, start, row['BAA_GRP_ID']), item)
    rows = [values[key] for key in sorted(values)]
    ciso_rows = [row for row in rows if row[3] == 'CISO']
    expected_hours, current = set(), datetime(2026, 5, 2, tzinfo=PT).astimezone(timezone.utc)
    stop = datetime(2026, 10, 29, tzinfo=PT).astimezone(timezone.utc)
    while current < stop:
        expected_hours.add(iso(current)); current += timedelta(hours=1)
    actual_hours = {row[1] for row in ciso_rows}
    missing_hours, extra_hours = len(expected_hours - actual_hours), len(actual_hours - expected_hours)
    missing_values = sum(row[j] is None for row in ciso_rows for j in [4, 5])
    return save_dataset('edam-wind-solar-vintages', fields, rows, sources=sources,
        cisoRows=len(ciso_rows), cisoDays=len(source_dates), cisoDates=sorted(source_dates),
        messageCount=len(messages), cisoMessageCount=len({row[0] for row in ciso_rows}), baas=sorted(baas),
        cisoRowsBeforeCutoff=sum(row[7] for row in ciso_rows),
        cisoMessageCountBeforeCutoff=len({row[0] for row in ciso_rows if row[7]}),
        distinctCisoHours=len(actual_hours), expectedCisoHours=len(expected_hours), missingCisoHours=missing_hours, unexpectedCisoHours=extra_hours,
        hourlyCoverageComplete=not any([missing_hours, extra_hours, missing_values]),
        missingCisoValues=missing_values,
        classification='source_timestamped_historical_forecast_files', modelStatus='not_integrated',
        notes=['历史消息时间由各官方XML文件提供，和本次下载时间分开存储。',
               '研究截点逐交易日按D−1 09:55 America/Los_Angeles计算，不固定UTC偏移。',
               'messageBeforeCutoff=false的记录晚于该研究截点，不得作为该次预测的事前输入；XML消息时间也不等于已验证的公开可用时间。',
               '保留OASIS本次返回的文件；尚未证明全部半小时发行或修订版本被保留，也不宣称首次发布。'])


def main():
    summaries = [forecast_panel()]
    summaries.append(generic_dataset('fuel_prices', ['INTERVALSTARTTIME_GMT', 'INTERVALENDTIME_GMT', 'FUEL_REGION_ID', 'PRC'],
        key_fields=['INTERVALSTARTTIME_GMT', 'FUEL_REGION_ID'], numeric_fields=['PRC'],
        unit='USD/MMBtu', intervalMinutes=60, classification='historical_fuel_price_index_current_vintage',
        notes=['燃料区索引，不是每个发电机的实际购气合同成本。区域对照另见fuel-region-map；历史发布时间未恢复。']))
    summaries.append(generic_dataset('ghg_allowance', ['INTERVALSTARTTIME_GMT', 'INTERVALENDTIME_GMT', 'GHG_PRC_IDX'],
        key_fields=['INTERVALSTARTTIME_GMT'], numeric_fields=['GHG_PRC_IDX'], unit='USD/metric_ton_CO2e',
        classification='historical_ghg_price_index_current_vintage', notes=['OASIS排放配额价格索引；不是节点LMP中的MGHG分量。']))
    summaries.append(generic_dataset('generation_outages', ['REPORT_DATE_GMT', 'INTERVALSTARTTIME_GMT', 'INTERVALENDTIME_GMT', 'TRADING_HUB', 'FUEL_CATEGORY', 'MW'],
        key_fields=['REPORT_DATE_GMT', 'INTERVALSTARTTIME_GMT', 'TRADING_HUB', 'FUEL_CATEGORY'], numeric_fields=['MW'],
        filter_fn=lambda row: row['TRADING_HUB'] in HUBS, unit='MW', classification='one_report_outage_schedule',
        notes=['仅取NP15/SP15/ZP26；报告日2026-10-28，包含未来计划，不是未来实际。',
               'REPORT_DATE_GMT保留报表日期，不推断为实际发布时刻。Aggregate与各燃料子项不得重复相加。']))
    summaries.append(generic_dataset('transmission_usage', ['INTERVALSTARTTIME_GMT', 'INTERVALENDTIME_GMT', 'MARKET_RUN_ID', 'TI_ID', 'TI_DIRECTION', 'TI_CONSTRAINT_ID', 'TR_TYPE', 'LABEL', 'MW'],
        numeric_fields=['MW'], unit='MW', classification='day_ahead_interface_usage',
        notes=['计划/限额/余量由TR_TYPE及LABEL区分，不能将所有行相加当成净进口。没有逐版本发布时间。']))
    summaries.append(generic_dataset('publication_log', ['PUBLICATION_ID', 'PUBLICATION_DATE_GMT', 'REPORT_NAME', 'MARKET_RUN_ID', 'INTERVAL_START_GMT', 'INTERVAL_END_GMT', 'ATLPUBVERSION', 'STATUS'],
        classification='source_publication_event_log',
        notes=['真实源发布事件，不等于下载时间。日志未包含对应完整数值快照，不能单凭它把当前历史值标成当时发行值。']))
    summaries.append(generic_dataset('cb_nodes', ['NODE_ID', 'TIE', 'CB_START_EFFECTIVE_DATE_GMT', 'CB_END_EFFECTIVE_DATE_GMT'],
        classification='convergence_bidding_node_eligibility_snapshot',
        notes=['资格列表需结合交易日有效期；不代表账户已获交易授权或信用额度。']))
    if list(read_reports('peak_calendar')):
        metas = list(read_reports('peak_calendar'))
        fields = sorted({field for _, records in metas for row in records for field in row})
        summaries.append(generic_dataset('peak_calendar', fields, classification='official_wecc_peak_calendar'))
    if list(read_reports('edam_renewables')):
        summaries.append(generic_dataset('edam_renewables', ['_SOURCE_MESSAGE_TIME', 'INTERVAL_START_GMT', 'INTERVAL_END_GMT', 'BAA_GRP_ID', 'SOLAR', 'WIND', '_SOURCE_FILE'],
            numeric_fields=['SOLAR', 'WIND'], unit='MW', classification='edam_forecast_xml_snapshot',
            notes=['源XML MessageHeader.TimeDate单独保存，需验证其与下载生成时间及历史发行批次的关系。']))
    for dataset in ['cb_group_limits', 'cb_system_awards', 'frp_nodal', 'frp_nodal_selected']:
        reports = list(read_reports(dataset))
        if reports:
            fields = sorted({field for _, records in reports for row in records for field in row})
            summaries.append(generic_dataset(dataset, fields, classification='public_market_report_sample'))
    if list(read_reports('cb_tradable_dam')) and list(read_reports('cb_tradable_fmm')):
        summaries.append(tradable_node_mapping())
    if len(list(read_reports('cb_history_dam'))) == 6 and len(list(read_reports('cb_history_fmm'))) == 6 and len(list(read_reports('peak_history'))) == 6:
        summaries.append(tradable_node_mapping(full_history=True))
    if list(read_reports('edam_history')):
        summaries.append(edam_history())
    # A complete seasonal delivery is published only after corresponding downloads exist.
    if len(list(read_reports('price_dam'))) == 7 and len(list(read_reports('price_fmm'))) == 7:
        summaries.append(price_archive())
    attempts = []
    for path in sorted(CACHE.glob('*.json')):
        meta = json.loads(path.read_text())
        if 'dataset' in meta:
            attempts.append({key: meta.get(key) for key in ['id', 'dataset', 'url', 'status', 'rowCount', 'bytes', 'sha256', 'fetchedAt', 'error', 'redirectLocation']})
    atomic_json(OUT / 'acquisition-audit.json', {'schemaVersion': 1, 'generatedAt': stamp(),
        'datasets': summaries, 'attempts': attempts,
        'policy': 'Downloaded data and historical availability evidence are separate. Existing experiments are immutable.'})
    print(json.dumps({'datasets': [{k: v.get(k) for k in ['dataset', 'rows', 'bytes', 'missingByField', 'complete', 'missingHourlyPairs']} for v in summaries]}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
