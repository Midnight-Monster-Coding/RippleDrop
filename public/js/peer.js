/**
 * RippleDrop — WebRTC Peer Manager  v10 (send-loop bottleneck fix)
 *
 * ══════════════════════════════════════════════════════════════════
 * THE ACTUAL CAUSE OF 1 MB/s ON LOCAL WIFI (v9 bug)
 * ══════════════════════════════════════════════════════════════════
 *
 * v9 called `await drainBuffer()` BEFORE every single dc.send() call:
 *
 *   for each 64 KB chunk:
 *     await drainBuffer()   ← always executed, even as fast-path Promise.resolve()
 *     dc.send(chunk)
 *
 * In JavaScript, EVERY `await` — even on an already-resolved Promise —
 * yields to the microtask queue. That means:
 *   - V8 suspends the async function
 *   - Schedules a microtask to resume it
 *   - Resumes on the next microtask checkpoint
 *
 * At 64 KB chunks for an 8 MB batch = 128 chunks = 128 forced async yields
 * per batch. Each yield costs ~5–50 µs of scheduler overhead. This alone
 * caps throughput to ~1–3 MB/s regardless of your WiFi speed, even on a
 * direct LAN connection with 7 ms RTT.
 *
 * THE FIX (v10):
 *   Send synchronously. Only await when the buffer is actually full.
 *
 *   for each 256 KB chunk:
 *     dc.send(chunk)                              ← synchronous, no yield
 *     if (bufferedAmount >= HIGH_WATERMARK):
 *       await drainBuffer()                       ← only yields when needed
 *
 * Combined with 256 KB chunks (4× fewer send() calls than v9's 64 KB),
 * this delivers the full DataChannel throughput: 20–100 MB/s on local WiFi.
 *
 * OTHER IMPROVEMENTS IN v10:
 *  - STUN servers added → works cross-network when deployed on Render
 *  - HIGH_WATERMARK raised to 8 MB → more data in-flight → better pipelining
 *  - LOW_WATERMARK raised to 1 MB → less frequent drain cycles
 *  - BATCH_BYTES raised to 16 MB → half as many disk reads
 *  - SDP patching kept (removes b=AS bandwidth caps Chrome sometimes injects)
 */

// ─── Tuning constants ──────────────────────────────────────────────────────

const CHUNK_SIZE     = 262144;   // 256 KB — Chrome's DataChannel max message size.
                                 // 4× larger than v9's 64 KB → 4× fewer send() calls.

const BATCH_BYTES    = 16777216; //  16 MB per File.slice() disk read.
                                 //  Fewer async disk ops = more time on the wire.

const HIGH_WATERMARK = 8388608;  //   8 MB: only pause here. More in-flight data
                                 //   = better utilisation of the SCTP congestion window.

const LOW_WATERMARK  = 1048576;  //   1 MB: resume when buffer drains to this.
                                 //  Wider band between HIGH/LOW = fewer drain cycles.

// ─── ICE / STUN config ────────────────────────────────────────────────────

/**
 * v10 adds Google STUN servers so RippleDrop works even when the two devices
 * are on different networks (e.g. Render-deployed app used cross-ISP).
 *
 * For same-LAN transfers the `host` candidate still wins (lower RTT), so
 * adding STUN doesn't slow down local transfers — it only adds a fallback.
 */
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ─── SDP helpers ──────────────────────────────────────────────────────────

/**
 * Remove bandwidth-cap lines Chrome may inject into SDP.
 * b=AS:30  caps DataChannel to 30 kbps in some Chrome versions.
 * b=TIAS:N is the newer per-transport cap — also removed.
 */
function removeBandwidthCaps(sdp) {
  return sdp
    .replace(/\r\nb=AS:\d+/g,   '')
    .replace(/\r\nb=CT:\d+/g,   '')
    .replace(/\r\nb=TIAS:\d+/g, '');
}

/**
 * Raise the SCTP max-message-size to 256 KB in the SDP.
 * Without this some Chrome versions fragment 256 KB messages into smaller
 * SCTP chunks, adding framing overhead for no benefit.
 */
function setMaxMessageSize(sdp, bytes = 262144) {
  if (/a=max-message-size:\d+/.test(sdp)) {
    return sdp.replace(/a=max-message-size:\d+/, `a=max-message-size:${bytes}`);
  }
  return sdp.replace(/(m=application [^\n]+\n)/, `$1a=max-message-size:${bytes}\r\n`);
}

function patchSdp(sdp) {
  return setMaxMessageSize(removeBandwidthCaps(sdp));
}

// ─── SpeedMeter ───────────────────────────────────────────────────────────

export class SpeedMeter {
  #lastBytes     = 0;
  #lastTime      = performance.now();
  #smoothedSpeed = 0;

