# 数据来源与抓取记录

抓取时间：2026-11-24（北京时间）。全部为公开页面/接口，未登录、未绕过付费墙、未使用任何账号 cookie。

## 总量

| 来源 | 数量 | 说明 |
|---|---|---|
| B站 · 视频元数据 | 601,044 | 唯一 bvid，132 个分区标签 |
| B站 · 弹幕 | 300,000 | 581 个视频，按时间均匀抽样 |
| B站 · 评论 | 70,269 | 2,180 个视频（含楼中楼一层） |
| 爱奇艺 | 46,101 | 13,040 个 album 展开的每集 |
| 优酷 | 1,970 | 频道列表页 SSR 数据 |
| 微博 | 1,916 | 视频类热点流 |
| 腾讯视频 | 347 | 10 个频道有数据 |
| **合计** | **1,021,647** | |

## B站

**主引擎**：`https://api.bilibili.com/x/web-interface/archive/related?bvid=<BV>`。一次 40 条，每个条目自带 `bvid/title/tname/tid/desc/pubdate/duration/owner/stat/cid`，等于「邻居图 + 元数据」二合一。从一个种子集合出发做 BFS，邻居重叠导致去重率稳定在 64%，42,161 次请求、103 分钟捞到 60 万条唯一稿件。

**辅助通道**：`ranking/v2`（只接受 rid {0,1,3,4,5,11,23,36,129}）、`popular`（只到第 5 页）、`search/type`（存量 2,591 条）、`newlist`（775 条）。

**弹幕**：`https://comment.bilibili.com/<cid>.xml`（XML，`<d p="时间,模式,字号,颜色,时间戳池,用户哈希,行号">文本</d>`）。原计划用的 `x/v1/dm/list.so` 匿名已 412。每视频按时间均匀抽上限 2,000 条。

**评论**：`x/v2/reply/wbi/main?type=1&oid=<aid>&mode=1|3`（每 mode 3 条顶楼）+ 楼中楼首页，匿名额度约 32 条/视频。

### 试过但拿不到的（如实记录，不是没试）

| 入口 | 结果 |
|---|---|
| `x/web-interface/wbi/search/type` | IP 级 412，返回 3,286 字节风控 HTML；换 cookie、换 UA、等 10 分钟均无效。未签名的 `/search/type` 同样 412 |
| `x/web-interface/newlist` | 412（带 wbi 也 412） |
| `x/web-interface/dynamic/region` | `-404`，接口已下线 |
| `x/space/wbi/arc/search` | `-352` 风控 |
| `x/tag/archive/tags` | `-400` |
| `ranking/v2?rid=<子分区 tid>` | `-400`，只吃少数大区 rid |
| `x/v1/dm/list.so?oid=<cid>` | 412 |
| 单个稿件 `BV19QX7Y1Eu2` | `62012` 稿件不可见 |

## 其它平台

| 平台 | 入口 | 结果 / 天花板 |
|---|---|---|
| 爱奇艺 | `pcw-api.iqiyi.com/search/recommend/list?channel_id=1..32&page_id=1..4&ret_num=200` + `albums/album/avlistinfo` 展开每集 | 46,101 条。**播放量/点赞/评论恒为 null**——匿名接口不返回，是平台事实 |
| 优酷 | `www.youku.com/ku/<pathName>` SSR 里的 `__INITIAL_DATA__` | 1,970 条。详情页请求 30–40 次后软封：HTTP 200 但返回 1,529 字节空壳 |
| 微博 | `weibo.com/ajax/feed/hottimeline`（先 `passport.weibo.com/visitor` 的 genvisitor + incarnate 拿 SUB/SUBP cookie） | 1,916 条。58 个频道 × `total_number=100` 是硬上限 |
| 腾讯视频 | `pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage` | 347 条。只有 10 个 channel 有数据 |
| 抖音 | `aweme/v1/web/hot/search/list`、`iesdouyin.com/share/video/<id>` | **0 条视频**。参数需 `a_bogus`/`X-Bogus` 签名：视频列表接口返回 200 但 body 0 字节；详情接口 `404 {"message":"Unsupported path(Janus)"}`；分享页与详情页均为纯 CSR 壳（无 `RENDER_DATA`/`_ROUTER_DATA`）。只拿到 49 条热搜话题（`raw/_douyin_hot_topics.jsonl`），**没有**混进视频表 |
| 快手 | `window.__APOLLO_STATE__` / `brilliantTypeData` | **0 条**。需 `web_st` + `__NS_sig3`，未签名请求返回 `{"feeds":[],"pcursor":null}` |
| 西瓜视频 | 首页 `_SSR_HYDRATED_DATA` / `api/pc/feed/` | **0 条**。需 `_signature`，首页只回 7,765 字节纯壳 |

## 合规与限速

- 请求速率 ≤ 8 次/秒、并发 ≤ 4；遇到 412/429 退避 30 秒，重试全部成功，没有死循环。
- 不调用登录态接口、不使用账号 cookie、不破解签名/验证码。
- 文本脱敏：手机号 → `<手机号>`，邮箱 → `<邮箱>`，身份证 → `<身份证>`，QQ 号 → `<QQ>`。
- 只存标题、分区、时长、公开互动计数与弹幕/评论文本；不存简介原文（只存长度），不存用户主页。
- 用途限定：语言学与内容分析、语感建模、教学与研究。请勿用于对个人画像、跟踪或自动化决策。
