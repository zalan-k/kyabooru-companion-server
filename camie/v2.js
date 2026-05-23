// camie/v2.js
//
// Wraps the Python tag_server.py subprocess. Manages lifecycle (lazy
// spawn, idle-based auto-release), serializes requests through a
// coalescing queue, emits state changes for the SSE channel.
//
// State machine:
//
//                       setEnabled(false)
//      ┌────────────────────────────────────────┐
//      ▼                                        │
//   ┌──────┐  setEnabled(true)  ┌─────────┐   ┌─┴────┐
//   │ off  │ ────────────────► │ dormant │◄─►│ ...  │
//   └──────┘                   └────┬────┘   └──────┘
//                                   │ tagImages()
//                                   ▼
//                             ┌──────────┐  health OK  ┌────────┐
//                             │ loading  │ ──────────► │ active │
//                             └────┬─────┘             └────┬───┘
//                                  │ exit during load       │ idle 15m
//                                  │ / spawn fails          │ or unexpected
//                                  ▼                        │ exit
//                             ┌──────────┐                  │
//                             │ crashed  │◄─────────────────┘
//                             └──────────┘
//                              (recoverable: setEnabled(true) from crashed
//                               resets to dormant)
//
// State semantics:
//   off       Toggle is disabled. No process, no work.
//   dormant   Toggle on, model unloaded. tagImages() will trigger spawn.
//   loading   Process spawned, model loading. tagImages() awaits ready.
//   active    Model loaded. Inference proceeds. Idle countdown active.
//   crashed   Process died unexpectedly. setEnabled(true) clears it.
//             tagImages() resolves with empty results until cleared.
//
// Public API:
//   setEnabled(bool)         Toggle on/off. Serialized — concurrent calls
//                            queue rather than racing. Returns when this
//                            specific call's state transition is settled.
//   tagImages(paths, opts)   Inference. Returns one tag list per path.
//   getState()               { state, message, enabled }
//   on('state', listener)    Fires on every state change.
//   shutdown()               Clean kill, for server graceful exit.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');

// Tunables. Deliberately not exposed as config — these are chosen for
// the staging-manager use case (single user, single machine, occasional
// bursts) and don't need per-deployment tweaking.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const COALESCE_WINDOW_MS = 100;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 120_000;   // generous: first model load can be slow
const SHUTDOWN_GRACE_MS = 5_000;
const TAG_REQUEST_TIMEOUT_MS = 60_000;    // single batch ceiling

class CamieV2 extends EventEmitter {
  constructor({ pythonPath, scriptPath } = {}) {
    super();

    // Resolved at construction; not reactive to env changes after that.
    // KYABOORU_PYTHON lets the user point at a specific venv interpreter
    // without touching config files.
    this.pythonPath = pythonPath || process.env.KYABOORU_PYTHON || 'python';
    this.scriptPath = scriptPath || path.join(__dirname, 'tag_server.py');

    // The user toggle. server-config.js owns persistence; we mirror it
    // here for fast access. server.js is responsible for keeping the
    // two in sync.
    this.enabled = false;

    // Process state. See the diagram above.
    this.state = 'off';
    this.stateMessage = null;

    this.proc = null;
    this.port = null;
    this.idleTimer = null;

    // Coalescing queue. Each entry: { paths, opts, resolve, reject }.
    this.queue = [];
    this.coalesceTimer = null;
    this.flushInFlight = false;

    // Recreated on each spawn. Resolves when state becomes 'active'.
    this.readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;

    // Serializes setEnabled calls. Without this, a fast toggle
    // off→on→off can interleave between awaits and leave the wrapper
    // in an inconsistent state. The chain catches errors so one failed
    // transition doesn't poison the next.
    this._settingPromise = Promise.resolve();
  }

  // --------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------

  getState() {
    return {
      state: this.state,
      message: this.stateMessage,
      enabled: this.enabled,
    };
  }

  /**
   * Toggle the feature. Turning off kills any running process and
   * drains pending requests with empty results. Turning on transitions
   * to 'dormant' — the actual spawn happens lazily on the first
   * tagImages() call.
   *
   * Serialized — if a previous setEnabled is still settling, this one
   * queues behind it. Returns when this specific call's transition
   * has completed.
   */
  setEnabled(enabled) {
    this._settingPromise = this._settingPromise
      .catch(() => {})  // shield: a failed prior transition shouldn't block us
      .then(() => this._doSetEnabled(enabled));
    return this._settingPromise;
  }

  async _doSetEnabled(enabled) {
    enabled = !!enabled;
    // Allow re-entry from 'crashed' even when enabled is unchanged, so
    // the user can recover by clicking the toggle without first having
    // to cycle it off. Setting enabled=true while crashed transitions
    // us to dormant, ready for the next tagImages call to spawn.
    if (this.enabled === enabled && this.state !== 'crashed') return;
    this.enabled = enabled;

    if (!enabled) {
      this._drainQueue();
      if (this.proc) {
        await this._kill('SIGTERM');
      }
      this._setState('off');
    } else {
      // off|crashed → dormant. No spawn yet — first tagImages does it.
      this._setState('dormant');
    }
  }

