// 第2步：建关键词池（目标 3500+）。
// 来源：分区名 / 分区名+后缀 / 真实 tag / 标题 n-gram / 种子搜索。
import fs from 'node:fs';
import path from 'node:path';
import { Bili, META, mkdirs, isoCST, stripHtml, sleep } from './miner_lib.mjs';

mkdirs();
const regions = JSON.parse(fs.readFileSync(path.join(META, 'regions.json'), 'utf8'));
const b = new Bili({ rps: 5 });
await b.boot();

const SUFFIX = ['教程', '测评', '实况', '合集', '解说', '盘点', '记录', '日常', '翻车', '高能', '攻略', '排行', '推荐', '入门', '进阶', '挑战', '直播', '切片', '混剪', '解析', '整活', '开箱', '对比', '试玩', '复盘', '名场面', '冷知识', '新手', '2026', '高燃'];
const AD = /(免费|破解|私服|代理|微信|qq群|QQ群|抽奖|广告|推广|官网|下载|安装包|色情|裸|福利|加群|代练|刷单|兼职|贷款|赌博|外挂|辅助|加速器|激活码|低价|秒杀|优惠券)/i;

const RE_CJK = /[\u4e00-\u9fa5]/;
const BAD_CHARS = /[<>{}\[\]\\|/@#$%^&*_=+~`"]/;
function goodWord(w) {
  if (typeof w !== 'string') return false;
  w = w.trim().replace(/\s+/g, ' ');
  if (w.length < 2 || w.length > 18) return false;
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(w)) return false;
  if (/^\d+$/.test(w)) return false;
  if (BAD_CHARS.test(w)) return false;
  if (AD.test(w)) return false;
  if (!RE_CJK.test(w)) return /^[A-Za-z][A-Za-z0-9 .+-]{2,}$/.test(w); // 纯英文至少3字符
  return true;
}

const pool = new Map(); // w -> from
function add(w, from) {
  w = String(w || '').trim().replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
  if (!goodWord(w)) return;
  if (!pool.has(w)) pool.set(w, from);
}

// ---- A. 分区名 ----
const firstLevel = Object.values(regions.known_first_level || {});
const subNames = [...new Set((regions.tids || []).map((t) => t.tname).filter(Boolean))].filter(goodWord);
const regionNames = [...new Set([...firstLevel, ...subNames])];
console.log('region names:', regionNames.length, 'first=', firstLevel.length, 'sub=', subNames.length);

// 一级 × 全部后缀
for (const r of Object.keys(regions.known_first_level || {}).filter((k) => k !== '0').map((k) => regions.known_first_level[k])) {
  for (const s of SUFFIX) add(r + s, 'region+suffix');
  add(r, 'region');
}
// 二级 × 轮转取 9 个后缀
let i = 0;
for (const r of subNames) {
  add(r, 'region');
  for (let k = 0; k < 9; k++) {
    add(r + SUFFIX[(i + k * 3) % SUFFIX.length], 'region+suffix');
  }
  i++;
}

