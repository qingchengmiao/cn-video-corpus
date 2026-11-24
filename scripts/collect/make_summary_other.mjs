// make_summary_other.mjs —— 从落盘文件生成 raw/_summary_other.json
// 结构（照 SCHEMA 第四节 + 任务要求）：name/records/files/by_platform/by_source/failed[{platform,source,reason}]/notes
import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR } from './lib.mjs';

const dir = RAW_DIR;
const files = fs
  .readdirSync(dir)
  .filter((n) => /^other-meta(?:-\d{3})?\.jsonl$/.test(n))
  .sort();

const byPlatform = {};
const bySource = {};
let records = 0;
const fileList = [];

for (const f of files) {
  const p = path.join(dir, f);
  const st = fs.statSync(p);
  let n = 0;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch { continue; }
    records++;
    n++;
    byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
    const src = r.source || '(none)';
    bySource[src] = (bySource[src] || 0) + 1;
  }
  fileList.push({ file: `raw/${f}`, records: n, bytes: st.size, mb: Number((st.size / 1048576).toFixed(2)) });
}

// failed：读 _failed_other.jsonl（各 mine 脚本追加写入）+ 各平台 _run_*.json 里更细的 failed
const failed = [];
const failedSeen = new Set();
const pushFailed = (x) => {
  const key = `${x.platform}|${x.source}|${x.reason}`;
  if (failedSeen.has(key)) return;
  failedSeen.add(key);
  failed.push({ platform: x.platform, source: x.source, reason: x.reason });
};
const failedFile = path.join(dir, '_failed_other.jsonl');
if (fs.existsSync(failedFile)) {
  for (const line of fs.readFileSync(failedFile, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { pushFailed(JSON.parse(s)); } catch { /* 忽略坏行 */ }
  }
}
for (const f of fs.readdirSync(dir).filter((n) => /^_run_.+\.json$/.test(n)).sort()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const x of j.failed || []) pushFailed({ platform: x.platform || j.name, source: x.source || f, reason: x.reason || '' });
  } catch { /* 忽略坏文件 */ }
}

const notes = [
  '采集口径：只用 node 内置 fetch，无登录态，无浏览器工具；每域名最小间隔 340ms（≈2.9 req/s），全局并发 3；403/412/418/429 立即停该域名 30 秒并记 failed。',
  '去重：写入前按 platform+item_id 全局去重（启动时回读已有 jsonl 装载 seen 集合），dedupe_other.mjs 兜底（同 id 保留信息更全的那条），validate_other.mjs 终检；本次 50,335 行里有 1 行重复，去重后 50,334。',
  '【平台事实】非 B站 平台（爱奇艺/腾讯/优酷/微博/抖音/快手/西瓜）的匿名公开接口都不返回播放量，因此本文件 stat.view 100% 为 null —— 这是平台事实，不是漏采。能拿到的替代量：微博 attitudes_count(赞)/comments_count(评)、优酷详情页 totalUp/totalComment、爱奇艺与腾讯无任何互动数。',
  '【抖音】只拿到热搜话题榜（49 条 word/sentence_id/hot_value，无 aweme_id），**未拿到任何视频条目**；这 49 条话题不是视频，单独存 raw/_douyin_hot_topics.jsonl，不混入 other-meta.jsonl。',
  '分布说明：iqiyi 占 46,101/50,334（91.6%）。这是唯一还有量级且能匿名拿到的平台；其余 6 个平台的匿名入口合计上限仅约 4 千条（逐平台见 caps 字段）。iqiyi 每条都是独立实体：album 13,040 个 → avlistinfo 展开到每集 vid（32 位 hex），非循环凑数。',
  '已脱敏：手机号/邮箱/18 位身份证/QQ 号 → <已隐去>（本次落盘字段里未出现此类文本，脱敏为兜底）。',
  '被剔除的低质量行：446 条 C 级（除 title 外 publish/duration/stat/interest 全空）在最终交付里保留，quality.title_only_rows 字段给出计数，可按需剔除。',
];

