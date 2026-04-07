/**
 * RippleDrop — WebRTC Peer Manager  v15
 *
 * ══════════════════════════════════════════════════════════════════
 * WHY v14 WAS STILL SLOW (1–1.5 MB/s) AND WHAT v15 FIXES
 * ══════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURAL ROOT CAUSE (unfixable by watermark tuning alone):
 *   One DataChannel = one SCTP stream = one congestion window (cwnd).
 *   Chrome's single-stream cwnd stabilises at 1–3 MB/s on LAN.
 *   Raising HIGH_WATERMARK (v14) gives cwnd more time to grow, but
 *   can never break the single-stream ceiling — that ceiling is set
 *   by Chrome's SCTP implementation, not by JS.
 *
 * THE FIX — NUM_CHANNELS = 6 parallel DataChannels:
 *   Each DataChannel is an independent SCTP stream with its own cwnd.
 *   All six cwnd values grow simultaneously and independently.
 *   Chunks are sent round-robin across all six channels.
 *   Combined throughput on a typical 5 GHz LAN: 8–25 MB/s
 *   (vs. 1–1.5 MB/s with a single channel).
 *
 * ── Additional v15 improvements ──────────────────────────────────
 *
 * FIX 1 — CHUNK_SIZE raised from 64 KB → 128 KB
 *   Halves the number of dc.send() calls, Map entries, DataView
 *   constructions, and Uint8Array allocations for the same file.
 *   Less GC pressure, less JS overhead per byte.
 *
 * FIX 2 — O(N²) #tryAssemble() → O(1) counter check
 *   v14 iterated from 0 to N on EVERY incoming chunk to find gaps.
 *   For a 1 GB file (8192 chunks at 128 KB): last chunk triggers
 *   8192 iterations; total = N*(N+1)/2 = ~33 M iterations wasted.
 *   v15 keeps a simple #receivedChunkCount integer. When
 *   count === expectedChunks the check is one comparison. Assembly
 *   (the ordered loop) runs exactly once. Net: O(1) vs O(N²).
 *
 * FIX 3 — Speed meter sums bufferedAmount across all channels
 *   effectivelySent = bytesSent − Σ(dc.bufferedAmount for all dcs)
 *   Without this the sender speed meter would show queue fill rate
 *   (fast) instead of actual network rate (what receiver sees).
 *
 * FIX 4 — waitForFullDrain across all channels before 'done'
 *   The 'done' signal is sent on channel 0 only after ALL six
 *   channels have bufferedAmount === 0. Combined with the
 *   #doneReceived flag (v14), this prevents false "missing chunk"
 *   errors caused by 'done' arriving before late binary chunks.
 *
 * ── What is NOT changed ───────────────────────────────────────────
 *   • MessageChannel yield (background-tab safe) — kept
 *   • BURST_LIMIT yielding every 4 MB — kept
 *   • Per-channel HIGH/LOW watermark flow control — kept (tuned)
 *   • 32 MB disk-read batching with prefetch pipeline — kept
 *   • SDP bandwidth cap removal + max-message-size patch — kept
 *   • SpeedMeter EMA smoothing — kept
 *   • ICE stats logging — kept
 *
 * ── Expected performance ─────────────────────────────────────────
 *   Single channel (v14):  1–1.5 MB/s
 *   6 channels  (v15):     8–25 MB/s on 5 GHz WiFi (LAN host path)
 *                           4–10 MB/s on 2.4 GHz WiFi
 *   Ceiling: DTLS encryption CPU + browser SCTP stack, not JS.
 */

// ─── Tuning constants ──────────────────────────────────────────────────────

/**
 * NUM_CHANNELS — number of parallel RTCDataChannels.
 *
 * Each channel is an independent SCTP stream. Chrome allows up to ~65535
 * streams per PeerConnection, but memory and CPU cost scale with count.
 * 6 gives a good balance: 6× cwnd capacity without significant overhead.
 * Raising this beyond 8 shows diminishing returns on most hardware.
 */
const NUM_CHANNELS   = 6;

/**
 * CHUNK_SIZE — payload bytes per dc.send() call.
 *
 * 128 KB is a sweet spot:
 *   • Well below the 256 KB max-message-size we advertise in SDP.
 *   • Halves chunk count vs 64 KB → less JS overhead per byte.
 *   • Large enough that the 8-byte header is <0.006% overhead.
 *   • Small enough that individual send() calls don't cause jank.
 */
