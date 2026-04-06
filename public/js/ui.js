/**
 * RippleDrop — UI Manager v3  (ui.js)
 *
 * Changes from v2:
 *
 *  SOUND FIX
 *   - Removed playWhooshSound() from inside particle spawn loop.
 *     Previously a whoosh played every 1600ms during any transfer — that's
 *     the "continuous noise" bug. Now silence during transfer.
 *   - Added exported playWhoosh() that plays /sounds/wave-whoose.mp3 ONCE
 *     (called by app.js when the sender initiates a file drop/pick).
 *     Falls back to a synthesised whoosh if the MP3 is unavailable.
 *
 *  PARTICLE FX
 *   - Sender particles now travel from BELOW THE SCREEN all the way to
 *     ABOVE the top edge — files appear to leave the device upward.
 *   - Receiver particles fall from ABOVE the screen all the way to
 *     the bottom — files appear to arrive from above.
 *   - Wave canvas stays as a mid-screen decorative element.
 *
 *  WAVE COLORS
 *   - Canvas wave layers updated from blue → warm amber/gold palette.
 *   - All glow, ripple and bloom colours updated to match amber theme.
 */

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const UPDATE_INTERVAL   = 80;          // ms between progress DOM writes
const PARTICLE_INTERVAL = 1800;        // ms between particle spawns
const WAVE_ZONE         = 0.42;        // fraction of viewport for wave height
const CIRCUMFERENCE     = 2 * Math.PI * 22; // SVG ring r=22

// ─────────────────────────────────────────────────────────
// Throttle state
// ─────────────────────────────────────────────────────────

let _lastSendUpdate = 0;
let _lastRecvUpdate = 0;

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

export const $ = id => document.getElementById(id);

