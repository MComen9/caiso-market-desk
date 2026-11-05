#!/usr/bin/env python3
"""Package the explicitly allowlisted forecasting research files; no credentials or runtime state."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data/forecast-lab'

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = json.loads((OUT/'report.json').read_text())
    forecast = json.loads((OUT/'forecast-forward.json').read_text())
    simulation = json.loads((OUT/'simulation-summary.json').read_text())
    if report['modelVersion'] != forecast['modelVersion'] or simulation['forecastDigest'] != forecast['digest']:
        raise ValueError('Forecast, report and simulation versions differ; rerun the input bridge before packaging')
    shutil.copyfile(ROOT/'research/data-audit.json', OUT/'data-audit.json')
    shutil.copyfile(ROOT/'research/trading_strategy.py', OUT/'trading_strategy.py')
    files = {}
    for path in (ROOT/'research').rglob('*'):
        if path.is_file() and path.suffix in {'.py','.mjs','.md','.txt','.json'} and '__pycache__' not in path.parts:
            files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for path in OUT.iterdir():
        if path.is_file() and path.suffix in {'.json','.csv','.py'} and path.name != 'release-manifest.json':
            if path.name == 'forecast-archive-receipt.json' and json.loads(path.read_text())['forecastFileDigest'] != forecast['digest']:
                continue  # Preserve the old receipt on disk, but do not label it as this new forecast's receipt.
            files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    files['data/strategy-history.json'] = (ROOT/'data/strategy-history.json').read_bytes()
    for name in ['time','strategy-types','strategy-engine','strategy-forecast']:
        path = ROOT/f'lib/{name}.ts'
        files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    files['README.md'] = (ROOT/'research/README.md').read_bytes() + b'\n\nSee research/PYTHON_INPUT.md for the strategy input and simulation commands. Optional TypeScript parity checks require npm install, then python research/test_strategy_bridge.py --export-parity and node research/test_strategy_parity.mjs.\n'
    files['package.json'] = (json.dumps({'name':'caiso-forecast-research','private':True,'type':'module','engines':{'node':'>=22.13.0'},'devDependencies':{'typescript':'5.9.3'}},indent=2)+'\n').encode()
    manifest = {'schemaVersion':1,'modelVersion':report['modelVersion'],'forecastGeneratedAt':report['generatedAt'],
                'purpose':'可复现的研究模型与策略模拟，不含平台凭据或自动下单',
                'files':[{'path':name,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()} for name,content in sorted(files.items())]}
    manifest_bytes = (json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
    files['release-manifest.json'] = manifest_bytes
    archive = OUT/'caiso-forecast-research.zip'
    # Never expose a partially written download to a preview server or file sync.
    # Verify the closed archive, then replace the published path atomically.
    descriptor, temporary_name = tempfile.mkstemp(prefix='.forecast-release-', suffix='.tmp', dir=OUT)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as bundle:
            for name,content in sorted(files.items()): bundle.writestr(name,content)
        with zipfile.ZipFile(temporary) as bundle:
            if bundle.testzip() is not None or set(bundle.namelist()) != set(files):
                raise ValueError('Incomplete release archive')
            for entry in manifest['files']:
                if hashlib.sha256(bundle.read(entry['path'])).hexdigest() != entry['sha256']:
                    raise ValueError('Release archive member hash mismatch: ' + entry['path'])
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    manifest_temporary = OUT/'.release-manifest.json.tmp'
    manifest_temporary.write_bytes(manifest_bytes)
    os.replace(manifest_temporary, OUT/'release-manifest.json')
    print(json.dumps({'archive':str(archive),'files':len(files),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))

if __name__ == '__main__': main()
