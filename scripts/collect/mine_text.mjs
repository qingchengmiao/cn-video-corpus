#!/usr/bin/env node
// mine_text.mjs — B站文本采集（弹幕 + 评论，目标 30 万条）
// 只用 node 内建模块；不装依赖；不打印正文。
// 输出：raw/bili-text-001.jsonl …（每 2 万条或 200MB 切一个）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAW = process.env.MINE_RAW ? path.resolve(process.env.MINE_RAW) : path.join(DIR, 'raw');
const STATE_FILE = path.join(RAW, '_state_bili-text.json');
const POOL_FILE = path.join(RAW, '_pool_bili-text.json');

const TARGET_DM = Number(process.env.MINE_DM ?? 300000);
const TARGET_REPLY = Number(process.env.MINE_REPLY ?? 70000);
const DM_PER_VIDEO = Number(process.env.MINE_DM_PER_VIDEO ?? 2000);
const CONC = Number(process.env.MINE_CONC ?? 3);
const BASE_RPS = Number(process.env.MINE_RPS ?? 5.0);
const MAX_VIDEOS = Number(process.env.MINE_MAX_VIDEOS ?? 6000);
const RID_MAX = Number(process.env.MINE_RID_MAX ?? 500);
const NL_MAX = Number(process.env.MINE_NL_MAX ?? 500);
const POP_PAGES = Number(process.env.MINE_POP_PAGES ?? 5);
const POOL_MAX = Number(process.env.MINE_POOL_MAX ?? 30000);
const TN_MIN = 3; // 每个 tname 至少 3 个视频
const SAVE_EVERY = 20;
const FILE_MAX_RECORDS = 20000;
const FILE_MAX_BYTES = 200 * 1024 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_FAILED = 300;
function pushFail(source, reason) {
  if (state.failed.length >= MAX_FAILED) {
    state.failedDropped = (state.failedDropped || 0) + 1;
    return;
  }
  state.failed.push({ source, reason: String(reason ?? '').slice(0, 200) });
}
function nowCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
}
function log(s) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); }

// ---------------- HTTP 层 ----------------
let COOKIE = '';
let WBI_MIXIN = '';
let wbiKeysAt = 0;
let rps = BASE_RPS;
let nextSlot = 0;
let reqCount = 0;
let riskEvents = 0;
let okStreak = 0;
let pauseUntil = 0;
const minedTname = new Map(); // tname -> Set(bvid)，覆盖进度用

function headers() {
  return {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Cookie: COOKIE,
  };
}

async function gate() {
  let now = Date.now();
  if (pauseUntil > now) {
    await sleep(pauseUntil - now);
    now = Date.now();
  }
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / rps;
  if (at > now) await sleep(at - now);
}