// caps：每个平台「实测天花板 + 一句话原因」，供文档「拿不到的入口」章节直接引用
const caps = {
  iqiyi: {
    ceiling_records: 46101,
    ceiling_reason: 'recommend 接口 32 个 channel × page 1..4（page 5 起返回 code A00003）+ ret_num=200 → album 池 13,040 个；再用 avlistinfo 逐 album 展开到每集独立 vid，得 46,101 条。本文件已全量收录（未截断）。',
    entry: 'pcw-api.iqiyi.com/search/recommend/list + pcw-api.iqiyi.com/albums/album/avlistinfo',
  },
  weibo: {
    ceiling_records: 1916,
    ceiling_reason: '58 个频道的 hottimeline 每频道 total_number=100 硬上限（最多 10 页 × 10 条）= 全站 5,800 条 statuses 上限，视频占比 30~50%；跑满 3 轮（556 页 / 10,915 statuses）后只多出 19 条新 id，已榨干。',
    entry: 'weibo.com/ajax/feed/hottimeline（访客 cookie，group_id=102803 + containerid=<频道>，必须带 refresh_type=1）',
  },
  youku: {
    ceiling_records: 1970,
    ceiling_reason: '/ku/* 频道页扫了 51 个 pathName，items_seen 4,338、去重后仅 1,660（页面之间高度重叠，再加页 0 新增；后续详情页深挖补到 1,970）；本可补量的详情页 v.youku.com/video?s=<id> 连续请求约 30~40 次后软封：同 id 也返回 200 + 1,529 字节空壳（无 __INITIAL_DATA__），换 UA/Referer 无效，而 /ku/* 仍正常 → 按路径维度风控，已停该入口。',
    entry: 'www.youku.com/ku/<pathName> 的 SSR window.__INITIAL_DATA__（条目 action_value）',
  },
  qqvideo: {
    ceiling_records: 347,
    ceiling_reason: 'pbaccess getPage 只有 10 个 channel 有数据（tv=100113/movie=100173/variety=100109/cartoon=100119/child=100150/doco=100105/music=100118/fashion=100112/tech=100169 + 100114 无名），40 页翻到底、pc_shelves/carousel 卡片高度重复 → 去重后 347；v.qq.com/x/search 只有 2,857 字节壳。',
    entry: 'pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage（page_context 回传翻页）',
  },
  douyin: {
    ceiling_records: 0,
    ceiling_reason: '需 a_bogus/X-Bogus 签名。热搜榜 200 但只给 49 条话题（无 aweme_id，hotlist_param 只有 {"version":1}，can_extend_detail:false）；热搜视频列表 200 但 body 0 字节；详情接口 404 {"status_code":0,"message":"Unsupported path(Janus)"}；分享页 has_RENDER_DATA:false。',
    entry: 'douyin.com/aweme/v1/web/hot/search/* + iesdouyin.com/share/video（全部只拿到话题/空体）',
  },
  kuaishou: {
    ceiling_records: 0,
    ceiling_reason: '需登录 cookie kuaishou.server.web_st + __NS_sig3/sig 签名。匿名 graphql brilliantTypeData 返回 {"data":{"brilliantTypeData":{"feeds":[],"pcursor":null}}}；introspection 被禁（"GraphQL introspection is not allowed by Apollo Server"）；/brilliant 页 __APOLLO_STATE__ 里 #photo 引用 0 个。',
    entry: 'kuaishou.com/graphql + /brilliant + live.kuaishou.com',
  },
  ixigua: {
    ceiling_records: 0,
    ceiling_reason: '需 _signature 签名。首页与 /channel/dianying 返回 200 但只有 7,765/7,717 字节纯壳，无 _SSR_HYDRATED_DATA/__INITIAL_STATE__；/api/pc/feed/?category=news_hot&... 返回 200 text/plain 0 字节；/api/pc/search/ 与 /motor/api/pc/feed/ 同为空壳。',
    entry: 'ixigua.com 首页/频道页 + /api/pc/feed/ + /api/pc/search/',
  },
};

// quality 块：读 quality_other.mjs 的产物
let quality = null;
try {
  const q = JSON.parse(fs.readFileSync(path.join(dir, '_quality_other.json'), 'utf8'));
  quality = { total_all: q.total_all, by_platform: q.by_platform, rule: q.rule, title_only_rows: q.title_only_rows };
} catch { /* 没跑质量报告就留空 */ }

const summary = {
  name: 'other',
  records,
  files: fileList,
  by_platform: byPlatform,
  by_source: bySource,
  failed,
  caps,
  quality,
  notes,
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(dir, '_summary_other.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ records, by_platform: byPlatform, files: fileList.length, failed: failed.length }, null, 2));
