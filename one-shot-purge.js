#!/usr/bin/env node
/**
 * one-shot-purge.js — Hard-delete every post on the Danbooru instance,
 * then reset all booru-tracking fields in the local staging DB and
 * sidecar JSONs so the affected images are eligible for re-upload.
 *
 * Run from the kyabooru-companion-server directory:
 *   node one-shot-purge.js
 *
 * NOT idempotent in the sense that re-running after a successful run
 * does nothing useful — but it IS safe to re-run if it crashed
 * partway. Each pass deletes whatever's still on the booru and resets
 * whatever still has booru IDs locally.
 *
 * Three stages:
 *   1. List every post on the booru, batch-delete them.
 *   2. Hard-purge each soft-deleted post.
 *   3. Reset local staging state (DB rows + sidecar JSONs).
 *
 * After running, every staging image is "fresh" — uploading via the
 * normal flow will re-create posts with current canonicalized tags +
 * AI tag merging.
 */

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
const STAGING_DIR   = process.env.STAGING_DIR   || 'C:\\Users\\zalka\\Downloads\\TagSaver';
const DB_PATH       = path.join(process.cwd(), 'tag_saver.db');

// Pause between API hits to avoid hammering. Tune if you have many posts.
const POLITE_GAP_MS = 250;

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
  // Danbooru paginates; use page=N until empty. Limit 200 per page.
  // `tags=status:any` makes the index return deleted+pending+everything,
  // not just the default "active only" filter.
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
  // Danbooru's destroy endpoint marks the post deleted. With admin
  // creds it goes through immediately; without, it queues a request.
  // We expect 204 or similar success on completion.
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
  // Per the route table: POST /moderator/post/posts/:id/expunge.json
  // Requires moderator+ permissions.
  //
  // Send empty JSON body + explicit Accept header. Without these,
  // Danbooru's moderator controller returns 406 Not Acceptable —
  // it negotiates content type strictly on these admin routes.
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
// STAGE 3 — local reset
// =============================================================================

async function stage3_resetLocalState() {
  console.log('\n=== STAGE 3: reset local staging state ===');

  // 3a. DB: clear booru fields on every staging_images row that has
  //     any of them set.
  const rows = db.prepare(`
    SELECT id, json_path
    FROM staging_images
    WHERE booru_post_id IS NOT NULL
       OR booru_upload_id IS NOT NULL
       OR booru_media_asset_id IS NOT NULL
  `).all();

  if (rows.length === 0) {
    console.log('  no rows have booru state; nothing to reset');
    return;
  }
  console.log(`  resetting ${rows.length} rows + their sidecars`);

  // 3b. DB update — single statement, transactioned.
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE staging_images
      SET booru_post_id = NULL,
          booru_upload_id = NULL,
          booru_media_asset_id = NULL
      WHERE booru_post_id IS NOT NULL
         OR booru_upload_id IS NOT NULL
         OR booru_media_asset_id IS NOT NULL
    `).run();
  });
  tx();
  console.log('  DB rows cleared');

  // 3c. Sidecar JSONs — strip the same fields, write back.
  let touched = 0, skipped = 0, errored = 0;
  for (const row of rows) {
    try {
      const raw = await fs.readFile(row.json_path, 'utf8');
      const json = JSON.parse(raw);
      let changed = false;
      for (const key of ['booruPostId', 'booruUploadId', 'booruMediaAssetId']) {
        if (key in json) {
          delete json[key];
          changed = true;
        }
      }
      if (!changed) {
        skipped++;
        continue;
      }
      await fs.writeFile(row.json_path, JSON.stringify(json, null, 2));
      touched++;
    } catch (err) {
      errored++;
      if (err.code === 'ENOENT') {
        // Sidecar gone — DB row was orphaned. Already cleared in DB,
        // nothing to do.
        continue;
      }
      console.warn(`  sidecar reset failed for ${row.id}: ${err.message}`);
    }
  }
  console.log(`  sidecars: ${touched} updated, ${skipped} no-op, ${errored} errored`);
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
