// 第3步：主采集。
// A ranking → B popular → C 搜索（按 order 分轮次）→ D related 图扩展（不足时）
// 去重、每 5 万条落盘、断点续跑、限速/退避。
import fs from 'node:fs';
import path from 'node:path';
import { Bili, ShardWriter, listShards, RAW, META, mkdirs, isoCST, stripHtml, parseDuration, sleep, Stopper } from './miner_lib.mjs';

const TARGET = Number(process.env.TARGET || 800000);
const RPS = Number(process.env.RPS || 6);
const WORKERS = Number(process.env.WORKERS || 4);
const MAX_PAGES = 20; // page_size=50 → 每词最多 1000 条（接口上限）
const ORDERS = (process.env.ORDERS || 'totalrank,pubdate,click,dm,stow').split(',');

mkdirs();
const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const regions = JSON.parse(fs.readFileSync(path.join(META, 'regions.json'), 'utf8'));
const kwFile = JSON.parse(fs.readFileSync(path.join(META, 'keywords.json'), 'utf8'));
const parentMap = regions.parent_map || {};
const stStop = new Stopper(path.join(META, 'STOP'));

const b = new Bili({ rps: RPS, log });
await b.boot();
log('boot ok rps=', RPS, 'workers=', WORKERS, 'target=', TARGET);

// ---------- 去重 / 续跑 ----------
const seen = new Set();
let priorCount = 0;
const existing = listShards('bili-meta');
for (const f of existing) {
  const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.bvid && !seen.has(r.bvid)) { seen.add(r.bvid); priorCount++; } } catch {}
  }
}
const writer = new ShardWriter('bili-meta', { maxRecords: 50000 });
writer.resumeFrom(existing, priorCount);
log('resume: files=', existing.length, 'records=', priorCount);

// 已完成任务日志
const journalPath = path.join(META, 'progress-search.jsonl');
const doneSet = new Set();
if (fs.existsSync(journalPath)) {
  for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) { if (line.trim()) doneSet.add(line); }
}
const jbuf = [];
function markDone(key) { doneSet.add(key); jbuf.push(key); if (jbuf.length >= 200) { fs.appendFileSync(journalPath, jbuf.join('\n') + '\n'); jbuf.length = 0; } }

// 统计
const bySource = {};
const byTname = {};
let added = 0, rawItems = 0, dupItems = 0, badItems = 0, lastReport = 0;
const failed = [];

function bump(obj, k) { obj[k] = (obj[k] || 0) + 1; }

function partitionPath(tid, tname) {
  const pm = parentMap[String(tid)];
  if (pm && pm.parent_name && tname) return `${pm.parent_name}/${tname}`;
  return null;
}

function mkRecord({ bvid, aid, title, tname, tid, tags, mid, author, pubdate, dur, stat, desc, keyword, source }) {
  return {
    platform: 'bilibili',
    bvid: bvid || null,
    aid: aid ?? null,
    title: stripHtml(title) ?? null,
    tname: tname || null,
    tid: tid ?? null,
    partition_path: partitionPath(tid, tname),
    keyword: keyword ?? null,
    source,
    tags: Array.isArray(tags) ? tags : [],
    author_mid: mid ?? null,
    author_name: author ?? null,
    pubdate: pubdate ?? null,
    duration_s: dur ?? null,
    stat: stat || { view: null, danmaku: null, reply: null, favorite: null, coin: null, like: null, share: null },
    desc_len: typeof desc === 'string' ? desc.length : (desc == null ? null : null),
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : null,
    crawled_at: isoCST(),
  };
}

function push(rec) {
  if (!rec.bvid) { badItems++; return false; }
  if (seen.has(rec.bvid)) { dupItems++; return false; }
  seen.add(rec.bvid);
  writer.write(rec);
  added++;
  bump(bySource, rec.source);
  bump(byTname, rec.tname || 'null');
  if (added % 10000 === 0) {
    log(`records=${priorCount + added} (+${added}) raw=${rawItems} dup=${dupItems} rate=${(rawItems / ((Date.now() - t0) / 1000)).toFixed(2)}/s files=${writer.idx + 1} queueBuf=${writer.buf.length}`);
  }
  return true;
}

