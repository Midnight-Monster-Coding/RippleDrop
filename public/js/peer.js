/**
 * RippleDrop — WebRTC Peer Manager  v17
 *
 * ══════════════════════════════════════════════════════════════════
 * WHAT v17 FIXES OVER v16
 * ══════════════════════════════════════════════════════════════════
 *
 * ROOT CAUSE OF v16's CONNECTION FAILURE:
 *   A race condition between ICE candidate signals and SDP negotiation.
 *
 *   The host emits 'multi-offer' and immediately begins ICE gathering.
 *   ICE 'candidate' signals can arrive at the guest BEFORE the guest
 *   has finished processing 'multi-offer' (i.e. before setRemoteDescription
 *   is called on the matching PeerConnection).
 *
 *   addIceCandidate() throws InvalidStateError when remoteDescription is
 *   null — exactly the error visible in the console:
 *     "Failed to execute 'addIceCandidate' on 'RTCPeerConnection':
 *      The remote description was null"
 *
 *   The secondary 'sctp-failure: User-Initiated Abort' errors are a
 *   knock-on effect: the broken PC is closed while chunks are in-flight.
 *
 * THE FIX — ICE candidate queuing (#pendingCandidates):
 *   Any 'ice' signal that arrives before its PC has a remoteDescription
 *   is pushed onto #pendingCandidates[]. Once #handleMultiOffer() (guest)
 *   or the 'multi-answer' handler (host) finishes setting all remote
 *   descriptions, the queue is drained and every buffered candidate is
 *   applied in order. This eliminates the race completely.
 *
 * ── What is NOT changed vs v16 ───────────────────────────────────
 *   • NUM_CONNECTIONS 6 independent RTCPeerConnections  — kept
 *   • CHUNK_SIZE 128 KB                                 — kept
 *   • BATCH_BYTES 32 MB disk-read batching              — kept
 *   • HIGH/LOW watermark per-connection flow control    — kept
 *   • BURST_LIMIT + MessageChannel yield                — kept
 *   • O(1) #tryAssemble() counter check                 — kept
 *   • Speed meter bufferedAmount correction             — kept
 *   • waitForFullDrain before 'done'                    — kept
 *   • SDP bandwidth cap removal + max-message-size      — kept
 *   • SpeedMeter EMA smoothing                          — kept
 *   • ICE stats logging                                 — kept
 *   • multi-offer / multi-answer signalling protocol    — kept
 *
 * ── Expected performance ─────────────────────────────────────────
 *   6 PeerConnections (v16/v17): 8–25 MB/s on 5 GHz WiFi / LAN
 *                                 4–10 MB/s on 2.4 GHz WiFi
 *   Ceiling: DTLS encryption CPU + browser SCTP stack, not JS.
 */

// ─── Tuning constants ──────────────────────────────────────────────────────

/**
 * NUM_CONNECTIONS — number of independent RTCPeerConnections.
 *
 * Each PeerConnection is a separate SCTP association with its own cwnd.
 * 6 gives a good balance: 6× cwnd capacity without significant overhead.
 * Raising this beyond 8 shows diminishing returns on most hardware.
 */
const NUM_CONNECTIONS = 6;

/**
 * CHUNK_SIZE — payload bytes per dc.send() call (128 KB).
 */
const CHUNK_SIZE     = 131072;   // 128 KB

/**
 * BATCH_BYTES — bytes read from disk per File.slice().arrayBuffer() (32 MB).
 */
const BATCH_BYTES    = 33554432; // 32 MB

/**
 * HIGH_WATERMARK — pause dc.send() when bufferedAmount ≥ this value.
 * 8 MB per connection keeps each cwnd well-fed.
 */
const HIGH_WATERMARK = 8388608;  //  8 MB per connection

/**
 * LOW_WATERMARK — resume dc.send() when bufferedAmount drops here.
 */
const LOW_WATERMARK  = 2097152;  //  2 MB per connection

