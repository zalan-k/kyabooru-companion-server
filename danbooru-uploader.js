// danbooru-uploader.js
//
// Two-step Danbooru flow:
//   1. POST /uploads.json  (multipart, file)  -> upload_media_asset_id
//   2. POST /posts.json    (json: tags, rating, source, parent_id)
//
// Server-friendly entry point:
//   const postId = await uploader.uploadFromMetadata(imagePath, metadata, parentId);
//   // Throws DanbooruUploadError on failure with { phase, status, body }
//
// CLI-friendly entry points (catch errors, log, return null on failure):
//   await uploader.uploadSinglePair(imagePath, jsonPath);
//   await uploader.uploadSequence(folderPath);

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "2025-07-05T22:55:57.823Z" -> "2025_07_05_22_55_57"
 */
function formatTimestamp(ts) {
  return ts
    .replace(/\.\d+Z?$/, '')
    .replace(/Z$/, '')
    .replace(/[-T:]/g, '_');
}

class DanbooruUploadError extends Error {
  constructor(message, { phase, status, body, cause } = {}) {
    super(message);
    this.name = 'DanbooruUploadError';
    this.phase = phase;       // 'upload' | 'post'
    this.status = status;     // HTTP status code from Danbooru
    this.body = body;         // response body, if any
    if (cause) this.cause = cause;
  }
}

