import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const tmp=await fs.mkdtemp(path.join(root,'.sites-runtime/gridstatus-test-'));
const oldKey=process.env.GRIDSTATUS_API_KEY;
const oldFetch=globalThis.fetch;
try {
  for (const name of ['types','oasis','gridstatus']) {
    const input=await fs.readFile(path.join(root,`lib/${name}.ts`),'utf8');
    const output=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from ['"]\.\/(types|oasis)['"]/g,"from './$1.mjs'");
    await fs.writeFile(path.join(tmp,`${name}.mjs`),output);
  }
  const mod=await import(pathToFileURL(path.join(tmp,'gridstatus.mjs')).href);
  delete process.env.GRIDSTATUS_API_KEY;
  assert.equal(mod.connectionStatus().status,'not_configured');
  await assert.rejects(mod.availableDatasets(),error=>error.code==='NOT_CONFIGURED');
  const params=new URLSearchParams({dataset:'caiso_load',start:'2026-11-01',limit:'300'});
  const validated=mod.validateGridStatusQuery(params);
  assert.equal((Date.parse(validated.query.get('end_time'))-Date.parse(validated.query.get('start_time')))/3600000,25);
  for (const [key,value,code] of [['dataset','https://evil.invalid','INVALID_DATASET'],['dataset','ercot_load','INVALID_DATASET'],['start','2026-02-30','INVALID_DATE'],['limit','1001','INVALID_LIMIT'],['limit','-1','INVALID_LIMIT']]) {
    const p=new URLSearchParams(params);p.set(key,value);
    assert.throws(()=>mod.validateGridStatusQuery(p),e=>e.code===code);
  }
  console.log('PASS: no-key status, bounded CAISO-only queries, valid dates and 25-hour DST window');
  process.env.GRIDSTATUS_API_KEY='non-secret-test-fixture';
  let requests=0;
  globalThis.fetch=async (url,init)=>{
    requests++;
    assert(String(url).startsWith('https://api.gridstatus.io/v1/'));
    assert.equal(init.headers['x-api-key'],'non-secret-test-fixture');
    assert(!String(url).includes('non-secret-test-fixture'));
    if (String(url).endsWith('/datasets')) return Response.json({data:[{id:'caiso_load',name:'CAISO Load'},{id:'ercot_load',name:'ERCOT Load'}]});
    return Response.json({data:[{interval_start_utc:'2026-11-01T07:00:00Z',load:0}],meta:{hasNextPage:true}});
  };
  const connected=await mod.availableDatasets();
  assert.equal(connected.status,'connected');assert.equal(connected.datasets.length,1);
  assert(!JSON.stringify(connected).includes('non-secret-test-fixture'));
  const data=await mod.queryGridStatus(params);
  assert.equal(data.rows[0].load,0);assert.equal(data.limited,true);
  await mod.queryGridStatus(params);assert.equal(requests,2);
  globalThis.fetch=async()=>new Response('upstream confidential error',{status:403});
  const other=new URLSearchParams(params);other.set('dataset','caiso_fuel_mix');
  await assert.rejects(mod.queryGridStatus(other),e=>e.code==='ACCESS_DENIED'&&!e.message.includes('confidential'));
  console.log('PASS: header-only key, authorized CAISO catalog, explicit incomplete results, cache and safe authorization errors');
} finally {
  globalThis.fetch=oldFetch;
  if(oldKey===undefined)delete process.env.GRIDSTATUS_API_KEY;else process.env.GRIDSTATUS_API_KEY=oldKey;
  await fs.rm(tmp,{recursive:true,force:true});
}
