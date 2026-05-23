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
// One feature flag:
//   camieEnabled — whether the Camie v2 tagger feature is active.
//                  Default true on first boot. Persisted in
//                  server-config.json so it survives restart.
//                  Has no env-var override (UI toggle is the only
//                  user-facing path).
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
// Runtime mutations go through setStagingDir() / setMangaDir() /
// setCamieEnabled(). The contract for all three:
//   - validate input
//   - write the config file FIRST
//   - mutate in-memory state only on successful write
// Reasoning: if disk write fails, callers see a thrown error and
// in-memory state stays consistent with disk state.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'server-config.json');

// Single source of truth for the in-memory values. Mutated only by
// loadServerConfig() at boot and the set* runtime mutators.
//
// All fields are nullable to make "not loaded yet" detectable. Note
// that `camieEnabled: false` is a valid runtime value, so the getter
// uses a strict `=== null` check rather than the truthy `!state.x`
// pattern used by the string fields.
const state = {
  stagingDir: null,
  mangaDir: null,
  bindHost: null,
  camieEnabled: null,
};

const serverConfig = {
  get stagingDir() {
    if (!state.stagingDir) { throw new Error('serverConfig.stagingDir accessed before loadServerConfig()');}
    return state.stagingDir;
  },
  get mangaDir() {
    if (!state.mangaDir) { throw new Error('serverConfig.mangaDir accessed before loadServerConfig()');}
    return state.mangaDir;
  },
  get bindHost() {
    if (!state.bindHost) { throw new Error('serverConfig.bindHost accessed before loadServerConfig()');}
    return state.bindHost;
  },
  get camieEnabled() {
    // Strict null check — `false` is a valid loaded value.
    if (state.camieEnabled === null) {
      throw new Error('serverConfig.camieEnabled accessed before loadServerConfig()');
    }
    return state.camieEnabled;
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
 *   { stagingDir, mangaDir, bindHost, camieEnabled,
 *     sources: { staging, manga, bindHost, camieEnabled } }
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

  let bindHost = { value: '127.0.0.1', source: 'default' };
  const envHost = process.env.KYABOORU_BIND_HOST;
  if (typeof envHost === 'string' && envHost.trim()) {
    bindHost = { value: envHost.trim(), source: 'env' };
  } else if (typeof parsed.bindHost === 'string' && parsed.bindHost.trim()) {
    bindHost = { value: parsed.bindHost.trim(), source: 'config' };
  }

  // camieEnabled — no env var. Default true on a fresh install.
  // Only accept `true`/`false`; anything else means the config was hand-
  // edited badly and we should fall back to the default rather than
  // silently coerce.
  let camieEnabled = { value: true, source: 'default' };
  if (typeof parsed.camieEnabled === 'boolean') {
    camieEnabled = { value: parsed.camieEnabled, source: 'config' };
  }

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

  state.stagingDir   = staging.value;
  state.mangaDir     = manga.value;
  state.bindHost     = bindHost.value;
  state.camieEnabled = camieEnabled.value;

  // Persist the resolved values so the file stays in sync. No-op if
  // it already matches.
  try {
    persistConfig();
  } catch (err) {
    console.warn(`[server-config] couldn't persist ${CONFIG_PATH}: ${err.message}`);
  }

  return {
    stagingDir:   state.stagingDir,
    mangaDir:     state.mangaDir,
    bindHost:     state.bindHost,
    camieEnabled: state.camieEnabled,
    sources: {
      staging:      staging.source,
      manga:        manga.source,
      bindHost:     bindHost.source,
      camieEnabled: camieEnabled.source,
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

/**
 * Mutate camieEnabled. Same persist-first contract as the path setters.
 *
 * Throws Error with .code:
 *   - 'EINVAL' input wasn't a boolean
 *   - 'ENOOP'  value is unchanged
 *   - other errors pass through from persistConfig (disk write failure)
 */
function setCamieEnabled(value) {
  if (typeof value !== 'boolean') {
    const err = new Error('camieEnabled must be a boolean');
    err.code = 'EINVAL';
    throw err;
  }

  if (value === state.camieEnabled) {
    const err = new Error('camieEnabled is unchanged');
    err.code = 'ENOOP';
    throw err;
  }

  const previous = state.camieEnabled;
  state.camieEnabled = value;
  try {
    persistConfig();
  } catch (err) {
    state.camieEnabled = previous;
    throw err;
  }
  return value;
}

function persistConfig() {
  const payload = {
    stagingDir:   state.stagingDir,
    mangaDir:     state.mangaDir,
    bindHost:     state.bindHost,
    camieEnabled: state.camieEnabled,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Snapshot for GET /api/server-config. No I/O.
 */
function snapshot() {
  return {
    stagingDir:   state.stagingDir,
    mangaDir:     state.mangaDir,
    bindHost:     state.bindHost,
    camieEnabled: state.camieEnabled,
  };
}

module.exports = {
  serverConfig,
  loadServerConfig,
  setStagingDir,
  setMangaDir,
  setCamieEnabled,
  snapshot,
};
