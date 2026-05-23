// server.js - Tag Saver Local Server
const multer = require('multer');
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const sharp = require('sharp');
const glob = require('glob');
const fs = require('fs').promises;
const { constants: fsConstants } = require('fs');
const { spawn } = require('child_process');

const { DanbooruUploader } = require('./danbooru-uploader');

const { downloadManga } = require('./manga_modules/download');
const { initMangaDedupSchema } = require('./manga_modules/dedup');
const { uploadManga } = require('./manga_modules/upload');

const { getCamie } = require('./camie/v2');

const saveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1000 * 1024 * 1024 },
});

const mangaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 500 },
});

const booruUploader = new DanbooruUploader({
  baseUrl:  process.env.DANBOORU_URL  || 'https://kyabooru.kyabatsunas.synology.me/',
  username: process.env.DANBOORU_USER || 'kyabatsu',
  apiKey:   process.env.DANBOORU_KEY  || 'EPBFXUJbxWFsBPq2QZaf7TcY',
});

// Public URL is what we return to the UI for "view on booru" links.
// If you reverse-proxy later, set DANBOORU_PUBLIC_URL separately.
const BOORU_PUBLIC_URL = (
  process.env.DANBOORU_PUBLIC_URL ||
  process.env.DANBOORU_URL ||
  'https://kyabooru.kyabatsunas.synology.me/'
).replace(/\/$/, '');

const BOORU_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];

// Singleton Camie wrapper. Module-level so /save, /refresh, and the
// PATCH /api/server-config handler all share it.
const camie = getCamie();
// Bridge Camie state changes to the staging SSE stream so the UI's
// stat card updates without polling.
camie.on('state', (state) => publishStagingEvent('camie-state', state));

const {
  serverConfig,
  loadServerConfig,
  setStagingDir,
  setMangaDir,
  setCamieEnabled,
  snapshot: serverConfigSnapshot,
} = require('./server-config');

const app = express();
const PORT = 3737; // Fixed port for the extension to connect to

/**
 * If Camie is enabled and the image has fewer than 10 general tags,
 * run inference and merge results into the sidecar.
 *
 * Designed to be called fire-and-forget from /save and /refresh —
 * never throws, returns a small status object that callers can ignore.
 * On success, also publishes an `image-saved` SSE so the grid card
 * refreshes with the new tag count.
 *
 * The merged tags run through canonicalize() so the user's aliases /
 * hierarchy / blacklist apply to Camie's output too. Without this,
 * a tag Camie emits that's blacklisted by the user would slip through.
 */
const CAMIE_META_EXCLUDE = [
  /^bad_(\w+_)?id$/,   // bad_id, bad_pixiv_id, bad_twitter_id, ...
];
async function maybeCamieTagId(id) {
  if (!serverConfig.camieEnabled) return { tagged: false, reason: 'disabled' };

  const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
  let json;
  try {
    json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  } catch {
    return { tagged: false, reason: 'sidecar-missing' };
  }

  if (json.mediaType === 'video') {
    return { tagged: false, reason: 'video' };
  }

  // Threshold: count general tags only. Post-canonicalize, because
  // that's the form they're stored in.
  const generalCount = Array.isArray(json.tags?.general) ? json.tags.general.length : 0;
  if (generalCount >= 10) {
    return { tagged: false, reason: 'enough-tags', generalCount };
  }

  // Locate the image file (extension search, same pattern as elsewhere).
  const baseName = jsonPath.replace(/\.json$/, '');
  let imagePath = null;
  for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']) {
    const candidate = baseName + ext;
    try { await fs.access(candidate); imagePath = candidate; break; } catch {}
  }
  if (!imagePath) return { tagged: false, reason: 'image-missing' };

  // Inference. tagImages is the only thing that triggers a lazy spawn.
  console.log(`[camie] processing ${id} with Camie v2...`);
  const camieStart = Date.now();
  let tagResults;
  try {
    [tagResults] = await camie.tagImages([imagePath]);
  } catch (err) {
    console.warn(`[camie] tag failed for ${id}: ${err.message}`);
    return { tagged: false, reason: 'inference-failed' };
  }
  if (!tagResults || tagResults.length === 0) {
    console.log(`[camie] done ${id}: model returned no tags`);
    return { tagged: false, reason: 'no-tags' };
  }

  // Normalize the tags-by-category shape before merging.
  if (!json.tags || typeof json.tags !== 'object' || Array.isArray(json.tags)) {
    json.tags = {};
  }
  for (const cat of ['artist', 'character', 'copyright', 'general', 'meta']) {
    if (!Array.isArray(json.tags[cat])) json.tags[cat] = [];
  }

  // Merge — general + meta only. The /tag request already asked for
  // those categories, but a belt-and-suspenders filter here means a
  // future change to defaults won't accidentally let other categories
  // leak into the sidecar.
  let added = 0;
  for (const t of tagResults) {
    const cat = t.category;
    if (cat !== 'general' && cat !== 'meta') continue;
    // Drop Camie's "bad_*_id" meta tags — danbooru source-link flags
    // (bad_id, bad_pixiv_id, bad_twitter_id, etc.) that are noise on
    // a local archive. Extend CAMIE_META_EXCLUDE if more junk surfaces.
    if (cat === 'meta' && CAMIE_META_EXCLUDE.some(re => re.test(t.tag))) continue;
    if (!json.tags[cat].includes(t.tag)) {
      json.tags[cat].push(t.tag);
      added++;
    }
  }
    if (added === 0) {
    console.log(`[camie] done ${id}: no new tags after merge`);
    return { tagged: false, reason: 'no-new-tags' };
  }

  // Run the merged set through canonicalize() so aliases/hierarchy/
  // blacklist apply to Camie's output. Flatten → canonicalize → re-bucket.
  const flat = [];
  for (const [cat, list] of Object.entries(json.tags)) {
    if (!Array.isArray(list)) continue;
    for (const name of list) flat.push(cat === 'general' ? name : `${cat}:${name}`);
  }
  const canonical = canonicalize(flat);
  const categorized = { artist: [], character: [], copyright: [], general: [], meta: [] };
  for (const tag of canonical) {
    const { category, name } = parseTagName(tag);
    if (categorized[category]) categorized[category].push(name);
    else categorized.general.push(tag);
  }
  json.tags = categorized;

  try {
    await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
    await syncSidecarToDb(id);
  } catch (err) {
    console.error(`[camie] writeback failed for ${id}: ${err.message}`);
    return { tagged: false, reason: 'writeback-failed' };
  }

  // Push the refreshed image so the grid card re-renders with new tags.
  try {
    const updated = await loadStagingImage(id);
    if (updated) publishStagingEvent('image-saved', updated);
  } catch {}

  console.log(`[camie] done ${id}: +${added} tags (${Date.now() - camieStart}ms)`);
  return { tagged: true, added };
}

// ============================================================
// SSE — staging events
// ============================================================
// Subscribers list. Each entry is the Express res object kept open
// with text/event-stream content-type. Writes are fire-and-forget.

const sseSubscribers = new Set();
/**
 * Broadcast a staging event to all subscribers. `data` is serialized
 * as JSON. Failures (closed sockets) are pruned silently.
 */
function publishStagingEvent(event, data) {
  if (sseSubscribers.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseSubscribers) {
    try {
      res.write(payload);
    } catch {
      sseSubscribers.delete(res);
    }
  }
}


class TagCache {
  constructor() {
    this.cache = new Map();
    this.lastUpdate = Date.now();
    this.CACHE_TTL = 30000; // 30 seconds
  }
  
  get(query) {
    const key = query.toLowerCase();
    const entry = this.cache.get(key);
    
    if (entry && (Date.now() - entry.timestamp) < this.CACHE_TTL) { 
      return entry.data;
    }
    return null;
  }
  
  set(query, data) {
    const key = query.toLowerCase();
    this.cache.set(key, {
      data: data,
      timestamp: Date.now()
    });
    
    // Cleanup old entries (keep cache size reasonable)
    if (this.cache.size > 1000) {
      const oldEntries = Array.from(this.cache.entries())
        .filter(([k, v]) => (Date.now() - v.timestamp) > this.CACHE_TTL);
      
      oldEntries.forEach(([key]) => this.cache.delete(key));
    }
  }
  
  invalidate() {
    this.cache.clear();
  }
}

const tagCache = new TagCache();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=5, max=1000');
  next();
});

// Database setup
const DB_PATH = path.join(process.cwd(), 'tag_saver.db');
let db;

// ============================================================
// Lifecycle — WAL checkpointer + graceful shutdown
// ============================================================
let httpServer = null;             // set in startServer()
let walCheckpointInterval = null;  // set after initDatabase()
let shuttingDown = false;

const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000; // 30 min

function startWalCheckpointer() {
  walCheckpointInterval = setInterval(() => {
    try {
      // TRUNCATE resets the WAL file to zero bytes once readers release.
      // Single-process + better-sqlite3 means no concurrent readers in
      // this Node process; with WAL mode, external readers (sqlite3 CLI,
      // litestream, etc.) would briefly block this call but not corrupt.
      const [r] = db.pragma('wal_checkpoint(TRUNCATE)');
      if (r && r.busy) {
        console.warn(`[wal] checkpoint busy: log=${r.log} ckpt=${r.checkpointed}`);
      }
    } catch (err) {
      console.error('[wal] checkpoint failed:', err.message);
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  walCheckpointInterval.unref?.();
}

async function shutdown(reason = 'manual') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`█ Shutdown initiated (${reason})`);

  if (walCheckpointInterval) {
    clearInterval(walCheckpointInterval);
    walCheckpointInterval = null;
  }

  // End SSE subscribers so their keep-alive sockets actually close;
  // otherwise server.close() will sit waiting on them forever.
  for (const res of sseSubscribers) {
    try { res.end(); } catch {}
  }
  sseSubscribers.clear();

  // Stop accepting new connections, wait for in-flight to finish.
  // Hard 5s ceiling so a wedged request can't block shutdown.
  await new Promise(resolve => {
    if (!httpServer) return resolve();
    const t = setTimeout(() => {
      console.warn('[shutdown] server.close timed out, forcing exit');
      resolve();
    }, 5000);
    t.unref?.();
    httpServer.close(() => { clearTimeout(t); resolve(); });
  });

  try { await camie.shutdown(); }
  catch (err) { console.warn('[shutdown] camie shutdown failed:', err.message); }

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('█ Database closed cleanly');
  } catch (err) {
    console.error('[shutdown] db close failed:', err.message);
  }

  console.log('█ Goodbye');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


// Initialize database (synchronous now — better-sqlite3 has no async
// API, all calls block. With our query volume this is fine.)
function initDatabase() {
  db = new Database(DB_PATH);

  // Pragmas. better-sqlite3 supports the `pragma()` shortcut, but a
  // raw exec works the same and matches the SQL we already had.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;

    PRAGMA wal_autocheckpoint = 0;
    PRAGMA checkpoint_fullfsync = 0;
    PRAGMA count_changes = 0;

    PRAGMA optimize;
  `);

  db.pragma('wal_checkpoint(TRUNCATE)');

  // Schema. exec() runs all statements in one go — no need for
  // serialize() because better-sqlite3 is sync by design.
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      image_url TEXT,
      image_hash TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      pool_id TEXT,
      pool_index INTEGER,
      media_type TEXT DEFAULT 'image',
      file_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT DEFAULT 'general',
      count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER,
      tag_id INTEGER,
      PRIMARY KEY (image_id, tag_id),
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_images_hash ON images(image_hash);
    CREATE INDEX IF NOT EXISTS idx_images_url ON images(url);
    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    CREATE INDEX IF NOT EXISTS idx_pool ON images(pool_id, pool_index);


    CREATE TABLE IF NOT EXISTS staging_images (
      id TEXT PRIMARY KEY,

      json_path TEXT NOT NULL,
      image_path TEXT,
      filename TEXT,

      source_url TEXT,
      image_hash TEXT,
      media_type TEXT,

      pool_id TEXT,
      pool_index INTEGER,

      booru_upload_id INTEGER,
      booru_media_asset_id INTEGER,
      booru_post_id INTEGER,

      timestamp INTEGER,
      sidecar_mtime INTEGER NOT NULL,
      tag_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_staging_timestamp
      ON staging_images(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_staging_pool
      ON staging_images(pool_id, pool_index);
    CREATE INDEX IF NOT EXISTS idx_staging_post_id
      ON staging_images(booru_post_id);
    CREATE INDEX IF NOT EXISTS idx_staging_upload_id
      ON staging_images(booru_upload_id);
    CREATE INDEX IF NOT EXISTS idx_staging_tag_count
      ON staging_images(tag_count);

    CREATE TABLE IF NOT EXISTS staging_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      post_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(category, name)
    );

    CREATE INDEX IF NOT EXISTS idx_staging_tags_name ON staging_tags(name);

    CREATE TABLE IF NOT EXISTS staging_image_tags (
      image_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (image_id, tag_id),
      FOREIGN KEY (image_id) REFERENCES staging_images(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES staging_tags(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_staging_image_tags_tag
      ON staging_image_tags(tag_id);

    CREATE TABLE IF NOT EXISTS config_aliases (
      source TEXT PRIMARY KEY,
      canonical TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config_hierarchy (
      parent TEXT NOT NULL,
      child TEXT NOT NULL,
      PRIMARY KEY (parent, child)
    );

    CREATE INDEX IF NOT EXISTS idx_hierarchy_parent
      ON config_hierarchy(parent);

    CREATE TABLE IF NOT EXISTS config_blacklist (
      tag TEXT PRIMARY KEY
    );
    
    CREATE TABLE IF NOT EXISTS config_aliases_rejected (
      source TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS config_blacklist_rejected (
      tag TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS config_aliases_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical TEXT NOT NULL,
      source TEXT NOT NULL,
      -- Total post_count for this group (denormalized for UI sort)
      group_count INTEGER NOT NULL DEFAULT 0,
      -- post_count of the source variant (so UI can show "elira_pendora (3)")
      source_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(canonical, source)
    );

    CREATE INDEX IF NOT EXISTS idx_alias_suggestions_canonical
      ON config_aliases_suggestions(canonical);
    CREATE INDEX IF NOT EXISTS idx_alias_suggestions_group_count
      ON config_aliases_suggestions(group_count DESC);

    CREATE TABLE IF NOT EXISTS config_blacklist_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,            -- 'non-ascii' | 'low-count'
      post_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_blacklist_suggestions_count
      ON config_blacklist_suggestions(post_count DESC);

    -- ============================================================
    -- Persistent log: survives staging deletions, monotonic counts
    -- ============================================================

    -- Hash log: every image hash ever ingested. Drives the extension's
    -- duplicate check independent of whether the image is currently in
    -- staging. Smaller payload than the legacy join — extension scrolling
    -- through hundreds of booru images per second needs this fast.
    CREATE TABLE IF NOT EXISTS image_log (
      image_hash      TEXT PRIMARY KEY,
      source_url      TEXT,
      pool_id         TEXT,
      pool_index      INTEGER,
      booru_post_id   INTEGER,
      first_seen_ts   INTEGER NOT NULL,
      last_seen_ts    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_image_log_pool ON image_log(pool_id);
    CREATE INDEX IF NOT EXISTS idx_image_log_booru ON image_log(booru_post_id);

    -- Pool log: every pool ID + highest index ever seen. Used to (a)
    -- generate non-colliding new pool IDs, (b) answer pool-highest-index
    -- queries from history not just current staging.
    CREATE TABLE IF NOT EXISTS pool_log (
      pool_id         TEXT PRIMARY KEY,
      source_url      TEXT,
      highest_index   INTEGER NOT NULL DEFAULT 0,
      first_seen_ts   INTEGER NOT NULL,
      last_seen_ts    INTEGER NOT NULL
    );

    -- Tag log: cumulative count of how many times a (category, name)
    -- pair has been added to a sidecar. Counts are monotonic — never
    -- decrement. Powers autocomplete ranking with historical accuracy.
    CREATE TABLE IF NOT EXISTS tag_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category        TEXT NOT NULL,
      name            TEXT NOT NULL,
      total_uses      INTEGER NOT NULL DEFAULT 0,
      first_seen_ts   INTEGER NOT NULL,
      last_seen_ts    INTEGER NOT NULL,
      UNIQUE(category, name)
    );

    CREATE INDEX IF NOT EXISTS idx_tag_log_uses ON tag_log(total_uses DESC);
    CREATE INDEX IF NOT EXISTS idx_tag_log_name ON tag_log(name);

    -- Junction: which (image_id, tag_log_id) pairs have been counted.
    -- Prevents double-counting on re-syncs. Insertion via INSERT OR IGNORE;
    -- only when a row is genuinely inserted (changes > 0) does tag_log
    -- count get bumped. Survives staging_images deletion intentionally.
    CREATE TABLE IF NOT EXISTS tag_log_seen (
      image_id        TEXT NOT NULL,
      tag_log_id      INTEGER NOT NULL,
      PRIMARY KEY (image_id, tag_log_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tag_log_seen_tag ON tag_log_seen(tag_log_id);
  `);

  try {
    db.exec(`ALTER TABLE config_aliases ADD COLUMN created_at INTEGER`);
  } catch (err) {
    // SQLite errors if column already exists — ignore. (No "IF NOT EXISTS"
    // for ALTER TABLE in SQLite.)
  }

  console.log('█ Database initialized.');
}

// ============================================================
// STAGING INDEX — boot scan + helpers
// ============================================================

