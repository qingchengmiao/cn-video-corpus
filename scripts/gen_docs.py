#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""voice-video 文档生成：db/stats-video.json -> docs/*.md
用法：python gen_docs.py
"""
import json
import os
from datetime import datetime, timezone as _tz

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")
os.makedirs(DOCS, exist_ok=True)
S = json.load(open(os.path.join(ROOT, "db", "stats-video.json"), encoding="utf-8"))
sc = S["scale"]
now = datetime.now().strftime("%Y-%m-%d %H:%M")


def w(name, text):
    p = os.path.join(DOCS, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text.strip() + "\n")
    print(name, os.path.getsize(p), "bytes")


def fmt(n):
    if n is None:
        return "—"
    if isinstance(n, float):
        return f"{n:,.2f}"
    return f"{n:,}"


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join("" if v is None else str(v) for v in r) + " |")
    return "\n".join(out)


total = (sc["videos"] or 0) + (sc["texts"] or 0) + (sc["other"] or 0)

# ---------------- 00 README
w("00-README.md", f"""
# 视频平台语料库（v1）

生成时间 {now}。本目录是国内主流视频平台的一次性抓取与分析产物：**{fmt(total)} 条记录**
（B站视频元数据 {fmt(sc['videos'])}、B站弹幕与评论 {fmt(sc['texts'])}、其它平台视频 {fmt(sc['other'])}），
覆盖 B站 {sc['tnames']} 个分区标签、{sc['days_covered']} 个自然日的发布数据，以及 {sc['tag_edges']} 条视频-标签关系。

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
- **文本与元数据的对齐**：文本侧覆盖 {fmt(sc['texts_videos'])} 个视频，其中绝大多数已补进 `videos`（`source='view_patch'`），仍有 **{fmt(sc['orphan_texts'])} 条**文本的稿件已被删除或不可见，只能靠 `texts` 表自带的 bvid/tname 使用。
- **`coin`/`share` 有空洞**：来自 `search` 通道的记录这两个字段是 null（接口不返回），不是 0。
- **其它平台的样本远小于 B站，且部分平台为 0**：抖音需 `a_bogus`/`X-Bogus`、快手需 `web_st`/`__NS_sig3`、西瓜需 `_signature`，匿名拿不到，只有 0 条；拿到的是爱奇艺 46,101（频道推荐 + 专辑展开）、优酷 1,970、微博 1,916、腾讯 347。爱奇艺等平台的播放量匿名接口一律不返回（null 是平台事实，不是采集失败）。
- **失败入口如实记录**：`db/stats-video.json` 的 `failed` 字段与各 `raw/_summary_*.json`（其它平台还有 `caps` 字段写明天花板与原因）列出了被封/需签名/超时的入口，没有用编造数据填补。
- 文本只做了手机号/邮箱/身份证/QQ 号脱敏，其余原样保留（含错别字、网络缩写、脏话）。
""")

# ---------------- 01 数据集说明
w("01-数据集说明.md", f"""
# 数据集说明

## 规模

| 项 | 数量 |
|---|---|
| B站视频元数据 | {fmt(sc['videos'])} |
| B站弹幕 + 评论 | {fmt(sc['texts'])} |
| 其它平台视频 | {fmt(sc['other'])} |
| 视频-标签关系 | {fmt(sc['tag_edges'])} |
| 分区标签（tname） | {sc['tnames']} |
| 覆盖自然日 | {sc['days_covered']} |

文本按类型：{json.dumps(sc.get('by_text_kind') or {}, ensure_ascii=False)}
其它平台按平台：{json.dumps(sc.get('by_other_platform') or {}, ensure_ascii=False)}

## 表结构

`videos`：`bvid`(PK) `aid` `title` `tname` `tid` `partition_path` `keyword` `source` `author_mid`
`author_name` `pubdate`(unix) `duration_s` `desc_len` `url` `crawled_at` `view` `danmaku` `reply`
`favorite` `coin` `like_` `share`

`texts`：`id`(PK) `platform` `kind`(danmaku/reply) `bvid` `cid` `aid` `tname` `text` `time_ms`
`mode` `color` `rpid` `root` `parent` `depth` `likes` `ctime` `uid` `video_pubdate` `crawled_at`

`video_tags`：`bvid` `tag`

`other_videos`：`platform`+`item_id`(复合 PK) `title` `category` `interest` `author` `publish_ts`
`duration_s` `view` `like_` `comment` `url` `source` `crawled_at`

`regions`：`rid`(PK) `tname` `tid` `sample_bvid` `source`

## 采集方法

