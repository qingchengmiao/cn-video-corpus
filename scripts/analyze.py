#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""voice-video 分析：db/video-corpus.sqlite -> db/stats-video.json
用法：python analyze.py
"""
import json
import math
import os
import re
import sqlite3
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "db", "video-corpus.sqlite")
OUT = os.path.join(ROOT, "db", "stats-video.json")

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()


def q(sql, args=()):
    return c.execute(sql, args).fetchall()


def one(sql, args=()):
    r = c.execute(sql, args).fetchone()
    return r[0] if r else None


S = {}

# ---------- 规模
S["scale"] = {
    "videos": one("SELECT COUNT(*) FROM videos"),
    "texts": one("SELECT COUNT(*) FROM texts"),
    "other": one("SELECT COUNT(*) FROM other_videos"),
    "tag_edges": one("SELECT COUNT(*) FROM video_tags"),
    "regions": one("SELECT COUNT(*) FROM regions"),
    "tnames": one("SELECT COUNT(DISTINCT tname) FROM videos"),
    "days_covered": one("SELECT COUNT(DISTINCT date(pubdate,'unixepoch','+8 hours')) FROM videos WHERE pubdate>0"),
    "orphan_texts": one("SELECT COUNT(*) FROM texts t LEFT JOIN videos v ON v.bvid=t.bvid WHERE v.bvid IS NULL"),
    "tagged_videos": one("SELECT COUNT(DISTINCT bvid) FROM video_tags"),
    "texts_videos": one("SELECT COUNT(DISTINCT bvid) FROM texts"),
}

# ---------- 分区全景
S["by_partition"] = [
    dict(r) for r in q("""
    SELECT tname, COUNT(*) n, SUM(view) plays,
           CAST(AVG(duration_s) AS INT) dur_mean,
           CAST(AVG(like_ * 1.0 / NULLIF(view,0)) * 1000 AS INT) like_per1k,
           CAST(AVG(reply * 1.0 / NULLIF(view,0)) * 10000 AS INT) reply_per10k,
           MIN(pubdate) oldest, MAX(pubdate) newest
    FROM videos WHERE tname IS NOT NULL
    GROUP BY tname ORDER BY n DESC""")
]

# ---------- 兴趣向：标签
S["top_tags"] = [
    dict(r) for r in q("""
    SELECT tag, COUNT(*) n, COUNT(DISTINCT bvid) videos FROM video_tags
    GROUP BY tag ORDER BY n DESC LIMIT 200""")
]

# 标签共现（只统计出现 >=3 次的标签，取 top 对）
trows = q("""
SELECT v.tname AS tname, t.tag AS tag, t.bvid AS bvid FROM video_tags t
JOIN videos v ON v.bvid=t.bvid""")
tag_count = Counter()
by_bvid = defaultdict(list)
by_tname_tags = defaultdict(Counter)
for r in trows:
    tag_count[r["tag"]] += 1
    by_bvid[r["bvid"]].append(r["tag"])
    if r["tname"]:
        by_tname_tags[r["tname"]][r["tag"]] += 1
keep = {t for t, n in tag_count.items() if n >= 3}
pairs = Counter()
for bvid, tags in by_bvid.items():
    tags = sorted({t for t in tags if t in keep})
    for i in range(len(tags)):
        for j in range(i + 1, len(tags)):
            pairs[(tags[i], tags[j])] += 1
S["top_tag_pairs"] = [{"a": a, "b": b, "n": n} for (a, b), n in pairs.most_common(120)]

# ---------- 兴趣图谱：标签图上的标签传播社区
adj = defaultdict(Counter)
for (a, b), n in pairs.items():
    if n < 3:
        continue
    adj[a][b] += n
    adj[b][a] += n
nodes = sorted(adj, key=lambda t: -tag_count[t])
label = {t: t for t in nodes}
order = sorted(nodes, key=lambda t: -tag_count[t])
for _ in range(6):
    changed = 0
    for t in order:
        if not adj[t]:
            continue
        w = Counter()
        for nb, wt in adj[t].items():
            w[label[nb]] += wt
        if not w:
            continue
        best = w.most_common(1)[0][0]
        if best != label[t]:
            label[t] = best
            changed += 1
    if changed == 0:
        break
comm = defaultdict(list)
for t in nodes:
    comm[label[t]].append(t)
communities = []
for root, members in comm.items():
    if len(members) < 3:
        continue
    members.sort(key=lambda t: -tag_count[t])
    total = sum(tag_count[t] for t in members)
    # 该社区最集中的分区
    tnames = Counter()
    mset = set(members)
    for tn, cnt in by_tname_tags.items():
        hit = sum(cnt[t] for t in mset if t in cnt)
        if hit:
            tnames[tn] += hit
    communities.append({
        "size": len(members),
        "weight": total,
        "top_tags": members[:12],
        "top_partitions": [{"tname": k, "n": v} for k, v in tnames.most_common(6)],
    })
communities.sort(key=lambda x: -x["weight"])
S["interest_communities"] = communities[:20]
S["graph"] = {
    "nodes": len(nodes),
    "edges": sum(1 for (a, b), n in pairs.items() if n >= 3),
    "communities": len(communities),
}

# ---------- 兴趣图谱（标题词版本）：标签在匿名接口下拿不到多少，改用标题 n-gram 共现
CJK = re.compile(r"[\u4e00-\u9fff]+")
STOP = set("视频 一个 什么 我们 你们 他们 这个 那个 怎么 为什么 可以 就是 还是 没有 不是 真的 自己 "
           "今天 现在 然后 但是 因为 所以 如果 已经 时候 感觉 看看 大家 非常 有点 一直 第一 第二 "
           "最后一 起来 出来 知道 觉得 喜欢 分享 推荐 教程 合集 全集 高清 完整版 中文".split())
titles = [r[0] for r in q("SELECT title FROM videos WHERE title IS NOT NULL AND length(title)>=4")]
if len(titles) > 200000:
    titles = titles[:200000]
tok_freq = Counter()
per_title = []
for t in titles:
    toks = []
    for run in CJK.findall(t):
        for n in (2, 3, 4):
            for i in range(0, max(0, len(run) - n + 1)):
                w = run[i:i + n]
                if w in STOP:
                    continue
                toks.append(w)
    # 去掉被更长 token 完全包含的短 token（同一标题内去冗余）
    toks = list(dict.fromkeys(toks))
    keep_long = set()
    for w in toks:
        if len(w) >= 3:
            keep_long.add(w)
    toks = [w for w in toks if len(w) >= 3 or not any(w in l for l in keep_long)]
    toks = toks[:10]
    per_title.append(toks)
    tok_freq.update(toks)
good = {w for w, n in tok_freq.items() if n >= 80}
tp = Counter()
for toks in per_title:
    ts = sorted({w for w in toks if w in good})
    for i in range(len(ts)):
        for j in range(i + 1, len(ts)):
            tp[(ts[i], ts[j])] += 1
tadj = defaultdict(Counter)
for (a, b), n in tp.items():
    if n < 8:
        continue
    tadj[a][b] += n
    tadj[b][a] += n
tnodes = sorted(tadj, key=lambda t: -tok_freq[t])[:4000]
tlabel = {t: t for t in tnodes}
for _ in range(6):
    changed = 0
    for t in tnodes:
        w = Counter()
        for nb, wt in tadj[t].items():
            if nb in tlabel:
                w[tlabel[nb]] += wt
        if not w:
            continue
        best = w.most_common(1)[0][0]
        if best != tlabel[t]:
            tlabel[t] = best
            changed += 1
    if changed == 0:
        break
tcomm = defaultdict(list)
for t in tnodes:
    tcomm[tlabel[t]].append(t)
tcomms = []
for root, members in tcomm.items():
    if len(members) < 4:
        continue
    members.sort(key=lambda t: -tok_freq[t])
    tcomms.append({
        "size": len(members),
        "weight": sum(tok_freq[t] for t in members),
        "top_words": members[:14],
    })
tcomms.sort(key=lambda x: -x["weight"])
S["title_communities"] = tcomms[:20]
S["title_graph"] = {
    "titles": len(titles),
    "tokens": len(good),
    "nodes": len(tnodes),
    "edges": sum(1 for (a, b), n in tp.items() if n >= 8),
    "communities": len(tcomms),
}

# ---------- 时长 / 播放 / 发布节奏
dur = q("SELECT duration_s FROM videos WHERE duration_s>0")
buckets = [0, 15, 60, 180, 600, 1800, 3600, 7200, 10 ** 9]
labels = ["≤15s", "15–60s", "1–3min", "3–10min", "10–30min", "30–60min", "1–2h", ">2h"]
hist = [0] * (len(buckets) - 1)
for r in dur:
    d = r[0]
    for i in range(len(buckets) - 1):
        if buckets[i] <= d < buckets[i + 1]:
            hist[i] += 1
            break
S["duration_hist"] = [{"bucket": labels[i], "n": hist[i]} for i in range(len(hist))]

S["by_hour"] = [dict(r) for r in q("""
SELECT CAST(strftime('%H', pubdate, 'unixepoch', '+8 hours') AS INT) hour, COUNT(*) n
FROM videos WHERE pubdate>0 GROUP BY hour ORDER BY hour""")]
S["by_weekday"] = [dict(r) for r in q("""
SELECT CAST(strftime('%w', pubdate, 'unixepoch', '+8 hours') AS INT) wd, COUNT(*) n
FROM videos WHERE pubdate>0 GROUP BY wd ORDER BY wd""")]
S["by_year"] = [dict(r) for r in q("""
SELECT CAST(strftime('%Y', pubdate, 'unixepoch', '+8 hours') AS INT) y, COUNT(*) n
FROM videos WHERE pubdate>0 GROUP BY y ORDER BY y""")]

S["view_hist"] = [dict(r) for r in q("""
SELECT CASE
  WHEN view < 1000 THEN 'a <1k'
  WHEN view < 10000 THEN 'b 1k-10k'
  WHEN view < 100000 THEN 'c 10k-100k'
  WHEN view < 1000000 THEN 'd 100k-1M'
  WHEN view < 10000000 THEN 'e 1M-10M'
  ELSE 'f >10M' END bucket, COUNT(*) n
