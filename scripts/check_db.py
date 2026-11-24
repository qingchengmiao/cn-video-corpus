import sqlite3

DB = r"D:\Backup\Documents\deepseek-harness\default-workspace\voice-video\db\video-corpus.sqlite"
c = sqlite3.connect(DB)
print("counts", c.execute(
    "select (select count(*) from videos),(select count(*) from texts),"
    "(select count(*) from other_videos),(select count(*) from video_tags),(select count(*) from regions)").fetchone())
print("fts rows", c.execute("select count(*) from video_fts").fetchone(), c.execute("select count(*) from text_fts").fetchone())
print("fts query", c.execute("select count(*) from video_fts where video_fts match ?", ("原神",)).fetchone())
print("orphan texts", c.execute(
    "select count(*) from texts t left join videos v on v.bvid=t.bvid where v.bvid is null").fetchone())
print("tag coverage bvid", c.execute("select count(distinct bvid) from video_tags").fetchone())
print("engagement per1k/1w", c.execute(
    "select round(avg(like_*1.0/nullif(view,0))*1000,2), round(avg(reply*1.0/nullif(view,0))*10000,2) "
    "from videos where view>1000").fetchone())
print("top partition", c.execute("select tname,count(*) from videos group by tname order by 2 desc limit 5").fetchall())
print("tail partition", c.execute("select tname,count(*) from videos group by tname order by 2 asc limit 5").fetchall())
print("danmaku videos", c.execute("select count(distinct bvid) from texts where kind='danmaku'").fetchone())
print("reply videos", c.execute("select count(distinct bvid) from texts where kind='reply'").fetchone())
print("video per tname with texts", c.execute("select count(distinct tname) from texts").fetchone())
