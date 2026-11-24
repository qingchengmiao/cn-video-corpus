// mine_douyin.mjs —— 抖音：公开无签名接口只有「热搜话题」，没有视频条目；视频列表/分享页需 a_bogus/X-Bogus 签名。
// 本脚本只做「复查 + 如实记 failed」，不产出任何记录（不编造）。
import fs from 'node:fs';
import path from 'node:path';
import { fetchText, fetchJson, recordFailed, RAW_DIR } from './lib.mjs';

const PLATFORM = 'douyin';
const started = Date.now();
const probes = [];

// 1) 热搜榜（无签名，可用）—— 只有 word/sentence_id/hot_value，无视频
{
  const url = 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=web&aid=6383&channel=channel_pc_web&detail_list=1';
  const r = await fetchJson(url, { headers: { Referer: 'https://www.douyin.com/' } });
  const n = r.json?.data?.word_list?.length || 0;
  const sample = r.json?.data?.word_list?.[0] || null;
  probes.push({ url, status: r.status, len: r.len, words: n, sample_keys: sample ? Object.keys(sample) : [], has_aweme: !!(r.json?.data?.word_list || []).some((w) => w.aweme_id) });
}
// 2) 热搜话题的视频列表（需签名）—— 实测 200 空 body
let sentId = null;
{
  const url0 = 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=web&aid=6383&channel=channel_pc_web&detail_list=1';
  const r0 = await fetchJson(url0, { headers: { Referer: 'https://www.douyin.com/' } });
  sentId = r0.json?.data?.word_list?.[0]?.sentence_id || null;
}
if (sentId) {
  const url = `https://www.douyin.com/aweme/v1/web/hot/search/video/list/?device_platform=web&aid=6383&channel=channel_pc_web&sentence_id=${sentId}&detail_list=1&source=trending_page&word=`;
  const r = await fetchText(url, { headers: { Referer: 'https://www.douyin.com/hot' } });
  probes.push({ url, status: r.status, len: r.len, body0: (r.text || '').slice(0, 80) });
}
// 3) 老分享页 SSR（需签名）—— 无 RENDER_DATA
{
  const url = 'https://www.iesdouyin.com/share/video/7300000000000000000/';
  const r = await fetchText(url, { headers: { Referer: 'https://www.douyin.com/' } });
  probes.push({ url, status: r.status, len: r.len, has_RENDER_DATA: (r.text || '').includes('RENDER_DATA') });
}

const reason =
  `热搜榜可用但只返回话题元数据（word/sentence_id/hot_value/word_cover，无 aweme 视频条目，word_list=${probes[0]?.words} 条）；` +
  `热搜视频列表接口返回 200 但 body 0 字节（需 a_bogus/X-Bogus 签名）；` +
  `热搜详情接口 404 {"status_code":0,"message":"Unsupported path(Janus)"}；` +
  `分享页 /share/video/<id>/ 与 /video/<id> 均为纯壳 SSR，无 RENDER_DATA/_ROUTER_DATA。匿名无签名拿不到视频。`;
recordFailed(PLATFORM, 'douyin.com/aweme/v1/web/hot/search/* + iesdouyin.com/share/video', reason);
const out = { name: PLATFORM, records: 0, files: [], failed: [{ platform: PLATFORM, source: 'douyin 全部公开入口', reason }], probes, elapsed_s: Math.round((Date.now() - started) / 1000) };
fs.writeFileSync(path.join(RAW_DIR, '_run_douyin.json'), JSON.stringify(out, null, 2));
console.log('DONE douyin (no records, failed recorded)', JSON.stringify(probes));
