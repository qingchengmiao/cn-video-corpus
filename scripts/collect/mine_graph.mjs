// 图扩展采集器：以 archive/related（40 条/请求，元数据齐全）为引擎做 BFS。
// 为什么不是纯搜索：本 IP 的 /x/web-interface/search/type 与 /wbi/search/type 都被 412/风控封了，
// 而 related / view / newlist / ranking / popular 全部 code=0。所以先用图扩展保住进度，搜索端点恢复后再叠。
import fs from 'node:fs';
import path from 'node:path';
import { Bili, RAW, META, mkdirs, isoCST, sleep, stripHtml, parseDuration, ShardWriter, listShards } from './miner_lib.mjs';

const TARGET = Number(process.env.TARGET || 600000);
const RPS = Number(process.env.RPS || 10);
const WORKERS = Number(process.env.WORKERS || 6);
const SHARD_MAX = Number(process.env.SHARD_MAX || 50000);
const PREFIX = 'bili-meta';
const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

mkdirs();
const regions = JSON.parse(fs.readFileSync(path.join(META, 'regions.json'), 'utf8'));
const parentMap = regions.parent_map || {};

const seen = new Set();
const expanded = new Set();
const buckets = new Map(); // tname -> bvid 队列
const cntByTname = new Map();
let total = 0;

function bucket(tname) {
  const k = tname || '(未知)';
  if (!buckets.has(k)) buckets.set(k, []);
  return buckets.get(k);
}
function queue(bvid, tname, view) {
  if (!bvid || seen.has(bvid)) return false;
  seen.add(bvid);
  bucket(tname).push(bvid);
  return true;
}

// ---- 载入已有分片 ----
const files = listShards(PREFIX);
let existing = 0;
const srcOf = new Map();   // bvid -> 原始 source（富化时保留）
const tnameOfBv = new Map(); // bvid -> 原始 tname（view 接口匿名不返回 tname，必须沿用采集时的）
const tidOfBv = new Map();
for (const f of files) {
  const p = path.join(RAW, f);
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    existing++;
    seen.add(r.bvid);
    srcOf.set(r.bvid, r.source);
    tnameOfBv.set(r.bvid, r.tname);
    tidOfBv.set(r.bvid, r.tid);
    cntByTname.set(r.tname || '(未知)', (cntByTname.get(r.tname || '(未知)') || 0) + 1);
    bucket(r.tname).push(r.bvid);
  }
}
const writer = new ShardWriter(PREFIX, { maxRecords: SHARD_MAX });
writer.resumeFrom(files, existing);
total = existing;
log(`resume files=${files.length} records=${existing} tnames=${buckets.size}`);

// 已完成扩展的 bvid（断点续跑）
const donePath = path.join(META, 'graph-expanded.jsonl');
if (fs.existsSync(donePath)) {
  for (const line of fs.readFileSync(donePath, 'utf8').split('\n')) { if (line.trim()) expanded.add(line.trim()); }
  log(`expanded loaded=${expanded.size}`);
}
const doneBuf = [];
function markExpanded(bvid) { expanded.add(bvid); doneBuf.push(bvid); if (doneBuf.length >= 500) flushDone(); }
function flushDone() { if (doneBuf.length) { fs.appendFileSync(donePath, doneBuf.join('\n') + '\n'); doneBuf.length = 0; } }

// 富化产出（融合在 view/detail 请求里，真标签，不猜）
const enrichedPath = path.join(RAW, 'bili-meta-enriched.jsonl');
const enrichedSet = new Set();
let enrichedCount = 0;
if (fs.existsSync(enrichedPath)) {
  for (const line of fs.readFileSync(enrichedPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.bvid && !enrichedSet.has(r.bvid)) { enrichedSet.add(r.bvid); enrichedCount++; } } catch {}
  }
  log(`enriched loaded=${enrichedCount}`);
}