// ---------- 映射 ----------
function fromSearch(v, keyword) {
  return mkRecord({
    bvid: v.bvid, aid: v.aid, title: v.title, tname: v.typename, tid: v.typeid ? Number(v.typeid) : null,
    tags: typeof v.tag === 'string' && v.tag ? v.tag.split(',').map((s) => s.trim()).filter(Boolean) : [],
    mid: v.mid, author: v.author, pubdate: v.pubdate, dur: parseDuration(v.duration),
    stat: {
      view: v.play ?? null, danmaku: v.video_review ?? v.danmaku ?? null, reply: v.review ?? null,
      favorite: v.favorites ?? null, coin: null, like: v.like ?? null, share: null,
    },
    desc: v.description, keyword, source: 'search',
  });
}
function fromStatItem(v, source, keyword) {
  const s = v.stat || {};
  return mkRecord({
    bvid: v.bvid, aid: v.aid, title: v.title, tname: v.tname, tid: v.tid,
    tags: typeof v.tag === 'string' && v.tag ? v.tag.split(',').map((x) => x.trim()).filter(Boolean) : [],
    mid: v.owner?.mid, author: v.owner?.name, pubdate: v.pubdate, dur: v.duration,
    stat: {
      view: s.view ?? null, danmaku: s.danmaku ?? null, reply: s.reply ?? null,
      favorite: s.favorite ?? null, coin: s.coin ?? null, like: s.like ?? null, share: s.share ?? null,
    },
    desc: v.desc, keyword, source,
  });
}

// ---------- A. ranking ----------
const rankRids = (regions.valid_rids || [0, 1, 3, 4, 5, 11, 23, 36]);
if (!doneSet.has('PHASE_A')) {
  log('A. ranking rids=', rankRids.join(','));
  for (const rid of rankRids) {
    const key = `ranking|${rid}`;
    if (doneSet.has(key)) continue;
    try {
      const j = await b.raw(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, null, { signed: false });
      let n = 0;
      for (const v of j?.data?.list || []) { rawItems++; if (push(fromStatItem(v, 'ranking', null))) n++; }
      log(`  ranking rid=${rid} items=${(j?.data?.list || []).length} new=${n}`);
      markDone(key);
    } catch (e) { failed.push({ source: `ranking rid=${rid}`, reason: e.message }); }
  }
  markDone('PHASE_A');
}

// ---------- B. popular ----------
if (!doneSet.has('PHASE_B')) {
  log('B. popular');
  for (let pn = 1; pn <= 40; pn++) {
    const key = `popular|${pn}`;
    if (doneSet.has(key)) continue;
    try {
      const j = await b.raw('https://api.bilibili.com/x/web-interface/popular', { ps: 50, pn }, { signed: true });
      const list = j?.data?.list || [];
      if (!list.length) break;
      let n = 0;
      for (const v of list) { rawItems++; if (push(fromStatItem(v, 'popular', null))) n++; }
      log(`  popular pn=${pn} items=${list.length} new=${n}`);
      markDone(key);
      if (j?.data?.no_more) break;
    } catch (e) { failed.push({ source: `popular pn=${pn}`, reason: e.message }); break; }
  }
  markDone('PHASE_B');
}

// ---------- C. 搜索（多 order 轮次） ----------
const kws = kwFile.keywords.map((k) => k.w);
// 打散，避免相邻关键词同源
let seed = 20261124;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const shuffled = [...kws];
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }

log('C. search keywords=', shuffled.length, 'orders=', ORDERS.join(','), 'workers=', WORKERS);
let kwIdx = 0;
let kwDone = 0;
function flushJournal() {
  if (jbuf.length) { fs.appendFileSync(journalPath, jbuf.join('\n') + '\n'); jbuf.length = 0; }
}
async function keywordWorker(order) {
  for (;;) {
    if (priorCount + added >= TARGET) return;
    if (stStop.hit()) return;
    const my = kwIdx++;
    if (my >= shuffled.length) return;
    const kw = shuffled[my];
    let got = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const key = `search|${order}|${kw}|${page}`;
      if (doneSet.has(key)) continue;
      let j = null;
      try {
        j = await b.search(kw, page, order);
      } catch (e) {
        failed.push({ source: `search ${order} ${kw} p${page}`, reason: e.message });
        break;
      }
      const res = j?.data?.result || [];
      markDone(key);
      if (!res.length) break;
      for (const v of res) { rawItems++; if (push(fromSearch(v, kw))) got++; }
      if (res.length < 50) break;
    }
    kwDone++;
    if (kwDone % 50 === 0) {
      log(`  order=${order} kw=${kwDone} idx=${kwIdx}/${shuffled.length} records=${priorCount + added} files=${writer.idx + 1} dupRate=${(dupItems / Math.max(1, rawItems) * 100).toFixed(0)}%`);
      flushJournal();
    }
  }
}
outer:
for (const order of ORDERS) {
  kwIdx = 0; kwDone = 0;
  await Promise.all(Array.from({ length: WORKERS }, () => keywordWorker(order)));
  flushJournal();
  if (priorCount + added >= TARGET || stStop.hit()) break outer;
}

