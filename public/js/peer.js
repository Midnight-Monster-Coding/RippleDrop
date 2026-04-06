/**
 * RippleDrop — WebRTC Peer Manager  v11
 *
 * ══════════════════════════════════════════════════════════════════
 * ROOT CAUSE OF BURST → STALL → BURST PATTERN (v10 bug)
 * ══════════════════════════════════════════════════════════════════
 *
 * SYMPTOM:  30-50 MB/s for 1-2 seconds, then 0 B/s for many seconds,
 *           then a brief spike, then 0 again. Average = KB/s.
 *           ETA shows "266683536050.2h left".
 *
 * BUG 1 — SCTP CONGESTION WINDOW COLLAPSE (the main culprit)
 * ─────────────────────────────────────────────────────────────────
 * v10 used HIGH_WATERMARK = 8 MB. This means the send loop dumps
 * up to 8 MB into the DataChannel buffer in one synchronous burst
 * before yielding. Chrome then:
 *   1. Encrypts it all at once (DTLS/AES — CPU spike)
 *   2. Floods the SCTP stack with 8 MB of segments
 *   3. Receiver's SCTP receive window (rwnd) fills up
 *   4. SCTP treats rwnd exhaustion like network congestion
 *   5. Sender's cwnd collapses (same as TCP slow-start after loss)
 *   6. Speed drops to near 0 B/s for several seconds
 *   7. cwnd slowly grows → brief speed spike → collapse again
 *
 * FIX: HIGH_WATERMARK = 1 MB. The DataChannel buffer never holds
 * more than 1 MB at a time, keeping SCTP's cwnd stable.
 *
 * BUG 2 — NO EVENT-LOOP YIELD DURING SYNCHRONOUS BURST
 * ─────────────────────────────────────────────────────────────────
 * v10's send loop was fully synchronous until hitting HIGH_WATERMARK.
 * During a synchronous burst, the browser's networking thread (which
 * processes SCTP ACKs and updates the congestion window) cannot run.
 * Chrome literally cannot receive ACKs while JS is running. So:
 *   - cwnd stays at its initial value (small)
 *   - The send buffer fills without cwnd growing
 *   - When we eventually yield, cwnd update is batched → spike
 *
 * FIX: yield with `await yieldToEventLoop()` every BURST_LIMIT bytes.
 * This gives Chrome's networking thread a chance to process ACKs and
 * grow cwnd between bursts → smooth, sustained throughput.
 *
 * BUG 3 — SPEEDMETER DECAYS TO ZERO DURING STALLS → ABSURD ETA
 * ─────────────────────────────────────────────────────────────────
 * The uiTimer fires every 100ms and calls speed.update(bytesSent).
 * During a SCTP stall, bytesSent doesn't change. The old SpeedMeter:
 *   currentSpeed = deltaB / deltaT = 0 / 0.1 = 0
 *   smoothedSpeed = (0 × 0.3) + (smoothedSpeed × 0.7) → decays to ~0
 * After a 2-second stall: smoothedSpeed ≈ 0.00000001 B/s.
 * ETA = (remaining bytes) / 0.00000001 = 266 trillion hours.
 *
 * FIX: if deltaB == 0, skip the smoothing update. The last known speed
 * is preserved during stalls → ETA stays meaningful.
 * Also: cap ETA display at 99 minutes to guard against edge cases.
 */

// ─── Tuning constants ──────────────────────────────────────────────────────

const CHUNK_SIZE     = 65536;    //  64 KB per dc.send() — proven reliable with Chrome SCTP.
                                 //  256 KB (v10) caused excessive head-of-line blocking
                                 //  on retransmission events — reverted to 64 KB.

const BATCH_BYTES    = 8388608;  //   8 MB per disk read — large enough to keep the
                                 //   disk pipeline full without wasting RAM.

const HIGH_WATERMARK = 1048576;  //   1 MB — pause when DataChannel buffer hits this.
                                 //   Small enough that SCTP's cwnd never collapses.
                                 //   v10's 8 MB caused burst→stall cycles.

const LOW_WATERMARK  = 131072;   // 128 KB — resume once buffer drains here.
                                 //   Tight threshold → we resume quickly after drain.

const BURST_LIMIT    = 524288;   // 512 KB — yield to the browser event loop after
                                 //   sending this many bytes synchronously.
                                 //   Lets Chrome's SCTP process ACKs mid-burst
                                 //   → cwnd grows continuously → no stall cycles.

// ─── ICE / STUN config ────────────────────────────────────────────────────

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ─── SDP helpers ──────────────────────────────────────────────────────────