const STAGING_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];

/**
 * Resolve { id, jsonPath, imagePath, filename, sidecarMtime } for a
 * single sidecar path. Returns null if the matching image file is
 * missing — we skip those (sidecar without image is broken state).
 */
async function probeSidecar(jsonPath) {
  const stat = await fs.stat(jsonPath);
  const id = path.basename(jsonPath, '.json');
  const baseName = jsonPath.slice(0, -5); // strip .json
  let imagePath = null;
  let filename = null;
  for (const ext of STAGING_IMAGE_EXTS) {
    const candidate = baseName + ext;
    try {
      await fs.access(candidate);
      imagePath = candidate;
      filename = path.basename(candidate);
      break;
    } catch {
      // try next ext
    }
  }
  return {
    id, jsonPath, imagePath, filename,
    sidecarMtime: stat.mtimeMs,
  };
}

/**
 * Read the sidecar JSON, extract everything we need to populate one
 * staging_images row + its tag links. Returns the parsed object plus
 * the flat tag list as [{category, name}].
 */
async function readSidecar(jsonPath) {
  const raw = await fs.readFile(jsonPath, 'utf8');
  const json = JSON.parse(raw);

  const tags = [];
  if (Array.isArray(json.tags)) {
    // Flat array: assume general unless the tag has a category prefix.
    for (const t of json.tags) {
      if (typeof t !== 'string') continue;
      if (t.includes(':')) {
        const [cat, ...rest] = t.split(':');
        tags.push({ category: cat, name: rest.join(':') });
      } else {
        tags.push({ category: 'general', name: t });
      }
    }
  } else if (json.tags && typeof json.tags === 'object') {
    // Categorized form: { general: [...], character: [...], ... }
    for (const [category, list] of Object.entries(json.tags)) {
      if (!Array.isArray(list)) continue;
      for (const name of list) {
        if (typeof name === 'string') tags.push({ category, name });
      }
    }
  }

  // Timestamp: prefer JSON.timestamp, fall back to file mtime
  let timestamp = null;
  if (json.timestamp) timestamp = new Date(json.timestamp).getTime();

  return { json, tags, timestamp };
}

/**
 * Insert/update one sidecar in the index. Idempotent.
 *
 * Returns 'inserted' | 'updated' | 'skipped'. Logging granularity for
 * the boot scan stats.
 */
function upsertStagingRow(probe, json, tags, timestamp) {
  return db.transaction(() => {
    // 1. Existing row check by id
    const existing = db.prepare(
      'SELECT sidecar_mtime FROM staging_images WHERE id = ?'
    ).get(probe.id);

    if (existing && existing.sidecar_mtime === probe.sidecarMtime) {
      return 'skipped';
    }

    // 2. Upsert the staging_images row
    const row = {
      id: probe.id,
      json_path: probe.jsonPath,
      image_path: probe.imagePath,
      filename: probe.filename,
      source_url: json.sourceUrl || null,
      image_hash: json.imageHash || null,
      media_type: json.mediaType || 'image',
      pool_id: json.poolId || null,
      pool_index: json.poolIndex ?? null,
      booru_upload_id: json.booruUploadId || null,
      booru_media_asset_id: json.booruMediaAssetId || null,
      booru_post_id:
        json.booruPostId === undefined ? null :   // pending
        json.booruPostId === null      ? 0    :   // duplicate-skip sentinel
        json.booruPostId,                          // -1 (fail) or positive (success), preserved as-is
      timestamp: timestamp ?? probe.sidecarMtime,
      sidecar_mtime: probe.sidecarMtime,
      tag_count: tags.length,
    };

    db.prepare(`
      INSERT INTO staging_images (
        id, json_path, image_path, filename, source_url, image_hash,
        media_type, pool_id, pool_index,
        booru_upload_id, booru_media_asset_id, booru_post_id,
        timestamp, sidecar_mtime, tag_count
      ) VALUES (
        @id, @json_path, @image_path, @filename, @source_url, @image_hash,
        @media_type, @pool_id, @pool_index,
        @booru_upload_id, @booru_media_asset_id, @booru_post_id,
        @timestamp, @sidecar_mtime, @tag_count
      )
      ON CONFLICT(id) DO UPDATE SET
        json_path = excluded.json_path,
        image_path = excluded.image_path,
        filename = excluded.filename,
        source_url = excluded.source_url,
        image_hash = excluded.image_hash,
        media_type = excluded.media_type,
        pool_id = excluded.pool_id,
        pool_index = excluded.pool_index,
        booru_upload_id = excluded.booru_upload_id,
        booru_media_asset_id = excluded.booru_media_asset_id,
        booru_post_id = excluded.booru_post_id,
        timestamp = excluded.timestamp,
        sidecar_mtime = excluded.sidecar_mtime,
        tag_count = excluded.tag_count
    `).run(row);

    // 3. Replace tag links — easier than diffing for now
    db.prepare('DELETE FROM staging_image_tags WHERE image_id = ?').run(probe.id);

    const insertTag = db.prepare(`
      INSERT INTO staging_tags (category, name, post_count) VALUES (?, ?, 0)
      ON CONFLICT(category, name) DO NOTHING
    `);
    const findTag = db.prepare(
      'SELECT id FROM staging_tags WHERE category = ? AND name = ?'
    );
    const linkTag = db.prepare(
      'INSERT OR IGNORE INTO staging_image_tags (image_id, tag_id) VALUES (?, ?)'
    );

    for (const { category, name } of tags) {
      insertTag.run(category, name);
      const tagRow = findTag.get(category, name);
      if (tagRow) linkTag.run(probe.id, tagRow.id);
    }
    syncLogTables(probe.id, json, tags);
    return existing ? 'updated' : 'inserted';
  })();
}

/**
 * Recompute every tag's post_count from the junction. Cheap (one
 * scan), idempotent, called once at the end of the boot scan.
 */
function recomputeTagCounts() {
  db.exec(`
    UPDATE staging_tags
    SET post_count = (
      SELECT COUNT(*) FROM staging_image_tags WHERE tag_id = staging_tags.id
    )
  `);
  // Optional: prune zero-count tags. Skipped — tag history is useful
  // for analytics and the count only adds bytes, not query cost.
}

/**
 * Prune index rows whose sidecar file no longer exists on disk.
 * Called after the scan loop completes.
 */
async function pruneOrphans(seenIds) {
  const all = db.prepare('SELECT id FROM staging_images').all();
  const toDelete = all.map(r => r.id).filter(id => !seenIds.has(id));
  if (toDelete.length === 0) return 0;

  const stmt = db.prepare('DELETE FROM staging_images WHERE id = ?');
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  tx(toDelete);
  return toDelete.length;
}

/**
 * Walk staging, sync the index. Called at boot and on demand.
 */
/**
 * Walk serverConfig.stagingDir, sync the index. Called at boot and on
 * demand (boot scan, /api/staging/rebuild, PATCH /api/server-config).
 *
 * options.rescanId — when set, periodically publish 'rescan-progress'
 * SSE events so the UI can show a progress bar. Boot calls this with
 * no rescanId because no clients are connected yet.
 */
async function scanStagingIntoDb(options = {}) {
  const { rescanId = null } = options;

  const t0 = Date.now();
  const files = glob.sync(`${serverConfig.stagingDir}/**/*.json`).filter(f => !f.includes('.trash'));

  console.log(`  [index-scan] found ${files.length} sidecars on disk`);

  let inserted = 0, updated = 0, skipped = 0, errored = 0;
  const seen = new Set();

  // Publish progress every PROGRESS_STEP files. For 15k files this
  // gives ~30 events — enough resolution for a progress bar without
  // spamming SSE consumers.
  const PROGRESS_STEP = 500;

  for (const jsonPath of files) {
    try {
      const probe = await probeSidecar(jsonPath);
      seen.add(probe.id);

      // Fast path: mtime match — skip the JSON read entirely.
      const existing = db.prepare(
        'SELECT sidecar_mtime FROM staging_images WHERE id = ?'
      ).get(probe.id);
      if (existing && existing.sidecar_mtime === probe.sidecarMtime) {
        skipped++;
        continue;
      }

      // Slow path: read JSON, upsert.
      const { json, tags, timestamp } = await readSidecar(jsonPath);
      const action = upsertStagingRow(probe, json, tags, timestamp);
      if (action === 'inserted') inserted++;
      else if (action === 'updated') updated++;
      else skipped++;
    } catch (err) {
      errored++;
      console.warn(`  [index-scan] error on ${jsonPath}: ${err.message}`);
    }

    const processed = inserted + updated + skipped + errored;

    if (processed % 1000 === 0) {
      console.log(`  [index-scan] progress: ${processed}/${files.length}`);
    }

    if (rescanId && processed % PROGRESS_STEP === 0) {
      publishStagingEvent('rescan-progress', {
        rescanId,
        processed,
        total: files.length,
      });
    }
  }

  const pruned = await pruneOrphans(seen);
  recomputeTagCounts();

  const elapsed = Date.now() - t0;
  console.log(
    `  [index-scan] done in ${elapsed}ms — ` +
    `ins: ${inserted} upd: ${updated} skip: ${skipped} ` +
    `err: ${errored} prune: ${pruned}`
  );

  return { inserted, updated, skipped, errored, pruned, elapsed };
}

// ============================================================
// STAGING INDEX — incremental sync helpers
// ============================================================

/**
 * Sync one sidecar JSON to its staging_images + staging_image_tags
 * rows. Idempotent. Use this after any save/upload/post that mutates
 * a sidecar.
 *
 * Differs from scanStagingIntoDb's upsert path in two ways:
 *   - It also adjusts staging_tags.post_count for tags added/removed,
 *     so we don't need a full recompute after every save.
 *   - It assumes the caller already wrote the sidecar, so we read
 *     fresh from disk to capture exactly what's there.
 */
async function syncSidecarToDb(id) {
  const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);

  let probe;
  try {
    probe = await probeSidecar(jsonPath);
  } catch (err) {
    console.warn(`[index-sync] failed to stat ${id}: ${err.message}`);
    return false;
  }

  let json, tags, timestamp;
  try {
    ({ json, tags, timestamp } = await readSidecar(jsonPath));
  } catch (err) {
    console.warn(`[index-sync] failed to read ${id}: ${err.message}`);
    return false;
  }

  // Diff: figure out which (category, name) pairs leave or join the
  // image, so we can adjust post_count incrementally.
  const oldLinkRows = db.prepare(`
    SELECT st.id AS tag_id, st.category, st.name
    FROM staging_image_tags sit
    JOIN staging_tags st ON st.id = sit.tag_id
    WHERE sit.image_id = ?
  `).all(id);

  const oldKeys = new Set(oldLinkRows.map(r => `${r.category}\0${r.name}`));
  const newKeys = new Set(tags.map(t => `${t.category}\0${t.name}`));

  const tx = db.transaction(() => {
    // Upsert the image row
    db.prepare(`
      INSERT INTO staging_images (
        id, json_path, image_path, filename, source_url, image_hash,
        media_type, pool_id, pool_index,
        booru_upload_id, booru_media_asset_id, booru_post_id,
        timestamp, sidecar_mtime, tag_count
      ) VALUES (
        @id, @json_path, @image_path, @filename, @source_url, @image_hash,
        @media_type, @pool_id, @pool_index,
        @booru_upload_id, @booru_media_asset_id, @booru_post_id,
        @timestamp, @sidecar_mtime, @tag_count
      )
      ON CONFLICT(id) DO UPDATE SET
        json_path = excluded.json_path,
        image_path = excluded.image_path,
        filename = excluded.filename,
        source_url = excluded.source_url,
        image_hash = excluded.image_hash,
        media_type = excluded.media_type,
        pool_id = excluded.pool_id,
        pool_index = excluded.pool_index,
        booru_upload_id = excluded.booru_upload_id,
        booru_media_asset_id = excluded.booru_media_asset_id,
        booru_post_id = excluded.booru_post_id,
        timestamp = excluded.timestamp,
        sidecar_mtime = excluded.sidecar_mtime,
        tag_count = excluded.tag_count
    `).run({
      id: probe.id,
      json_path: probe.jsonPath,
      image_path: probe.imagePath,
      filename: probe.filename,
      source_url: json.sourceUrl || null,
      image_hash: json.imageHash || null,
      media_type: json.mediaType || 'image',
      pool_id: json.poolId || null,
      pool_index: json.poolIndex ?? null,
      booru_upload_id: json.booruUploadId || null,
      booru_media_asset_id: json.booruMediaAssetId || null,
      booru_post_id:
        json.booruPostId === undefined ? null :   // pending
        json.booruPostId === null      ? 0    :   // duplicate-skip sentinel
        json.booruPostId,                          // -1 (fail) or positive (success), preserved as-is
      timestamp: timestamp ?? probe.sidecarMtime,
      sidecar_mtime: probe.sidecarMtime,
      tag_count: tags.length,
    });
    // Tags that disappeared: unlink + decrement post_count
    const decTag = db.prepare(`
      UPDATE staging_tags SET post_count = MAX(post_count - 1, 0)
      WHERE id = ?
    `);
    const unlinkTag = db.prepare(
      'DELETE FROM staging_image_tags WHERE image_id = ? AND tag_id = ?'
    );
    for (const old of oldLinkRows) {
      const key = `${old.category}\0${old.name}`;
      if (!newKeys.has(key)) {
        unlinkTag.run(id, old.tag_id);
        decTag.run(old.tag_id);
      }
    }

    // Tags that arrived: insert tag row if missing, link, increment
    const insertTag = db.prepare(`
      INSERT INTO staging_tags (category, name, post_count) VALUES (?, ?, 0)
      ON CONFLICT(category, name) DO NOTHING
    `);
    const findTag = db.prepare(
      'SELECT id FROM staging_tags WHERE category = ? AND name = ?'
    );
    const linkTag = db.prepare(
      'INSERT OR IGNORE INTO staging_image_tags (image_id, tag_id) VALUES (?, ?)'
    );
    const incTag = db.prepare(
      'UPDATE staging_tags SET post_count = post_count + 1 WHERE id = ?'
    );

    for (const t of tags) {
      const key = `${t.category}\0${t.name}`;
      if (oldKeys.has(key)) continue;  // already linked

      insertTag.run(t.category, t.name);
      const tagRow = findTag.get(t.category, t.name);
      if (!tagRow) continue;
      const linked = linkTag.run(id, tagRow.id);
      // Only increment if we actually inserted a new link.
      if (linked.changes > 0) incTag.run(tagRow.id);
    }
    
    syncLogTables(id, json, tags);
  });
  try {
    tx();
    return true;
  } catch (err) {
    console.error(`[index-sync] tx failed for ${id}: ${err.message}`);
    return false;
  }
}

/**
 * Remove a row from the staging index. Adjusts post_count for any
 * tags this image was the only user of.
 */
function removeStagingFromDb(id) {
  const tx = db.transaction(() => {
    const linkRows = db.prepare(
      'SELECT tag_id FROM staging_image_tags WHERE image_id = ?'
    ).all(id);

    db.prepare('DELETE FROM staging_image_tags WHERE image_id = ?').run(id);

    const decTag = db.prepare(`
      UPDATE staging_tags SET post_count = MAX(post_count - 1, 0)
      WHERE id = ?
    `);
    for (const r of linkRows) decTag.run(r.tag_id);

    db.prepare('DELETE FROM staging_images WHERE id = ?').run(id);
  });

  try {
    tx();
    return true;
  } catch (err) {
    console.error(`[index-sync] remove failed for ${id}: ${err.message}`);
    return false;
  }
}

/**
 * Update the persistent log tables for one synced sidecar.
 *
 *   - image_log: upsert by hash, stamp last_seen_ts. Updates booru_post_id
 *     if present in metadata (tracks current state, not history of changes).
 *   - pool_log: upsert by pool_id, bump highest_index using max().
 *   - tag_log: per tag (post-canonicalize), insert tag row if missing,
 *     attempt junction insert. Junction collision = tag already counted
 *     for this image; no-op. Junction insert success = tag is new for
 *     this image; bump total_uses.
 *
 * @param id      staging image id (string, sidecar basename)
 * @param data    parsed sidecar JSON
 * @param tags    array of {category, name} for tags currently in sidecar
 *                (already canonicalized — only canonical tags count)
 */
