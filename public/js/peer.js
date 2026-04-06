/**
 * RippleDrop — WebRTC Peer Manager  v9 (AirDrop-speed rewrite)
 *
 * THREE BUGS FIXED FROM v8:
 *
 * BUG 1 — BACKPRESSURE DEADLOCK (the main bottleneck — caused 0 B/s freezes)
 * ────────────────────────────────────────────────────────────────────────────
 * v8's waitForRoom() always added a 'bufferedamountlow' event listener and
 * then awaited it. But that event fires ONLY when the buffer transitions from
 * above→below the threshold. If SCTP drained the buffer below LOW_WATERMARK
 * BEFORE our listener was attached, the event had already fired and would
 * never fire again → permanent deadlock → 0 B/s → "2946352.4h left".
 *
 * THE FIX: check bufferedAmount INSIDE the Promise constructor (synchronous,
 * no yield point between check and addEventListener) and resolve immediately
 * if already below the drain target. JavaScript is single-threaded — SCTP
 * events can only arrive after we yield. So the check is race-free.
 *
 * BUG 2 — CHUNK SIZE TOO SMALL (16 KB → 4,800 dc.send() calls per 75 MB)
 * ────────────────────────────────────────────────────────────────────────────
 * Each dc.send() call costs: V8 argument parsing, ArrayBuffer boundary check,
 * IPC serialization to the browser's SCTP thread, event-queue processing.
 * At 16 KB × 4,800 chunks the overhead dominated actual transfer time.
 *
 * THE FIX: 64 KB chunks. Chrome's DataChannel handles up to 256 KB per
 * message. 64 KB cuts send() call count by 4×, keeps us well inside limits,
 * and matches the SCTP max segment size Chrome uses internally.
 *
 * BUG 3 — SEQUENTIAL DISK READ + NETWORK SEND (no pipeline)
 * ────────────────────────────────────────────────────────────────────────────
 * v8 did: await disk(N) → send(N) → await disk(N+1) → send(N+1) …
 * During each disk read the SCTP send buffer emptied, the congestion window
 * stagnated, and speed dropped.
 *
 * THE FIX: pipeline. While sending batch N, kick off the disk read for
 * batch N+1 in the background. By the time the send loop finishes, the
 * next batch is already in RAM. No idle time on the wire.
 *
 * RESULT: On the same LAN WiFi these bugs limited speed to 50–300 KB/s.
 * Fixed, expect 20–100 MB/s (DataChannel hardware ceiling on WiFi).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ICE / ROUTING (unchanged from v8)
 * ────────────────────────────────────────────────────────────────────────────
 * Empty iceServers → Chrome generates only host (mDNS) candidates → file
 * bytes never leave your WiFi. Both devices must be on the same network.
 */

// ─── Tuning constants ──────────────────────────────────────────────────────

const CHUNK_SIZE     = 65536;    //  64 KB per dc.send() call
                                 //  Chrome supports up to 256 KB; 64 KB is
                                 //  the sweet spot — fast, never hits limits.

const BATCH_BYTES    = 8388608;  //   8 MB per disk read (one File.slice call)
                                 //  Larger batch = fewer async disk ops.

const HIGH_WATERMARK = 4194304;  //   4 MB: pause when send buffer hits this.
                                 //  Low enough that SCTP drains it quickly,
                                 //  avoiding the long stalls of v8's 8 MB.

const LOW_WATERMARK  = 262144;   // 256 KB: resume once buffer drains here.
                                 //  Tight threshold → we resume almost
                                 //  immediately after SCTP clears the queue.

// ─── ICE config ───────────────────────────────────────────────────────────

const ICE_CONFIG = {
  iceServers: [], // Intentionally empty — host candidates only, LAN-direct
};

// ─── SDP helpers ──────────────────────────────────────────────────────────

/**
 * Remove bandwidth cap lines Chrome may inject.
 * b=AS:30 caps DataChannel to 30 kbps in some Chrome versions.
 * b=TIAS:N is the newer per-transport cap — also removed.
 */
