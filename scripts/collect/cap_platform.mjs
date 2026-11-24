// cap_platform.mjs —— 把某平台截断到上限条数；被剔除的行另存到 raw/_trimmed_<platform>.jsonl（可恢复）
// 保留顺序：质量分高者优先（publish/duration/stat/interest 各计 1 分），同分按原顺序
// 用法：node cap_platform.mjs iqiyi 20000
import fs from 'node:fs';
import path from 'node:path';
const [platform, capStr] = process.argv.slice(2);
const cap = Number(capStr);
if (!platform || !Number.isFinite(cap)) { console.error('用法：node cap_platform.mjs <platform> <cap>'); process.exit(1); }

const dir = path.join(process.cwd(), 'raw');
const files = fs.readdirSync(dir).filter((n) => /^other-meta(?:-\d{3})?\.jsonl$/.test(n)).sort();
const isSet = (v) => v !== null && v !== undefined && v !== '';
const score = (o) => (isSet(o.publish_ts) ? 1 : 0) + (isSet(o.duration_s) ? 2 : 0)
  + (isSet(o.stat?.like) || isSet(o.stat?.comment) || isSet(o.stat?.view) ? 1 : 0)
  + (Array.isArray(o.interest) && o.interest.length ? 1 : 0) + (isSet(o.url) ? 1 : 0);

const mine = [];
const others = [];
for (const f of files) {
  fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line) => {
    if (!line.trim()) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    (o.platform === platform ? mine : others).push({ line, o });
  });
}
if (mine.length <= cap) { console.log(`${platform} 只有 ${mine.length} 条，无需截断（cap=${cap}）`); process.exit(0); }

mine.forEach((x, i) => { x.i = i; x.s = score(x.o); });
mine.sort((a, b) => b.s - a.s || a.i - b.i);
const keep = mine.slice(0, cap);
const drop = mine.slice(cap);

// 保持文件内原顺序写回：用文件+行号记录原位——简化为按原 i 排序输出
const keepSorted = keep.slice().sort((a, b) => a.i - b.i);
const outLines = [];
for (const f of files) {
  const p = path.join(dir, f);
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.platform === platform) continue;
    outLines.push(line);
  }
}
const allKeep = [...outLines, ...keepSorted.map((x) => x.line)];
fs.writeFileSync(path.join(dir, files[0]), allKeep.join('\n') + '\n');
for (const f of files.slice(1)) fs.writeFileSync(path.join(dir, f), '');

fs.writeFileSync(path.join(dir, `_trimmed_${platform}.jsonl`), drop.map((x) => x.line).join('\n') + '\n');
console.log(`${platform}: 保留 ${cap}，剔除 ${drop.length}（另存 raw/_trimmed_${platform}.jsonl）；全库 ${allKeep.length}`);