// ---- 记录构造 ----
function relRec(v, src = 'related') {
  const tid = v.tid == null ? null : Number(v.tid);
  const pm = tid != null ? parentMap[String(tid)] : null;
  const st = v.stat || {};
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    platform: 'bilibili',
    bvid: v.bvid || null,
    aid: num(v.aid),
    title: v.title == null ? null : stripHtml(String(v.title)),
    tname: v.tname ?? null,
    tid,
    partition_path: pm ? `${pm.parent_name}/${v.tname}` : null,
    keyword: null,
    source: src,
    tags: [],
    author_mid: num(v.owner?.mid),
    author_name: v.owner?.name ?? null,
    pubdate: num(v.pubdate),
    duration_s: parseDuration(v.duration),
    stat: {
      view: num(st.view), danmaku: num(st.danmaku), reply: num(st.reply),
      favorite: num(st.favorite), coin: num(st.coin), like: num(st.like), share: num(st.share),
    },
    desc_len: typeof v.desc === 'string' ? v.desc.length : (v.desc == null ? null : String(v.desc).length),
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : null,
    crawled_at: isoCST(),
  };
}
let added = 0;
let dupItems = 0;
let rawItems = 0;
function push(rec) {
  if (!rec.bvid || seen.has(rec.bvid)) { dupItems++; return false; }
  seen.add(rec.bvid);
  writer.write(rec);
  added++; total++;
  const k = rec.tname || '(未知)';
  cntByTname.set(k, (cntByTname.get(k) || 0) + 1);
  bucket(k).push(rec.bvid);
  return true;
}

const b = new Bili({ rps: RPS });
await b.boot();
log(`boot ok rps=${RPS} workers=${WORKERS} target=${TARGET}`);

// ---- 冷启动种子：ranking / popular / newlist（一次性、便宜）----
async function seedRanking() {
  for (const rid of regions.valid_rids || [1, 3, 4, 5, 11, 23, 36]) {
    try {
      const j = await b.raw(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, null, { signed: false, retry: 1, riskRetry: false, riskPause: 8000 });
      const list = j?.data?.list || [];
      let n = 0;
      for (const v of list) { rawItems++; if (push(relRec(v, 'ranking'))) n++; }
      log(`  ranking rid=${rid} items=${list.length} new=${n}`);
    } catch (e) { log(`  ranking rid=${rid} ERR ${e.message}`); }
  }
}
async function seedPopular() {
  for (let pn = 1; pn <= 20; pn++) {
    let j = null;
    try { j = await b.raw('https://api.bilibili.com/x/web-interface/popular', { ps: 50, pn }, { signed: true, retry: 1 }); }
    catch (e) { log(`  popular pn=${pn} ERR ${e.message}`); break; }
    const list = j?.data?.list || [];
    if (!list.length) break;
    let n = 0;
    for (const v of list) { rawItems++; if (push(relRec(v, 'popular'))) n++; }
    log(`  popular pn=${pn} items=${list.length} new=${n}`);
    if (n === 0 && pn > 3) break;
  }
}
async function seedNewlist() {
  const rids = [1, 3, 4, 5, 11, 13, 23, 36, 119, 129, 155, 160, 167, 181, 188, 202, 211];
  for (const rid of rids) {
    for (let pn = 1; pn <= 3; pn++) {
      let j = null;
      try { j = await b.raw(`https://api.bilibili.com/x/web-interface/newlist?rid=${rid}&ps=50&pn=${pn}&type=0`, null, { signed: false, retry: 1, riskRetry: false }); }
      catch (e) { break; }
      const arr = j?.data?.archives || [];
      if (!arr.length) break;
      let n = 0;
      for (const v of arr) { rawItems++; if (push(relRec(v, 'newlist'))) n++; }
      log(`  newlist rid=${rid} pn=${pn} items=${arr.length} new=${n}`);
    }
  }
}

if (!process.env.SKIP_SEED) {
  await seedRanking();
  await seedPopular();
  await seedNewlist();
  log(`seeds done records=${total}`);
}

