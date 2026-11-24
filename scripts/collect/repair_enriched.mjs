// 修富化文件的分区字段：view 接口匿名不返回 tname（返回空串），
// 富化记录里的 tname/tid/partition_path 一律以采集分片里的原值为准。
import fs from 'node:fs';
import path from 'node:path';
import { RAW, META, listShards } from './miner_lib.mjs';

const regions = JSON.parse(fs.readFileSync(path.join(META, 'regions.json'), 'utf8'));
const parentMap = regions.parent_map || {};

const tnameOf = new Map();
const tidOf = new Map();
for (const f of listShards('bili-meta')) {
  for (const line of fs.readFileSync(path.join(RAW, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    tnameOf.set(r.bvid, r.tname);
    tidOf.set(r.bvid, r.tid);
  }
}

const p = path.join(RAW, 'bili-meta-enriched.jsonl');
if (!fs.existsSync(p)) { console.log(JSON.stringify({ ok: false, reason: 'no enriched file' })); process.exit(0); }
const seen = new Set();
const out = [];
let fixedTname = 0, fixedTid = 0, dropDup = 0, fixedPath = 0, bad = 0, missing = 0;
for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch { bad++; continue; }
  if (!r.bvid) { bad++; continue; }
  if (seen.has(r.bvid)) { dropDup++; continue; }
  seen.add(r.bvid);
  const t = tnameOf.get(r.bvid);
  if (t) { if (r.tname !== t) { r.tname = t; fixedTname++; } }
  else missing++;
  const id = tidOf.get(r.bvid);
  if (id != null && r.tid !== id) { r.tid = id; fixedTid++; }
  const pm = r.tid != null ? parentMap[String(r.tid)] : null;
  const np = (pm && pm.parent_name && r.tname) ? `${pm.parent_name}/${r.tname}` : null;
  if (r.partition_path !== np) { r.partition_path = np; fixedPath++; }
  out.push(JSON.stringify(r));
}
fs.writeFileSync(p, out.join('\n') + '\n', 'utf8');
const byT = {};
for (const line of out) { const r = JSON.parse(line); byT[r.tname || '(空)'] = (byT[r.tname || '(空)'] || 0) + 1; }
console.log(JSON.stringify({
  ok: true, records: out.length, fixedTname, fixedTid, fixedPath, dropDup, badJson: bad,
  tname_missing_in_corpus: missing, bytes: fs.statSync(p).size,
  tnames: Object.keys(byT).length,
}, null, 1));
