#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 SQLite 导出成 CSV / JSONL / Excel，方便进 pandas、DuckDB、Excel 或喂给模型。

用法：
    python scripts/export_formats.py                    # CSV + JSONL，输出到 export/
    python scripts/export_formats.py --excel            # 额外生成一个多 sheet 的 xlsx
    python scripts/export_formats.py --db db/sample.sqlite --out export/sample
    python scripts/export_formats.py --tables videos,texts

每张表一个文件；文本表默认先导 5 万行，用 --limit 0 导全量。
"""
import argparse
import csv
import json
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(ROOT, "db", "sample.sqlite")
TABLES = ["videos", "video_tags", "texts", "other_videos", "regions"]


def dump_table(con, table, outdir, limit, fmt):
    cur = con.cursor()
    cur.execute(f"SELECT * FROM {table}" + (f" LIMIT {limit}" if limit else ""))
    cols = [d[0] for d in cur.description]
    n = 0
    if fmt == "csv":
        path = os.path.join(outdir, f"{table}.csv")
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for row in cur:
                w.writerow(row)
                n += 1
    else:
        path = os.path.join(outdir, f"{table}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for row in cur:
                f.write(json.dumps(dict(zip(cols, row)), ensure_ascii=False) + "\n")
                n += 1
    print(f"  {table:14s} {n:>8d} 行 → {os.path.relpath(path, ROOT)}")


def dump_excel(con, outdir, limit):
    try:
        import pandas as pd
    except ImportError:
        print("  [跳过 xlsx] 需要 pandas + openpyxl：pip install pandas openpyxl")
        return
    path = os.path.join(outdir, "video-corpus.xlsx")
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        for t in TABLES:
            df = pd.read_sql_query(f"SELECT * FROM {t}" + (f" LIMIT {limit}" if limit else ""), con)
            sheet = t[:31]
            df.to_excel(xw, sheet_name=sheet, index=False)
            print(f"  sheet {sheet}: {len(df)} 行")
    print(f"  → {os.path.relpath(path, ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=os.path.join(ROOT, "export"))
    ap.add_argument("--tables", default=",".join(TABLES))
    ap.add_argument("--limit", type=int, default=50000, help="每表最多导多少行，0 = 全量")
    ap.add_argument("--excel", action="store_true")
    ap.add_argument("--no-csv", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(a.db):
        raise SystemExit(f"没有找到库：{a.db}")
    os.makedirs(a.out, exist_ok=True)
    con = sqlite3.connect(a.db)
    tables = [t for t in a.tables.split(",") if t]
    if not a.no_csv:
        for t in tables:
            dump_table(con, t, a.out, a.limit, "csv")
    for t in tables:
        dump_table(con, t, a.out, a.limit, "jsonl")
    if a.excel:
        dump_excel(con, a.out, min(a.limit or 100000, 100000))
    con.close()
    print(f"导出完成：{os.path.relpath(a.out, ROOT)}/")


if __name__ == "__main__":
    main()