// ---- BFS：每次取「已采条数最少的分区」的队头，保证分区广度 ----
const inflight = new Set();
const tnOfBv = new Map();
let lastPickTname = null;
function nextBvid() {
  let bestK = null, bestC = Infinity;
  for (const [k, arr] of buckets) {
    if (!arr.length) continue;
    const c = cntByTname.get(k) || 0;
    if (c < bestC) { bestC = c; bestK = k; }
  }
  if (bestK == null) return null;
  const arr = buckets.get(bestK);
  while (arr.length) {
    const bv = arr.shift();
    if (expanded.has(bv) || inflight.has(bv)) continue;
    inflight.add(bv);
    return bv;
  }
  return nextBvid();
}

let reqs = 0;
let fail = 0;
let stop = false;
let lastBeat = Date.now();
let active = 0;
function checkStop() {
  if (fs.existsSync(path.join(META, 'STOP'))) { stop = true; log('STOP file detected'); }
  if (total >= TARGET) { stop = true; log('TARGET reached'); }
}
// 看门狗：15s 一次心跳，能看出卡在等待还是在推进
setInterval(() => {
  const q = [...buckets.values()].reduce((s, a) => s + a.length, 0);
  log(`  [beat] reqs=${reqs} records=${total} queue=${q} expanded=${expanded.size} inflight=${inflight.size} active=${active} fail=${fail}`);
}, 15000).unref();

// 每 5 分钟写 raw/_progress_bili-meta.json 给上游看 ETA
const progPath = path.join(RAW, '_progress_bili-meta.json');
let lastProgAt = Date.now();
let lastProgRecords = total;
function writeProgress() {
  const now = Date.now();
  const dtMin = (now - lastProgAt) / 60000;
  const ratePerMin = dtMin > 0.2 ? Math.round((total - lastProgRecords) / dtMin) : 0;
  const remain = Math.max(0, TARGET - total);
  fs.writeFileSync(progPath, JSON.stringify({
    records: total,
    files: listShards(PREFIX),
    rate_per_min: ratePerMin,
    eta_minutes: ratePerMin > 0 ? Math.round(remain / ratePerMin) : null,
    last_keyword: null,
    engine: 'archive/related BFS（search 通道 IP 级 412 不可用）',
    last_tname_expanded: lastTname,
    tname_count: [...buckets.keys()].length,
    reqs, fail, target: TARGET,
    rps: b.lim.rps, workers: WORKERS,
    updated_at: isoCST(),
  }, null, 1));
  lastProgAt = now; lastProgRecords = total;
}
setInterval(() => { try { writeProgress(); } catch (e) { log('progress write err', e.message); } }, 5 * 60 * 1000).unref();
let lastTname = null;

