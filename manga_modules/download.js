// manga/download.js
//
// Orchestrates: fetch all pages → build CBZ → record dedup row.
//
// Parallel fetch with a small concurrency limit. Using Promise.all
// over all pages at once would hammer the server and trip rate
// limiters. 4 concurrent is conservative — matches what the Python
// nhentai scraper does and is fine for hentainexus too.
//
// Per-page failure is fatal for the whole download. A 23-of-24
// archive isn't useful — Kavita would mark it incomplete and the
// user has to redownload anyway. Better to fail loudly and let them
// retry the whole thing.
//
// Progress callbacks fire after each page completes (success only —
// a failure rejects the whole promise before the next progress
// callback). Caller wires these to SSE.

const path = require('path');
const fs = require('fs').promises;

const { buildCbz } = require('./cbz');
const { buildDedupKey, findExistingDownload, recordDownload } = require('./dedup');

const FETCH_CONCURRENCY = 2;
const PER_PAGE_TIMEOUT_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 5;
const INTER_REQUEST_DELAY_MS = 150;   // small gap between same-worker fetches

/**
 * Sleep helper, abortable. Resolves on timeout, rejects on abort
 * with an AbortError so callers can fall through their existing
 * cancel handling.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Honor the Retry-After header if the server sent one. Returns ms.
 * Spec allows either a delta-seconds integer or an HTTP-date.
 * For our purposes "delta-seconds" is the common case and the only
 * one i.nhentai.net actually emits.
 */
function parseRetryAfterMs(headerValue, fallbackMs) {
  if (!headerValue) return fallbackMs;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 30_000);   // cap at 30s
  }
  return fallbackMs;
}

function safeFilename(str) {
  return String(str || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 200)
    .trim() || 'untitled';
}

function generateSubfolderHash() { return Math.random().toString(36).substring(2, 10); }

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

/**
 * Fetch one page with timeout + size guard. Returns { buffer,
 * contentType }. Throws on any failure.
 */
