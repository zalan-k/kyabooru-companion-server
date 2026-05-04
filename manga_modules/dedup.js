// manga/dedup.js
//
// Tracks completed manga downloads so re-submitting the same gallery
// can short-circuit with a 409 instead of re-downloading.
//
// Identity is (source, artist_canonical, title_canonical, chapter).
// We deliberately don't dedup by gallery_id because the same doujin
// can exist on multiple sources and the user may resubmit from a
// different one — they probably don't want two copies on disk.
//
// `chapter` defaults to 1. Doujinshi are typically single-chapter so
// this is the common case; multi-chapter entries can override it
// from the overlay.
//
// Canonicalization is intentionally aggressive — lowercase, trimmed,
// whitespace collapsed to underscores, punctuation stripped. The
// goal is "minor metadata mess shouldn't create dupes." Users who
// want two distinct entries can disambiguate with explicit chapter
// numbers.

/**
 * Initialize the manga_downloads table. Idempotent — safe to call
 * on every server start. The caller passes their better-sqlite3 db
 * handle so we don't have to know about the connection setup.
 */
function initMangaDedupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manga_downloads (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      source             TEXT NOT NULL,
      artist_canonical   TEXT NOT NULL,
      title_canonical    TEXT NOT NULL,
      chapter            INTEGER NOT NULL DEFAULT 1,
      gallery_id         TEXT,
      title_display      TEXT,
      artist_display     TEXT,
      cbz_path           TEXT NOT NULL,
      cbz_bytes          INTEGER,
      page_count         INTEGER,
      source_url         TEXT,
      downloaded_at      INTEGER NOT NULL,
      UNIQUE (source, artist_canonical, title_canonical, chapter)
    );

    CREATE INDEX IF NOT EXISTS idx_manga_downloads_source
      ON manga_downloads(source);
    CREATE INDEX IF NOT EXISTS idx_manga_downloads_downloaded_at
      ON manga_downloads(downloaded_at);
  `);
}

/**
 * Canonicalize one identifier component. Empty string in → empty
 * string out (caller decides what to do with that).
 */
function canonicalize(str) {
  return String(str ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')   // strip punctuation
    .replace(/\s+/g, '_')      // collapse whitespace
    .replace(/_+/g, '_')       // collapse repeated underscores
    .replace(/^_|_$/g, '');    // trim leading/trailing underscores
}

/**
 * Build the canonical key tuple from raw metadata. Chapter defaults
 * to 1. Returns null if either artist or title is empty after
 * canonicalization — caller should treat that as "can't dedup, just
 * download" rather than an error.
 */
function buildDedupKey({ source, artists, title, chapter }) {
  const artistCanon = canonicalize((artists || [])[0] || '');
  const titleCanon = canonicalize(title || '');
  if (!artistCanon || !titleCanon) return null;
  return {
    source,
    artist_canonical: artistCanon,
    title_canonical: titleCanon,
    chapter: chapter || 1,
  };
}

/**
 * Look up an existing download by canonical key. Returns the row or
 * null. Pure read, no side effects.
 */
function findExistingDownload(db, key) {
  if (!key) return null;
  return db.prepare(`
    SELECT * FROM manga_downloads
    WHERE source = ? AND artist_canonical = ? AND title_canonical = ? AND chapter = ?
  `).get(key.source, key.artist_canonical, key.title_canonical, key.chapter) || null;
}

/**
 * Record a successful download. Throws on UNIQUE violation — caller
 * should have already checked findExistingDownload, so a violation
 * here is a race and worth surfacing.
 */
function recordDownload(db, {
  source, artists, title, chapter,
  galleryId, cbzPath, cbzBytes, pageCount, sourceUrl,
}) {
  const key = buildDedupKey({ source, artists, title, chapter });
  if (!key) {
    throw new Error('recordDownload: cannot build dedup key (empty artist or title)');
  }
  const stmt = db.prepare(`
    INSERT INTO manga_downloads (
      source, artist_canonical, title_canonical, chapter,
      gallery_id, title_display, artist_display,
      cbz_path, cbz_bytes, page_count, source_url, downloaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    key.source, key.artist_canonical, key.title_canonical, key.chapter,
    galleryId || null,
    title || null,
    (artists || [])[0] || null,
    cbzPath, cbzBytes || null, pageCount || null, sourceUrl || null,
    Date.now(),
  );
}

module.exports = {
  initMangaDedupSchema,
  canonicalize,
  buildDedupKey,
  findExistingDownload,
  recordDownload,
};