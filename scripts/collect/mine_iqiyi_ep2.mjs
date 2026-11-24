// mine_iqiyi_ep2.mjs —— 爱奇艺剧集补充阶段：对「已落盘但还没抽过剧集」的 album 逐个拉 avlistinfo，
// 直到总记录数到 TARGET_TOTAL。album 池来自 raw/other-meta*.jsonl 里 source 含 pcw-recommend 的记录。
import fs from 'node:fs';
import path from 'node:path';
import { Sink, fetchJson, makeRecord, toInt, RAW_DIR } from './lib.mjs';

const TARGET_TOTAL = Number(process.env.TARGET_TOTAL || 50000);
const EP_BUDGET = Number(process.env.EP_BUDGET || 2000);
const PER_ALBUM = 30;

const sink = new Sink({ dir: RAW_DIR });
const started = Date.now();

// 收 album（含已抽过剧集的也留着，去重会挡掉重复 ep）
const albums = [];
const seenAlbum = new Set();
for (const f of fs.existsSync(RAW_DIR) ? fs.readdirSync(RAW_DIR).filter((n) => /^other-meta(?:-\d{3})?\.jsonl$/.test(n)) : []) {
  for (const line of fs.readFileSync(path.join(RAW_DIR, f), 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (r.platform !== 'iqiyi') continue;
    if (!String(r.source || '').includes('pcw-recommend')) continue;
    const aid = String(r.item_id);
    if (seenAlbum.has(aid)) continue;
    seenAlbum.add(aid);
    albums.push({ aid, category: r.category || null, ch: (String(r.source).match(/channel_id=(\d+)/) || [])[1] || '' });
  }
}
console.log(`album 池=${albums.length} 当前记录=${sink.count} 目标=${TARGET_TOTAL}`);

const HDR = { Referer: 'https://www.iqiyi.com/', Accept: 'application/json, text/plain, */*' };
const stats = { calls: 0, eps: 0, codes: {}, noEp: 0 };
const failed = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const a of albums) {
  if (sink.count >= TARGET_TOTAL) break;
  if (stats.calls >= EP_BUDGET) break;
  const url = `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${a.aid}&page=1&pageSize=${PER_ALBUM}`;
  const r = await fetchJson(url, { headers: HDR });
  stats.calls++;
  await sleep(340);
  if (r.err || !r.json) { failed.push({ platform: 'iqiyi', source: `avlistinfo:aid=${a.aid}`, reason: r.err || 'invalid json' }); continue; }
  const code = r.json.code;
  stats.codes[code] = (stats.codes[code] || 0) + 1;
  if (code !== 'A00000') { stats.noEp++; continue; }
  const eps = r.json.data?.epsodelist || [];
  for (const ep of eps.slice(0, PER_ALBUM)) {
    const rec = makeRecord({
      platform: 'iqiyi',
      item_id: ep.vid || (ep.tvId ? String(ep.tvId) : null),
      title: ep.name || ep.shortTitle,
      category: a.category,
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
  if (stats.calls % 100 === 0) console.log(`  [ep2] 调用=${stats.calls} 目标剩余=${TARGET_TOTAL - sink.count} 累计=${sink.count}`);
}

await sink.close();
const out = {
  name: 'iqiyi_ep2',
  records: sink.count,
  stats,
  dups: sink.dups,
  rejected: sink.rejected,
  by_platform: sink.byPlatform,
  failed,
  elapsed_s: Math.round((Date.now() - started) / 1000),
};
fs.writeFileSync(path.join(RAW_DIR, '_run_iqiyi_ep2.json'), JSON.stringify(out, null, 2));
console.log('DONE iqiyi_ep2', JSON.stringify({ records: out.records, stats, elapsed: out.elapsed_s }));
