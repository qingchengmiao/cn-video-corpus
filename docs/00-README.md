# 视频平台语料库（v1）

生成时间 2026-11-24 06:41。本目录是国内主流视频平台的一次性抓取与分析产物：**1,021,647 条记录**
（B站视频元数据 601,044、B站弹幕与评论 370,269、其它平台视频 50,334），
覆盖 B站 132 个分区标签、5179 个自然日的发布数据，以及 442598 条视频-标签关系。

## 有什么

| 文件 | 内容 |
|---|---|
| `db/video-corpus.sqlite` | 主数据库。`videos` 视频元数据、`texts` 弹幕/评论、`video_tags` 标签、`other_videos` 其它平台、`regions` 分区表；含 `video_fts`/`text_fts` 两个全文索引 |
| `db/stats-video.json` | 全部分析结果的机读版（本文档所有数字都从它来） |
| `db/schema.sql` | 建库语句（想自己导入别的工具时用） |
| `raw/*.jsonl` | 原始采集数据，一行一条，未做任何改写（只脱敏） |
| `raw/_summary_*.json` | 每个采集器的规模与失败清单 |
| `meta/regions.json`、`meta/keywords.json` | 分区表与关键词池（复跑抓取时用） |
| `docs/01…06` | 按主题写的分析文档 |

## 怎么查

```sql
-- 某分区播放最高的 20 条
SELECT title, author_name, view FROM videos WHERE tname='游戏' ORDER BY view DESC LIMIT 20;
-- 某视频的全部弹幕（按时间）
SELECT time_ms, text FROM texts WHERE bvid='BV1xx' AND kind='danmaku' ORDER BY time_ms;
-- 全文搜索标题
SELECT title FROM video_fts WHERE video_fts MATCH '原神';
-- 标签共现最强的组合
SELECT a.tag, b.tag, COUNT(*) n FROM video_tags a JOIN video_tags b ON a.bvid=b.bvid AND a.tag<b.tag
GROUP BY 1,2 ORDER BY n DESC LIMIT 20;
```

## 口径与边界（重要）

- **样本不是均衡抽的**：B站搜索接口（`wbi/search/type`、未签名 `search/type`、`newlist`）对本机 IP 全部返回 412，可用主引擎是 `archive/related`（每条视频的邻居圈，一次 40 条）。所以 60 万条是**沿相关视频图做 BFS 扩出来的**，优先补「已采条数最少的分区」，能逼近分区广度但**分布明显右偏**：日常 66,354、影视剪辑 39,777、综合 29,531 在前，尾部「电影」只有 1 条、「番剧资讯」2 条。别把它当 B站的均衡样本。
- **不是全量**：B站视频总量以千万计，60 万条是在「搜索全封、只有 related 可走」的条件下能捞到的上限（邻居重叠导致去重率稳定在 64%，越采越稀，80 万不现实）。
- **标签只覆盖一小部分**：`video_tags` 来自 45,044 条富化记录（4.7 万视频有 tag，442,598 条视频-标签关系）。`videos.tags=[]` 是**没采**，不是「没有标签」。
- **弹幕是抽样**：每个视频按时间均匀抽，上限 2,000 条；30 万弹幕来自 581 个视频。评论受匿名额度限制，每视频约 32 条（顶楼 6 + 楼中楼首页 20）。所以文本统计反映的是「有文本的视频长什么样」，不是全平台弹幕/评论。
- **文本与元数据的对齐**：文本侧覆盖 2,183 个视频，其中绝大多数已补进 `videos`（`source='view_patch'`），仍有 **862 条**文本的稿件已被删除或不可见，只能靠 `texts` 表自带的 bvid/tname 使用。
- **`coin`/`share` 有空洞**：来自 `search` 通道的记录这两个字段是 null（接口不返回），不是 0。
- **其它平台的样本远小于 B站，且部分平台为 0**：抖音需 `a_bogus`/`X-Bogus`、快手需 `web_st`/`__NS_sig3`、西瓜需 `_signature`，匿名拿不到，只有 0 条；拿到的是爱奇艺 46,101（频道推荐 + 专辑展开）、优酷 1,970、微博 1,916、腾讯 347。爱奇艺等平台的播放量匿名接口一律不返回（null 是平台事实，不是采集失败）。
- **失败入口如实记录**：`db/stats-video.json` 的 `failed` 字段与各 `raw/_summary_*.json`（其它平台还有 `caps` 字段写明天花板与原因）列出了被封/需签名/超时的入口，没有用编造数据填补。
- 文本只做了手机号/邮箱/身份证/QQ 号脱敏，其余原样保留（含错别字、网络缩写、脏话）。