async function boot() {
  const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const setc = r.headers.getSetCookie?.() || [];
  let ck = setc.map((c) => c.split(';')[0]).join('; ');
  try {
    const spi = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA, Cookie: ck }, signal: AbortSignal.timeout(15000) })).json();
    if (spi?.data?.b_3) ck += `; buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4}`;
  } catch { /* 拿不到 buvid 也能跑 */ }
  COOKIE = ck;
  await refreshWbi();
}
async function refreshWbi() {
  const j = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: headers(), signal: AbortSignal.timeout(15000) })).json();
  const img = j?.data?.wbi_img?.img_url || '';
  const sub = j?.data?.wbi_img?.sub_url || '';
  const key = (img.split('/').pop() || '').split('.')[0] + (sub.split('/').pop() || '').split('.')[0];
  let m = '';
  for (const i of MIXIN) m += key[i] ?? '';
  WBI_MIXIN = m.slice(0, 32);
  wbiKeysAt = Date.now();
}
function wbiQuery(params) {
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${q}&w_rid=${crypto.createHash('md5').update(q + WBI_MIXIN).digest('hex')}`;
}
async function backoff(ms) {
  riskEvents++;
  const until = Date.now() + ms;
  if (until > pauseUntil) pauseUntil = until;
  rps = Math.max(2.2, rps * 0.7);
  okStreak = 0;
  if (riskEvents <= 3 || riskEvents % 8 === 0) log(`! 风控/限流 ${riskEvents} 次，全队暂停 ${(ms / 1000).toFixed(0)}s，rps=${rps.toFixed(2)}`);
  await sleep(Math.min(ms, 6000));
  if (Date.now() - wbiKeysAt > 10 * 60 * 1000) await boot().catch(() => {});
}

// 返回 JSON；binary=true 返回 Buffer
async function httpGet(url, opts = {}) {
  const { binary = false, tries = 4 } = opts;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (Date.now() - wbiKeysAt > 20 * 60 * 1000) await refreshWbi().catch(() => {});
    await gate();
    reqCount++;
    let res;
    try {
      res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(25000) });
    } catch (e) {
      lastErr = e;
      await sleep(1200 + i * 800);
      continue;
    }
    if (res.status === 412 || res.status === 429) {
      lastErr = new Error('HTTP ' + res.status);
      await backoff(30000);
      continue;
    }
    if (res.status !== 200) {
      lastErr = new Error('HTTP ' + res.status);
      await sleep(800 + i * 800);
      continue;
    }
    okStreak++
    if (okStreak % 60 === 0 && rps < BASE_RPS) rps = Math.min(BASE_RPS, rps + 0.2);
    if (binary) return Buffer.from(await res.arrayBuffer());
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      lastErr = new Error('bad json');
      await sleep(800 + i * 800);
      continue;
    }
    if (json.code === -352 || json.code === -412 || json.code === -509) {
      lastErr = new Error('risk code ' + json.code);
      await backoff(30000);
      continue;
    }
    okStreak++
    if (okStreak % 60 === 0 && rps < BASE_RPS) rps = Math.min(BASE_RPS, rps + 0.2);
    return json;
  }
  throw lastErr || new Error('request failed');
}
async function wbiGet(url, params, opts) {
  return httpGet(`${url}?${wbiQuery(params)}`, opts);
}

// ---------------- 脱敏 ----------------
function desensitize(s) {
  let t = s;
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<已隐去>'); // 邮箱
  t = t.replace(/(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/g, '<已隐去>'); // 手机
  t = t.replace(/(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])/g, '<已隐去>'); // 身份证 18
  t = t.replace(/(?<![0-9A-Za-z])\d{15}(?![0-9A-Za-z])/g, '<已隐去>'); // 身份证 15
  t = t.replace(/(?:qq|扣扣|企鹅|群号|加群|q群)\s*[:：]?\s*[1-9]\d{4,10}/gi, (m) => m.replace(/[1-9]\d{4,10}/, '<已隐去>'));
  t = t.replace(/(?<![0-9A-Za-z])\d{9,11}(?![0-9A-Za-z])/g, '<已隐去>'); // 裸 9–11 位号（QQ）
  return t;
}

// ---------------- 解析 ----------------
function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function parseDanmaku(xml) {
  const out = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const p = m[1].split(',');
    const text = unescapeXml(m[2]);
    if (!text || !text.trim()) continue;
    const time = Number(p[0]);
    if (!Number.isFinite(time) || time < 0) continue;
    out.push({ time, mode: Number(p[1]) || 0, color: Number(p[3]) || 16777215, text });
  }
  return out;
}
// 时间上均匀抽 k 条：先按时间排序，再等距取；n<=k 全留
function sampleByTime(list, k) {
  if (list.length <= k) return list.slice();
  const sorted = list.slice().sort((a, b) => a.time - b.time);
  const out = [];
  const n = sorted.length;
  for (let i = 0; i < k; i++) out.push(sorted[Math.round((i * (n - 1)) / (k - 1))]);
  return out;
}

// ---------------- 落盘 ----------------
const state = {
  processed: [],
  dm: 0,
  reply: 0,
  videos: 0,
  videos_with_dm: 0,
  videos_with_reply: 0,
  by_tname: {},
  files: [],
  failed: [],
  started_at: nowCN(),
};
const processedSet = new Set();
const seen = new Set();
const hashKey = (kind, bvid, t, text) => crypto.createHash('md5').update(`${kind}|${bvid}|${t ?? ''}|${text}`).digest('base64');

let fileIdx = 0;
let curRecords = 0;
let curBytes = 0;
let stream = null;

function filePath(i) { return path.join(RAW, `bili-text-${String(i).padStart(3, '0')}.jsonl`); }
function openNewFile() {
  fileIdx += 1;
  curRecords = 0;
  curBytes = 0;
  if (stream) stream.end();
  stream = fs.createWriteStream(filePath(fileIdx), { flags: 'a' });
  state.files.push(`bili-text-${String(fileIdx).padStart(3, '0')}.jsonl`);
}
async function writeRec(obj, line) {
  if (curRecords >= FILE_MAX_RECORDS || curBytes + line.length > FILE_MAX_BYTES) openNewFile();
  const ok = stream.write(line);
  curRecords++;
  curBytes += line.length;
  if (!ok) await new Promise((r) => stream.once('drain', r));
}
async function flush() {
  if (!stream) return;
  await new Promise((r) => stream.write('', r));
}

function saveState() {
  state.processed = [...processedSet];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return false;
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  Object.assign(state, s);
  state.failed = state.failed || [];
  state.by_tname = state.by_tname || {};
  state.files = state.files || [];
  for (const b of state.processed || []) processedSet.add(b);
  return true;
}

// 从已存在文件重建 seen / 计数（续跑用）
function rebuildFromFiles() {
  const files = fs.readdirSync(RAW).filter((f) => /^bili-text-\d{3}\.jsonl$/.test(f)).sort();
  if (!files.length) return;
  let dm = 0, rp = 0;
  const vids = new Set();
  const tn = {};
  let last = null, lastCount = 0, lastBytes = 0;
  for (const f of files) {
    const p = path.join(RAW, f);
    const txt = fs.readFileSync(p, 'utf8');
    lastBytes = txt.length;
    lastCount = 0;
    for (const line of txt.split('\n')) {
      if (!line) continue;
      lastCount++;
      let o; try { o = JSON.parse(line); } catch { continue; }
      seen.add(hashKey(o.kind, o.bvid, o.kind === 'danmaku' ? o.time_ms : o.ctime, o.text));
      vids.add(o.bvid);
      if (o.tname) {
        let ss = minedTname.get(o.tname);
        if (!ss) { ss = new Set(); minedTname.set(o.tname, ss); }
        ss.add(o.bvid);
      }
      if (o.kind === 'danmaku') dm++; else rp++;
      const k = o.tname || 'null';
      tn[k] = (tn[k] || 0) + 1;
    }
    last = f;
  }
  state.dm = dm; state.reply = rp;
  state.by_tname = tn;
  // 顶楼/楼中楼数不再重算，videos 以 state 为准
  if (!state.videos) state.videos = vids.size;
  fileIdx = files.length;
  curRecords = lastCount;
  curBytes = lastBytes;
  state.files = files;
  stream = fs.createWriteStream(path.join(RAW, last), { flags: 'a' });
  log(`续跑：已存在 ${files.length} 个文件，dm=${dm} reply=${rp}，当前文件 ${last}（${lastCount} 条）`);
}

// ---------------- 候选池 ----------------
// 池子里能带齐的元数据尽量带齐：aid/cid/pubdate 齐了就不必再打 view
const pool = new Map();
// B站 有些计数字段是字符串（"1.2万" / "3456"），统一转成数字，拿不到就 null
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const m = s.match(/^([\d.]+)\s*(万|亿)?$/);
  if (m) return Math.round(parseFloat(m[1]) * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1));
  return null;
}
function addCand(bvid, tname, source, extra) {
  if (!bvid || typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return;
  const x = extra || {};
  const rp = num(x.reply), dk = num(x.danmaku);
  const cur = pool.get(bvid);
  if (cur) {
    if (!cur.tname && tname) cur.tname = tname;
    if (cur.reply == null && rp != null) cur.reply = rp;
    if (cur.aid == null && x.aid != null) cur.aid = x.aid;
    if (cur.cid == null && x.cid != null) cur.cid = x.cid;
    if (cur.pubdate == null && x.pubdate != null) cur.pubdate = x.pubdate;
    if (cur.danmaku == null && dk != null) cur.danmaku = dk;
    if (cur.source === 'ranking' && source !== 'ranking') cur.source = source;
    return;
  }
  pool.set(bvid, {
    bvid, tname: tname || null, source, rid: x.rid ?? null,
    reply: rp, danmaku: dk,
    aid: x.aid ?? null, cid: x.cid ?? null, pubdate: x.pubdate ?? null,
  });
}

// 种子池：缓存优先；否则 ranking(rid 1..500, day=3) + popular 前几页
async function buildSeeds() {
  if (fs.existsSync(POOL_FILE)) {
    const arr = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    log(`复用候选池：${arr.length} 个视频`);
    return arr;
  }
  log(`建池：ranking rid 1..${RID_MAX} + popular ${POP_PAGES} 页（newlist/search 已死，不用）`);
  const seeds = new Map();
  function push(bvid, tname, source, extra) {
    if (!bvid || !/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return;
    const x = extra || {};
    if (seeds.has(bvid)) return;
    seeds.set(bvid, {
      bvid, tname: tname || null, source, rid: x.rid ?? null,
      reply: num(x.reply), danmaku: num(x.danmaku),
      aid: x.aid ?? null, cid: x.cid ?? null, pubdate: x.pubdate ?? null,
    });
  }
  let cursor = 0;
  const rkTasks = [];
  for (let rid = 1; rid <= RID_MAX; rid++) rkTasks.push(rid);
  async function rkWorker() {
    while (true) {
      const i = cursor++;
      if (i >= rkTasks.length) break;
      const rid = rkTasks[i];
      try {
        const j = await httpGet(`https://api.bilibili.com/x/web-interface/ranking?rid=${rid}&day=3`);
        for (const v of j?.data?.list || []) {
          push(v.bvid, null, 'ranking', { danmaku: v.video_review, aid: v.aid, cid: v.cid, rid });
        }
      } catch (e) {
        pushFail('ranking:' + rid, e.message);
      }
    }
  }
  await Promise.all([rkWorker(), rkWorker(), rkWorker()]);
  log(`ranking 种子 ${seeds.size}`);
  for (let pn = 1; pn <= POP_PAGES; pn++) {
    try {
      const j = await wbiGet('https://api.bilibili.com/x/web-interface/popular', { ps: 50, pn });
      const list = j?.data?.list || [];
      if (!list.length) break;
      for (const v of list) {
        push(v.bvid, v.tname || null, 'popular', {
          reply: v.stat?.reply, danmaku: v.stat?.danmaku,
          aid: v.aid, cid: v.cid, pubdate: v.pubdate,
        });
      }
    } catch (e) {
      pushFail('popular:' + pn, e.message);
      break;
    }
  }
  const ordered = [...seeds.values()].sort((a, b) => (b.reply ?? 0) - (a.reply ?? 0));
  fs.writeFileSync(POOL_FILE, JSON.stringify(ordered), 'utf8');
  log(`种子池：${ordered.length} 个视频`);
  return ordered;
}