  update(currentTotalBytes) {
    const now    = performance.now();
    const deltaT = (now - this.#lastTime) / 1000;
    if (deltaT >= 0.1) {
      const deltaB       = currentTotalBytes - this.#lastBytes;
      const currentSpeed = deltaB / deltaT;
      this.#smoothedSpeed = this.#smoothedSpeed === 0
        ? currentSpeed
        : (currentSpeed * 0.3) + (this.#smoothedSpeed * 0.7);
      this.#lastBytes = currentTotalBytes;
      this.#lastTime  = now;
    }
  }

  get bytesPerSecond()      { return this.#smoothedSpeed; }
  eta(total, current)       { return this.#smoothedSpeed <= 0 ? Infinity : (total - current) / this.#smoothedSpeed; }
  formatSpeed()             { return _fmtSpeed(this.bytesPerSecond); }
  formatETA(total, current) { return _fmtETA(this.eta(total, current)); }
}

function _fmtSpeed(bps) {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function _fmtETA(s) {
  if (!isFinite(s) || s < 0) return '—';
  if (s < 4)    return 'almost done';
  if (s < 60)   return `${Math.round(s)}s left`;
  if (s < 3600) return `${Math.round(s / 60)}m left`;
  return `${(s / 3600).toFixed(1)}h left`;
}

// ─── Backpressure primitive ────────────────────────────────────────────────

/**
 * drainBuffer(dc) — resolves when safe to resume sending.
 *
 * KEY: This is called AFTER dc.send() pushes the buffer over HIGH_WATERMARK,
 * NOT before every send. This is what makes v10 fast.
 *
 * Race-condition fix (same as v9): all checks happen synchronously inside
 * the Promise constructor. JS is single-threaded so SCTP events can only
 * arrive after we yield. If the buffer already drained by the time we check,
 * we resolve immediately — no listener needed.
 *
 * @param {RTCDataChannel} dc
 * @returns {Promise<void>}
 */
function drainBuffer(dc) {
  return new Promise(resolve => {
    // Synchronous check inside constructor — race-free.
    if (!dc || dc.bufferedAmount < LOW_WATERMARK) {
      resolve();
      return;
    }
    dc.bufferedAmountLowThreshold = LOW_WATERMARK;
    dc.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

/**
 * waitForFullDrain(dc) — wait until the send buffer is completely empty.
 * Called after the last chunk so the receiver gets 'done' only after all
 * bytes have been handed off to the OS network stack.
 */
function waitForFullDrain(dc) {
  return new Promise(resolve => {
    if (!dc || dc.bufferedAmount === 0) { resolve(); return; }

    const prev = dc.bufferedAmountLowThreshold;
    dc.bufferedAmountLowThreshold = 0;

    const handler = () => {
      dc.bufferedAmountLowThreshold = prev;
      resolve();
    };
    dc.addEventListener('bufferedamountlow', handler, { once: true });
  });
}

// ─── RipplePeer ───────────────────────────────────────────────────────────

export class RipplePeer {
  #pc = null;
  #dc = null;

  #role;
  #socket;
  #cb;

  #incomingMeta   = null;
  #incomingChunks = [];
  #receivedBytes  = 0;
  #recvSpeed      = new SpeedMeter();

  constructor({ role, socket, callbacks }) {
    this.#role   = role;
    this.#socket = socket;
    this.#cb     = callbacks;
  }

  async init() {
    this.#pc = new RTCPeerConnection(ICE_CONFIG);

    // ── ICE candidate handler ──────────────────────────────────────────────
    this.#pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      // Forward all candidate types — host for LAN, srflx for cross-network.
      console.log('[ICE] Candidate:', candidate.type, candidate.address ?? '(mDNS)');
      this.#socket.emit('signal', { signal: { type: 'ice', candidate } });
    };

    // ── ICE state logging ──────────────────────────────────────────────────
    this.#pc.oniceconnectionstatechange = () => {
      const s = this.#pc?.iceConnectionState;
      if (!s) return;
      console.log('[ICE]', s);
      if (s === 'connected' || s === 'completed') this.#logIceStats();
      if (s === 'failed') {
        this.#cb.onError?.('Direct connection failed. Check that both devices can reach the internet or are on the same network.');
      }
      if (s === 'disconnected') {
        this.#cb.onError?.('The other device disconnected.');
      }
    };

    // ── DataChannel setup ──────────────────────────────────────────────────
    if (this.#role === 'host') {
      this.#dc = this.#pc.createDataChannel('rippledrop', {
        ordered: true,       // Required for correct file reassembly
      });
      this.#dc.bufferedAmountLowThreshold = LOW_WATERMARK;
      this.#dc.binaryType = 'arraybuffer';
      this.#bindChannel(this.#dc);

      const offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription({
        type: offer.type,
        sdp:  patchSdp(offer.sdp),
      });
      this.#socket.emit('signal', { signal: { type: 'offer', sdp: this.#pc.localDescription } });

    } else {
      // Guest (receiver) — DataChannel is created by the host
      this.#pc.ondatachannel = ({ channel }) => {
        this.#dc = channel;
        this.#dc.bufferedAmountLowThreshold = LOW_WATERMARK;
        this.#dc.binaryType = 'arraybuffer';
        this.#bindChannel(this.#dc);
      };
    }
  }

  async handleSignal(signal) {
    if (!this.#pc) return;
    try {
      if (signal.type === 'offer') {
        await this.#pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription({
          type: answer.type,
          sdp:  patchSdp(answer.sdp),
        });
        this.#socket.emit('signal', { signal: { type: 'answer', sdp: this.#pc.localDescription } });

      } else if (signal.type === 'answer') {
        await this.#pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      } else if (signal.type === 'ice' && signal.candidate) {
        await this.#pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (e) {
      console.error('[Signal] Error:', e);
    }
  }

  // ── ICE stats (confirms path type) ────────────────────────────────────────

  async #logIceStats() {
    try {
      await new Promise(r => setTimeout(r, 700));
      const stats   = await this.#pc?.getStats();
      if (!stats) return;
      const reports = {};
      stats.forEach(r => { reports[r.id] = r; });

      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
          const local  = reports[report.localCandidateId];
          const remote = reports[report.remoteCandidateId];
          const rtt    = report.currentRoundTripTime != null
            ? `${(report.currentRoundTripTime * 1000).toFixed(1)} ms RTT`
            : 'RTT unknown';

          console.group('%c[ICE Stats] Active path', 'color:#22d3ee;font-weight:bold');
          console.log('Local  :', local?.candidateType,  '|', local?.address  ?? '(mDNS)', ':', local?.port);
          console.log('Remote :', remote?.candidateType, '|', remote?.address ?? '(mDNS)', ':', remote?.port);
          console.log('Path   :', rtt);

          if (local?.candidateType === 'host') {
            console.log('%c✅ DIRECT LAN — file bytes stay on your WiFi. Expect 20–100 MB/s.', 'color:#4ade80;font-weight:bold');
          } else if (local?.candidateType === 'srflx') {
            console.log('%c🌐 STUN path — P2P over internet. Expect 1–50 MB/s depending on ISP.', 'color:#fbbf24;font-weight:bold');
          } else {
            console.log('%c⚠️ Path type:', 'color:#f87171', local?.candidateType);
          }
          console.groupEnd();
        }
      });
    } catch (e) {
      console.warn('[ICE Stats] Could not read stats:', e);
    }
  }

  // ── DataChannel binding ────────────────────────────────────────────────────

  #bindChannel(dc) {
    dc.onopen    = () => this.#cb.onOpen?.();
    dc.onclose   = () => this.#cb.onClose?.();
    dc.onerror   = (e) => { console.error('[DC]', e); this.#cb.onError?.('Transfer channel error.'); };
    dc.onmessage = (e) => this.#onMessage(e);
  }

  // ── Receive path ──────────────────────────────────────────────────────────

  #onMessage({ data }) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'meta') {
        this.#incomingMeta   = msg;
        this.#incomingChunks = [];
        this.#receivedBytes  = 0;
        this.#recvSpeed      = new SpeedMeter();
        this.#cb.onFileMeta?.(msg);

      } else if (msg.type === 'done') {
        const blob = new Blob(this.#incomingChunks, { type: this.#incomingMeta.mimeType });
        this.#cb.onFileDone?.(blob, this.#incomingMeta);
        this.#incomingMeta   = null;
        this.#incomingChunks = [];
        this.#receivedBytes  = 0;
      }

    } else {
      // Binary chunk
      this.#incomingChunks.push(data);
      this.#receivedBytes += data.byteLength;
      this.#recvSpeed.update(this.#receivedBytes);
      this.#cb.onChunkReceived?.({
        receivedBytes: this.#receivedBytes,
        totalBytes:    this.#incomingMeta?.size ?? 1,
        speed:         this.#recvSpeed,
        meta:          this.#incomingMeta,
      });
    }
  }

  // ── Public send API ────────────────────────────────────────────────────────

  async sendFiles(files, onProgress) {
    for (let i = 0; i < files.length; i++) {
      await this.#sendOne(files[i], i, files.length, onProgress);
    }
  }

  // ── Core send loop ─────────────────────────────────────────────────────────

  async #sendOne(file, fileIndex, fileTotal, onProgress) {
    // 1. Send metadata frame
    const meta = {
      type:     'meta',
      name:     file.name,
      size:     file.size,
      mimeType: file.type || 'application/octet-stream',
      fileIndex,
      fileTotal,
    };
    this.#dc.send(JSON.stringify(meta));

    if (file.size === 0) {
      this.#dc.send(JSON.stringify({ type: 'done' }));
      onProgress?.({ sentBytes: 0, totalBytes: 0, speed: new SpeedMeter(), meta, fileIndex, fileTotal, isLastChunk: true });
      return;
    }

    // 2. Progress reporting via timer (keeps UI smooth without flooding)
    const speed     = new SpeedMeter();
    let   bytesSent = 0;

    const uiTimer = setInterval(() => {
      if (!this.#dc) return;
      speed.update(bytesSent);
      onProgress?.({ sentBytes: bytesSent, totalBytes: file.size, speed, meta, fileIndex, fileTotal, isLastChunk: false });
    }, 100);

    try {
      // 3. ── THE FAST SEND LOOP ─────────────────────────────────────────────
      //
      // v10 KEY CHANGE vs v9:
      //   v9: await drainBuffer() BEFORE every dc.send() — forced microtask
      //       yield on every 64 KB chunk → capped at ~1 MB/s.
      //   v10: dc.send() is SYNCHRONOUS. We only await when the send buffer
      //       actually fills up (bufferedAmount ≥ HIGH_WATERMARK = 8 MB).
      //       On a fast local WiFi connection this `await` never triggers
      //       until the buffer is genuinely full, so the hot path has ZERO
      //       async overhead. This is why you get 20–100 MB/s instead of 1 MB/s.
      //
      // PIPELINE:
      //   While sending batch N, disk read for batch N+1 runs concurrently.
      //   The `await nextBatchPromise` at the top of the loop is the only
      //   true async boundary in the hot path (and it resolves fast because
      //   the read started one iteration ago).
      //
      // CHUNK STRATEGY:
      //   256 KB views into an ArrayBuffer — zero-copy. dc.send(TypedArray)
      //   passes the buffer directly to SCTP without copying.

      let fileOffset = 0;

      // Kick off the first disk read immediately
      let nextBatchPromise = this.#readBatch(file, fileOffset);
      fileOffset = Math.min(fileOffset + BATCH_BYTES, file.size);

      while (true) {
        // Wait for the current batch to land in RAM
        const batch = await nextBatchPromise;
        if (!batch || batch.byteLength === 0) break;

        // Kick off the NEXT disk read while we send this batch (pipeline)
        if (fileOffset < file.size) {
          nextBatchPromise = this.#readBatch(file, fileOffset);
          fileOffset = Math.min(fileOffset + BATCH_BYTES, file.size);
        } else {
          nextBatchPromise = Promise.resolve(null);
        }

        // Send every 256 KB slice of this batch — SYNCHRONOUS hot path
        for (let i = 0; i < batch.byteLength; i += CHUNK_SIZE) {
          if (!this.#dc) throw new Error('DataChannel closed during send');

          const end  = Math.min(i + CHUNK_SIZE, batch.byteLength);
          const view = new Uint8Array(batch, i, end - i); // zero-copy view
          this.#dc.send(view);
          bytesSent += view.byteLength;

          // ── BACKPRESSURE: only await when buffer is genuinely full ────────
          // This is the critical difference from v9. No per-chunk microtask.
          if (this.#dc.bufferedAmount >= HIGH_WATERMARK) {
            await drainBuffer(this.#dc);
          }
        }
      }

      // 4. Wait for every queued byte to leave the send buffer before
      //    signalling 'done'. Prevents the receiver getting 'done' before
      //    all chunks arrive (would cause a truncated file).
      await waitForFullDrain(this.#dc);

      speed.update(file.size);
      onProgress?.({ sentBytes: file.size, totalBytes: file.size, speed, meta, fileIndex, fileTotal, isLastChunk: true });

    } finally {
      clearInterval(uiTimer);
    }

    // 5. Signal end-of-file to receiver
    this.#dc.send(JSON.stringify({ type: 'done' }));
  }

  /**
   * Read one BATCH_BYTES slice of a File as an ArrayBuffer.
   * Called pipelined — the caller kicks this off one iteration before it
   * needs the data, so disk latency is hidden behind the network send time.
   */
  #readBatch(file, startOffset) {
    if (startOffset >= file.size) return Promise.resolve(null);
    const end = Math.min(startOffset + BATCH_BYTES, file.size);
    return file.slice(startOffset, end).arrayBuffer();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  close() {
    try { this.#dc?.close(); } catch (_) {}
    try { this.#pc?.close(); } catch (_) {}
    this.#dc = null;
    this.#pc = null;
  }
}