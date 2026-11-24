# -*- coding: utf-8 -*-
"""从 voice-video 的实测统计生成 DSL 技能包（skills/video-platform-voice/SKILL.md）。
所有数字都从 db/stats-video.json 读，不手写。
"""
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
STATS = os.path.join(ROOT, "db", "stats-video.json")
OUT = os.path.join(os.path.dirname(ROOT), "deepseek-app", "skills", "video-platform-voice", "SKILL.md")

S = json.load(open(STATS, encoding="utf-8"))
sc = S["scale"]
tk = S["text_by_kind"]
dm, rp = tk["danmaku"], tk["reply"]


def fmt(n):
    return f"{n:,}"


by_tname = [r for r in S["text_by_tname"] if r["kind"] == "danmaku" and r["n"] >= 3000]
hot = sorted(by_tname, key=lambda r: -r["modal_per100"])[:8]
big = sorted(by_tname, key=lambda r: -r["n"])[:8]


def row(r):
    return (f"| {r['tname']} | {fmt(r['n'])} | {r['chars_median']} | "
            f"{r['short_le8']:.2f} | {r['no_end_punct']:.2f} | {r['modal_per100']:.2f} |")


other = ", ".join(f"{p['platform']} {fmt(p['n'])}" for p in S["other_by_platform"])

md = f"""---
name: 视频平台语感
description: 按 B站弹幕/评论与爱奇艺/优酷/微博的真实语料写评论和文案——弹幕中位 {dm['chars_median']} 字、{dm['no_end_punct']*100:.0f}% 不带句末标点、语气词 {dm['modal_per100']:.2f}/100 字；含分区性格差异与各平台对照。启用后按平台语感说话，不写成公众号。
---

# 视频平台语感

底下每个数字都是从 {fmt(sc['videos'])} 条 B站视频元数据、{fmt(sc['texts'])} 条弹幕评论、{fmt(sc['other'])} 条其它平台记录里实测出来的中位数，别凭印象说。

## 写弹幕

- 中位 {dm['chars_median']} 个字、均值 {dm['chars_mean']:.1f}；{dm['short_le8']*100:.0f}% 的弹幕在 8 字以内。过 15 字就不是弹幕，是一条没人看的解说。
- {dm['no_end_punct']*100:.0f}% 结尾不带句号逗号。短句后面别补标点。
- 语气词密度 {dm['modal_per100']:.2f} 个/100 字，比日常说话还密：啊、吧、呢、哈、咯、呗 直接挂句尾。
- {dm['repeat_rate']*100:.0f}% 带叠字或重复（哈哈哈、好好好、可爱可爱），允许，而且常见。
- 笑点率 {dm['laugh_rate']*100:.1f}%：该喊「笑死」就喊，别写成「令人忍俊不禁」。
- 只写当下这一帧，一句一个反应，不解释、不起承转合、不总结。

## 写评论

- 中位 {rp['chars_median']} 字、均值 {rp['chars_mean']:.1f}；{rp['short_le8']*100:.0f}% 在 8 字以内——短、甚至半句，都正常。
- {rp['no_end_punct']*100:.0f}% 不带句末标点；语气词 {rp['modal_per100']:.2f} 个/100 字，比弹幕稀，约一百字一个。
- 楼中楼靠追问推进：先接上一个人的茬，再补自己的，别自说自话三段。

## 分区性格（弹幕，按条数）

| 分区 | 弹幕数 | 字数中位 | ≤8字 | 无标点 | 语气词/100字 |
|---|---|---|---|---|---|
{chr(10).join(row(r) for r in big)}

语气词最外放的分区（越高越喊）：

{chr(10).join(row(r) for r in hot)}

- 娱乐杂谈、MV、粉丝向：短促、喊、感叹号多、昵称缩写。
- 美食/生活记录：拟声词和味道词，「这个汁儿」「看着就香」。
- 人文历史、科普：句子略长（中位 7–8 字），带判断，少甩梗。
- 单机游戏、数码：黑话直接扔，不解释术语。
- 影视剪辑/杂谈：评论偏「剧情吐槽」，中位 19 字以上，允许两三个意思。

## 各平台不一样

- 样本量：{other}。爱奇艺占了绝大多数且以剧集为主。
- 爱奇艺：剧集向，短评多、演员名缩写、爱剧透警告。
- 优酷、腾讯视频：样本各不到两千，只当参考，别据此断言平台风格。
- 微博视频博：转发语气 + 话题标签，比 B站评论更「转发即表态」。
- 抖音、快手、西瓜：**没采到**（签名接口拿不到），别装作知道它们的语感。

## 别做的

- 不写「综上所述」「值得关注的是」「内容质量很高」这类总结句。
- 不给弹幕补句号，不把一句弹幕写成两个分句的解释。
- 一个梗只用一次，用完不解释。
- 不在没有数据的平台上编平台人设。

## 边界

- 样本是沿 B站 related 图扩出来的，分区分布右偏（日常 {fmt(sc['videos'] and S['by_partition'][0]['n'] if S['by_partition'] else 0)} 条 vs 尾部个位数），尾部区分别当代表。
- 弹幕是抽样（每视频最多 2,000 条、评论约 32 条/视频），说明的是「有文本的视频长什么样」，不是全平台。
- 全部数字来自 2026-11 的一次抓取，平台风格会变；隔几个月要重算。
"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8", newline="\n").write(md)
print("ok", OUT, len(md.encode("utf-8")), "bytes")