// ---------------- 动态调度：按 tname 轮转，related 生长 ----------------
const byTname = new Map(); // tname -> {arr:[bvid], i, mined}
const claimed = new Set();
function tnGroup(tname) {
  const k = tname || 'null';
  let g = byTname.get(k);
  if (!g) { g = { arr: [], i: 0, mined: minedTname.get(k)?.size || 0 }; byTname.set(k, g); }
  return g;
}
function enqueue(cand) {
  if (!cand || !cand.bvid) return false;
  if (pool.has(cand.bvid) || processedSet.has(cand.bvid)) return false;
  pool.set(cand.bvid, cand);
  tnGroup(cand.tname).arr.push(cand.bvid);
  return true;
}
// 优先补 mined<TN_MIN 的 tname；同优先级下取 mined 最少的
function claimNext() {
  for (let guard = 0; guard < 5000; guard++) {
    let bestTn = null, bestScore = Infinity;
    for (const [tn, g] of byTname) {
      if (g.i >= g.arr.length) continue;
      const score = g.mined < TN_MIN ? g.mined : 1000 + g.mined;
      if (score < bestScore) { bestScore = score; bestTn = tn; }
    }
    if (bestTn == null) return null;
    const g = byTname.get(bestTn);
    // 从后面 40 个待挖里挑 stat.reply 最高的：评论区大的先挖，评论产出更高
    let bestPicked = null, bestReply = -1, bestAt = -1;
    for (let k = g.i; k < Math.min(g.arr.length, g.i + 40); k++) {
      const bv = g.arr[k];
      if (processedSet.has(bv) || claimed.has(bv)) continue;
      const rp = pool.get(bv)?.reply ?? -1;
      if (rp > bestReply) { bestReply = rp; bestPicked = bv; bestAt = k; }
    }
    if (bestPicked) {
      g.arr.splice(bestAt, 1);
      claimed.add(bestPicked);
      return { c: pool.get(bestPicked), tn: bestTn };
    }
    g.i = g.arr.length;
  }
  return null;
}
function coverageMissing() {
  const miss = [];
  for (const [tn, g] of byTname) if (g.mined < TN_MIN && g.i < g.arr.length) miss.push(tn);
  return miss.length;
}
// 顺着 related 从已挖视频滚出邻居（带 cid/aid/tname/stat，不必再打 view）
async function growFrom(bvid) {
  if (pool.size >= Math.min(POOL_MAX, 15000)) return 0;
  try {
    const j = await httpGet(`https://api.bilibili.com/x/web-interface/archive/related?bvid=${bvid}`);
    const list = j?.data || [];
    let added = 0;
    for (const v of list) {
      if (enqueue({
        bvid: v.bvid, tname: v.tname || null, source: 'related',
        reply: num(v.stat?.reply), danmaku: num(v.stat?.danmaku),
        aid: v.aid ?? null, cid: v.cid ?? null, pubdate: v.pubdate ?? null,
      })) added++;
    }
    return added;
  } catch (e) {
    pushFail('related:' + bvid, e.message);
    return 0;
  }
}


