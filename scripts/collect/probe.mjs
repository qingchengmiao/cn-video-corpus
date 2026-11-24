// B站 wbi 签名探针：拿分区树 + 试几个列表接口
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

async function getNav() {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H });
  const j = await r.json();
  const img = j?.data?.wbi_img?.img_url || '';
  const sub = j?.data?.wbi_img?.sub_url || '';
  const key = (img.split('/').pop() || '').split('.')[0] + (sub.split('/').pop() || '').split('.')[0];
  let mixin = '';
  for (const i of MIXIN) mixin += key[i] ?? '';
  return mixin.slice(0, 32);
}

function sign(mixin, params) {
  const wts = Math.round(Date.now() / 1000);
  const p = { ...params, wts };
  const q = Object.keys(p).sort().map((k) => {
    const v = String(p[k]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex');
  return `${q}&w_rid=${w_rid}`;
}

async function api(url, params = {}) {
  const mixin = await getNav();
  const qs = sign(mixin, params);
  const full = `${url}?${qs}`;
  const r = await fetch(full, { headers: H });
  const j = await r.json();
  return { code: j.code, msg: j.message, data: j.data, url: full.slice(0, 160) };
}

const mode = process.argv[2] || 'region';
if (mode === 'region') {
  const j = await api('https://api.bilibili.com/x/v2/region/index', {});
  console.log('code', j.code, j.msg);
  if (j.code === 0) {
    for (const top of j.data) {
      console.log(`${top.rid}\t${top.name}\t${(top.children || []).length} 个子分区`);
      for (const c of top.children || []) console.log(`\t${top.rid}-${c.rid}\t${c.name}`);
    }
  }
} else if (mode === 'rank') {
  const rids = process.argv.slice(3);
  for (const rid of rids) {
    const j = await api('https://api.bilibili.com/x/web-interface/ranking/v2', { rid, type: 'all' });
    const n = j.data?.list?.length ?? 0;
    const s = j.data?.list?.[0];
    console.log(`rid=${rid} code=${j.code} n=${n}${s ? ` | ${s.title} | ${s.tname}/${s.tid} | ${s.owner?.name} | ${s.stat?.view} 播放 ${s.stat?.danmaku} 弹幕` : ''}`);
  }
}
