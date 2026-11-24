// mine_youku_detail.mjs —— 优酷「视频详情页」深挖：https://v.youku.com/video?s=<短id>
// 页面 SSR 的 window.__INITIAL_DATA__.pageMap.extra 给了真元数据：
//   videoTitle / showName / videoCategory / videoType / videoPublishTime("2025-09-08 09:09:00")
//   duration(秒, 52.16) / totalUp(点赞) / totalComment(评论)
// 每页还带 20~30 个相关视频 id（v.youku.com/video?s=... 与 action_value）→ 用它做广度爬取扩量。
// 无 view 字段：播放量平台不给（不猜，写 null）。
import fs from 'node:fs';
import path from 'node:path';
import { Sink, fetchText, extractJsLiteral, makeRecord, toInt, RAW_DIR } from './lib.mjs';

const TARGET_YOUKU = Number(process.env.TARGET_YOUKU || 20000); // 本平台上限
const MAX_REQ = Number(process.env.MAX_REQ || 4000);
const ID_RE = /^[A-Za-z0-9=+/]{8,40}$/;

const sink = new Sink({ dir: RAW_DIR });
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 种子：已有 jsonl 里的 youku item_id + /ku 频道页里抓到的 id
const queue = [];
const queued = new Set();
const push = (id) => {
  if (!id || !ID_RE.test(id) || queued.has(id)) return;
  queued.add(id);
  queue.push(id);
};
for (const f of fs.readdirSync(RAW_DIR).filter((n) => /^other-meta(?:-\d{3})?\.jsonl$/.test(n))) {
  for (const line of fs.readFileSync(path.join(RAW_DIR, f), 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (r.platform === 'youku') push(String(r.item_id));
  }
}
const seedN = queue.length;
const seedFile = path.join('probe', 'yk_ids.json');
if (fs.existsSync(seedFile)) for (const id of JSON.parse(fs.readFileSync(seedFile, 'utf8'))) push(id);
console.log(`youku 详情页爬取：种子=${queue.length}（jsonl ${seedN} 条）目标=${TARGET_YOUKU} 请求上限=${MAX_REQ}`);

const parseTs = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]); // 站点时间按北京时间
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

const stats = { req: 0, added: 0, empty: 0, bad: 0, queuePeak: 0 };
const failed = [];
let youkuCount = sink.byPlatform?.youku || 0;

for (let i = 0; i < queue.length && stats.req < MAX_REQ; i++) {
  if (youkuCount >= TARGET_YOUKU) break;
  const id = queue[i];
  const url = `https://v.youku.com/video?s=${id}`;
  const r = await fetchText(url, { headers: { Referer: 'https://www.youku.com/', Accept: 'text/html' } });
  stats.req++;
  await sleep(120);
  if (r.err || !r.text) {
    stats.bad++;
    if (stats.bad <= 5) failed.push({ platform: 'youku', source: `v.youku.com/video?s=${id}`, reason: r.err || 'empty body' });
    continue;
  }
  const lit = extractJsLiteral(r.text, 'window.__INITIAL_DATA__');
  const ex = lit?.pageMap?.extra;
  if (!ex || !ex.videoTitle) {
    stats.empty++;
    continue;
  }
  const cat = ex.videoCategory || ex.showCategory || null;
  const vtype = ex.videoType || null;
  const interest = [];
  if (vtype && vtype !== cat) interest.push(vtype);
  if (ex.showSubtitle) interest.push(String(ex.showSubtitle).slice(0, 40));
  const rec = makeRecord({
    platform: 'youku',
    item_id: id,
    title: ex.videoTitle,
    category: cat,
    interest: interest.length ? interest : null,
    author: ex.userName || null, // 优酷详情页不暴露上传者；没有就 null，不拿剧名冒充
    publish_ts: parseTs(ex.videoPublishTime) ?? (ex.showReleaseTime && ex.showReleaseTime !== '0000-00-00' ? parseTs(ex.showReleaseTime + ' 00:00:00') : null),
    duration_s: typeof ex.duration === 'number' ? Math.round(ex.duration) : (toInt(ex.duration) || null),
    stat: { view: null, like: toInt(ex.totalUp) || null, comment: toInt(ex.totalComment) || null },
    url,
    source: 'youku:v-detail:/video?s=',
  });
  if (sink.add(rec)) { stats.added++; youkuCount++; }

  // 相关视频 id 入队
  for (const m of r.text.matchAll(/v\.youku\.com\/video\?s=([A-Za-z0-9=+/]{8,40})/g)) push(m[1]);
  for (const m of r.text.matchAll(/"action_value":"([A-Za-z0-9=+/]{8,40})"/g)) push(m[1]);
  if (queue.length > stats.queuePeak) stats.queuePeak = queue.length;
  if (stats.req % 100 === 0) console.log(`  [yk] req=${stats.req} +${stats.added} 累计=${sink.count} 队列剩余=${queue.length - i}`);
}

await sink.close();
const out = { name: 'youku_detail', records: sink.count, stats, by_platform: sink.byPlatform, dups: sink.dups, rejected: sink.rejected, failed, elapsed_s: Math.round((Date.now() - started) / 1000) };
fs.writeFileSync(path.join(RAW_DIR, '_run_youku_detail.json'), JSON.stringify(out, null, 2));
console.log('DONE youku_detail', JSON.stringify({ records: out.records, stats, by_platform: out.by_platform, elapsed: out.elapsed_s }));