/**
 * BURST_LIMIT — yield to event loop after sending this many bytes.
 * Lets Chrome process SCTP ACKs so each connection's cwnd can climb.
 */
const BURST_LIMIT    = 4194304;  //  4 MB

// ─── ICE / STUN config ────────────────────────────────────────────────────

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
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
  return setMaxMessageSize(removeBandwidthCaps(sdp), 262144);
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

// ─── MessageChannel yield (background-tab safe) ───────────────────────────

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
  // v16+: Array of independent PeerConnections (one per slot).
  // Each #pcs[i] pairs with #dcs[i]. Each has its own SCTP association
  // and congestion window, unlike v15 where all channels shared one PC.
  #pcs = [];   // Array<RTCPeerConnection>, length = NUM_CONNECTIONS
  #dcs = [];   // Array<RTCDataChannel>,   length = NUM_CONNECTIONS

  #role;
  #socket;
  #cb;

  // ── v17: ICE candidate queue ─────────────────────────────────────────────
  // ICE 'candidate' signals can arrive before setRemoteDescription() is
  // called on the matching PeerConnection (race condition). Candidates are
  // buffered here and drained once all remote descriptions are in place.
  #pendingCandidates = []; // Array<{ pcIndex, candidate }>

  // ── Receiver state ──────────────────────────────────────────────────────
  #incomingMeta        = null;
  #incomingChunks      = new Map();
  #receivedBytes       = 0;
  #receivedChunkCount  = 0;
  #expectedChunks      = 0;
  #doneReceived        = false;
  #recvSpeed           = new SpeedMeter();

  constructor({ role, socket, callbacks }) {
    this.#role   = role;
    this.#socket = socket;
    this.#cb     = callbacks;
  }

  // ── Initialise PeerConnections + DataChannels ──────────────────────────

  async init() {
    if (this.#role === 'host') {
      await this.#initHost();
    }
    // Guest role: PeerConnections are created lazily when 'multi-offer' arrives
    // via handleSignal(). Nothing to set up here.
  }

  /**
   * #makePeerConnection — create one RTCPeerConnection with shared ICE and
   * state-change handlers. pcIndex is used to:
   *   • tag ICE candidate messages so the remote knows which PC they belong to
   *   • limit verbose logging to pc0 only
   */
  #makePeerConnection(pcIndex) {
    const pc = new RTCPeerConnection(ICE_CONFIG);

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (pcIndex === 0) {
        console.log('[ICE] Candidate:', candidate.type, candidate.address ?? '(mDNS)');
      }
      this.#socket.emit('signal', { signal: { type: 'ice', pcIndex, candidate } });
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (!s) return;
      // Only log and show ICE stats from the first PeerConnection to avoid spam
      if (pcIndex === 0) {
        console.log('[ICE]', s);
        if (s === 'connected' || s === 'completed') this.#logIceStats(pc);
      }
      if (s === 'failed')       this.#cb.onError?.('Connection failed. Ensure both devices are on the same Wi-Fi.');
      if (s === 'disconnected') this.#cb.onError?.('The other device disconnected.');
    };

    return pc;
  }

  /**
   * HOST (sender): create NUM_CONNECTIONS independent PeerConnections,
   * each with its own DataChannel. Collect all offers and send as one
   * 'multi-offer' signal so the guest can answer in a single round-trip.
   *
   * onOpen() fires only when ALL connections are simultaneously open.
   */
  async #initHost() {
    let openCount = 0;
    const offers  = [];

    for (let i = 0; i < NUM_CONNECTIONS; i++) {
      const pc = this.#makePeerConnection(i);
      this.#pcs.push(pc);

      const dc = pc.createDataChannel('rippledrop', {
        ordered: false,  // unordered = no HOL-blocking across chunks
                         // reliable (default) = no data loss
      });
      dc.bufferedAmountLowThreshold = LOW_WATERMARK;
      dc.binaryType = 'arraybuffer';
      this.#dcs[i] = dc;
      this.#bindChannelHandlers(dc);

      dc.addEventListener('open', () => {
        openCount++;
        console.log(`[DC] Connection ${i} open (${openCount}/${NUM_CONNECTIONS})`);
        if (openCount === NUM_CONNECTIONS) {
          console.log(`[DC] All ${NUM_CONNECTIONS} connections open — send pipeline ready`);
          this.#cb.onOpen?.();
        }
      }, { once: true });

      // Gather offer (ICE candidates begin gathering in background)
      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: offer.type, sdp: patchSdp(offer.sdp) });
      offers.push({ type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    }

    // Send all NUM_CONNECTIONS offers in one signalling message
    this.#socket.emit('signal', { signal: { type: 'multi-offer', sdps: offers } });
  }

  // ── Signal handling ───────────────────────────────────────────────────────

  /**
   * handleSignal — dispatch incoming signalling messages.
   *
   * 'multi-offer'  (guest receives from host):
   *   Create NUM_CONNECTIONS PeerConnections, set remote descriptions,
   *   register ondatachannel, create answers, send 'multi-answer'.
   *   After all setRemoteDescription calls, drain #pendingCandidates.
   *
   * 'multi-answer' (host receives from guest):
   *   Set remote descriptions on existing PCs.
   *   After all setRemoteDescription calls, drain #pendingCandidates.
   *
   * 'ice' (both sides):
   *   If the target PC has a remoteDescription → apply immediately.
   *   Otherwise → push onto #pendingCandidates for later drain.
   *   This eliminates the InvalidStateError race condition (v17 fix).
   */
  async handleSignal(signal) {
    try {
      if (signal.type === 'multi-offer') {
        await this.#handleMultiOffer(signal.sdps);

      } else if (signal.type === 'multi-answer') {
        for (let i = 0; i < signal.sdps.length; i++) {
          if (this.#pcs[i]) {
            await this.#pcs[i].setRemoteDescription(
              new RTCSessionDescription(signal.sdps[i])
            );
          }
        }
        // Drain any ICE candidates that arrived before the answers were set
        await this.#drainPendingCandidates();

      } else if (signal.type === 'ice' && signal.candidate) {
        // ── v17 fix: guard against null remoteDescription ──────────────────
        // ICE candidates often arrive before the corresponding SDP answer/offer
        // has been set as the remote description. Applying them immediately
        // throws InvalidStateError. We queue them and apply after the SDP
        // exchange completes (#drainPendingCandidates).
        const pc = this.#pcs[signal.pcIndex];
        if (!pc || !pc.remoteDescription) {
          this.#pendingCandidates.push({
            pcIndex:   signal.pcIndex,
            candidate: signal.candidate,
          });
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      }
    } catch (e) {
      console.error('[Signal] Error:', e);
    }
  }

  /**
   * #drainPendingCandidates — apply all queued ICE candidates now that every
   * PeerConnection has a remoteDescription set. Called after SDP negotiation
   * completes on both host ('multi-answer' received) and guest ('multi-offer'
   * processed).
   *
   * Candidates whose PC slot is still missing (shouldn't happen in normal
   * flow, but guarded for safety) are silently discarded.
   */
  async #drainPendingCandidates() {
    const pending = this.#pendingCandidates.splice(0); // drain atomically
    for (const { pcIndex, candidate } of pending) {
      const pc = this.#pcs[pcIndex];
      if (!pc?.remoteDescription) continue; // safety guard
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn(`[ICE] Failed to apply queued candidate for pc${pcIndex}:`, e);
      }
    }
    if (pending.length > 0) {
      console.log(`[ICE] Drained ${pending.length} queued candidate(s)`);
    }
  }

  /**
   * GUEST (receiver): process a 'multi-offer' from the host.
   * Creates NUM_CONNECTIONS PeerConnections, each with:
   *   • remote description set from the corresponding offer SDP
   *   • ondatachannel handler to receive the DataChannel the host opened
   *   • an answer SDP
   * Sends all answers back as 'multi-answer'.
   * Drains #pendingCandidates after all remote descriptions are set.
   */
  async #handleMultiOffer(sdps) {
    let openCount = 0;
    const answers = [];

    for (let i = 0; i < sdps.length; i++) {
      const pc = this.#makePeerConnection(i);
      this.#pcs.push(pc);

      // Each PC receives exactly one DataChannel from the host
      pc.ondatachannel = ({ channel }) => {
        channel.bufferedAmountLowThreshold = LOW_WATERMARK;
        channel.binaryType = 'arraybuffer';
        this.#dcs[i] = channel;
        this.#bindChannelHandlers(channel);

        const onOpen = () => {
          openCount++;
          console.log(`[DC] Connection ${i} open (${openCount}/${NUM_CONNECTIONS})`);
          if (openCount === NUM_CONNECTIONS) {
            console.log(`[DC] All ${NUM_CONNECTIONS} connections open — receive pipeline ready`);
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

      await pc.setRemoteDescription(new RTCSessionDescription(sdps[i]));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription({ type: answer.type, sdp: patchSdp(answer.sdp) });
      answers.push({ type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    }

    // All remote descriptions are now set — safe to apply queued candidates
    await this.#drainPendingCandidates();

    this.#socket.emit('signal', { signal: { type: 'multi-answer', sdps: answers } });
  }

  // ── ICE stats logging (diagnostic) ───────────────────────────────────────

  /**
   * Log ICE path info for one PeerConnection (called on pc0 only).
   */
  async #logIceStats(pc) {
    try {
      await new Promise(r => setTimeout(r, 700));
      const stats = await pc?.getStats();
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
          console.log('Connections:', NUM_CONNECTIONS, '(independent SCTP associations)');
          console.log('Local   :', local?.candidateType,  '|', local?.address  ?? '(mDNS)', ':', local?.port);
          console.log('Remote  :', remote?.candidateType, '|', remote?.address ?? '(mDNS)', ':', remote?.port);
          console.log('Path    :', rtt);
          if (local?.candidateType === 'host') {
            console.log(
              `%c✅ DIRECT LAN — ${NUM_CONNECTIONS} independent cwnds. Expect 8–25 MB/s.`,
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
   * All NUM_CONNECTIONS DataChannels share this single message handler.
   * Binary packets from any connection are merged into the same chunk Map.
   * Control messages (meta, done) are only ever sent on #dcs[0].
   *
   * Binary packet wire format:
   *   [0..3]  seq  — uint32 little-endian, global chunk sequence number
   *   [4..7]  len  — uint32 little-endian, payload byte length
   *   [8..]   payload — raw file bytes
   */
  #onMessage({ data }) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'meta') {
        this.#incomingMeta        = msg;
        this.#incomingChunks      = new Map();
        this.#receivedBytes       = 0;
        this.#receivedChunkCount  = 0;
        this.#expectedChunks      = msg.totalChunks || 0;
        this.#doneReceived        = false;
        this.#recvSpeed           = new SpeedMeter();
        this.#cb.onFileMeta?.(msg);

      } else if (msg.type === 'done') {
        this.#doneReceived = true;
        this.#tryAssemble();
      }
      return;
    }

    // Binary chunk
    const dv      = new DataView(data);
    const seq     = dv.getUint32(0, true);
    const len     = dv.getUint32(4, true);
    const payload = data.slice(8, 8 + len);

    if (!this.#incomingChunks.has(seq)) {
      this.#incomingChunks.set(seq, payload);
      this.#receivedBytes      += payload.byteLength;
      this.#receivedChunkCount += 1;
      this.#recvSpeed.update(this.#receivedBytes);
    }

    this.#cb.onChunkReceived?.({
      receivedBytes: this.#receivedBytes,
      totalBytes:    this.#incomingMeta?.size ?? 1,
      speed:         this.#recvSpeed,
      meta:          this.#incomingMeta,
    });

    if (this.#doneReceived) this.#tryAssemble();
  }

  // ── Assembly ───────────────────────────────────────────────────────────────

  #tryAssemble() {
    if (this.#receivedChunkCount < this.#expectedChunks) return;

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
   * #sendOne — send a single file across NUM_CONNECTIONS DataChannels.
   *
   * Chunk distribution (round-robin across all connections):
   *   chunk seq=0  → dcs[0]  (on pcs[0], its own cwnd)
   *   chunk seq=1  → dcs[1]  (on pcs[1], its own cwnd)
   *   ...
   *   chunk seq=5  → dcs[5]  (on pcs[5], its own cwnd)
   *   chunk seq=6  → dcs[0]  ← wraps round-robin
   *
   * Each dcs[i] has a SEPARATE PeerConnection and thus a separate SCTP
   * association with an independent congestion window.
   * All six cwnds grow in parallel and independently at the network level.
   *
   * 'done' is sent on dcs[0] only AFTER all connections have fully drained.
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

    // Control messages always on connection 0
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
    let   bytesSent = 0;
    let   seq       = 0;

    // UI progress timer — subtracts total buffered across all connections
    // so the display shows actual network rate, not queue-fill rate.
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
      let fileOffset       = 0;
      let nextBatchPromise = this.#readBatch(file, fileOffset);
      fileOffset           = Math.min(fileOffset + BATCH_BYTES, file.size);

      while (true) {
        const batch = await nextBatchPromise;
        if (!batch || batch.byteLength === 0) break;

        // Prefetch next batch while sending current one
        if (fileOffset < file.size) {
          nextBatchPromise = this.#readBatch(file, fileOffset);
          fileOffset       = Math.min(fileOffset + BATCH_BYTES, file.size);
        } else {
          nextBatchPromise = Promise.resolve(null);
        }

        let burstBytes = 0;

        for (let i = 0; i < batch.byteLength; i += CHUNK_SIZE) {
          // Round-robin across all connections
          const chIdx = seq % NUM_CONNECTIONS;
          const dc    = this.#dcs[chIdx];

          if (!dc || dc.readyState !== 'open') {
            throw new Error(`DataChannel ${chIdx} closed during send`);
          }

          const end     = Math.min(i + CHUNK_SIZE, batch.byteLength);
          const payload = new Uint8Array(batch, i, end - i);

          // Wire format: 8-byte header + payload
          //   bytes 0–3: seq  (uint32 LE)
          //   bytes 4–7: len  (uint32 LE)
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

          // Yield every BURST_LIMIT bytes — lets each PC's SCTP process ACKs
          // and advance its cwnd independently.
          if (burstBytes >= BURST_LIMIT) {
            burstBytes = 0;
            await yieldToChannel();
          }

          // Per-connection backpressure — only this connection pauses
          if (dc.bufferedAmount >= HIGH_WATERMARK) {
            await drainBuffer(dc);
            burstBytes = 0;
          }
        }
      }

      // Wait for ALL connections to fully drain before sending 'done'
      await Promise.all(this.#dcs.map(dc => waitForFullDrain(dc)));

      speed.update(file.size);
      onProgress?.({
        sentBytes: file.size, totalBytes: file.size,
        speed, meta, fileIndex, fileTotal, isLastChunk: true,
      });

    } finally {
      clearInterval(uiTimer);
    }

    // 'done' on connection 0 — signals receiver to assemble Blob
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
    this.#pendingCandidates = [];
    this.#dcs.forEach(dc => { try { dc?.close(); } catch (_) {} });
    this.#pcs.forEach(pc => { try { pc?.close(); } catch (_) {} });
    this.#dcs = [];
    this.#pcs = [];
  }
}