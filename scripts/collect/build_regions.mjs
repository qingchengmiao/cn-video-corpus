// 第1步：探测真实分区。
// 对 rid 1..500 调 ranking/v2，收集 code=0 的 rid 与返回视频的真实 tid/tname。
// 不瞎补：只有接口返回过的 tid/tname 才写；一级分区中文名单独放在 known_first_level（标明是已知对照，非接口返回）。
import fs from 'node:fs';
import path from 'node:path';
import { Bili, META, RAW, mkdirs, isoCST, sleep, listShards } from './miner_lib.mjs';

const KNOWN_FIRST_LEVEL = {
  0: '全站', 1: '动画', 3: '音乐', 4: '游戏', 5: '娱乐', 11: '电视剧', 13: '番剧',
  23: '电影', 36: '科技', 119: '鬼畜', 129: '舞蹈', 138: '搞笑', 155: '时尚',
  160: '生活', 167: '国创相关', 181: '影视', 188: '数码', 202: '资讯', 211: '美食',
  217: '动物圈', 223: '汽车', 234: '运动', 249: '知识',
};

mkdirs();
const b = new Bili({ rps: 1.6 });
await b.boot();
console.log('boot ok, cookie len=', b.cookie.length);

// 本会话早前已实测 code=0 的榜单 rid（t3.mjs 结果），作为已观测证据保留
const OBSERVED_OK = [0, 1, 3, 4, 5, 11, 23, 36];

const probed = [];
const tidAgg = new Map();
const validRids = new Set(OBSERVED_OK.filter((r) => r !== 0));
let blocked = 0, consecBlocked = 0;
let abortedAt = null;
const BUDGET_MS = Number(process.env.BUDGET_MS || 8 * 60 * 1000);
const t0 = Date.now();

for (let rid = 1; rid <= 500; rid++) {
  if (Date.now() - t0 > BUDGET_MS) { abortedAt = { rid, reason: 'time budget' }; console.log(`  预算用尽，停在 rid=${rid}`); break; }
  if (consecBlocked >= 10) { abortedAt = { rid, reason: '连续10次 -352 风控' }; console.log(`  连续风控，停止探测于 rid=${rid}`); break; }
  let j = null;
  try {
    j = await b.raw(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, null, { signed: false, retry: 0, riskRetry: false, riskPause: 4000 });
  } catch (e) {
    probed.push({ rid, code: 'err', n: 0, sample_bvid: null });
    if (/-352/.test(e.message)) { blocked++; consecBlocked++; }
    continue;
  }
  const list = j?.data?.list || [];
  probed.push({ rid, code: j?.code ?? null, n: list.length, sample_bvid: list[0]?.bvid ?? null });
  if (j?.code === -352) { blocked++; consecBlocked++; }
  else {
    consecBlocked = 0;
    if (j?.code === 0 && list.length) {
      validRids.add(rid);
      for (const v of list) {
        if (!v.tid) continue;
        const key = Number(v.tid);
        if (!tidAgg.has(key)) tidAgg.set(key, { tid: key, tname: v.tname ?? null, rids: new Set(), n: 0 });
        const e = tidAgg.get(key);
        e.rids.add(rid); e.n++;
        if (!e.tname && v.tname) e.tname = v.tname;
      }
    }
  }
  if (rid % 50 === 0) console.log(`  probed rid=${rid} valid=${validRids.size} blocked=${blocked}`);
}

const validRidsArr = [...validRids].sort((a, c) => a - c);
console.log('ranking probe done. valid rids =', validRidsArr.join(','), 'obs tids=', tidAgg.size, 'aborted=', JSON.stringify(abortedAt));

// ---- 补充：newlist 分区列表（ranking 被 -352 风控挡死时的实证替代入口）----
// 已知被 newlist 接受的 rid（本次会话实测 n>0），每个 rid 取前 3 页 × 50 条，收集 tid/tname。
const NEWLIST_RIDS = [1, 3, 4, 5, 11, 13, 23, 36, 119, 129, 155, 160, 167, 181, 188, 202, 211];
const newlistObs = [];
if (process.env.SKIP_NEWLIST !== '1') {
  const nb = new Bili({ rps: 1.6 });
  await nb.boot();
  for (const rid of NEWLIST_RIDS) {
    for (let pn = 1; pn <= 3; pn++) {
      let j = null;
      try {
        j = await nb.raw(`https://api.bilibili.com/x/web-interface/newlist?rid=${rid}&ps=50&pn=${pn}&type=0`, null, { signed: false, retry: 1, riskPause: 6000, riskRetry: false });
      } catch (e) { newlistObs.push({ rid, pn, code: 'err', n: 0 }); continue; }
      const arr = j?.data?.archives || [];
      newlistObs.push({ rid, pn, code: j?.code ?? null, n: arr.length });
      for (const v of arr) {
        if (!v.tid) continue;
        const key = Number(v.tid);
        if (!tidAgg.has(key)) tidAgg.set(key, { tid: key, tname: v.tname ?? null, rids: new Set(), n: 0, nlRids: new Set() });
        const e = tidAgg.get(key);
        e.n++;
        if (!e.tname && v.tname) e.tname = v.tname;
        if (!e.nlRids) e.nlRids = new Set();
        e.nlRids.add(rid);
      }
      await sleep(300);
    }
    console.log(`  newlist rid=${rid} done, tids=${tidAgg.size}`);
  }
}

