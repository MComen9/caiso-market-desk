import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await fs.mkdtemp(path.join(root,'.sites-runtime/strategy-api-test-'));
const sql=new DatabaseSync(':memory:');
sql.exec('PRAGMA foreign_keys=ON');
sql.exec(await fs.readFile(path.join(root,'drizzle/0000_futuristic_stardust.sql'),'utf8'));
class D1Statement {
  constructor(query,args=[]){this.query=query;this.args=args;}
  bind(...args){return new D1Statement(this.query,args);}
  async first(){return sql.prepare(this.query).get(...this.args)??null;}
  async all(){return {results:sql.prepare(this.query).all(...this.args),success:true};}
  async run(){return sql.prepare(this.query).run(...this.args);}
}
globalThis.__researchTestDB={prepare:query=>new D1Statement(query),batch:async statements=>{
  sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}
}};
try{
  await fs.writeFile(path.join(temp,'cloudflare.mjs'),'export const env = {DB:globalThis.__researchTestDB};');
  for(const file of ['time','types','analytics','oasis','strategy-types','strategy-engine','strategy-forecast','strategy-storage']){
    const input=await fs.readFile(path.join(root,`lib/${file}.ts`),'utf8');
    const built=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
      .replace(/from ['"]\.\/([^'"]+)['"]/g,"from './$1.mjs'")
      .replace(/from ['"]cloudflare:workers['"]/g,"from './cloudflare.mjs'");
    await fs.writeFile(path.join(temp,`${file}.mjs`),built);
  }
  const priceFixture=JSON.parse(await fs.readFile(path.join(root,'public/data/prices-bootstrap.json'),'utf8'));
  globalThis.__priceFixture=priceFixture;
  await fs.writeFile(path.join(temp,'mock-oasis.mjs'),`export {validateQuery,OasisError} from './oasis.mjs'; export async function queryMarket(query){const source=globalThis.__priceFixture.markets[query.market];return {...source,request:{...source.request,startDate:query.startDate,endDate:query.endDate,nodes:query.nodes},intervals:source.intervals.filter(row=>row.localDate>=query.startDate&&row.localDate<=query.endDate&&query.nodes.includes(row.node))};}`);
  let route=ts.transpileModule(await fs.readFile(path.join(root,'app/api/strategy/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
    .replace(/from ['"]@\/lib\/oasis['"]/g,"from './mock-oasis.mjs'")
    .replace(/from ['"]@\/lib\/([^'"]+)['"]/g,"from './$1.mjs'");
  for(const match of [...route.matchAll(/import ([a-zA-Z_$][\w$]*) from ['"]@\/data\/([^'"]+\.json)['"];?/g)]){
    const data=JSON.parse(await fs.readFile(path.join(root,'data',match[2]),'utf8'));
    route=route.replace(match[0],`const ${match[1]} = ${JSON.stringify(data)};`);
  }
  await fs.writeFile(path.join(temp,'route.mjs'),route);
  const {GET,POST}=await import(pathToFileURL(path.join(temp,'route.mjs')).href);
  const {DEFAULT_CONFIG,DEFAULT_BASELINE}=await import(pathToFileURL(path.join(temp,'strategy-types.mjs')).href);
  const {runStrategy}=await import(pathToFileURL(path.join(temp,'strategy-engine.mjs')).href);
  const storage=await import(pathToFileURL(path.join(temp,'strategy-storage.mjs')).href);
  const request=(body,origin='https://research.example')=>new Request('https://research.example/api/strategy',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
  const read=async response=>({status:response.status,body:await response.json()});
  const count=()=>sql.prepare('SELECT COUNT(*) AS n FROM research_records').get().n;
  const catalog=await read(await GET(new Request('https://research.example/api/strategy?resource=catalog')));
  assert.equal(catalog.status,200);assert.equal(catalog.body.persistent,true);assert(catalog.body.prices.length>=1);
  const builtinId='oasis-bootstrap-2026-10-22-2026-10-28';
  const input={mode:'single',startDate:'2026-10-28',endDate:'2026-10-28',forecastMode:'scenario',timingPolicy:'declared',cutoffTime:'09:55',baseline:DEFAULT_BASELINE,scenario:{predictedDa:100,predictedSpread:10,sigma:5},configs:[{...DEFAULT_CONFIG,k:0,nodes:['TH_NP15_GEN-APND'],totalMWh:3,perNodeMWh:3}],priceArchiveIds:[builtinId]};
  const runResponse=await read(await POST(request({action:'run',request:input})));
  assert.equal(runResponse.status,200,JSON.stringify(runResponse.body));
  const run=runResponse.body.run;assert.equal(run.evidence.input.actuals.length,168);assert(run.evidence.input.actuals.every(row=>row.node==='TH_NP15_GEN-APND'));assert.equal(count(),1);
  assert.equal(run.inputDigest,await storage.sha256(JSON.stringify(run.evidence.input)));
  assert.equal(run.evidence.resultDigest,await storage.sha256(JSON.stringify(run.result)));
  const reopened=await read(await GET(new Request(`https://research.example/api/strategy?resource=run&id=${run.id}`)));
  assert.deepEqual(reopened.body.run,run);
  const replay=await read(await POST(request({action:'replay',id:run.id})));
  assert.equal(replay.body.identical,true,JSON.stringify(replay.body));assert.equal(count(),1);
  console.log('PASS: persisted run reopens exactly; full input and result digests verify; server replay is identical');

  const csv='node,startUtc,predictedDa,predictedSpread,sigma,issuedAt,modelVersion\nTH_NP15_GEN-APND,2026-10-28T07:00:00Z,40,10,5,2026-10-27T15:00:00Z,test-v1';
  const imported=await read(await POST(request({action:'import_forecast',name:'TEST synthetic forecast',source:'Synthetic test fixture',modelVersion:'test-v1',text:csv})));
  assert.equal(imported.status,200,JSON.stringify(imported.body));assert.equal(imported.body.batch.points.length,1);
  assert(Date.parse(imported.body.batch.createdAt)>=Date.parse('2026-10-29'));
  const before=count();
  const invalid=await read(await POST(request({action:'import_forecast',text:csv.replace(',40,',',null,')})));
  assert.equal(invalid.status,400);assert.equal(count(),before);
  const blocked=await read(await POST(request({action:'run',request:input},'https://untrusted.example')));
  assert.equal(blocked.status,403);assert.equal(count(),before);
  const missing=await read(await POST(request({action:'run',request:{...input,priceArchiveIds:['missing']}})));
  assert.equal(missing.status,404);assert.equal(count(),before);
  console.log('PASS: server timestamps forecast receipt; malformed import / cross-origin writes / missing versions cannot create records');

  const queried=await read(await POST(request({action:'fetch_prices',startDate:'2026-10-28',endDate:'2026-10-28',nodes:['TH_NP15_GEN-APND']})));
  assert.equal(queried.status,200,JSON.stringify(queried.body));assert.equal(queried.body.archive.rows.length,24);assert(queried.body.archive.rows.every(r=>r.paired&&r.fmmCount===4));
  const merged=await read(await POST(request({action:'run',request:{...input,priceArchiveIds:[builtinId,queried.body.archive.id]}})));
  assert.equal(merged.status,200,JSON.stringify(merged.body));assert.equal(merged.body.run.evidence.input.actuals.length,168);assert(merged.body.run.result.warnings.some(w=>w.includes('重叠')));
  assert.equal((await read(await POST(request({action:'replay',id:merged.body.run.id})))).body.identical,true);
  console.log('PASS: official-format fixture yields complete hourly archive; overlapping versions deduplicate and provenance survives replay');

  const currentId='oasis-current-price-2025-10-29-2026-10-29';
  const current=await read(await GET(new Request(`https://research.example/api/strategy?resource=price&id=${currentId}`)));
  assert.equal(current.status,200);assert.equal(current.body.archive.rows.length,26352);
  assert(Buffer.byteLength(JSON.stringify(current.body.archive.rows))>5_000_000);
  for(const mode of ['scenario','baseline']){
    const scoped={...input,startDate:'2026-10-29',endDate:'2026-10-29',forecastMode:mode,
      configs:[{...DEFAULT_CONFIG,k:0,selection:mode==='baseline'?'ranked':'manual',minNodeSamples:1,minWinRate:0}],priceArchiveIds:[currentId]};
    const response=await read(await POST(request({action:'run',request:scoped})));
    assert.equal(response.status,200,JSON.stringify(response.body));
    const sliced=response.body.run;
    assert(sliced.evidence.input.actuals.length<current.body.archive.rows.length);
    assert(Buffer.byteLength(JSON.stringify(sliced.evidence.input))<5_000_000);
    // The engine deliberately caps a single input at 20,000 rows. This long
    // reference window is below that cap and far exceeds every required lag.
    const referenceRows=current.body.archive.rows.filter(row=>row.localDate>='2026-03-01');
    const full=runStrategy({...sliced.evidence.input,actuals:referenceRows});
    assert.deepEqual(sliced.result.plans,full.plans,`${mode}: required lookback preserves long-reference calculation`);
    const replay=await read(await POST(request({action:'replay',id:sliced.id})));
    assert.equal(replay.body.identical,true);
  }
  console.log('PASS: yearly archive simulations fit persistence budget; manual and nested ranked-baseline results equal long-reference calculations; replay remains identical');

  const payload={text:'a'.repeat(99990)+'📈研究'.repeat(40000)};
  const summary={id:'test_multichunk_unicode',kind:'forecast',name:'Synthetic storage fixture',createdAt:new Date().toISOString(),digest:await storage.sha256(JSON.stringify(payload))};
  await storage.saveResearchRecord(summary,payload);
  assert.deepEqual(await storage.readResearchRecord(summary.id,'forecast'),payload);
  await assert.rejects(()=>storage.saveResearchRecord(summary,payload));
  assert.deepEqual(await storage.readResearchRecord(summary.id,'forecast'),payload);
  console.log('PASS: SQLite-backed D1 adapter preserves multi-part Unicode payloads and rejects mutation of existing version IDs');
} finally {
  sql.close();delete globalThis.__researchTestDB;delete globalThis.__priceFixture;
  await fs.rm(temp,{recursive:true,force:true});
}
