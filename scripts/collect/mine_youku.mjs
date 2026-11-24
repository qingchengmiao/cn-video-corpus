// mine_youku.mjs —— 优酷：各频道 SSR 页 window.__INITIAL_DATA__ 里的推荐位条目
// 入口：https://www.youku.com/ku/<pathName>（webhome/webtv/webmovie/...）与 /ku/webchart
import fs from 'node:fs';
import path from 'node:path';
import { Sink, fetchText, makeRecord, extractJsLiteral, recordFailed, RAW_DIR } from './lib.mjs';

const PAGES = [
  ['webhome', '首页'], ['webchart', '榜单'], ['webtv', '电视剧'], ['webmovie', '电影'],
  ['webvariety', '综艺'], ['webcomic', '动漫'], ['webtv', '电视剧2'], ['webduanju', '短剧'],
  ['webchild', '少儿'], ['webdocumentary', '纪录片'], ['aijingpinpc', 'AI专区'], ['tiyu', '体育'],
  ['webculture', '人文'], ['webgame', '游戏'], ['lexue', '乐学'], ['webknowledge', '新知'],
  ['new', '新片'], ['health', '健康'], ['juhaokan', '剧好看'],
  // 追加候选频道（页面存在即采，去重挡重复）
  ['weblive', '直播'], ['playcenter2', '页游中心'], ['webgongyi', '公益'], ['webwza', '无障碍'],
  ['webyule', '娱乐'], ['webdianying', '电影2'], ['webzongyi', '综艺2'], ['webanime', '动漫2'],
  ['webjunshi', '军事'], ['webkeji', '科技'], ['webcaijing', '财经'], ['webqiche', '汽车'],
  ['webmeishi', '美食'], ['webgaoxiao', '搞笑'], ['weblvyou', '旅游'], ['webyinyue', '音乐'],
  ['weblishi', '历史'], ['webmeizhuang', '美妆'], ['webjiankang', '健康2'], ['webmengchong', '萌宠'],
  ['webjiaju', '家居'], ['webdushi', '都市'], ['webrank', '排行'], ['webhot', '热播'],
  ['pc_movie', '电影频道'], ['pc_tv', '电视剧频道'], ['pc_variety', '综艺频道'], ['pc_cartoon', '动漫频道'],
  ['pc_child', '少儿频道'], ['pc_doco', '纪录片频道'], ['pc_zongyi', '综艺频道2'],
  ['20261119greatworkwsdhxpc', '回响'],
];

const sink = new Sink({ dir: RAW_DIR });
const failed = [];
const stats = { pages: 0, items_seen: 0 };
const started = Date.now();

const TAGS_DROP = new Set(['限免中', 'VIP', '独播', '会员', '免费', '热播', '新片', '预告', '花絮']);
const TAG_NOISE = /^(限免|VIP|独播|会员|免费|热播|更新至|全\d+集|共\d+集|\d+集|付费)/;
// 首页/榜单页的条目没有频道上下文，用条目自带的标签当 category 更准
const GENERIC_PAGE = new Set(['首页', '榜单']);

for (const [pn, pageName] of PAGES) {
  const url = `https://www.youku.com/ku/${pn}`;
  const r = await fetchText(url, { headers: { Referer: 'https://www.youku.com/', Accept: 'text/html,application/xhtml+xml' } });
  stats.pages++;
  if (r.err) { failed.push({ platform: 'youku', source: url, reason: r.err }); continue; }
  if (r.status !== 200 || !r.text) {
    failed.push({ platform: 'youku', source: url, reason: `status=${r.status} len=${r.len}` });
    continue;
  }
  if (r.text.length < 20000) {
    failed.push({ platform: 'youku', source: url, reason: `疑似被风控：status=${r.status} 但 body 仅 ${r.len} 字节` });
    continue;
  }
  const data = extractJsLiteral(r.text, 'window.__INITIAL_DATA__');
  if (!data) { failed.push({ platform: 'youku', source: url, reason: '页面无 window.__INITIAL_DATA__ 或解析失败' }); continue; }
  let added = 0;
  for (const mod of data.moduleList || []) {
    for (const comp of mod.components || []) {
      for (const it of comp.itemList || []) {
        if (!it || it.rawAdData || it.isYkAd) continue;
        const showId = it.action_value || it.action?.value;
        if (!showId || !it.title) continue;
        stats.items_seen++;
        const tagTitles = [...new Set(
          (it.tags || [])
            .map((t) => t?.text?.title)
            .filter((x) => typeof x === 'string' && x.trim() && !TAGS_DROP.has(x.trim()) && !TAG_NOISE.test(x.trim())),
        )];
        const category = GENERIC_PAGE.has(pageName) ? (tagTitles[0] || null) : pageName;
        const interests = tagTitles.filter((t) => t !== category);
        const rec = makeRecord({
          platform: 'youku',
          item_id: showId,
          title: it.title,
          category,
          interest: interests.length ? interests.slice(0, 8) : null,
          author: null,
          publish_ts: null,
          duration_s: null,
          stat: { view: null, like: null, comment: null },
          url: `https://www.youku.com/show_page/id_${showId}.html`,
          source: `youku:/ku/${pn}`,
        });
        if (sink.add(rec)) added++;
      }
    }
  }
  console.log(`  [youku] /ku/${pn} items=${stats.items_seen} +${added} 累计=${sink.count}`);
}

await sink.close();
const out = {
  name: 'youku', records: sink.count, files: sink.files, dups: sink.dups, rejected: sink.rejected,
  by_platform: sink.byPlatform, by_source: sink.bySource, stats, failed,
  elapsed_s: Math.round((Date.now() - started) / 1000),
};
fs.writeFileSync(path.join(RAW_DIR, '_run_youku.json'), JSON.stringify(out, null, 2));
for (const f of failed) recordFailed(f.platform, f.source, f.reason);
console.log('DONE youku', JSON.stringify({ records: out.records, stats, elapsed: out.elapsed_s }));
