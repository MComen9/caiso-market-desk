import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(root, '.sites-runtime/strategy-bootstrap-'));
try {
  for (const file of ['time', 'analytics']) {
    const source = await fs.readFile(path.join(root, `lib/${file}.ts`), 'utf8');
    const built = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from ['"]\.\/time['"]/g, "from './time.mjs'");
    await fs.writeFile(path.join(temp, `${file}.mjs`), built);
  }
  const {buildHourlyRows} = await import(pathToFileURL(path.join(temp, 'analytics.mjs')).href);
  const data = JSON.parse(await fs.readFile(path.join(root, 'public/data/prices-bootstrap.json'), 'utf8'));
  const nodes = ['TH_NP15_GEN-APND','TH_SP15_GEN-APND','TH_ZP26_GEN-APND'];
  const rows = nodes.flatMap(node => buildHourlyRows(data.markets,node,data.startDate,data.endDate)).map(({node,startUtc,endUtc,localDate,localHour,utcOffset,dam,fmm,fmmCount,paired}) => ({node,startUtc,endUtc,localDate,localHour,utcOffset,dam,fmm,fmmCount,paired}));
  const fetchedAt = [data.markets.DAM.fetchedAt, data.markets.FMM.fetchedAt].sort().at(-1);
  const archive = {id:`oasis-bootstrap-${data.startDate}-${data.endDate}`,name:`OASIS 预载价格 · ${data.startDate} 至 ${data.endDate}`,createdAt:fetchedAt,startDate:data.startDate,endDate:data.endDate,nodes,rows,sourceUrls:[data.markets.DAM.sourceUrl,data.markets.FMM.sourceUrl],fetchedAt,digest:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),warnings:['真实历史价格快照；无法证明每个价格的首次发布时间或修订前值。']};
  await fs.writeFile(path.join(root,'data/strategy-bootstrap.json'), JSON.stringify(archive));
  console.log(JSON.stringify({id:archive.id,rows:rows.length,paired:rows.filter(r=>r.paired).length,bytes:JSON.stringify(archive).length}));
} finally { await fs.rm(temp,{recursive:true,force:true}); }