function syncLogTables(id, data, tags) {
  const now = Date.now();

  // --- image_log -------------------------------------------------------
  if (data.imageHash) {
    db.prepare(`
      INSERT INTO image_log
        (image_hash, source_url, pool_id, pool_index, booru_post_id, first_seen_ts, last_seen_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(image_hash) DO UPDATE SET
        source_url    = COALESCE(excluded.source_url, source_url),
        pool_id       = COALESCE(excluded.pool_id, pool_id),
        pool_index    = COALESCE(excluded.pool_index, pool_index),
        booru_post_id = COALESCE(excluded.booru_post_id, booru_post_id),
        last_seen_ts  = excluded.last_seen_ts
    `).run(
      data.imageHash,
      data.sourceUrl || null,
      data.poolId || null,
      data.poolIndex ?? null,
      data.booruPostId ?? null,
      now, now
    );
  }

  // --- pool_log --------------------------------------------------------
  // Bump highest_index = max(existing, this image's index). Uses
  // ON CONFLICT to upsert atomically.
  if (data.poolId) {
    const idx = data.poolIndex ?? 0;
    db.prepare(`
      INSERT INTO pool_log
        (pool_id, source_url, highest_index, first_seen_ts, last_seen_ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pool_id) DO UPDATE SET
        highest_index = MAX(highest_index, excluded.highest_index),
        last_seen_ts  = excluded.last_seen_ts
    `).run(data.poolId, data.sourceUrl || null, idx, now, now);
  }

  // --- tag_log + tag_log_seen ------------------------------------------
  // For each tag: ensure tag_log row, attempt junction insert. If junction
  // insert succeeds (changes=1), this is the first time this image has
  // contributed this tag — bump total_uses. If it fails (changes=0,
  // collision on PK), already counted — no-op.

  const upsertTagLog = db.prepare(`
    INSERT INTO tag_log (category, name, total_uses, first_seen_ts, last_seen_ts)
    VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(category, name) DO UPDATE SET
      last_seen_ts = excluded.last_seen_ts
  `);
  const findTagLog = db.prepare(
    'SELECT id FROM tag_log WHERE category = ? AND name = ?'
  );
  const insertSeen = db.prepare(
    'INSERT OR IGNORE INTO tag_log_seen (image_id, tag_log_id) VALUES (?, ?)'
  );
  const incTagLog = db.prepare(
    'UPDATE tag_log SET total_uses = total_uses + 1 WHERE id = ?'
  );

  for (const t of tags) {
    upsertTagLog.run(t.category, t.name, now, now);
    const row = findTagLog.get(t.category, t.name);
    if (!row) continue;
    const seen = insertSeen.run(id, row.id);
    if (seen.changes > 0) {
      incTagLog.run(row.id);
    }
  }
}

// Helper functions
async function promiseDb(query, params = []) {
  return db.prepare(query).all(...arrayifyParams(params));
}

async function promiseDbRun(query, params = []) {
  const info = db.prepare(query).run(...arrayifyParams(params));
  return { id: info.lastInsertRowid, changes: info.changes };
}

function arrayifyParams(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  if (typeof params === 'object') return [params];
  return [params];
}

// Add Hamming distance calculation function
function calculateHammingDistance(hash1, hash2) {
  if (!hash1 || !hash2) {
    return Infinity;
  }
  
  try {
    // Convert hex to binary
    const bin1 = hexToBinary(hash1);
    const bin2 = hexToBinary(hash2);
    
    // Ensure equal length
    const minLength = Math.min(bin1.length, bin2.length);
    
    // Count differing bits
    let distance = 0;
    for (let i = 0; i < minLength; i++) {
      if (bin1[i] !== bin2[i]) {
        distance++;
      }
    }
    
    // Add difference in length as additional distance
    distance += Math.abs(bin1.length - bin2.length);
    
    return distance;
  } catch (error) {
    console.error("Error calculating hamming distance:", error);
    return Infinity;
  }
}

async function computeImageHash(imagePath) {
  try {
    // ✅ UPDATED: Use 16x16 for pHash (matches client implementation)
    const { data, info } = await sharp(imagePath)
      .resize(16, 16, { 
        fit: 'fill',
        kernel: sharp.kernel.cubic,
        background: { r: 255, g: 255, b: 255 } // ✅ White background for transparency
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // ✅ Convert to grayscale matrix (same as client)
    const size = 16;
    const grayPixels = [];
    
    for (let y = 0; y < size; y++) {
      grayPixels[y] = [];
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3; // RGB data (3 channels per pixel)
        // ✅ EXACT same ITU-R BT.709 grayscale conversion as client
        grayPixels[y][x] = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      }
    }
    
    // ✅ Apply 2D DCT (same as client implementation)
    const dctSize = 8;
    const dct = [];
    for (let u = 0; u < dctSize; u++) {
      dct[u] = [];
      for (let v = 0; v < dctSize; v++) {
        let sum = 0;
        for (let x = 0; x < size; x++) {
          for (let y = 0; y < size; y++) {
            sum += grayPixels[x][y] * 
                   Math.cos((2*x + 1) * u * Math.PI / (2*size)) *
                   Math.cos((2*y + 1) * v * Math.PI / (2*size));
          }
        }
        const cu = u === 0 ? 1/Math.sqrt(2) : 1;
        const cv = v === 0 ? 1/Math.sqrt(2) : 1;
        dct[u][v] = (2/size) * cu * cv * sum;
      }
    }
    
    // ✅ Get average of DCT coefficients (excluding DC component)
    let sum = 0;
    let count = 0;
    for (let y = 0; y < dctSize; y++) {
      for (let x = 0; x < dctSize; x++) {
        if (x !== 0 || y !== 0) { // Skip DC component
          sum += dct[y][x];
          count++;
        }
      }
    }
    const avg = sum / count;
    
    // ✅ Generate hash (same as client)
    let hashBits = '';
    for (let y = 0; y < dctSize; y++) {
      for (let x = 0; x < dctSize; x++) {
        if (x !== 0 || y !== 0) {
          hashBits += dct[y][x] >= avg ? '1' : '0';
        }
      }
    }
    
    // Convert to hex
    return binaryToHex(hashBits);
  } catch (error) {
    console.error(`Error computing pHash for ${imagePath}:`, error);
    return null;
  }
}

// Convert hex string to binary string
function hexToBinary(hex) {
  let binary = '';
  for (let i = 0; i < hex.length; i++) {
    const decimal = parseInt(hex[i], 16);
    const bits = decimal.toString(2).padStart(4, '0');
    binary += bits;
  }
  return binary;
}

function binaryToHex(binaryStr) {
  let output = '';
  for (let i = 0; i < binaryStr.length; i += 4) {
    const chunk = binaryStr.substr(i, 4);
    const decimal = parseInt(chunk, 2);
    output += decimal.toString(16);
  }
  return output;
}

// Enhanced duplicate checking with similarity threshold
async function checkForDuplicateWithSimilarity(imageHash, similarityThreshold = 8) {
  if (!imageHash) {
    return { isDuplicate: false };
  }

  try {
    // Get all images with hashes
    const allImages = await promiseDb(
      'SELECT id, url, image_url, image_hash, timestamp FROM images WHERE image_hash IS NOT NULL'
    );

    // Check for exact match first
    const exactMatch = allImages.find(img => img.image_hash === imageHash);
    if (exactMatch) {
      return {
        isDuplicate: true,
        exactMatch: true,
        originalRecord: exactMatch
      };
    }

    // Check for similar matches using Hamming distance
    for (const img of allImages) {
      const distance = calculateHammingDistance(imageHash, img.image_hash);
      if (distance <= similarityThreshold) {
        return {
          isDuplicate: true,
          exactMatch: false,
          originalRecord: img
        };
      }
    }

    return { isDuplicate: false };
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    return { isDuplicate: false };
  }
}

// Save image with tags
app.post('/api/images', async (req, res) => {
  const startTime = process.hrtime.bigint();
  
  try {
    const { url, tags, imageUrl, imageHash, poolId, poolIndex, mediaType = 'image', similarityThreshold = 8 } = req.body;
    
    if (!url || !tags || !Array.isArray(tags)) {
      return res.status(400).json({ error: 'Missing required fields: url, tags' });
    }
    
    let duplicateInfo = null;
    if (imageHash) {
      const duplicateResult = await checkForDuplicateWithSimilarity(imageHash, similarityThreshold);
      
      if (duplicateResult.isDuplicate) {
        console.log(`📋 Duplicate detected but continuing with save: ${duplicateResult.exactMatch ? 'exact' : 'similar'} match`);
        duplicateInfo = {
          isDuplicate: true,
          exactMatch: duplicateResult.exactMatch,
          originalRecord: duplicateResult.originalRecord
        };
      }
    }

    // Keep pool_log in sync so /api/pools/:id/highest-index reflects this
    // save immediately rather than waiting for the next boot scan.
    if (poolId) {
      const idx = poolIndex ?? 0;
      const now = Date.now();
      try {
        db.prepare(`
          INSERT INTO pool_log
            (pool_id, source_url, highest_index, first_seen_ts, last_seen_ts)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(pool_id) DO UPDATE SET
            highest_index = MAX(highest_index, excluded.highest_index),
            last_seen_ts  = excluded.last_seen_ts
        `).run(poolId, url || null, idx, now, now);
      } catch (err) {
        console.warn(`/api/images: pool_log upsert failed for ${poolId}: ${err.message}`);
      }
    }

    const tempId = Date.now();
    res.json({ 
      success: true, 
      imageId: tempId, 
      processing: true,
      duplicateInfo: duplicateInfo
    });
    
  } catch (error) {
    console.error('❌ Error saving image:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// CONFIG — DB-backed taxonomy
// ============================================================

/**
 * Read the full config bundle from the DB. Shape matches what the
 * old loadOrInitializeTaxonomy() used to return, so the UI doesn't
 * notice the storage swap.
 *
 * Returns:
 * {
 *   aliases:    { canonical -> { category, variants[] } },
 *   exclusions: { blacklist[], whitelist[] },
 *   hierarchy:  { parent -> child[] },
 *   suggestions: { aliases: [], garbage: [] },   // empty until step 11+
 *   dismissed:   { aliases: [], garbage: [] },   // mirrors rejected tables
 *   lastRun:    null
 * }
 */
function loadTaxonomyFromDb() {
  // --- Aliases ---
  // DB stores flat (source, canonical). UI wants grouped by canonical
  // with category extracted. Group on the fly.
  const aliasRows = db.prepare(`
    SELECT source, canonical, created_at
    FROM config_aliases
    ORDER BY COALESCE(created_at, 0) DESC, canonical, source
  `).all();

  const aliases = {};
  const orderedCanonicals = [];
  for (const { source, canonical, created_at } of aliasRows) {
    if (!aliases[canonical]) {
      const [category] = canonical.includes(':') ? canonical.split(':') : ['general'];
      aliases[canonical] = {
        category,
        variants: [],
        createdAt: created_at,   // pass through; UI ignores if missing
      };
      orderedCanonicals.push(canonical);
    }
    aliases[canonical].variants.push(source);
  }

  // --- Exclusions ---
  // Blacklist comes from config_blacklist; whitelist (= rejected) comes
  // from config_blacklist_rejected. Old code stored these in the same
  // exclusions object so we mirror that shape.
  const blacklist = db.prepare(
    'SELECT tag FROM config_blacklist ORDER BY tag'
  ).all().map(r => r.tag);

  const whitelist = db.prepare(
    'SELECT tag FROM config_blacklist_rejected ORDER BY tag'
  ).all().map(r => r.tag);

  // --- Hierarchy ---
  // DB stores flat (parent, child). UI wants { parent -> [children] }.
  const hierarchyRows = db.prepare(
    'SELECT parent, child FROM config_hierarchy ORDER BY parent, child'
  ).all();

  const hierarchy = {};
  for (const { parent, child } of hierarchyRows) {
    if (!hierarchy[parent]) hierarchy[parent] = [];
    hierarchy[parent].push(child);
  }

  // --- Dismissed (alias side) ---
  const dismissedAliases = db.prepare(
    'SELECT source FROM config_aliases_rejected ORDER BY source'
  ).all().map(r => r.source);

  return {
    aliases,
    exclusions: { blacklist, whitelist },
    hierarchy,
    suggestions: { aliases: [], garbage: [] },
    dismissed: { aliases: dismissedAliases, garbage: whitelist },
    lastRun: null,
  };
}

/**
 * Replace the aliases section in the DB with `payload`.
 * `payload` shape: { canonical -> { category, variants[] } }
 *
 * Atomic: wraps in a transaction so a failed write leaves the DB
 * unchanged.
 */
function saveAliasesToDb(payload) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_aliases').run();
    const insert = db.prepare(
      'INSERT OR REPLACE INTO config_aliases (source, canonical, created_at) VALUES (?, ?, ?)'
    )
    if (payload && typeof payload === 'object') {
      for (const [canonical, entry] of Object.entries(payload)) {
        if (!entry || !Array.isArray(entry.variants)) continue;
        for (const source of entry.variants) {
          if (typeof source === 'string' && source.length > 0) {
            insert.run(source, canonical, Date.now());
          }
        }
      }
    }
  });
  tx();
}

/**
 * Replace the exclusions section. payload = { blacklist[], whitelist[] }.
 * blacklist -> config_blacklist, whitelist -> config_blacklist_rejected.
 */
function saveExclusionsToDb(payload) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_blacklist').run();
    db.prepare('DELETE FROM config_blacklist_rejected').run();

    const insertBl = db.prepare(
      'INSERT OR IGNORE INTO config_blacklist (tag) VALUES (?)'
    );
    const insertWl = db.prepare(
      'INSERT OR IGNORE INTO config_blacklist_rejected (tag) VALUES (?)'
    );

    if (payload && Array.isArray(payload.blacklist)) {
      for (const tag of payload.blacklist) {
        if (typeof tag === 'string' && tag.length > 0) insertBl.run(tag);
      }
    }
    if (payload && Array.isArray(payload.whitelist)) {
      for (const tag of payload.whitelist) {
        if (typeof tag === 'string' && tag.length > 0) insertWl.run(tag);
      }
    }
  });
  tx();
}

/**
 * Replace the hierarchy section.
 * payload shape: { parent -> [child, child, ...] }
 */
function saveHierarchyToDb(payload) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_hierarchy').run();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO config_hierarchy (parent, child) VALUES (?, ?)'
    );
    if (payload && typeof payload === 'object') {
      for (const [parent, children] of Object.entries(payload)) {
        if (!Array.isArray(children)) continue;
        for (const child of children) {
          if (typeof child === 'string' && child.length > 0) {
            insert.run(parent, child);
          }
        }
      }
    }
  });
  tx();
}

// ============================================================
// CONFIG — auto-suggester
// ============================================================

/**
 * Strip "(parenthetical)" suffixes from a tag name. Used during
 * grouping so "tenma_maemi (1st costume)" hashes to "tenma_maemi".
 *
 *   "foo_bar"               → "foo_bar"
 *   "foo_bar (1st costume)" → "foo_bar"
 *   "foo (a) (b)"           → "foo"
 */
function stripParentheticals(name) {
  return name.replace(/\s*\([^)]*\)/g, '').trim();
}

/**
 * Aggressive normalize for grouping comparisons. Used ONLY to decide
 * which tags belong in the same group — NOT what the canonical
 * stored form looks like.
 *
 *   "Elira Pendora (1st)" → "elirapendora"
 *   "elira_pendora"       → "elirapendora"
 *   "ElirA-pendora"       → "elirapendora"
 */
function aggressiveNormalize(name) {
  return stripParentheticals(name)
    .toLowerCase()
    .replace(/[_\s\-]+/g, '')
    .trim();
}

/**
 * Run the analyzer. Wipes existing suggestions, scans staging_tags,
 * populates config_aliases_suggestions + config_blacklist_suggestions.
 *
 * Returns { aliasGroups, blacklistCandidates, elapsed }.
 */
