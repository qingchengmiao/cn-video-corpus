import json
import sqlite3
import time
import urllib.request

DB = r"D:\Backup\Documents\deepseek-harness\default-workspace\voice-video\db\video-corpus.sqlite"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
c = sqlite3.connect(DB)
missing = [r[0] for r in c.execute(
    "SELECT DISTINCT t.bvid FROM texts t LEFT JOIN videos v ON v.bvid=t.bvid WHERE v.bvid IS NULL")]
print("缺元数据的 bvid:", len(missing))


def view(bvid):
    u = "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid
    r = urllib.request.urlopen(urllib.request.Request(u, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com"}), timeout=20)
    return json.loads(r.read().decode("utf-8", "replace"))


rows, fails = [], 0
for i, b in enumerate(missing):
    try:
        d = view(b)
        if d.get("code") != 0:
            fails += 1
            continue
        x = d["data"]
        st = x.get("stat") or {}
        rows.append((
            b, x.get("aid"), x.get("title"), x.get("tname"), x.get("tid"), None, None, "view_patch",
            (x.get("owner") or {}).get("mid"), (x.get("owner") or {}).get("name"),
            x.get("pubdate"), x.get("duration"), len(x.get("desc") or ""),
            "https://www.bilibili.com/video/" + b, time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
            st.get("view"), st.get("danmaku"), st.get("reply"), st.get("favorite"),
            st.get("coin"), st.get("like"), st.get("share"), x.get("cid"),
        ))
    except Exception:
        fails += 1
    if i % 200 == 0:
        print(i, "已取", len(rows), "失败", fails, flush=True)
    time.sleep(0.18)

c.executemany(
    "INSERT OR IGNORE INTO videos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
c.commit()
# 补进 FTS
c.executemany(
    "INSERT INTO video_fts(rowid, title, author_name) SELECT rowid, title, author_name FROM videos WHERE bvid=?", 
    [(r[0],) for r in rows])
c.commit()
left = c.execute("select count(*) from texts t left join videos v on v.bvid=t.bvid where v.bvid is null").fetchone()[0]
print("补入", len(rows), "失败", fails, "仍孤儿 texts:", left)
print("videos 总数:", c.execute("select count(*) from videos").fetchone()[0])
