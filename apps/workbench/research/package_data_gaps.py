#!/usr/bin/env python3
"""Package existing data-gap artifacts with strict allowlists and byte manifests.

Creates two independent ZIPs. No API calls, model changes or catalog rewrites.
Default output is a working snapshot; use --final only after collection/build/QA.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
import stat
import tempfile
from urllib.parse import urlsplit
import zipfile

from inspect_data_gaps import DATA, LIMIT_BYTES, safe_member, sha256, verify_archive

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path('.sites-runtime/gap-acquisition')
RAW_NAME = 'oasis-public-responses.zip'
DELIVERY_NAME = 'caiso-data-gap-delivery.zip'
RAW_MANIFEST = 'oasis-public-responses-manifest.json'
RAW_README = 'OASIS_PUBLIC_RESPONSES_README.md'
SCRIPTS = (
    'fetch_missing_data.py', 'build_missing_data.py', 'build_data_gap_catalog.py',
    'verify_missing_forecasts.mjs', 'test_missing_data_integrity.py',
    'recover_price_components.py', 'test_recover_price_components.py',
    'fetch_weather_nws.py', 'fetch_weather_single_run.py',
    'fetch_generator_outage_samples.py', 'normalize_generator_outage_samples.py',
    'fetch_fuel_region_mapping.py', 'build_weather_evidence.py', 'verify_weather_evidence.py',
    'package_data_gaps.py', 'inspect_data_gaps.py',
)
LIBS = ('types.ts', 'oasis.ts', 'data-types.ts', 'fundamentals-types.ts', 'fundamentals.ts')
EVIDENCE = ('settlement-evidence/download-evidence.zip', 'weather-evidence/weather-outage-evidence.zip')
REQUIRED_DATA = (
    'catalog.json', 'DATA_GAPS_README.md', 'acquisition-audit.json',
    'official-forecast-history-180d.json.gz', 'forecast-history-verification.json',
    'price-components-180d.json.gz', 'price-components-audit.json',
    'price-history-365d.json.gz', 'price-history-365d-audit.json',
    'tradable-node-map-180d.json.gz', 'tradable-node-map-180d-audit.json',
    'node-mapping-discrepancies.json', 'edam-wind-solar-vintages.json.gz',
)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


class Snapshot:
    def __init__(self, root):
        self.root = root.resolve()
        self.observed = {}

    def read(self, relative):
        name = safe_member(Path(relative).as_posix())
        path = self.root / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(self.root):
            raise ValueError('Expected a regular in-project source file: ' + name)
        before = path.stat()
        raw = path.read_bytes()
        after = path.stat()
        signature = lambda item: (item.st_ino, item.st_size, item.st_mtime_ns)
        if signature(before) != signature(after) or len(raw) != after.st_size:
            raise ValueError('Source changed while being read; retry packaging: ' + name)
        self.observed[name] = signature(after)
        return raw

    def changed(self):
        changed = []
        for name, signature in self.observed.items():
            path = self.root / name
            if not path.exists():
                changed.append(name)
            else:
                item = path.stat()
                if signature != (item.st_ino, item.st_size, item.st_mtime_ns):
                    changed.append(name)
        return changed


def receipt_paths(root):
    # Campaign progress JSON and every other runtime directory are excluded.
    pattern = re.compile(r'^[A-Za-z0-9_-]+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$')
    return sorted(path for path in (root / CACHE).glob('*.json') if pattern.fullmatch(path.name))


def collect_responses(snapshot):
    members, receipts = {}, {}
    unbound, missing_raw, status_counts, dataset_counts = [], [], Counter(), Counter()
    paths = receipt_paths(snapshot.root)
    for path in paths:
        relative = path.relative_to(snapshot.root)
        raw_receipt = snapshot.read(relative)
        receipt = json.loads(raw_receipt)
        if receipt.get('id') != path.stem or not isinstance(receipt.get('dataset'), str):
            raise ValueError('Unexpected per-request receipt: ' + path.name)
        raw_name = safe_member(receipt.get('rawFile', ''))
        if raw_name != path.stem + '.zip':
            raise ValueError('Receipt points outside its exact response basename')
        url = urlsplit(receipt.get('url', ''))
        if url.scheme != 'https' or url.netloc != 'oasis.caiso.com' or url.path not in ('/oasisapi/SingleZip', '/oasisapi/GroupZip'):
            raise ValueError('Receipt is not a public OASIS endpoint')
        members[relative.as_posix()] = raw_receipt
        receipts[receipt['id']] = receipt
        status_counts[receipt.get('status', 'unknown')] += 1
        dataset_counts[receipt['dataset']] += 1
        raw_path = CACHE / raw_name
        if (snapshot.root / raw_path).is_file():
            response = snapshot.read(raw_path)
            if receipt.get('sha256') is not None:
                if sha256(response) != receipt['sha256'] or len(response) != receipt.get('bytes'):
                    raise ValueError('Response bytes disagree with receipt: ' + raw_name)
            elif receipt.get('status') == 'downloaded':
                raise ValueError('Successful receipt lacks a response SHA: ' + path.name)
            else:
                unbound.append(raw_name)
            members[raw_path.as_posix()] = response
        else:
            if receipt.get('status') == 'downloaded' or receipt.get('sha256'):
                raise ValueError('Receipt-bound raw response is missing: ' + raw_name)
            missing_raw.append(raw_name)
    if not receipts:
        raise ValueError('No public acquisition receipts found')
    included = {Path(name).name for name in members if name.endswith('.zip')}
    orphaned = sorted(path.name for path in (snapshot.root / CACHE).glob('*.zip') if path.name not in included)
    metadata = {
        'receiptCount': len(receipts), 'rawResponseCount': len(included),
        'statusCounts': dict(sorted(status_counts.items())), 'datasetReceiptCounts': dict(sorted(dataset_counts.items())),
        'failedReceiptsWithoutSavedResponse': missing_raw,
        'rawFilesNotBoundByReceiptHash': unbound,
        'excludedUnreceiptedRawFiles': orphaned,
        'sourceScope': 'Only direct raw.zip / per-request receipt.json files from this gap-acquisition campaign; failed receipts are included.',
        'excludedScope': 'Other runtime directories, campaign-progress JSON, credentials, sessions, node_modules, and the 52 older native-price source caches are not included.',
    }
    return members, receipts, metadata, [path.name for path in paths]


def validate_data_links(members, receipts):
    """Bind delivered table audits to captured files and newly archived sources."""
    linked_sources, older_sources = set(), set()
    audit_checks = 0
    for name, raw in members.items():
        if name.startswith(DATA.as_posix() + '/') and name.endswith('.json.gz'):
            payload = json.loads(gzip.decompress(raw))
            for source in payload.get('sources', []):
                source_id = source.get('id')
                if Path(name).name == 'price-components-180d.json.gz':
                    older_sources.add(source_id)
                    continue
                if source_id not in receipts or source.get('sha256') != receipts[source_id].get('sha256'):
                    raise ValueError('Delivered table source is missing/different in the new raw package: ' + str(source_id))
                linked_sources.add(source_id)
        if not name.endswith('-audit.json') or '/' in name.removeprefix(DATA.as_posix() + '/'):
            continue
        audit = json.loads(raw)
        download = audit.get('download')
        if isinstance(download, dict):
            href, expected_hash, expected_bytes = download.get('path'), download.get('sha256'), download.get('bytes')
        else:
            href, expected_hash, expected_bytes = download, audit.get('sha256'), audit.get('bytes')
        if isinstance(href, str) and href.startswith('/data/data-gaps/') and expected_hash:
            target = 'public' + href
            if target not in members or sha256(members[target]) != expected_hash or len(members[target]) != expected_bytes:
                raise ValueError('Normalized file differs from its audit; finish the build first: ' + target)
            audit_checks += 1
    return {'normalizedFileAuditHashesChecked': audit_checks,
            'newSourceReceiptsReferencedByTables': len(linked_sources),
            'olderNativePriceSourceReferencesNotRepackaged': len(older_sources),
            'reproductionLimit': 'The frozen hourly baseline and recovered native-price table are included; the older native-price source caches are not. Native-component recovery from those older sources cannot be rerun solely from this delivery.'}


def collect_delivery(snapshot, receipts):
    members = {}
    directory = snapshot.root / DATA
    for filename in REQUIRED_DATA:
        if not (directory / filename).is_file():
            raise ValueError('Required data delivery file is missing: ' + filename)
    for path in sorted(directory.iterdir()):
        if path.is_file() and (path.name.endswith('.json') or path.name.endswith('.json.gz') or path.name.endswith('.md')):
            relative = path.relative_to(snapshot.root)
            members[relative.as_posix()] = snapshot.read(relative)
    evidence_checks = []
    for filename in EVIDENCE:
        relative = DATA / filename
        evidence_checks.append(verify_archive(snapshot.root / relative))
        members[relative.as_posix()] = snapshot.read(relative)
    for filename in SCRIPTS:
        relative = Path('research') / filename
        members[relative.as_posix()] = snapshot.read(relative)
    for filename in LIBS:
        relative = Path('lib') / filename
        members[relative.as_posix()] = snapshot.read(relative)
    baseline = Path('data/strategy-history-expanded.json')
    members[baseline.as_posix()] = snapshot.read(baseline)
    dependencies = {'fflate': '0.8.2', 'typescript': '5.9.3'}
    project = json.loads(snapshot.read(Path('package.json')))
    for name, version in dependencies.items():
        installed_spec = (project.get('dependencies', {}) | project.get('devDependencies', {})).get(name)
        if installed_spec != version:
            raise ValueError(f'Update the minimal verification dependency pin for {name}: {installed_spec}')
    members['package.json'] = encoded({
        'name': 'caiso-data-gap-verification', 'version': '1.0.0', 'private': True, 'type': 'module',
        'engines': {'node': '>=18'}, 'scripts': {'verify:forecasts': 'node research/verify_missing_forecasts.mjs'},
        'dependencies': dependencies,
    })
    members['requirements-optional.txt'] = (
        '# Core reader, packager, OASIS builder and integrity tests use only Python 3.11+ stdlib.\n'
        '# Needed only to re-fetch/extract CAISO XLSX weather/outage/fuel-region evidence.\n'
        'openpyxl==3.1.5\n'
    ).encode()
    return members, {'evidencePackages': evidence_checks, **validate_data_links(members, receipts)}


def raw_readme(summary, label):
    return f'''# 本轮 OASIS 原始响应与回执

快照标签：{label}。包含 {summary['receiptCount']} 份逐请求回执、{summary['rawResponseCount']} 份已保存响应；失败回执也保留。

仅收录本轮 gap-acquisition 的直接响应和回执；不包含其他运行环境文件。HTTP 200、ZIP后缀或存在文件都不表示业务成功，须查看回执 status/error。失败时可能没有响应正文。

解压到代码交付包同一根目录，即恢复脚本需要的原始响应位置。{RAW_MANIFEST} 对全部负载文件列出 SHA-256 和字节数；清单自身不进行不可能的自哈希，整个 ZIP 的 SHA-256 由打包命令输出。

本包不包含原有52份价格源缓存；不能据此声称旧180天原生价格分量已经从全部旧源完整重现。新采集源可以复核；旧原生价格规范化表及其审计由 companion delivery 包提供。

```bash
python research/inspect_data_gaps.py verify /path/to/oasis-public-responses.zip
python research/inspect_data_gaps.py qa-nodes
```

快照不等于所有数据缺口已解决，也不等于历史可用时间已得到证明。
'''.encode()


def delivery_readme(summary, label, generated):
    return f'''# CAISO 本次数据补齐交付

生成于 {generated}；快照标签：**{label}**。完整业务说明和数据目录见 `public/data/data-gaps/DATA_GAPS_README.md` 与 `catalog.json`。

## 两个包分别包含什么

- `caiso-data-gap-delivery.zip`：规范化 JSON/GZ、审计与冲突报告、必要读取/采集/整理/验证代码、冻结的180天小时价格基线、5个既有 TypeScript 标准化模块，以及最小依赖说明。
- `oasis-public-responses.zip`：本轮 {summary['receiptCount']} 份公开 OASIS 请求回执及 {summary['rawResponseCount']} 份已保存响应，包括失败记录。只取本轮公开采集目录，没有其他运行环境文件。

两个 ZIP 均小于25 MiB。每包的清单包含全部负载文件的 SHA-256 与字节数；清单自身除外，整个 ZIP 的 SHA-256 由打包命令输出。路径、大小与ZIP CRC均校验。天气和结算证据各保留一个嵌套 ZIP，官方原件不重复铺开。

## 解压与基本复核

在一个空工作目录保存两个 ZIP，然后执行：

```bash
python -m zipfile -e caiso-data-gap-delivery.zip caiso-data-gap
python caiso-data-gap/research/inspect_data_gaps.py verify caiso-data-gap-delivery.zip oasis-public-responses.zip
python -m zipfile -e oasis-public-responses.zip caiso-data-gap
cd caiso-data-gap
python research/inspect_data_gaps.py list
python research/inspect_data_gaps.py head official-forecast-history-180d --limit 3
python research/inspect_data_gaps.py head tradable-node-map-180d --limit 3
python -m unittest discover -s research -p test_missing_data_integrity.py -v
python research/inspect_data_gaps.py qa-nodes
```

`qa-nodes`直接用标准库读原始ZIP/CSV，独立比较官方峰谷日历、实际返回的节点与已交付原生参考价格，不导入新整理器。它核对交付的冲突报告；成功表示报告复核一致，**不表示节点冲突已解决或已获交易授权**。全部布尔、null和原始符号按声明字段保留。

## 独立 TypeScript 全值核验

需要 Node.js 18+。包内最小package.json只固定 `fflate@0.8.2` 与 `typescript@5.9.3`，不安装完整网站依赖。依赖安装需要网络，核验本身离线。

```bash
npm install --ignore-scripts
node research/verify_missing_forecasts.mjs
```

该核验重读24份本轮预测响应，经过既有 TypeScript 标准化逻辑比较180天预测面板。它会在解压副本更新核验JSON，不改模型。

## 天气与结算证据

读取器可直接从嵌套ZIP读取JSON，例如：

```bash
python research/inspect_data_gaps.py head weather-evidence/generator-outages-am-20261029.json --limit 3
python research/inspect_data_gaps.py verify public/data/data-gaps/weather-evidence/weather-outage-evidence.zip public/data/data-gaps/settlement-evidence/download-evidence.zip
```

如需打开原件、运行天气核验或重新生成目录，先解压两份证据包到各自目录：

```bash
python -m zipfile -e public/data/data-gaps/weather-evidence/weather-outage-evidence.zip public/data/data-gaps/weather-evidence
python -m zipfile -e public/data/data-gaps/settlement-evidence/download-evidence.zip public/data/data-gaps/settlement-evidence
python research/verify_weather_evidence.py
```

## 可重建范围与限制

解压两包及证据后可运行 `python research/build_missing_data.py`、`python research/build_data_gap_catalog.py`。这些命令重建本次新增表，不会训练模型。生成时间更新会改变压缩字节；需按字段和数值核验，不能要求重建ZIP与原包逐字节相同。

包含 `data/strategy-history-expanded.json` 作为原有180天小时基线，包含 `price-components-180d.json.gz` 作为已经回收的原生价格分量。**本轮原始包没有复制原有52份价格源缓存**，因此 `recover_price_components.py` 是方法代码，不可仅凭这两包重新恢复全部旧源；它需要原项目中相应旧缓存及bootstrap。本文不声称全应用、冻结模型和全部历史源都已打包。

预测当前历史值、XML源消息时间、模型初始化时间和原始可公开时间是不同概念。读取、哈希通过、字段齐全和消息早于截点都不自动批准因果回测。节点冲突、完整结算/FM、费用及账户资料的限制继续生效。

## 再采集和再次打包

在线采集代码保留原限流；运行 fetch 脚本会请求公开服务。只做离线核验无需运行它们。核心Python工具仅需Python3.11+标准库和IANA时区库；重取XLSX才需要 `pip install -r requirements-optional.txt`，缺IANA时区的系统可安装 `tzdata`。

```bash
python research/package_data_gaps.py --output-dir /path/to/trial-packages
# 收集、整理、QA结束且源文件静止后，再由交付负责人执行：
python research/package_data_gaps.py --final
```

`--final`要求打包过程中源文件和请求回执列表保持稳定；它标记本次交付快照，不宣称所有研究缺口已补齐。
'''.encode()


def prepare_archive(target, members, metadata, manifest_name='manifest.json'):
    target.parent.mkdir(parents=True, exist_ok=True)
    entries = [{'path': safe_member(name), 'bytes': len(raw), 'sha256': sha256(raw)}
               for name, raw in sorted(members.items())]
    manifest = {'schemaVersion': 1, **metadata, 'files': entries,
                'manifestHashPolicy': 'The manifest itself is excluded from its own file list; the complete ZIP SHA is returned by the packaging command.'}
    payloads = dict(members)
    payloads[manifest_name] = encoded(manifest)
    handle = tempfile.NamedTemporaryFile(prefix=target.stem + '-', suffix='.zip.part', dir=target.parent, delete=False)
    temporary = Path(handle.name)
    handle.close()
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, raw in sorted(payloads.items()):
                info = zipfile.ZipInfo(safe_member(name), date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                compression = zipfile.ZIP_STORED if name.endswith(('.zip', '.gz')) else zipfile.ZIP_DEFLATED
                archive.writestr(info, raw, compress_type=compression, compresslevel=9)
        checked = verify_archive(temporary, maximum_bytes=LIMIT_BYTES)
        checked['archive'] = target.name
        return temporary, checked
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, default=ROOT)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--final', action='store_true', help='Require a stable collection/build snapshot before publication')
    args = parser.parse_args()
    root = args.repo_root.resolve()
    output = args.output_dir.resolve() if args.output_dir else root / DATA
    generated = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    label = 'delivery-snapshot' if args.final else 'working-snapshot-not-final'
    snapshot = Snapshot(root)
    raw_members, receipts, raw_summary, initial_receipts = collect_responses(snapshot)
    delivery_members, delivery_summary = collect_delivery(snapshot, receipts)
    raw_members[RAW_README] = raw_readme(raw_summary, label)
    delivery_members['README.md'] = delivery_readme(raw_summary, label, generated)
    common = {'generatedAtUtc': generated, 'snapshotLabel': label, 'maximumArchiveBytesExclusive': LIMIT_BYTES}
    pending = []
    try:
        raw_tmp, raw_check = prepare_archive(output / RAW_NAME, raw_members,
            {**common, 'packageKind': 'new-public-oasis-responses', **raw_summary}, RAW_MANIFEST)
        pending.append(raw_tmp)
        delivery_tmp, delivery_check = prepare_archive(output / DELIVERY_NAME, delivery_members,
            {**common, 'packageKind': 'normalized-data-and-verification-code', **delivery_summary,
             'companionRawArchive': raw_check})
        pending.append(delivery_tmp)
        changed = snapshot.changed()
        new_receipts = [path.name for path in receipt_paths(root)] != initial_receipts
        if args.final and (changed or new_receipts or raw_summary['excludedUnreceiptedRawFiles']):
            raise ValueError('Collection/build is not stable; finish it before --final: ' + json.dumps({
                'changedFiles': changed, 'receiptListChanged': new_receipts,
                'unreceiptedRawFiles': raw_summary['excludedUnreceiptedRawFiles']}))
        raw_tmp.replace(output / RAW_NAME)
        delivery_tmp.replace(output / DELIVERY_NAME)
        print(json.dumps({'snapshotLabel': label, 'outputDirectory': str(output),
                          'archives': [raw_check, delivery_check], 'sourceFilesChangedDuringPackaging': changed,
                          'receiptListChangedDuringPackaging': new_receipts,
                          'receiptCount': raw_summary['receiptCount'], 'rawResponseCount': raw_summary['rawResponseCount'],
                          'normalizedFileAuditHashesChecked': delivery_summary['normalizedFileAuditHashesChecked'],
                          'olderNativePriceSourceReferencesNotRepackaged': delivery_summary['olderNativePriceSourceReferencesNotRepackaged'],
                          'allArchiveChecksPassed': True}, ensure_ascii=False, indent=2))
    finally:
        for path in pending:
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