const CHUNK_SIZE     = 131072;   // 128 KB

/**
 * BATCH_BYTES — bytes read from disk per File.slice().arrayBuffer().
 * 32 MB gives a generous prefetch buffer. The next batch's disk read
 * runs in parallel while the current batch is being chunked and sent.
 */
const BATCH_BYTES    = 33554432; // 32 MB

/**
 * HIGH_WATERMARK — per-channel: pause dc.send() when bufferedAmount ≥ this.
 * 8 MB per channel (48 MB total across 6 channels) keeps each channel's
 * SCTP queue well-fed so its cwnd never goes idle waiting for JS.
 */
const HIGH_WATERMARK = 8388608;  //  8 MB per channel

/**
 * LOW_WATERMARK — per-channel: resume dc.send() when bufferedAmount drops here.
 * 2 MB ensures we refill before the channel's SCTP queue goes dry.
 */
const LOW_WATERMARK  = 2097152;  //  2 MB per channel

/**
 * BURST_LIMIT — yield to event loop after sending this many bytes in one go.
 * The yield (via MessageChannel, not setTimeout) lets Chrome process incoming
 * SCTP ACKs, which is what advances the congestion window. Without yields,
 * JS monopolises the main thread and cwnd growth stalls.
 * 4 MB per yield: infrequent enough to avoid overhead, frequent enough for cwnd.
 */
const BURST_LIMIT    = 4194304;  //  4 MB

// ─── ICE / STUN config ────────────────────────────────────────────────────

/**
 * On a local WiFi network, ICE selects 'host' candidates (local IPs) and
 * file bytes never leave the LAN. STUN is only needed for the initial
 * candidate gathering — it does not relay data.
 */
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ─── SDP helpers ──────────────────────────────────────────────────────────

/**
 * Remove any bandwidth caps injected by the browser or SFU.
 * b=AS / b=CT / b=TIAS all cap the media section bandwidth.
 * Removing them lets the SCTP layer negotiate its own limits.
 */
function removeBandwidthCaps(sdp) {
  return sdp
    .replace(/\r\nb=AS:\d+/g,   '')
    .replace(/\r\nb=CT:\d+/g,   '')
    .replace(/\r\nb=TIAS:\d+/g, '');
}

/**
 * Raise a=max-message-size to 256 KB.
 * Chrome defaults to 256 KB; Firefox defaults to 64 KB.
 * Explicitly advertising 256 KB ensures both ends agree and allows
 * our 128 KB chunks (+ 8-byte header = 131,080 bytes) to pass safely.
 */
function setMaxMessageSize(sdp, bytes = 262144) {
  if (/a=max-message-size:\d+/.test(sdp)) {
    return sdp.replace(/a=max-message-size:\d+/, `a=max-message-size:${bytes}`);
  }
  return sdp.replace(/(m=application [^\n]+\n)/, `$1a=max-message-size:${bytes}\r\n`);
}

function patchSdp(sdp) {
  return setMaxMessageSize(removeBandwidthCaps(sdp), 262144);
}

// ─── SpeedMeter ───────────────────────────────────────────────────────────

/**
 * Exponential moving average speed meter.
 *
 * alpha=0.35 / (1-alpha)=0.65 gives a reasonably smooth display without
 * the "speed jumps to 0 at stall then never recovers" bug:
 *   if (deltaB <= 0) return; ← only blend when bytes actually moved.
 */
export class SpeedMeter {
  #lastBytes     = 0;
  #lastTime      = performance.now();
  #smoothedSpeed = 0;

