// lib.mjs —— 其它平台采集共享层：限速/并发、取数、字段归一、脱敏、去重落盘、失败记录
// 约束：只用 node 内置 fetch，不装依赖；同域名 ≤3 req/s；全局并发 ≤3。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const PLATFORMS = ['douyin', 'kuaishou', 'ixigua', 'youku', 'qqvideo', 'iqiyi', 'weibo'];

export const RAW_DIR = path.join(process.cwd(), 'raw');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 调速器：每域名最小间隔 + 全局并发上限 ----------------
class Pacer {
  constructor({ concurrency = 3, minGapMs = 340, hostPause = new Map() } = {}) {
    this.concurrency = concurrency;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.lastByHost = new Map();
    this.pauseUntil = hostPause;
    this.q = [];
    this._tm = null;
  }
  pauseHost(host, ms) {
    this.pauseUntil.set(host, Date.now() + ms);
  }
  run(host, task) {
    return new Promise((resolve, reject) => {
      this.q.push({ host, task, resolve, reject });
      this._pump();
    });
  }
  _pump() {
    if (this._tm) return;
    const now = Date.now();
    while (this.active < this.concurrency) {
      let idx = -1;
      let waitMs = Infinity;
      for (let i = 0; i < this.q.length; i++) {
        const job = this.q[i];
        const pu = this.pauseUntil.get(job.host) || 0;
        const nextAllowed = Math.max((this.lastByHost.get(job.host) || 0) + this.minGapMs, pu);
        const d = nextAllowed - now;
        if (d <= 0) { idx = i; break; }
        if (d < waitMs) waitMs = d;
      }
      if (idx < 0) {
        if (this.q.length && waitMs < Infinity) {
          this._tm = setTimeout(() => { this._tm = null; this._pump(); }, Math.max(5, Math.min(waitMs, 2000)));
        }
        return;
      }
      const job = this.q.splice(idx, 1)[0];
      this.active++;
      this.lastByHost.set(job.host, Date.now());
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => { this.active--; this._pump(); });
    }
  }
}

export const pacer = new Pacer();

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'invalid'; }
}

// ---------------- 取数 ----------------
const BAD_STATUS = new Set([403, 412, 418, 429]);

