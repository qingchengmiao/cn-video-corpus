#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""voice-video 数据入库：raw/*.jsonl -> db/video-corpus.sqlite
用法：python build_db.py
改为分批 INSERT（不把百万行塞进内存字典），耗时与内存都可控。
"""
import glob
import html
import json
import os
import re
import sqlite3
import time
from collections import Counter

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "raw")
DB = os.path.join(ROOT, "db", "video-corpus.sqlite")
os.makedirs(os.path.dirname(DB), exist_ok=True)

PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
MAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
QQ = re.compile(r"(?<!\d)[1-9]\d{4,10}(?!\d)")
IDC = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
TAG_RE = re.compile(r"<[^>]{1,80}>")


def clean(text):
    if not text:
        return ""
    t = html.unescape(str(text))
    t = TAG_RE.sub("", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = MAIL.sub("<已隐去>", t)
    t = IDC.sub("<已隐去>", t)
    t = PHONE.sub("<已隐去>", t)
    t = QQ.sub("<已隐去>", t)
    return t


def jsons(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def num(v):
    try:
        if v is None or v == "":
            return None
        return int(float(v))
    except Exception:
        return None


def flush(cur, sql, rows):
    if rows:
        cur.executemany(sql, rows)
    return 0


con = sqlite3.connect(DB)
con.executescript(
    """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=OFF;
DROP TABLE IF EXISTS videos; DROP TABLE IF EXISTS video_tags; DROP TABLE IF EXISTS texts;
DROP TABLE IF EXISTS other_videos; DROP TABLE IF EXISTS regions; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS video_fts; DROP TABLE IF EXISTS text_fts;DROP INDEX IF EXISTS idx_v_tname; DROP INDEX IF EXISTS idx_v_view; DROP INDEX IF EXISTS idx_v_pub; DROP INDEX IF EXISTS idx_t_bvid; DROP INDEX IF EXISTS idx_t_kind; DROP INDEX IF EXISTS idx_t_tname; DROP INDEX IF EXISTS idx_tag_tag; DROP INDEX IF EXISTS idx_o_plat;
CREATE TABLE videos(
  bvid TEXT PRIMARY KEY, aid INTEGER, title TEXT, tname TEXT, tid INTEGER, partition_path TEXT,
  keyword TEXT, source TEXT, author_mid INTEGER, author_name TEXT, pubdate INTEGER, duration_s INTEGER,
  desc_len INTEGER, url TEXT, crawled_at TEXT, view INTEGER, danmaku INTEGER, reply INTEGER,
  favorite INTEGER, coin INTEGER, like_ INTEGER, share INTEGER, cid INTEGER);
CREATE TABLE video_tags(bvid TEXT, tag TEXT);
CREATE TABLE texts(
  id INTEGER PRIMARY KEY, platform TEXT, kind TEXT, bvid TEXT, cid INTEGER, aid INTEGER, tname TEXT,
  text TEXT, time_ms INTEGER, mode INTEGER, color INTEGER, rpid INTEGER, root INTEGER, parent INTEGER,
  depth INTEGER, likes INTEGER, ctime INTEGER, uid INTEGER, video_pubdate INTEGER, crawled_at TEXT);
CREATE TABLE other_videos(
  platform TEXT, item_id TEXT, title TEXT, category TEXT, interest TEXT, author TEXT, publish_ts INTEGER,
  duration_s INTEGER, view INTEGER, like_ INTEGER, comment INTEGER, url TEXT, source TEXT, crawled_at TEXT,
  PRIMARY KEY(platform, item_id));