function removeBandwidthCaps(sdp) {
  return sdp
    .replace(/\r\nb=AS:\d+/g,   '')
    .replace(/\r\nb=CT:\d+/g,   '')
    .replace(/\r\nb=TIAS:\d+/g, '');
}

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

  /**
   * v11 fix: only update smoothedSpeed when bytes are actually moving.
   * If deltaB == 0, skip the EMA blend — preserve last known speed.
   * This prevents the "266 trillion hour ETA" caused by stall decay.
   */
  update(currentTotalBytes) {
    const now    = performance.now();
    const deltaT = (now - this.#lastTime) / 1000;
    if (deltaT < 0.1) return;

    const deltaB = currentTotalBytes - this.#lastBytes;
    this.#lastBytes = currentTotalBytes;
    this.#lastTime  = now;

    if (deltaB <= 0) return; // ← KEY FIX: skip blend if no bytes moved

    const currentSpeed  = deltaB / deltaT;
    this.#smoothedSpeed = this.#smoothedSpeed === 0
      ? currentSpeed
      : (currentSpeed * 0.35) + (this.#smoothedSpeed * 0.65);
  }

  reset() {
    this.#lastBytes     = 0;
    this.#lastTime      = performance.now();
    this.#smoothedSpeed = 0;
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
  if (bps >  0)   return `${Math.round(bps)} B/s`;
  return '—';
}

function _fmtETA(s) {
  // v11 fix: cap absurd ETAs. Previously a near-zero speed (after stall decay)
  // produced enormous-but-finite values like "266683536050.2h left".
  // Cap at 99 minutes → show "—" for anything beyond that.
  if (!isFinite(s) || s < 0 || s > 5940) return '—';
  if (s < 4)    return 'almost done';
  if (s < 60)   return `${Math.round(s)}s left`;
  if (s < 3600) return `${Math.round(s / 60)}m left`;
  return `${(s / 3600).toFixed(1)}h left`;
}

// ─── Backpressure primitives ───────────────────────────────────────────────

/**
 * drainBuffer — resolves when safe to resume sending.
 * Race-condition-free: synchronous check inside the Promise constructor.
 * If the buffer already drained below LOW_WATERMARK before we attach
 * the listener, we resolve immediately — no deadlock.
 */
function drainBuffer(dc) {
  return new Promise(resolve => {
    if (!dc || dc.bufferedAmount < LOW_WATERMARK) {
      resolve();
      return;
    }
    dc.bufferedAmountLowThreshold = LOW_WATERMARK;
    dc.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

/**
 * waitForFullDrain — wait until send buffer is completely empty.
 * Called after the last chunk to ensure 'done' signal arrives after
 * all data chunks (prevents truncated files on the receiver).
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

/**
 * yieldToEventLoop — give Chrome's networking thread a timeslice.
 *
 * Chrome's SCTP congestion control (cwnd) is updated when ACKs arrive
 * from the receiver. ACK processing requires the browser's event loop
 * to turn over. If JS holds the thread with a tight synchronous loop,
 * cwnd never grows → throughput is capped at the initial slow-start
 * value → you see a small burst followed by a long stall.
 *
 * Awaiting this every BURST_LIMIT bytes lets the browser breathe,
 * processes pending ACKs, grows cwnd, and keeps throughput steady.
 */
function yieldToEventLoop() {
  return new Promise(r => setTimeout(r, 0));
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
      console.log('[ICE] Candidate:', candidate.type, candidate.address ?? '(mDNS)');
      this.#socket.emit('signal', { signal: { type: 'ice', candidate } });
    };

    // ── ICE state ─────────────────────────────────────────────────────────
    this.#pc.oniceconnectionstatechange = () => {
      const s = this.#pc?.iceConnectionState;
      if (!s) return;
      console.log('[ICE]', s);
      if (s === 'connected' || s === 'completed') this.#logIceStats();
      if (s === 'failed')       this.#cb.onError?.('Direct connection failed. Ensure both devices are on the same Wi-Fi or can reach the internet.');
      if (s === 'disconnected') this.#cb.onError?.('The other device disconnected.');
    };

    // ── DataChannel setup ──────────────────────────────────────────────────
    if (this.#role === 'host') {
      this.#dc = this.#pc.createDataChannel('rippledrop', { ordered: true });
      this.#dc.bufferedAmountLowThreshold = LOW_WATERMARK;
      this.#dc.binaryType = 'arraybuffer';
      this.#bindChannel(this.#dc);

      const offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription({ type: offer.type, sdp: patchSdp(offer.sdp) });
      this.#socket.emit('signal', { signal: { type: 'offer', sdp: this.#pc.localDescription } });

    } else {
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
        await this.#pc.setLocalDescription({ type: answer.type, sdp: patchSdp(answer.sdp) });
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

  // ── ICE stats ─────────────────────────────────────────────────────────────

  async #logIceStats() {
    try {
      await new Promise(r => setTimeout(r, 700));
      const stats = await this.#pc?.getStats();
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
            console.log('%c✅ DIRECT LAN — file bytes stay on your WiFi. Expect 20–80 MB/s.', 'color:#4ade80;font-weight:bold');
          } else if (local?.candidateType === 'srflx') {
            console.log('%c🌐 STUN path — P2P over internet.', 'color:#fbbf24;font-weight:bold');
          } else {
            console.log('[ICE] Path type:', local?.candidateType);
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
    const meta = {
      type: 'meta', name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      fileIndex, fileTotal,
    };
    this.#dc.send(JSON.stringify(meta));

    if (file.size === 0) {
      this.#dc.send(JSON.stringify({ type: 'done' }));
      onProgress?.({ sentBytes: 0, totalBytes: 0, speed: new SpeedMeter(), meta, fileIndex, fileTotal, isLastChunk: true });
      return;
    }

    const speed     = new SpeedMeter();
    let   bytesSent = 0;

    const uiTimer = setInterval(() => {
      if (!this.#dc) return;
      speed.update(bytesSent); // no-op if bytesSent unchanged → no decay
      onProgress?.({ sentBytes: bytesSent, totalBytes: file.size, speed, meta, fileIndex, fileTotal, isLastChunk: false });
    }, 100);

    try {
      // ── THREE-LEVEL FLOW CONTROL ───────────────────────────────────────────
      //
      // Level 1 — BURST LIMIT (NEW in v11, most important):
      //   yield to event loop every 512 KB. Lets Chrome process SCTP ACKs
      //   and grow cwnd. Without this, cwnd stagnates → burst→stall pattern.
      //
      // Level 2 — BACKPRESSURE:
      //   block when DataChannel buffer hits 1 MB. Small watermark prevents
      //   SCTP rwnd exhaustion and cwnd collapse.
      //
      // Level 3 — DISK PIPELINE:
      //   while sending batch N, disk-read batch N+1 runs concurrently.

      let fileOffset = 0;
      let nextBatchPromise = this.#readBatch(file, fileOffset);
      fileOffset = Math.min(fileOffset + BATCH_BYTES, file.size);

      while (true) {
        const batch = await nextBatchPromise;
        if (!batch || batch.byteLength === 0) break;

        if (fileOffset < file.size) {
          nextBatchPromise = this.#readBatch(file, fileOffset);
          fileOffset = Math.min(fileOffset + BATCH_BYTES, file.size);
        } else {
          nextBatchPromise = Promise.resolve(null);
        }

        let burstBytes = 0;

        for (let i = 0; i < batch.byteLength; i += CHUNK_SIZE) {
          if (!this.#dc) throw new Error('DataChannel closed during send');

          const end  = Math.min(i + CHUNK_SIZE, batch.byteLength);
          const view = new Uint8Array(batch, i, end - i); // zero-copy view
          this.#dc.send(view);
          bytesSent  += view.byteLength;
          burstBytes += view.byteLength;

          // Level 1: yield every 512 KB so SCTP can process ACKs
          if (burstBytes >= BURST_LIMIT) {
            burstBytes = 0;
            await yieldToEventLoop();
          }

          // Level 2: block only when buffer is genuinely full
          if (this.#dc && this.#dc.bufferedAmount >= HIGH_WATERMARK) {
            await drainBuffer(this.#dc);
            burstBytes = 0;
          }
        }
      }

      await waitForFullDrain(this.#dc);

      speed.update(file.size);
      onProgress?.({ sentBytes: file.size, totalBytes: file.size, speed, meta, fileIndex, fileTotal, isLastChunk: true });

    } finally {
      clearInterval(uiTimer);
    }

    this.#dc.send(JSON.stringify({ type: 'done' }));
  }

  #readBatch(file, startOffset) {
    if (startOffset >= file.size) return Promise.resolve(null);
    return file.slice(startOffset, Math.min(startOffset + BATCH_BYTES, file.size)).arrayBuffer();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  close() {
    try { this.#dc?.close(); } catch (_) {}
    try { this.#pc?.close(); } catch (_) {}
    this.#dc = null;
    this.#pc = null;
  }
}