// 补充：从已采 raw 里吃 search 的 typename/typeid（若已存在），作为 tid→tname 的实证补充
let rawTidPairs = 0;
for (const f of listShards('bili-meta')) {
  const txt = fs.readFileSync(path.join(RAW, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.tid && r.tname) {
      rawTidPairs++;
      const key = Number(r.tid);
      if (!tidAgg.has(key)) tidAgg.set(key, { tid: key, tname: r.tname, rids: new Set(), n: 0 });
      const e = tidAgg.get(key);
      e.n++;
      if (!e.tname) e.tname = r.tname;
    }
  }
}
console.log('raw tid/tname pairs=', rawTidPairs, 'tids total=', tidAgg.size);

const tids = [];
const parentMap = {};
for (const e of [...tidAgg.values()].sort((a, b2) => a.tid - b2.tid)) {
  const rids = [...e.rids];
  const nlRids = [...(e.nlRids || [])];
  tids.push({ tid: e.tid, tname: e.tname, ranking_rids: rids, newlist_rids: nlRids, count: e.n });
  // 归属判定：newlist 优先（分区新投稿列表天然属于该一级区），其次 ranking 唯一归属
  let parentRid = null, basis = null;
  if (nlRids.length === 1) { parentRid = nlRids[0]; basis = 'newlist 该一级 rid 的新投稿列表返回的 tid'; }
  else if (!nlRids.length && rids.length === 1) { parentRid = rids[0]; basis = 'ranking/v2 该 rid 榜单返回的视频 tid 唯一归属'; }
  if (parentRid != null && KNOWN_FIRST_LEVEL[parentRid]) {
    parentMap[e.tid] = { parent_rid: parentRid, parent_name: KNOWN_FIRST_LEVEL[parentRid], basis };
  }
}

const out = {
  generated_at: isoCST(),
  method: '对 rid 1..500 调 https://api.bilibili.com/x/web-interface/ranking/v2?rid=R&type=all，记录 code/n 与返回视频的 tid/tname；并用已采 raw 的 typeid/typename 补充 tid→二级名',
  probed_count: probed.length,
  probed_to_rid: probed.length ? probed[probed.length - 1].rid : 0,
  aborted: abortedAt,
  valid_rids: validRidsArr,
  ranking_rejected_rids: probed.filter((p) => p.code === -400).map((p) => p.rid),
  risk_blocked: probed.filter((p) => p.code === -352).map((p) => p.rid),
  empty_rids: probed.filter((p) => p.code === 0 && p.n === 0).map((p) => p.rid),
  tids,
  parent_map: parentMap,
  newlist_probe: newlistObs,
  known_first_level: KNOWN_FIRST_LEVEL,
  notes: [
    'ranking/v2 实际只接受少量一级 rid（本次 code=0 的见 valid_rids），其余返回 -400；-352 是风控不是 rid 无效。',
    '排名接口在本会话中途被 -352 风控挡死（rid≥17 起连续 -352），因此补了一次 newlist 分区列表探测作为实证替代；两者都只记录接口真实返回的 tid/tname。',
    'rid 参数是「榜单区/分区」，返回视频的 tid/tname 是视频自身二级分区；parent_map 只在归属唯一时建立。',
    'known_first_level 是已知对照（非接口返回），只用于给 rid 命名，未验证的 rid 一律不写。',
    abortedAt ? `ranking 探测在 rid=${abortedAt.rid} 提前中止（${abortedAt.reason}）；中止后的 rid 未探测，不做任何推断。` : 'rid 1..500 全部探测完毕。',
    'OBSERVED_OK 里的 rid 是本次会话早期对 1..200 逐位实测 code=0 的结果，作为已观测证据合并进 valid_rids。',
  ],
};
fs.writeFileSync(path.join(META, 'regions.json'), JSON.stringify(out, null, 1), 'utf8');
console.log('WROTE meta/regions.json valid_rids=', validRids.length, 'tids=', tids.length, 'parent_map=', Object.keys(parentMap).length);