CREATE TABLE regions(rid INTEGER PRIMARY KEY, tname TEXT, tid INTEGER, sample_bvid TEXT, source TEXT);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
"""
)
cur = con.cursor()

# ---------- 1. 分区表
n_reg = 0
for p in glob.glob(os.path.join(ROOT, "meta", "regions.json")):
    try:
        data = json.load(open(p, encoding="utf-8"))
    except Exception:
        continue
    rows = []
    if isinstance(data, dict) and isinstance(data.get("tids"), (dict, list)):
        tids = data["tids"]
        parent = data.get("parent_map") or {}
        pair = tids.items() if isinstance(tids, dict) else [(x.get("tid"), x.get("tname")) for x in tids]
        for tid, tname in pair:
            tid = num(tid)
            if tid is None:
                continue
            rows.append((tid, tname, tid, str(parent.get(str(tid)) or ""), "ranking_probe"))
    else:
        items = data if isinstance(data, list) else data.get("regions", [])
        for r in items:
            rid = num(r.get("rid") or r.get("tid"))
            if rid is None:
                continue
            rows.append((rid, r.get("tname"), num(r.get("tid")) or rid, r.get("sample_bvid") or "", "ranking_probe"))
    cur.executemany("INSERT OR REPLACE INTO regions VALUES(?,?,?,?,?)", rows)
    n_reg += len(rows)
print(f"[1/5] 分区表 {n_reg} 条")

# ---------- 2. B站元数据（分批）
VS = "INSERT OR IGNORE INTO videos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
files = sorted(glob.glob(os.path.join(RAW, "bili-meta-*.jsonl")))
vbuf, tbuf, seen_tags = [], [], set()
n_meta = 0
for p in files:
    for r in jsons(p):
        b = (r.get("bvid") or "").strip()
        if not b:
            continue
        st = r.get("stat") or {}
        own = r.get("owner") or {}
        vbuf.append((
            b, num(r.get("aid")), clean(r.get("title")), r.get("tname"), num(r.get("tid")),
            r.get("partition_path") or r.get("pid_name_v2"), r.get("keyword"), r.get("source"),
            num(r.get("author_mid") or own.get("mid")), clean(r.get("author_name") or own.get("name")),
            num(r.get("pubdate")), num(r.get("duration_s") or r.get("duration")), num(r.get("desc_len")),
            r.get("url") or f"https://www.bilibili.com/video/{b}", r.get("crawled_at"),
            num(st.get("view")), num(st.get("danmaku")), num(st.get("reply")),
            num(st.get("favorite")), num(st.get("coin")), num(st.get("like")), num(st.get("share")),
            num(r.get("cid")),
        ))
        for t in (r.get("tags") or []):
            t = clean(t)
            if t and (b, t) not in seen_tags:
                seen_tags.add((b, t))
                tbuf.append((b, t))
        n_meta += 1
        if len(vbuf) >= 20000:
            cur.executemany(VS, vbuf)
            cur.executemany("INSERT INTO video_tags VALUES(?,?)", tbuf)
            vbuf, tbuf = [], []
    print("  ", os.path.basename(p), n_meta, "累计")
cur.executemany(VS, vbuf)
cur.executemany("INSERT INTO video_tags VALUES(?,?)", tbuf)
n_videos = cur.execute("SELECT COUNT(*) FROM videos").fetchone()[0]
n_tags = cur.execute("SELECT COUNT(*) FROM video_tags").fetchone()[0]
print(f"[2/5] B站视频入库 {n_videos} 条（读 {n_meta}），标签 {n_tags} 对")

# ---------- 3. 弹幕 + 评论
TS = "INSERT INTO texts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
n_text = 0
t_kind = Counter()
tid = 0
for p in sorted(glob.glob(os.path.join(RAW, "bili-text-*.jsonl"))):
    buf = []
    for r in jsons(p):
        kind = r.get("kind")
        if kind not in ("danmaku", "reply"):
            continue
        tid += 1
        t_kind[kind] += 1
        buf.append((
            tid, "bilibili", kind, r.get("bvid"), num(r.get("cid")), num(r.get("aid")), r.get("tname"),
            clean(r.get("text"))[:2000], num(r.get("time_ms")), num(r.get("mode")), num(r.get("color")),
            num(r.get("rpid")), num(r.get("root")), num(r.get("parent")), num(r.get("depth")),
            num(r.get("likes")), num(r.get("ctime")), num(r.get("uid")), num(r.get("video_pubdate")),
            r.get("crawled_at"),
        ))
        if len(buf) >= 20000:
            cur.executemany(TS, buf)
            n_text += len(buf)
            buf = []
    if buf:
        cur.executemany(TS, buf)
        n_text += len(buf)
    print("  ", os.path.basename(p), n_text, "累计")
print(f"[3/5] 文本 {n_text} 条 {dict(t_kind)}")

# ---------- 4. 其它平台
OS_ = "INSERT OR IGNORE INTO other_videos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
n_other = 0
o_plat = Counter()
for p in sorted(glob.glob(os.path.join(RAW, "other-meta*.jsonl"))):
    buf = []
    for r in jsons(p):
        plat = (r.get("platform") or "").strip()
        iid = str(r.get("item_id") or "").strip()
        if not plat or not iid:
            continue
        st = r.get("stat") or {}
        it = r.get("interest")
        buf.append((
            plat, iid, clean(r.get("title")), r.get("category"),
            ",".join(it) if isinstance(it, list) else it, clean(r.get("author")),
            num(r.get("publish_ts")), num(r.get("duration_s")), num(st.get("view")),
            num(st.get("like")), num(st.get("comment")), r.get("url"), r.get("source"),
            r.get("crawled_at"),
        ))
        o_plat[plat] += 1
        if len(buf) >= 20000:
            cur.executemany(OS_, buf)
            n_other += len(buf)
            buf = []
    if buf:
        cur.executemany(OS_, buf)
        n_other += len(buf)
print(f"[4/5] 其它平台 {n_other} 条 {dict(o_plat)}")

# ---------- 5. 索引 + 汇总
con.commit()
con.executescript(
    """
