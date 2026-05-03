// server-config.js
//
// Owns the server's mutable runtime configuration.
//
// Boot resolution order for stagingDir:
//   1. process.env.KYABOORU_STAGING_DIR (highest priority — ops override)
//   2. server-config.json's stagingDir (last persisted user choice)
//   3. path.join(os.homedir(), 'Downloads')   (sensible default)
//
// Whichever path wins is auto-created (recursive mkdir) and the
// effective value is written back to server-config.json so the file
// always reflects current state.
//
// Runtime mutations go through setStagingDir(). The contract there is:
//   - validate input
//   - write the config file FIRST
//   - mutate in-memory state only on successful write
// Reasoning: if disk write fails, callers see a thrown error and
// in-memory state stays consistent with disk state.
//
// All path constants in server.js (STAGING_DIR, TRASH_DIR, THUMBS_DIR)
// are gone — every call site reads through serverConfig.{stagingDir,
// trashDir, thumbsDir}, which are getters. Derived dirs (.trash,
// .thumbs) are NOT cached: they're recomputed on each access so a
// runtime PATCH naturally swaps them too.
 
const fs = require('fs');
const path = require('path');
const os = require('os');
 
const CONFIG_PATH = path.join(__dirname, 'server-config.json');
 
// Single source of truth for the in-memory value. Mutated only by
// loadServerConfig() at boot and setStagingDir() at runtime.
const state = {
  stagingDir: null,
};
 
const serverConfig = {
  get stagingDir() {
    if (!state.stagingDir) {
      throw new Error('serverConfig accessed before loadServerConfig()');
    }
    return state.stagingDir;
  },
  get trashDir() {
    return path.join(this.stagingDir, '.trash');
  },
  get thumbsDir() {
    return path.join(this.stagingDir, '.thumbs');
  },
};
 
/**
 * Synchronously load config at boot. Call this once before anything
 * else touches the filesystem.
 *
 * Returns { stagingDir, source } where source is one of
 * 'env' | 'config' | 'default' — useful for the boot banner.
 *
 * Throws if the resolved staging dir cannot be created (the entire
 * app depends on it, so failing here is correct).
 */
function loadServerConfig() {
  let stagingDir = null;
  let source = null;
 
  // 1. Env var
  const envValue = process.env.KYABOORU_STAGING_DIR;
  if (typeof envValue === 'string' && envValue.trim()) {
    stagingDir = path.resolve(envValue.trim());
    source = 'env';
  }
 
  // 2. Config file
  if (!stagingDir) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.stagingDir === 'string' && parsed.stagingDir.trim()) {
        stagingDir = path.resolve(parsed.stagingDir.trim());
        source = 'config';
      }
    } catch (err) {
      // ENOENT means first boot — totally fine. Other errors are worth
      // surfacing because they probably indicate a corrupt config file
      // the user wants to know about.
      if (err.code !== 'ENOENT') {
        console.warn(`[server-config] couldn't read ${CONFIG_PATH}: ${err.message}`);
      }
    }
  }
 
  // 3. Default
  if (!stagingDir) {
    stagingDir = path.join(os.homedir(), 'Downloads');
    source = 'default';
  }
 
  // Auto-create on boot. First-boot default isn't user-typed, so silent
  // creation is the right behavior. Loud failure if it doesn't work.
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
  } catch (err) {
    console.error(`[server-config] FATAL: cannot create staging dir ${stagingDir}: ${err.message}`);
    throw err;
  }
 
  state.stagingDir = stagingDir;
 
  // Always persist the resolved value so the file stays in sync with
  // reality. This is a no-op write if the file already matches.
  try {
    persistConfig();
  } catch (err) {
    // Don't fail boot just because we couldn't write back to the
    // config file. Worst case the user gets the default again next
    // boot — annoying but not fatal.
    console.warn(`[server-config] couldn't persist ${CONFIG_PATH}: ${err.message}`);
  }
 
  return { stagingDir, source };
}
 
/**
 * Atomically replace the staging directory at runtime.
 *
 * Validation:
 *   - newPath is a non-empty string
 *   - resolved path differs from current value
 *   - resolved path exists, readable, writeable
 *
 * Write order: config file FIRST, then in-memory state. If the file
 * write fails, in-memory state is rolled back to its previous value
 * and the error propagates.
 *
 * Note: we deliberately do NOT auto-create on PATCH. Auto-create is
 * for the boot default (no human in the loop); PATCH is user-typed
 * and a typo'd path should fail loudly rather than silently create
 * an empty `D:\Donwloads\TagSaver`.
 *
 * Throws Error with .code set to one of:
 *   - 'EINVAL'  invalid input
 *   - 'ENOOP'   path is unchanged
 *   - 'ENOENT'  path doesn't exist
 *   - 'EACCES'  not readable/writeable
 *   - other fs errno codes pass through unchanged
 */
function setStagingDir(newPath) {
  if (typeof newPath !== 'string' || !newPath.trim()) {
    const err = new Error('stagingDir must be a non-empty string');
    err.code = 'EINVAL';
    throw err;
  }
 
  const resolved = path.resolve(newPath.trim());
 
  if (resolved === state.stagingDir) {
    const err = new Error('stagingDir is unchanged');
    err.code = 'ENOOP';
    throw err;
  }
 
  // accessSync throws with a useful errno if the path is missing or
  // inaccessible. We let that error propagate — the caller's HTTP
  // handler turns it into a 400.
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
 
  // Write the file FIRST. If this throws (disk full, permissions),
  // in-memory state stays untouched and the caller can retry.
  const previous = state.stagingDir;
  state.stagingDir = resolved;
  try {
    persistConfig();
  } catch (err) {
    state.stagingDir = previous;
    throw err;
  }
 
  return resolved;
}
 
function persistConfig() {
  const payload = {
    stagingDir: state.stagingDir,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2));
}
 
/**
 * Snapshot of the current config for GET /api/server-config.
 * Just an object literal; no I/O.
 */
function snapshot() {
  return {
    stagingDir: state.stagingDir,
  };
}
 
module.exports = {
  serverConfig,
  loadServerConfig,
  setStagingDir,
  snapshot,
};
