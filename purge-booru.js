const path = require('path');
const fs = require('fs').promises;
const Database = require('better-sqlite3');
const axios = require('axios');

// =============================================================================
// CONFIG — edit these if your env differs
// =============================================================================

const DANBOORU_URL  = process.env.DANBOORU_URL  || 'http://192.168.0.205:3000';
const DANBOORU_USER = process.env.DANBOORU_USER || 'kyabatsu';
const DANBOORU_KEY  = process.env.DANBOORU_KEY  || 'EPBFXUJbxWFsBPq2QZaf7TcY';
const STAGING_DIR   = process.env.STAGING_DIR   || 'F:\\kaali-stage';
const DB_PATH       = path.join(process.cwd(), 'tag_saver.db');

// Pause between API hits to avoid hammering. Tune if you have many posts.
const POLITE_GAP_MS = 100;

// Sidecar keys to strip. pool* is intentionally NOT here — pools are
// staging-side concepts that survive a booru purge.
const BOORU_KEYS = ['booruPostId', 'booruUploadId', 'booruMediaAssetId'];

// =============================================================================
// SETUP
// =============================================================================

const client = axios.create({
  baseURL: DANBOORU_URL.replace(/\/$/, ''),
  auth: { username: DANBOORU_USER, password: DANBOORU_KEY },
  timeout: 60000,
});

const db = new Database(DB_PATH);

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// =============================================================================
// STAGE 1 — soft-delete every post
// =============================================================================

async function listAllPosts() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await client.get('/posts.json', {
      params: { limit: 200, page, tags: 'status:any' },
    });
    const batch = res.data || [];
    if (batch.length === 0) break;
    all.push(...batch);
    console.log(`  page ${page}: +${batch.length} posts (total ${all.length})`);
    page++;
    await sleep(POLITE_GAP_MS);
  }
  return all;
}

async function softDeletePost(postId) {
  await client.delete(`/posts/${postId}.json`);
}

async function stage1_softDeleteAll() {
  console.log('\n=== STAGE 1: soft-delete all posts ===');
  const posts = await listAllPosts();
  if (posts.length === 0) {
    console.log('  no posts to delete; skipping stage 1');
    return [];
  }
  console.log(`  total posts to delete: ${posts.length}`);

  const ids = posts.map(p => p.id);
  let succeeded = 0, failed = 0;
  for (const id of ids) {
    try {
      await softDeletePost(id);
      succeeded++;
      if (succeeded % 25 === 0) {
        console.log(`  soft-deleted ${succeeded}/${ids.length}`);
      }
    } catch (err) {
      failed++;
      console.warn(`  soft-delete failed for ${id}: ${err.response?.status || err.message}`);
    }
    await sleep(POLITE_GAP_MS);
  }

  console.log(`  done: ${succeeded} soft-deleted, ${failed} failed`);
  return ids;
}

// =============================================================================
// STAGE 2 — hard-purge each soft-deleted post
// =============================================================================

async function hardPurgePost(postId) {
  await client.post(
    `/moderator/post/posts/${postId}/expunge.json`,
    {},
    { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' } }
  );
  return 'expunged';
}

async function stage2_hardPurge(ids) {
  console.log('\n=== STAGE 2: hard-purge soft-deleted posts ===');
  if (ids.length === 0) {
    console.log('  nothing to purge; skipping stage 2');
    return;
  }
  let succeeded = 0, failed = 0;
  for (const id of ids) {
    try {
      await hardPurgePost(id);
      succeeded++;
      if (succeeded % 25 === 0) {
        console.log(`  purged ${succeeded}/${ids.length}`);
      }
    } catch (err) {
      failed++;
      console.warn(`  purge failed for ${id}: ${err.response?.status || err.message}`);
    }
    await sleep(POLITE_GAP_MS);
  }
  console.log(`  done: ${succeeded} purged, ${failed} failed`);
}

// =============================================================================
// STAGE 3 — reset local state (filesystem-driven)
// =============================================================================

async function* walkJson(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`  cannot read ${dir}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJson(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      yield full;
    }
  }
}

async function stage3_resetLocalState() {
  console.log('\n=== STAGE 3: reset local staging state ===');

  // 3a. DB blanket clear. No WHERE clause needed — clearing a NULL column to
  //     NULL is a no-op, and a blanket update sidesteps any DB↔sidecar drift
  //     introduced by an earlier dedup pass.
  const beforeCount = db.prepare(`
    SELECT COUNT(*) AS n FROM staging_images
    WHERE booru_post_id IS NOT NULL
       OR booru_upload_id IS NOT NULL
       OR booru_media_asset_id IS NOT NULL
  `).get().n;

  db.prepare(`
    UPDATE staging_images
    SET booru_post_id = NULL,
        booru_upload_id = NULL,
        booru_media_asset_id = NULL
  `).run();
  console.log(`  DB: cleared booru fields on ${beforeCount} row(s)`);

  // 3b. Filesystem sweep. Walk STAGING_DIR recursively, strip the three
  //     booru_* keys from every JSON sidecar that has them. pool* and
  //     everything else is preserved untouched. This catches keeper sidecars
  //     that inherited booru IDs through a dedup merge without the DB row
  //     reflecting it.
  console.log(`  scanning sidecars under ${STAGING_DIR} ...`);
  let scanned = 0, touched = 0, errored = 0;
  for await (const file of walkJson(STAGING_DIR)) {
    scanned++;
    try {
      const raw = await fs.readFile(file, 'utf8');
      let json;
      try { json = JSON.parse(raw); }
      catch { continue; }  // not valid JSON, skip silently
      if (typeof json !== 'object' || json === null) continue;

      let changed = false;
      for (const key of BOORU_KEYS) {
        if (key in json) {
          delete json[key];
          changed = true;
        }
      }
      if (!changed) continue;

      await fs.writeFile(file, JSON.stringify(json, null, 2));
      touched++;
      if (touched % 500 === 0) {
        console.log(`  ... stripped ${touched} so far (scanned ${scanned})`);
      }
    } catch (err) {
      errored++;
      console.warn(`  sidecar reset failed for ${file}: ${err.message}`);
    }
  }
  console.log(`  sidecars: scanned ${scanned}, stripped ${touched}, errored ${errored}`);
}

// =============================================================================
// MAIN
// =============================================================================

(async () => {
  console.log('one-shot-purge starting');
  console.log(`  Danbooru:    ${DANBOORU_URL}`);
  console.log(`  STAGING_DIR: ${STAGING_DIR}`);
  console.log(`  DB:          ${DB_PATH}`);
  console.log('  ⚠  This deletes ALL posts on the Danbooru instance ⚠');
  console.log('  Sleeping 5s — Ctrl+C to abort');
  await sleep(5000);

  try {
    const ids = await stage1_softDeleteAll();
    await stage2_hardPurge(ids);
    await stage3_resetLocalState();
    console.log('\n✓ purge complete');
    process.exit(0);
  } catch (err) {
    console.error('\n✗ purge failed:', err.response?.data || err.message);
    process.exit(1);
  }
})();
