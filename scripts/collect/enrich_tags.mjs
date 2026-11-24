// 第4步：补标签。按 tname 均匀抽 15 万条，调 view/detail 补 tags / partition_path / desc_len。
import fs from 'node:fs';
import path from 'node:path';
import { Bili, listShards, RAW, META, mkdirs, isoCST, sleep, Stopper } from './miner_lib.mjs';

const LIMIT = Number(process.env.LIMIT || 150000);
const RPS = Number(process.env.RPS || 6);
mkdirs();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const regions = JSON.parse(fs.readFileSync(path.join(META, 'regions.json'), 'utf8'));
const parentMap = regions.parent_map || {};
const files = listShards('bili-meta');
log('files=', files.length);

// ---- pass 1: 统计每个 tname 的条数 ----
const cnt = new Map();
let total = 0;
for (const f of files) {
  const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const tn = r.tname || 'null';
    cnt.set(tn, (cnt.get(tn) || 0) + 1);
    total++;
  }
}
log('total records=', total, 'tnames=', cnt.size);

// 均分配额（每 tname 至少 1，按比例，封顶自身条数）
const quota = new Map();
const sum = [...cnt.values()].reduce((a, b) => a + b, 0);
for (const [tn, c] of cnt) quota.set(tn, Math.min(c, Math.max(1, Math.round((LIMIT * c) / sum))));
const qsum = [...quota.values()].reduce((a, b) => a + b, 0);
log('quota total=', qsum);

// ---- pass 2: 选条（每个 tname 内等步长抽样，避免只取分片开头那批）----
const picked = [];
const stride = new Map();
for (const [tn, c] of cnt) stride.set(tn, Math.max(1, Math.ceil(c / Math.max(1, quota.get(tn)))));
const seenIn = new Map();
for (const f of files) {
  const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const tn = r.tname || 'null';
    const q = quota.get(tn) || 0;
    if (q <= 0) continue;
    const k = (seenIn.get(tn) || 0) + 1;
    seenIn.set(tn, k);
    if ((k - 1) % stride.get(tn) !== 0) continue;
    picked.push(r);
    quota.set(tn, q - 1);
  }
}
log('picked=', picked.length, 'stride sample mode');

// ---- 已有产出（续跑）----
const outPath = path.join(RAW, 'bili-meta-enriched.jsonl');
const doneBv = new Set();
if (fs.existsSync(outPath)) {
  for (const line of fs.readFileSync(outPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.bvid) doneBv.add(r.bvid); } catch {}
  }
}
log('already enriched=', doneBv.size);

const stStop = new Stopper(path.join(META, 'STOP'));
const b = new Bili({ rps: RPS, log });
await b.boot();

function partitionPath(tid, tname) {
  const pm = parentMap[String(tid)];
  return pm && pm.parent_name && tname ? `${pm.parent_name}/${tname}` : null;
}

let wrote = 0, ok = 0, fail = 0, noTag = 0;
const buf = [];
function flush() {
  if (!buf.length) return;
  fs.appendFileSync(outPath, buf.join(''), 'utf8');
  wrote += buf.length;
  buf.length = 0;
}
const t0 = Date.now();
for (let i = 0; i < picked.length; i++) {
  const r = picked[i];
  if (doneBv.has(r.bvid)) continue;
  if (stStop.hit()) { log('STOP'); break; }
  let v = null, tags = null;
  try {
    const j = await b.raw(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${r.bvid}`, null, { signed: false, retry: 2 });
    if (j?.code === 0 && j.data) { v = j.data.View || null; tags = Array.isArray(j.data.Tags) ? j.data.Tags.map((t) => t?.tag_name).filter(Boolean) : null; }
  } catch (e) { fail++; }
  if (!v) {
    // 拿不到就保留原记录（不许编造），标记 enriched:false
    buf.push(JSON.stringify({ ...r, enriched: false }) + '\n');
    ok++;
  } else {
    const st = v.stat || {};
    const rec = {
      ...r,
      tname: r.tname || v.tname || null,
      tid: v.tid ?? r.tid ?? null,
      partition_path: partitionPath(v.tid ?? r.tid, r.tname || v.tname),
      tags: tags || r.tags || [],
      pubdate: v.pubdate ?? r.pubdate ?? null,
      duration_s: v.duration ?? r.duration_s ?? null,
      stat: {
        view: st.view ?? r.stat?.view ?? null, danmaku: st.danmaku ?? r.stat?.danmaku ?? null,
        reply: st.reply ?? r.stat?.reply ?? null, favorite: st.favorite ?? r.stat?.favorite ?? null,
        coin: st.coin ?? r.stat?.coin ?? null, like: st.like ?? r.stat?.like ?? null, share: st.share ?? r.stat?.share ?? null,
      },
      desc_len: typeof v.desc === 'string' ? v.desc.length : r.desc_len ?? null,
      author_mid: v.owner?.mid ?? r.author_mid ?? null,
      author_name: v.owner?.name ?? r.author_name ?? null,
      enriched: true,
    };
    if (!rec.tags || !rec.tags.length) noTag++;
    doneBv.add(r.bvid);
    buf.push(JSON.stringify(rec) + '\n');
    ok++;
  }
  if (buf.length >= 200) flush();
  if ((i + 1) % 5000 === 0) {
    log(`  enriched ${i + 1}/${picked.length} wrote=${wrote + buf.length} fail=${fail} elapsed=${Math.round((Date.now() - t0) / 60000)}min`);
  }
}
flush();
const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
fs.writeFileSync(path.join(META, 'enrich-report.json'), JSON.stringify({
  finished_at: isoCST(), picked: picked.length, wrote, ok, fail, no_tag_after: noTag, bytes: size,
  rate: ((ok / ((Date.now() - t0) / 1000)) || 0).toFixed(2) + '/s',
  notes: ['用 view/detail 一次拿 View+Tags；拿不到 View 的条目标 enriched:false 且保留原字段，未编造。', 'view 接口对匿名请求不再返回 tname，故 tname 保留原记录（来自 search typename / 榜单），partition_path 由 tid→parent_map 推。'],
}, null, 1), 'utf8');
log('DONE enriched wrote=', wrote, 'bytes=', size, 'fail=', fail);
