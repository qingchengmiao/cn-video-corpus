// mine_weibo.mjs —— 微博视频：访客 cookie + 频道 hottimeline 翻页，只取带 page_info(object_type=video) 的微博
// 入口：https://weibo.com/ajax/feed/allGroups（拿频道 containerid）
//       https://weibo.com/ajax/feed/hottimeline?group_id=102803&containerid=<频道>（注意：group_id 固定 102803，频道靠 containerid 区分）
import fs from 'node:fs';
import path from 'node:path';
import { Sink, fetchJson, fetchText, makeRecord, recordFailed, RAW_DIR, sleep } from './lib.mjs';

const MAX_PAGES_PER_CH = Number(process.env.WB_MAX_PAGES || 12);
const sink = new Sink({ dir: RAW_DIR });
const failed = [];
const stats = { channels_tried: 0, channels_ok: 0, pages: 0, statuses: 0, with_page_info: 0, video: 0 };
const started = Date.now();

const FP = JSON.stringify({ os: '1', browser: 'Chrome131,131,0,0', fonts: 'undefined', screenInfo: '1920*1080*24', plugins: '' });

// ---- 1) 访客 cookie ----
let cookie = '';
{
  const gv = await fetchText('https://passport.weibo.com/visitor/genvisitor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://passport.weibo.com/visitor/visitor', Accept: '*/*' },
    body: 'cb=gen_callback&fp=' + encodeURIComponent(FP),
  });
  const tid = (gv.text || '').match(/"tid":"([^"]+)"/)?.[1];
  const jar = [];
  const take = (res) => { for (const c of res.headers?.getSetCookie?.() || []) { const kv = c.split(';')[0]; if (/^(SUB|SUBP|SVB|SRT|SRF)=/.test(kv)) jar.push(kv); } };
  take(gv);
  if (!tid) {
    failed.push({ platform: 'weibo', source: 'passport.weibo.com/visitor/genvisitor', reason: `未拿到 tid：status=${gv.status} body=${(gv.text || '').slice(0, 160)}` });
  } else {
    await sleep(500);
    const inc = await fetchText(
      `https://passport.weibo.com/visitor/visitor?a=incarnate&t=${tid}&w=2&c=095&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
      { headers: { Referer: 'https://weibo.com/', Accept: '*/*' } },
    );
    take(inc);
    if (!jar.some((x) => x.startsWith('SUB='))) {
      failed.push({ platform: 'weibo', source: 'passport.weibo.com/visitor/visitor?a=incarnate', reason: `未拿到 SUB：status=${inc.status} body=${(inc.text || '').slice(0, 160)}` });
    }
  }
  cookie = jar.join('; ');
  console.log(`  [weibo] 访客 cookie 字段=${jar.length} ${cookie ? 'ok' : '空'}`);
}

const HDR = {
  Referer: 'https://weibo.com/',
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
  ...(cookie ? { Cookie: cookie } : {}),
};

// ---- 2) 频道列表 ----
let channels = [];
{
  const r = await fetchJson('https://weibo.com/ajax/feed/allGroups?is_new_segment=1&fetch_hot=1', { headers: HDR });
  if (r.json?.ok === 1) {
    for (const grp of r.json.groups || []) {
      for (const item of grp.group || []) {
        if (item.containerid && /^102803_/.test(item.containerid)) channels.push({ title: item.title, containerid: item.containerid });
      }
    }
  } else {
    failed.push({ platform: 'weibo', source: 'weibo.com/ajax/feed/allGroups', reason: `ok=${r.json?.ok} status=${r.status}` });
  }
  if (!channels.length) channels = [{ title: '热门', containerid: '102803' }];
  console.log(`  [weibo] 频道数=${channels.length}`);
}

// ---- 3) 逐频道翻页 ----
const HASH_RE = /#([^#\s]{1,30})#/g;
const parseSid = (v) => {
  if (v && typeof v === 'object' && v.since_id) return String(v.since_id);
  if (typeof v === 'string' && v) { try { const o = JSON.parse(v); if (o?.since_id) return String(o.since_id); } catch { /* not json */ } }
  return null;
};

for (const ch of channels) {
  stats.channels_tried++;
  let sinceId = '0';
  const seenSid = new Set();
  let addedHere = 0;
  const cid = ch.containerid;
  for (let page = 1; page <= MAX_PAGES_PER_CH; page++) {
    const url =
      `https://weibo.com/ajax/feed/hottimeline?since_id=${sinceId}&refresh=0&group_id=102803` +
      `&containerid=${encodeURIComponent(cid)}&extparam=discover%3A%3A0&refresh_type=1`;
    const r = await fetchJson(url, { headers: HDR });
    stats.pages++;
    if (r.err) { failed.push({ platform: 'weibo', source: `hottimeline:${cid}`, reason: r.err }); break; }
    if (!r.json) {
      failed.push({ platform: 'weibo', source: `hottimeline:${cid}`, reason: `非 JSON：status=${r.status} body=${(r.text || '').slice(0, 160)}` });
      break;
    }
    if (r.json.ok !== 1) {
      failed.push({ platform: 'weibo', source: `hottimeline:${cid}`, reason: `ok=${r.json.ok} message=${r.json.message || r.json.msg || ''} status=${r.status}` });
      break;
    }
    const list = r.json.statuses || [];
    if (!list.length) break;
    stats.statuses += list.length;
    for (const s of list) {
      const pi = s.page_info;
      if (!pi) continue;
      stats.with_page_info++;
      if (!(pi.object_type === 'video' || pi.media_info)) continue;
      stats.video++;
      const text = s.text_raw || s.text || '';
      const tags = [...new Set([...String(text).matchAll(HASH_RE)].map((m) => m[1].trim()).filter(Boolean))].slice(0, 8);
      const title =
        pi.page_title ||
        pi.media_info?.name ||
        (s.title && String(s.title).trim()) ||
        String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
      const rec = makeRecord({
        platform: 'weibo',
        item_id: pi.object_id || s.mid || s.idstr,
        title,
        category: ch.title || null,
        interest: tags.length ? tags : null,
        author: s.user?.screen_name || null,
        publish_ts: s.created_at,
        duration_s: pi.media_info?.duration ?? null,
        stat: {
          view: pi.play_count ?? null,
          like: s.attitudes_count ?? null,
          comment: s.comments_count ?? null,
        },
        url: pi.h5_url || pi.media_info?.h5_url || (s.mid ? `https://m.weibo.cn/detail/${s.mid}` : null),
        source: `weibo:hottimeline:${ch.title}`,
      });
      if (sink.add(rec)) addedHere++;
    }
    const next = parseSid(r.json.since_id);
    if (!next || seenSid.has(next) || next === sinceId) break;
    seenSid.add(next);
    sinceId = next;
  }
  if (addedHere > 0) stats.channels_ok++;
  console.log(`  [weibo] ${ch.title} +${addedHere} 累计=${sink.count}`);
}

await sink.close();
const out = {
  name: 'weibo', records: sink.count, files: sink.files, dups: sink.dups, rejected: sink.rejected,
  by_platform: sink.byPlatform, by_source: sink.bySource, stats, failed,
  elapsed_s: Math.round((Date.now() - started) / 1000),
};
fs.writeFileSync(path.join(RAW_DIR, '_run_weibo.json'), JSON.stringify(out, null, 2));
for (const f of failed) recordFailed(f.platform, f.source, f.reason);
console.log('DONE weibo', JSON.stringify({ records: out.records, stats, elapsed: out.elapsed_s }));