function runSuggesterAnalysis() {
  const t0 = Date.now();

  // 1. Load all tags + counts. Single query.
  const allTags = db.prepare(`
    SELECT category, name, post_count
    FROM staging_tags
    WHERE post_count > 0
  `).all();

  // 2. Load skip lists.
  const aliasSources    = new Set(db.prepare('SELECT source FROM config_aliases').all().map(r => r.source));
  const aliasCanonicals = new Set(db.prepare('SELECT DISTINCT canonical FROM config_aliases').all().map(r => r.canonical));
  const aliasRejected   = new Set(db.prepare('SELECT source FROM config_aliases_rejected').all().map(r => r.source));
  const blacklistActive = new Set(db.prepare('SELECT tag FROM config_blacklist').all().map(r => r.tag));
  const blacklistReject = new Set(db.prepare('SELECT tag FROM config_blacklist_rejected').all().map(r => r.tag));

  // Helper to get the full "category:name" form
  const fullTag = (category, name) =>
    category === 'general' ? name : `${category}:${name}`;

  // ============================================================
  // ALIAS SUGGESTIONS
  // ============================================================

  // Group all tags by aggressiveNormalize(name). Cross-category by
  // design — general:dokibird and character:dokibird group together.
  const groups = new Map();
  for (const row of allTags) {
    const key = aggressiveNormalize(row.name);
    if (!key) continue;  // skip empty/whitespace-only after normalize
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // For each group with > 1 distinct full tags, build a suggestion.
  const aliasInserts = [];
  let aliasGroups = 0;

  for (const [key, members] of groups) {
    // Distinct full forms in this group
    const byFullTag = new Map();
    for (const m of members) {
      const ft = fullTag(m.category, m.name);
      if (!byFullTag.has(ft)) byFullTag.set(ft, { ...m, full: ft });
      else byFullTag.get(ft).post_count += m.post_count;  // shouldn't happen, defensive
    }
    if (byFullTag.size < 2) continue;  // not a group

    const variants = [...byFullTag.values()];

    // Pick canonical:
    //   1. Prefer non-'general' categories (any non-general beats general)
    //   2. Among those, highest post_count wins
    //   3. Tiebreak alphabetically
    variants.sort((a, b) => {
      const aGen = a.category === 'general' ? 1 : 0;
      const bGen = b.category === 'general' ? 1 : 0;
      if (aGen !== bGen) return aGen - bGen;          // non-general first
      if (a.post_count !== b.post_count) return b.post_count - a.post_count;
      return a.full.localeCompare(b.full);
    });

    const winner = variants[0];
    const canonicalName = stripParentheticals(winner.name)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_');
    const canonical = winner.category === 'general'
      ? canonicalName
      : `${winner.category}:${canonicalName}`;
    const sources   = variants.slice(1).map(v => ({ full: v.full, count: v.post_count }));

    // Skip the entire group if the canonical is itself an alias source
    // (would create a chain), is blacklisted, or is in either rejected list.
    if (aliasSources.has(canonical))    continue;
    if (blacklistActive.has(canonical)) continue;

    // Filter sources: drop ones already covered by config or rejected,
    // OR ones whose normalized form already equals the canonical
    // (canonicalize-on-save handles those for free, no alias needed).
    const filteredSources = sources.filter(s =>
      !aliasSources.has(s.full)    &&
      !aliasRejected.has(s.full)   &&
      !blacklistActive.has(s.full) &&
      s.full !== canonical         &&
      normalizeTag(s.full) !== canonical
    );
    if (filteredSources.length === 0) continue;

    // Skip if canonical is already a known canonical AND every source is too —
    // means this group is fully resolved already.
    if (aliasCanonicals.has(canonical) &&
        filteredSources.every(s => aliasCanonicals.has(s.full))) continue;

    const groupCount = variants.reduce((sum, v) => sum + v.post_count, 0);

    for (const s of filteredSources) {
      aliasInserts.push({
        canonical,
        source: s.full,
        group_count: groupCount,
        source_count: s.count,
      });
    }
    aliasGroups++;
  }

  // ============================================================
  // BLACKLIST SUGGESTIONS
  // ============================================================

  const NON_ASCII_RE = /[^\x00-\x7F]/;
  const blacklistInserts = [];

  for (const row of allTags) {
    const ft = fullTag(row.category, row.name);

    // Skip lists
    if (aliasSources.has(ft))    continue;  // already gets canonicalized
    if (blacklistActive.has(ft)) continue;
    if (blacklistReject.has(ft)) continue;

    let reason = null;
    if (NON_ASCII_RE.test(row.name)) {
      reason = 'non-ascii';
    } else if (row.post_count <= 1) {
      reason = 'low-count';
    }
    if (!reason) continue;

    blacklistInserts.push({ tag: ft, reason, post_count: row.post_count });
  }

  // ============================================================
  // COMMIT
  // ============================================================

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_aliases_suggestions').run();
    db.prepare('DELETE FROM config_blacklist_suggestions').run();

    if (aliasInserts.length > 0) {
      const insert = db.prepare(`
        INSERT INTO config_aliases_suggestions (canonical, source, group_count, source_count)
        VALUES (@canonical, @source, @group_count, @source_count)
      `);
      for (const row of aliasInserts) insert.run(row);
    }

    if (blacklistInserts.length > 0) {
      const insert = db.prepare(`
        INSERT INTO config_blacklist_suggestions (tag, reason, post_count)
        VALUES (@tag, @reason, @post_count)
      `);
      for (const row of blacklistInserts) insert.run(row);
    }
  });
  tx();

  const elapsed = Date.now() - t0;
  console.log(
    `[suggester] ${allTags.length} tags scanned, ` +
    `${aliasGroups} alias groups (${aliasInserts.length} sources), ` +
    `${blacklistInserts.length} blacklist candidates, ${elapsed}ms`
  );

  return {
    aliasGroups,
    aliasSourcesCount: aliasInserts.length,
    blacklistCandidates: blacklistInserts.length,
    elapsed,
  };
}

// ============================================================
// Save endpoint helpers
// ============================================================
/**
 * Canonicalize the categorized-tags object that the extension sends.
 * Input  shape: { general: ['raw tag', ...], character: [...], ... }
 * Output shape: same shape but with normalized + alias-resolved +
 *               hierarchy-expanded + blacklist-filtered names. Empty
 *               categories are dropped.
 *
 * Internally flattens to "category:name" strings, calls canonicalize(),
 * then re-buckets by category.
 */
function canonicalizeCategorized(tagsByCategory) {
  if (!tagsByCategory || typeof tagsByCategory !== 'object') return {};

  const flat = [];
  for (const [category, list] of Object.entries(tagsByCategory)) {
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      if (typeof name !== 'string' || !name) continue;
      flat.push(category === 'general' ? name : `${category}:${name}`);
    }
  }

  // canonicalize() returns sorted unique "category:name" strings
  const cleaned = canonicalize(flat);

  const out = {};
  for (const tag of cleaned) {
    const idx = tag.indexOf(':');
    const cat = idx === -1 ? 'general' : tag.slice(0, idx);
    const name = idx === -1 ? tag : tag.slice(idx + 1);
    if (!out[cat]) out[cat] = [];
    out[cat].push(name);
  }
  return out;
}

/**
 * Build the on-disk id from a source URL the same way background.js
 * used to. Domain (no www) + millisecond timestamp.
 *   "https://www.pixiv.net/en/artworks/123" → "pixiv.net_1730000000000"
 * Falls back to "unknown_<ts>" if the URL doesn't parse.
 */
function buildStagingId(sourceUrl) {
  let domain = 'unknown';
  try {
    const u = new URL(sourceUrl);
    if (u.hostname) domain = u.hostname.replace(/^www\./, '');
  } catch { /* keep 'unknown' */ }
  return `${domain}_${Date.now()}`;
}

/**
 * Pick the file extension to write the image bytes under.
 * Prefers explicit hint from the client; falls back to MIME map; last
 * resort .bin.
 */
function pickExtension({ filenameHint, mimeType }) {
  if (filenameHint) {
    const m = /\.([a-z0-9]+)$/i.exec(filenameHint);
    if (m) return '.' + m[1].toLowerCase();
  }
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':           return '.jpg';
    case 'image/png':            return '.png';
    case 'image/gif':            return '.gif';
    case 'image/webp':           return '.webp';
    case 'video/mp4':            return '.mp4';
    case 'video/webm':           return '.webm';
    case 'image/x-ms-bmp':
    case 'image/bmp':            return '.bmp';
    default:                     return '.bin';
  }
}

// ============================================================
// CONFIG — JSON I/O (export + canonize)
// ============================================================

/**
 * Export aliases as the documented JSON shape.
 * Groups all (source, canonical) rows by canonical.
 */
function exportAliases() {
  const rows = db.prepare(
    'SELECT source, canonical FROM config_aliases ORDER BY canonical, source'
  ).all();

  const byCanonical = new Map();
  for (const { source, canonical } of rows) {
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical).push(source);
  }

  const aliases = [];
  for (const [canonical, sources] of byCanonical) {
    aliases.push({ canonical, sources });
  }
  return { aliases };
}

/**
 * Validate + canonize aliases. Atomic — wipes the section then loads
 * from body. If validation fails, throws and DB is unchanged.
 *
 * Errors:
 *   - body shape wrong → 400
 *   - duplicate source under different canonicals → 400 with offender
 */
function canonizeAliases(body) {
  if (!body || !Array.isArray(body.aliases)) {
    throw new HttpError(400, 'Body must be { aliases: [...] }');
  }

  // Validate + flatten in one pass. Track sources to detect dupes.
  const flat = [];
  const seen = new Map();  // source -> canonical
  for (let i = 0; i < body.aliases.length; i++) {
    const entry = body.aliases[i];
    if (!entry || typeof entry.canonical !== 'string' || !entry.canonical) {
      throw new HttpError(400, `aliases[${i}].canonical missing or invalid`);
    }
    if (!Array.isArray(entry.sources)) {
      throw new HttpError(400, `aliases[${i}].sources must be an array`);
    }
    for (let j = 0; j < entry.sources.length; j++) {
      const source = entry.sources[j];
      if (typeof source !== 'string' || !source) {
        throw new HttpError(400, `aliases[${i}].sources[${j}] must be a non-empty string`);
      }
      if (seen.has(source) && seen.get(source) !== entry.canonical) {
        throw new HttpError(400,
          `Duplicate source "${source}" maps to both "${seen.get(source)}" and "${entry.canonical}"`);
      }
      seen.set(source, entry.canonical);
      flat.push([source, entry.canonical]);
    }
  }

  // All clear — write atomically.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_aliases').run();
    const insert = db.prepare(
      'INSERT INTO config_aliases (source, canonical, created_at) VALUES (?, ?, ?)'
    );
    for (const [source, canonical] of flat) insert.run(source, canonical, Date.now());
  });
  tx();

  return { count: flat.length };
}

/**
 * Export hierarchy as the documented JSON shape.
 * Groups (parent, child) rows by parent.
 */
function exportHierarchy() {
  const rows = db.prepare(
    'SELECT parent, child FROM config_hierarchy ORDER BY parent, child'
  ).all();

  const byParent = new Map();
  for (const { parent, child } of rows) {
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(child);
  }

  const hierarchy = [];
  for (const [parent, children] of byParent) {
    hierarchy.push({ parent, children });
  }
  return { hierarchy };
}

/**
 * Validate + canonize hierarchy.
 * Detects cycles via DFS before commit — refuses on cycle with 400.
 */
function canonizeHierarchy(body) {
  if (!body || !Array.isArray(body.hierarchy)) {
    throw new HttpError(400, 'Body must be { hierarchy: [...] }');
  }

  // Build adjacency list while validating
  const adj = new Map();  // parent -> Set<child>
  const flat = [];

  for (let i = 0; i < body.hierarchy.length; i++) {
    const entry = body.hierarchy[i];
    if (!entry || typeof entry.parent !== 'string' || !entry.parent) {
      throw new HttpError(400, `hierarchy[${i}].parent missing or invalid`);
    }
    if (!Array.isArray(entry.children)) {
      throw new HttpError(400, `hierarchy[${i}].children must be an array`);
    }
    if (!adj.has(entry.parent)) adj.set(entry.parent, new Set());
    for (let j = 0; j < entry.children.length; j++) {
      const child = entry.children[j];
      if (typeof child !== 'string' || !child) {
        throw new HttpError(400,
          `hierarchy[${i}].children[${j}] must be a non-empty string`);
      }
      if (child === entry.parent) {
        throw new HttpError(400, `Self-edge: "${entry.parent}" cannot be its own child`);
      }
      adj.get(entry.parent).add(child);
      flat.push([entry.parent, child]);
    }
  }

  // Cycle detection — DFS with three colors (white=unvisited, gray=in
  // progress, black=done). Re-encounter a gray node = cycle.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  // Initialize colors for every node mentioned (parent or child)
  for (const [parent, children] of adj) {
    if (!color.has(parent)) color.set(parent, WHITE);
    for (const c of children) if (!color.has(c)) color.set(c, WHITE);
  }

  function dfs(node, path) {
    color.set(node, GRAY);
    path.push(node);
    const children = adj.get(node);
    if (children) {
      for (const c of children) {
        const cc = color.get(c);
        if (cc === GRAY) {
          // Cycle found — extract the cycle path for a useful error.
          const startIdx = path.indexOf(c);
          const cyclePath = path.slice(startIdx).concat(c).join(' → ');
          throw new HttpError(400, `Cycle detected: ${cyclePath}`);
        } else if (cc === WHITE) {
          dfs(c, path);
        }
      }
    }
    color.set(node, BLACK);
    path.pop();
  }

  for (const node of color.keys()) {
    if (color.get(node) === WHITE) dfs(node, []);
  }

  // All clear — commit
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_hierarchy').run();
    const insert = db.prepare(
      'INSERT INTO config_hierarchy (parent, child) VALUES (?, ?)'
    );
    for (const [parent, child] of flat) insert.run(parent, child);
  });
  tx();

  return { count: flat.length };
}

/**
 * Export blacklist as the documented JSON shape.
 */
function exportBlacklist() {
  const rows = db.prepare(
    'SELECT tag FROM config_blacklist ORDER BY tag'
  ).all();
  return { blacklist: rows.map(r => r.tag) };
}

/**
 * Validate + canonize blacklist.
 */
function canonizeBlacklist(body) {
  if (!body || !Array.isArray(body.blacklist)) {
    throw new HttpError(400, 'Body must be { blacklist: [...] }');
  }

  const seen = new Set();
  for (let i = 0; i < body.blacklist.length; i++) {
    const tag = body.blacklist[i];
    if (typeof tag !== 'string' || !tag) {
      throw new HttpError(400, `blacklist[${i}] must be a non-empty string`);
    }
    seen.add(tag);
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM config_blacklist').run();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO config_blacklist (tag) VALUES (?)'
    );
    for (const tag of seen) insert.run(tag);
  });
  tx();

  return { count: seen.size };
}

// ============================================================
// CONFIG — canonicalize pipeline
// ============================================================

/**
 * Canonical normalization for raw tag strings.
 *   - toLowerCase
 *   - spaces collapsed to underscores
 *
 * Applied to the NAME portion only. The category prefix (everything
 * before the first ':') is preserved as-is.
 *
 * Example:
 *   "Character:Elira Pendora" → "character:elira_pendora"
 *   "Dizzy Dokuro"            → "dizzy_dokuro"
 */
function normalizeTag(tag) {
  if (typeof tag !== 'string' || !tag) return tag;
  if (tag.includes(':')) {
    const [category, ...rest] = tag.split(':');
    const name = rest.join(':')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_');
    return `${category.toLowerCase()}:${name}`;
  }
  return tag.toLowerCase().trim().replace(/\s+/g, '_');
}

/**
 * Apply alias → hierarchy → blacklist transformations to a tag list.
 * Returns a new sorted, deduped array of "category:name" strings.
 *
 * Pure function over DB state — for a given DB snapshot, the same
 * input always produces the same output.
 */
function canonicalize(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return [];

  // ---------- Step 1: Alias ----------
  // Look up each raw input through config_aliases. If matched, replace
  // with the canonical form. If not, keep as-is (already canonical or
  // simply unknown).
  //
  // Aliases are stored with the source as PK — exact match. We don't
  // case-fold or whitespace-collapse on the lookup; the source must
  // match what the user typed. (If you want fuzzy matching, that's a
  // step 9.5 feature.)
  const aliasLookup = db.prepare(
    'SELECT canonical FROM config_aliases WHERE source = ?'
  );

  const afterAlias = new Set();
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag) continue;
    const normalized = normalizeTag(tag);
    const hit = aliasLookup.get(tag) || aliasLookup.get(normalized);
    afterAlias.add(hit ? hit.canonical : normalized);
  }
  // ---------- Step 2: Hierarchy ----------
  // For each tag in `afterAlias`:
  //   (a) walk ancestors transitively, accumulate
  //   (b) pull direct children where category prefix is "meta:"
  //
  // Ancestor walk uses a visited set to defend against cycles even
  // though canonize-time validation should prevent them.

  const ancestorOf = db.prepare(
    'SELECT parent FROM config_hierarchy WHERE child = ?'
  );
  const childrenOf = db.prepare(
    'SELECT child FROM config_hierarchy WHERE parent = ?'
  );

  const expanded = new Set(afterAlias);
  for (const tag of afterAlias) {
    // (a) ancestors
    const queue = [tag];
    const visited = new Set([tag]);
    while (queue.length > 0) {
      const cur = queue.shift();
      const parents = ancestorOf.all(cur).map(r => r.parent);
      for (const p of parents) {
        if (visited.has(p)) continue;
        visited.add(p);
        expanded.add(p);
        queue.push(p);
      }
    }
    // (b) direct meta children of the original tag (not of the
    // ancestors — that would defeat the "phase_connect alone shouldn't
    // drag in dizzy" invariant).
    const directChildren = childrenOf.all(tag).map(r => r.child);
    for (const c of directChildren) {
      if (c.startsWith('meta:')) expanded.add(c);
    }
  }

  // ---------- Step 3: Blacklist ----------
  // Drop anything in config_blacklist. Done as a single IN query for
  // efficiency — even though we then filter in-memory.
  const blacklistRows = db.prepare(
    'SELECT tag FROM config_blacklist'
  ).all();
  const blacklist = new Set(blacklistRows.map(r => r.tag));

  const filtered = [...expanded].filter(t => !blacklist.has(t));

  // Stable sort for deterministic output (helps diff sidecars cleanly)
  filtered.sort();
  return filtered;
}

