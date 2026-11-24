// mine_kuaishou.mjs —— 快手：Web GraphQL 匿名能过 schema 校验但业务数据为空；brilliant 页 SSR 只有 visionConfig 配置无视频。
// 本脚本只做「复查 + 如实记 failed」，不产出任何记录。
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, fetchText, extractJsLiteral, recordFailed, RAW_DIR } from './lib.mjs';

const PLATFORM = 'kuaishou';
const started = Date.now();
const probes = [];

const GQL = 'https://www.kuaishou.com/graphql';
const HDR = {
  'Content-Type': 'application/json',
  Referer: 'https://www.kuaishou.com/brilliant',
  Origin: 'https://www.kuaishou.com',
  Accept: '*/*',
};

// 1) brilliantTypeData（榜单流）
{
  const body = JSON.stringify({
    operationName: 'brilliantTypeData',
    variables: { hotChannelId: '1', page: 'brilliant', pcursor: '' },
    query:
      'query brilliantTypeData($hotChannelId: String, $page: String, $pcursor: String) { brilliantTypeData(hotChannelId: $hotChannelId, page: $page, pcursor: $pcursor) { feeds { type author { id name } photo { id caption duration } } pcursor } }',
  });
  const r = await fetchJson(GQL, { method: 'POST', headers: HDR, body });
  probes.push({
    api: 'graphql brilliantTypeData',
    status: r.status,
    feeds: r.json?.data?.brilliantTypeData?.feeds?.length ?? null,
    raw: (r.text || '').slice(0, 200),
  });
}
// 2) visionHotRank（热榜）
{
  const body = JSON.stringify({
    operationName: 'visionHotRank',
    variables: { page: 'home' },
    query: 'query visionHotRank($page: String) { visionHotRank(page: $page) { result } }',
  });
  const r = await fetchJson(GQL, { method: 'POST', headers: HDR, body });
  probes.push({ api: 'graphql visionHotRank', status: r.status, raw: (r.text || '').slice(0, 220) });
}
// 3) brilliant 页 SSR
{
  const r = await fetchText('https://www.kuaishou.com/brilliant', { headers: { Referer: 'https://www.kuaishou.com/', Accept: 'text/html' } });
  const st = extractJsLiteral(r.text || '', 'window.__APOLLO_STATE__');
  const keys = st ? Object.keys(st.defaultClient || {}) : [];
  probes.push({
    page: 'https://www.kuaishou.com/brilliant',
    status: r.status,
    len: r.len,
    has_APOLLO_STATE: !!st,
    apollo_keys: keys.slice(0, 5),
    photo_refs: (r.text || '').match(/"#photo\.[^"]*"/g)?.length || 0,
  });
}

const reason =
  `POST https://www.kuaishou.com/graphql 匿名可过 schema 校验（未报签名错），但 brilliantTypeData(hotChannelId:"1",page:"brilliant",pcursor:"") 返回 ` +
  `{"data":{"brilliantTypeData":{"feeds":[],"pcursor":null}}}（空数组）；` +
  `visionHotRank 只返回配置/聚合词；` +
  `https://www.kuaishou.com/brilliant 页面 SSR 的 window.__APOLLO_STATE__ 解析后只有 $ROOT_QUERY.visionConfig 配置，无 #photo/#caption 视频对象；` +
  `https://live.kuaishou.com/ 页面 105KB 无 SSR 数据。需登录 cookie（kuaishou.server.web_st）与签名（__NS_sig3/sig）才能取到 feeds。`;
recordFailed(PLATFORM, 'kuaishou.com/graphql + /brilliant + live.kuaishou.com', reason);
const out = { name: PLATFORM, records: 0, files: [], failed: [{ platform: PLATFORM, source: 'kuaishou 全部公开入口', reason }], probes, elapsed_s: Math.round((Date.now() - started) / 1000) };
fs.writeFileSync(path.join(RAW_DIR, '_run_kuaishou.json'), JSON.stringify(out, null, 2));
console.log('DONE kuaishou (no records, failed recorded)', JSON.stringify(probes, null, 1));
