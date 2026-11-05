#!/usr/bin/env python3
"""Package the bounded current-data forecast and its exact runnable inputs."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data/forecast-lab/v4'


def main() -> None:
    report = json.loads((OUT / 'report.json').read_text())
    forecast = json.loads((OUT / 'forecast-forward.json').read_text())
    embedded = json.loads((OUT / 'embedded-data.json').read_text())
    simulation = json.loads((OUT / 'simulation-summary.json').read_text())
    if not (report['modelVersion'] == forecast['modelVersion'] == embedded['meta']['modelVersion']):
        raise ValueError('Model versions differ')
    if not (forecast['digest'] == embedded['meta']['forecastDigest'] == simulation['forecastDigest']):
        raise ValueError('Forecast digests differ')
    if hashlib.sha256((OUT / 'input-price-history.json.gz').read_bytes()).hexdigest() != report['sample']['inputSha256']:
        raise ValueError('Packaged training input is not the actual model input')
    if not forecast['points'] or any(p[k] is not None for p in forecast['points'] for k in ['actualDa', 'actualFmm', 'actualSpread']):
        raise ValueError('Future actuals must be unknown')

    files: dict[str, bytes] = {}
    for name in ['current_data_pipeline.py', 'test_current_data_pipeline.py', 'forecast_pipeline.py',
                 'build_strategy_input.py', 'trading_strategy.py', 'requirements.txt', 'build_current_release.py']:
        files['research/' + name] = (ROOT / 'research' / name).read_bytes()
    for path in sorted(OUT.iterdir()):
        if path.is_file() and path.suffix in {'.json', '.csv', '.py', '.gz'} and path.name != 'release-manifest.json':
            files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for directory in [ROOT / 'public/data/current-inputs', ROOT / 'research/current_data_acquisition']:
        if directory.exists():
            for path in sorted(directory.rglob('*')):
                if path.is_file() and '__pycache__' not in path.parts and path.suffix in {'.json', '.gz', '.zip', '.xml', '.txt', '.md', '.py'}:
                    files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    selected, baseline = report['holdout']['selected'], report['holdout']['baseline']
    target = report['forecast']['targetDate']
    readme = f'''# CAISO 当前数据预测 V4

本包包含实际运行的预测结果、固定输入、训练流程和模拟程序。无需采购数据、提供 API Key 或等待其他来源；离线重放模拟只依赖 Python 标准库。

## 本次结果

- 模型版本：`{report['modelVersion']}`
- 真实生成时间：`{report['generatedAt']}` UTC
- 预测交易日：**{target}，America/Los_Angeles**
- 价格输入：{report['sample']['startDate']}—{report['sample']['endDate']} PT，{report['sample']['days']} 天，{report['sample']['rows']:,} 节点小时
- 历史特征和训练标签截止：D−{report['method']['featureDelayDays']}；未来实际值保留 null。
- 日前模型：{report['selectedModels']['da']['label']}；价差模型：{report['selectedModels']['spread']['label']}。

| 已见历史开发评估 | 本模型 MAE | 预声明基线 MAE |
|---|---:|---:|
| DA，美元/MWh | {selected['da']['mae']:.6f} | {baseline['da']['mae']:.6f} |
| FMM−DA，美元/MWh | {selected['spread']['mae']:.6f} | {baseline['spread']['mae']:.6f} |

选型、校准和评估窗口由 protocol.json 固定，选型只看较早验证期 MAE，未按最终模拟收益更换参数。历史窗口包含此前已查看日期，因此不称新的独立测试。未来预测才可在实际价格到齐后追加评价。

## 先直接运行模拟

从解压后的根目录运行：

```bash
python research/trading_strategy.py --data public/data/forecast-lab/v4/embedded-data.json --date {target} --strategy normal --k 0.5 --fee-per-mwh 1 --output forward-result.json
```

历史开发评估使用同一固定费用情景：

```bash
python research/trading_strategy.py --data public/data/forecast-lab/v4/holdout-input.json --strategy normal --k 0.5 --fee-per-mwh 1 --output development-result.json
```

费用是每模拟成交 MWh 1 美元的情景值，不代表完整 CAISO 账户结算。前向计划没有真实成交和真实收益，结果为空是正确行为。程序不向市场提交报价。

## 查看结果和输入

| 文件 | 用途 |
|---|---|
| public/data/forecast-lab/v4/forward-predictions.csv | 本次未来逐小时 DA、FMM、价差与已估计区间 |
| public/data/forecast-lab/v4/forecast-forward.json | 带真实发布时间、模型版本和内容摘要的预测 |
| public/data/forecast-lab/v4/embedded-data.json | 模拟程序兼容输入：meta、nodes、series、provenance |
| public/data/forecast-lab/v4/report.json | 选型、误差、区间覆盖和时间窗口 |
| public/data/forecast-lab/v4/protocol.json | 固定的候选、选择规则与运行协议 |
| public/data/forecast-lab/v4/input-price-history.json.gz | 实际进入模型的完整价格输入 |
| public/data/current-inputs/ | 本轮免费补取的公开数据和回执，EIA仅作研究参考 |
| release-manifest.json | 包内每个文件的 SHA-256 |

sampleCount 表示起点可用的监督标签行数；每个滑窗候选实际使用的训练行数见 report.method.fitAudit，不把全部历史数当成滑窗拟合数。

## 重新训练

训练需要 research/requirements.txt 中的依赖。先安装后可执行同一协议；使用新输出目录可保留交付结果：

```bash
python -m pip install -r research/requirements.txt
python research/current_data_pipeline.py --input public/data/forecast-lab/v4/input-price-history.json.gz --output rerun-v4 --forecast-date {target}
python research/test_current_data_pipeline.py
```

该目标的日前研究截点过去后，以上命令会拒绝把过去日期发布成新预测。此时可加 `--evaluation-only` 重建历史评估，或传入仍在截点前的新目标日期与新的输出目录。已有固定模拟输入可随时离线重放，无需重新训练或改写时间戳。

若最新日补取失败，流程根据实际可用数据声明更长的信息滞后，并将相同滞后用于历史训练和预测；不依赖被排除的数据。完整价格区间内存在无效或重复时段仍应报告输入错误，不伪造数值。

## 来源和交付范围

价格来自 CAISO OASIS。本包保留实际使用的归一价格、最近一天原始价格响应、数据审计和来源摘要，旧年度原始响应沿用平台既有数据交付包。EIA 原工作簿较大，本包只提供归一面板、来源 URL、原文件摘要及归一脚本；该面板未用于本轮模型训练。

本次训练没有使用天气历史、未经验证的官方预测历史发行版本、FRP费用补项或账户数据。它们不阻塞本版本。
'''
    files['README.md'] = readme.encode()
    (OUT / 'README.md').write_text(readme)
    manifest = {
        'schemaVersion': 4, 'modelVersion': report['modelVersion'],
        'forecastGeneratedAt': forecast['generatedAt'], 'forecastDigest': forecast['digest'],
        'inputSha256': report['sample']['inputSha256'], 'classification': 'current_free_data_research',
        'files': [{'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
                  for name, content in sorted(files.items())],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    files['release-manifest.json'] = manifest_bytes
    handle, tmp = tempfile.mkstemp(prefix='.current-release-', suffix='.tmp', dir=OUT)
    os.close(handle)
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
            for name, content in sorted(files.items()):
                bundle.writestr(name, content)
        with zipfile.ZipFile(tmp) as bundle:
            if bundle.testzip() is not None:
                raise ValueError('Archive CRC verification failed')
            for entry in manifest['files']:
                if hashlib.sha256(bundle.read(entry['path'])).hexdigest() != entry['sha256']:
                    raise ValueError('Archive content differs: ' + entry['path'])
        archive = OUT / 'caiso-current-forecast.zip'
        os.replace(tmp, archive)
    finally:
        Path(tmp).unlink(missing_ok=True)
    (OUT / 'release-manifest.json').write_bytes(manifest_bytes)
    print(json.dumps({'archive': str(archive), 'files': len(files), 'bytes': archive.stat().st_size,
                      'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