// 池子与覆盖进度落盘：重启不丢「已发现的 tname / 已挖视频数」
const POOL2 = path.join(RAW, '_pool2_bili-text.json');
function savePool() {
  try {
    const items = [];
    for (const c of pool.values()) {
      if (processedSet.has(c.bvid)) continue;
      items.push({ b: c.bvid, t: c.tname, a: c.aid, c: c.cid, r: c.reply, p: c.pubdate, s: c.source });
      if (items.length >= 20000) break;
    }
    const tnames = {};
    for (const [tn, set] of minedTname) tnames[tn] = set.size;
    fs.writeFileSync(POOL2, JSON.stringify({ v: 1, tnames, items }), 'utf8');
  } catch {}
}
function loadPool() {
  if (!fs.existsSync(POOL2)) return false;
  try {
    const o = JSON.parse(fs.readFileSync(POOL2, 'utf8'));
    for (const [tn, n] of Object.entries(o.tnames || {})) {
      let set = minedTname.get(tn);
      if (!set) { set = new Set(); minedTname.set(tn, set); }
      tnGroup(tn).mined = n;
    }
    let n = 0;
    for (const it of o.items || []) {
      if (enqueue({ bvid: it.b, tname: it.t || null, source: it.s || 'pool2',
        reply: it.r ?? null, danmaku: null, aid: it.a ?? null, cid: it.c ?? null, pubdate: it.p ?? null })) n++;
    }
    log('恢复池子：' + n + ' 个待挖，' + Object.keys(o.tnames || {}).length + ' 个 tname 历史');
    return true;
  } catch { return false; }
}