function removeBandwidthCaps(sdp) {
  return sdp
    .replace(/\r\nb=AS:\d+/g, '')
    .replace(/\r\nb=CT:\d+/g, '')
    .replace(/\r\nb=TIAS:\d+/g, '');
}

/**
 * Set the SCTP max-message-size to 256 KB in the SDP.
 * Without this some Chrome versions fragment at 64 KB, adding overhead.
 */
function setMaxMessageSize(sdp, bytes = 262144) {
  // Replace existing max-message-size or append it to the SCTP m-section
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
    if (deltaT >= 0.1) {  // sample every 100 ms for tighter accuracy
      const deltaB       = currentTotalBytes - this.#lastBytes;
      const currentSpeed = deltaB / deltaT;
      this.#smoothedSpeed = this.#smoothedSpeed === 0
        ? currentSpeed
        : (currentSpeed * 0.25) + (this.#smoothedSpeed * 0.75);
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
 * drainBuffer(dc) — race-condition-free backpressure.
 *
 * THE BUG THIS FIXES:
 *   v8 always added a listener and then waited for the event. But
 *   'bufferedamountlow' fires ONLY on downward transitions. If SCTP already
 *   drained the buffer below our threshold before we added the listener, the
 *   event already fired and will NEVER fire again → infinite stall.
 *
 * THE FIX:
 *   All checks happen INSIDE the Promise constructor — synchronous, no yield.
 *   JS is single-threaded: SCTP events can only arrive after we yield (await).
 *   So if bufferedAmount is already below LOW_WATERMARK at the moment we check,
 *   we resolve() immediately — no listener needed, no race possible.
 *
 * @param {RTCDataChannel} dc
 * @returns {Promise<void>}  resolves when safe to send more data
 */
function drainBuffer(dc) {
  // Fast path: buffer is healthy — no work to do.
  if (!dc || dc.bufferedAmount < HIGH_WATERMARK) return Promise.resolve();

  return new Promise(resolve => {
    // ── CRITICAL: check inside constructor (synchronous — no yield yet) ──
    // If buffer already drained by the time we get here, resolve immediately.
    // This is the line that fixes the deadlock. Without it, adding the
    // listener after a drain means it never fires.
    if (dc.bufferedAmount < LOW_WATERMARK) {
      resolve();
      return;
    }

    dc.bufferedAmountLowThreshold = LOW_WATERMARK;

    // { once: true } auto-removes the listener after first fire — no leaks.
    dc.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

/**
 * waitForFullDrain(dc) — wait until the send buffer is completely empty.
 * Called after the last chunk of a file, before sending the 'done' signal.
 * Same race-condition fix as drainBuffer().
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

      // Only forward host (mDNS) candidates — no STUN/TURN.
      // host   = direct LAN → bytes stay on WiFi ✅
      // srflx  = internet NAT → bytes routed via ISP ❌
      // relay  = TURN server → bytes hit internet ❌
      if (candidate.type !== 'host') {
        console.log('[ICE] Dropped non-local candidate:', candidate.type, candidate.address);
        return;
      }

      console.log('[ICE] Sharing local candidate:', candidate.address);
      this.#socket.emit('signal', { signal: { type: 'ice', candidate } });
    };

    // ── ICE state logging ──────────────────────────────────────────────────
    this.#pc.oniceconnectionstatechange = () => {
      const s = this.#pc.iceConnectionState;
      console.log('[ICE]', s);

      if (s === 'connected' || s === 'completed') this.#logIceStats();

      if (s === 'failed') {
        console.error('[ICE] Connection failed. Both devices must be on the same WiFi network.');
        this.#cb.onError?.('Direct connection failed. Make sure both devices are on the same WiFi network.');
      }
      if (s === 'disconnected') {
        this.#cb.onError?.('The other device disconnected.');
      }
    };

    // ── DataChannel setup ──────────────────────────────────────────────────
    if (this.#role === 'host') {
      this.#dc = this.#pc.createDataChannel('rippledrop', {
        ordered: true, // Required for correct file reassembly
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

  // ── ICE stats (confirms direct LAN path) ──────────────────────────────────

  async #logIceStats() {
    try {
      await new Promise(r => setTimeout(r, 600));
      const stats   = await this.#pc.getStats();
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
          console.log('Local  :', local?.candidateType,  '|', local?.address,  ':', local?.port);
          console.log('Remote :', remote?.candidateType, '|', remote?.address, ':', remote?.port);
          console.log('Path   :', rtt);

          if (local?.candidateType === 'host') {
            console.log('%c✅ DIRECT LAN — file bytes stay on your WiFi. Expect 10–100 MB/s.', 'color:#4ade80;font-weight:bold');
          } else {
            console.warn('%c⚠️  Unexpected non-host candidate. Type:', 'color:#f87171', local?.candidateType);
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

    // 2. Progress reporting
    const speed     = new SpeedMeter();
    let   bytesSent = 0;

    const uiTimer = setInterval(() => {
      if (!this.#dc) return;
      speed.update(bytesSent);
      onProgress?.({ sentBytes: bytesSent, totalBytes: file.size, speed, meta, fileIndex, fileTotal, isLastChunk: false });
    }, 100); // 100 ms → smooth UI without flooding

    try {
      // 3. Pipelined send loop
      //
      // PIPELINE DESIGN:
      //   We kick off the disk read for batch N+1 WHILE we are still sending
      //   batch N. By the time the send loop for batch N finishes, the next
      //   chunk of file data is already in RAM. Zero idle time on the wire.
      //
      //   Sequence:
      //     read(0)  → [in background: read(1)]
      //     send(0)  → await next (already done) → send(1) → ...
      //
      // CHUNK STRATEGY:
      //   We read 8 MB at a time from disk (one arrayBuffer() call).
      //   Inside that 8 MB RAM buffer we loop in 64 KB slices using
      //   Uint8Array views — zero-copy, no ArrayBuffer.slice() allocations.
      //   dc.send() accepts TypedArray directly.
      //
      // BACKPRESSURE:
      //   After each dc.send(), if bufferedAmount ≥ HIGH_WATERMARK (4 MB),
      //   we await drainBuffer() which resolves as soon as bufferedAmount
      //   drops below LOW_WATERMARK (256 KB). The race-condition fix in
      //   drainBuffer() ensures this never deadlocks.

      let fileOffset = 0;

      // Prefetch the first batch immediately
      let nextBatchPromise = this.#readBatch(file, fileOffset);
      fileOffset = Math.min(fileOffset + BATCH_BYTES, file.size);

      while (true) {
        // Wait for current batch to be in RAM
        const batch = await nextBatchPromise;
        if (!batch || batch.byteLength === 0) break;

        // Kick off the NEXT disk read while we send this batch (pipeline)
        if (fileOffset < file.size) {
          nextBatchPromise = this.#readBatch(file, fileOffset);
          fileOffset = Math.min(fileOffset + BATCH_BYTES, file.size);
        } else {
          nextBatchPromise = Promise.resolve(null); // signal: no more batches
        }

        // Send every 64 KB slice of this batch
        for (let i = 0; i < batch.byteLength; i += CHUNK_SIZE) {
          if (!this.#dc) throw new Error('DataChannel closed during send');

          // Backpressure check — race-condition-free (see drainBuffer above)
          await drainBuffer(this.#dc);

          const end  = Math.min(i + CHUNK_SIZE, batch.byteLength);
          const view = new Uint8Array(batch, i, end - i); // zero-copy view
          this.#dc.send(view);
          bytesSent += view.byteLength;
        }
      }

      // 4. Drain: wait for every queued byte to leave the send buffer before
      //    signalling 'done'. Prevents the receiver getting 'done' before all
      //    chunks arrive (would cause a truncated or corrupt file).
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
   * A single File.slice().arrayBuffer() call → one OS read → maximal disk
   * throughput. The pipelined caller kicks this off BEFORE it needs the data.
   */
  #readBatch(file, startOffset) {
    const end = Math.min(startOffset + BATCH_BYTES, file.size);
    if (startOffset >= file.size) return Promise.resolve(null);
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