// manga_modules/upload.js
//
// Localfile manga upload path. Parallel to manga_modules/download.js
// but the network/dedup bits are gone: pages arrive as Buffers (via
// multer) so we skip straight to CBZ building.
//
// Why this is a separate module rather than another branch of
// downloadManga: downloadManga's signature is tied to the bundle
// shape that scrapers emit, and threading "no fetch, here are bytes"
// through there would mean either a second code path inside the same
// function or a fake-bundle-with-buffers convention. Cleaner to
// have a sibling module that shares cbz.js (which already exposes
// the right entry point) and shares download.js's safeFilename.
//
// Subfolder reservation is duplicated rather than imported because
// download.js doesn't export reserveSubfolder/pathExists. If you'd
// rather export them, this module is a one-line require swap.

const path = require('path');
const fs = require('fs').promises;

const { buildCbz } = require('./cbz');
const { safeFilename } = require('./download');

// ----------------------------------------------------------------
//  Subfolder reservation — kept in sync with download.js
// ----------------------------------------------------------------

function generateSubfolderHash() {
  return Math.random().toString(36).substring(2, 10);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function reserveSubfolder(mangaDir) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const hash = generateSubfolderHash();
    const subfolder = path.join(mangaDir, hash);
    if (!(await pathExists(subfolder))) {
      await fs.mkdir(subfolder, { recursive: false });
      return { hash, subfolder };
    }
  }
  throw new Error('Could not generate unique subfolder hash after 50 attempts');
}

// ----------------------------------------------------------------
//  Public API
// ----------------------------------------------------------------

/**
 * Build a CBZ from already-loaded page buffers.
 *
 * @param {Object}   args
 * @param {string}   args.mangaDir   serverConfig.mangaDir — must exist
 * @param {Object}   args.metadata   Same shape downloadManga consumes:
 *                                   { title, titleJapanese, artists[],
 *                                     parodies[], characters[], tags[],
 *                                     language, chapter, pageCount,
 *                                     sourceUrl, description }
 * @param {Array}    args.pages      Multer file objects in reading order:
 *                                   { buffer, originalname, mimetype, size }
 *                                   Caller is responsible for ordering
 *                                   (the /api/manga/upload route sorts
 *                                   by originalname).
 *
 * @returns {Promise<{ cbzPath: string, bytes: number, pageCount: number }>}
 *
 * Throws on validation failures and CBZ write failures. On failure
 * the freshly-created subfolder is removed so we don't leave empty
 * dirs littering mangaDir.
 *
 * Note: no DB involvement. Dedup is intentionally skipped for
 * localfile uploads — the user is the source of truth on duplicates,
 * and the current dedup detector is slated for rework anyway.
 */
async function uploadManga({ mangaDir, metadata, pages }) {
  if (!mangaDir) throw new Error('mangaDir is required');
  if (!metadata?.title) throw new Error('metadata.title is required');
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('pages must be a non-empty array');
  }

  const baseFilename = safeFilename(metadata.title);
  const { subfolder } = await reserveSubfolder(mangaDir);
  const cbzPath = path.join(subfolder, `${baseFilename}.cbz`);

  // Map multer file objects → cbz.js's page shape. mimetype is
  // reliably populated by multer for the image types this endpoint
  // accepts (image/jpeg, image/png, image/webp, image/gif), so
  // pickPageExtension's contentType branch covers us without needing
  // a url field.
  const cbzPages = pages.map(p => ({
    buffer: p.buffer,
    contentType: p.mimetype,
  }));

  let bytes, pageCount;
  try {
    ({ bytes, pageCount } = await buildCbz({
      pages: cbzPages,
      metadata,
      outPath: cbzPath,
    }));
  } catch (err) {
    // Best-effort cleanup of the empty/partial subfolder. Match
    // downloadManga's pattern: swallow cleanup errors so the original
    // error propagates to the caller.
    try {
      await fs.rm(subfolder, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[manga-upload] cleanup failed for ${subfolder}: ${cleanupErr.message}`);
    }
    throw err;
  }

  return { cbzPath, bytes, pageCount };
}

module.exports = { uploadManga };