// ---------------- 单视频采集 ----------------
function addDmRecords(bvid, cid, tname, pubdate, dmList, cap) {
  let n = 0;
  for (const d of dmList) {
    const text = desensitize(d.text);
    if (!text || !text.trim()) continue;
    const timeMs = Math.round(d.time * 1000);
    const h = hashKey('danmaku', bvid, timeMs, text);
    if (seen.has(h)) continue;
    seen.add(h);
    const rec = {
      platform: 'bilibili', kind: 'danmaku', bvid, cid, tname,
      text, time_ms: timeMs, mode: d.mode, color: d.color,
      video_pubdate: pubdate ?? null, crawled_at: nowCN(),
    };
    pending.push(rec);
    n++;
    if (state.dm + n >= cap) break;
  }
  return n;
}

const pending = [];
async function flushPending() {
  if (!pending.length) return;
  const buf = [];
  for (const rec of pending) {
    const line = JSON.stringify(rec) + '\n';
    if (rec.kind === 'danmaku') state.dm++; else state.reply++;
    const k = rec.tname || 'null';
    state.by_tname[k] = (state.by_tname[k] || 0) + 1;
    buf.push(line);
  }
  pending.length = 0;
  for (const line of buf) await writeRec(null, line);
}

function pushReplyRec(bvid, tname, r, depth, rootId) {
  const msg = r?.content?.message;
  if (typeof msg !== 'string' || !msg.trim()) return 0;
  const text = desensitize(msg);
  if (!text.trim()) return 0;
  const h = hashKey('reply', bvid, r.ctime ?? 0, text);
  if (seen.has(h)) return 0;
  seen.add(h);
  const root = depth === 0 ? 0 : (r.root || rootId || 0);
  const rec = {
    platform: 'bilibili', kind: 'reply', bvid, rpid: r.rpid,
    root: depth === 0 ? 0 : root,
    parent: depth === 0 ? 0 : (r.parent || 0),
    depth,
    text, likes: r.like ?? null, ctime: r.ctime ?? null,
    uid: r.mid ?? r.member?.mid ?? null,
    tname, crawled_at: nowCN(),
  };
  pending.push(rec);
  return 1;
}