export function formatBytes(b) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b} B`;
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fileIcon(mime = '') {
  if (!mime) return '📄';
  if (mime.startsWith('image/'))  return '🖼️';
  if (mime.startsWith('video/'))  return '🎬';
  if (mime.startsWith('audio/'))  return '🎵';
  if (mime.includes('pdf'))       return '📑';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('gz') || mime.includes('rar')) return '📦';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel'))   return '📊';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📊';
  return '📄';
}

// ─────────────────────────────────────────────────────────
// View management
// ─────────────────────────────────────────────────────────

export function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}

// ─────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────

let _toastTimer = null;

export function showToast(msg, type = 'error') {
  const el = $('toast');
  el.textContent  = msg;
  el.dataset.type = type;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─────────────────────────────────────────────────────────
// QR Code
// ─────────────────────────────────────────────────────────

export function generateQR(container, url) {
  container.innerHTML = '';
  try {
    new QRCode(container, {
      text: url,
      width: 192,
      height: 192,
      colorDark:  '#F59E0B',   // amber
      colorLight: '#0A0806',   // warm dark bg
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    container.textContent = url;
  }
}

// ─────────────────────────────────────────────────────────
// Dynamic Neumorphism — cursor-linked shadow rotation
// ─────────────────────────────────────────────────────────

let _cursorThrottle = 0;

function initCursorLighting() {
  document.addEventListener('mousemove', e => {
    const now = Date.now();
    if (now - _cursorThrottle < 40) return;
    _cursorThrottle = now;

    const cx    = window.innerWidth  / 2;
    const cy    = window.innerHeight / 2;
    const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
    const dist  = 8;
    const dx    = (Math.cos(angle) * dist).toFixed(2);
    const dy    = (Math.sin(angle) * dist).toFixed(2);
    document.documentElement.style.setProperty('--neu-dx', `${dx}px`);
    document.documentElement.style.setProperty('--neu-dy', `${dy}px`);
  });
}

// ─────────────────────────────────────────────────────────
// Haptic Feedback
// ─────────────────────────────────────────────────────────

function haptic(ms) {
  try { navigator.vibrate?.(ms); } catch (_) {}
}

// ─────────────────────────────────────────────────────────
// Audio — MP3 + Web Audio fallback
// ─────────────────────────────────────────────────────────

let _audioCtx    = null;
let _whooshAudio = null;  // preloaded <Audio> for the MP3
let _whooshLoaded = false;

function getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  return _audioCtx;
}

/** Preload the wave-whoose MP3 so playback is instant. */
function _preloadWhoosh() {
  try {
    _whooshAudio = new Audio('/sounds/wave-whoose.mp3');
    _whooshAudio.preload = 'auto';
    _whooshAudio.volume  = 0.7;
    _whooshAudio.addEventListener('canplaythrough', () => { _whooshLoaded = true; }, { once: true });
    _whooshAudio.addEventListener('error', () => {
      // MP3 missing — will use synthesised fallback
      _whooshAudio = null;
    }, { once: true });
    _whooshAudio.load();
  } catch (_) {
    _whooshAudio = null;
  }
}

/**
 * Synthesised fallback whoosh — an airy noise burst sweeping upward.
 * Used only if /sounds/wave-whoose.mp3 is unavailable.
 */
function _synthWhoosh() {
  const ctx = getAudioCtx();
  if (!ctx) return;

  const dur    = 0.55;
  const bufLen = Math.floor(ctx.sampleRate * dur);
  const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data   = buf.getChannelData(0);

  // Pink-ish noise with fast fade-out
  for (let i = 0; i < bufLen; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 1.8);
  }

  const src     = ctx.createBufferSource();
  const filter1 = ctx.createBiquadFilter();  // low cut
  const filter2 = ctx.createBiquadFilter();  // sweep bandpass
  const gain    = ctx.createGain();

  src.buffer = buf;

  filter1.type            = 'highpass';
  filter1.frequency.value = 200;

  filter2.type = 'bandpass';
  filter2.frequency.setValueAtTime(400,  ctx.currentTime);
  filter2.frequency.exponentialRampToValueAtTime(5000, ctx.currentTime + dur);
  filter2.Q.value = 0.6;

  gain.gain.setValueAtTime(0,    ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);

  src.connect(filter1);
  filter1.connect(filter2);
  filter2.connect(gain);
  gain.connect(ctx.destination);
  src.start(ctx.currentTime);
}

/**
 * Play the wave-whoosh sound ONCE.
 * Called by app.js exactly once per file-pick / drop event.
 * NEVER called inside the particle loop (that was the noise bug).
 */
export function playWhoosh() {
  // Ensure AudioContext is resumed (browsers require a user gesture first)
  const ctx = getAudioCtx();
  if (ctx?.state === 'suspended') ctx.resume();

  if (_whooshAudio && _whooshLoaded) {
    // Clone the audio node so rapid re-picks work correctly
    const clone = _whooshAudio.cloneNode();
    clone.volume = 0.7;
    clone.play().catch(() => _synthWhoosh());
  } else {
    _synthWhoosh();
  }
}

/** Low rumble thump — played when peers connect */
function playConnectSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3);
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.45);
}

/** Soft success ping — played when all files complete */
function playSuccessSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  [523.25, 659.25, 783.99].forEach((freq, i) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.1, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.start(t);
    osc.stop(t + 0.55);
  });
}

// ─────────────────────────────────────────────────────────
// Wave Canvas  — warm amber palette
// ─────────────────────────────────────────────────────────

let _wCanvas = null;
let _wCtx    = null;
let _wTime   = 0;
let _wRAF    = null;
let _ripples = [];    // [{x, y, t}]
let _wRole   = null;  // 'send' | 'receive'

function initWave() {
  _wCanvas = $('wave-canvas');
  _wCtx    = _wCanvas.getContext('2d');
  _resizeWave();
  window.addEventListener('resize', _resizeWave);
}

function _resizeWave() {
  _wCanvas.width  = window.innerWidth;
  _wCanvas.height = window.innerHeight;
}

function waveZoneHeight() { return window.innerHeight * WAVE_ZONE; }
function waveSurfaceY()   { return waveZoneHeight() * 0.78; }

function _drawWave(t) {
  const W  = _wCanvas.width;
  const wz = waveZoneHeight();

  _wCtx.clearRect(0, 0, W, _wCanvas.height);

  // ── Four amber/gold wave layers ────────────────────────
  const layers = [
    { a: 28, f: 0.007, ph: 0,             sp: 0.35, fill: 'rgba(90, 50,  5, 0.12)' },
    { a: 22, f: 0.010, ph: Math.PI * 0.4, sp: 0.50, fill: 'rgba(150, 90, 10, 0.11)' },
    { a: 17, f: 0.013, ph: Math.PI * 0.8, sp: 0.65, fill: 'rgba(200,130, 15, 0.09)' },
    { a: 12, f: 0.018, ph: Math.PI * 1.3, sp: 0.90, fill: 'rgba(245,158, 11, 0.06)' },
  ];

  layers.forEach(l => {
    _wCtx.beginPath();
    for (let x = 0; x <= W; x++) {
      const y = wz * 0.8
        + l.a * Math.sin(x * l.f + t * l.sp + l.ph)
        + l.a * 0.45 * Math.sin(x * l.f * 1.7 + t * l.sp * 1.4);
      x === 0 ? _wCtx.moveTo(x, y) : _wCtx.lineTo(x, y);
    }
    _wCtx.lineTo(W, 0);
    _wCtx.lineTo(0, 0);
    _wCtx.closePath();
    _wCtx.fillStyle = l.fill;
    _wCtx.fill();
  });

  // ── Glowing amber edge line ────────────────────────────
  _wCtx.beginPath();
  for (let x = 0; x <= W; x++) {
    const y = wz * 0.78
      + 18 * Math.sin(x * 0.009 + t * 0.55)
      + 12 * Math.sin(x * 0.015 + t * 0.38 + 1.2);
    x === 0 ? _wCtx.moveTo(x, y) : _wCtx.lineTo(x, y);
  }
  _wCtx.strokeStyle = 'rgba(245,158,11,0.65)';
  _wCtx.lineWidth   = 1.5;
  _wCtx.shadowColor = 'rgba(245,158,11,0.9)';
  _wCtx.shadowBlur  = 10;
  _wCtx.stroke();
  _wCtx.shadowBlur  = 0;

  // ── Coral secondary sheen ──────────────────────────────
  _wCtx.beginPath();
  for (let x = 0; x <= W; x++) {
    const y = wz * 0.72
      + 10 * Math.sin(x * 0.011 + t * 0.45 + 0.8)
      +  7 * Math.sin(x * 0.019 + t * 0.70 + 2.1);
    x === 0 ? _wCtx.moveTo(x, y) : _wCtx.lineTo(x, y);
  }
  _wCtx.strokeStyle = 'rgba(251,146,60,0.25)';
  _wCtx.lineWidth   = 1;
  _wCtx.stroke();

  // ── Ripple circles (amber) ─────────────────────────────
const now = performance.now();
  _ripples = _ripples.filter(r => {
    const age = (now - r.t) / 1000;
    
    // NEW: If the ripple is scheduled for the future, keep it but don't draw it yet!
    if (age < 0) return true; 
    
    if (age > 1.2) return false; // Expired, remove it
    
    const radius = age * 75;
    const alpha  = Math.max(0, 0.7 - age * 0.6);
    _wCtx.beginPath();
    _wCtx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    _wCtx.strokeStyle = `rgba(245,158,11,${alpha})`;
    _wCtx.lineWidth   = 1.5;
    _wCtx.shadowColor = 'rgba(245,158,11,0.5)';
    _wCtx.shadowBlur  = 6;
    _wCtx.stroke();
    _wCtx.shadowBlur  = 0;
    return true;
  });
}

function _waveLoop() {
  _wTime += 0.014;
  _drawWave(_wTime);
  _wRAF = requestAnimationFrame(_waveLoop);
}

export function startWave(role) {
  _wRole = role;
  initWave();
  $('wave-layer').classList.add('active');
  _waveLoop();
}

export function stopWave() {
  if (_wRAF) { cancelAnimationFrame(_wRAF); _wRAF = null; }
  $('wave-layer').classList.remove('active');
  _ripples = [];
}

// ─────────────────────────────────────────────────────────
// Bloom Flash  (amber)
// ─────────────────────────────────────────────────────────

function spawnBloom(x, y) {
  const el = document.createElement('div');
  el.className = 'bloom-flash';
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 650);
}

// ─────────────────────────────────────────────────────────
// File Particle System — full-screen traversal
// ─────────────────────────────────────────────────────────

let _particleTimer   = null;
let _currentFileMeta = null;
let _particleRole    = null;

/**
 * Spawn a single glassmorphic file card and animate it.
 *
 * SENDER   — card starts BELOW the screen, floats upward and exits
 *             OFF THE TOP. Looks like files are leaving the device.
 *
 * RECEIVER — card starts ABOVE the screen, falls down and fades out
 *             near the bottom. Looks like files are arriving from above.
 *
 * NOTE: NO sound is played here. Sound is handled once by app.js.
 */
function _spawnParticle(filename, mime, role) {
  if (!window.gsap) return;

  const container = $('particles-container');
  const card      = document.createElement('div');
  card.className  = 'file-particle';

  const icon      = fileIcon(mime);
  const shortName = filename.length > 14 ? filename.slice(0, 12) + '…' : filename;
  card.innerHTML  = `<span class="fp-icon">${icon}</span><span class="fp-name">${shortName}</span>`;

  const W      = window.innerWidth;
  const startX = 40 + Math.random() * Math.max(0, W - 200);
  const driftX = (Math.random() - 0.5) * 80;

  if (role === 'send') {
    // ── SENDER: rise from below, exit off top ──────────────
    const startY = window.innerHeight + 60;    // below screen
    const travelY = -(startY + 160);           // move up past top edge
    const dur     = 2.3 + Math.random() * 0.9;

    card.style.cssText = `left:${startX}px; top:${startY}px; opacity:0;`;
    container.appendChild(card);

    window.gsap.timeline()
      .to(card, {
        opacity:  1,
        duration: 0.35,
      })
      .to(card, {
        y:        travelY,
        x:        driftX,
        duration: dur,
        ease:     'power1.inOut',
        onComplete: () => {
          // Leave a ripple on the wave surface as card passes through
          const sy = waveSurfaceY();
          _ripples.push({ x: startX + 60, y: sy, t: performance.now() });
          spawnBloom(startX + 60, sy);
          card.remove();
        },
      }, 0)
      .to(card, {
        opacity: 0,
        duration: 0.4,
      }, dur - 0.35);  // fade just before exiting screen

  } else {
    // ── RECEIVER: fall from above, drift down ──────────────
    const startY  = -120;                           // above screen
    const travelY = window.innerHeight + 100;        // fall to below screen
    const dur     = 2.5 + Math.random() * 0.9;

    card.style.cssText = `left:${startX}px; top:${startY}px; opacity:0; transform:scale(0.65)`;
    container.appendChild(card);

    // Emit an immediate ripple where the card "enters" at the wave surface
    const sy = waveSurfaceY();
    _ripples.push({ x: startX + 60, y: sy, t: performance.now() + 400 });

    window.gsap.timeline()
      .to(card, {
        opacity:  1,
        scale:    1,
        duration: 0.4,
        ease:     'back.out(1.8)',
      })
      .to(card, {
        y:        travelY,
        x:        driftX,
        duration: dur,
        ease:     'power1.in',
      }, 0)
      .to(card, {
        opacity:  0,
        duration: 0.5,
      }, dur - 0.45);  // fade before hitting bottom
  }
}

/** Start periodically spawning particles during a transfer */
function startParticles(filename, mime, role) {
  _currentFileMeta = { filename, mime };
  _particleRole    = role;
  stopParticles();
  _spawnParticle(filename, mime, role);
  _particleTimer = setInterval(() => {
    _spawnParticle(_currentFileMeta.filename, _currentFileMeta.mime, role);
  }, PARTICLE_INTERVAL);
}

/** Update the filename being visualised (for multi-file sends) */
export function updateParticleMeta(filename, mime) {
  _currentFileMeta = { filename, mime };
}

/** Stop spawning and clear the container */
function stopParticles() {
  clearInterval(_particleTimer);
  _particleTimer = null;
  $('particles-container').innerHTML = '';
}

// ─────────────────────────────────────────────────────────
// Bottom Transfer HUD
// ─────────────────────────────────────────────────────────

let _hudVisible = false;

export function showHUD() {
  const hud = $('transfer-hud');
  hud.classList.remove('hidden');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      hud.classList.add('visible');
      _hudVisible = true;
    });
  });
}

export function hideHUD() {
  const hud = $('transfer-hud');
  hud.classList.remove('visible');
  _hudVisible = false;
  setTimeout(() => hud.classList.add('hidden'), 700);
}

export function updateHUD({ speed, eta, pct }) {
  $('hud-speed').textContent = speed;
  $('hud-eta').textContent   = eta;
  $('hud-pct').textContent   = pct + '%';

  const offset = CIRCUMFERENCE * (1 - pct / 100);
  $('hud-ring-fill').style.strokeDashoffset = offset.toFixed(2);
}

// ─────────────────────────────────────────────────────────
// Send View
// ─────────────────────────────────────────────────────────

export function showRoomCode(code) {
  $('code-display').textContent = code;
}

export function showSendConnected() {
  $('send-status-dot').className    = 'status-dot connected';
  $('send-status-text').textContent = 'Connected — drop files below ↓';
  const section = $('send-connected-section');
  section.classList.remove('hidden');
  section.style.display = 'flex';
  haptic(50);
  playConnectSound();
}

export function showSendProgress() {
  $('send-progress').classList.remove('hidden');
  $('send-complete').classList.add('hidden');
  _lastSendUpdate = 0;
  showHUD();
  if (!$('wave-layer').classList.contains('active')) startWave('send');
  if (_particleRole !== 'send') startParticles('file', '', 'send');
}

export function updateSendProgress({ pct, speed, eta, filename, fileIndex, fileTotal, isLastChunk }) {
  const now = performance.now();
  if (!isLastChunk && now - _lastSendUpdate < UPDATE_INTERVAL) return;
  _lastSendUpdate = now;

  updateParticleMeta(filename, '');

  requestAnimationFrame(() => {
    $('send-prog-name').textContent  = filename;
    $('send-prog-count').textContent = `File ${fileIndex + 1} of ${fileTotal}`;
    $('send-prog-fill').style.width  = pct + '%';
    $('send-prog-pct').textContent   = pct + '%';
    $('send-prog-speed').textContent = speed;
    $('send-prog-eta').textContent   = eta;
    updateHUD({ speed, eta, pct });
  });
}

export function showSendComplete() {
  $('send-progress').classList.add('hidden');
  $('send-complete').classList.remove('hidden');
  stopParticles();
  stopWave();
  hideHUD();
  playSuccessSound();
  haptic([60, 40, 120]);
}

// ─────────────────────────────────────────────────────────
// Receive View
// ─────────────────────────────────────────────────────────

export function showConnecting() {
  $('receive-enter-section').classList.add('hidden');
  $('receive-connecting').classList.remove('hidden');
}

export function showEnterCode() {
  $('receive-connecting').classList.add('hidden');
  $('receive-enter-section').classList.remove('hidden');
}

export function showReceiveConnected() {
  $('receive-connecting').classList.add('hidden');
  const section = $('receive-connected-section');
  section.classList.remove('hidden');
  section.style.display = 'flex';
  haptic(50);
  playConnectSound();
}

export function showReceiveProgress(meta) {
  $('receive-idle').classList.add('hidden');
  $('receive-progress').classList.remove('hidden');
  $('recv-prog-name').textContent  = meta.name;
  $('recv-prog-size').textContent  = formatBytes(meta.size);
  $('recv-prog-fill').style.width  = '0%';
  $('recv-prog-pct').textContent   = '0%';
  $('recv-prog-speed').textContent = '—';
  $('recv-prog-eta').textContent   = '—';
  _lastRecvUpdate = 0;

  showHUD();
  if (!$('wave-layer').classList.contains('active')) startWave('receive');
  startParticles(meta.name, meta.mimeType || '', 'receive');
}

export function updateReceiveProgress({ pct, speed, eta, isLastChunk }) {
  const now = performance.now();
  if (!isLastChunk && now - _lastRecvUpdate < UPDATE_INTERVAL) return;
  _lastRecvUpdate = now;

  requestAnimationFrame(() => {
    $('recv-prog-fill').style.width  = pct + '%';
    $('recv-prog-pct').textContent   = pct + '%';
    $('recv-prog-speed').textContent = speed;
    $('recv-prog-eta').textContent   = eta;
    updateHUD({ speed, eta, pct });
  });
}

export function hideReceiveProgress() {
  $('receive-progress').classList.add('hidden');
  $('receive-idle').classList.remove('hidden');
  stopParticles();
  stopWave();
  hideHUD();
  playSuccessSound();
  haptic([60, 40, 120]);
}

export function addReceivedFile(blob, meta) {
  $('receive-idle').classList.add('hidden');
  const url  = URL.createObjectURL(blob);
  const item = document.createElement('div');
  item.className = 'received-item';
  item.innerHTML = `
    <div class="received-item-info">
      <span class="received-item-icon">${fileIcon(meta.mimeType)}</span>
      <div style="min-width:0;">
        <div class="received-item-name">${escapeHTML(meta.name)}</div>
        <div class="received-item-size">${formatBytes(meta.size)}</div>
      </div>
    </div>
    <a href="${url}" download="${escapeHTML(meta.name)}" class="btn-download">↓ Save</a>
  `;
  $('received-list').appendChild(item);
}

// ─────────────────────────────────────────────────────────
// Code Inputs
// ─────────────────────────────────────────────────────────

export function setupCodeInputs({ onChange, onSubmit }) {
  const inputs = ['ci0', 'ci1', 'ci2', 'ci3'].map(id => $(id));

  function getCode() { return inputs.map(x => x.value).join(''); }

  inputs.forEach((inp, i) => {
    inp.addEventListener('input', e => {
      let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');

      if (val.length > 1) {
        const chars = val.slice(0, 4).split('');
        chars.forEach((ch, j) => {
          if (inputs[j]) {
            inputs[j].value = ch;
            inputs[j].classList.toggle('filled', !!ch);
          }
        });
        inputs[Math.min(chars.length - 1, 3)].focus();
        onChange(getCode());
        return;
      }
      inp.value = val;
      inp.classList.toggle('filled', !!val);
      if (val && i < 3) inputs[i + 1].focus();
      onChange(getCode());
    });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !inp.value && i > 0) {
        inputs[i - 1].focus();
        inputs[i - 1].value = '';
        inputs[i - 1].classList.remove('filled');
        onChange(getCode());
      }
      if (e.key === 'Enter') onSubmit();
    });

    inp.addEventListener('focus', () => inp.select());
  });

  return {
    getCode,
    setCode(code) {
      code.split('').forEach((ch, j) => {
        if (inputs[j]) { inputs[j].value = ch; inputs[j].classList.add('filled'); }
      });
      onChange(getCode());
    },
    reset() {
      inputs.forEach(x => { x.value = ''; x.classList.remove('filled'); });
      onChange('');
    },
    focus() { inputs[0]?.focus(); },
  };
}

// ─────────────────────────────────────────────────────────
// Clipboard
// ─────────────────────────────────────────────────────────

export function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text)
    .then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      haptic(30);
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    })
    .catch(() => showToast('Clipboard unavailable'));
}

// ─────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────

export function resetSendUI() {
  $('code-display').textContent     = '····';
  $('send-status-dot').className    = 'status-dot waiting';
  $('send-status-text').textContent = 'Waiting for receiver...';
  $('qr-container').innerHTML       = '';
  $('send-connected-section').classList.add('hidden');
  $('send-progress').classList.add('hidden');
  $('send-complete').classList.add('hidden');
  stopParticles();
  stopWave();
  hideHUD();
}

export function resetReceiveUI() {
  $('receive-enter-section').classList.remove('hidden');
  $('receive-connecting').classList.add('hidden');
  $('receive-connected-section').classList.add('hidden');
  $('receive-idle').classList.remove('hidden');
  $('receive-progress').classList.add('hidden');
  $('received-list').innerHTML = '';
  stopParticles();
  stopWave();
  hideHUD();
}

// ─────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initCursorLighting();

  document.addEventListener('touchmove', e => {
    const t     = e.touches[0];
    const angle = Math.atan2(t.clientY - window.innerHeight / 2, t.clientX - window.innerWidth / 2);
    const dx    = (Math.cos(angle) * 8).toFixed(2);
    const dy    = (Math.sin(angle) * 8).toFixed(2);
    document.documentElement.style.setProperty('--neu-dx', `${dx}px`);
    document.documentElement.style.setProperty('--neu-dy', `${dy}px`);
  }, { passive: true });

  // Unlock AudioContext on first user gesture
  const unlockAudio = () => {
    const ctx = getAudioCtx();
    if (ctx?.state === 'suspended') ctx.resume();
    document.removeEventListener('pointerdown', unlockAudio);
  };
  document.addEventListener('pointerdown', unlockAudio);

  // Start preloading the whoosh MP3 early
  _preloadWhoosh();
});