// quality_other.mjs —— 质量报告：按平台的 total / with_view / with_publish / with_duration / title_uniq
// 以及「低质量行」判定（只有标题、publish/duration/stat 全空）→ 写 raw/_quality_other.json
// 用法：node quality_other.mjs            # 只报告
//       node quality_other.mjs --trim     # 报告 + 剔除 C 级行（title 之外全空）
import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR, PLATFORMS } from './lib.mjs';

const TRIM = process.argv.includes('--trim');
const files = fs.readdirSync(RAW_DIR).filter((n) => /^other-meta(?:-\d{3})?\.jsonl$/.test(n)).sort();

const isSet = (v) => v !== null && v !== undefined && v !== '';
const hasStat = (s) => !!s && (isSet(s.view) || isSet(s.like) || isSet(s.comment));

const by = {};
for (const p of PLATFORMS) by[p] = { total: 0, with_view: 0, with_like: 0, with_comment: 0, with_publish: 0, with_duration: 0, with_interest: 0, title_only: 0, titles: new Set() };

const rows = []; // { file, line }
for (const f of files) {
  fs.readFileSync(path.join(RAW_DIR, f), 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    rows.push({ file: f, lineNo: i + 1, raw: line });
  });
}

const cRows = [];
for (const r of rows) {
  let o; try { o = JSON.parse(r.raw); } catch { continue; }
  const b = by[o.platform] || (by[o.platform] = { total: 0, with_view: 0, with_like: 0, with_comment: 0, with_publish: 0, with_duration: 0, with_interest: 0, title_only: 0, titles: new Set() });
  b.total++;
  if (o.title) b.titles.add(String(o.title).trim());
  if (isSet(o.stat?.view)) b.with_view++;
  if (isSet(o.stat?.like)) b.with_like++;
  if (isSet(o.stat?.comment)) b.with_comment++;
  if (isSet(o.publish_ts)) b.with_publish++;
  if (isSet(o.duration_s)) b.with_duration++;
  if (Array.isArray(o.interest) && o.interest.length) b.with_interest++;
  const isC = isSet(o.title) && !isSet(o.publish_ts) && !isSet(o.duration_s) && !hasStat(o.stat) && !(Array.isArray(o.interest) && o.interest.length);
  if (isC) { b.title_only++; cRows.push(r); }
}

const report = {};
let totalAll = 0;
for (const [p, b] of Object.entries(by)) {
  if (!b.total) continue;
  totalAll += b.total;
  report[p] = {
    total: b.total,
    with_view: b.with_view,
    with_like: b.with_like,
    with_comment: b.with_comment,
    with_publish: b.with_publish,
    with_duration: b.with_duration,
    with_interest: b.with_interest,
    title_only: b.title_only,
    title_uniq: b.titles.size,
    coverage: {
      view: `${((b.with_view / b.total) * 100).toFixed(1)}%`,
      publish: `${((b.with_publish / b.total) * 100).toFixed(1)}%`,
      duration: `${((b.with_duration / b.total) * 100).toFixed(1)}%`,
      any_stat: `${(((b.with_like + b.with_comment - (b.with_like && b.with_comment ? 0 : 0)) / b.total) * 100).toFixed(1)}%`,
    },
  };
}

const out = {
  generated_at: new Date().toISOString(),
  total_all: totalAll,
  by_platform: report,
  rule: 'C 级（低质量）= 除 title 外 publish_ts/duration_s/stat/interest 全空；A 级 = 有 publish 或 duration；stat.view 全平台匿名接口都不给（见 failed/notes）',
  title_only_rows: cRows.length,
};
fs.writeFileSync(path.join(RAW_DIR, '_quality_other.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ total_all: totalAll, by_platform: report, title_only_rows: cRows.length }, null, 2));

if (TRIM && cRows.length) {
  const drop = new Set(cRows.map((r) => `${r.file}:${r.lineNo}`));
  for (const f of files) {
    const p = path.join(RAW_DIR, f);
    const keep = [];
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      if (drop.has(`${f}:${i + 1}`)) return;
      keep.push(line);
    });
    fs.writeFileSync(p, keep.length ? keep.join('\n') + '\n' : '');
  }
  console.log(`\n已剔除 ${cRows.length} 条 C 级行`);
}