// ---------- D. related 图扩展（不足时） ----------
if (priorCount + added < TARGET) {
  log('D. related 扩展，当前 records=', priorCount + added);
  // 每 tname 取播放最高的一批作为种子（有界内存：每 tname 只留 topN）
  const perT = new Map();
  const seeds = [];
  {
    const files = listShards('bili-meta');
    const topN = 200;
    for (const f of files) {
      const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r.bvid || r.stat?.view == null) continue;
        const tn = r.tname || 'null';
        let arr = perT.get(tn);
        if (!arr) { arr = []; perT.set(tn, arr); }
        arr.push([r.stat.view, r.bvid]);
        if (arr.length > topN * 2) { arr.sort((a, c) => c[0] - a[0]); arr.length = topN; }
      }
    }
    const all = [];
    for (const [, arr] of perT) { arr.sort((a, c) => c[0] - a[0]); arr.length = topN; all.push(...arr); }
    all.sort((a, c) => c[0] - a[0]);
    for (const [, bv] of all) { seeds.push(bv); if (seeds.length >= 40000) break; }
    log('  related seeds=', seeds.length, 'tnames=', perT.size);
  }
  for (let i = 0; i < seeds.length; i++) {
    if (priorCount + added >= TARGET) break;
    if (stStop.hit()) break;
    const bv = seeds[i];
    const key = `related|${bv}`;
    if (doneSet.has(key)) continue;
    try {
      const j = await b.raw(`https://api.bilibili.com/x/web-interface/archive/related?bvid=${bv}`, null, { signed: false });
      for (const v of j?.data || []) { rawItems++; push(fromStatItem(v, 'related', null)); }
      markDone(key);
    } catch (e) { /* 单个失败不记 */ }
    if ((i + 1) % 500 === 0) {
      log(`  related ${i + 1}/${seeds.length} records=${priorCount + added}`);
      fs.appendFileSync(journalPath, jbuf.join('\n') + (jbuf.length ? '\n' : '')); jbuf.length = 0;
      writer.flush();
    }
  }
}

// ---------- 收尾 ----------
if (jbuf.length) fs.appendFileSync(journalPath, jbuf.join('\n') + '\n');
writer.flush();
const total = priorCount + added;
const files = listShards('bili-meta');
const byTnameTop = Object.entries(byTname).sort((a, c) => c[1] - a[1]).slice(0, 40);
const summary = {
  name: 'bili-meta',
  records: total,
  this_run_added: added,
  files,
  file_bytes: files.map((f) => ({ file: f, bytes: fs.statSync(path.join(RAW, f)).size })),
  by_source: bySource,
  by_tname: Object.fromEntries(byTnameTop),
  tnames_total: Object.keys(byTname).length,
  failed,
  notes: [
    '主入口 search 每关键词最多 1000 条（page_size=50 × 20 页），是接口硬上限；靠多关键词（' + shuffled.length + ' 个）+ 多排序（' + ORDERS.join('/') + '）铺量，因此对长尾冷门稿件覆盖偏弱。',
    'tags 只写接口真实返回：search 条目的 tag 字段、ranking/popular/related 无 tag 字段则空数组，未用标题猜。',
    'partition_path 仅当 tid 能在 regions.json 的 parent_map 中唯一对上（ranking 榜单实证）时才拼 parent/tname，否则 null。',
    'stat 中 search 来源缺 coin/share（接口不返回），写 null；ranking/popular/related 来源字段完整。',
    'related 扩展轮只用已采到的高播放视频（每 tname 前 200）作图扩展。',
    'crawled_at 为 UTC+08:00 的 ISO 时间。',
  ],
  elapsed_min: Math.round((Date.now() - t0) / 60000),
  finished_at: isoCST(),
};
fs.writeFileSync(path.join(RAW, '_summary_bili-meta.json'), JSON.stringify(summary, null, 1), 'utf8');
log('DONE total=', total, 'added=', added, 'files=', files.length, 'elapsed=', Math.round((Date.now() - t0) / 60000) + 'min');