async function worker(id) {
  for (;;) {
    if (stop) return;
    checkStop();
    if (stop) return;
    const bv = nextBvid();
    if (!bv) { await sleep(500); continue; }
    if (!tnOfBv.has(bv)) tnOfBv.set(bv, lastPickTname);
    active++;
    let j = null;
    try {
      // view/detail 一次给 View+Tags+Related(40)：related 用来扩图，Tags 顺手把这条富化掉，
      // 省掉单独跑 5 万次 view 的富化阶段（同一请求干两件事）。
      j = await b.raw(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${bv}`, null, { signed: false, retry: 2, riskPause: 30000 });
    } catch (e) {
      fail++;
      inflight.delete(bv);
      active--;
      if (fail % 20 === 1) log(`  related ERR ${e.message} fail=${fail}`);
      await sleep(2000);
      continue;
    }
    reqs++;
    lastBeat = Date.now();
    const list = Array.isArray(j?.data?.Related) ? j.data.Related : (Array.isArray(j?.data) ? j.data : []);
    let n = 0;
    for (const v of list) { rawItems++; if (push(relRec(v, 'related'))) n++; }
    // 顺手富化当前节点（真标签，不猜）
    try {
      const v = j?.data?.View;
      const tags = Array.isArray(j?.data?.Tags) ? j.data.Tags.map((t) => t?.tag_name).filter(Boolean) : null;
      if (v && v.bvid && !enrichedSet.has(v.bvid)) {
        const rec = { ...relRec(v, srcOf.get(v.bvid) || 'related'), tags: tags || [], enriched: true };
        // view 接口匿名请求不返回 tname（返回空串），必须沿用采集时拿到的 tname/tid，否则分区字段会丢
        const ot = tnameOfBv.get(v.bvid);
        if (ot) rec.tname = ot;
        const oi = tidOfBv.get(v.bvid);
        if (oi != null) rec.tid = oi;
        rec.partition_path = (rec.tid != null && parentMap[String(rec.tid)] && rec.tname)
          ? `${parentMap[String(rec.tid)].parent_name}/${rec.tname}` : null;
        fs.appendFileSync(enrichedPath, JSON.stringify(rec) + '\n', 'utf8');
        enrichedSet.add(v.bvid);
        enrichedCount++;
        if (enrichedCount % 200 === 0) log(`  enriched=${enrichedCount}`);
      }
    } catch (e) { log('  enrich err', e.message); }
    markExpanded(bv);
    lastTname = tnOfBv.get(bv) || lastTname;
    inflight.delete(bv);
    active--;
    if (reqs % 100 === 0) {
      const dupRate = (dupItems / Math.max(1, rawItems) * 100).toFixed(0);
      const q = [...buckets.values()].reduce((s, a) => s + a.length, 0);
      log(`  reqs=${reqs} records=${total} (+${added}) queue=${q} tnames=${buckets.size} dup=${dupRate}% enriched=${enrichedCount} fail=${fail} elapsed=${Math.round((Date.now() - t0) / 60000)}min`);
      flushDone();
    }
    if (reqs % 500 === 0 && writer.buf.length) writer.flush();
  }
}

await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
flushDone();
if (writer.buf.length) writer.flush();
log(`DONE records=${total} added=${added} reqs=${reqs} fail=${fail} files=${writer.files.join(',')} elapsed=${Math.round((Date.now() - t0) / 60000)}min`);

// ---- 汇总 ----
const bySource = {};
const byTname = {};
const allFiles = listShards(PREFIX);
const seenFinal = new Set();
for (const f of allFiles) {
  for (const line of fs.readFileSync(path.join(RAW, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (seenFinal.has(r.bvid)) continue;
    seenFinal.add(r.bvid);
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byTname[r.tname || '(未知)'] = (byTname[r.tname || '(未知)'] || 0) + 1;
  }
}
const byTnameTop = Object.entries(byTname).sort((a, c) => c[1] - a[1]);
const byTnameAsc = Object.entries(byTname).sort((a, c) => a[1] - c[1]);
const summary = {
  name: 'bili-meta',
  records: seenFinal.size,
  files: allFiles,
  by_source: bySource,
  by_tname: Object.fromEntries(byTnameTop.slice(0, 40)),
  tname_count: byTnameTop.length,
  tname_bottom10: Object.fromEntries(byTnameAsc.slice(0, 10)),
  failed: [{ source: 'search /x/web-interface/search/type 与 /wbi/search/type', reason: 'IP 级 412（返回 3286 字节风控 HTML 页），两个路径都被封，搜索引擎整体不可用' }, ...(fail ? [{ source: 'archive/related', reason: `重试后仍失败 ${fail} 次` }] : [])],
  notes: [
    '主引擎是 archive/related 图扩展（40 条/请求，元数据齐全但无 tag），种子来自 ranking/popular/newlist。',
    '分区遍历无法按 tid 走：newlist 只接受 17 个一级 rid（子 tid 返回 n=0），dynamic/region 已 -404，ranking/v2 只接受 8 个 rid。因此分区覆盖靠 BFS 的「已采条数最少的 tname 优先」保证。',
    'tags 只有真从 view/detail 或 tag 接口拿到才写；未富化的记录 tags=[]（表示未采集，不是「无标签」）。',
    'partition_path 只在 meta/regions.json 的 parent_map 能唯一归属时拼「一级/二级」，否则 null。',
    'title 已去掉 <em class="keyword"> 这类高亮 HTML 标签，文字原样保留。',
  ],
};
fs.writeFileSync(path.join(RAW, '_summary_bili-meta.json'), JSON.stringify(summary, null, 2));
log('summary written', JSON.stringify({ records: summary.records, tname_count: summary.tname_count, by_source: bySource }));