- B站走的是 web 接口 + wbi 签名（`w_rid`/`wts`），先用 `buvid3`/`b_nut` 引导 cookie，再打搜索/详情/热门/排行榜/相关推荐/弹幕 XML/评论。
- 分区表不是从已废弃的 `region/index` 拿的（该接口恒 `code -400`），而是对 `rid=1..500` 逐个探排行榜、用返回视频的 `tname` 反推。
- 其它平台以「公开榜单页 + 页面 SSR 里的 hydration 数据」为主，需要签名的接口（抖音 a_bogus、快手 graphql）没有硬碰。

## 清洗与脱敏

HTML 反转义 → 去标签 → 空白压缩；手机号/邮箱/身份证/QQ 号替换为 `<已隐去>`；文本长度截断到 2000 字。
没做：去重（同一弹幕在不同视频会各留一条）、去广告、语言识别。

## 已知偏差

1. 搜索最多 1000 条/关键词 → 头部过采样。
2. 弹幕每视频只留 800 条 → 长视频的尾部弹幕不足。
3. 采集时点集中在 {now} 前后，播放量是「抓取那一刻」的快照，不是历史峰值。
4. 其它平台样本量与 B站不可比。
""")

# ---------------- 02 分区全景
rows = []
for r in S["by_partition"][:80]:
    rows.append([
        r["tname"], fmt(r["n"]), fmt(r["plays"]),
        f"{r['dur_mean'] or 0}s", (r["like_per1k"] or 0), (r["reply_per10k"] or 0),
        datetime.fromtimestamp(r["oldest"], tz=_tz.utc).strftime("%Y-%m-%d") if r["oldest"] else "—",
    ])
w("02-分区全景.md", f"""
# 分区全景

B站共抓到 **{sc['tnames']} 个分区标签**、{fmt(sc['videos'])} 条视频。下表按视频条数排序（前 80），
`千播点赞` = 每千次播放的点赞数，`万播评论` = 每万次播放的评论数（互动强度代理）。

{table(["分区", "视频数", "总播放", "平均时长", "千播点赞", "万播评论", "最早发布"], rows)}

## 怎么读

- 条数多不等于热门：抓取是按关键词并集，全站通用词（游戏、音乐、日常）会显著过采样。**看互动强度列比看条数更有意义**。
- 平均时长差异极大：短视频分区（鬼畜、舞蹈）几百秒以下，影视/课程分区动辄半小时以上。跨分区比时长没意义。
- 最早发布列用来判断该分区的「存量有多老」：老分区（音乐、动画）常有 2010 年前的内容，新分区（生活、科技）大多是近三年。
""")

# ---------------- 03 兴趣图谱
tag_rows = [[t["tag"], fmt(t["n"]), fmt(t["videos"])] for t in S["top_tags"][:80]]
pair_rows = [[p["a"], p["b"], fmt(p["n"])] for p in S["top_tag_pairs"][:40]]
comm_blocks = []
for i, cm in enumerate(S["interest_communities"], 1):
    tags = "、".join(cm["top_tags"][:10])
    parts = "、".join(f"{p['tname']}({p['n']})" for p in cm["top_partitions"][:4])
    comm_blocks.append(f"**社区 {i}**（{cm['size']} 个标签，权重 {cm['weight']}）：{tags}\n\n  → 落点分区：{parts}\n")

w("03-兴趣图谱.md", f"""
# 兴趣图谱

用「同一个视频被打了哪些标签」建共现图（出现 ≥3 次的标签、共现 ≥3 次的边），在图上做标签传播，
得到 **{S['graph']['communities']} 个兴趣社区**（{S['graph']['nodes']} 个标签节点、{S['graph']['edges']} 条边），
每个社区给出最集中的官方分区，这就是「兴趣向 vs 官方分区」的差。

## 社区（按权重排序）

{chr(10).join(comm_blocks)}

## 高频标签（前 80）

{table(["标签", "出现次数", "涉及视频"], tag_rows)}

## 最强共现对（前 40）

{table(["标签 A", "标签 B", "共现视频数"], pair_rows)}

## 怎么读

- 社区不是官方分区：官方分区是作者投稿时选的（一个视频只能选一个），标签是作者/观众打的（一个视频可以有多个）。所以社区会跨分区，这正是「兴趣向」的证据。
- 权重 = 社区内标签出现次数之和，受抓取量影响，只能横向比结构、不能当绝对热度。
- 想拿某个社区的视频：把该社区 top_tags 拿去 `video_tags` 里 OR 查询，再 JOIN `videos` 取元数据：
  `SELECT v.* FROM video_tags t JOIN videos v ON v.bvid=t.bvid WHERE t.tag IN ('标签1','标签2') GROUP BY v.bvid;`