CREATE INDEX idx_v_tname ON videos(tname);
CREATE INDEX idx_v_view ON videos(view);
CREATE INDEX idx_v_pub ON videos(pubdate);
CREATE INDEX idx_t_bvid ON texts(bvid);
CREATE INDEX idx_t_kind ON texts(kind);
CREATE INDEX idx_t_tname ON texts(tname);
CREATE INDEX idx_tag_tag ON video_tags(tag);
CREATE INDEX idx_o_plat ON other_videos(platform);
CREATE VIRTUAL TABLE video_fts USING fts5(title, author_name, content='videos', content_rowid='rowid');
INSERT INTO video_fts(rowid, title, author_name) SELECT rowid, title, author_name FROM videos;
CREATE VIRTUAL TABLE text_fts USING fts5(text, content='texts', content_rowid='id');
INSERT INTO text_fts(rowid, text) SELECT id, text FROM texts;
"""
)
tot = {
    "videos": n_videos, "texts": n_text, "other": cur.execute("SELECT COUNT(*) FROM other_videos").fetchone()[0],
    "tags": n_tags, "regions": n_reg, "tnames": cur.execute("SELECT COUNT(DISTINCT tname) FROM videos WHERE tname IS NOT NULL").fetchone()[0],
    "by_text_kind": dict(t_kind), "by_other_platform": dict(cur.execute(
        "SELECT platform, COUNT(*) FROM other_videos GROUP BY platform").fetchall()),
    "built_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
}
for k, v in tot.items():
    cur.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (k, json.dumps(v, ensure_ascii=False)))
con.commit()
cast = "\n".join(r[0] + ";" for r in con.execute(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('video_fts','text_fts') "
    "AND name NOT LIKE 'video_fts_%' AND name NOT LIKE 'text_fts_%'"))
open(os.path.join(ROOT, "db", "schema.sql"), "w", encoding="utf-8").write(cast + "\n")
con.execute("VACUUM")
con.close()
print(f"[5/5] 完成 → {DB} {os.path.getsize(DB)/1e6:.1f} MB")
print("总计：", json.dumps(tot, ensure_ascii=False))