async function fetchPage(page, outerSignal) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; Kyabooru/1.0)',
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
  };
  if (page.referer) headers.Referer = page.referer;

  let attempt = 0;
  let lastError = null;

  while (attempt < RETRY_MAX_ATTEMPTS) {
    attempt++;
    if (outerSignal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    // Per-attempt controller, linked once to the outer signal. The
    // link is torn down in `finally` so we don't leak listeners.
    const attemptCtrl = new AbortController();
    const timer = setTimeout(() => attemptCtrl.abort(), PER_PAGE_TIMEOUT_MS);
    const forwardAbort = () => attemptCtrl.abort();
    outerSignal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const response = await fetch(page.url, {
        headers,
        signal: attemptCtrl.signal,
      });

      // 429 / 503 → backoff per Retry-After (or exponential default)
      if (response.status === 429 || response.status === 503) {
        const fallback = Math.min(1000 * 2 ** (attempt - 1), 16_000);
        const waitMs = parseRetryAfterMs(response.headers.get('retry-after'), fallback);
        console.warn(`[manga] ${response.status} on ${page.url} — backing off ${waitMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
        // Drain the body so the connection can be reused
        await response.arrayBuffer().catch(() => {});
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(waitMs, outerSignal);
        continue;
      }

      // Other 4xx → permanent. Don't retry, fail the whole download.
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${page.url}`);
      }

      // 5xx → retry with exponential backoff
      if (!response.ok) {
        const waitMs = Math.min(500 * 2 ** (attempt - 1), 8_000);
        console.warn(`[manga] ${response.status} on ${page.url} — retrying in ${waitMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(waitMs, outerSignal);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        contentType: response.headers.get('content-type') || null,
        url: page.url,
      };

    } catch (err) {
      // Outer-signal abort: bail immediately
      if (outerSignal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      // Per-attempt timeout or network blip: retry with backoff
      lastError = err;
      const waitMs = Math.min(500 * 2 ** (attempt - 1), 8_000);
      console.warn(`[manga] ${err.message} on ${page.url} — retrying in ${waitMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
      try {
        await sleep(waitMs, outerSignal);
      } catch {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw new Error(
    `Failed after ${RETRY_MAX_ATTEMPTS} attempts: ${lastError?.message || 'unknown'} (${page.url})`
  );
}


/**
 * Worker-pool fetch over an array of page descriptors. Preserves
 * order in the output array. Calls onProgress({ completed, total })
 * after each successful fetch.
 */
async function fetchAllPages({ pages, onProgress, signal }) {
  const results = new Array(pages.length);
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      const i = nextIndex++;
      if (i >= pages.length) return;
      results[i] = await fetchPage(pages[i], signal);
      completed++;
      onProgress?.({ completed, total: pages.length });
      if (INTER_REQUEST_DELAY_MS > 0) {
        await sleep(INTER_REQUEST_DELAY_MS, signal).catch(() => {});
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(FETCH_CONCURRENCY, pages.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Top-level orchestrator. Validates the bundle, checks dedup,
 * fetches all pages, builds CBZ, records dedup row.
 *
 * @param {Object} args
 * @param {Object} args.db         better-sqlite3 handle
 * @param {string} args.mangaDir   serverConfig.mangaDir
 * @param {Object} args.bundle     { source, metadata, pages, galleryId? }
 * @param {Function} args.onProgress
 *        ({ phase: 'fetch'|'archive', completed, total }) => void
 * @param {AbortSignal} args.signal optional cancel
 *
 * @returns {Promise<{ cbzPath, bytes, pageCount, alreadyExisted: false }>}
 *
 * Throws { code: 'EDUPLICATE', existing: <row> } if already
 * downloaded. Caller turns that into HTTP 409.
 */
async function downloadManga({ db, mangaDir, bundle, onProgress, signal }) {
  const { source, metadata, pages, galleryId } = bundle;

  if (!source) throw new Error('bundle.source is required');
  if (!metadata?.title) throw new Error('bundle.metadata.title is required');
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('bundle.pages must be a non-empty array');
  }

  // ---- Dedup check ----
  const dedupKey = buildDedupKey({
    source,
    artists: metadata.artists,
    title: metadata.title,
    chapter: metadata.chapter,
  });
  if (dedupKey) {
    const existing = findExistingDownload(db, dedupKey);
    if (existing) {
      const err = new Error('Manga already downloaded');
      err.code = 'EDUPLICATE';
      err.existing = existing;
      throw err;
    }
  }

  const baseFilename = safeFilename(metadata.title);
  const { hash: subfolderHash, subfolder } = await reserveSubfolder(mangaDir);
  const cbzPath = path.join(subfolder, `${baseFilename}.cbz`);

  // ---- Fetch pages + build CBZ ----
  // Wrapped so a failure (network, archive write, dedup record)
  // removes the empty subfolder rather than leaving orphans behind.
  let bytes, pageCount;
  try {
    onProgress?.({ phase: 'fetch', completed: 0, total: pages.length });
    const fetched = await fetchAllPages({
      pages,
      signal,
      onProgress: ({ completed, total }) => {
        onProgress?.({ phase: 'fetch', completed, total });
      },
    });

    onProgress?.({ phase: 'archive', completed: 0, total: 1 });
    ({ bytes, pageCount } = await buildCbz({
      pages: fetched,
      metadata,
      outPath: cbzPath,
    }));
    onProgress?.({ phase: 'archive', completed: 1, total: 1 });
  } catch (err) {
    // Best-effort cleanup. If the rm fails (permissions, missing),
    // log and swallow — we want the original error to propagate.
    try {
      await fs.rm(subfolder, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[manga] could not clean up ${subfolder}: ${cleanupErr.message}`);
    }
    throw err;
  }

  // ---- Record dedup ----
  if (dedupKey) {
    try {
      recordDownload(db, {
        source,
        artists: metadata.artists,
        title: metadata.title,
        chapter: metadata.chapter,
        galleryId,
        cbzPath,
        cbzBytes: bytes,
        pageCount,
        sourceUrl: metadata.sourceUrl,
      });
    } catch (err) {
      // Race with a concurrent submit. The CBZ is on disk; warn but
      // don't fail the request — the user has their file.
      console.warn(`[manga] dedup insert failed for ${baseFilename}: ${err.message}`);
    }
  }

  return { cbzPath, bytes, pageCount, alreadyExisted: false };
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  downloadManga,
  safeFilename,    // exported for tests
};