export async function fetchRaw(url, opts = {}) {
  const { headers = {}, method = 'GET', body, timeout = 25000, retries = 2, retryDelay = 1500 } = opts;
  const host = hostOf(url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(retryDelay * attempt);
    const out = await pacer.run(host, async () => {
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': UA_PC,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Accept: '*/*',
            ...headers,
          },
          body,
          signal: ac.signal,
          redirect: 'follow',
        });
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, headers: res.headers, buf, url: res.url };
      } finally {
        clearTimeout(tm);
      }
    }).catch((e) => ({ err: `${e.name || 'Error'}: ${e.message}` }));

    if (out.err) {
      lastErr = out.err;
      continue;
    }
    if (BAD_STATUS.has(out.status)) {
      // 403/412/429：立刻停该入口 30 秒，不硬碰
      pacer.pauseHost(host, 30000);
      out.text = out.buf.toString('utf8');
      return out;
    }
    out.text = out.buf.toString('utf8');
    return out;
  }
  return { err: lastErr, status: 0, text: '', buf: Buffer.alloc(0), url };
}

export async function fetchText(url, opts) {
  const r = await fetchRaw(url, opts);
  return r.err ? r : { ...r, text: r.text };
}

export async function fetchJson(url, opts) {
  const r = await fetchRaw(url, opts);
  if (r.err) return { ...r, json: null };
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch (e) {
    return { ...r, json: null, parseError: e.message };
  }
}

// 从 HTML 里抽 `window.XXX = {...}` / `window.XXX = [...]` 的 JS 字面量（含 undefined），用 vm 求值
export function extractJsLiteral(html, marker, { timeout = 3000 } = {}) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  const startArr = html.indexOf('[', at);
  let s = start;
  if (startArr >= 0 && (s < 0 || startArr < s)) s = startArr;
  if (s < 0) return null;
  const open = html[s];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let q = '';
  let esc = false;
  let end = -1;
  for (let i = s; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === q) { inStr = false; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  const lit = html.slice(s, end);
  try {
    return vm.runInNewContext('(' + lit + ')', Object.create(null), { timeout });
  } catch {
    return null;
  }
}

// ---------------- 字段归一 ----------------
const p2 = (n) => String(n).padStart(2, '0');

export function toTs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    const s = v > 1e12 ? Math.round(v / 1000) : Math.round(v);
    return s > 946684800 && s < 4102444800 ? s : null; // 2000..2100
  }
  const str = String(v).trim();
  if (/^\d{9,13}$/.test(str)) return toTs(Number(str));
  // 微博格式：Tue Nov 24 03:48:30 +0800 2026
  const wb = str.match(/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \+(\d{4}) (\d{4})$/);
  if (wb) {
    const mon = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }[wb[1]];
    if (mon) {
      const iso = `${wb[7]}-${p2(mon)}-${p2(Number(wb[2]))}T${wb[3]}:${wb[4]}:${wb[5]}+${wb[6].slice(0, 2)}:${wb[6].slice(2)}`;
      const t = Date.parse(iso);
      return Number.isNaN(t) ? null : Math.round(t / 1000);
    }
  }
  // 2024-01-02 / 2024-01-02 03:04:05 / 2024/01/02（按东八区）
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const iso = `${m[1]}-${p2(Number(m[2]))}-${p2(Number(m[3]))}T${p2(Number(m[4] || 0))}:${p2(Number(m[5] || 0))}:${p2(Number(m[6] || 0))}+08:00`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.round(t / 1000);
  }
  const t = Date.parse(str.replace(' ', 'T'));
  return Number.isNaN(t) ? null : Math.round(t / 1000);
}

export function toDur(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const str = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str));
  const parts = str.split(':').map((x) => Number(x));
  if (parts.length >= 2 && parts.every((x) => Number.isFinite(x))) {
    let sec = 0;
    for (const x of parts) sec = sec * 60 + x;
    return Math.round(sec);
  }
  return null;
}

export function toInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const str = String(v).replace(/[,\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str));
  const m = str.match(/^(\d+(?:\.\d+)?)(万|亿|w|W|亿)?$/);
  if (m) {
    const mul = m[2] === '万' || m[2] === 'w' || m[2] === 'W' ? 10000 : m[2] === '亿' ? 100000000 : 1;
    return Math.round(Number(m[1]) * mul);
  }
  return null;
}

// ---------------- 脱敏 ----------------
const RE_IDCARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const RE_QQ = /(?:QQ|qq|Qq|扣扣|企鹅)\s*[:：号]?\s*\d{5,12}/g;
const RE_URL_QQ = /(?:uin|qq)=(\d{5,12})/g;

export function sanitize(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(RE_IDCARD, '<已隐去>')
    .replace(RE_EMAIL, '<已隐去>')
    .replace(RE_PHONE, '<已隐去>')
    .replace(RE_QQ, '<已隐去>')
    .replace(RE_URL_QQ, 'qq=<已隐去>');
}

// ---------------- 记录构造 ----------------
export function makeRecord({
  platform,
  item_id,
  title,
  category = null,
  interest = null,
  author = null,
  publish_ts = null,
  duration_s = null,
  stat = {},
  url = null,
  source = null,
}) {
  return {
    platform,
    item_id: item_id === null || item_id === undefined ? null : String(item_id),
    title: sanitize(typeof title === 'string' ? title.trim() : title === null || title === undefined ? null : String(title)),
    category: category === undefined ? null : category,
    interest: Array.isArray(interest) && interest.length ? interest.filter((x) => typeof x === 'string' && x.trim()).map((x) => sanitize(x.trim())) : null,
    author: author === null || author === undefined ? null : sanitize(String(author).trim()) || null,
    publish_ts: toTs(publish_ts),
    duration_s: toDur(duration_s),
    stat: {
      view: toInt(stat.view ?? null),
      like: toInt(stat.like ?? null),
      comment: toInt(stat.comment ?? null),
    },
    url: url || null,
    source: source || null,
    crawled_at: new Date().toISOString(),
  };
}

// ---------------- 落盘 + 去重 + 轮转 ----------------
const FILE_RE = /^other-meta(?:-(\d{3}))?\.jsonl$/;

export class Sink {
  constructor({ dir = RAW_DIR, maxBytes = 200 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.seen = new Set();
    this.count = 0;
    this.dups = 0;
    this.rejected = 0;
    this.rejectReasons = {};
    this.byPlatform = {};
    this.bySource = {};
    this.files = []; // [{name, bytes}]
    this.stream = null;
    this.curIdx = 0;
    this.curBytes = 0;
    this._loadExisting();
  }

  _fname(idx) {
    return idx === 1 ? 'other-meta.jsonl' : `other-meta-${String(idx).padStart(3, '0')}.jsonl`;
  }

  _loadExisting() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    const names = fs
      .readdirSync(this.dir)
      .map((n) => ({ n, m: n.match(FILE_RE) }))
      .filter((x) => x.m)
      .map((x) => ({ name: x.n, idx: x.m[1] ? Number(x.m[1]) : 1, size: fs.statSync(path.join(this.dir, x.n)).size }))
      .sort((a, b) => a.idx - b.idx);
    for (const f of names) {
      const txt = fs.readFileSync(path.join(this.dir, f.name), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r && r.platform && r.item_id) this.seen.add(`${r.platform}|${r.item_id}`);
          this.count++;
          this.byPlatform[r.platform] = (this.byPlatform[r.platform] || 0) + 1;
          if (r.source) this.bySource[r.source] = (this.bySource[r.source] || 0) + 1;
        } catch { /* 坏行忽略 */ }
      }
      this.files.push({ name: f.name, bytes: f.size });
    }
    const last = names[names.length - 1];
    if (last) {
      this.curIdx = last.idx;
      this.curBytes = last.size;
      if (this.curBytes >= this.maxBytes) this.curIdx = last.idx + 1, this.curBytes = 0;
    } else {
      this.curIdx = 1;
      this.curBytes = 0;
    }
  }

  _open() {
    if (this.stream) return;
    const name = this._fname(this.curIdx);
    if (!this.files.find((f) => f.name === name)) this.files.push({ name, bytes: 0 });
    this.stream = fs.createWriteStream(path.join(this.dir, name), { flags: 'a' });
  }

  _rotateIfNeeded(addBytes) {
    if (this.curBytes + addBytes <= this.maxBytes) return;
    if (this.stream) { this.stream.end(); this.stream = null; }
    this.curIdx++;
    this.curBytes = 0;
  }

  add(rec) {
    if (!rec || !PLATFORMS.includes(rec.platform)) return this._reject('platform');
    if (!rec.item_id || !String(rec.item_id).trim()) return this._reject('item_id');
    if (!rec.title || !String(rec.title).trim()) return this._reject('title');
    const key = `${rec.platform}|${rec.item_id}`;
    if (this.seen.has(key)) { this.dups++; return false; }
    this.seen.add(key);
    const line = JSON.stringify(rec) + '\n';
    const bytes = Buffer.byteLength(line);
    this._rotateIfNeeded(bytes);
    this._open();
    this.stream.write(line);
    this.curBytes += bytes;
    const f = this.files[this.files.length - 1];
    if (f) f.bytes = this.curBytes;
    this.count++;
    this.byPlatform[rec.platform] = (this.byPlatform[rec.platform] || 0) + 1;
    if (rec.source) this.bySource[rec.source] = (this.bySource[rec.source] || 0) + 1;
    return true;
  }

  _reject(why) {
    this.rejected++;
    this.rejectReasons[why] = (this.rejectReasons[why] || 0) + 1;
    return false;
  }

  async close() {
    if (this.stream) {
      await new Promise((res) => this.stream.end(res));
      this.stream = null;
    }
  }
}

// ---------------- 失败记录（各平台脚本追加） ----------------
export function failedPath() {
  return path.join(RAW_DIR, '_failed_other.jsonl');
}

export function recordFailed(platform, source, reason) {
  if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });
  const rec = { platform, source, reason, at: new Date().toISOString() };
  fs.appendFileSync(failedPath(), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

export function readFailed() {
  const p = failedPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function logSummary(name, sink, extra = {}) {
  return { name, records: sink.count, dups: sink.dups, rejected: sink.rejected, ...extra };
}
