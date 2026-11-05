import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.resolve(root,process.argv[2]||'.sites-runtime/strategy-history');
const temp=await fs.mkdtemp(path.join(root,'.sites-runtime/build-history-'));
try{
  for(const file of ['time','analytics']){
    const source=await fs.readFile(path.join(root,`lib/${file}.ts`),'utf8');
    const built=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from ['"]\.\/time['"]/g,"from './time.mjs'");
    await fs.writeFile(path.join(temp,`${file}.mjs`),built);
  }
  const {buildHourlyRows}=await import(pathToFileURL(path.join(temp,'analytics.mjs')).href);
  const {addDays}=await import(pathToFileURL(path.join(temp,'time.mjs')).href);
  const builtin=JSON.parse(await fs.readFile(path.join(root,'data/strategy-bootstrap.json'),'utf8'));
  const rows=[...builtin.rows],sourceUrls=[...builtin.sourceUrls],fetchTimes=[builtin.fetchedAt];
  for(let date='2026-09-03';date<='2026-10-21';date=addDays(date,7)){
    const end=addDays(date,6),markets={};
    for(const market of ['DAM','FMM']){
      const report=JSON.parse(await fs.readFile(path.join(directory,`${date}_${end}_${market}.json`),'utf8'));
      if(!report.ok||!report.intervals.length)throw new Error(`Unverified ${date} ${market}`);
      markets[market]=report;sourceUrls.push(report.sourceUrl);fetchTimes.push(report.fetchedAt);
    }
    for(const node of builtin.nodes){
      const hours=buildHourlyRows(markets,node,date,end);
      if(hours.length!==168||hours.some(r=>!r.paired||r.fmmCount!==4))throw new Error(`Incomplete ${date} ${node}`);
      rows.push(...hours.map(({node,startUtc,endUtc,localDate,localHour,utcOffset,dam,fmm,fmmCount,paired})=>({node,startUtc,endUtc,localDate,localHour,utcOffset,dam,fmm,fmmCount,paired})));
    }
  }
  rows.sort((a,b)=>a.startUtc.localeCompare(b.startUtc)||a.node.localeCompare(b.node));
  if(rows.length!==4032||new Set(rows.map(r=>r.node+'|'+r.startUtc)).size!==4032)throw new Error('Unexpected count or duplicate');
  const fetchedAt=fetchTimes.sort().at(-1);
  const archive={id:'oasis-research-2026-09-03-2026-10-28',name:'OASIS 研究历史 · 56 日 / 3 枢纽',createdAt:fetchedAt,startDate:'2026-09-03',endDate:'2026-10-28',nodes:builtin.nodes,rows,sourceUrls:[...new Set(sourceUrls)],fetchedAt,digest:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),warnings:['56 日真实 OASIS DA / FMM 价格；2026-10-29 获取的历史版本，可能含事后修订。','历史基线在每个模拟截点之前滚动训练，但不证明当时原始价格发布值或预测实际存在。']};
  await fs.writeFile(path.join(root,'data/strategy-history.json'),JSON.stringify(archive));
  console.log(JSON.stringify({id:archive.id,days:56,hourlyRows:rows.length,paired:rows.filter(r=>r.paired).length,rawIntervals:rows.length*5,sourceQueries:archive.sourceUrls.length,bytes:JSON.stringify(archive).length,digest:archive.digest}));
}finally{await fs.rm(temp,{recursive:true,force:true});}
