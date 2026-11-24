// mine_iqiyi.mjs —— 爱奇艺：pcw-api 推荐列表（album 级）+ avlistinfo（剧集级）
// 入口：https://pcw-api.iqiyi.com/search/recommend/list  /  https://pcw-api.iqiyi.com/albums/album/avlistinfo
import fs from 'node:fs';
import path from 'node:path';
import { Sink, fetchJson, makeRecord, toInt, recordFailed, sleep, RAW_DIR } from './lib.mjs';

const TARGET_TOTAL = Number(process.env.TARGET_TOTAL || 50000);
const EP_BUDGET = Number(process.env.EP_BUDGET || 3200); // avlistinfo 请求上限
const PER_ALBUM = 30; // 每个 album 抽取集数上限

const CHANNELS = {
  1: '电影', 2: '电视剧', 3: '纪录片', 4: '动漫', 5: '音乐', 6: '综艺', 7: '娱乐', 8: '儿童',
  9: '旅游', 10: '游戏', 11: '教育', 12: '体育', 13: '生活', 14: '时尚', 15: '动画', 16: '生活',
  17: '体育', 18: '游戏', 19: '汽车', 20: '美食', 21: '美食', 22: '搞笑', 23: '财经', 24: '财经',
  25: '资讯', 26: '汽车', 27: '游戏', 28: '历史', 29: '生活', 30: '科技', 31: '教育', 32: '健身',
};

const sink = new Sink({ dir: RAW_DIR });
const started = Date.now();
const stats = { albumPages: 0, albums: 0, epCalls: 0, eps: 0, codes: {} };
const albumList = [];
const failed = [];

const API = (ch, page, n) =>
  `https://pcw-api.iqiyi.com/search/recommend/list?channel_id=${ch}&data_type=1&mode=11&page_id=${page}&ret_num=${n}&session=`;
const HDR = { Referer: 'https://www.iqiyi.com/', Accept: 'application/json, text/plain, */*' };

// ---------- 阶段 1：album 列表 ----------
for (const [chStr, chName] of Object.entries(CHANNELS)) {
  const ch = Number(chStr);
  if (sink.count >= TARGET_TOTAL) break;
  for (let page = 1; page <= 4; page++) {
    const r = await fetchJson(API(ch, page, 200), { headers: HDR });
    stats.albumPages++;
    if (r.err || !r.json) {
      failed.push({ platform: 'iqiyi', source: `recommend:channel_id=${ch}&page=${page}`, reason: r.err || 'invalid json / empty body' });
      break;
    }
    const code = r.json.code;
    stats.codes[code] = (stats.codes[code] || 0) + 1;
    if (code !== 'A00000') {
      if (page === 1) failed.push({ platform: 'iqiyi', source: `recommend:channel_id=${ch}`, reason: `code=${code} (该频道无推荐数据)` });
      break;
    }
    const list = r.json.data?.list || [];
    for (const a of list) {
      const rec = makeRecord({
        platform: 'iqiyi',
        item_id: String(a.albumId),
        title: a.name || a.title,
        category: chName,
        interest: null,
        author: null,
        publish_ts: a.period,
        duration_s: null,
        stat: { view: null, like: null, comment: null },
        url: a.playUrl || null,
        source: `iqiyi:pcw-recommend:channel_id=${ch}`,
      });
      if (sink.add(rec)) {
        stats.albums++;
        if (albumList.length < 1e6) albumList.push({ albumId: a.albumId, ch, chName, name: rec.title, videoCount: toInt(a.videoCount) || 0, order: a.latestOrder || 0 });
      }
    }
    if (list.length === 0) break;
  }
  console.log(`  [album] ch=${ch}(${chName}) 累计=${sink.count}`);
}

// ---------- 阶段 2：剧集（按 videoCount 分散到各频道轮转） ----------
console.log(`  album 阶段完成：records=${sink.count} albums=${stats.albums}`);
const buckets = new Map();
for (const a of albumList) {
  if (!buckets.has(a.ch)) buckets.set(a.ch, []);
  buckets.get(a.ch).push(a);
}
for (const [, arr] of buckets) arr.sort((x, y) => (y.videoCount || 0) - (x.videoCount || 0));
const order = [...buckets.values()];
// 频道间轮转交错，保证每个频道都先取头部热门，再往深处走
const interleaved = [];
for (let k = 0, more = true; more; k++) {
  more = false;
  for (const arr of order) if (arr[k]) { interleaved.push(arr[k]); more = true; }
}
let cursor = 0;

while (stats.epCalls < EP_BUDGET && sink.count < TARGET_TOTAL && cursor < interleaved.length) {
  const a = interleaved[cursor++];
  const r = await fetchJson(`https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${a.albumId}&page=1&pageSize=${PER_ALBUM}`, { headers: HDR });
  stats.epCalls++;
  if (r.err || !r.json) {
    failed.push({ platform: 'iqiyi', source: `avlistinfo:aid=${a.albumId}`, reason: r.err || 'invalid json / empty body' });
    continue;
  }
  if (r.json.code !== 'A00000') {
    stats.codes[r.json.code] = (stats.codes[r.json.code] || 0) + 1;
    continue;
  }
  const eps = r.json.data?.epsodelist || [];
  for (const ep of eps.slice(0, PER_ALBUM)) {
    const rec = makeRecord({
      platform: 'iqiyi',
      item_id: ep.vid || (ep.tvId ? String(ep.tvId) : null),
      title: ep.name || ep.shortTitle,
      category: a.chName,
      interest: null,
      author: null,
      publish_ts: ep.issueTime || ep.publishTime || ep.period,
      duration_s: ep.duration,
      stat: { view: null, like: null, comment: null },
      url: ep.playUrl || null,
      source: `iqiyi:avlistinfo:channel_id=${a.ch}`,
    });
    if (sink.add(rec)) stats.eps++;
  }
  if (stats.epCalls % 200 === 0) console.log(`  [ep] 调用=${stats.epCalls} records=${sink.count}`);
}

await sink.close();
const out = {
  name: 'iqiyi',
  records: sink.count,
  files: sink.files,
  stats,
  dups: sink.dups,
  rejected: sink.rejected,
  reject_reasons: sink.rejectReasons,
  by_platform: sink.byPlatform,
  by_source: sink.bySource,
  failed,
  elapsed_s: Math.round((Date.now() - started) / 1000),
};
fs.writeFileSync(path.join(RAW_DIR, '_run_iqiyi.json'), JSON.stringify(out, null, 2));
console.log('DONE iqiyi', JSON.stringify({ records: out.records, stats, elapsed: out.elapsed_s }));
