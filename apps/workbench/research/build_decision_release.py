#!/usr/bin/env python3
"""Atomically package the V3 decision study with frozen evidence and public raw data."""
from pathlib import Path
import hashlib
import json
import os
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'public/data/forecast-lab'
OUT = BASE/'v3'


def main():
    report = json.loads((OUT/'report.json').read_text())
    verification = json.loads((OUT/'replay-verification.json').read_text())
    decision_input = json.loads((OUT/'decision-plan-input.json').read_text())
    fundamentals = json.loads((ROOT/'data/fundamentals-history-v3.json').read_text())
    if verification['experimentVersion'] != report['experimentVersion'] or verification['inputDigest'] != decision_input['meta']['inputDigest']:
        raise ValueError('V3 replay and input versions differ')
    if verification['cases'] != 40 or verification['allMetricsMatch'] is not True:
        raise ValueError('Independent fixed-scenario replay has not passed')
    if report['forward']['status'] != 'not_generated':
        raise ValueError('This V3 release must not claim a new forward forecast')
    for filename,key in [('strategy-history-expanded.json','priceInputSha256'),('fundamentals-history-v3.json','fundamentalsInputSha256')]:
        if hashlib.sha256((ROOT/'data'/filename).read_bytes()).hexdigest() != report['sample'][key]:
            raise ValueError('Training archive changed: '+filename)
    (OUT/'decision_strategy.py').write_bytes((ROOT/'research/decision_strategy.py').read_bytes())
    files = {}
    for folder in [ROOT/'research', BASE]:
        for path in folder.rglob('*'):
            if not path.is_file() or path.suffix not in {'.py','.mjs','.md','.txt','.json','.csv'}:
                continue
            if '__pycache__' in path.parts or path.name == 'release-manifest.json':
                continue
            files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for name in ('strategy-history.json','strategy-history-expanded.json','fundamentals-history-v3.json'):
        files['data/'+name] = (ROOT/'data'/name).read_bytes()
    for name in ('time','strategy-types','strategy-engine','strategy-forecast','types','oasis','data-types','fundamentals-types','fundamentals','analytics'):
        files['lib/'+name+'.ts'] = (ROOT/'lib'/f'{name}.ts').read_bytes()
    # Only the 12 known public OASIS responses and their typed receipts are added;
    # no other runtime state, tokens, credentials, or private API captures enter.
    for receipt in fundamentals['sourceRequests']:
        family = 'load' if receipt['report']=='SLD_FCST' else 'renewables'
        stem = f"{family}-{receipt['startDate']}-{receipt['endDateExclusive']}"
        for extension in ('.zip','.json'):
            name = '.sites-runtime/v3-fundamentals/'+stem+extension
            path = ROOT/name
            raw = path.read_bytes()
            if extension=='.zip' and hashlib.sha256(raw).hexdigest()!=receipt['rawSha256']:
                raise ValueError('Public source ZIP fingerprint differs')
            if extension=='.json':
                metadata = json.loads(raw)
                if set(metadata)-{'sourceUrl','fetchedAt','lastModified','rawSha256','rawBytes','report','marketRunId','startDate','endDateExclusive'}:
                    raise ValueError('Unexpected metadata in public response receipt')
                if not metadata['sourceUrl'].startswith('https://oasis.caiso.com/oasisapi/SingleZip?'):
                    raise ValueError('Unexpected source origin')
            files[name] = raw
    files['README.md'] = (ROOT/'research/DECISION_DELIVERY.md').read_bytes()
    files['package.json'] = (json.dumps({'name':'caiso-decision-research-v3','private':True,'type':'module',
        'engines':{'node':'>=22.13.0'},'dependencies':{'fflate':'0.8.2'},'devDependencies':{'typescript':'5.9.3'}},indent=2)+'\n').encode()
    manifest = {'schemaVersion':3,'experimentVersion':report['experimentVersion'],'generatedAt':report['generatedAt'],
                'classification':'historical_decision_reconstruction','forwardStatus':'not_generated',
                'inputDigest':decision_input['meta']['inputDigest'],
                'files':[{'path':name,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()} for name,content in sorted(files.items())]}
    manifest_bytes = (json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
    files['release-manifest.json'] = manifest_bytes
    descriptor,name = tempfile.mkstemp(prefix='.decision-release-',suffix='.tmp',dir=OUT)
    os.close(descriptor)
    temporary = Path(name)
    try:
        with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as bundle:
            for filename,content in sorted(files.items()):
                bundle.writestr(filename,content)
        with zipfile.ZipFile(temporary) as bundle:
            if bundle.testzip() is not None or set(bundle.namelist())!=set(files):
                raise ValueError('Invalid decision research ZIP')
            for entry in manifest['files']:
                if hashlib.sha256(bundle.read(entry['path'])).hexdigest()!=entry['sha256']:
                    raise ValueError('Archive member fingerprint differs')
        archive = OUT/'caiso-decision-research.zip'
        if temporary.stat().st_size > 24*1024*1024:
            raise ValueError('Release exceeds the static-asset size budget')
        os.replace(temporary,archive)
    finally:
        temporary.unlink(missing_ok=True)
    (OUT/'.release-manifest.json.tmp').write_bytes(manifest_bytes)
    os.replace(OUT/'.release-manifest.json.tmp',OUT/'release-manifest.json')
    print(json.dumps({'archive':str(archive),'files':len(files),'bytes':archive.stat().st_size,
                      'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}))


if __name__=='__main__':
    main()
