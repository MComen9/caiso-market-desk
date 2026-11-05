import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=await fs.mkdtemp(path.join(root,'.sites-runtime/outlook-test-'));
try {
  for (const name of ['data-types','types','time','oasis','outlook']) {
    const source=await fs.readFile(path.join(root,`lib/${name}.ts`),'utf8');
    const built=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
      .replace(/from ['"]\.\/(data-types|types|time|oasis|outlook)['"]/g,(_,name)=>`from './${name}.mjs'`);
    await fs.writeFile(path.join(temporary,`${name}.mjs`),built);
  }
  const mod=await import(pathToFileURL(path.join(temporary,'outlook.mjs')).href);
  assert.throws(()=>mod.validOutlookDate('2026-02-30'));
  assert.throws(()=>mod.outlookSourceUrl('../../secret','2026-10-28','2026-10-29'));
  assert.equal(mod.outlookSourceUrl('demand','2026-10-28','2026-10-29'),'https://www.caiso.com/outlook/history/20261028/demand.csv');
  assert.equal(mod.outlookSourceUrl('stats','2026-10-29','2026-10-29'),'https://www.caiso.com/outlook/current/stats.txt');
  const sample='Time,Day ahead forecast,Hour ahead forecast,Current demand,Demand response\n00:00,10,9,0,\n00:05,10,8,-2,\n12:00,9,8,,\n00:00,8,9,,';
  const feed=mod.normalizeOutlookCsv('demand',sample,'2026-10-28','2026-10-29T09:00:00Z',null,'2026-10-29');
  assert.equal(feed.rows.length,3);
  assert.equal(feed.rows[0].values.demandActual,0);
  assert.equal(feed.rows[1].values.demandActual,-2);
  assert.equal(feed.rows[2].values.demandActual,null);
  assert.equal(feed.columns.find(c=>c.key==='demandDayAhead').nativeMinutes,60);
  assert.equal(feed.rows[0].startUtc,'2026-10-28T07:00:00.000Z');
  assert(feed.notes.some(n=>n.includes('尾点')));
  console.log('PASS: input allowlist, Pacific conversion, native resolution, future nulls, negative/zero and next-midnight removal');

  assert.equal(mod.wallTimeCandidates('2026-11-01','01:30').length,2);
  assert.equal(mod.wallTimeCandidates('2026-03-08','02:30').length,0);
  const fall=mod.normalizeOutlookCsv('storage','Time,Total batteries,Stand-alone batteries,Hybrid batteries\n01:30,0,-10,3','2026-11-01');
  assert.equal(fall.rows[0].startUtc,null); assert.equal(fall.rows[0].quality,'ambiguous');
  assert.equal(fall.rows[0].sourceTime,'01:30'); assert.equal(fall.rows[0].values.batteriesStandalone,-10);
  const repeated=mod.normalizeOutlookCsv('storage','Time,Total batteries,Stand-alone batteries,Hybrid batteries\n01:30,0,-10,3\n01:30,1,-9,4','2026-11-01');
  assert.equal(Date.parse(repeated.rows[1].startUtc)-Date.parse(repeated.rows[0].startUtc),3600000);
  const spring=mod.normalizeOutlookCsv('storage','Time,Total batteries,Stand-alone batteries,Hybrid batteries\n01:55,0,0,0\n02:00,,,\n03:00,1,1,0','2026-03-08');
  assert.equal(spring.rows.length,2);
  const stale=mod.normalizeOutlookCsv('storage','Time,Total batteries,Stand-alone batteries,Hybrid batteries\n23:55,0,1,2','2026-10-29','2026-10-29T07:02:00Z',null,'2026-10-29');
  assert.equal(stale.dataDate,'2026-10-28'); assert.equal(stale.status,'partial');
  console.log('PASS: ambiguous fall-back times retained unlocated, duplicate folds distinguished, nonexistent spring times and midnight stale file');

  const daily=mod.normalizeOutlookCsv('peak_and_daily_storage','Resource,Peak production time,Peak production (MW),Daily production (MWh)\nTotal batteries,10/28/2026 7:03:02 PM,9168.6,-4591','2026-10-28');
  assert.equal(daily.rows.length,0); assert.equal(daily.table.rows[0].dailyMWh,-4591);
  assert.equal(daily.table.columns.find(c=>c.key==='dailyMWh').unit,'MWh');
  const unavailable=mod.normalizeRawOutlookFile({id:'stats',date:'2026-10-28',fetchedAt:'2026-10-29T09:00:00Z',status:0,sourceUrl:'https://www.caiso.com/outlook/history/20261028/stats.txt'},'2026-10-29');
  assert.equal(unavailable.status,'unavailable'); assert.equal(unavailable.stats,undefined);
  const schema=mod.normalizeRawOutlookFile({id:'demand',date:'2026-10-28',fetchedAt:'2026-10-29T09:00:00Z',status:200,text:'wrong,fields\n1,2',sourceUrl:'https://www.caiso.com/outlook/history/20261028/demand.csv'},'2026-10-29');
  assert.equal(schema.status,'error'); assert.equal(schema.error.code,'SCHEMA_CHANGED');
  console.log('PASS: daily MW/MWh kept separate, historical stats unavailable and schema changes fail closed');

  const raw=JSON.parse(await fs.readFile(path.join(root,'data/outlook-raw.json'),'utf8'));
  const archive={generatedAt:raw.generatedAt,byDate:{}};
  for (const date of [...new Set(raw.files.map(f=>f.date))]) {
    const feeds=raw.files.filter(f=>f.date===date).map(f=>mod.normalizeRawOutlookFile(f,raw.today));
    archive.byDate[date]={ok:feeds.some(f=>f.status==='ok'||f.status==='partial'),date,fetchedAt:raw.generatedAt,feeds:Object.fromEntries(feeds.map(f=>[f.id,f])),warnings:feeds.some(f=>f.status==='error')?['部分来源获取失败，请检查来源状态。']:[]};
    assert.equal(feeds.length,13); assert(!feeds.some(f=>f.status==='error'),JSON.stringify(feeds.filter(f=>f.status==='error')));
    const demand=archive.byDate[date].feeds.demand;
    assert.equal(demand.rows.length,288);
    assert(demand.rows.every(r=>r.sourceTime!=='24:00'));
    const net=archive.byDate[date].feeds.netdemand;
    for (const row of demand.rows) {
      const other=net.rows.find(x=>x.startUtc===row.startUtc);
      if (other?.values.demandActual!=null && row.values.demandActual!=null) assert.equal(other.values.demandActual,row.values.demandActual);
    }
    assert.equal(archive.byDate[date].feeds.rtm_forecast_7day.rows.filter(r=>r.quality==='ambiguous').length,12);
    console.log(`PASS: real ${date} official snapshot; ${feeds.filter(f=>f.status==='ok'||f.status==='partial').length}/13 available; 288 demand slots; cross-source actual demand consistency; DST ambiguity retained`);
  }
  if (process.argv.includes('--write-snapshot')) {
    await fs.writeFile(path.join(root,'data/outlook-bootstrap.json'),JSON.stringify(archive));
    await fs.writeFile(path.join(root,'public/data/outlook_snapshot_2026-10-28_2026-10-29.json'),JSON.stringify(archive));
    console.log('WROTE: normalized real-data archive and public downloadable JSON');
  }
} finally {await fs.rm(temporary,{recursive:true,force:true});}
