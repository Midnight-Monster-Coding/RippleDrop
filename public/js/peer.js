/**
 * RippleDrop — WebRTC Peer Manager  v12
 *
 * ══════════════════════════════════════════════════════════════════
 * BUGS FIXED IN v12
 * ══════════════════════════════════════════════════════════════════
 *
 * BUG 1 — setTimeout(0) THROTTLED TO 1000ms IN BACKGROUND TABS
 * ─────────────────────────────────────────────────────────────────
 * v11 introduced `await yieldToEventLoop()` using setTimeout(r, 0)
 * every 512 KB to let Chrome process SCTP ACKs mid-burst.
 *
 * THE PROBLEM: Chrome throttles setTimeout to a minimum of 1000ms
 * when the tab is not in the foreground. If you open the sender tab
 * and then switch to the receiver tab to watch progress, the sender
 * tab becomes a "background tab":
 *
 *   512 KB sent → yield (setTimeout 0 → throttled to 1000ms) → resume
 *   = 512 KB / 1000ms = 512 KB/s ← EXACTLY the speed you observed
 *
 * This also explains why you'd occasionally see brief spikes: when you
 * click back to the sender tab it briefly runs unthrottled.
 *
 * THE FIX: Replace setTimeout with MessageChannel.
 *   MessageChannel.postMessage() is a "postTask" — it is NOT subject
 *   to timer throttling. It fires in the next task queue turn, typically
 *   within 0–1ms regardless of tab focus state. This allows the yield
 *   to process SCTP ACKs without suffering background tab penalties.
 *
 * BUG 2 — SENDER SPEED METER MEASURES QUEUE RATE, NOT SEND RATE
 * ─────────────────────────────────────────────────────────────────
 * `bytesSent` counts bytes passed to dc.send() (queuing speed).
 * dc.send() is nearly instantaneous — it just copies data into the
 * DataChannel's internal buffer. The sender showed 5–10 MB/s because
 * it was measuring how fast JS could fill the buffer, not how fast
 * SCTP was transmitting data over WiFi.
 *
 * The receiver's speed (442 KB/s) was correct — it measured actual
 * bytes arriving over the network.
 *
 * THE FIX: Compute `effectivelySent = bytesSent - dc.bufferedAmount`.
 *   dc.bufferedAmount = bytes queued in DC buffer but NOT yet handed
 *   to SCTP. So bytesSent - bufferedAmount ≈ bytes actually sent to
 *   the SCTP stack (and on their way to the receiver). This makes the
 *   sender's speed meter match what the receiver sees.
 *
 * BUG 3 — RTCErrorEvent FROM SENDING ON CLOSING CHANNEL
 * ─────────────────────────────────────────────────────────────────
 * The RTCErrorEvent visible in the console was caused by dc.send()
 * being called after the DataChannel started closing (e.g. on back
 * navigation or disconnect). Added a readyState guard before sends.
 */

// ─── Tuning constants ──────────────────────────────────────────────────────

const CHUNK_SIZE     = 65536;    //  64 KB per dc.send()

const BATCH_BYTES    = 8388608;  //   8 MB per disk read

const HIGH_WATERMARK = 2097152;  //   2 MB — pause threshold.
                                 //   Raised slightly from v11's 1 MB to keep
                                 //   more data in-flight for higher throughput,
                                 //   while still preventing SCTP cwnd collapse.

const LOW_WATERMARK  = 262144;   // 256 KB — resume threshold.

