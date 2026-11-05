#!/usr/bin/env python3
"""Atomically package both frozen experiments and the expanded data for v2."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'public/data/forecast-lab'
OUT = BASE/'v2'


def main():
    report = json.loads((OUT/'report.json').read_text())
    forecast = json.loads((OUT/'forecast-forward.json').read_text())
    simulation = json.loads((OUT/'simulation-summary.json').read_text())
    history = json.loads((ROOT/'data/strategy-history-expanded.json').read_text())
    if report['modelVersion'] != forecast['modelVersion'] or simulation['forecastDigest'] != forecast['digest']:
        raise ValueError('V2 forecast and simulation versions differ')
    if report['sample']['archiveDigest'] != history['digest']:
        raise ValueError('Expanded archive differs from model training input')
    shutil.copyfile(ROOT/'research/extended-history-audit.json', OUT/'data-audit.json')
    shutil.copyfile(ROOT/'research/trading_strategy.py', OUT/'trading_strategy.py')
    files = {}
    for directory in [ROOT/'research', BASE]:
        for path in directory.rglob('*'):
            if not path.is_file() or path.suffix not in {'.py', '.mjs', '.md', '.txt', '.json', '.csv'}:
                continue
            if '__pycache__' in path.parts or path.name == 'release-manifest.json':
                continue
            if path.parent == OUT and path.name == 'forecast-archive-receipt.json':
                receipt = json.loads(path.read_text())
                if receipt['forecastFileDigest'] != forecast['digest']:
                    raise ValueError('V2 receipt describes a different forecast')
            files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for filename in ['strategy-history.json', 'strategy-history-expanded.json']:
        files['data/'+filename] = (ROOT/'data'/filename).read_bytes()
    for name in ['time', 'strategy-types', 'strategy-engine', 'strategy-forecast']:
        files['lib/'+name+'.ts'] = (ROOT/'lib'/f'{name}.ts').read_bytes()
    instructions = ROOT/'research/OPTIMIZATION.md'
    files['README.md'] = instructions.read_bytes() if instructions.exists() else (ROOT/'research/README.md').read_bytes()
    files['package.json'] = (json.dumps({'name':'caiso-forecast-research-v2','private':True,'type':'module',
                             'engines':{'node':'>=22.13.0'},'devDependencies':{'typescript':'5.9.3'}},indent=2)+'\n').encode()
    manifest = {'schemaVersion':2, 'modelVersion':report['modelVersion'], 'forecastGeneratedAt':forecast['generatedAt'],
                'dataArchiveDigest': history['digest'], 'classification':'research_only',
                'purpose':'第二轮可复现模型、固定策略比较与真实前向预测；不含凭据或下单功能',
                'files':[{'path':name,'bytes':len(value),'sha256':hashlib.sha256(value).hexdigest()}
                         for name,value in sorted(files.items())]}
    manifest_bytes = (json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
    files['release-manifest.json'] = manifest_bytes
    descriptor, name = tempfile.mkstemp(prefix='.optimization-release-',suffix='.tmp',dir=OUT)
    os.close(descriptor)
    temporary = Path(name)
    try:
        with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as bundle:
            for path,content in sorted(files.items()): bundle.writestr(path,content)
        with zipfile.ZipFile(temporary) as bundle:
            if bundle.testzip() is not None or set(bundle.namelist()) != set(files):
                raise ValueError('Invalid optimization archive')
            for entry in manifest['files']:
                if hashlib.sha256(bundle.read(entry['path'])).hexdigest() != entry['sha256']:
                    raise ValueError('Archive member mismatch: '+entry['path'])
        archive = OUT/'caiso-forecast-research.zip'
        os.replace(temporary,archive)
    finally:
        temporary.unlink(missing_ok=True)
    manifest_temporary = OUT/'.release-manifest.json.tmp'
    manifest_temporary.write_bytes(manifest_bytes)
    os.replace(manifest_temporary,OUT/'release-manifest.json')
    print(json.dumps({'archive':str(archive),'files':len(files),'bytes':archive.stat().st_size,
                      'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))


if __name__ == '__main__': main()