function handleConfigError(err, res) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else {
    console.error('Config endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Tiny error class so route handlers can convert status+message to a
 * proper HTTP response. Anything not throwing HttpError → 500.
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Parse tag into category and name
 */
function parseTagName(tag) {
  if (tag && tag.includes(':')) {
    const [category, ...rest] = tag.split(':');
    return { category, name: rest.join(':') };
  }
  return { category: 'general', name: tag || '' };
}

// ============================================
// STAGING AREA MANAGEMENT
// ============================================

/**
 * Scan staging directory and return image metadata
 */
async function scanStagingDirectory(limit = 50, offset = 0, sort = 'newest', uploadFilter = 'all') {
  let orderBy;
  switch (sort) {
    case 'oldest':    orderBy = 'timestamp ASC, id ASC'; break;
    case 'tags-desc': orderBy = 'tag_count DESC, timestamp DESC'; break;
    case 'tags-asc':  orderBy = 'tag_count ASC, timestamp DESC'; break;
    case 'newest':
    default:          orderBy = 'timestamp DESC, id DESC'; break;
  }

  // Upload-state filter — applied to both COUNT and SELECT so hasMore stays correct.
  let whereClause = '';
  if      (uploadFilter === 'pending')  whereClause = 'WHERE booru_post_id IS NULL OR booru_post_id = -1';
  else if (uploadFilter === 'uploaded') whereClause = 'WHERE booru_post_id >= 0';

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM staging_images ${whereClause}`
  ).get().c;

  const rows = db.prepare(`
    SELECT
      id, json_path, image_path, filename, source_url, image_hash,
      media_type, pool_id, pool_index,
      booru_upload_id, booru_media_asset_id, booru_post_id,
      timestamp, tag_count
    FROM staging_images
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  if (rows.length === 0) {
    return { images: [], hasMore: false, total };
  }

  // 3. Tags for the page in one query. Aggregate the joined rows by
  // image_id so we get { id -> ["category:name", ...] }.
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const tagRows = db.prepare(`
    SELECT
      sit.image_id AS image_id,
      st.category AS category,
      st.name AS name
    FROM staging_image_tags sit
    JOIN staging_tags st ON st.id = sit.tag_id
    WHERE sit.image_id IN (${placeholders})
  `).all(...ids);

  const tagsByImage = new Map();
  for (const tr of tagRows) {
    if (!tagsByImage.has(tr.image_id)) tagsByImage.set(tr.image_id, []);
    tagsByImage.get(tr.image_id).push(
      tr.category === 'general' ? tr.name : `${tr.category}:${tr.name}`
    );
  }

  // 4. Map to the same response shape scanStagingDirectory used to return.
  const images = rows.map(r => {
    const pid = r.booru_post_id;
    const booruPostState =
      pid === null ? 'pending' :
      pid === -1   ? 'errored' :
      pid === 0    ? 'duplicate' :
      'posted';
    return {
      id: r.id,
      filename: r.filename || path.basename(r.image_path || r.json_path),
      filePath: r.image_path,
      jsonPath: r.json_path,
      tags: tagsByImage.get(r.id) || [],
      tagCount: r.tag_count,
      sourceUrl: r.source_url,
      imageUrl: r.image_path,
      poolId: r.pool_id,
      poolIndex: r.pool_index,
      phash: r.image_hash,
      mediaType: r.media_type || 'image',
      timestamp: r.timestamp,
      booruUploadId: r.booru_upload_id,
      booruPostId: pid > 0 ? pid : null,
      booruPostState,
      booruPublicUrl: pid > 0 ? `${BOORU_PUBLIC_URL}/posts/${pid}` : null,
    };
  });

  return {
    images,
    hasMore: offset + limit < total,
    total,
  };
}

/**
 * Extract a frame from a video and save as JPEG.
 * Output path:   stagingDir/.thumbs/${id}.jpg
 * Source frame:  1 second in (or last frame if shorter)
 * Sizing:        fits inside size×size, preserves aspect ratio
 *
 * Returns the path to the cached thumbnail. Throws on ffmpeg failure.
 */
async function extractVideoThumbnail(videoPath, id, size = 200) {
  await fs.mkdir(serverConfig.thumbsDir, { recursive: true });
  const outPath = path.join(serverConfig.thumbsDir, `${id}.jpg`);

  // Probe duration first. Some clips (rule34, Twitter shorts) are
  // under a second long. A naive `-ss 1` against a 0.66s clip seeks
  // past the end, yields zero frames, and ffmpeg cheerfully exits 0
  // having written nothing — which then trips Sharp downstream.
  const duration = await probeDuration(videoPath);
  // Aim for ~10% into the clip, capped at 1s, floored at 0. The
  // small offset avoids the very first frame which is sometimes
  // black/blank from encoder warmup.
  const seekTime = Math.max(0, Math.min(1, duration * 0.1));

  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(seekTime),
      '-i', videoPath,
      '-frames:v', '1',
      // First scale: aspect-preserving fit into size×size box.
      // Second scale: force even dimensions (MJPEG/yuvj420p needs them).
      // format=yuvj420p: explicit JPEG-range pixel format for the encoder.
      '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p`,
      '-q:v', '2',
      '-y',
      outPath,
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    proc.on('close', async code => {
      if (code !== 0) {
        const tail = stderr.split('\n').slice(-10).join('\n');
        reject(new Error(`ffmpeg exited ${code}: ${tail}`));
        return;
      }
      // ffmpeg can exit 0 having produced no output (e.g. -ss past
      // end of stream). Verify a real file exists before declaring
      // success — otherwise Sharp downstream will trip with "Input
      // file is missing" and we'll have wasted everyone's time
      // debugging the wrong layer.
      try {
        const stat = await fs.stat(outPath);
        if (stat.size === 0) {
          reject(new Error(`ffmpeg produced empty thumbnail (likely -ss ${seekTime}s past end of ${duration}s clip)`));
          return;
        }
        resolve(outPath);
      } catch (err) {
        reject(new Error(`ffmpeg exited 0 but no output file produced (likely seek past end; duration=${duration}s, seek=${seekTime}s)`));
      }
    });
  });
}

/**
 * Get a video's duration in seconds via ffprobe. Returns 0 on any
 * failure so the caller can pick a sensible default seek time
 * without crashing.
 */
async function probeDuration(videoPath) {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let stdout = '';
    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.on('close', () => {
      const dur = parseFloat(stdout.trim());
      resolve(Number.isFinite(dur) ? dur : 0);
    });
    proc.on('error', () => resolve(0));
  });
}

/**
 * Load a single staging image's full metadata, sourced from the DB.
 * Returns null if the row doesn't exist.
 */
async function loadStagingImage(id) {
  const row = db.prepare(`
    SELECT
      id, json_path, image_path, filename, source_url, image_hash,
      media_type, pool_id, pool_index,
      booru_upload_id, booru_media_asset_id, booru_post_id,
      timestamp, tag_count
    FROM staging_images
    WHERE id = ?
  `).get(id);

  if (!row) return null;

  // Tags: same shape as the list endpoint returns. Single JOIN.
  const tagRows = db.prepare(`
    SELECT st.category, st.name
    FROM staging_image_tags sit
    JOIN staging_tags st ON st.id = sit.tag_id
    WHERE sit.image_id = ?
  `).all(id);

  const tags = tagRows.map(t =>
    t.category === 'general' ? t.name : `${t.category}:${t.name}`
  );

  return {
    id: row.id,
    filename: row.filename || path.basename(row.image_path || row.json_path),
    filePath: row.image_path,
    jsonPath: row.json_path,
    tags,
    tagCount: row.tag_count,
    sourceUrl: row.source_url,
    imageUrl: row.image_path,
    poolId: row.pool_id,
    poolIndex: row.pool_index,
    phash: row.image_hash,
    mediaType: row.media_type || 'image',
    timestamp: row.timestamp,
    booruUploadId: row.booru_upload_id,
    booruMediaAssetId: row.booru_media_asset_id,
    booruPostId: row.booru_post_id,
  };
}

/**
 * Update staging image metadata
 */
async function updateStagingImage(id, updates) {
  const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
  
  try {
    // Load existing data
    const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    
    // Update fields
    if (updates.sourceUrl !== undefined) jsonData.sourceUrl = updates.sourceUrl;
    if (updates.poolId !== undefined) jsonData.poolId = updates.poolId;
    if (updates.poolIndex !== undefined) jsonData.poolIndex = updates.poolIndex;
    
    // Handle tags - convert to categorized format
    if (updates.tags !== undefined) {
      const canonicalTags = canonicalize(updates.tags);
      const categorized = {
        artist: [],
        character: [],
        copyright: [],
        general: [],
        meta: []
      };
      
      for (const tag of canonicalTags) {
        const { category, name } = parseTagName(tag);
        if (categorized[category]) {
          categorized[category].push(name);
        } else {
          categorized.general.push(tag);
        }
      }
      
      jsonData.tags = categorized;
    }
    
    // Write back
    await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2));
    await syncSidecarToDb(id);

    return true;
  } catch (error) {
    console.error(`Error updating staging image ${id}:`, error);
    return false;
  }
}

/**
 * Delete staging image (move to trash)
 */
async function deleteStagingImage(id) {
  try {
    const movedAny = await moveImageToTrash(id);
    if (!movedAny) {
      console.warn(`[delete] no files found for ${id}`);
      return false;
    }
    removeStagingFromDb(id);
    return true;
  } catch (error) {
    console.error(`Error deleting staging image ${id}:`, error);
    return false;
  }
}

/**
 * Move one image's sidecar + image file to the trash directory.
 * Idempotent enough for batch use — missing files don't throw.
 * Returns true if at least one file was moved.
 */
async function moveImageToTrash(id) {
  await fs.mkdir(serverConfig.trashDir, { recursive: true });

  const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
  const baseName = jsonPath.replace(/\.json$/, '');
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];

  let movedAny = false;

  // JSON sidecar
  try {
    await fs.rename(jsonPath, path.join(serverConfig.trashDir, `${id}.json`));
    movedAny = true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[trash] JSON move failed for ${id}: ${err.message}`);
    }
  }

  // Image file (whichever extension exists)
  for (const ext of imageExts) {
    const src = baseName + ext;
    try {
      await fs.access(src);
      await fs.rename(src, path.join(serverConfig.trashDir, `${id}${ext}`));
      movedAny = true;
      break;
    } catch (err) {
      // ENOENT just means this extension doesn't apply, try next
    }
  }

  // Also nuke the thumbnail cache for this id
  try {
    await fs.unlink(path.join(serverConfig.thumbsDir, `${id}.jpg`));
  } catch {}  // not cached, fine

  return movedAny;
}

/**
 * Load everything we need to upload one staging item:
 *   - raw categorized JSON (uploader.processTags expects this shape)
 *   - the matching image file path
 *
 * Throws if the JSON is missing/unreadable or no image with a known
 * extension sits next to it. The route turns these into per-id failures.
 */
async function loadBooruJob(id) {
  const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
  const metadata = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
 
  const baseName = jsonPath.replace(/\.json$/, '');
  for (const ext of BOORU_IMAGE_EXTS) {
    const candidate = baseName + ext;
    try {
      await fs.access(candidate);
      return { id, jsonPath, imagePath: candidate, metadata };
    } catch {
      // try next extension
    }
  }
  throw new Error('Image file not found');
}
 
/**
 * Resolve body into a flat list of staging IDs.
 * Returns [] if nothing to upload (route validates inputs upstream).
 */
async function resolveBooruTargetIds({ ids, all, force }) {
  if (Array.isArray(ids) && ids.length > 0) return ids;
  if (!all) return [];
 
  const files = glob.sync(`${serverConfig.stagingDir}/**/*.json`).filter(f => !f.includes('.trash'));
  const out = [];
  for (const file of files) {
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      if (force || json.booruPostId === undefined || json.booruPostId === -1) {
        out.push(path.basename(file, '.json'));
      }
    } catch {
      // skip unreadable
    }
  }
  return out;
}

 
/**
 * For each pool we're about to upload into, find an already-uploaded
 * sibling outside this batch — its post ID becomes the parent_id.
 */
async function findExistingPoolParents(poolIds) {
  if (poolIds.size === 0) return new Map();
 
  const files = glob.sync(`${serverConfig.stagingDir}/**/*.json`).filter(f => !f.includes('.trash'));
  const candidates = new Map(); // poolId -> { postId, poolIndex }
 
  for (const file of files) {
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!poolIds.has(json.poolId) || !json.booruPostId) continue;
 
      const idx = json.poolIndex ?? 0;
      const existing = candidates.get(json.poolId);
      if (!existing || idx < existing.poolIndex) {
        candidates.set(json.poolId, { postId: json.booruPostId, poolIndex: idx });
      }
    } catch {
      // skip unreadable
    }
  }
 
  const out = new Map();
  for (const [poolId, info] of candidates) out.set(poolId, info.postId);
  return out;
}

 
function groupAndOrderByPool(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.metadata.poolId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.metadata.poolIndex ?? 0) - (b.metadata.poolIndex ?? 0));
  }
  return groups;
}
 
/**
 * Validate body shape. Returns null if OK, or an error message.
 * Both routes call this before doing anything else.
 */
function validateBooruUploadBody(body) {
  const { ids, all = false } = body || {};
  if (Array.isArray(ids) && ids.length > 0) return null;
  if (all) return null;
  return 'Body must include `ids` array or `all: true`';
}

/**
 * Run an upload batch. Calls onProgress (if provided) at three phases:
 *   { phase: 'start', total }
 *   { phase: 'item',  completed, total, result }   -- once per id
 *   { phase: 'done',  total, succeeded, failed }
 *
 * Returns the same summary object the bulk JSON endpoint responds with.
 * Body is assumed valid (route layer validates).
 */
/**
 * UPLOAD-ONLY pass. For each target id:
 *   - Skip if already has booruUploadId (idempotent on restarts).
 *   - Call /uploads.json.
 *   - Write booruUploadId + booruMediaAssetId to the sidecar.
 *   - Emit SSE progress.
 *
 * Posting is the worker's job. This function returns once all uploads
 * are done.
 */
async function runBooruUploads({ ids, all, force }, onProgress) {
  const emit = onProgress || (() => {});
  const results = [];
  let completed = 0;

  const targetIds = await resolveBooruTargetIds({ ids, all, force });
  const total = targetIds.length;

  emit({ phase: 'start', total });

  if (total === 0) {
    emit({ phase: 'done', total: 0, succeeded: 0, failed: 0 });
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  for (const id of targetIds) {
    let result;
    try {
      const job = await loadBooruJob(id);

      if (job.metadata.booruUploadId && !force) {
        result = {
          id, success: true,
          uploadAssetId: job.metadata.booruUploadId,
          alreadyUploaded: true,
        };
      } else {
        const { uploadAssetId, mediaAssetId } =
          await booruUploader.uploadFileOnly(job.imagePath);

        job.metadata.booruUploadId = uploadAssetId;
        job.metadata.booruMediaAssetId = mediaAssetId;
        await fs.writeFile(job.jsonPath, JSON.stringify(job.metadata, null, 2));
        await syncSidecarToDb(id);

        result = {
          id, success: true,
          uploadAssetId,
          mediaAssetId,
          alreadyUploaded: false,
        };
      }
    } catch (err) {
      result = {
        id, success: false,
        error: err.message,
        phase: err.phase,
        status: err.status,
        body: err.body,
      };
    }

    results.push(result);
    completed++;
    emit({ phase: 'item', completed, total, result });

    if (completed < total) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  emit({ phase: 'done', total, succeeded, failed });

  return { total, succeeded, failed, results };
}

// ============================================================
// POST WORKER — runs concurrently with uploads, processes the
// "uploaded but not posted" backlog from sidecars.
// ============================================================

const POST_WORKER = {
  running: false,
  scheduled: false,
  pendingScope: null, 
  POLITENESS_GAP_MS: 500,
  MAINTENANCE_INTERVAL_MS: 60 * 60 * 1000,
  get DUPLICATE_LOG() {
    return path.join(serverConfig.stagingDir, 'duplicate-failures.log');
  },
};

/**
 * Find sidecars that have been uploaded but not yet posted.
 * Sorted so pool members are grouped and ordered by poolIndex.
 */
async function findPendingPosts(scopeIds = null, { skipFailed = false } = {}) {
  const files = glob.sync(`${serverConfig.stagingDir}/**/*.json`).filter(f => !f.includes('.trash'));
  const scopeSet = scopeIds ? new Set(scopeIds) : null;
  const pending = [];

  for (const file of files) {
    try {
      const id = path.basename(file, '.json');
      if (scopeSet && !scopeSet.has(id)) continue;
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      
      if (!json.booruUploadId || !json.booruMediaAssetId) continue;
      const isFailed = json.booruPostId === -1;
      const isNew   = json.booruPostId === undefined;
      if (isNew || (isFailed && !skipFailed)) {
        pending.push({ jsonPath: file, id, metadata: json });
      }
    } catch {
      // skip unreadable
    }
  }

  pending.sort((a, b) => {
    const aPool = a.metadata.poolId || '';
    const bPool = b.metadata.poolId || '';
    if (aPool !== bPool) return aPool.localeCompare(bPool);
    return (a.metadata.poolIndex ?? 0) - (b.metadata.poolIndex ?? 0);
  });

  return pending;
}

/** Pull a Danbooru post ID from a 422 duplicate error body. */
function extractDuplicatePostId(body) {
  if (!body) return null;
  const md5Errs = body.errors?.md5;
  if (Array.isArray(md5Errs)) {
    for (const msg of md5Errs) {
      const match = String(msg).match(/\/posts\/(\d+)|post #(\d+)/);
      if (match) return parseInt(match[1] || match[2], 10);
    }
  }
  if (body.post_id) return parseInt(body.post_id, 10);
  return null;
}

/** Append one line to the duplicate-failures log. Best-effort. */
async function logDuplicateFailure(filename, errBody) {
  try {
    const conflictId = extractDuplicatePostId(errBody);
    const line = [
      new Date().toISOString(),
      filename,
      conflictId ? `duplicate_of=${conflictId}` : 'duplicate_unknown',
      JSON.stringify(errBody || {}),
    ].join('\t') + '\n';
    await fs.appendFile(POST_WORKER.DUPLICATE_LOG, line);
  } catch (err) {
    console.error('Failed to write duplicate log:', err.message);
  }
}

/** One worker tick — drains the pending queue once. */
async function postWorkerTick(scopeIds = null, { skipFailed = false } = {}) {
  if (POST_WORKER.running) {
    POST_WORKER.scheduled = true;
    // Merge scopes for the next run. null is "broadest" — once any
    // caller passes null, the next tick runs unscoped.
    if (scopeIds === null) {
      POST_WORKER.pendingScope = null;
    } else if (POST_WORKER.pendingScope !== null) {
      if (!(POST_WORKER.pendingScope instanceof Set)) {
        POST_WORKER.pendingScope = new Set();
      }
      for (const id of scopeIds) POST_WORKER.pendingScope.add(id);
    }
    if (!skipFailed) POST_WORKER.pendingSkipFailed = false;
    return;
  }
  POST_WORKER.running = true;

  try {
    const pending = await findPendingPosts(scopeIds, { skipFailed });
    if (pending.length === 0) return;

    console.log(
      `[booru-postman] processing ${pending.length} pending posts` +
      (scopeIds ? ` (scoped: ${scopeIds.length})` : ' (all)')
    );

    const poolParents = new Map();

    for (const { id, jsonPath, metadata: initialMetadata } of pending) {
      let metadata = initialMetadata;
      try {
        const generalCount = Array.isArray(metadata.tags?.general)
          ? metadata.tags.general.length : 0;
        if (generalCount < 10) {
          const camieResult = await maybeCamieTagId(id);
          if (camieResult.tagged) {
            metadata = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
            console.log(`[booru-postman] camie added ${camieResult.added} tags to ${id} before post`);
          }
        }

        const poolId = metadata.poolId;
        let parentId = null;
        if (poolId) {
          if (poolParents.has(poolId)) {
            parentId = poolParents.get(poolId);
          } else {
            const existing = await findExistingPoolParents(new Set([poolId]));
            parentId = existing.get(poolId) ?? null;
          }
        }

        let postId;
        try {
          postId = await booruUploader.createPostFromAsset(
            metadata.booruUploadId, metadata, parentId
          );
        } catch (err) {
          // 422 with an extractable existing post id means Danbooru already has
          // this image. Adopt the existing post id rather than forcing a second
          // copy via bypass_dnp.
          const existingId = err.phase === 'post' && err.status === 422
            ? extractDuplicatePostId(err.body)
            : null;

          if (existingId !== null) {
            postId = existingId;
            console.log(`[booru-postman] adopting existing post #${existingId} for ${id} (already on booru)`);
          } else {
            throw err;
          }
        }

        if (postId === null) { console.log(`[booru-postman] duplicate-skipped for ${id} (200 OK)`); }
        metadata.booruPostId = postId;
        await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2));
        await syncSidecarToDb(id);
        if (poolId && !poolParents.has(poolId)) poolParents.set(poolId, postId);
      } catch (err) {
        console.error(`[booru-postman] failed to post ${id}:`, err.message);
        try {
          metadata.booruPostId = -1;
          await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2));
          await syncSidecarToDb(id);
        } catch (writeErr) {
          console.error(`[booru-postman] failed to mark ${id} as errored:`, writeErr.message);
        }
      }
      await new Promise(r => setTimeout(r, POST_WORKER.POLITENESS_GAP_MS));
    }

    console.log('[booru-postman] work tick complete');
  } finally {
    POST_WORKER.running = false;
    if (POST_WORKER.scheduled) {
      POST_WORKER.scheduled = false;
      const nextScope = POST_WORKER.pendingScope;
      const nextSkipFailed = POST_WORKER.pendingSkipFailed ?? true;
      POST_WORKER.pendingScope = null;
      POST_WORKER.pendingSkipFailed = true;
      const scopeArg = nextScope instanceof Set ? [...nextScope] : null;
      setImmediate(() => postWorkerTick(scopeArg, { skipFailed: nextSkipFailed }));
    }
  }
}