class DanbooruUploader {
  constructor({ baseUrl, username, apiKey, timeout = 5 * 60 * 1000 }) {
    if (!baseUrl) throw new Error('DanbooruUploader: baseUrl is required');
    if (!username) throw new Error('DanbooruUploader: username is required');
    if (!apiKey) throw new Error('DanbooruUploader: apiKey is required');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.client = axios.create({
      baseURL: this.baseUrl,
      auth: { username, password: apiKey },
      timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    this.uploadedPosts = {}; // populated by uploadSequence; "{poolId}_{poolIndex}" -> post id
  }

  async loadMetadata(jsonPath) {
    const raw = await fs.promises.readFile(jsonPath, 'utf-8');
    return JSON.parse(raw);
  }

  processTags(metadata) {
    const parts = [];
    const tags = metadata.tags || {};
    for (const [category, tagList] of Object.entries(tags)) {
      if (!Array.isArray(tagList)) continue;
      if (category === 'general') {
        parts.push(...tagList);
      } else {
        parts.push(...tagList.map((t) => `${category}:${t}`));
      }
    }
    return parts.join(' ');
  }

  determineRating(metadata) {
    const allTags = [];
    for (const list of Object.values(metadata.tags || {})) {
      if (Array.isArray(list)) allTags.push(...list);
    }
    return allTags.includes('safe') ? 's' : 'e';
  }

  /**
   * Step 1 of the upload. Throws DanbooruUploadError with phase='upload' on failure.
   */
  async uploadFile(imagePath) {
    console.log(`Uploading file: ${path.basename(imagePath)}`);

    const form = new FormData();
    form.append('upload[files][0]', fs.createReadStream(imagePath));

    let res;
    try {
      res = await this.client.post('/uploads.json', form, {
        headers: form.getHeaders(),
      });
    } catch (err) {
      throw new DanbooruUploadError(
        `Upload request failed: ${err.message}`,
        {
          phase: 'upload',
          status: err.response?.status,
          body: err.response?.data,
          cause: err,
        }
      );
    }

    if (res.status !== 201) {
      throw new DanbooruUploadError(
        `Upload returned ${res.status}`,
        { phase: 'upload', status: res.status, body: res.data }
      );
    }

    console.log(`Upload successful! ID: ${res.data.id}`);
    return res.data;
  }

  /**
   * Step 2 of the upload. Throws DanbooruUploadError with phase='post' on failure.
   */
  async createPost(uploadData, metadata, parentId = null) {
    console.log('Creating post with tags...');

    let tagString = this.processTags(metadata);

    if (metadata.imageHash) {
      tagString += ` meta:${metadata.imageHash}`;
    }
    if (metadata.timestamp) {
      tagString += ` meta:${formatTimestamp(metadata.timestamp)}`;
    }

    const postData = {
      upload_media_asset_id: uploadData.upload_media_assets[0].id,
      tag_string: tagString,
      rating: this.determineRating(metadata),
      source: metadata.sourceUrl || 'API Upload',
    };

    if (parentId) postData.parent_id = parentId;

    let res;
    try {
      res = await this.client.post('/posts.json', postData);
    } catch (err) {
      throw new DanbooruUploadError(
        `Post creation request failed: ${err.message}`,
        {
          phase: 'post',
          status: err.response?.status,
          body: err.response?.data,
          cause: err,
        }
      );
    }

    if (res.status !== 201) {
      throw new DanbooruUploadError(
        `Post creation returned ${res.status}`,
        { phase: 'post', status: res.status, body: res.data }
      );
    }

    const postId = res.data.id;
    console.log(`Post created successfully! Post ID: ${postId}`);
    return postId;
  }

  /**
   * Server-friendly: takes an in-memory metadata object, no JSON file required.
   * Returns the new post ID. Throws DanbooruUploadError on failure.
   */
  async uploadFromMetadata(imagePath, metadata, parentId = null) {
    const uploadData = await this.uploadFile(imagePath);
    return await this.createPost(uploadData, metadata, parentId);
  }

  /**
   * Step 1 only. Returns { uploadAssetId, mediaAssetId }.
   *  - uploadAssetId: passed to /posts.json as upload_media_asset_id
   *  - mediaAssetId:  used for /ai_tags.json lookup
   */
  async uploadFileOnly(imagePath) {
    const data = await this.uploadFile(imagePath);
    const uma = data.upload_media_assets[0];
    return {
      uploadAssetId: uma.id,
      mediaAssetId: uma.media_asset_id,
    };
  }

  /**
   * Step 2 only. Caller controls metadata so AI tags can be merged in
   * before posting.
   *
   * options.duplicateOverride: if true, adds bypass_dnp=true to bypass
   * Danbooru's md5-collision rejection.
   */
  async createPostFromAsset(uploadAssetId, metadata, parentId = null, options = {}) {
    console.log('Creating post with tags...');

    let tagString = this.processTags(metadata);

    if (metadata.imageHash) tagString += ` meta:${metadata.imageHash}`;
    if (metadata.timestamp) tagString += ` meta:${formatTimestamp(metadata.timestamp)}`;

    const postData = {
      upload_media_asset_id: uploadAssetId,
      tag_string: tagString,
      rating: this.determineRating(metadata),
      source: metadata.sourceUrl || 'API Upload',
    };

    if (parentId) postData.parent_id = parentId;
    if (options.duplicateOverride) postData.bypass_dnp = true;

    let res;
    try {
      res = await this.client.post('/posts.json', postData);
    } catch (err) {
      throw new DanbooruUploadError(
        `Post creation request failed: ${err.message}`,
        {
          phase: 'post',
          status: err.response?.status,
          body: err.response?.data,
          cause: err,
        }
      );
    }

    if (res.status !== 201) {
      throw new DanbooruUploadError(
        `Post creation returned ${res.status}`,
        { phase: 'post', status: res.status, body: res.data }
      );
    }

    const postId = res.data.id;
    console.log(`Post created successfully! Post ID: ${postId}`);
    return postId;
  }

  /**
   * Fetch AI tags for a media asset.
   *
   * Returns array of { tag, score, category } with:
   *   - tag: resolved tag name (string)
   *   - score: normalized 0-1 (was 0-100 from booru)
   *   - category: 'general' | 'artist' | 'copyright' | 'character' | 'meta'
   *
   * Returns [] if no tags yet (autotagger still chewing).
   */
  async getAiTags(mediaAssetId) {
    // Step 1: raw {tag_id, score} pairs
    let raw;
    try {
      const res = await this.client.get('/ai_tags.json', {
        params: { 'search[media_asset_id]': mediaAssetId, limit: 100 },
      });
      raw = res.data || [];
    } catch (err) {
      console.warn(`getAiTags step1 failed for media asset ${mediaAssetId}: ${err.message}`);
      return [];
    }

    if (raw.length === 0) return [];

    // Step 2: resolve tag_ids to names + categories
    const ids = raw.map(t => t.tag_id).join(',');
    let tagDocs;
    try {
      const res = await this.client.get('/tags.json', {
        params: { 'search[id]': ids, limit: 200 },
      });
      tagDocs = res.data || [];
    } catch (err) {
      console.warn(`getAiTags step2 failed for media asset ${mediaAssetId}: ${err.message}`);
      return [];
    }

    const tagMap = new Map(tagDocs.map(t => [t.id, t]));
    const CAT_NUM_TO_NAME = {
      0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta',
    };

    return raw.map(t => {
      const tag = tagMap.get(t.tag_id);
      return {
        tag: tag?.name || `unknown_${t.tag_id}`,
        score: (t.score ?? 0) / 100,
        category: CAT_NUM_TO_NAME[tag?.category] || 'general',
      };
    });
  }

  // ---------- CLI-friendly methods (non-throwing, for the __main__ block) ----------

  async findImageJsonPairs(folderPath) {
    const entries = await fs.promises.readdir(folderPath);
    const pairs = [];
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;

      const imgPath = path.join(folderPath, name);
      const jsonPath = path.join(folderPath, name.slice(0, -ext.length) + '.json');

      try {
        await fs.promises.access(jsonPath);
        pairs.push([imgPath, jsonPath]);
      } catch {
        console.log(`Warning: No JSON file found for ${name}`);
      }
    }
    return pairs;
  }

  async uploadSinglePair(imagePath, jsonPath) {
    try {
      await fs.promises.access(imagePath);
      await fs.promises.access(jsonPath);
    } catch {
      console.log('Image or JSON file not found');
      return null;
    }

    const metadata = await this.loadMetadata(jsonPath);
    try {
      const postId = await this.uploadFromMetadata(imagePath, metadata);
      console.log(`Successfully uploaded: ${path.basename(imagePath)}`);
      return postId;
    } catch (err) {
      console.log(`Upload failed (${err.phase}): ${err.message}`);
      if (err.body) console.log(JSON.stringify(err.body));
      return null;
    }
  }

  async uploadSequence(folderPath) {
    const pairs = await this.findImageJsonPairs(folderPath);
    if (pairs.length === 0) {
      console.log('No image-JSON pairs found in the folder');
      return;
    }

    const sequences = new Map();
    for (const [imgPath, jsonPath] of pairs) {
      const metadata = await this.loadMetadata(jsonPath);
      const poolId = metadata.poolId ?? null;
      const poolIndex = metadata.poolIndex ?? 0;

      if (!sequences.has(poolId)) sequences.set(poolId, []);
      sequences.get(poolId).push({ imgPath, jsonPath, metadata, poolIndex });
    }
    for (const seq of sequences.values()) {
      seq.sort((a, b) => a.poolIndex - b.poolIndex);
    }

    for (const [poolId, sequence] of sequences) {
      console.log(`\n--- Processing sequence: ${poolId} ---`);
      let parentPostId = null;

      for (const item of sequence) {
        console.log(`\nProcessing pool index ${item.poolIndex}`);

        try {
          const postId = await this.uploadFromMetadata(item.imgPath, item.metadata, parentPostId);
          if (parentPostId === null) {
            parentPostId = postId;
            console.log(`Set parent post ID: ${parentPostId}`);
          }
          this.uploadedPosts[`${poolId}_${item.poolIndex}`] = postId;
        } catch (err) {
          console.log(`Failed (${err.phase}): ${err.message}`);
          if (err.body) console.log(JSON.stringify(err.body));
          // continue to next file
        }

        await sleep(1000);
      }
    }

    console.log(
      `\nUpload complete! Processed ${pairs.length} files in ${sequences.size} sequences.`
    );
  }
}

module.exports = { DanbooruUploader, DanbooruUploadError, formatTimestamp };

// CLI entry — same behavior as before.
if (require.main === module) {
  const uploader = new DanbooruUploader({
    baseUrl: process.env.DANBOORU_URL || 'http://192.168.0.205:3000',
    username: process.env.DANBOORU_USER || 'kyabatsu',
    apiKey: process.env.DANBOORU_KEY || 'EPBFXUJbxWFsBPq2QZaf7TcY',
  });

  const folderPath = process.argv[2];
  if (!folderPath) {
    console.error('Usage: node danbooru-uploader.js <folder-path>');
    process.exit(1);
  }

  uploader.uploadSequence(folderPath).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
