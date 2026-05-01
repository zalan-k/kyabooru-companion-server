// test-booru-flow.js
//
// Standalone end-to-end test of the upload + AI-tag + post flow on a
// single sidecar. No dependency on danbooru-uploader.js — uses axios
// directly so you can probe the booru without applying any of the
// pending refactor.
//
// Usage:
//   node test-booru-flow.js <staging-id>
//   node test-booru-flow.js                  # picks an arbitrary unposted sidecar
//   DO_POST=1 node test-booru-flow.js abc    # actually creates the post too
//
// Edit the STAGING_DIR constant below before running.

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// ---- Config -----------------------------------------------------------

const STAGING_DIR = process.env.STAGING_DIR || 'C:/Users/zalka/Downloads/TagSaver';  // <-- EDIT
const DO_POST = process.env.DO_POST === '1';

const BOORU = {
  baseUrl: (process.env.DANBOORU_URL || 'http://192.168.0.205:3000').replace(/\/$/, ''),
  username: process.env.DANBOORU_USER || 'kyabatsu',
  apiKey:   process.env.DANBOORU_KEY  || 'EPBFXUJbxWFsBPq2QZaf7TcY',
};

const AI_THRESHOLDS = {
  character: 0.75,
  copyright: 0.75,
  artist: 0.75,
  general: 0.25,
};

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15000;

const client = axios.create({
  baseURL: BOORU.baseUrl,
  auth: { username: BOORU.username, password: BOORU.apiKey },
  timeout: 5 * 60 * 1000,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

// ---- Booru calls (replicates uploader logic inline) -------------------

async function uploadFile(imagePath) {
  const form = new FormData();
  form.append('upload[files][0]', fsSync.createReadStream(imagePath));

  const res = await client.post('/uploads.json', form, { headers: form.getHeaders() });
  if (res.status !== 201) {
    throw new Error(`Upload returned ${res.status}: ${JSON.stringify(res.data)}`);
  }
  // Return BOTH ids — assetId for posting, mediaAssetId for AI tag lookup
  const uma = res.data.upload_media_assets[0];
  return { uploadAssetId: uma.id, mediaAssetId: uma.media_asset_id };
}

async function getAiTags(mediaAssetId) {
  // 1. Get raw {tag_id, score} pairs (score 0-100)
  const aiRes = await client.get(`/ai_tags.json`, {
    params: { 'search[media_asset_id]': mediaAssetId, limit: 100 }
  });
  const raw = aiRes.data;
  if (!raw || raw.length === 0) return [];

  // 2. Resolve tag_ids to names + categories
  const ids = raw.map(t => t.tag_id).join(',');
  const tagRes = await client.get(`/tags.json`, {
    params: { 'search[id]': ids, limit: 200 }
  });
  const tagMap = new Map(tagRes.data.map(t => [t.id, t]));

  const CAT_NUM_TO_NAME = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

  return raw.map(t => {
    const tag = tagMap.get(t.tag_id);
    return {
      tag: tag?.name || `unknown_${t.tag_id}`,
      score: (t.score ?? 0) / 100,  // normalize to 0-1
      category: CAT_NUM_TO_NAME[tag?.category] || 'general',
    };
  });
}

async function createPost(assetId, tagString, rating, source, parentId, options = {}) {
  const postData = {
    upload_media_asset_id: assetId,
    tag_string: tagString,
    rating,
    source: source || 'API Upload',
  };
  if (parentId) postData.parent_id = parentId;
  if (options.duplicateOverride) postData.bypass_dnp = true;

  try {
    const res = await client.post('/posts.json', postData);
    if (res.status !== 201) {
      const err = new Error(`Post returned ${res.status}`);
      err.body = res.data;
      err.status = res.status;
      throw err;
    }
    return res.data.id;
  } catch (err) {
    if (err.response) {
      const e = new Error(err.message);
      e.body = err.response.data;
      e.status = err.response.status;
      throw e;
    }
    throw err;
  }
}

// ---- Tag formatting (replicates uploader's processTags) ---------------

function processTags(metadata) {
  const parts = [];
  const tags = metadata.tags || {};
  for (const [category, tagList] of Object.entries(tags)) {
    if (!Array.isArray(tagList)) continue;
    if (category === 'general') {
      parts.push(...tagList);
    } else {
      parts.push(...tagList.map(t => `${category}:${t}`));
    }
  }
  return parts.join(' ');
}

function determineRating(metadata) {
  const all = [];
  for (const list of Object.values(metadata.tags || {})) {
    if (Array.isArray(list)) all.push(...list);
  }
  return all.includes('safe') ? 's' : 'e';
}

// ---- Sidecar probing --------------------------------------------------

async function findSidecar(maybeId) {
  if (maybeId) {
    const p = path.join(STAGING_DIR, `${maybeId}.json`);
    await fs.access(p);
    return p;
  }
  const files = (await fs.readdir(STAGING_DIR)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(STAGING_DIR, f), 'utf8'));
      if (!data.booruPostId) return path.join(STAGING_DIR, f);
    } catch {}
  }
  throw new Error('No unposted sidecars found in staging dir');
}

async function findImageFor(jsonPath) {
  const base = jsonPath.replace(/\.json$/, '');
  for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4']) {
    try {
      await fs.access(base + ext);
      return base + ext;
    } catch {}
  }
  throw new Error(`No image file next to ${jsonPath}`);
}

function categorize(aiTags) {
  const buckets = { character: [], copyright: [], artist: [], general: [], meta: [], other: [] };
  for (const t of aiTags) {
    const cat = t.category || 'general';
    (buckets[cat] || buckets.other).push(t);
  }
  return buckets;
}

