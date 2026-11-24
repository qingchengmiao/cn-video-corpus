// 探针 2：search / view / popular / related / danmaku 五个通道是否可用
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

let COOKIE = '';
async function boot() {
  const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA } });
  const sc = r.headers.getSetCookie?.() || [];
  COOKIE = sc.map((c) => c.split(';')[0]).join('; ');
  console.log('cookies:', COOKIE.slice(0, 120));
}
function H() {
  return { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Cookie: COOKIE };
}
async function getNav() {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H() });
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
  const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`;
}
async function wbi(url, params) {
  const mixin = await getNav();
  const r = await fetch(`${url}?${sign(mixin, params)}`, { headers: H() });
  return await r.json();
}

await boot();
const mixinMade = await getNav();
console.log('mixin:', mixinMade.slice(0, 8) + '…');

// 1 search
{
  const j = await wbi('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'video', keyword: '游戏', page: 1, page_size: 20 });
  console.log('search code=', j.code, 'n=', j.data?.result?.length, 'numPages=', j.data?.numPages, 'numResults=', j.data?.numResults);
  const v = j.data?.result?.[0];
  if (v) console.log('  sample:', v.bvid, v.title?.slice(0, 40), '|', v.typename, '|', v.play, '播放', '|', v.duration);
}
// 2 view
{
  const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7', { headers: H() });
  const j = await r.json();
  console.log('view code=', j.code, j.data ? `bvid=${j.data.bvid} tid=${j.data.tid} tname=${j.data.tname} tags=${j.data.tag?.length ?? 0} stat.view=${j.data.stat?.view} desc=${(j.data.desc || '').length}字` : j.message);
}
// 3 popular
{
  const j = await wbi('https://api.bilibili.com/x/web-interface/popular', { ps: 50, pn: 1 });
  console.log('popular code=', j.code, 'n=', j.data?.list?.length);
}
// 4 related
{
  const r = await fetch('https://api.bilibili.com/x/web-interface/archive/related?bvid=BV1GJ411x7h7', { headers: H() });
  const j = await r.json();
  console.log('related code=', j.code, 'n=', j.data?.length);
}
// 5 danmaku
{
  const r = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=1000000', { headers: H() });
  const t = await r.text();
  console.log('danmaku status=', r.status, 'len=', t.length, 'head=', t.slice(0, 60).replace(/\n/g, ' '));
}
