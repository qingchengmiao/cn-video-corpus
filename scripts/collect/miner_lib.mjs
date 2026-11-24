// 共享底层：cookie 引导、wbi 签名、限速、重试、JSONL 落盘
// 注意：目录里还有别的采集器在用 lib.mjs，这个是本采集器专用，避免互相覆盖。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const RAW = path.join(ROOT, 'raw');
export const META = path.join(ROOT, 'meta');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mkdirs() { fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(META, { recursive: true }); }

export function isoCST(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

export function stripHtml(s) {
  if (typeof s !== 'string') return s ?? null;
  return s.replace(/<[^>]*>/g, '');
}

export function parseDuration(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  if (typeof d !== 'string') return null;
  const p = d.trim().split(':').map(Number);
  if (p.some((x) => !Number.isFinite(x))) return null;
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 1) return p[0];
  return null;
}

export class RateLimiter {
  constructor(rps, burst) { this.rps = rps; this.cap = burst ?? Math.max(1, rps); this.tokens = this.cap; this.last = Date.now(); this.pausedUntil = 0; }
  setRate(rps) { this.rps = Math.max(1, Math.min(8, rps)); }
  async take() {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) { await sleep(Math.min(2000, this.pausedUntil - now)); continue; }
      this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.rps);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await sleep(Math.max(5, ((1 - this.tokens) / this.rps) * 1000));
    }
  }
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); this.tokens = 0; this.last = Date.now(); }
}

export class Stopper { constructor(file) { this.file = file; } hit() { return fs.existsSync(this.file); } }

export class Bili {
  constructor({ rps = 6, log = console.log } = {}) {
    this.rpsMax = Math.max(rps, Number(process.env.RPS_MAX || rps));
    this.lastBlockAt = 0;
    setInterval(() => {
      // 风控退避后缓慢回升：90s 内无风控就 +0.5/s，直到 rpsMax
      if (Date.now() - this.lastBlockAt > 90000 && this.lim.rps < this.rpsMax) this.lim.setRate(Math.min(this.rpsMax, this.lim.rps + 0.5));
    }, 60000).unref();
    this.cookie = '';
    this.mixin = null;
    this.mixinAt = 0;
    this.lim = new RateLimiter(rps);
    this.log = log;
    this.req = 0;
    this.err412 = 0; this._busy = false; this.lastOk = 0;
  }
  async boot() {
    for (let i = 0; i < 3 && !this.cookie; i++) {
      try {
        const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA } });
        const sc = r.headers.getSetCookie?.() || [];
        this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
        if (!this.cookie) {
          const raw = sc.join('; ');
          const m1 = raw.match(/buvid3=[^;]+/), m2 = raw.match(/b_nut=[^;]+/);
          this.cookie = [m1?.[0], m2?.[0]].filter(Boolean).join('; ');
        }
      } catch (e) { await sleep(1500); }
    }
    if (!this.cookie) throw new Error('cookie boot failed');
    await this.refreshMixin();
  }
  H() { return { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Cookie: this.cookie }; }
  async refreshMixin() {
    const j = await this.raw('https://api.bilibili.com/x/web-interface/nav', null, { signed: false, retry: 3 });
    const img = j?.data?.wbi_img?.img_url || '', sub = j?.data?.wbi_img?.sub_url || '';
    const key = (img.split('/').pop() || '').split('.')[0] + (sub.split('/').pop() || '').split('.')[0];
    if (key.length < 32) throw new Error('mixin key missing');
    let m = '';
    for (const i of MIXIN) m += key[i] ?? '';
    this.mixin = m.slice(0, 32);
    this.mixinAt = Date.now();
  }
  sign(params) {
    const wts = Math.round(Date.now() / 1000);
    const p = { ...params, wts };
    const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
    return `${q}&w_rid=${crypto.createHash('md5').update(q + this.mixin).digest('hex')}`;
  }
  async blockBackoff(block, basePause) {
    this.lastBlockAt = Date.now();
    const wait = Math.min(basePause * Math.pow(2, Math.min(4, block - 1)), 600000);
    this.lim.pause(wait);
    this.lim.setRate(Math.max(1, this.lim.rps / 2));
    this.log(`  [风控x${block}] 退避${Math.round(wait / 1000)}s，降速至 ${this.lim.rps.toFixed(1)}/s`);
    if (block >= 2 && !this._busy) {  // 换一份 cookie（412 常与 buvid 绑定）
      this._busy = true;
      try { await this.boot(); this.log('  cookie/mixin 已重建'); } catch (e) { this.log('  重建失败: ' + e.message); } finally { this._busy = false; }
    }
    return wait;
  }
  async raw(url, params, { signed = true, timeout = 20000, retry = 3, riskPause = 30000, riskRetry = true, maxBlock = 6 } = {}) {
    let attempt = 0;
    let block = 0;
    let lastErr = null;
    for (;;) {
      attempt++;
      await this.lim.take();
      await sleep(Math.random() * 150);
      let full = url;
      try {
        if (params && Object.keys(params).length) full = `${url}?${signed ? this.sign(params) : new URLSearchParams(params).toString()}`;
        else if (signed) full = `${url}?${this.sign({})}`;
        const r = await fetch(full, { headers: this.H(), signal: AbortSignal.timeout(timeout) });
        this.req++;
        const text = await r.text();
        if (r.status === 412 || r.status === 429) {
          this.err412++;
          block++;
          lastErr = new Error('http ' + r.status);
          await this.blockBackoff(block, riskPause);
          if (!riskRetry || block >= maxBlock || attempt >= retry + 2 * maxBlock) throw lastErr;
          continue;
        }
        let j = null;
        try { j = JSON.parse(text); } catch { throw new Error('bad json len=' + text.length); }
        if (j.code === -352 || j.code === -412) {
          this.err412++;
          block++;
          lastErr = new Error(String(j.code));
          await this.blockBackoff(block, riskPause);
          if (!riskRetry || block >= maxBlock || attempt >= retry + 2 * maxBlock) throw lastErr;
          continue;
        }
        this.lastOk = Date.now();
        return j;
      } catch (e) {
        lastErr = e;
        if (attempt > retry) throw lastErr;
        await sleep(800 * attempt);
      }
    }
  }
  async search(keyword, page, order = 'totalrank') {
    // 实测：/wbi/search/type 被 IP 级 412 封（返回 HTML），而**未签名的 /search/type 仍 code=0**，
    // 且支持 page_size=50、page 1..20（每词上限 1000）、order=totalrank|click|pubdate|dm|stow。
    const params = { search_type: 'video', keyword, page, page_size: 50 };
    if (order && order !== 'totalrank') params.order = order;
    return this.raw('https://api.bilibili.com/x/web-interface/search/type', params, { signed: false, retry: 2 });
  }
}