const formatScore = (s) => (s ?? 0).toFixed(3);

// ---- Main -------------------------------------------------------------

(async () => {
  const arg = process.argv[2];
  const jsonPath = await findSidecar(arg);
  console.log(`\n📂 Sidecar: ${jsonPath}`);

  const metadata = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const imagePath = await findImageFor(jsonPath);
  console.log(`🖼  Image:   ${imagePath}\n`);

  // ---- Step 1: upload ----
  let uploadAssetId = metadata.booruUploadId;
  let mediaAssetId = metadata.booruMediaAssetId;
  if (uploadAssetId && mediaAssetId) {
    console.log(`✅ already uploaded: upload_asset=${uploadAssetId} media_asset=${mediaAssetId}`);
    console.log('   (skipping upload)\n');
  } else {
    console.log('⬆️  Uploading...');
    const t0 = Date.now();
    ({ uploadAssetId, mediaAssetId } = await uploadFile(imagePath));
    console.log(`✅ Uploaded in ${Date.now() - t0}ms — upload_asset=${uploadAssetId} media_asset=${mediaAssetId}\n`);
  }

  // ---- Step 2: poll for AI tags ----
  console.log('🤖 Polling for AI tags...');
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let aiTags = [];
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    aiTags = await getAiTags(mediaAssetId);
    console.log(`   attempt ${attempts}: ${aiTags.length} tags`);
    if (aiTags.length > 0) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (aiTags.length === 0) {
    console.log(`❌ No AI tags after ${POLL_TIMEOUT_MS}ms — autotagger queue may be backed up\n`);
  } else {
    console.log(`✅ Got ${aiTags.length} AI tags after ${attempts} attempt(s)\n`);
  }

  // ---- Step 3: dump raw tags by category ----
  if (aiTags.length > 0) {
    const buckets = categorize(aiTags);
    console.log('🏷  Raw AI tags by category:');
    for (const [cat, tags] of Object.entries(buckets)) {
      if (tags.length === 0) continue;
      const threshold = AI_THRESHOLDS[cat] ?? '?';
      console.log(`\n  [${cat}] (threshold ${threshold})`);
      tags
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .forEach(t => {
          const passes = (t.score ?? 0) >= (AI_THRESHOLDS[cat] ?? 1.0);
          console.log(`    ${passes ? '✓' : '·'} ${formatScore(t.score)}  ${t.tag}`);
        });
    }
    console.log('\n  ✓ = above threshold (would be merged)');
    console.log('  · = below threshold (would be skipped)\n');
  }

  // ---- Step 4: dump existing manual tags ----
  console.log('📝 Existing sidecar tags:');
  if (metadata.tags && typeof metadata.tags === 'object' && !Array.isArray(metadata.tags)) {
    for (const [cat, list] of Object.entries(metadata.tags)) {
      if (Array.isArray(list) && list.length) {
        console.log(`  [${cat}] ${list.join(', ')}`);
      }
    }
  } else if (Array.isArray(metadata.tags)) {
    console.log(`  ${metadata.tags.join(', ')}`);
  } else {
    console.log('  (no tags)');
  }
  console.log();

  // ---- Step 5: optionally post ----
  if (!DO_POST) {
    console.log('🚫 Not posting (set DO_POST=1 to actually post)\n');
    return;
  }

  console.log('📮 Creating post...');

  // Merge AI tags into metadata at thresholds
  if (!metadata.tags || typeof metadata.tags !== 'object' || Array.isArray(metadata.tags)) {
    metadata.tags = {};
  }
  for (const cat of ['general', 'character', 'copyright', 'artist', 'meta']) {
    if (!Array.isArray(metadata.tags[cat])) metadata.tags[cat] = [];
  }
  for (const t of aiTags) {
    const cat = t.category || 'general';
    const threshold = AI_THRESHOLDS[cat] ?? 1.0;
    if ((t.score ?? 0) < threshold) continue;
    if (!metadata.tags[cat].includes(t.tag)) metadata.tags[cat].push(t.tag);
  }

  let tagString = processTags(metadata);
  if (metadata.imageHash) tagString += ` meta:${metadata.imageHash}`;

  console.log(`   final tag_string: ${tagString}`);

  try {
    const postId = await createPost(
      uploadAssetId, tagString, determineRating(metadata),
      metadata.sourceUrl, null
    );
    console.log(`✅ Post created: ${postId}`);
    console.log(`   ${BOORU.baseUrl}/posts/${postId}\n`);
  } catch (err) {
    console.log(`❌ Post failed: ${err.message}`);
    console.log(`   status=${err.status}`);
    console.log(`   body=${JSON.stringify(err.body, null, 2)}\n`);

    // Auto-retry with override on 422 duplicate
    if (err.status === 422 && JSON.stringify(err.body || '').includes('md5')) {
      console.log('🔁 Looks like duplicate — retrying with bypass_dnp...');
      try {
        const postId = await createPost(
          assetId, tagString, determineRating(metadata),
          metadata.sourceUrl, null, { duplicateOverride: true }
        );
        console.log(`✅ Override succeeded: ${postId}`);
        console.log(`   ${BOORU.baseUrl}/posts/${postId}\n`);
      } catch (overrideErr) {
        console.log(`❌ Override also failed: ${overrideErr.message}`);
        console.log(`   status=${overrideErr.status}`);
        console.log(`   body=${JSON.stringify(overrideErr.body, null, 2)}\n`);
      }
    }
  }
})().catch(err => {
  console.error('\n💥 Fatal:', err.message);
  if (err.body) console.error('   body:', JSON.stringify(err.body, null, 2));
  process.exit(1);
});
