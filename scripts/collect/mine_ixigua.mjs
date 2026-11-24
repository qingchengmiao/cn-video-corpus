// mine_ixigua.mjs —— 西瓜视频：首页/频道页纯壳无 _SSR_HYDRATED_DATA；feed 接口需 _signature 且返回 0 字节。
// 本脚本只做「复查 + 如实记 failed」，不产出任何记录。
import fs from 'node:fs';
import path from 'node:path';
import { fetchText, recordFailed, RAW_DIR } from './lib.mjs';

const PLATFORM = 'ixigua';
const started = Date.now();
const probes = [];

const targets = [
  ['https://www.ixigua.com/', 'text/html'],
  ['https://www.ixigua.com/channel/dianying', 'text/html'],
  ['https://www.ixigua.com/api/pc/feed/?category=news_hot&max_behot_time=0&utm_source=toutiao&aid=1768&app_name=toutiao_web', 'application/json'],
  ['https://www.ixigua.com/api/pc/search/?keyword=%E7%94%B5%E5%BD%B1&offset=0', 'application/json'],
];
for (const [url, accept] of targets) {
  const r = await fetchText(url, { headers: { Referer: 'https://www.ixigua.com/', Accept: accept } });
  probes.push({
    url,
    status: r.status,
    len: r.len,
    ct: r.headers?.get?.('content-type') || '',
    has_SSR: (r.text || '').includes('_SSR_HYDRATED_DATA'),
    has_ROUTER: (r.text || '').includes('__INITIAL_STATE__'),
    body0: (r.text || '').slice(0, 100),
  });
}

const reason =
  `https://www.ixigua.com/ 与 /channel/dianying 返回 200 但 body 仅 7765/7717 字节纯壳 HTML，无 _SSR_HYDRATED_DATA/__INITIAL_STATE__；` +
  `https://www.ixigua.com/api/pc/feed/?category=news_hot&... 返回 200 text/plain 但 body 0 字节（需 _signature 签名）；` +
  `https://www.ixigua.com/api/pc/search/?keyword=... 与 /motor/api/pc/feed/、/api/pc/list/feed 同样为空壳或无响应数据。`;
recordFailed(PLATFORM, 'ixigua.com 首页/频道页 + /api/pc/feed/ + /api/pc/search/', reason);
const out = { name: PLATFORM, records: 0, files: [], failed: [{ platform: PLATFORM, source: 'ixigua 全部公开入口', reason }], probes, elapsed_s: Math.round((Date.now() - started) / 1000) };
fs.writeFileSync(path.join(RAW_DIR, '_run_ixigua.json'), JSON.stringify(out, null, 2));
console.log('DONE ixigua (no records, failed recorded)', JSON.stringify(probes, null, 1));