FROM videos WHERE view IS NOT NULL GROUP BY bucket ORDER BY bucket""")]

S["engagement"] = {"median_play": one("SELECT view FROM videos WHERE view>0 ORDER BY view LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM videos WHERE view>0)")}

# ---------- 文本语感（弹幕 vs 评论）
MODAL = re.compile(r"[啊吧呢呗嘛咯哦噢呀哈嘿嗯诶欸啦嘞咯嘛]")
LAUGH = re.compile(r"(哈{2,}|233+|hhh+|草{1,}|笑死|笑不活)")
PUNCT = re.compile(r"[。！？!?…~～]")
SPLIT = re.compile(r"[。！？!?；;\n]+")
REPEAT = re.compile(r"(.)\1{2,}")

def text_stats(rows):
    n = len(rows)
    if not n:
        return {}
    lens = []
    modals = 0
    laughs = 0
    short = 0
    nosent = 0
    repeats = 0
    chars = 0
    for (t,) in rows:
        if not t:
            continue
        L = len(t)
        lens.append(L)
        chars += L
        modals += len(MODAL.findall(t))
        if LAUGH.search(t):
            laughs += 1
        if REPEAT.search(t):
            repeats += 1
        if L <= 8:
            short += 1
        if not PUNCT.search(t) or PUNCT.findall(t)[-1:] == []:
            nosent += 1
    lens.sort()
    med = lens[len(lens) // 2] if lens else 0
    return {
        "n": n, "chars_mean": round(chars / max(n, 1), 1), "chars_median": med,
        "short_le8": round(short / n, 3), "no_end_punct": round(nosent / n, 3),
        "modal_per100": round(modals / max(chars, 1) * 100, 2),
        "laugh_rate": round(laughs / n, 4), "repeat_rate": round(repeats / n, 4),
    }

S["text_by_kind"] = {}
for kind in ("danmaku", "reply"):
    S["text_by_kind"][kind] = text_stats(q("SELECT text FROM texts WHERE kind=?", (kind,)))
S["text_by_tname"] = []
for r in q("SELECT tname, kind, COUNT(*) n FROM texts WHERE tname IS NOT NULL GROUP BY tname, kind ORDER BY n DESC LIMIT 60"):
    rows = q("SELECT text FROM texts WHERE tname=? AND kind=?", (r["tname"], r["kind"]))
    st = text_stats(rows)
    st.update({"tname": r["tname"], "kind": r["kind"]})
    S["text_by_tname"].append(st)

S["top_danmaku"] = [dict(r) for r in q("""
SELECT text, COUNT(*) n FROM texts WHERE kind='danmaku' AND length(text) BETWEEN 2 AND 30
GROUP BY text ORDER BY n DESC LIMIT 100""")]
S["top_replies"] = [dict(r) for r in q("""
SELECT text, likes FROM texts WHERE kind='reply' AND likes IS NOT NULL AND length(text)>1
ORDER BY likes DESC LIMIT 50""")]

# ---------- 其它平台
S["other_by_platform"] = [dict(r) for r in q("""
SELECT platform, COUNT(*) n, SUM(view) plays FROM other_videos GROUP BY platform ORDER BY n DESC""")]
S["other_top_interest"] = [dict(r) for r in q("""
SELECT platform, interest, COUNT(*) n FROM other_videos WHERE interest IS NOT NULL AND interest<>''
GROUP BY platform, interest ORDER BY n DESC LIMIT 80""")]
S["other_top_categories"] = [dict(r) for r in q("""
SELECT platform, category, COUNT(*) n FROM other_videos WHERE category IS NOT NULL AND category<>''
GROUP BY platform, category ORDER BY n DESC LIMIT 60""")]

# ---------- 收录摘要里的 failed
failed = []
for p in sorted(os.listdir(os.path.join(ROOT, "raw"))):
    if p.startswith("_summary") and p.endswith(".json"):
        try:
            d = json.load(open(os.path.join(ROOT, "raw", p), encoding="utf-8"))
        except Exception:
            continue
        for f in (d.get("failed") or [])[:200]:
            if isinstance(f, dict):
                failed.append({"from": p, **{k: f.get(k) for k in ("platform", "source", "reason", "entry") if k in f}})
            else:
                failed.append({"from": p, "reason": str(f)[:200]})
S["failed"] = failed[:300]

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(S, f, ensure_ascii=False, indent=1)
print("stats ->", OUT, os.path.getsize(OUT), "bytes")
print(json.dumps(S["scale"], ensure_ascii=False))
print("partitions:", len(S["by_partition"]), "| communities:", len(S["interest_communities"]), S["graph"])
print("text:", json.dumps(S["text_by_kind"], ensure_ascii=False))

