// 第5步：自检。逐行 JSON.parse、bvid 唯一、platform、类型、crawled_at。
import fs from 'node:fs';
import path from 'node:path';
import { listShards, RAW, META, mkdirs, isoCST } from './miner_lib.mjs';

mkdirs();
const problems = [];
const P = (kind, file, lineNo, detail) => { if (problems.length < 500) problems.push({ kind, file, line: lineNo, detail }); };

function checkFile(file) {
  const p = path.join(RAW, file);
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.split('\n');
  const out = { file, bytes: fs.statSync(p).size, records: 0, badJson: 0, dupInFile: 0, tnames: new Set(), sources: {} };
  let ln = 0;
  for (const line of lines) {
    ln++;
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { out.badJson++; P('badJson', file, ln); continue; }
    out.records++;
    if (typeof r.bvid !== 'string' || !/^BV[0-9A-Za-z]{8,12}$/.test(r.bvid)) P('badBvid', file, ln, String(r.bvid));
    if (r.platform !== 'bilibili') P('badPlatform', file, ln, String(r.platform));
    if (!r.crawled_at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(r.crawled_at)) P('badCrawledAt', file, ln, String(r.crawled_at));
    if (!(r.aid === null || Number.isInteger(r.aid))) P('badAid', file, ln, String(r.aid));
    if (!(r.pubdate === null || Number.isInteger(r.pubdate))) P('badPubdate', file, ln, String(r.pubdate));
    if (!(r.duration_s === null || Number.isInteger(r.duration_s))) P('badDuration', file, ln, String(r.duration_s));
    if (!(r.desc_len === null || Number.isInteger(r.desc_len))) P('badDescLen', file, ln, String(r.desc_len));
    if (!Array.isArray(r.tags)) P('badTags', file, ln);
    if (!r.stat || typeof r.stat !== 'object' || Array.isArray(r.stat)) P('badStat', file, ln);
    else for (const k of ['view', 'danmaku', 'reply', 'favorite', 'coin', 'like', 'share']) {
      const v = r.stat[k];
      if (!(v === null || Number.isInteger(v))) P('badStatField', file, ln, `${k}=${v}`);
    }
    if (r.title && /<\/?[a-zA-Z][^>]*>/.test(r.title)) P('titleHasHtml', file, ln, r.title.slice(0, 40));
    if (r.tname) out.tnames.add(r.tname);
    out.sources[r.source] = (out.sources[r.source] || 0) + 1;
  }
  out.tnames = out.tnames.size;
  return out;
}

const files = listShards('bili-meta');
const perFile = [];
const seen = new Set();
let records = 0, dup = 0, badJson = 0;
const allTnames = new Set();
const bySource = {};
for (const f of files) {
  const r = checkFile(f);
  perFile.push(r);
  records += r.records; badJson += r.badJson;
  for (const [k, v] of Object.entries(r.sources)) bySource[k] = (bySource[k] || 0) + v;
  // 全库唯一性（第二次扫，避免单文件内存过大问题）
  const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (!x.bvid) continue;
    if (seen.has(x.bvid)) { dup++; P('dupBvid', f, 0, x.bvid); } else seen.add(x.bvid);
  }
}
for (const r of perFile) { /* tnames 需要合并，单独再扫 */ }

// tname 汇总 + 全库唯一计数
const tnameCount = new Map();
for (const f of files) {
  const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    const tn = x.tname || 'null';
    tnameCount.set(tn, (tnameCount.get(tn) || 0) + 1);
  }
}

// enriched 文件单独校验（若存在）
let enriched = null;
const ep = path.join(RAW, 'bili-meta-enriched.jsonl');
if (fs.existsSync(ep)) {
  const txt = fs.readFileSync(ep, 'utf8');
  let n = 0, bad = 0, seen2 = new Set(), dup2 = 0, trueCount = 0;
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let x; try { x = JSON.parse(line); } catch { bad++; continue; }
    n++;
    if (x.enriched === true) trueCount++;
    if (!x.bvid || !/^BV/.test(x.bvid)) P('enrichedBadBvid', 'bili-meta-enriched.jsonl', 0, String(x.bvid));
    if (x.bvid) { if (seen2.has(x.bvid)) dup2++; else seen2.add(x.bvid); }
  }
  enriched = { file: 'bili-meta-enriched.jsonl', bytes: fs.statSync(ep).size, records: n, badJson: bad, dup: dup2, enrichedTrue: trueCount };
}

const report = {
  generated_at: isoCST(),
  ok: badJson === 0 && dup === 0 && problems.length === 0,
  records,
  unique_bvid: seen.size,
  dup,
  badJson,
  tnames: tnameCount.size,
  files: perFile,
  by_source: bySource,
  enriched,
  schemaProblems: problems.slice(0, 200),
  schemaProblemCount: problems.length,
  notes: [
    'bvid 全库唯一性按「已采所有 bili-meta-*.jsonl」整体校验（跨文件去重）。',
    'title 里若出现 <em class="keyword"> 等标签会记为 titleHasHtml；正常采集已 stripHtml。',
    'stat 的 coin/share 在 search 来源为 null（接口不返回），属预期。',
  ],
};
fs.writeFileSync(path.join(META, 'validate-report.json'), JSON.stringify(report, null, 1), 'utf8');
console.log(JSON.stringify({ ok: report.ok, records, unique: seen.size, dup, badJson, tnames: report.tnames, problems: problems.length, files: files.length }));
