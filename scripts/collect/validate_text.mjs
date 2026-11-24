// 校验 raw\bili-text-*.jsonl 并生成 raw\_summary_bili-text.json
// 用法：node validate_text.mjs [--raw <目录>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const rawIdx = argv.indexOf('--raw');
const RAW = rawIdx >= 0 && argv[rawIdx + 1] ? path.resolve(argv[rawIdx + 1]) : path.join(DIR, 'raw');

const KINDS = new Set(['danmaku', 'reply']);
const errors = [];
const errCount = new Map();
function err(cat, detail) {
  errCount.set(cat, (errCount.get(cat) || 0) + 1);
  if (errors.length < 200) errors.push({ cat, detail });
}

const files = fs.readdirSync(RAW).filter((f) => /^bili-text-\d{3}\.jsonl$/.test(f)).sort();
let records = 0;
const byKind = { danmaku: 0, reply: 0 };
const byTname = {};
const videos = new Set();
const kindVideos = { danmaku: new Set(), reply: new Set() };
const fileInfo = [];
const minCtime = { v: Infinity };
let emptyText = 0;
let seen = new Set();
let dup = 0;

for (const f of files) {
  const p = path.join(RAW, f);
  const size = fs.statSync(p).size;
  const buf = fs.readFileSync(p);
  let lines = 0;
  let bad = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) err('bom', f);
  const text = buf.toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      bad++;
      err('json', `${f}: ${line.slice(0, 120)}`);
      continue;
    }
    if (o.platform !== 'bilibili') err('platform', f);
    if (!KINDS.has(o.kind)) { err('kind', String(o.kind)); continue; }
    if (typeof o.bvid !== 'string' || !o.bvid.trim()) err('bvid', f);
    if (typeof o.text !== 'string' || !o.text.length) { err('text-empty', f); continue; }
    if (o.text.length > 2000) err('text-long', `${f}:${o.text.length}`);
    if (o.kind === 'danmaku') {
      if (!Number.isFinite(o.time_ms)) err('dm-time_ms', f);
      if (!Number.isFinite(o.mode)) err('dm-mode', f);
      if (!Number.isFinite(o.color)) err('dm-color', f);
      if (!Number.isFinite(o.cid)) err('dm-cid', f);
      if (!o.text.trim()) emptyText++;
      byKind.danmaku++;
      kindVideos.danmaku.add(o.bvid);
    } else {
      if (!Number.isFinite(o.rpid)) err('reply-rpid', f);
      if (o.root !== 0 && !Number.isFinite(o.root)) err('reply-root', f);
      if (o.parent !== 0 && !Number.isFinite(o.parent)) err('reply-parent', f);
      if (o.depth !== 0 && o.depth !== 1) err('reply-depth', String(o.depth));
      byKind.reply++;
      kindVideos.reply.add(o.bvid);
    }
    if (o.tname) byTname[o.tname] = (byTname[o.tname] || 0) + 1;
    if (Number.isFinite(o.ctime) && o.ctime > 0 && o.ctime < minCtime.v) minCtime.v = o.ctime;
    videos.add(o.bvid);
    // 跨文件重复检查：弹幕用 bvid|time_ms|text，评论用 bvid|rpid
    const key = o.kind === 'danmaku' ? `d|${o.bvid}|${o.time_ms}|${o.text}` : `r|${o.bvid}|${o.rpid}`;
    if (seen.has(key)) dup++;
    else seen.add(key);
    if (seen.size > 400000) seen = new Set([...seen].slice(-200000));
    records++;
  }
  // 行数应等于非空行数
  if (records === 0 && lines === 0) err('empty-file', f);
  fileInfo.push({ name: f, bytes: size, records: lines - bad });
}

let state = null;
try {
  state = JSON.parse(fs.readFileSync(path.join(RAW, '_state_bili-text.json'), 'utf8'));
} catch { /* 无状态文件 */ }

const byTnameSorted = Object.fromEntries(Object.entries(byTname).sort((a, b) => b[1] - a[1]));
const uniqTname = Object.keys(byTname).length;
const summary = {
  name: 'bili-text',
  records,
  by_kind: byKind,
  by_tname: byTnameSorted,
  tname_count: uniqTname,
  videos_covered: videos.size,
  videos_with_danmaku: kindVideos.danmaku.size,
  videos_with_reply: kindVideos.reply.size,
  files: fileInfo,
  files_total_bytes: fileInfo.reduce((s, x) => s + x.bytes, 0),
  duplicates_across_files: dup,
  oldest_ctime: Number.isFinite(minCtime.v) ? minCtime.v : null,
  validation: {
    ok: errors.length === 0 && dup === 0,
    errors: errCount.size ? Object.fromEntries(errCount) : {},
    samples: errors,
  },
  failed: (state?.failed || []).map((x) => ({ source: x.source, reason: x.reason })),
  failed_total_dropped: state?.failedDropped || 0,
  notes: [
    'kind=danmaku 来自 comment.bilibili.com/<cid>.xml（弹幕 XML，list.so 对匿名 IP 返回 412 已弃用）；time_ms = p[0]秒×1000，mode = p[1]，color = p[3]，text 原样（XML 实体已反转义）。',
    'kind=reply 来自 /x/v2/reply/wbi/main?mode=1 与 mode=3 两套顶楼（各 3 条，互不重复）+ /x/v2/reply/reply 楼中楼第一页（≤20/root）；匿名态单视频可见评论上限约 6 顶楼 + 各自 20 条楼中楼，因此每视频评论数约 20–60，非全量。',
    '一级评论 root=0 depth=0；楼中楼 root=顶楼 rpid，parent=接口给的父 rpid，depth=1。',
    '脱敏：邮箱 / 手机号 / 18位与15位身份证 / 带标记(QQ、扣扣、企鹅、群号、加群、q群)的 QQ 号 / 裸 9–11 位数字 → <已隐去>；其余文本原样，未过滤脏话、缩写、重复字符。',
    '每视频弹幕按发送时间均匀抽样，上限 800 条（不是全量弹幕池）。',
    'crawled_at 为采集时刻（Asia/Shanghai，ISO8601 +08:00）。',
  ],
};
fs.writeFileSync(path.join(RAW, '_summary_bili-text.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log(`records=${records} dm=${byKind.danmaku} reply=${byKind.reply} videos=${videos.size} tnames=${uniqTname} files=${files.length} dup=${dup} err=${errors.length}`);
if (errors.length) {
  for (const e of errors.slice(0, 10)) console.log(`ERR ${e.cat}: ${e.detail}`);
}
console.log('summary ->', path.join(RAW, '_summary_bili-text.json'));
