// validate_other.mjs —— 校验 raw/other-meta*.jsonl
// 规则（严格照任务）：
//   1. 每行 JSON 可解析
//   2. platform 在枚举内
//   3. item_id 非空
//   4. title 非空
//   5. platform+item_id 全局唯一
// 顺带统计：字段 null 率、stat 子字段 null 率、url 非空率、category/interest 覆盖率
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORMS, RAW_DIR } from './lib.mjs';

const dir = RAW_DIR;
const files = fs
  .readdirSync(dir)
  .filter((n) => /^other-meta(?:-\d{3})?\.jsonl$/.test(n))
  .sort();

if (!files.length) { console.error('没找到 raw/other-meta*.jsonl'); process.exit(1); }

const seen = new Map(); // platform|item_id -> 首次出现位置
const fatal = []; // 严重问题（不可解析 / 枚举外 / item_id 空 / title 空 / 重复）
let total = 0;
let bytes = 0;
const byPlatform = {};
const nulls = {};
const fields = ['title', 'category', 'interest', 'author', 'publish_ts', 'duration_s', 'url', 'source', 'crawled_at'];
const statFields = ['view', 'like', 'comment'];

const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

for (const f of files) {
  const p = path.join(dir, f);
  bytes += fs.statSync(p).size;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    total++;
    const where = `${f}:${lineNo}`;
    let r;
    try { r = JSON.parse(line); } catch (e) {
      fatal.push({ where, reason: `JSON 不可解析: ${e.message}`, head: line.slice(0, 120) });
      continue;
    }
    if (!PLATFORMS.includes(r.platform)) fatal.push({ where, reason: `platform 枚举外: ${JSON.stringify(r.platform)}` });
    const itemId = r.item_id == null ? '' : String(r.item_id).trim();
    if (!itemId) fatal.push({ where, reason: 'item_id 为空' });
    const title = r.title == null ? '' : String(r.title).trim();
    if (!title) fatal.push({ where, reason: 'title 为空' });
    if (itemId) {
      const key = `${r.platform}|${itemId}`;
      if (seen.has(key)) fatal.push({ where, reason: `platform+item_id 重复（首现 ${seen.get(key)}）: ${key}` });
      else seen.set(key, where);
    }
    bump(byPlatform, r.platform);
    for (const k of fields) if (r[k] === null || r[k] === undefined || r[k] === '') bump(nulls, k);
    if (!r.stat || typeof r.stat !== 'object') bump(nulls, 'stat');
    else for (const k of statFields) if (r.stat[k] === null || r.stat[k] === undefined) bump(nulls, `stat.${k}`);
  }
}

const pct = (n) => `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`;
const summary = {
  ok: fatal.length === 0,
  files,
  bytes,
  total,
  unique: seen.size,
  by_platform: byPlatform,
  null_rate: Object.fromEntries(Object.entries(nulls).map(([k, v]) => [k, `${pct(v)} (${v})`])),
  fatal_count: fatal.length,
  fatal_sample: fatal.slice(0, 30),
};

console.log(JSON.stringify(summary, null, 2));
if (fatal.length) {
  console.error(`\n❌ 校验失败：${fatal.length} 条问题（上面只列前 30 条）`);
  process.exitCode = 1;
} else {
  console.error(`\n✅ 校验通过：${total} 条，${files.length} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
}
fs.writeFileSync(path.join(dir, '_validate_other.json'), JSON.stringify(summary, null, 2));