// ---- B. 采集真实 tag / 标题（种子搜索 + 榜单 + 热门）----
const SEEDS = ['动画', '音乐', '游戏', '娱乐', '电视剧', '番剧', '电影', '科技', '鬼畜', '舞蹈', '搞笑', '时尚', '生活', '国创', '影视', '数码', '资讯', '美食', '动物', '汽车', '运动', '知识', '单机游戏', '手游', '原神', '我的世界', '英雄联盟', '王者荣耀', '黑神话悟空', '美食探店', '考研', '编程', '摄影', '健身', '旅行', '手工', '钓鱼', '猫meme', '综艺', '纪录片'];
const titles = [];
const tagFreq = new Map();
function harvest(item) {
  if (!item) return;
  if (typeof item.title === 'string') titles.push(stripHtml(item.title));
  const tg = item.tag;
  if (typeof tg === 'string' && tg) {
    for (const t of tg.split(',')) { const w = t.trim(); if (w) tagFreq.set(w, (tagFreq.get(w) || 0) + 1); }
  }
}
for (const kw of SEEDS) {
  for (const page of [1, 2]) {
    try {
      const j = await b.search(kw, page);
      for (const v of j?.data?.result || []) harvest(v);
    } catch (e) { console.log('  seed fail', kw, page, e.message); }
  }
}
// 热门 + 全站榜
for (let pn = 1; pn <= 4; pn++) {
  try {
    const j = await b.raw('https://api.bilibili.com/x/web-interface/popular', { ps: 50, pn }, { signed: true });
    for (const v of j?.data?.list || []) harvest(v);
    if (j?.data?.no_more) break;
  } catch {}
}
for (const rid of [0, 1, 3, 4, 5, 11, 23, 36]) {
  try {
    const j = await b.raw(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, null, { signed: false });
    for (const v of j?.data?.list || []) harvest(v);
  } catch {}
}
console.log('harvested titles=', titles.length, 'tags=', tagFreq.size);

// tag 词表
const tagsSorted = [...tagFreq.entries()].sort((a, c) => c[1] - a[1]);
for (const [t] of tagsSorted.slice(0, 450)) add(t, 'tag');
// 高频 tag × 后缀（取前 160）
for (const [t] of tagsSorted.slice(0, 160)) {
  for (let k = 0; k < 3; k++) add(t + SUFFIX[(k * 7) % SUFFIX.length], 'tag+suffix');
}

// ---- C. 标题 n-gram（2-4 字中文 + 英文词）----
const gram = new Map();
function addGram(w, wgt) { if (w.length < 2) return; gram.set(w, (gram.get(w) || 0) + wgt); }
for (const t of titles) {
  if (!t) continue;
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean);
  for (const seg of cjk) {
    const chars = [...seg];
    for (let n = 2; n <= 4; n++) {
      for (let s = 0; s + n <= chars.length; s++) {
        const w = chars.slice(s, s + n).join('');
        if (/^(.)\1+$/.test(w)) continue;     // 叠字
        if (/^[的了是在和与及或我你他她它们这那就都也还又很太更最]/.test(w)) continue;
        addGram(w, n === 3 ? 1.2 : 1);
      }
    }
  }
  for (const w of (t.match(/[A-Za-z][A-Za-z0-9+.]{2,}/g) || [])) addGram(w.toLowerCase(), 1);
}
const gramSorted = [...gram.entries()]
  .filter(([w, c]) => c >= 3 && goodWord(w) && !/^\d+$/.test(w))
  .sort((a, c) => c[1] - a[1]);
for (const [w] of gramSorted.slice(0, 900)) add(w, 'ngram');
console.log('ngram candidates=', gramSorted.length);

// ---- D. 补到目标数量 ----
const MIN = 3600;
if (pool.size < MIN) {
  for (const [w] of gramSorted.slice(900)) { if (pool.size >= MIN) break; add(w, 'ngram'); }
}
// 还差就用 二级名+兴趣词 两两组合
const INTEREST = ['新手', '进阶', '高玩', '小白', '女生', '男生', '学生', '上班族', '深夜', '周末', '2025', '2026', '推荐', '避坑', '技巧', '深度', '硬核', '治愈', '搞笑', '干货'];
for (const r of subNames) {
  for (const w of INTEREST) { add(r + w, 'region+interest'); if (pool.size > 4200) break; }
  if (pool.size > 4200) break;
}

const list = [...pool.entries()].map(([w, from]) => ({ w, from }));
const byFrom = {};
for (const k of list) byFrom[k.from] = (byFrom[k.from] || 0) + 1;
fs.writeFileSync(path.join(META, 'keywords.json'), JSON.stringify({
  generated_at: isoCST(), count: list.length, by_from: byFrom,
  keywords: list,
}, null, 0), 'utf8');
console.log('WROTE meta/keywords.json count=', list.length, JSON.stringify(byFrom));
