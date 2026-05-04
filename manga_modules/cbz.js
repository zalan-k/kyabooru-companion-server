// manga/cbz.js
//
// Builds a CBZ archive: zipped images + ComicInfo.xml at the root.
//
// CBZ is just ZIP with a different extension. We use `archiver` for
// streaming write (constant memory regardless of page count) rather
// than buffering the whole archive in RAM.
//
// ComicInfo.xml schema follows the de-facto standard recognized by
// Kavita, Komga, Mylar, etc:
//   https://github.com/anansi-project/comicinfo
//
// Page filenames inside the archive use 3-digit zero-padded indices
// (001.jpg, 002.png, ...) so alphabetical sort matches reading order.
// This is what every CBZ reader expects.

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

/**
 * Map a Content-Type or URL extension to a canonical lowercase ext
 * (without the dot). Falls back to 'jpg' since that's the dominant
 * format for scraped manga.
 */
function pickPageExtension({ contentType, url }) {
  if (contentType) {
    const lower = contentType.toLowerCase();
    if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
    if (lower.includes('png')) return 'png';
    if (lower.includes('webp')) return 'webp';
    if (lower.includes('gif')) return 'gif';
  }
  // Fall back to URL-derived extension
  if (url) {
    const m = url.match(/\.([a-z0-9]{2,4})(?:[?#]|$)/i);
    if (m) {
      const ext = m[1].toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
        return ext === 'jpeg' ? 'jpg' : ext;
      }
    }
  }
  return 'jpg';
}

/**
 * XML-escape a string. Only the five mandatory entities — ComicInfo
 * readers are forgiving but we don't want to emit broken XML for a
 * title containing & or <.
 */
function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build ComicInfo.xml content from normalized metadata.
 *
 * Mapping (matches the Python scrapers' output):
 *   Series          ← title
 *   AlternateSeries ← titleJapanese
 *   Writer          ← artists.join(', ')
 *   Genre           ← parodies.join(', ')
 *   Tags            ← tags.join(', ')
 *   Language        ← language
 *   PageCount       ← pageCount
 *   Web             ← sourceUrl
 *   Summary         ← description || sourceUrl
 *
 * Fields are emitted only when present so we don't leave empty
 * elements that confuse readers.
 */
function buildComicInfoXml(metadata) {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<ComicInfo>'];

  const push = (tag, value) => {
    if (value === null || value === undefined || value === '') return;
    lines.push(`  <${tag}>${xmlEscape(value)}</${tag}>`);
  };

  push('Series', metadata.title);
  push('AlternateSeries', metadata.titleJapanese);
  if (metadata.artists?.length) push('Writer', metadata.artists.join(', '));
  if (metadata.parodies?.length) push('Genre', metadata.parodies.join(', '));
  if (metadata.tags?.length) push('Tags', metadata.tags.join(', '));
  push('Language', metadata.language);
  if (metadata.pageCount) push('PageCount', String(metadata.pageCount));
  push('Web', metadata.sourceUrl);
  push('Summary', metadata.description || metadata.sourceUrl);

  lines.push('</ComicInfo>');
  return lines.join('\n');
}

/**
 * Build a CBZ archive at `outPath` containing:
 *   - one image per entry in `pages`
 *   - ComicInfo.xml at the root
 *
 * @param {Object} args
 * @param {Array<{ buffer: Buffer, contentType?: string, url?: string }>} args.pages
 *        Page buffers in reading order, plus enough info to pick an
 *        extension. Caller is responsible for fetching these.
 * @param {Object} args.metadata Normalized manga metadata.
 * @param {string} args.outPath Absolute path to write the .cbz.
 * @returns {Promise<{ bytes: number, pageCount: number }>}
 *
 * Errors propagate. Caller is responsible for cleanup of partial
 * writes — we don't try-and-delete because a failed write often
 * means disk full / permission, and a half-written CBZ should be
 * visible for debugging rather than silently vanish.
 */
async function buildCbz({ pages, metadata, outPath }) {
  if (!pages?.length) {
    throw new Error('buildCbz: pages array cannot be empty');
  }

  // Make sure parent dir exists. Caller usually does this, but it's
  // cheap insurance.
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', {
      // Manga images are already compressed (JPEG/PNG/WebP), so zip
      // compression is wasted CPU. Store-only is faster and the output
      // is essentially the same size.
      store: true,
    });

    let bytesWritten = 0;
    output.on('close', () => {
      resolve({ bytes: bytesWritten, pageCount: pages.length });
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      // ENOENT warnings are fatal in our context.
      if (err.code === 'ENOENT') reject(err);
      else console.warn('[cbz] archiver warning:', err.message);
    });
    output.on('finish', () => {
      bytesWritten = output.bytesWritten;
    });

    archive.pipe(output);

    // Pages
    pages.forEach((page, i) => {
      const ext = pickPageExtension({
        contentType: page.contentType,
        url: page.url,
      });
      const filename = `${String(i + 1).padStart(3, '0')}.${ext}`;
      archive.append(page.buffer, { name: filename });
    });

    // ComicInfo.xml at the root
    const comicInfo = buildComicInfoXml({
      ...metadata,
      pageCount: metadata.pageCount || pages.length,
    });
    archive.append(comicInfo, { name: 'ComicInfo.xml' });

    archive.finalize();
  });
}

module.exports = {
  buildCbz,
  buildComicInfoXml,    // exported for tests
  pickPageExtension,    // exported for tests
};