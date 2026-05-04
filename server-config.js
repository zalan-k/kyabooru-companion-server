// server-config.js
//
// Owns the server's mutable runtime configuration.
//
// Two managed paths:
//   stagingDir — staging area for the per-image pipeline (sidecars,
//                thumbs, trash). Indexed by SQLite.
//   mangaDir   — output dir for CBZ archives produced by the manga
//                downloader. Not indexed.
//
// Boot resolution order (per path):
//   1. process.env.KYABOORU_STAGING_DIR / KYABOORU_MANGA_DIR
//   2. server-config.json field
//   3. default — ~/Downloads (staging), ~/Manga (manga)
//
// Whichever path wins is auto-created (recursive mkdir) and the
// effective value is written back to server-config.json so the file
// always reflects current state.
//
// Runtime mutations go through setStagingDir() / setMangaDir(). The
// contract for both:
//   - validate input
//   - write the config file FIRST
//   - mutate in-memory state only on successful write
// Reasoning: if disk write fails, callers see a thrown error and
// in-memory state stays consistent with disk state.
//
// All path constants in server.js (STAGING_DIR, TRASH_DIR, THUMBS_DIR)
// are gone — every call site reads through serverConfig.{stagingDir,
// trashDir, thumbsDir, mangaDir}, which are getters. Derived dirs
// (.trash, .thumbs) are NOT cached: they're recomputed on each access
// so a runtime PATCH naturally swaps them too.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'server-config.json');

// Single source of truth for the in-memory values. Mutated only by
// loadServerConfig() at boot and setStagingDir/setMangaDir at runtime.
const state = {
  stagingDir: null,
  mangaDir: null,
};

const serverConfig = {
  get stagingDir() {
    if (!state.stagingDir) {
      throw new Error('serverConfig.stagingDir accessed before loadServerConfig()');
    }
    return state.stagingDir;
  },
  get mangaDir() {
    if (!state.mangaDir) {
      throw new Error('serverConfig.mangaDir accessed before loadServerConfig()');
    }
    return state.mangaDir;
  },
  get trashDir() {
    return path.join(this.stagingDir, '.trash');
  },
  get thumbsDir() {
    return path.join(this.stagingDir, '.thumbs');
  },
};

/**
 * Synchronously resolve one path field at boot time.
 * Returns { value, source } where source is 'env' | 'config' | 'default'.
 */
function resolvePath({ envName, configValue, defaultPath }) {
  const envValue = process.env[envName];
  if (typeof envValue === 'string' && envValue.trim()) {
    return { value: path.resolve(envValue.trim()), source: 'env' };
  }
  if (typeof configValue === 'string' && configValue.trim()) {
    return { value: path.resolve(configValue.trim()), source: 'config' };
  }
  return { value: defaultPath, source: 'default' };
}

/**
 * Synchronously load config at boot. Call this once before anything
 * else touches the filesystem.
 *
 * Returns:
 *   { stagingDir, mangaDir, sources: { staging, manga } }
 *
 * sources are 'env' | 'config' | 'default' — useful for the boot banner.
 *
 * Throws if either resolved path cannot be created.
 */
function loadServerConfig() {
  // Read config file once.
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[server-config] couldn't read ${CONFIG_PATH}: ${err.message}`);
    }
  }

  const staging = resolvePath({
    envName: 'KYABOORU_STAGING_DIR',
    configValue: parsed.stagingDir,
    defaultPath: path.join(os.homedir(), 'Downloads'),
  });

  const manga = resolvePath({
    envName: 'KYABOORU_MANGA_DIR',
    configValue: parsed.mangaDir,
    defaultPath: path.join(os.homedir(), 'Manga'),
  });

  // Auto-create both. First-boot defaults aren't user-typed, so silent
  // creation is the right behavior. Loud failure if either fails.
  for (const { value } of [staging, manga]) {
    try {
      fs.mkdirSync(value, { recursive: true });
    } catch (err) {
      console.error(`[server-config] FATAL: cannot create dir ${value}: ${err.message}`);
      throw err;
    }
  }

  state.stagingDir = staging.value;
  state.mangaDir = manga.value;

  // Persist the resolved values so the file stays in sync. No-op if
  // it already matches.
  try {
    persistConfig();
  } catch (err) {
    console.warn(`[server-config] couldn't persist ${CONFIG_PATH}: ${err.message}`);
  }

  return {
    stagingDir: state.stagingDir,
    mangaDir: state.mangaDir,
    sources: {
      staging: staging.source,
      manga: manga.source,
    },
  };
}

/**
 * Generic setter shared by setStagingDir and setMangaDir. Same
 * contract: validate → access-check → persist → mutate. If persist
 * fails, in-memory state rolls back.
 *
 * Throws Error with .code:
 *   - 'EINVAL' invalid input
 *   - 'ENOOP'  path is unchanged
 *   - 'ENOENT' path doesn't exist
 *   - 'EACCES' not readable/writeable
 *   - other fs errno codes pass through
 */
function setPath(stateKey, newPath) {
  if (typeof newPath !== 'string' || !newPath.trim()) {
    const err = new Error(`${stateKey} must be a non-empty string`);
    err.code = 'EINVAL';
    throw err;
  }

  const resolved = path.resolve(newPath.trim());

  if (resolved === state[stateKey]) {
    const err = new Error(`${stateKey} is unchanged`);
    err.code = 'ENOOP';
    throw err;
  }

  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);

  const previous = state[stateKey];
  state[stateKey] = resolved;
  try {
    persistConfig();
  } catch (err) {
    state[stateKey] = previous;
    throw err;
  }

  return resolved;
}

function setStagingDir(newPath) {
  return setPath('stagingDir', newPath);
}

function setMangaDir(newPath) {
  return setPath('mangaDir', newPath);
}

function persistConfig() {
  const payload = {
    stagingDir: state.stagingDir,
    mangaDir: state.mangaDir,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Snapshot for GET /api/server-config. No I/O.
 */
function snapshot() {
  return {
    stagingDir: state.stagingDir,
    mangaDir: state.mangaDir,
  };
}

module.exports = {
  serverConfig,
  loadServerConfig,
  setStagingDir,
  setMangaDir,
  snapshot,
};