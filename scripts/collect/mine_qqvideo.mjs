// mine_qqvideo.mjs —— 腾讯视频：pbaccess getPage（频道聚合页）翻页取 cid 卡片
// 入口：POST https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage?video_appid=3000010&vversion_platform=2
import fs from 'node:fs';
import path from 'node:path';
import { Sink, fetchJson, makeRecord, recordFailed, RAW_DIR } from './lib.mjs';

const MAX_PAGES = Number(process.env.QQ_MAX_PAGES || 40);
const TARGET_TOTAL = Number(process.env.TARGET_TOTAL || 50000);

// cid -> 频道名（从 https://v.qq.com/channel/<x> 页内 window.__channel_id__ 反查得到）
const CHANNELS = [
  ['100113', '电视剧'], ['100173', '电影'], ['100109', '综艺'], ['100119', '动漫'],
  ['100150', '少儿'], ['100105', '纪录片'], ['100118', '音乐'], ['100112', '时尚'],
  ['100169', '科技'], ['100114', null],
];

const sink = new Sink({ dir: RAW_DIR });
const failed = [];
const stats = { pages: 0, channels_ok: 0, empty_channels: [] };
const started = Date.now();

function body(cid, pageContext = null) {
  return JSON.stringify({
    page_params: {
      page_type: 'channel', page_id: cid, scene: 'channel', new_mark_label_enabled: '1',
      vl_to_mvl: '', ad_exp_ids: '', ams_cookies: '',
      ad_trans_data: JSON.stringify({ ad_request_id: 'abc12345-x1y2-z3a4', game_sessions: [] }),
      skip_privacy_types: '0', support_click_scan: '1',
    },
    page_bypass_params: {
      params: {
        platform_id: '2', caller_id: '3000010', data_mode: 'default', user_mode: 'default',
        specified_strategy: '', page_type: 'channel', page_id: cid, scene: 'channel',
        new_mark_label_enabled: '1',
      },
      scene: 'channel', app_version: '', abtest_bypass_id: '',
    },
    page_context: pageContext,
  });
}

const URL_PAGE = 'https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage?video_appid=3000010&vversion_platform=2';
const HDR = { 'Content-Type': 'application/json', Referer: 'https://v.qq.com/channel/tv', Origin: 'https://v.qq.com', Accept: 'application/json, text/plain, */*' };

// 递归收集所有同时含 cid 与 title 的 params 对象
function collectVideos(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const x of node) collectVideos(x, out, depth + 1);
    return out;
  }
  const p = node.params;
  if (p && typeof p === 'object' && p.cid && p.title) out.push(p);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectVideos(v, out, depth + 1);
  }
  return out;
}

for (const [cid, name0] of CHANNELS) {
  if (sink.count >= TARGET_TOTAL) break;
  let ctx = null;
  let name = name0;
  let addedHere = 0;
  let zeroStreak = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchJson(URL_PAGE, { method: 'POST', headers: HDR, body: body(cid, ctx) });
    stats.pages++;
    if (r.err) {
      failed.push({ platform: 'qqvideo', source: `getPage:channel_id=${cid}&page=${page}`, reason: r.err });
      break;
    }
    if (!r.json || !r.json.data) {
      const raw = (r.text || '').slice(0, 120);
      failed.push({ platform: 'qqvideo', source: `getPage:channel_id=${cid}`, reason: `空响应/无 data（len=${r.len}, ret=${r.json?.ret}, msg=${r.json?.msg}）` });
      if (page === 1) stats.empty_channels.push(cid);
      void raw;
      break;
    }
    if (!name) {
      const j = JSON.stringify(r.json);
      const m = j.match(/"channel_name":"([^"]{1,20})"/) || j.match(/"page_title":"([^"]{1,20})"/);
      if (m) name = m[1];
    }
    const vids = collectVideos(r.json.data.CardList || [], []);
    const before = addedHere;
    for (const p of vids) {
      const rec = makeRecord({
        platform: 'qqvideo',
        item_id: p.cid,
        title: p.title,
        category: name || null,
        interest: typeof p.main_genres === 'string' && p.main_genres.trim()
          ? p.main_genres.split(/[,，\/、]/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
          : null,
        author: null,
        publish_ts: null,
        duration_s: p.cut_video_duration || p.duration || p.vid_duration,
        stat: { view: null, like: null, comment: null },
        url: `https://v.qq.com/x/cover/${p.cid}.html`,
        source: `qqvideo:getPage:channel=${name || cid}`,
      });
      if (sink.add(rec)) addedHere++;
    }
    const newOnPage = addedHere - before;
    if (newOnPage === 0) zeroStreak++; else zeroStreak = 0;
    if (!r.json.data.has_next_page || zeroStreak >= 3) break;
    ctx = r.json.data.page_context;
    if (!ctx) break;
  }
  if (addedHere > 0) stats.channels_ok++;
  else failed.push({ platform: 'qqvideo', source: `getPage:channel_id=${cid}`, reason: `该频道页无 cid 卡片数据（len=${0}）` });
  console.log(`  [qq] cid=${cid} name=${name} +${addedHere} 累计=${sink.count}`);
}

await sink.close();
const out = {
  name: 'qqvideo', records: sink.count, files: sink.files, dups: sink.dups, rejected: sink.rejected,
  by_platform: sink.byPlatform, by_source: sink.bySource, stats, failed, elapsed_s: Math.round((Date.now() - started) / 1000),
};
fs.writeFileSync(path.join(RAW_DIR, '_run_qqvideo.json'), JSON.stringify(out, null, 2));
for (const f of failed) recordFailed(f.platform, f.source, f.reason);
console.log('DONE qqvideo', JSON.stringify({ records: out.records, stats, elapsed: out.elapsed_s }));
