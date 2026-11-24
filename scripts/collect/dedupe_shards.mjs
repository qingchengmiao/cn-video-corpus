// 去重：按分片顺序保留每个 bvid 首次出现，重写分片（旧文件先改名 .dup 备份再删）。
import fs from 'node:fs';
import path from 'node:path';
import { RAW, mkdirs, listShards } from './miner_lib.mjs';

mkdirs();
const PREFIX = 'bili-meta';
const files = listShards(PREFIX);
const seen = new Set();
const kept = [];   // {line, bvid}
let totalIn = 0, dup = 0, bad = 0;
for (const f of files) {
  for (const line of fs.readFileSync(path.join(RAW, f), 'utf8').split('\n')) {
    if (!line) continue;
    totalIn++;
    let r; try { r = JSON.parse(line); } catch { bad++; continue; }
    if (!r.bvid) { bad++; continue; }
    if (seen.has(r.bvid)) { dup++; continue; }
    seen.add(r.bvid);
    kept.push({ r, f });
  }
}
// 分片重写：每 50000 条一片，编号从 001 开始
const outFiles = [];
const tmpDir = path.join(RAW, '_dedupe_tmp');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
let idx = 0, buf = [], cnt = 0;
const flush = () => {
  if (!buf.length) return;
  idx++;
  const name = `${PREFIX}-${String(idx).padStart(3, '0')}.jsonl`;
  fs.writeFileSync(path.join(tmpDir, name), buf.join(''));
  outFiles.push(name);
  buf = [];
};
for (const { r } of kept) {
  buf.push(JSON.stringify(r) + '\n');
  cnt++;
  if (cnt % 50000 === 0) flush();
}
flush();
// 备份旧文件后替换
const bakDir = path.join(RAW, '_dup_bak');
fs.rmSync(bakDir, { recursive: true, force: true });
fs.mkdirSync(bakDir, { recursive: true });
for (const f of files) fs.renameSync(path.join(RAW, f), path.join(bakDir, f));
for (const f of outFiles) fs.renameSync(path.join(tmpDir, f), path.join(RAW, f));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(JSON.stringify({ totalIn, kept: kept.length, dup, bad, outFiles: outFiles.length, backup: bakDir }, null, 0));
