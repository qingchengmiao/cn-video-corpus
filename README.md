# 中文视频平台语料库 · 102 万条

2026-11 抓的一次性真实语料 + 分析方法 + 直接可用的「视频平台语感」技能包。

**1,021,647 条记录**：B站视频元数据 601,044、B站弹幕与评论 370,269（弹幕 300,000 / 评论 70,269）、其它平台 50,334（爱奇艺 46,101 / 优酷 1,970 / 微博 1,916 / 腾讯视频 347）。覆盖 132 个分区标签、5,179 个自然日、442,598 条视频-标签关系。

数据库是一份 SQLite（`db/video-corpus.sqlite`，361.9 MB，带 FTS5 全文索引），下载地址见本页 Release 附件；仓库里另附一份**抽样库** `db/sample.sqlite`（约 2 万条，克隆下来就能跑通所有查询）。

## 有什么

| 路径 | 内容 |
|---|---|
| `db/video-corpus.sqlite` | 全量库（Release 附件，需单独下载） |
| `db/sample.sqlite` | 抽样库，结构与全量一致 |
| `db/schema.sql` | 建库语句 |
| `db/stats-video.json` | 全部分析结果机读版（文档里的数字都从它来） |
| `docs/` | 10 篇分析文档：数据说明、分区全景、兴趣图谱、节奏热度、弹幕评论、多平台对照、**分析方法**、**数据字典**、原始格式 |
| `SKILL.md` | 技能包：把语料里量出来的语感变成可执行的写作参数（也可放 `skills/<id>/SKILL.md` 给 DSH / DeepSeek Local 直接用） |
| `scripts/build_db.py` | 从 `raw/*.jsonl` 建库（18 秒全量） |
| `scripts/analyze.py` | 出 `stats-video.json`（分区、标签图、文本形态、失败入口） |
| `scripts/gen_docs.py` | 从 stats 生成 `docs/01…06` |
| `scripts/gen_skill.py` | 从 stats 生成技能包（数字不手写） |
| `scripts/collect/` | 采集器：B站 related 图 BFS、弹幕评论、多平台 |
| `scripts/make_sample.py` | 分层抽样生成 sample.sqlite |
| `scripts/export_formats.py` | 导出 CSV / JSONL，方便进 pandas、DuckDB、Excel |
| `DATA-SOURCES.md` | 来源、抓取时间、各入口实测结果、拿不到的部分与原因 |

## 怎么查

```sql
-- 某分区播放最高的 20 条
SELECT title, author_name, view FROM videos WHERE tname='单机游戏' ORDER BY view DESC LIMIT 20;

-- 某视频的全部弹幕（按出现时间）
SELECT time_ms, text FROM texts WHERE bvid='BV1xx411c7mD' AND kind='danmaku' ORDER BY time_ms;

-- 标题全文搜索
SELECT title FROM video_fts WHERE video_fts MATCH '原神';

-- 标签共现最强的组合
SELECT a.tag, b.tag, COUNT(*) n FROM video_tags a JOIN video_tags b ON a.bvid=b.bvid AND a.tag<b.tag
GROUP BY 1,2 ORDER BY n DESC LIMIT 20;

-- 每个分区的弹幕字数中位数（节奏分析的最小单元）
SELECT tname, COUNT(*) n FROM texts WHERE kind='danmaku' GROUP BY 1 ORDER BY n DESC LIMIT 20;

-- 弹幕/评论原文全文搜索
SELECT bvid, text FROM text_fts WHERE text_fts MATCH '笑死' LIMIT 10;
```

Python：

```python
import sqlite3, pandas as pd
con = sqlite3.connect('db/sample.sqlite')
df = pd.read_sql('SELECT tname, view, like_ FROM videos WHERE view > 10000', con)
```

## 几个实测量的关键数（都在 `docs/` 里展开）

- **弹幕**中位 6 字、均值 9.4，62.6% 在 8 字以内，78.5% 不带句末标点，语气词 3.04/100 字，叠字 7.4%，笑点标记 3.3%。
- **评论**中位 19 字、均值 29.5，22.5% 在 8 字以内，语气词 1.02/100 字。
- **分区差异**：语气词密度从娱乐杂谈 6.90 到动漫杂谈 1.43，差近 5 倍；美食类中位 4 字，人文历史中位 8 字。
- **兴趣图谱**：标签共现图上做标签传播，19,221 个节点、314,023 条边、116 个兴趣社区，每簇都能落到具体分区。
- **热度**：播放量中位 81,205，千播点赞 36.1，万播评论 19.2。

## 口径与边界（先读这段再引用数字）

1. **不是均衡样本**：B站搜索接口（`wbi/search/type`、`newlist`）对本机 IP 全部 412，主引擎只能走 `archive/related` 的邻居图做 BFS。所以分布右偏——日常 66,354 条、影视剪辑 39,777 条在前，尾部「电影」1 条、「番剧资讯」2 条。**能看分区里的构成，不能当全站比例。**
2. **不是全量**：B站视频以千万计，60 万是「搜索全封 + 只有 related」条件下能捞到的上限（邻居重叠，去重率稳定 64%）。
3. **标签只覆盖 4.7 万视频**：`videos` 里没有 `tag` 字段，标签在 `video_tags`；主表记录 `source != 'view_patch'` 时多数没采标签，**「没采」不等于「没标签」**。
4. **文本是抽样**：弹幕每视频按时间均匀抽、上限 2,000 条（30 万条来自 581 个视频）；评论受匿名额度限制，每视频约 32 条。统计的是「有文本的视频长什么样」。
5. **抖音 / 快手 / 西瓜 0 条**：需要 `a_bogus`、`__NS_sig3`、`_signature`，匿名拿不到，`DATA-SOURCES.md` 里写了试过哪些入口、返什么。
6. **爱奇艺等平台播放量为 null**：匿名接口不返回，是平台事实。
7. 文本只脱敏了手机号、邮箱、身份证、QQ 号，其余原样（含错别字、缩写、脏话）。

## 数据来源与用途

来源见 `DATA-SOURCES.md`。抓取遵守限速（≤8 请求/秒、并发 ≤4）、412/429 退避 30 秒、不绕过任何登录或付费墙。**数据仅供研究与学习**（语言学分析、语感建模、内容研究），不含用户可识别信息，别用于对个人画像、跟踪或任何自动化决策。

## 复现

```bash
# 1. 采集（需要自己机器有出口，B站对数据中心 IP 风控很严）
node scripts/collect/mine_graph.mjs        # B站元数据：related 图 BFS
node scripts/collect/mine_text.mjs         # 弹幕 + 评论
node scripts/collect/mine_iqiyi.mjs        # 多平台

# 2. 建库与分析
python scripts/build_db.py
python scripts/analyze.py
python scripts/gen_docs.py
python scripts/gen_skill.py

# 3. 抽样 & 导出
python scripts/make_sample.py
python scripts/export_formats.py --excel
```

依赖：Python 3.11+（仅标准库 + pandas/openpyxl 用于导出）、Node 20+（采集器只用内置 `fetch`）。

## 许可

代码 MIT（见 `LICENSE`）。语料为各平台公开内容的分析用快照，版权归原作者与平台；引用请注明来源与本仓库。
