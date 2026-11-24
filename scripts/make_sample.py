#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从全量库分层抽样出一个能进 Git 的小库（db/sample.sqlite）。

分层规则：按 tname 分层，每层按 sqrt(n) 分配名额（既不让大分区垄断，也保证小分区有样本），
每层至少 min_per 条、全库上限 max_total 条；抽样时按 view 排序取头部 + 尾部，避免只拿爆款。
文本侧只保留被选中视频的弹幕/评论（每视频上限 texts_per_video 条）。

用法：
    python scripts/make_sample.py                        # 默认 ~20,000 视频
    python scripts/make_sample.py --max-videos 30000 --out db/sample.sqlite
"""
import argparse
import os
import shutil
import sqlite3
from math import sqrt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "db", "video-corpus.sqlite")
DST = os.path.join(ROOT, "db", "sample.sqlite")
SCHEMA = os.path.join(ROOT, "db", "schema.sql")


def pick(src, max_videos, min_per, texts_per_video):
    cur = src.cursor()
    cur.execute("SELECT tname, COUNT(*) FROM videos GROUP BY tname ORDER BY 2 DESC")
    layers = cur.fetchall()
    total = sum(n for _, n in layers) or 1
    quota = {}
    for tname, n in layers:
        q = max(min_per, round(max_videos * sqrt(n) / sum(sqrt(x) for _, x in layers)))
        quota[tname] = min(q, n, max_videos)
    # 按配额收缩到 max_videos 以内
    while sum(quota.values()) > max_videos:
        biggest = max(quota, key=lambda k: quota[k] - min_per)
        if quota[biggest] <= min_per:
            break
        quota[biggest] -= max(1, quota[biggest] // 100)

    picked = []
    for tname, q in quota.items():
        if q <= 0:
            continue
        head = max(1, int(q * 0.6))
        tail = q - head
        cur.execute(
            "SELECT bvid FROM videos WHERE tname=? ORDER BY COALESCE(view,0) DESC LIMIT ?",
            (tname, head),
        )
        picked += [r[0] for r in cur.fetchall()]
        if tail > 0:
            # 中位数附近取（视图量 1.5 万–3 万区间，能用 idx_v_view，不去排序 ABS）
            cur.execute(
                "SELECT bvid FROM videos WHERE tname=? AND view BETWEEN 15000 AND 30000 "
                "ORDER BY view DESC LIMIT ?",
                (tname, tail),
            )
            picked += [r[0] for r in cur.fetchall()]
    picked = sorted(set(picked))[:max_videos]
    print(f"选中视频 {len(picked)} 条，覆盖 {len(quota)} 个分区")
    return picked


def build(picked, texts_per_video, other_max=8000):
    if os.path.exists(DST):
        os.remove(DST)
    src = sqlite3.connect(SRC)
    dst = sqlite3.connect(DST)
    with open(SCHEMA, encoding="utf-8") as f:
        dst.executescript(f.read())

    src.row_factory = sqlite3.Row
    sc = src.cursor()
    dc = dst.cursor()
    keep = set(picked)

    # videos + video_tags
    src.row_factory = None
    keep_list = sorted(keep)
    for i in range(0, len(keep_list), 800):
        chunk = keep_list[i:i + 800]
        sc.execute("SELECT * FROM videos WHERE bvid IN (%s)" % ",".join("?" * len(chunk)), chunk)
        rows = sc.fetchall()
        cols = [d[0] for d in sc.description]
        dc.executemany(f"INSERT OR IGNORE INTO videos({','.join(cols)}) VALUES({','.join('?'*len(cols))})", rows)
    for i in range(0, len(keep_list), 400):
        chunk = keep_list[i:i + 400]
        sc.execute("SELECT bvid, tag FROM video_tags WHERE bvid IN (%s)" % ",".join("?" * len(chunk)), chunk)
        dc.executemany("INSERT OR IGNORE INTO video_tags(bvid, tag) VALUES(?,?)", sc.fetchall())

    # texts：一条 SQL 抓全（比逐视频查快一个数量级），再在内存里按视频限流
    for kind in ("danmaku", "reply"):
        n = 0
        for i in range(0, len(keep_list), 800):
            chunk = keep_list[i:i + 800]
            sc.execute(
                "SELECT * FROM texts WHERE kind=? AND bvid IN (%s) ORDER BY %s"
                % (",".join("?" * len(chunk)), "bvid, time_ms" if kind == "danmaku" else "bvid, likes DESC"),
                [kind] + chunk,
            )
            tcols = [d[0] for d in sc.description]
            bucket = {}
            for r in sc.fetchall():
                b = r[3]  # bvid 列位置
                if len(bucket.setdefault(b, [])) < texts_per_video:
                    bucket[b].append(tuple(r))
            flat = [row for rows_ in bucket.values() for row in rows_]
            if flat:
                dc.executemany(
                    f"INSERT OR IGNORE INTO texts({','.join(tcols)}) VALUES({','.join('?'*len(tcols))})", flat)
                n += len(flat)
        print(f"  {kind}: {n} 条")

    # 附属表整表搬（很小）
    for table in ("other_videos", "regions", "meta"):
        if table == "other_videos" and other_max:
            sc.execute("SELECT * FROM other_videos ORDER BY RANDOM() LIMIT ?", (other_max,))
        else:
            sc.execute(f"SELECT * FROM {table}")
        rows = sc.fetchall()
        if not rows:
            continue
        tcols = [d[0] for d in sc.description]
        dc.executemany(
            f"INSERT OR IGNORE INTO {table}({','.join(tcols)}) VALUES({','.join('?'*len(tcols))})",
            [tuple(r) for r in rows],
        )
        print(f"  {table}: {len(rows)} 条")

    dc.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)",
               ("sample_note", "分层抽样：按 tname 用 sqrt(n) 配额，60% 头部 + 40% 播放量近 2 万区间；文本每视频限流"))
    dst.commit()
    # FTS 重建
    for fts in ("video_fts", "text_fts"):
        try:
            dc.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
        except sqlite3.OperationalError:
            pass
    dst.isolation_level = None
    dst.execute("VACUUM")
    dst.isolation_level = ""
    dst.commit()
    src.close()
    dst.close()


def main():
    global DST, SRC
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-videos", type=int, default=20000)
    ap.add_argument("--min-per", type=int, default=5)
    ap.add_argument("--texts-per-video", type=int, default=60)
    ap.add_argument("--src", default=SRC, help="全量库路径")
    ap.add_argument("--other-max", type=int, default=8000, help="other_videos 抽样上限，0=全量")
    ap.add_argument("--out", default=DST)
    a = ap.parse_args()
    SRC = os.path.abspath(a.src)
    DST = os.path.abspath(a.out)
    if not os.path.exists(SRC):
        raise SystemExit(f"没有找到全量库：{SRC}（先从 Release 下载 video-corpus.sqlite 放到 db/）")
    picked = pick(sqlite3.connect(SRC), a.max_videos, a.min_per, a.texts_per_video)
    build(picked, a.texts_per_video, a.other_max)
    size = os.path.getsize(DST) / 1024 / 1024
    con = sqlite3.connect(DST)
    c = con.cursor()
    stat = {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in ("videos", "video_tags", "texts", "other_videos", "regions")}
    con.close()
    print(f"完成：{DST}  {size:.1f} MB  {stat}")


if __name__ == "__main__":
    main()