const BURST_LIMIT    = 1048576;  //   1 MB — yield to browser after this many
                                 //   bytes. Doubled from v11's 512 KB since
                                 //   MessageChannel yields are ~0ms (not 1000ms)
                                 //   so we can afford larger bursts before ACK
                                 //   processing. Less yield overhead = faster.

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

  update(currentTotalBytes) {
    const now    = performance.now();
    const deltaT = (now - this.#lastTime) / 1000;
    if (deltaT < 0.1) return;

    const deltaB = currentTotalBytes - this.#lastBytes;
    this.#lastBytes = currentTotalBytes;
    this.#lastTime  = now;

    // Skip blend when no bytes moved — preserves last known speed.
    // Prevents the "266 trillion hour ETA" from stall-decay (v11 fix).
    if (deltaB <= 0) return;

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
  // Cap at 99 min — prevents absurd strings from near-zero speed readings.
  if (!isFinite(s) || s < 0 || s > 5940) return '—';
  if (s < 4)    return 'almost done';
  if (s < 60)   return `${Math.round(s)}s left`;
  if (s < 3600) return `${Math.round(s / 60)}m left`;
  return `${(s / 3600).toFixed(1)}h left`;
}

// ─── Backpressure primitives ───────────────────────────────────────────────

function drainBuffer(dc) {
  return new Promise(resolve => {
    if (!dc || dc.bufferedAmount < LOW_WATERMARK) { resolve(); return; }
    dc.bufferedAmountLowThreshold = LOW_WATERMARK;
    dc.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

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

// ─── MessageChannel-based yield ───────────────────────────────────────────

/**
 * yieldToChannel() — fires in the NEXT TASK QUEUE TURN.
 *
 * WHY NOT setTimeout(r, 0)?
 *   setTimeout has a minimum delay of 1ms when the tab is active, and
 *   is throttled to 1000ms MINIMUM when the tab is in the background
 *   (Chrome's "background timer throttling" policy). If you switch from
 *   the sender tab to the receiver tab to watch progress, the sender
 *   becomes a background tab and setTimeout fires at most once per second.
 *   With BURST_LIMIT = 512KB, this caps throughput at 512 KB/s.
 *
 * WHY MessageChannel?
 *   MessageChannel.postMessage() schedules a MessageEvent in the task
 *   queue. This is NOT subject to timer throttling — it fires in the
 *   next available task turn regardless of whether the tab is in focus.
 *   Typical latency: 0–1ms in foreground AND background.
 *
 * WHY YIELD AT ALL?
 *   Chrome's SCTP networking runs on a separate thread, but incoming
 *   SCTP ACKs (which update the congestion window, cwnd) are processed
 *   as browser tasks. If JS monopolises the main thread, pending ACK
 *   tasks pile up, cwnd stagnates, and throughput is capped at its
 *   initial value. Yielding every BURST_LIMIT bytes lets ACK tasks run.
 */
let _yieldChannel = null;
function yieldToChannel() {
  if (!_yieldChannel) _yieldChannel = new MessageChannel();
  return new Promise(resolve => {
    _yieldChannel.port1.onmessage = resolve;
    _yieldChannel.port2.postMessage(null);
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

    this.#pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      console.log('[ICE] Candidate:', candidate.type, candidate.address ?? '(mDNS)');
      this.#socket.emit('signal', { signal: { type: 'ice', candidate } });
    };

    this.#pc.oniceconnectionstatechange = () => {
      const s = this.#pc?.iceConnectionState;
      if (!s) return;
      console.log('[ICE]', s);
      if (s === 'connected' || s === 'completed') this.#logIceStats();
      if (s === 'failed')       this.#cb.onError?.('Connection failed. Ensure both devices are on the same Wi-Fi or can reach the internet.');
      if (s === 'disconnected') this.#cb.onError?.('The other device disconnected.');
    };

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

  #bindChannel(dc) {
    dc.onopen  = () => this.#cb.onOpen?.();
    dc.onclose = () => this.#cb.onClose?.();
    dc.onerror = (e) => {
      // Log full error details to help diagnose RTCErrorEvent issues
      const err = e.error;
      console.error('[DC] RTCErrorEvent:', err?.errorDetail ?? 'unknown', err?.message ?? e);
      this.#cb.onError?.('Transfer channel error — check console for details.');
    };
    dc.onmessage = (e) => this.#onMessage(e);
  }

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

  async sendFiles(files, onProgress) {
    for (let i = 0; i < files.length; i++) {
      await this.#sendOne(files[i], i, files.length, onProgress);
    }
  }

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
    let   bytesSent = 0; // bytes passed to dc.send() (used for progress %)

    const uiTimer = setInterval(() => {
      if (!this.#dc) return;

      // ── v12 SPEED METER FIX ────────────────────────────────────────────
      // bytesSent = bytes QUEUED into DataChannel (dc.send is near-instant)
      // dc.bufferedAmount = bytes still sitting in DC buffer, not yet sent
      // effectivelySent ≈ bytes actually handed to SCTP → close to what
      //                   the receiver is counting.
      //
      // Without this fix, the sender showed 5–10 MB/s (queue fill rate)
      // while the receiver showed 442 KB/s (true network rate). Now both
      // sides agree on the speed.
      const effectivelySent = Math.max(0, bytesSent - (this.#dc?.bufferedAmount ?? 0));
      speed.update(effectivelySent);

      onProgress?.({
        sentBytes:  bytesSent,       // use queue bytes for % progress
        totalBytes: file.size,
        speed,
        meta, fileIndex, fileTotal,
        isLastChunk: false,
      });
    }, 100);

    try {
      // ── THREE-LEVEL FLOW CONTROL ───────────────────────────────────────
      //
      // Level 1 — BURST LIMIT (MessageChannel yield every 1 MB):
      //   Lets Chrome process SCTP ACKs mid-burst so cwnd can grow.
      //   Uses MessageChannel instead of setTimeout — NOT throttled in
      //   background tabs (fixes the 512 KB/s background-tab ceiling).
      //
      // Level 2 — BACKPRESSURE (drainBuffer at 2 MB):
      //   Prevents flooding SCTP's receive window and causing cwnd collapse.
      //
      // Level 3 — DISK PIPELINE:
      //   Disk read for batch N+1 starts while batch N is being sent.

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
          if (!this.#dc || this.#dc.readyState !== 'open') {
            throw new Error('DataChannel closed during send');
          }

          const end  = Math.min(i + CHUNK_SIZE, batch.byteLength);
          const view = new Uint8Array(batch, i, end - i);
          this.#dc.send(view);
          bytesSent  += view.byteLength;
          burstBytes += view.byteLength;

          // Level 1: MessageChannel yield — background-tab safe
          if (burstBytes >= BURST_LIMIT) {
            burstBytes = 0;
            await yieldToChannel();
          }

          // Level 2: backpressure
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

  close() {
    try { this.#dc?.close(); } catch (_) {}
    try { this.#pc?.close(); } catch (_) {}
    this.#dc = null;
    this.#pc = null;
  }
}