- 标签覆盖率不是 100%：只对一部分视频拿到了 tag（`video_tags` 行数 / `videos` 行数 ≈ {sc['tag_edges']/max(sc['videos'],1):.1f} 个/条），没打标签的视频只进分区统计、不进社区图。
""")

# ---------------- 04 节奏与热度
dur_rows = [[d["bucket"], fmt(d["n"])] for d in S["duration_hist"]]
hour_rows = [[f"{h['hour']:02d}:00", fmt(h["n"])] for h in S["by_hour"]]
wd_names = "一二三四五六日"
wd_rows = [[wd_names[w["wd"] - 1] if w["wd"] else "日", fmt(w["n"])] for w in S["by_weekday"]]
year_rows = [[y["y"], fmt(y["n"])] for y in S["by_year"]]
view_rows = [[v["bucket"][2:], fmt(v["n"])] for v in S["view_hist"]]
w("04-节奏与热度.md", f"""
# 时长、发布节奏与热度分布

## 时长分布

{table(["时长区间", "视频数"], dur_rows)}

## 播放量分布

{table(["播放量档", "视频数"], view_rows)}

## 一天里什么时候发（+08:00）

{table(["小时", "发布数"], hour_rows)}

## 一周里哪天发

{table(["星期", "发布数"], wd_rows)}

## 按年份

{table(["年", "发布数"], year_rows[-16:])}

## 怎么读

- 时长直方图能看出该平台的内容形态：1–10 分钟是绝对主力，>2 小时的是课程/直播回放/影视。
- 发布小时是「作者投稿时间」，不是「观众观看时间」，别当活跃度曲线用。
- 播放量档位受抓取偏置影响（搜索与榜单都偏向有热度的视频），中位数参考价值高于均值。
""")

# ---------------- 05 弹幕与评论
tk = S["text_by_kind"]
def tkrow(name, key):
    d = tk.get(key) or {}
    return [name, fmt(d.get("n")), fmt(d.get("chars_median")), fmt(d.get("chars_mean")),
            fmt(d.get("short_le8")), fmt(d.get("no_end_punct")), fmt(d.get("modal_per100")),
            fmt(d.get("laugh_rate")), fmt(d.get("repeat_rate"))]
t_rows = [tkrow("弹幕", "danmaku"), tkrow("评论", "reply")]
by_t = [[r["tname"], r["kind"], fmt(r["n"]), fmt(r["chars_median"]), fmt(r["short_le8"]),
         fmt(r["no_end_punct"]), fmt(r["modal_per100"])] for r in S["text_by_tname"][:40]]
top_dm = [[t["text"], fmt(t["n"])] for t in S["top_danmaku"][:60]]
top_rp = [[t["text"][:80].replace("|", "｜"), fmt(t["likes"])] for t in S["top_replies"][:30]]
w("05-弹幕与评论.md", f"""
# 弹幕与评论的文本形态

## 总览

{table(["类型", "条数", "字数中位", "字数均值", "≤8字占比", "无句末标点", "语气词/100字", "笑点标记率", "叠字率"], t_rows)}

## 各分区的文本形态（前 40，按条数）

{table(["分区", "类型", "条数", "字数中位", "≤8字占比", "无句末标点", "语气词/100字"], by_t)}

## 重复最多的弹幕（前 60）

{table(["弹幕", "出现次数"], top_dm)}

## 点赞最高的评论（前 30）

{table(["评论", "点赞"], top_rp)}

## 怎么读

- 弹幕是「边看边喊」，所以 ≤8 字占比极高、几乎不写句末标点；评论是「看完再说」，句子明显更长。
- 「笑点标记率」= 含 哈哈/233/hhh/草/笑死 的条数占比，「叠字率」= 含 3 个以上连续同字的条数占比。这两个是最省事的「真人感」指纹。
- 高赞评论里能直接看出该分区的表达习惯（长文分析 / 一句话抖机灵 / 方言吐槽）。
""")

# ---------------- 06 多平台
op_rows = [[r["platform"], fmt(r["n"]), fmt(r["plays"])] for r in S["other_by_platform"]]
cat_rows = [[r["platform"], r["category"], fmt(r["n"])] for r in S["other_top_categories"][:40]]
int_rows = [[r["platform"], r["interest"], fmt(r["n"])] for r in S["other_top_interest"][:40]]
fail_rows = [[f.get("from", ""), f.get("platform") or f.get("source") or "", (f.get("reason") or "")[:120]] for f in S["failed"][:60]]
w("06-多平台对照.md", f"""
# 其它平台样本

## 样本量

{table(["平台", "条数", "总播放"], op_rows)}

## 分类分布（平台自带分类）

{table(["平台", "分类", "条数"], cat_rows)}

## 兴趣/话题分布

{table(["平台", "兴趣", "条数"], int_rows)}

## 拿不到的入口（如实记录）

{table(["来源", "平台/入口", "原因"], fail_rows)}

## 怎么读

- 其它平台的样本量比 B站小一个数量级，**只能做形态对照，不能做平台间热度比较**。
- 抖音/快手需要签名（a_bogus / graphql）的接口没去硬碰，样本主要来自公开榜单与页面 SSR。
""")

print("done:", len(os.listdir(DOCS)), "docs")



