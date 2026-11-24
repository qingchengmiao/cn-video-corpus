-- 视频语料库 · 建库语句（SQLite 3）
-- 与 db/video-corpus.sqlite 一致的 DDL。想自己从 raw/*.jsonl 重建，跑 scripts/build_db.py。
-- 注意：FTS5 是外部内容表，插入主表后要用 INSERT INTO xxx_fts(xxx_fts) VALUES('rebuild') 或逐行补 rowid。

CREATE TABLE videos(
  bvid TEXT PRIMARY KEY,          -- B站稿件号，如 BV1xx411c7mD
  aid INTEGER,                    -- 旧 av 号
  title TEXT,                     -- 标题（已去 HTML 标签与实体）
  tname TEXT,                     -- 分区标签名（新老两套并存，见 docs/07）
  tid INTEGER,                    -- 分区 id
  partition_path TEXT,            -- 分区路径，如 "游戏/单机游戏"，可空（69.7% 有值）
  keyword TEXT,                   -- 采到它的关键词（related 图扩展时为空）
  source TEXT,                    -- related | search | newlist | ranking | popular | view_patch
  author_mid INTEGER, author_name TEXT,
  pubdate INTEGER,                -- 发布 Unix 秒
  duration_s INTEGER,             -- 时长（秒）
  desc_len INTEGER,               -- 简介字数（不存原文）
  url TEXT, crawled_at TEXT,      -- ISO8601 +08:00
  view INTEGER, danmaku INTEGER, reply INTEGER, favorite INTEGER,
  coin INTEGER,                   -- search 来源为 null（接口不返回）
  like_ INTEGER, share INTEGER,   -- like 是保留字，故用 like_
  cid INTEGER                     -- 弹幕分P id
);

CREATE TABLE video_tags(bvid TEXT, tag TEXT);   -- 视频-标签关系，仅 46,980 个视频有

CREATE TABLE texts(
  id INTEGER PRIMARY KEY,
  platform TEXT,                  -- bilibili
  kind TEXT,                      -- danmaku | reply
  bvid TEXT, cid INTEGER, aid INTEGER, tname TEXT,
  text TEXT,                      -- 原文（只脱敏了手机号/邮箱/身份证/QQ）
  time_ms INTEGER,                -- 仅 danmaku：出现时间（毫秒）
  mode INTEGER, color INTEGER,    -- 仅 danmaku：弹幕模式与颜色
  rpid INTEGER, root INTEGER, parent INTEGER, depth INTEGER,  -- 仅 reply：楼中楼关系
  likes INTEGER, ctime INTEGER, uid INTEGER,                  -- 仅 reply：点赞/时间/作者
  video_pubdate INTEGER, crawled_at TEXT
);

CREATE TABLE other_videos(
  platform TEXT,                  -- iqiyi | youku | weibo | qqvideo
  item_id TEXT,                   -- 平台内 id
  title TEXT, category TEXT, interest TEXT, author TEXT,
  publish_ts INTEGER, duration_s INTEGER,
  view INTEGER, like_ INTEGER, comment INTEGER,   -- 匿名接口多数为 null，是平台事实
  url TEXT, source TEXT, crawled_at TEXT,
  PRIMARY KEY(platform, item_id)
);

CREATE TABLE regions(rid INTEGER PRIMARY KEY, tname TEXT, tid INTEGER, sample_bvid TEXT, source TEXT);

CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);   -- 构建信息（时间、来源口径）

CREATE INDEX idx_v_tname ON videos(tname);
CREATE INDEX idx_v_view  ON videos(view);
CREATE INDEX idx_v_pub   ON videos(pubdate);
CREATE INDEX idx_t_bvid  ON texts(bvid);
CREATE INDEX idx_t_kind  ON texts(kind);
CREATE INDEX idx_t_tname ON texts(tname);
CREATE INDEX idx_tag_tag ON video_tags(tag);
CREATE INDEX idx_o_plat  ON other_videos(platform);

-- 全文索引（标题 / 弹幕评论原文）
CREATE VIRTUAL TABLE video_fts USING fts5(title, author_name, content='videos', content_rowid='rowid');
CREATE VIRTUAL TABLE text_fts  USING fts5(text, content='texts', content_rowid='id');