/** Public entry — coalesces concurrent calls. */
function kickPostWorker(scopeIds = null, opts = {}) {
  postWorkerTick(scopeIds, opts).catch(err => console.error('[booru-postman] tick threw:', err));
}

// Maintenance: catch any sidecars uploaded outside the SSE flow.
setInterval(() => kickPostWorker(null, { skipFailed: true }), POST_WORKER.MAINTENANCE_INTERVAL_MS);

// ============================================================
// CONFIG — suggester routes
// ============================================================

// Trigger an analysis run.
app.post('/api/config/suggestions/analyze', (req, res) => {
  try {
    const result = runSuggesterAnalysis();
    tagCache.invalidate();   // counts may have changed implicitly; harmless
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Suggester analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Paginated alias suggestions, grouped by canonical.
//   ?limit=50&offset=0
app.get('/api/config/suggestions/aliases', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 500));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // Get distinct canonicals, paginated. Then load all sources for
    // those canonicals.
    const canonicals = db.prepare(`
      SELECT canonical, MAX(group_count) AS group_count
      FROM config_aliases_suggestions
      GROUP BY canonical
      ORDER BY group_count DESC, canonical ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = db.prepare(
      'SELECT COUNT(DISTINCT canonical) AS c FROM config_aliases_suggestions'
    ).get().c;

    if (canonicals.length === 0) {
      return res.json({ groups: [], total, limit, offset });
    }

    const placeholders = canonicals.map(() => '?').join(',');
    const sources = db.prepare(`
      SELECT canonical, source, source_count
      FROM config_aliases_suggestions
      WHERE canonical IN (${placeholders})
      ORDER BY source_count DESC, source ASC
    `).all(...canonicals.map(c => c.canonical));

    const sourcesByCanonical = new Map();
    for (const s of sources) {
      if (!sourcesByCanonical.has(s.canonical)) sourcesByCanonical.set(s.canonical, []);
      sourcesByCanonical.get(s.canonical).push({ source: s.source, count: s.source_count });
    }

    const groups = canonicals.map(c => ({
      canonical: c.canonical,
      group_count: c.group_count,
      sources: sourcesByCanonical.get(c.canonical) || [],
    }));

    res.json({ groups, total, limit, offset });
  } catch (err) {
    console.error('Suggester list aliases error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Accept an alias suggestion. Body: { canonical: "...", sources: [...] }
// (The full group, or a subset if user only wants some sources.)
app.post('/api/config/suggestions/aliases/accept', (req, res) => {
  try {
    const { canonical, sources } = req.body || {};
    if (typeof canonical !== 'string' || !canonical) {
      return res.status(400).json({ error: 'canonical required' });
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({ error: 'sources must be non-empty array' });
    }

    const tx = db.transaction(() => {
      const insertAlias = db.prepare(`
        INSERT OR REPLACE INTO config_aliases (source, canonical, created_at) VALUES (?, ?, ?)
      `);
      const removeSugg = db.prepare(`
        DELETE FROM config_aliases_suggestions
        WHERE canonical = ? AND source = ?
      `);
      for (const source of sources) {
        if (typeof source !== 'string' || !source) continue;
        insertAlias.run(source, canonical, Date.now());
        removeSugg.run(canonical, source);
      }
    });
    tx();
    tagCache.invalidate();

    res.json({ success: true, count: sources.length });
  } catch (err) {
    console.error('Suggester accept aliases error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reject an alias suggestion. Body: { canonical: "...", sources: [...] }
// Sources go to the rejected table so they don't re-surface next analyze.
app.post('/api/config/suggestions/aliases/reject', (req, res) => {
  try {
    const { canonical, sources } = req.body || {};
    if (typeof canonical !== 'string' || !canonical) {
      return res.status(400).json({ error: 'canonical required' });
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({ error: 'sources must be non-empty array' });
    }

    const tx = db.transaction(() => {
      const insertReject = db.prepare(
        'INSERT OR IGNORE INTO config_aliases_rejected (source) VALUES (?)'
      );
      const removeSugg = db.prepare(`
        DELETE FROM config_aliases_suggestions
        WHERE canonical = ? AND source = ?
      `);
      for (const source of sources) {
        if (typeof source !== 'string' || !source) continue;
        insertReject.run(source);
        removeSugg.run(canonical, source);
      }
    });
    tx();

    res.json({ success: true, count: sources.length });
  } catch (err) {
    console.error('Suggester reject aliases error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Paginated blacklist suggestions.
app.get('/api/config/suggestions/blacklist', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 500));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const items = db.prepare(`
      SELECT tag, reason, post_count
      FROM config_blacklist_suggestions
      ORDER BY post_count DESC, tag ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = db.prepare(
      'SELECT COUNT(*) AS c FROM config_blacklist_suggestions'
    ).get().c;

    res.json({ items, total, limit, offset });
  } catch (err) {
    console.error('Suggester list blacklist error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Accept blacklist suggestion(s). Body: { tags: [...] }
app.post('/api/config/suggestions/blacklist/accept', (req, res) => {
  try {
    const { tags } = req.body || {};
    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: 'tags must be non-empty array' });
    }

    const tx = db.transaction(() => {
      const insertBl = db.prepare(
        'INSERT OR IGNORE INTO config_blacklist (tag) VALUES (?)'
      );
      const removeSugg = db.prepare(
        'DELETE FROM config_blacklist_suggestions WHERE tag = ?'
      );
      for (const tag of tags) {
        if (typeof tag !== 'string' || !tag) continue;
        insertBl.run(tag);
        removeSugg.run(tag);
      }
    });
    tx();
    tagCache.invalidate();

    res.json({ success: true, count: tags.length });
  } catch (err) {
    console.error('Suggester accept blacklist error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reject blacklist suggestion(s). Body: { tags: [...] }
app.post('/api/config/suggestions/blacklist/reject', (req, res) => {
  try {
    const { tags } = req.body || {};
    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: 'tags must be non-empty array' });
    }

    const tx = db.transaction(() => {
      const insertReject = db.prepare(
        'INSERT OR IGNORE INTO config_blacklist_rejected (tag) VALUES (?)'
      );
      const removeSugg = db.prepare(
        'DELETE FROM config_blacklist_suggestions WHERE tag = ?'
      );
      for (const tag of tags) {
        if (typeof tag !== 'string' || !tag) continue;
        insertReject.run(tag);
        removeSugg.run(tag);
      }
    });
    tx();

    res.json({ success: true, count: tags.length });
  } catch (err) {
    console.error('Suggester reject blacklist error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Route — place near the other /api/staging routes
// ============================================================
 
// Bulk JSON response (back-compat with v1).
app.post('/api/staging/upload-to-booru', async (req, res) => {
  const validationError = validateBooruUploadBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
 
  try {
    const { ids, all = false, force = false } = req.body;
    const summary = await runBooruUploads({ ids, all, force });
    kickPostWorker(all ? null : (ids || []));
    res.json(summary);
  } catch (err) {
    console.error('Error in upload-to-booru:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/manga/download — accept a fully-resolved manga bundle
// and stream progress as SSE.
//
// Body shape:
//   {
//     source:    'nhentai' | 'hentainexus' | ...,
//     galleryId: string,                       // optional, for logging/dedup display
//     metadata: {
//       title:           string,               // required
//       titleJapanese:   string,               // optional
//       artists:         string[],
//       parodies:        string[],
//       characters:      string[],             // optional, not in ComicInfo
//       tags:            string[],
//       language:        string,
//       pageCount:       number,
//       chapter:         number,               // default 1
//       sourceUrl:       string,
//       description:     string,               // optional
//     },
//     pages: [{ url: string, referer?: string }, ...]   // required, ≥1
//   }
//
// Streams text/event-stream:
//   event: start         { total }
//   event: fetch         { completed, total }     // per-page progress
//   event: archive       { stage: 'building' }
//   event: done          { cbzPath, bytes, pageCount }
//   event: error         { error, code? }
//   event: duplicate     { existing }             // sent INSTEAD of done if dedup hits
//
// SSE rather than plain JSON because hentainexus chapters can take
// a while and we want the UI to show per-page progress, same as the
// booru upload stream.
app.post('/api/manga/download', express.json({ limit: '1mb' }), async (req, res) => {
  // Set up SSE BEFORE any validation so errors flow through the
  // event stream rather than as opaque connection drops.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Cancel propagation: if the client disconnects, abort the fetch.
  const abortController = new AbortController();
  req.on('aborted', () => {
    console.log('[manga] client aborted');
    abortController.abort();
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log('[manga] response closed before end');
      abortController.abort();
    }
  });

  const bundle = req.body || {};
  const sourceLabel = bundle.source || 'unknown';
  const titleLabel = bundle.metadata?.title || '(untitled)';
  console.log(`[manga] download request: ${sourceLabel} / ${titleLabel} / ${bundle.pages?.length ?? '?'} pages`);

  try {
    send('start', { total: bundle.pages?.length || 0 });

    const result = await downloadManga({
      db,
      mangaDir: serverConfig.mangaDir,
      bundle,
      signal: abortController.signal,
      onProgress: ({ phase, completed, total }) => {
        if (phase === 'fetch') {
          send('fetch', { completed, total });
        } else if (phase === 'archive') {
          send('archive', { stage: completed === 0 ? 'building' : 'done' });
        }
      },
    });

    send('done', {
      cbzPath: result.cbzPath,
      bytes: result.bytes,
      pageCount: result.pageCount,
    });
    res.end();
    console.log(`[manga] saved: ${result.cbzPath} (${result.pageCount} pages, ${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);

  } catch (err) {
    if (err.code === 'EDUPLICATE') {
      send('duplicate', { existing: err.existing });
      res.end();
      console.log(`[manga] duplicate: ${titleLabel}`);
      return;
    }
    if (err.name === 'AbortError') {
      send('error', { error: 'Cancelled by client', code: 'ECANCELLED' });
      res.end();
      console.log(`[manga] cancelled: ${titleLabel}`);
      return;
    }
    console.error('[manga] download failed:', err);
    send('error', { error: err.message, code: err.code || 'EUNKNOWN' });
    res.end();
  }
});

app.post('/api/manga/upload', mangaUpload.array('pages', 500), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No pages uploaded' });
    }
    if (!req.body.metadata) {
      return res.status(400).json({ success: false, error: 'Missing metadata field' });
    }

    let metadata;
    try {
      metadata = JSON.parse(req.body.metadata);
    } catch (err) {
      return res.status(400).json({ success: false, error: `Bad metadata JSON: ${err.message}` });
    }
    if (!metadata.title) {
      return res.status(400).json({ success: false, error: 'metadata.title is required' });
    }

    // Defense-in-depth: sort by originalname. The client zero-pads,
    // so localeCompare gives correct numeric order.
    const pages = [...req.files].sort((a, b) =>
      a.originalname.localeCompare(b.originalname)
    );

    console.log(`[manga-upload] request: ${metadata.title} (ch.${metadata.chapter}) / ${pages.length} pages`);

    // Delegate to manga_modules/upload — you'll implement this.
    // Suggested signature:
    //   uploadManga({ db, mangaDir, metadata, pages })
    //     returns { cbzPath, bytes, pageCount }
    const { uploadManga } = require('./manga_modules/upload');
    const result = await uploadManga({
      db,
      mangaDir: serverConfig.mangaDir,
      metadata,
      pages,   // multer file objects: { buffer, originalname, mimetype, size }
    });

    res.json({
      success: true,
      cbzPath: result.cbzPath,
      bytes: result.bytes,
      pageCount: result.pageCount,
    });
    console.log(`[manga-upload] saved: ${result.cbzPath} (${result.pageCount} pages, ${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.error('[manga-upload] failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/staging/save
 *
 * Multipart upload from the extension. Replaces the old
 * background.js → browser.downloads.download flow. Server takes
 * raw bytes + raw metadata, canonicalizes, writes both the image and
 * sidecar atomically, syncs the DB, and pushes an SSE event to the
 * staging manager.
 *
 * Form fields:
 *   image            (file, required) - raw bytes
 *   metadata         (string,  required) - JSON of { sourceUrl, tags,
 *                                          imageUrl, mediaType,
 *                                          timestamp?, imageHash?,
 *                                          poolId?, poolIndex? }
 *   filenameHint     (string, optional) - hint for extension picking,
 *                                          e.g. "foo_p0.png"
 *
 * Response:
 *   { success: true, id, filename, image: <full image object> }
 *
 * The full image object in the response matches what
 * GET /api/staging/images/:id returns — saves the extension a round
 * trip if it cares about the resulting record (it doesn't today, but
 * keeps options open).
 */
app.post('/api/staging/save', saveUpload.single('image'), async (req, res) => {
  const startTime = process.hrtime.bigint();

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing image field' });
    }
    if (!req.body || !req.body.metadata) {
      return res.status(400).json({ error: 'Missing metadata field' });
    }

    let raw;
    try {
      raw = JSON.parse(req.body.metadata);
    } catch (err) {
      return res.status(400).json({ error: `Bad metadata JSON: ${err.message}` });
    }

    if (!raw.sourceUrl) {
      return res.status(400).json({ error: 'metadata.sourceUrl is required' });
    }

    // ---- Canonicalize tags ----
    // raw.tags is the categorized form { general: [...], character: [...] }
    // Canonicalize applies normalize + alias + hierarchy + blacklist
    // and re-buckets by category.
    const cleanTags = canonicalizeCategorized(raw.tags || {});

    // ---- Decide filenames ----
    const id = buildStagingId(raw.sourceUrl);
    const ext = pickExtension({
      filenameHint: req.body.filenameHint,
      mimeType: req.file.mimetype,
    });
    const imageFilename = `${id}${ext}`;
    const imagePath = path.join(serverConfig.stagingDir, imageFilename);
    const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);

    // ---- Compose final sidecar ----
    const sidecar = {
      sourceUrl: raw.sourceUrl,
      tags: cleanTags,
      imageUrl: raw.imageUrl || null,
      mediaType: raw.mediaType || 'image',
      timestamp: raw.timestamp || new Date().toISOString(),
      imageHash: raw.imageHash || null,
      ...(raw.poolId && {
        poolId: raw.poolId,
        poolIndex: parseInt(raw.poolIndex, 10) || 0,
      }),
    };

    // ---- Write image first, then sidecar ----
    // Order matters: the post-worker scans for *.json files and looks
    // for a sibling image; if the JSON existed without the image we'd
    // hit a race. So bytes first.
    await fs.writeFile(imagePath, req.file.buffer);
    await fs.writeFile(jsonPath, JSON.stringify(sidecar, null, 2));

    // ---- Sync to DB ----
    // syncSidecarToDb is the same function the boot scan and rescan
    // endpoints use. Handles staging_images, staging_tags,
    // staging_image_tags, tag_log, tag_log_seen, image_log. Idempotent.
    const synced = await syncSidecarToDb(id);
    if (!synced) {
      console.warn(`[save] syncSidecarToDb returned false for ${id} — disk write succeeded but DB sync did not`);
    }

    // ---- pool_log upsert (same as the old /api/images stub did) ----
    if (sidecar.poolId) {
      const now = Date.now();
      try {
        db.prepare(`
          INSERT INTO pool_log
            (pool_id, source_url, highest_index, first_seen_ts, last_seen_ts)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(pool_id) DO UPDATE SET
            highest_index = MAX(highest_index, excluded.highest_index),
            last_seen_ts  = excluded.last_seen_ts
        `).run(sidecar.poolId, sidecar.sourceUrl, sidecar.poolIndex, now, now);
      } catch (err) {
        console.warn(`[save] pool_log upsert failed for ${sidecar.poolId}: ${err.message}`);
      }
    }

    // ---- Build the response payload (full image object) ----
    let image = null;
    try {
      image = await loadStagingImage(id);
    } catch (err) {
      console.warn(`[save] loadStagingImage failed for ${id}: ${err.message}`);
    }

    // ---- Publish SSE ----
    if (image) {
      publishStagingEvent('image-saved', image);
    }

    const ms = Number((process.hrtime.bigint() - startTime) / 1_000_000n);
    console.log(`[save] ${id} (${ms}ms, ${cleanTags ? Object.values(cleanTags).flat().length : 0} tags)`);

    res.json({ success: true, id, filename: imageFilename, image });
    setImmediate(() => {
      maybeCamieTagId(id).catch(err =>
        console.error(`[camie] background tag for ${id}:`, err.message)
      );
    });
  } catch (err) {
    console.error('[save] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Streaming SSE per-item progress.
app.post('/api/staging/upload-to-booru/stream', async (req, res) => {
  const validationError = validateBooruUploadBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
 
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable buffering if reverse-proxied
  res.flushHeaders();

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }
  
  res.write(': ping\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.socket && typeof res.socket.uncork === 'function') {
      res.socket.uncork();         // ensure immediate send
    }
  };
 
  // If the client disconnects mid-stream, stop emitting (the loop is sequential
  // and the next emit will silently no-op into a closed socket; that's fine).
  try {
    const { ids, all = false, force = false } = req.body;
    await runBooruUploads({ ids, all, force }, (progress) => {
      send(progress.phase, progress);
    });
    kickPostWorker(all ? null : (ids || []));
  } catch (err) {
    console.error('Error in upload-to-booru/stream:', err);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

//Debugging

app.post('/api/admin/wipe-staging', (req, res) => {
  db.exec('DELETE FROM staging_image_tags; DELETE FROM staging_tags; DELETE FROM staging_images;');
  res.json({ wiped: true });
});

app.get('/api/stats/logs', (req, res) => {
  const imageLog = db.prepare('SELECT COUNT(*) AS c FROM image_log').get().c;
  const tagLog = db.prepare('SELECT COUNT(*) AS c FROM tag_log').get().c;
  const tagLogSeen = db.prepare('SELECT COUNT(*) AS c FROM tag_log_seen').get().c;
  const poolLog = db.prepare('SELECT COUNT(*) AS c FROM pool_log').get().c;
  res.json({ imageLog, tagLog, tagLogSeen, poolLog });
});

// Updated duplicate check endpoint with similarity support
app.get('/api/images/check-duplicate/:hash', (req, res) => {
  try {
    const { hash } = req.params;
    const similarityThreshold = parseInt(req.query.threshold, 10) || 8;

    // Exact hash hit — fastest path. Single row by PK.
    const exact = db.prepare(`
      SELECT image_hash, source_url, booru_post_id, pool_id, pool_index, last_seen_ts
      FROM image_log
      WHERE image_hash = ?
    `).get(hash);

    if (exact) {
      // Check if it's still in staging (computed flag, no extra column needed)
      const stagingHit = db.prepare(`
        SELECT id FROM staging_images WHERE image_hash = ? LIMIT 1
      `).get(hash);

      // Map to the legacy response shape (extension expects {url, image_url, ...}).
      // The extension cares mainly about exists/exactMatch; the duplicate
      // body just needs to look like a row.
      return res.json({
        exists: true,
        exactMatch: true,
        duplicate: {
          id: stagingHit?.id ?? null,
          url: exact.source_url,
          image_url: null,
          image_hash: exact.image_hash,
          timestamp: exact.last_seen_ts,
          booru_post_id: exact.booru_post_id,
          pool_id: exact.pool_id,
          pool_index: exact.pool_index,
        },
      });
    }

    // Fuzzy match via Hamming distance. Read all hashes once, compare
    // in JS. Acceptably fast at ~hundreds-of-thousands scale.
    if (similarityThreshold > 0) {
      const all = db.prepare(`
        SELECT image_hash, source_url, booru_post_id, pool_id, pool_index, last_seen_ts
        FROM image_log
        WHERE image_hash IS NOT NULL AND image_hash != ''
      `).all();

      for (const row of all) {
        const distance = calculateHammingDistance(hash, row.image_hash);
        if (distance <= similarityThreshold) {
          return res.json({
            exists: true,
            exactMatch: false,
            duplicate: {
              id: null,
              url: row.source_url,
              image_url: null,
              image_hash: row.image_hash,
              timestamp: row.last_seen_ts,
              booru_post_id: row.booru_post_id,
              pool_id: row.pool_id,
              pool_index: row.pool_index,
            },
          });
        }
      }
    }

    res.json({ exists: false, exactMatch: false, duplicate: null });
  } catch (err) {
    console.error('Error checking duplicate:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tags/search?q=term&limit=30
//   Autocomplete from staging_tags + alias canonicals.
//   Excludes alias sources and blacklisted tags.
app.get('/api/tags/search', (req, res) => {
  const startTime = process.hrtime.bigint();

  try {
    const { q, limit = 30 } = req.query;
    if (!q || q.length < 2) return res.json([]);

    const cached = tagCache.get(q);
    if (cached) return res.json(cached);

    const lim = parseInt(limit, 10) || 30;
    const like = `%${q}%`;

    const tagRows = db.prepare(`
      SELECT
        tl.category,
        tl.name,
        tl.total_uses AS post_count
      FROM tag_log tl
      WHERE (tl.name LIKE ? OR (tl.category || ':' || tl.name) LIKE ?)
        AND NOT EXISTS (
          SELECT 1 FROM config_blacklist bl
          WHERE bl.tag = CASE
            WHEN tl.category = 'general' THEN tl.name
            ELSE tl.category || ':' || tl.name
          END
        )
        AND NOT EXISTS (
          SELECT 1 FROM config_aliases ca
          WHERE ca.source = CASE
            WHEN tl.category = 'general' THEN tl.name
            ELSE tl.category || ':' || tl.name
          END
        )
      ORDER BY tl.total_uses DESC, tl.name ASC
      LIMIT ?
    `).all(like, like, lim);

    // Query 2: alias canonicals. Surfaces canonicals not yet used by
    // any image. Same matching: bare name OR full prefixed form.
    //
    // We're matching the user's `q` against a substring of `canonical`,
    // which is stored as the full "category:name" string. So a single
    // LIKE on canonical handles both forms transparently.
    const aliasRows = db.prepare(`
      SELECT DISTINCT canonical
      FROM config_aliases
      WHERE canonical LIKE ?
        AND canonical NOT IN (SELECT tag FROM config_blacklist)
      LIMIT ?
    `).all(like, lim);

    // Build the suggestion list — staging tags first (real usage),
    // alias canonicals second (only those NOT already in staging tags
    // to avoid duplicates).
    const suggestions = [];
    const seen = new Set();

    for (const row of tagRows) {
      const formatted = row.category === 'general' ? row.name : `${row.category}:${row.name}`;
      if (seen.has(formatted)) continue;
      seen.add(formatted);
      suggestions.push(formatted);
    }

    for (const row of aliasRows) {
      if (seen.has(row.canonical)) continue;
      seen.add(row.canonical);
      suggestions.push(row.canonical);
    }

    // Filter out alias sources. A "Dizzy Dokuro" suggestion (alias
    // source) is meaningless — the user wants the canonical to land
    // in the tag list, not the source. We do this AFTER the dedupe
    // step because:
    //   (a) alias sources won't appear in staging_tags normally
    //       (canonicalize-on-save converts them before storage), but
    //       legacy sidecars from before step 9 may have raw sources
    //       still present.
    //   (b) cheaper than a SQL NOT EXISTS join on every query.
    const aliasSources = new Set(
      db.prepare('SELECT source FROM config_aliases').all().map(r => r.source)
    );
    const filtered = suggestions.filter(s => !aliasSources.has(s));

    // Cap at limit
    const final = filtered.slice(0, lim);

    tagCache.set(q, final);

    const time = Number(process.hrtime.bigint() - startTime) / 1000000;

    res.json(final);
  } catch (err) {
    console.error('Error searching tags:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/warmup', (req, res) => {
  try {
    db.prepare('SELECT 1 FROM image_log LIMIT 1').get();
    db.prepare('SELECT 1 FROM tag_log LIMIT 1').get();
    db.prepare('SELECT 1 FROM staging_images LIMIT 1').get();
    db.prepare('SELECT 1 FROM staging_tags LIMIT 1').get();
    res.json({ ok: true });
  } catch (err) {
    console.error('Warmup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get pool highest index
app.get('/api/pools/:poolId/highest-index', (req, res) => {
  try {
    const { poolId } = req.params;
    const row = db.prepare(`
      SELECT highest_index AS h FROM pool_log WHERE pool_id = ?
    `).get(poolId);
    res.json({
      success: true,
      highestIndex: row?.h ?? null,
    });
  } catch (err) {
    console.error('Error getting pool index:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pools/new', (req, res) => {
  try {
    const existsLog     = db.prepare('SELECT 1 FROM pool_log WHERE pool_id = ? LIMIT 1');
    const existsStaging = db.prepare('SELECT 1 FROM staging_images WHERE pool_id = ? LIMIT 1');

    for (let attempt = 0; attempt < 50; attempt++) {
      const id = Math.random().toString(36).substring(2, 10);
      if (!existsLog.get(id) && !existsStaging.get(id)) {
        return res.json({ poolId: id });
      }
    }
    res.status(500).json({ error: 'Failed to generate unique pool ID after 50 attempts' });
  } catch (err) {
    console.error('Pool generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Server status
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'running', 
    version: '1.0.0',
    database: DB_PATH,
    timestamp: new Date().toISOString()
  });
});

// --- Aliases ---
app.get('/api/config/aliases/export', (req, res) => {
  try { res.json(exportAliases()); }
  catch (err) { handleConfigError(err, res); }
});

app.post('/api/config/aliases/canonize', (req, res) => {
  try {
    const result = canonizeAliases(req.body);
    tagCache.invalidate();           // <-- NEW
    res.json({ success: true, ...result });
  } catch (err) { handleConfigError(err, res); }
});

// --- Hierarchy ---
app.get('/api/config/hierarchy/export', (req, res) => {
  try { res.json(exportHierarchy()); }
  catch (err) { handleConfigError(err, res); }
});

app.post('/api/config/hierarchy/canonize', (req, res) => {
  try { res.json({ success: true, ...canonizeHierarchy(req.body) }); }
  catch (err) { handleConfigError(err, res); }
});

// --- Blacklist ---
app.get('/api/config/blacklist/export', (req, res) => {
  try { res.json(exportBlacklist()); }
  catch (err) { handleConfigError(err, res); }
});

app.post('/api/config/blacklist/canonize', (req, res) => {
  try {
    const result = canonizeBlacklist(req.body);
    tagCache.invalidate();           // <-- NEW
    res.json({ success: true, ...result });
  } catch (err) { handleConfigError(err, res); }
});

// ============================================
// API ENDPOINTS
// ============================================

// GET /api/config - Get full taxonomy/config
app.get('/api/config', (req, res) => {
  try {
    res.json(loadTaxonomyFromDb());
  } catch (err) {
    console.error('Error loading config:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/aliases - Update aliases
app.put('/api/config/aliases', (req, res) => {
  try {
    saveAliasesToDb(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving aliases:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/exclusions - Update exclusions
app.put('/api/config/exclusions', (req, res) => {
  try {
    saveExclusionsToDb(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving exclusions:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/hierarchy - Update hierarchy
app.put('/api/config/hierarchy', (req, res) => {
  try {
    saveHierarchyToDb(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving hierarchy:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/analyze - Run tag analysis
app.post('/api/config/analyze', (req, res) => {
  res.status(501).json({ error: 'Auto-suggester is being rebuilt — see step 11+' });
});

// GET /api/staging/images - List staging images (paginated)
app.get('/api/staging/images', async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 50;
    const offset = parseInt(req.query.offset) || 0;
    const validSorts   = ['newest', 'oldest', 'tags-desc', 'tags-asc'];
    const validUploads = ['all', 'pending', 'uploaded'];
    const sort         = validSorts.includes(req.query.sort)     ? req.query.sort     : 'newest';
    const uploadFilter = validUploads.includes(req.query.upload) ? req.query.upload   : 'all';

    const result = await scanStagingDirectory(limit, offset, sort, uploadFilter);
    res.json(result);
  } catch (error) {
    console.error('Error listing staging images:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/staging/events — Server-Sent Events stream of staging changes
//
// Events emitted:
//   event: image-saved   data: <full image object, same shape as
//                              GET /api/staging/images/:id returns>
//   event: heartbeat     data: { ts: <epoch_ms> }   (every 30s)
//
// Client should reconnect with EventSource if the stream drops.
app.get('/api/staging/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Initial hello so EventSource fires onopen immediately
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  sseSubscribers.add(res);

  // Heartbeat to keep proxies / Tailscale / browsers from idle-closing
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
      sseSubscribers.delete(res);
    }
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseSubscribers.delete(res);
  });
});

// GET /api/staging/images/:id - Get single staging image metadata
app.get('/api/staging/images/:id', async (req, res) => {
  try {
    const image = await loadStagingImage(req.params.id);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    res.json(image);
  } catch (error) {
    console.error('Error loading staging image:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/staging/images/batch
app.patch('/api/staging/images/batch', async (req, res) => {
  try {
    const { ids, addTags = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`ids` must be a non-empty array' });
    }
    if (!Array.isArray(addTags)) {
      return res.status(400).json({ error: '`addTags` must be an array' });
    }
    if (addTags.length === 0) {
      return res.json({ total: 0, succeeded: 0, failed: 0, results: [] });
    }

    const results = [];
    for (const id of ids) {
      const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
      try {
        const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
        const existing = new Set();
        
        if (Array.isArray(json.tags)) {
          json.tags.forEach(t => existing.add(t));
        } else if (json.tags && typeof json.tags === 'object') {
          for (const [cat, list] of Object.entries(json.tags)) {
            if (!Array.isArray(list)) continue;
            list.forEach(t => existing.add(cat === 'general' ? t : `${cat}:${t}`));
          }
        }
        addTags.forEach(t => existing.add(t));

        const canonicalTags = canonicalize([...existing]);
        const categorized = { artist: [], character: [], copyright: [], general: [], meta: [] };
        for (const tag of canonicalTags) {
          const { category, name } = parseTagName(tag);
          if (categorized[category]) categorized[category].push(name);
          else categorized.general.push(tag);
        }
        json.tags = categorized;
        await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
        await syncSidecarToDb(id);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }

    res.json({
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('Error in /staging/images/batch PATCH:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/staging/images/batch
app.delete('/api/staging/images/batch', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`ids` must be a non-empty array' });
    }

    const results = [];
    for (const id of ids) {
      try {
        const movedAny = await moveImageToTrash(id);
        if (!movedAny) {
          results.push({ id, success: false, error: 'No files found' });
          continue;
        }
        removeStagingFromDb(id);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }

    res.json({
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('Error in /staging/images/batch DELETE:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staging/images/:id - Update staging image
app.put('/api/staging/images/:id', async (req, res) => {
  try {
    const success = await updateStagingImage(req.params.id, req.body);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to update image' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating staging image:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/staging/images/:id/rescan
//   Re-read the sidecar from disk and update its DB row. Useful when
//   you've manually edited the JSON file outside the staging manager.
app.post('/api/staging/images/:id/rescan', async (req, res) => {
  try {
    const id = req.params.id;
    const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);

    // Sanity check: file actually exists?
    try {
      await fs.access(jsonPath);
    } catch {
      return res.status(404).json({ error: `Sidecar not found: ${id}.json` });
    }

    const ok = await syncSidecarToDb(id);
    if (!ok) {
      return res.status(500).json({ error: 'Sync failed (see server logs)' });
    }

    // Return the freshly-synced row so the caller can refresh its UI.
    const image = await loadStagingImage(id);
    res.json({ success: true, image });
  } catch (err) {
    console.error('Error in /staging/images/:id/rescan:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/images/:id/refresh
//   Re-canonicalize the image's current tags using the latest config.
//   No-op if the resulting tags are identical to current.
app.post('/api/staging/images/:id/refresh', async (req, res) => {
  try {
    const id = req.params.id;
    const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);

    let json;
    try {
      json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: `Sidecar not found: ${id}.json` });
      }
      throw err;
    }

    // Flatten current tags whether categorized or flat-array form
    const currentFlat = [];
    if (Array.isArray(json.tags)) {
      currentFlat.push(...json.tags);
    } else if (json.tags && typeof json.tags === 'object') {
      for (const [cat, list] of Object.entries(json.tags)) {
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          currentFlat.push(cat === 'general' ? t : `${cat}:${t}`);
        }
      }
    }

    const canonicalTags = canonicalize(currentFlat);

    // Convert to categorized form for write (matches save shape)
    const categorized = { artist: [], character: [], copyright: [], general: [], meta: [] };
    for (const tag of canonicalTags) {
      const { category, name } = parseTagName(tag);
      if (categorized[category]) categorized[category].push(name);
      else categorized.general.push(tag);
    }

    // Skip write + sync if nothing changed (avoids touching mtime)
    const beforeJson = JSON.stringify(json.tags);
    json.tags = categorized;
    const afterJson = JSON.stringify(json.tags);
    const changed = beforeJson !== afterJson;

    if (changed) {
      await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
      await syncSidecarToDb(id);
    }

    res.json({
      success: true,
      changed,
      tagCount: canonicalTags.length,
    });
    setImmediate(() => {
      maybeCamieTagId(id).catch(err =>
        console.error(`[camie] refresh tag for ${id}:`, err.message)
      );
    });
  } catch (err) {
    console.error('Error in /staging/images/:id/refresh:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/images/refresh-batch
//   Re-canonicalize tags for each id in the batch. Same logic as
//   /:id/refresh, looped per-id, with aggregate response.
app.post('/api/staging/images/refresh-batch', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`ids` must be a non-empty array' });
    }

    const results = [];
    for (const id of ids) {
      const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
      try {
        let json;
        try {
          json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
        } catch (err) {
          if (err.code === 'ENOENT') {
            results.push({ id, success: false, error: 'Sidecar not found' });
            continue;
          }
          throw err;
        }

        const currentFlat = [];
        if (Array.isArray(json.tags)) {
          currentFlat.push(...json.tags);
        } else if (json.tags && typeof json.tags === 'object') {
          for (const [cat, list] of Object.entries(json.tags)) {
            if (!Array.isArray(list)) continue;
            for (const t of list) {
              currentFlat.push(cat === 'general' ? t : `${cat}:${t}`);
            }
          }
        }

        const canonicalTags = canonicalize(currentFlat);
        const categorized = { artist: [], character: [], copyright: [], general: [], meta: [] };
        for (const tag of canonicalTags) {
          const { category, name } = parseTagName(tag);
          if (categorized[category]) categorized[category].push(name);
          else categorized.general.push(tag);
        }

        const beforeJson = JSON.stringify(json.tags);
        json.tags = categorized;
        const afterJson = JSON.stringify(json.tags);
        const changed = beforeJson !== afterJson;

        if (changed) {
          await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
          await syncSidecarToDb(id);
        }

        results.push({ id, success: true, changed, tagCount: canonicalTags.length });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }

    res.json({
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      changed: results.filter(r => r.success && r.changed).length,
      results,
    });
    setImmediate(() => {
      for (const r of results) {
        if (!r.success) continue;
        maybeCamieTagId(r.id).catch(err =>
          console.error(`[camie] batch refresh tag for ${r.id}:`, err.message)
        );
      }
    });
  } catch (err) {
    console.error('Error in /staging/images/refresh-batch:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/images/rescan-batch
//   Re-read each sidecar from disk and update its DB row.
app.post('/api/staging/images/rescan-batch', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`ids` must be a non-empty array' });
    }

    const results = [];
    for (const id of ids) {
      const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
      try {
        try {
          await fs.access(jsonPath);
        } catch {
          results.push({ id, success: false, error: 'Sidecar not found' });
          continue;
        }

        const ok = await syncSidecarToDb(id);
        if (!ok) {
          results.push({ id, success: false, error: 'Sync failed' });
          continue;
        }
        const image = await loadStagingImage(id);
        results.push({ id, success: true, tagCount: (image?.tags?.length) ?? 0 });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }

    res.json({
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('Error in /staging/images/rescan-batch:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/refresh-all
//   Re-canonicalize every staging image. Long-running on large
//   datasets. Returns aggregate stats once complete.
app.post('/api/staging/refresh-all', async (req, res) => {
  try {
    const allRows = db.prepare('SELECT id FROM staging_images').all();
    const ids = allRows.map(r => r.id);

    console.log(`[refresh-all] starting on ${ids.length} images`);
    const t0 = Date.now();

    let changed = 0;
    let unchanged = 0;
    let errored = 0;

    for (const id of ids) {
      try {
        const jsonPath = path.join(serverConfig.stagingDir, `${id}.json`);
        const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));

        const currentFlat = [];
        if (Array.isArray(json.tags)) {
          currentFlat.push(...json.tags);
        } else if (json.tags && typeof json.tags === 'object') {
          for (const [cat, list] of Object.entries(json.tags)) {
            if (!Array.isArray(list)) continue;
            for (const t of list) {
              currentFlat.push(cat === 'general' ? t : `${cat}:${t}`);
            }
          }
        }

        const canonicalTags = canonicalize(currentFlat);
        const categorized = { artist: [], character: [], copyright: [], general: [], meta: [] };
        for (const tag of canonicalTags) {
          const { category, name } = parseTagName(tag);
          if (categorized[category]) categorized[category].push(name);
          else categorized.general.push(tag);
        }

        const beforeJson = JSON.stringify(json.tags);
        json.tags = categorized;
        const afterJson = JSON.stringify(json.tags);

        if (beforeJson !== afterJson) {
          await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
          await syncSidecarToDb(id);
          changed++;
        } else {
          unchanged++;
        }
      } catch (err) {
        errored++;
        console.warn(`[refresh-all] error on ${id}: ${err.message}`);
      }

      const total = changed + unchanged + errored;
      if (total % 1000 === 0) {
        console.log(`[refresh-all] progress: ${total}/${ids.length}`);
      }
    }

    const elapsed = Date.now() - t0;
    console.log(
      `[refresh-all] done in ${elapsed}ms — ` +
      `changed=${changed} unchanged=${unchanged} errored=${errored}`
    );

    res.json({
      success: true,
      total: ids.length,
      changed,
      unchanged,
      errored,
      elapsed,
    });
    setImmediate(() => {
      for (const id of ids) {
        maybeCamieTagId(id).catch(err =>
          console.error(`[camie] refresh-all tag for ${id}:`, err.message)
        );
      }
    });
  } catch (err) {
    console.error('Error in /staging/refresh-all:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/rebuild
//   Drop the entire staging index and rerun the full disk scan.
//   Equivalent to deleting the tables and restarting the server — but
//   keeps everything else (extension hash dedup data, config, etc.)
//   intact.
//
//   Long-running on first invocation if the cache is cold. Consider
//   warning the UI before kicking this off.
app.post('/api/staging/rebuild', async (req, res) => {
  try {
    // Wipe staging index tables. NOT the existing images/tags/image_tags
    // (those are the extension's hash dedup tables). NOT the config.
    db.exec(`
      DELETE FROM staging_image_tags;
      DELETE FROM staging_images;
      DELETE FROM staging_tags;
    `);

    console.log(`[rebuild] index wiped, rescanning ${serverConfig.stagingDir} ...`);

    const stats = await scanStagingIntoDb();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('Error in /staging/rebuild:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/staging/images/:id - Delete staging image
app.delete('/api/staging/images/:id', async (req, res) => {
  try {
    const success = await deleteStagingImage(req.params.id);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete image' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting staging image:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/staging/image/:id - Get full-size image
app.get('/api/staging/image/:id', async (req, res) => {
  try {
    const image = await loadStagingImage(req.params.id);
    
    if (!image || !image.filePath) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    res.sendFile(image.filePath);
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/staging/thumbnail/:id', async (req, res) => {
  try {
    const size = parseInt(req.query.size) || 200;
    const image = await loadStagingImage(req.params.id);

    if (!image || !image.filePath) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Video path — extract frame, with on-disk cache.
    if (image.mediaType === 'video') {
      const cachedPath = path.join(serverConfig.thumbsDir, `${req.params.id}.jpg`);

      // Cache hit?
      let useCache = false;
      try {
        await fs.access(cachedPath);
        useCache = true;
      } catch {
        // Cache miss — fall through to extract
      }

      if (!useCache) {
        try {
          await extractVideoThumbnail(image.filePath, req.params.id, size);
        } catch (err) {
          console.error(`Thumbnail extraction failed for ${req.params.id}:`, err.message);
          return res.status(500).json({ error: 'Thumbnail extraction failed' });
        }
      }

      // Resize via sharp to the requested size — the cached file may
      // have been generated at a different size. This keeps response
      // pixel-accurate to the size param.
      //
      // (Optional: skip this if you're OK serving the cached size
      // verbatim. Faster, but may serve a 200×200 to a 400-pixel
      // grid request.)
      const resized = await sharp(cachedPath)
        .resize(size, size, { fit: 'inside' })
        .jpeg({ quality: 85 })
        .toBuffer();

      res.type('image/jpeg');
      return res.send(resized);
    }

    // Image path — unchanged from before
    const thumbnail = await sharp(image.filePath)
      .resize(size, size, { fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer();

    res.type('image/jpeg');
    res.send(thumbnail);
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stats - Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Count staging images
    const staging = await scanStagingDirectory(1, 0);
    
    // Count unique tags in database
    const tagCount = await promiseDb('SELECT COUNT(*) as count FROM tags');
    
    res.json({
      imageCount: staging.total,
      uniqueTags: tagCount[0].count
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Server config — runtime-mutable settings
// ============================================================

// GET /api/server-config — returns the current config snapshot.
// Used by the extension's Settings page to populate fields on load.
app.get('/api/server-config', (req, res) => {
  const cfg = serverConfigSnapshot();
  cfg.camieState = camie.getState();
  res.json(cfg);
});

// PATCH /api/server-config — change one or more config values.
//
// Currently only supports stagingDir. Validation order:
//   1. body.stagingDir is a non-empty string         -> 400 if not
//   2. resolved path differs from current value      -> 200 noop if not
//   3. fs.access(R_OK | W_OK) succeeds               -> 400 if not
//   4. setStagingDir() persists + mutates in-memory  -> 400 if rejected
//
// On success, returns 202 with a rescanId, then asynchronously runs
// scanStagingIntoDb() against the new dir, publishing 'rescan-progress'
// and finally 'rescan-done' (or 'rescan-error') SSE events so the UI
// can show a progress bar without blocking the HTTP response.
app.patch('/api/server-config', async (req, res) => {
  const body = req.body || {};
  const stagingPresent = typeof body.stagingDir === 'string';
  const mangaPresent = typeof body.mangaDir === 'string';
  const camiePresent = typeof body.camieEnabled === 'boolean';

  if (!stagingPresent && !mangaPresent && !camiePresent) {
    return res.status(400).json({
      error: 'must provide stagingDir, mangaDir, camieEnabled, or some combination',
      code: 'EINVAL',
    });
  }

  // Phase 1: validate everything before mutating anything.
  let resolvedStaging = null;
  let resolvedManga = null;
  let stagingChanged = false;
  let mangaChanged = false;
  let camieChanged = camiePresent && body.camieEnabled !== serverConfig.camieEnabled;

  if (stagingPresent) {
    if (!body.stagingDir.trim()) {
      return res.status(400).json({ error: 'stagingDir cannot be empty', code: 'EINVAL' });
    }
    resolvedStaging = path.resolve(body.stagingDir.trim());
    stagingChanged = resolvedStaging !== serverConfig.stagingDir;
    if (stagingChanged) {
      try {
        await fs.access(resolvedStaging, fsConstants.R_OK | fsConstants.W_OK);
      } catch (err) {
        return res.status(400).json({
          error: `Cannot access staging dir: ${err.message}`,
          code: err.code || 'EACCES',
        });
      }
    }
  }

  if (mangaPresent) {
    if (!body.mangaDir.trim()) {
      return res.status(400).json({ error: 'mangaDir cannot be empty', code: 'EINVAL' });
    }
    resolvedManga = path.resolve(body.mangaDir.trim());
    mangaChanged = resolvedManga !== serverConfig.mangaDir;
    if (mangaChanged) {
      try {
        await fs.access(resolvedManga, fsConstants.R_OK | fsConstants.W_OK);
      } catch (err) {
        return res.status(400).json({
          error: `Cannot access manga dir: ${err.message}`,
          code: err.code || 'EACCES',
        });
      }
    }
  }

  // Phase 2: apply.
  const changed = [];

  if (stagingChanged) {
    try {
      setStagingDir(resolvedStaging);
      changed.push('stagingDir');
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'EINVAL' });
    }
  }

  if (mangaChanged) {
    try {
      setMangaDir(resolvedManga);
      changed.push('mangaDir');
    } catch (err) {
      return res.status(400).json({
        error: err.message,
        code: err.code || 'EINVAL',
        partial: changed,
      });
    }
  }

  if (camieChanged) {
    try {
      setCamieEnabled(body.camieEnabled);
      // Mirror to the live instance. setEnabled is serialized internally
      // so concurrent toggles can't race; we fire-and-forget here since
      // the response shouldn't wait on a potentially-long kill grace.
      camie.setEnabled(body.camieEnabled).catch(err =>
        console.error('[camie] mirror setEnabled failed:', err.message)
      );
      changed.push('camieEnabled');
    } catch (err) {
      return res.status(400).json({
        error: err.message,
        code: err.code || 'EINVAL',
        partial: changed,
      });
    }
  }

  // Phase 3: side effects. Only stagingDir triggers a rescan.
  let rescanId = null;
  if (changed.includes('stagingDir')) {
    rescanId = `rescan_${Date.now()}`;
    publishStagingEvent('rescan-start', {
      rescanId,
      stagingDir: serverConfig.stagingDir,
    });
    scanStagingIntoDb({ rescanId })
      .then((stats) => {
        publishStagingEvent('rescan-done', {
          rescanId,
          stagingDir: serverConfig.stagingDir,
          ...stats,
        });
      })
      .catch((err) => {
        console.error(`[rescan ${rescanId}] failed:`, err);
        publishStagingEvent('rescan-error', { rescanId, error: err.message });
      });
  }

  // Phase 4: response.
  const responseBody = {
    stagingDir:   serverConfig.stagingDir,
    mangaDir:     serverConfig.mangaDir,
    camieEnabled: serverConfig.camieEnabled,
    camieState:   camie.getState(),
    changed,
    rescanId,
  };

  if (changed.length === 0) {
    return res.status(200).json({ ...responseBody, noop: true });
  }

  res.status(rescanId ? 202 : 200).json(responseBody);
});

// GET /api/health - Health check (rename from /api/status)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// POST /api/shutdown - Gracefully stop the server.
// Server binds to localhost only, so no auth needed. Returns 202 and
// then defers the actual shutdown so the response can flush before the
// socket dies.
app.post('/api/shutdown', (req, res) => {
  if (shuttingDown) {
    return res.status(409).json({ status: 'already shutting down' });
  }
  res.status(202).json({ status: 'shutting down' });
  setImmediate(() => shutdown('api'));
});


module.exports = {
  scanStagingDirectory,
  loadStagingImage,
  updateStagingImage,
  deleteStagingImage
};

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function startServer() {
  console.log(`┌──────────────────────────────────────────────────────────┐`)
  console.log(`│░░░░░░░░░░░░░░░░░ Kyabooru server ░░░░░░░░░░░░░░░░░░░░░░░░│`)
  console.log(`└──────────────────────────────────────────────────────────┘`)

  // Load config file
  const { stagingDir, sources } = loadServerConfig();
  
  // Initialize database
  initDatabase();
  initMangaDedupSchema(db);
  
  if (serverConfig.camieEnabled) {
    camie.setEnabled(true).catch(err =>
      console.error('[camie] initial setEnabled failed:', err.message)
    );
  }

  startWalCheckpointer();

  // Build in-memory tag cache from staging directory
  await scanStagingIntoDb();

  httpServer = app.listen(PORT, serverConfig.bindHost, () => {
    console.log(`█ Server running on  http://${serverConfig.bindHost}:${PORT}`);
    console.log(`█ Database location: ${DB_PATH}`);
    console.log(`█ Image location:    ${serverConfig.stagingDir}`);
    console.log(`█ Manga location:    ${serverConfig.mangaDir}`);
    console.log('█ API endpoints ────────────────────────────────────────────');
    console.log('│ POST /api/images - Save image with tags');
    console.log('│ GET  /api/images/check-duplicate/:hash - Check duplicate');
    console.log('│ GET  /api/tags/search?q=term - Search tags');
    console.log('│ GET  /api/pools/:id/highest-index - Get pool info');
    console.log('│ GET  /api/export - Export all data');
    console.log('│ GET  /api/status - Server status');
    console.log('│ POST /api/shutdown - Graceful shutdown');
    console.log('│ GET  /api/config - Get taxonomy config');
    console.log('│ POST /api/config/analyze - Run tag analysis');
    console.log('│ GET  /api/staging/images - List staging images');
    console.log('│ GET  /api/health - Server health check');
    console.log('└───────────────────────────────────────────────────────────');
  });
}

startServer().catch(console.error);