export class ShardWriter {
  constructor(prefix, { maxRecords = 50000, maxBytes = 190 * 1024 * 1024 } = {}) {
    this.prefix = prefix; this.maxRecords = maxRecords; this.maxBytes = maxBytes;
    this.buf = []; this.bytes = 0; this.idx = 0; this.files = []; this.total = 0;
  }
  write(rec) {
    const line = JSON.stringify(rec) + '\n';
    this.buf.push(line); this.bytes += Buffer.byteLength(line);
    if (this.buf.length >= this.maxRecords || this.bytes >= this.maxBytes) this.flush();
  }
  flush() {
    if (!this.buf.length) return null;
    this.idx++;
    const name = `${this.prefix}-${String(this.idx).padStart(3, '0')}.jsonl`;
    const p = path.join(RAW, name);
    fs.writeFileSync(p, this.buf.join(''), 'utf8');
    this.files.push(name);
    this.total += this.buf.length;
    this.buf = []; this.bytes = 0;
    return p;
  }
  resumeFrom(files, count) {
    let mx = 0;
    for (const f of files) { const m = f.match(/-(\d+)\.jsonl$/); if (m) mx = Math.max(mx, Number(m[1])); }
    this.idx = mx; this.total = count;
  }
}

export function readJsonl(p) {
  const out = [];
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}

export function listShards(prefix) {
  if (!fs.existsSync(RAW)) return [];
  return fs.readdirSync(RAW).filter((f) => f.startsWith(prefix + '-') && /^[a-z0-9-]+-\d+\.jsonl$/.test(f)).sort();
}