  /**
   * Run inference on a batch of images.
   *
   * Returns an array the same length as `paths`. Each element is a tag
   * list ([{tag, score, category}, ...]) for that image. Empty arrays
   * mean either "no tags above threshold" or "Camie wasn't available"
   * — the caller can't and shouldn't distinguish. At call sites both
   * are treated as a no-op skip.
   *
   * @param {string[]} paths   absolute image paths
   * @param {object}   opts
   * @param {number}   opts.threshold   default 0.35
   * @param {string[]} opts.categories  default ['general', 'meta']
   */
  async tagImages(paths, opts = {}) {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    if (!this.enabled) return paths.map(() => []);
    if (this.state === 'crashed') return paths.map(() => []);

    try {
      await this._ensureActive();
    } catch (err) {
      console.warn(`[camie] could not become active: ${err.message}`);
      return paths.map(() => []);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        paths,
        opts: {
          threshold: opts.threshold ?? 0.35,
          categories: opts.categories ?? ['general', 'meta'],
        },
        resolve,
        reject,
      });
      this._scheduleFlush();
    });
  }

  /**
   * Hard shutdown. Called during server.js graceful exit. After this
   * the instance is unusable — create a new one to resume.
   */
  async shutdown() {
    this._drainQueue();
    if (this.proc) await this._kill('SIGTERM');
    this._setState('off');
    this.removeAllListeners();
  }

  // --------------------------------------------------------------------
  // State transitions
  // --------------------------------------------------------------------

  _setState(state, message = null) {
    if (this.state === state && this.stateMessage === message) return;
    this.state = state;
    this.stateMessage = message;
    this.emit('state', this.getState());
  }

  /**
   * Ensure the process is running and the model is ready. Idempotent;
   * concurrent callers during 'loading' all await the same ready promise.
   */
  async _ensureActive() {
    if (this.state === 'active') return;
    if (this.state === 'loading') return this.readyPromise;
    if (this.state === 'dormant') return this._spawn();
    throw new Error(`Cannot become active from state '${this.state}'`);
  }

  _spawn() {
    if (this.proc) return this.readyPromise;

    this._setState('loading');
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    let proc;
    try {
      proc = spawn(this.pythonPath, [this.scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this._setState('crashed', `spawn failed: ${err.message}`);
      this._readyReject(err);
      this._readyResolve = null;
      this._readyReject = null;
      return this.readyPromise;
    }
    this.proc = proc;

    this._readPortHandshake();
    this._wireLogging();
    this._wireExitHandler();

    return this.readyPromise;
  }

  /**
   * Read the FIRST line of stdout for "PORT=<n>". Anything before the
   * newline is parsed as the handshake; everything after is treated as
   * normal log output. This contract is the only thing forcing the
   * Python side to keep its handshake free of preamble.
   */
  _readPortHandshake() {
    let buffer = '';
    let received = false;

    const onData = (chunk) => {
      if (received) return;
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;

      const firstLine = buffer.slice(0, nl).trim();
      const rest = buffer.slice(nl + 1);
      received = true;
      this.proc?.stdout.removeListener('data', onData);

      const match = firstLine.match(/^PORT=(\d+)$/);
      if (!match) {
        console.error(`[camie] expected PORT= handshake, got: ${firstLine}`);
        this._kill('SIGKILL');
        return;
      }
      this.port = parseInt(match[1], 10);
      console.log(`[camie] handshake complete, port=${this.port}`);

      // Pipe any post-handshake stdout as normal logs.
      if (rest) this._logLines(rest, 'stdout');
      this.proc?.stdout.on('data', (c) => this._logLines(c.toString(), 'stdout'));

      // Now wait for the model to finish loading.
      this._pollHealth().catch(() => {});
    };

    this.proc.stdout.on('data', onData);
  }

  _wireLogging() {
    this.proc.stderr.on('data', (chunk) => this._logLines(chunk.toString(), 'stderr'));
  }

  _logLines(text, stream) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (stream === 'stderr') console.warn(`[camie] ${line}`);
      else console.log(`[camie] ${line}`);
    }
  }

  _wireExitHandler() {
    const proc = this.proc;
    proc.on('exit', (code, signal) => {
      // Was this expected? `_kill()` clears this.proc BEFORE sending
      // the signal, so when the exit fires after a kill, this.proc
      // already differs from the dying process — that's our signal
      // that this was deliberate.
      const wasExpected = this.proc !== proc;
      if (wasExpected) return;

      this.proc = null;
      this.port = null;
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      const msg = `exited code=${code} signal=${signal}`;
      console.warn(`[camie] ${msg}`);

      if (this.state === 'loading' && this._readyReject) {
        this._readyReject(new Error(`process exited during load (${msg})`));
        this._readyResolve = null;
        this._readyReject = null;
      }
      this._setState('crashed', msg);
      this._drainQueue();
    });
  }

  async _pollHealth() {
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) return;   // killed during load
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
          // Per-poll timeout so a stuck connect doesn't block the loop.
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) {
          this._setState('active');
          this._resetIdleTimer();
          if (this._readyResolve) {
            this._readyResolve();
            this._readyResolve = null;
            this._readyReject = null;
          }
          return;
        }
      } catch {
        // Not ready yet — uvicorn still binding or model still loading.
      }
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }

    console.error('[camie] health poll timed out, killing process');
    await this._kill('SIGKILL');
    this._setState('crashed', 'health check timed out');
    if (this._readyReject) {
      this._readyReject(new Error('health check timed out'));
      this._readyResolve = null;
      this._readyReject = null;
    }
  }

  // --------------------------------------------------------------------
  // Request queue / coalescing
  // --------------------------------------------------------------------

  _scheduleFlush() {
    if (this.coalesceTimer || this.flushInFlight) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this._flush().catch(err => console.error('[camie] flush error:', err));
    }, COALESCE_WINDOW_MS);
    this.coalesceTimer.unref?.();
  }

  async _flush() {
    if (this.flushInFlight || this.queue.length === 0) return;
    if (this.state !== 'active') {
      // State changed under us (e.g. crashed). Wait briefly and retry —
      // we don't want to lose the items.
      setTimeout(() => this._scheduleFlush(), COALESCE_WINDOW_MS);
      return;
    }

    this.flushInFlight = true;
    const batch = this.queue.splice(0);

    // Each queued call can specify its own threshold/categories. Group
    // by identical opts so we issue one HTTP request per group.
    const groups = new Map();
    for (const item of batch) {
      const key = `${item.opts.threshold}|${(item.opts.categories || []).join(',')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    try {
      for (const group of groups.values()) {
        const allPaths = group.flatMap(i => i.paths);
        const opts = group[0].opts;

        const res = await fetch(`http://127.0.0.1:${this.port}/tag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_paths: allPaths,
            threshold: opts.threshold,
            categories: opts.categories,
          }),
          signal: AbortSignal.timeout(TAG_REQUEST_TIMEOUT_MS),
        });

        if (!res.ok) {
          const err = new Error(`/tag returned ${res.status}`);
          for (const item of group) item.reject(err);
          continue;
        }

        const body = await res.json();
        const results = body.results || [];

        // Slice the batched response back into per-caller chunks.
        let idx = 0;
        for (const item of group) {
          const slice = results.slice(idx, idx + item.paths.length);
          idx += item.paths.length;
          item.resolve(slice);
        }
      }
    } catch (err) {
      console.error('[camie] flush HTTP error:', err.message);
      // Fail every pending item — better than dropping silently.
      for (const item of batch) {
        try { item.reject(err); } catch {}
      }
    } finally {
      this.flushInFlight = false;
      this._resetIdleTimer();
      if (this.queue.length > 0) this._scheduleFlush();
    }
  }

  _drainQueue() {
    if (this.queue.length === 0) return;
    const drained = this.queue.splice(0);
    for (const item of drained) {
      // Resolve with empty arrays so callers don't hang. Matches the
      // "disabled" semantics in tagImages().
      try { item.resolve(item.paths.map(() => [])); } catch {}
    }
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }

  // --------------------------------------------------------------------
  // Lifecycle helpers
  // --------------------------------------------------------------------

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Re-check at fire time: don't kill if work is in flight or queued.
      if (this.state === 'active' && this.queue.length === 0 && !this.flushInFlight) {
        console.log('[camie] idle timeout fired, releasing model');
        this._kill('SIGTERM').then(() => {
          if (this.enabled) this._setState('dormant');
        }).catch(() => {});
      }
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  async _kill(signal = 'SIGTERM') {
    const proc = this.proc;
    if (!proc) return;

    // Clear our reference first. This is how the exit handler tells
    // expected (kill) from unexpected (crash) exits.
    this.proc = null;
    this.port = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(graceTimer);
        resolve();
      };
      const graceTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, SHUTDOWN_GRACE_MS);
      graceTimer.unref?.();
      proc.once('exit', finish);
      try {
        proc.kill(signal);
      } catch (err) {
        console.warn(`[camie] kill(${signal}) failed: ${err.message}`);
        finish();
      }
    });
  }
}

// Module-level singleton — exactly one Camie instance per server process.
// server.js can either use this or instantiate its own; the singleton
// keeps things simple for the common case.
let _instance = null;

function getCamie() {
  if (!_instance) _instance = new CamieV2();
  return _instance;
}

module.exports = { CamieV2, getCamie };
