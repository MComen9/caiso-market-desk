const fs=require('node:fs');
const path=require('node:path');
const { siteUrl } = require('./site-config.cjs');
module.exports = function generateCsvView({ dist, basePath }) {
const d=path.join(dist,'data/forecast-lab/v4');
const data=fs.readFileSync(path.join(d,'forward-predictions.csv'));
const records=data.toString('utf8').trim().split(/\r?\n/).length-1;
const report=JSON.parse(fs.readFileSync(path.join(d,'report.json'),'utf8'));
const date=report.forecast.targetDate;
if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||records!==report.forecast.rows)throw Error('Invalid CSV source');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
fs.writeFileSync(path.join(d,'forecast-csv.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>逐小时预测 CSV · CAISO</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7f3;color:#18382e;font:15px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:40px 5vw}header{font-weight:bold;letter-spacing:.1em}h1{font-size:clamp(26px,4vw,36px);margin:26px 0 6px}p{color:#52695e}nav{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:22px 0 14px}a,button{font:inherit;color:#275742}nav a,nav button{border:1px solid #bad2bd;border-radius:8px;padding:8px 17px;text-decoration:none;background:white;cursor:pointer}nav a:first-child{background:#28563e;color:white}textarea{display:block;width:100%;min-height:47vh;padding:14px;white-space:pre;overflow:auto;font:12px/1.75 monospace;color:#324b41;background:white;border:1px solid #cbd9cd;border-radius:9px}</style><main><header>CAISO · 只读分享版</header><h1>逐小时预测 CSV</h1><p>${date} 太平洋时间 · ${records} 个节点小时 · NP15、SP15、ZP26</p><nav><a download="forward-predictions.csv" id="save" href="data:text/csv;charset=utf-8;base64,${data.toString('base64')}">下载 CSV</a><button id="copy">复制全部 CSV</button><a href="${siteUrl(basePath, '/#prices/prediction')}">返回预测页面</a></nav><p id="state" role="status">完整 CSV 已在本页载入，可直接查看、复制或保存。</p><textarea aria-label="完整逐小时预测 CSV" id="raw" readonly wrap="off">${escape(data.toString('utf8'))}</textarea></main><script>document.getElementById('copy').onclick=async()=>{const t=document.getElementById('raw');try{await navigator.clipboard.writeText(t.value);document.getElementById('state').textContent='已复制完整 CSV。'}catch{t.focus();t.select();document.getElementById('state').textContent='已选中全部数据，请使用系统复制快捷键。'}};</script></html>`);

};