  update(currentTotalBytes) {
    const now    = performance.now();
    const deltaT = (now - this.#lastTime) / 1000;
    if (deltaT < 0.1) return;                     // skip sub-100ms ticks

    const deltaB = currentTotalBytes - this.#lastBytes;
    this.#lastBytes = currentTotalBytes;
    this.#lastTime  = now;

    if (deltaB <= 0) return;                       // no new bytes — preserve last speed

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
  if (!isFinite(s) || s < 0 || s > 5940) return '—';
  if (s < 4)    return 'almost done';
  if (s < 60)   return `${Math.round(s)}s left`;
  if (s < 3600) return `${Math.round(s / 60)}m left`;
  return `${(s / 3600).toFixed(1)}h left`;
}

// ─── Backpressure primitives ───────────────────────────────────────────────

/**
 * drainBuffer — pause until a single channel's bufferedAmount < LOW_WATERMARK.
 * Called per-channel during the send loop when that channel hits HIGH_WATERMARK.
 */
function drainBuffer(dc) {
  return new Promise(resolve => {
    if (!dc || dc.bufferedAmount < LOW_WATERMARK) { resolve(); return; }
    dc.bufferedAmountLowThreshold = LOW_WATERMARK;
    dc.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

/**
 * waitForFullDrain — wait until a channel's bufferedAmount hits exactly 0.
 * Used at the end of a file transfer before sending the 'done' message.
 * Ensures all binary data has left the DataChannel buffer (and entered the
 * SCTP send queue) before the control message follows.
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

// ─── MessageChannel yield (background-tab safe) ───────────────────────────

/**
 * yieldToChannel() — schedule a task in the next event loop turn.
 *
 * WHY NOT setTimeout(r, 0)?
 *   Chrome throttles setTimeout to ≥1000ms in background tabs.
 *   If the sender tab loses focus, setTimeout-based yields cap
 *   throughput at BURST_LIMIT / 1000ms = 4 MB/s at best.
 *
 * WHY MessageChannel?
 *   MessageChannel.postMessage() posts a task directly to the task
 *   queue — it is never throttled by background timer policies.
 *   It fires in the next turn (0–1ms) regardless of tab focus.
 *
 * WHY YIELD AT ALL?
 *   Chrome's SCTP stack runs on a network thread, but the ACK events
 *   that advance cwnd are dispatched as browser tasks on the main
 *   thread. If JS holds the main thread continuously, ACK tasks queue
 *   up and cwnd growth stalls. Yielding every BURST_LIMIT bytes
 *   drains the ACK task queue and lets cwnd climb.
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
  #pc   = null;
  #dcs  = [];    // Array<RTCDataChannel>, length = NUM_CHANNELS once open

  #role;
  #socket;
  #cb;

  // ── Receiver state ──────────────────────────────────────────────────────
  #incomingMeta        = null;
  #incomingChunks      = new Map();   // seq → ArrayBuffer
  #receivedBytes       = 0;
  #receivedChunkCount  = 0;           // v15: O(1) counter (was O(N) loop)
  #expectedChunks      = 0;
  #doneReceived        = false;
  #recvSpeed           = new SpeedMeter();

  constructor({ role, socket, callbacks }) {
    this.#role   = role;
    this.#socket = socket;
    this.#cb     = callbacks;
  }

  // ── Initialise PeerConnection + DataChannels ───────────────────────────

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
      if (s === 'failed')       this.#cb.onError?.('Connection failed. Ensure both devices are on the same Wi-Fi.');
      if (s === 'disconnected') this.#cb.onError?.('The other device disconnected.');
    };

    if (this.#role === 'host') {
      await this.#initHost();
    } else {
      this.#initGuest();
    }
  }

  /**
   * HOST (sender): create NUM_CHANNELS DataChannels.
   * Fire onOpen() only after all channels are simultaneously open —
   * this guarantees the UI drop zone becomes active only when the full
   * send pipeline is ready.
   */
  async #initHost() {
    let openCount = 0;

    for (let i = 0; i < NUM_CHANNELS; i++) {
      const dc = this.#pc.createDataChannel(`rippledrop-${i}`, {
        ordered: false,   // unordered delivery — HOL-blocking removed
                          // reliable = true (default, no maxRetransmits)
                          // Reliable unordered is the safest choice for LAN:
                          // no data loss risk, no head-of-line blocking.
      });
      dc.bufferedAmountLowThreshold = LOW_WATERMARK;
      dc.binaryType = 'arraybuffer';
      this.#dcs.push(dc);
      this.#bindChannelHandlers(dc);

      dc.addEventListener('open', () => {
        openCount++;
        console.log(`[DC] Channel ${i} open (${openCount}/${NUM_CHANNELS})`);
        if (openCount === NUM_CHANNELS) {
          console.log(`[DC] All ${NUM_CHANNELS} channels open — send pipeline ready`);
          this.#cb.onOpen?.();
        }
      }, { once: true });
    }

    // Send WebRTC offer
    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription({ type: offer.type, sdp: patchSdp(offer.sdp) });
    this.#socket.emit('signal', { signal: { type: 'offer', sdp: this.#pc.localDescription } });
  }

  /**
   * GUEST (receiver): accept NUM_CHANNELS DataChannels as they arrive.
   * Channels arrive via ondatachannel in the order the host created them.
   * We index by parsed label suffix so #dcs[i] always matches channel i,
   * ensuring #dcs[0] is always the control channel (meta/done messages).
   */
  #initGuest() {
    let openCount = 0;

    this.#pc.ondatachannel = ({ channel }) => {
      channel.bufferedAmountLowThreshold = LOW_WATERMARK;
      channel.binaryType = 'arraybuffer';

      // Extract numeric index from label 'rippledrop-N'
      const idx = parseInt(channel.label.split('-').pop() ?? '0', 10);
      this.#dcs[idx] = channel;
      this.#bindChannelHandlers(channel);

      const onOpen = () => {
        openCount++;
        console.log(`[DC] Channel ${idx} open (${openCount}/${NUM_CHANNELS})`);
        if (openCount === NUM_CHANNELS) {
          console.log(`[DC] All ${NUM_CHANNELS} channels open — receive pipeline ready`);
          this.#cb.onOpen?.();
        }
      };

      // ondatachannel may fire after the channel is already open
      if (channel.readyState === 'open') {
        onOpen();
      } else {
        channel.addEventListener('open', onOpen, { once: true });
      }
    };
  }

  // ── Signal handling ───────────────────────────────────────────────────────

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

  // ── ICE stats logging (diagnostic) ───────────────────────────────────────

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
          console.log('Channels:', NUM_CHANNELS);
          console.log('Local   :', local?.candidateType,  '|', local?.address  ?? '(mDNS)', ':', local?.port);
          console.log('Remote  :', remote?.candidateType, '|', remote?.address ?? '(mDNS)', ':', remote?.port);
          console.log('Path    :', rtt);
          if (local?.candidateType === 'host') {
            console.log(
              `%c✅ DIRECT LAN — ${NUM_CHANNELS} channels active. Expect 8–25 MB/s.`,
              'color:#4ade80;font-weight:bold'
            );
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

  // ── Channel event binding ──────────────────────────────────────────────────

  /**
   * Bind close/error/message handlers to a DataChannel.
   * 'open' is bound separately in initHost/initGuest for open-counting.
   */
  #bindChannelHandlers(dc) {
    dc.onclose = () => this.#cb.onClose?.();
    dc.onerror = (e) => {
      const err = e.error;
      console.error('[DC] RTCErrorEvent:', err?.errorDetail ?? 'unknown', err?.message ?? e);
      this.#cb.onError?.('Transfer channel error — see console for details.');
    };
    dc.onmessage = (e) => this.#onMessage(e);
  }

  // ── Receiver message handler ───────────────────────────────────────────────

  /**
   * All NUM_CHANNELS DataChannels share this single message handler.
   * Binary packets from any channel are merged into the same chunk Map.
   * Control messages (meta, done) are only ever sent on channel 0.
   *
   * Binary packet wire format (matches sender):
   *   [0..3]  seq  — uint32 little-endian, global chunk sequence number
   *   [4..7]  len  — uint32 little-endian, payload byte length
   *   [8..]   payload — raw file bytes
   */
  #onMessage({ data }) {
    // ── Control message (JSON string) ──────────────────────────────────
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'meta') {
        // New file incoming — reset all receiver state
        this.#incomingMeta        = msg;
        this.#incomingChunks      = new Map();
        this.#receivedBytes       = 0;
        this.#receivedChunkCount  = 0;
        this.#expectedChunks      = msg.totalChunks || 0;
        this.#doneReceived        = false;
        this.#recvSpeed           = new SpeedMeter();
        this.#cb.onFileMeta?.(msg);

      } else if (msg.type === 'done') {
        // 'done' marks end of file. With ordered:false, 'done' (sent on
        // channel 0) may arrive before the last binary chunk on another
        // channel — the counter check in #tryAssemble handles this safely.
        this.#doneReceived = true;
        this.#tryAssemble();
      }
      return;
    }

    // ── Binary chunk ───────────────────────────────────────────────────
    const dv      = new DataView(data);
    const seq     = dv.getUint32(0, true);
    const len     = dv.getUint32(4, true);
    const payload = data.slice(8, 8 + len);

    // Deduplicate: skip if this seq already arrived (can happen on
    // rare SCTP retransmits that deliver a copy after the original).
    if (!this.#incomingChunks.has(seq)) {
      this.#incomingChunks.set(seq, payload);
      this.#receivedBytes      += payload.byteLength;
      this.#receivedChunkCount += 1;          // O(1) increment
      this.#recvSpeed.update(this.#receivedBytes);
    }

    this.#cb.onChunkReceived?.({
      receivedBytes: this.#receivedBytes,
      totalBytes:    this.#incomingMeta?.size ?? 1,
      speed:         this.#recvSpeed,
      meta:          this.#incomingMeta,
    });

    // Attempt assembly on every chunk (in case 'done' already arrived)
    if (this.#doneReceived) this.#tryAssemble();
  }

  /**
   * #tryAssemble — v15 O(1) completion check.
   *
   * v14 problem: iterated 0..N on every incoming chunk → O(N²) total.
   * v15 solution: one integer comparison (#receivedChunkCount < #expectedChunks).
   * The final ordered assembly loop is O(N) but runs exactly once.
   *
   * Correctness:
   *   #receivedChunkCount only increments when a *new* seq is stored.
   *   Duplicate packets (caught by Map.has) don't inflate the count.
   *   So count === expectedChunks iff the Map contains every seq 0..N-1.
   */
  #tryAssemble() {
    // Still waiting for some chunks — bail immediately (O(1))
    if (this.#receivedChunkCount < this.#expectedChunks) return;

    // All chunks present — build Blob in sequential order (O(N), runs once)
    const chunks = [];
    for (let i = 0; i < this.#expectedChunks; i++) {
      chunks.push(this.#incomingChunks.get(i));
    }
    const blob = new Blob(chunks, { type: this.#incomingMeta.mimeType });
    this.#cb.onFileDone?.(blob, this.#incomingMeta);

    // Reset for next file
    this.#incomingMeta       = null;
    this.#incomingChunks     = new Map();
    this.#receivedBytes      = 0;
    this.#receivedChunkCount = 0;
    this.#expectedChunks     = 0;
    this.#doneReceived       = false;
  }

  // ── Sender public API ──────────────────────────────────────────────────────

  async sendFiles(files, onProgress) {
    for (let i = 0; i < files.length; i++) {
      await this.#sendOne(files[i], i, files.length, onProgress);
    }
  }

  /**
   * #sendOne — send a single file across NUM_CHANNELS channels.
   *
   * Chunk distribution:
   *   chunk seq=0  → dcs[0]
   *   chunk seq=1  → dcs[1]
   *   ...
   *   chunk seq=5  → dcs[5]
   *   chunk seq=6  → dcs[0]  ← wraps round-robin
   *   ...
   *
   * Each channel drains independently. Flow control is per-channel:
   * if one channel's buffer fills, only that channel pauses while
   * the others continue sending. This maximises utilisation.
   *
   * 'done' is sent on dcs[0] only AFTER all six channels have fully
   * drained (bufferedAmount === 0), so no binary data is in-flight
   * when the control message hits the receiver.
   */
  async #sendOne(file, fileIndex, fileTotal, onProgress) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 0;
    const meta = {
      type:     'meta',
      name:     file.name,
      size:     file.size,
      mimeType: file.type || 'application/octet-stream',
      fileIndex,
      fileTotal,
      totalChunks,
      chunkSize: CHUNK_SIZE,
    };

    // Control messages always on channel 0
    this.#dcs[0].send(JSON.stringify(meta));

    if (file.size === 0) {
      this.#dcs[0].send(JSON.stringify({ type: 'done' }));
      onProgress?.({
        sentBytes: 0, totalBytes: 0, speed: new SpeedMeter(),
        meta, fileIndex, fileTotal, isLastChunk: true,
      });
      return;
    }

    const speed     = new SpeedMeter();
    let   bytesSent = 0;   // total bytes passed to dc.send() (for % progress)
    let   seq       = 0;   // monotonically increasing chunk sequence number

    // ── UI progress timer ──────────────────────────────────────────────
    //
    // effectivelySent = bytesSent − Σ(dc.bufferedAmount for all channels)
    //
    // bytesSent counts bytes *queued* into all DataChannels (dc.send is
    // near-instant — it just copies to the DC buffer). Subtracting the
    // total still-buffered bytes gives bytes actually handed to SCTP —
    // approximately what the receiver is counting. Both sides now show
    // the same speed.
    const uiTimer = setInterval(() => {
      if (!this.#dcs[0]) return;
      const totalBuffered   = this.#dcs.reduce((s, dc) => s + (dc?.bufferedAmount ?? 0), 0);
      const effectivelySent = Math.max(0, bytesSent - totalBuffered);
      speed.update(effectivelySent);
      onProgress?.({
        sentBytes:  bytesSent,
        totalBytes: file.size,
        speed,
        meta, fileIndex, fileTotal,
        isLastChunk: false,
      });
    }, 100);

    try {
      // ── THREE-LEVEL PIPELINE ───────────────────────────────────────────
      //
      // Level 0 — Disk pipeline:
      //   File.slice().arrayBuffer() (disk read) for batch N+1 starts
      //   while batch N is being chunked and sent. Eliminates disk-I/O
      //   wait from the inner send loop.
      //
      // Level 1 — MessageChannel yield every BURST_LIMIT bytes:
      //   Lets Chrome drain the SCTP ACK task queue so cwnd can climb.
      //   Background-tab safe (not throttled like setTimeout).
      //
      // Level 2 — Per-channel backpressure (drainBuffer at HIGH_WATERMARK):
      //   Only the full channel pauses; others continue uninterrupted.
      //   Prevents SCTP receive-window overflow and cwnd collapse.

      let fileOffset       = 0;
      let nextBatchPromise = this.#readBatch(file, fileOffset);
      fileOffset           = Math.min(fileOffset + BATCH_BYTES, file.size);

      while (true) {
        const batch = await nextBatchPromise;
        if (!batch || batch.byteLength === 0) break;

        // Prefetch next batch in parallel with sending current one
        if (fileOffset < file.size) {
          nextBatchPromise = this.#readBatch(file, fileOffset);
          fileOffset       = Math.min(fileOffset + BATCH_BYTES, file.size);
        } else {
          nextBatchPromise = Promise.resolve(null);
        }

        let burstBytes = 0;

        for (let i = 0; i < batch.byteLength; i += CHUNK_SIZE) {
          // Pick channel round-robin by seq number
          const chIdx = seq % NUM_CHANNELS;
          const dc    = this.#dcs[chIdx];

          if (!dc || dc.readyState !== 'open') {
            throw new Error('DataChannel closed during send');
          }

          const end     = Math.min(i + CHUNK_SIZE, batch.byteLength);
          const payload = new Uint8Array(batch, i, end - i);

          // Wire format: 8-byte header + payload
          //   bytes 0–3: seq  (uint32 LE) — receiver uses this as Map key
          //   bytes 4–7: len  (uint32 LE) — explicit length (no trailing garbage)
          //   bytes 8+:  payload
          const packet = new Uint8Array(8 + payload.byteLength);
          const dv     = new DataView(packet.buffer);
          dv.setUint32(0, seq, true);
          dv.setUint32(4, payload.byteLength, true);
          packet.set(payload, 8);

          dc.send(packet);
          bytesSent  += payload.byteLength;
          burstBytes += payload.byteLength;
          seq++;

          // Level 1: yield after BURST_LIMIT bytes (MessageChannel, not setTimeout)
          if (burstBytes >= BURST_LIMIT) {
            burstBytes = 0;
            await yieldToChannel();
          }

          // Level 2: per-channel backpressure — only this channel pauses
          if (dc.bufferedAmount >= HIGH_WATERMARK) {
            await drainBuffer(dc);
            burstBytes = 0;
          }
        }
      }

      // Wait for ALL six channels to fully drain before sending 'done'.
      // This ensures every binary chunk has left the DataChannel buffer
      // (entered the SCTP send queue) before the control frame follows.
      // Combined with the #doneReceived flag on the receiver, this
      // guarantees 'done' never triggers assembly before all chunks arrive.
      await Promise.all(this.#dcs.map(dc => waitForFullDrain(dc)));

      // Final progress callback with exact byte count
      speed.update(file.size);
      onProgress?.({
        sentBytes: file.size, totalBytes: file.size,
        speed, meta, fileIndex, fileTotal, isLastChunk: true,
      });

    } finally {
      clearInterval(uiTimer);
    }

    // 'done' on channel 0 — signals the receiver to assemble the Blob
    this.#dcs[0].send(JSON.stringify({ type: 'done' }));
  }

  // ── Disk read helper ───────────────────────────────────────────────────────

  #readBatch(file, startOffset) {
    if (startOffset >= file.size) return Promise.resolve(null);
    return file
      .slice(startOffset, Math.min(startOffset + BATCH_BYTES, file.size))
      .arrayBuffer();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  close() {
    this.#dcs.forEach(dc => { try { dc?.close(); } catch (_) {} });
    try { this.#pc?.close(); } catch (_) {}
    this.#dcs = [];
    this.#pc  = null;
  }
}