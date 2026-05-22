#!/usr/bin/env python3
"""
Dump artist tags + incidence counts from tag_saver.db.

Unifies the `tags`/`image_tags` (promoted) and
`staging_tags`/`staging_image_tags` (file-scan) stores.
Counts are recomputed from the join tables — the denormalized
`count`/`post_count` columns are ignored on purpose.

Usage:
    python dump_artists.py [path/to/tag_saver.db] [output.json]
Defaults: ./tag_saver.db -> ./artists.json
"""
import sqlite3
import json
import sys
from pathlib import Path

DB_PATH  = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tag_saver.db")
OUT_PATH = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("artists.json")

QUERY = """
WITH promoted AS (
    SELECT t.name, COUNT(it.image_id) AS n
    FROM tags t
    JOIN image_tags it ON it.tag_id = t.id
    WHERE t.category = 'artist'
    GROUP BY t.id
),
staging AS (
    SELECT t.name, COUNT(it.image_id) AS n
    FROM staging_tags t
    JOIN staging_image_tags it ON it.tag_id = t.id
    WHERE t.category = 'artist'
    GROUP BY t.id
),
unified AS (
    SELECT name, n AS promoted_n, 0 AS staging_n FROM promoted
    UNION ALL
    SELECT name, 0,             n              FROM staging
)
SELECT
    name,
    SUM(promoted_n) AS promoted_n,
    SUM(staging_n)  AS staging_n,
    SUM(promoted_n) + SUM(staging_n) AS total_n
FROM unified
GROUP BY name
ORDER BY total_n DESC, name ASC;
"""

def main():
    if not DB_PATH.exists():
        sys.exit(f"DB not found: {DB_PATH}")

    # Read-only URI mode so this is safe to run while the server is up.
    conn = sqlite3.connect(f"file:{DB_PATH.resolve()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    rows = [dict(r) for r in conn.execute(QUERY).fetchall()]
    conn.close()

    OUT_PATH.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")

    total_tags   = len(rows)
    total_images = sum(r["total_n"] for r in rows)
    only_staging = sum(1 for r in rows if r["promoted_n"] == 0)
    only_promoted = sum(1 for r in rows if r["staging_n"] == 0)
    print(f"wrote {OUT_PATH}: {total_tags} artist tags, {total_images} tag-incidences")
    print(f"  staging-only: {only_staging}  promoted-only: {only_promoted}")

if __name__ == "__main__":
    main()
