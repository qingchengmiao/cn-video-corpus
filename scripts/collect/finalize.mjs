// 生成最终汇总 raw/_summary_bili-meta.json（以整理后的分片为准，覆盖 miner 运行期写的那份）。
import fs from 'node:fs';
import path from 'node:path';
import { RAW, META, listShards, isoCST } from './miner_lib.mjs';

const files = listShards('bili-meta');
const by_source = {};
const by_tname = {};
const by_tid = {};
const seen = new Set();
let records = 0, badJson = 0, withTags = 0, enriched = 0;
const fileInfo = [];
for (const f of files) {
  const p = path.join(RAW, f);
  let n = 0;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { badJson++; continue; }
    if (seen.has(r.bvid)) continue;
    seen.add(r.bvid); n++; records++;
    by_source[r.source] = (by_source[r.source] || 0) + 1;
    by_tname[r.tname || '(未知)'] = (by_tname[r.tname || '(未知)'] || 0) + 1;
    by_tid[r.tid ?? 'null'] = (by_tid[r.tid ?? 'null'] || 0) + 1;
    if (Array.isArray(r.tags) && r.tags.length) withTags++;
    if (r.enriched) enriched++;
  }
  fileInfo.push({ file: f, bytes: fs.statSync(p).size, records: n });
}
const ep = path.join(RAW, 'bili-meta-enriched.jsonl');
let enrichedInfo = null;
if (fs.existsSync(ep)) {
  let n = 0, tags = 0, bad = 0;
  const byT = {};
  for (const line of fs.readFileSync(ep, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { bad++; continue; }
    n++;
    if (Array.isArray(r.tags) && r.tags.length) tags++;
    byT[r.tname || '(未知)'] = (byT[r.tname || '(未知)'] || 0) + 1;
  }
  const asc = Object.entries(byT).sort((a, c) => a[1] - c[1]);
  enrichedInfo = {
    file: 'bili-meta-enriched.jsonl', bytes: fs.statSync(ep).size, records: n, badJson: bad,
    with_real_tags: tags, tname_count: Object.keys(byT).length,
    by_tname_top10: Object.fromEntries(Object.entries(byT).sort((a, c) => c[1] - a[1]).slice(0, 10)),
    by_tname_bottom5: Object.fromEntries(asc.slice(0, 5)),
  };
}
const top = Object.entries(by_tname).sort((a, c) => c[1] - a[1]);
const asc = [...top].reverse();
const summary = {
  name: 'bili-meta',
  platform: 'bilibili',
  generated_at: isoCST(),
  records,
  unique_bvid: seen.size,
  badJson,
  tname_count: top.length,
  tid_count: Object.keys(by_tid).length,
  files: fileInfo,
  total_bytes: fileInfo.reduce((s, x) => s + x.bytes, 0),
  by_source,
  by_tname: Object.fromEntries(top.slice(0, 40)),
  tname_bottom10: Object.fromEntries(asc.slice(0, 10)),
  records_with_tags: withTags,
  enriched: enrichedInfo,
  failed: [
    { entry: 'https://api.bilibili.com/x/web-interface/wbi/search/type', reason: 'IP 级 412（返回 3286 字节风控 HTML 页），换 cookie/退避/等待 10 分钟均无效，搜索引擎整条通道不可用；未签名 /x/web-interface/search/type 同样 412' },
    { entry: 'https://api.bilibili.com/x/web-interface/newlist', reason: '412（带 wbi 也 412），分区列表遍历不可用' },
    { entry: 'https://api.bilibili.com/x/web-interface/dynamic/region', reason: '-404，接口已下线' },
    { entry: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=<子分区 tid>', reason: '-400，只接受 rid∈{0,1,3,4,5,11,23,36}，无法按 tid 建分区种子' },
    { entry: 'https://api.bilibili.com/x/tag/archive/tags', reason: '-400' },
    { entry: 'https://api.bilibili.com/x/web-interface/archive/related', reason: '主引擎，共 42,161 请求、31 次风控重试后成功，0 次最终失败' },
  ],
  notes: [
    '主引擎是 view/detail 图扩展：每次请求 = Related 40 条（新记录）+ 当前 bvid 的 Tags（顺带富化），没有「一条视频一次 view」的放大。',
    '分区覆盖不是按 tid 遍历得到的（该通道全部被封），而是靠 BFS「已采条数最少的 tname 优先」逼近，因此分布偏斜：日常 66,354 条居首，尾部电影/番剧资讯/动态漫只有个位数。',
    'tags 只有真从接口拿到才写；未富化记录 tags=[]，表示「未采集」而不是「没有标签」。全库带 tag 记录数见 records_with_tags。',
    'partition_path 只在 meta/regions.json 的 parent_map 能唯一归属时拼「一级/二级」，否则 null（匿名接口不返回 tname，富化时按 bvid 回填采集时的原值）。',
    'title 已去 HTML 标签（<em class="keyword"> 等），文字原样保留。',
    'stat.coin / stat.share 在 source=search 的记录里为 null（搜索接口不返回），其余来源为真实值。',
    'seed 来源：ranking（8 个 rid）、popular（pn 1..5）、newlist、search（早期未封禁时采到 2,591 条）。',
  ],
};
fs.writeFileSync(path.join(RAW, '_summary_bili-meta.json'), JSON.stringify(summary, null, 1), 'utf8');
fs.writeFileSync(path.join(META, 'summary-latest.json'), JSON.stringify({
  records, tname_count: top.length, files: files.length, total_bytes: summary.total_bytes,
  by_source, generated_at: summary.generated_at,
}, null, 1), 'utf8');
console.log(JSON.stringify({ records, tnames: top.length, files: files.length, totalMB: +(summary.total_bytes / 1048576).toFixed(1), by_source, enriched: enrichedInfo?.records, records_with_tags: withTags }, null, 0));