async function processVideo(c) { // 返回解析后的 tname
  // 池子里带了 aid/cid/pubdate/tname 的（newlist、popular）就不必再打 view
  let bvid = c.bvid, aid = c.aid, cid = c.cid, tname = c.tname || null, pubdate = c.pubdate ?? null;
  if (!(aid && cid && tname && pubdate != null)) {
    const jv = await httpGet(`https://api.bilibili.com/x/web-interface/view?bvid=${c.bvid}`);
    if (jv.code !== 0 || !jv.data) {
      pushFail('view:' + c.bvid, `code ${jv.code} ${jv.message || ''}`);
      return;
    }
    const d = jv.data;
    // 池子里 ranking 的 tname 是顶层分区名，view 给的分区更细，优先用 view 的
    tname = d.tname || d.tname_v2 || tname || null;
    bvid = d.bvid || c.bvid;
    aid = d.aid;
    cid = d.cid;
    pubdate = d.pubdate ?? pubdate ?? null;
  }

  // 弹幕：list.so 已对匿名 IP 返回 412，改用 comment.bilibili.com 的 XML（同格式，无需签名）
  if (state.dm < TARGET_DM && cid) {
    try {
      const buf = await httpGet(`https://comment.bilibili.com/${cid}.xml`, { binary: true });
      const xml = buf.toString('utf8');
      const all = parseDanmaku(xml);
      if (all.length) {
        const cap = Math.min(DM_PER_VIDEO, TARGET_DM - state.dm);
        const picked = sampleByTime(all, cap);
        if (addDmRecords(bvid, cid, tname, pubdate, picked, TARGET_DM) > 0) state.videos_with_dm++;
      }
    } catch (e) {
      pushFail('dm:' + bvid, e.message);
    }
  }

  // 评论：wbi/main mode=1 与 mode=3 各给 3 条互不相同的顶楼
  if (state.reply < TARGET_REPLY && aid) {
    const roots = [];
    const rootIds = new Set();
    for (const mode of [1, 3]) {
      try {
        const j = await wbiGet('https://api.bilibili.com/x/v2/reply/wbi/main', {
          type: 1, oid: aid, mode, pagination_str: JSON.stringify({ offset: '' }), plat: 1, web_location: 1315875,
        });
        const list = j?.data?.replies || [];
        for (const r of list) {
          if (rootIds.has(r.rpid)) continue;
          rootIds.add(r.rpid);
          roots.push(r);
        }
      } catch (e) {
        pushFail(`reply:${bvid}:mode${mode}`, e.message);
      }
    }
    let got = 0;
    for (const r of roots) {
      got += pushReplyRec(bvid, tname, r, 0, null);
      if (r.rcount > 0 && state.reply + pending.length < TARGET_REPLY) {
        try {
          const s = await httpGet(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${r.rpid}&pn=1&ps=20`);
          const subs = s?.data?.replies || [];
          for (const sr of subs) got += pushReplyRec(bvid, tname, sr, 1, r.rpid);
        } catch (e) {
          pushFail(`sub:${bvid}:${r.rpid}`, e.message);
        }
      }
    }
    if (got > 0) state.videos_with_reply++;
  }
  return tname;
}

// ---------------- 主流程 ----------------
async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const resumed = loadState();
  if (resumed) log(`续跑：已处理 ${state.processed.length} 个视频，dm=${state.dm} reply=${state.reply}`);
  if (resumed && fs.existsSync(RAW) && fs.readdirSync(RAW).some((f) => /^bili-text-\d{3}\.jsonl$/.test(f))) {
    rebuildFromFiles();
  }
  if (!stream) openNewFile();
  for (const b of state.processed || []) processedSet.add(b);

  await boot();
  log(`cookie 就绪（${COOKIE.length} 字符），wbi 就绪`);

  const hadPool = loadPool();
  const seeds = await buildSeeds();
  let addedSeeds = 0;
  for (const c of seeds) if (enqueue(c)) addedSeeds++;
  if (hadPool) log('已恢复的池子 + 种子池已合并');
  log(`开始采集：种子 ${addedSeeds} 个，${byTname.size} 个 tname 分组，目标 dm=${TARGET_DM} reply=${TARGET_REPLY}`);

  const t0 = Date.now();
  const allCovered = () => {
    for (const [, g] of byTname) if (g.mined < TN_MIN) return false;
    return true;
  };
  const done = () => state.dm >= TARGET_DM && state.reply >= TARGET_REPLY && allCovered();

  let lastProg = 0;
  const maxMinutes = Number(process.env.MINE_MAX_MINUTES ?? 180);
  function writeProgress() {
    const el = (Date.now() - t0) / 1000;
    const frac = Math.max(state.dm / TARGET_DM, state.reply / TARGET_REPLY, 0);
    const eta = frac > 0.03 ? Math.round((el / frac - el) / 60) : null;
    const tnameVideos = {};
    for (const [tn, g] of byTname) tnameVideos[tn] = g.mined;
    const prog = {
      records: state.dm + state.reply,
      by_kind: { danmaku: state.dm, reply: state.reply },
      videos_covered: state.videos,
      tnames_covered: Object.values(tnameVideos).filter((n) => n > 0).length,
      tnames_total: byTname.size,
      tname_videos: tnameVideos,
      pool_size: pool.size,
      eta_minutes: eta,
      target: { danmaku: TARGET_DM, reply: TARGET_REPLY },
      elapsed_minutes: Math.round(el / 60),
      requests: reqCount,
      rps: Number(rps.toFixed(2)),
      files: (state.files || []).length,
      failed: state.failed.length,
      updated_at: nowCN(),
    };
    try { fs.writeFileSync(path.join(RAW, '_progress_bili-text.json'), JSON.stringify(prog, null, 2), 'utf8'); } catch {}
    lastProg = Date.now();
  }

  let stop = false;
  let busy = 0;
  async function worker() {
    while (!stop) {
      if (done()) { stop = true; break; }
      if ((Date.now() - t0) / 60000 > maxMinutes) { stop = true; break; }
      if (state.videos >= MAX_VIDEOS) { stop = true; break; }
      const claim = claimNext();
      if (!claim) {
        // 没有候选了：如果还有 tname 没覆盖或目标未达，就先等生长；否则收工
        if (busy === 0) break;
        await sleep(700);
        continue;
      }
      const { c, tn } = claim;
      busy++;
      let resolvedTn = tn;
      try {
        const rt = await processVideo(c);
        if (rt) resolvedTn = rt;
      } catch (e) {
        pushFail(c.bvid, e.message);
      }
      for (const key of new Set([resolvedTn, tn])) {
        if (!key) continue;
        let set = minedTname.get(key);
        if (!set) { set = new Set(); minedTname.set(key, set); }
        set.add(c.bvid);
        if (byTname.has(key)) tnGroup(key).mined = set.size;
      }
      processedSet.add(c.bvid);
      state.processed.push(c.bvid);
      state.videos++;
      await flushPending();
      await growFrom(c.bvid);
      busy--;
      if (state.videos % SAVE_EVERY === 0 || done()) {
        await flush();
        saveState();
        savePool();
        const el = (Date.now() - t0) / 1000;
        const rate = reqCount / Math.max(el, 1);
        log(`v=${state.videos} dm=${state.dm} reply=${state.reply} tname=${tn} tnames=${[...byTname.values()].filter((g) => g.mined > 0).length}/${byTname.size} pool=${pool.size} files=${(state.files || []).length} req=${reqCount} ${rate.toFixed(1)}r/s rps=${rps.toFixed(1)} failed=${state.failed.length}`);
      }
      if (Date.now() - lastProg > 10 * 60 * 1000) writeProgress();
    }
  }
  writeProgress();
  await Promise.all([worker(), worker(), worker()]);

  await flushPending();
  await flush();
  saveState();
  savePool();
  writeProgress();
  if (stream) stream.end();

  log(`采集结束：dm=${state.dm} reply=${state.reply} videos=${state.videos} tnames=${[...byTname.values()].filter((g) => g.mined > 0).length}/${byTname.size} files=${(state.files || []).length} failed=${state.failed.length}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
