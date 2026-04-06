/**
 * RippleDrop — Application Entry Point  (app.js)
 *
 * Responsibilities:
 * - Socket.io connection & room management
 * - Orchestrating peer.js (WebRTC) ↔ ui.js (DOM)
 * - File send/receive pipeline
 * - URL-based auto-join (/join/:code)
 */

import { RipplePeer } from './peer.js';
import * as UI from './ui.js';

// ─────────────────────────────────────────────────────────
// App state
// ─────────────────────────────────────────────────────────

let socket      = null;
let peer        = null;
let role        = null;  // 'host' | 'guest'
let roomCode    = null;
let codeCtrl    = null;  // returned by UI.setupCodeInputs
let currentCode = '';    // live value from code inputs

// ─────────────────────────────────────────────────────────
// Socket management
// ─────────────────────────────────────────────────────────

function connectSocket() {
  if (socket?.connected) return;

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect_error', () => {
    UI.showToast('Cannot reach the server. Is it running?');
  });

  socket.on('peer-joined', async () => {
    console.log('[App] Peer joined — creating WebRTC offer');
    peer = makePeer('host');
    await peer.init();
  });

  socket.on('signal', async ({ signal }) => {
    if (!peer) {
      peer = makePeer('guest');
      await peer.init();
    }
    await peer.handleSignal(signal);
  });

  socket.on('peer-disconnected', () => {
    UI.showToast('The other device disconnected.', 'error');
    resetAll();
    UI.showView('view-home');
  });
}

function makePeer(r) {
  return new RipplePeer({
    role: r,
    socket,
    callbacks: {
      onOpen:          onPeerOpen,
      onClose:         () => {},
      onError:         msg => UI.showToast(msg, 'error'),
      onFileMeta:      onFileMeta,
      onChunkReceived: onChunkReceived,
      onFileDone:      onFileDone,
    },
  });
}

// ─────────────────────────────────────────────────────────
// Peer event handlers
// ─────────────────────────────────────────────────────────

function onPeerOpen() {
  console.log('[App] DataChannel open — role:', role);
  if (role === 'host') {
    UI.showSendConnected();
  } else {
    UI.showReceiveConnected();
  }
}

function onFileMeta(meta) {
  console.log('[Recv] Incoming:', meta.name, '—', meta.size, 'bytes');
  UI.showReceiveProgress(meta);
}

// Fixed UI passing values (bytes instead of chunks)
function onChunkReceived({ receivedBytes, totalBytes, speed, meta }) {
  const pct         = Math.round((receivedBytes / totalBytes) * 100);
  const isLastChunk = receivedBytes >= totalBytes;
  
  UI.updateReceiveProgress({
    pct,
    speed:       speed.formatSpeed(),
    eta:         speed.formatETA(totalBytes, receivedBytes),
    isLastChunk,
  });
}

function onFileDone(blob, meta) {
  console.log('[Recv] Complete:', meta.name);
  UI.hideReceiveProgress();
  UI.addReceivedFile(blob, meta);
  triggerDownload(blob, meta.name);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), {
    href: url,
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ─────────────────────────────────────────────────────────
// Sender flow
// ─────────────────────────────────────────────────────────

async function startSending() {
  connectSocket();
  socket.emit('create-room', ({ code }) => {
    role     = 'host';
    roomCode = code;
    UI.showView('view-send');
    UI.showRoomCode(code);
    UI.generateQR(UI.$('qr-container'), `${location.origin}/join/${code}`);
  });
}

async function handleFiles(files) {
  if (!files?.length) return;
  if (!peer) {
    UI.showToast('No peer connected yet.', 'error');
    return;
  }

  UI.playWhoosh();
  UI.showSendProgress();

  // Fixed sending side passing values (bytes instead of chunks)
  await peer.sendFiles(Array.from(files), progress => {
    const { sentBytes, totalBytes, speed, meta, fileIndex, fileTotal, isLastChunk } = progress;
    const pct = Math.round((sentBytes / totalBytes) * 100);

    UI.updateSendProgress({
      pct,
      speed:      speed.formatSpeed(),
      eta:        speed.formatETA(totalBytes, sentBytes),
      filename:   meta.name,
      fileIndex,
      fileTotal,
      isLastChunk,
    });
  });

  UI.showSendComplete();
}

// ─────────────────────────────────────────────────────────
// Receiver flow
// ─────────────────────────────────────────────────────────

function startReceiving() {
  UI.showView('view-receive');
  setTimeout(() => codeCtrl?.focus(), 100);
}

async function joinRoom(code) {
  connectSocket();
  role = 'guest';
  UI.showConnecting();

  socket.emit('join-room', { code }, ({ success, error }) => {
    if (error) {
      UI.showEnterCode();
      UI.showToast(error, 'error');
      return;
    }
    roomCode = code;
    console.log('[App] Joined room:', code, '— awaiting WebRTC signals');
  });
}

// ─────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────

function resetAll() {
  peer?.close();
  peer = null;
  if (socket) { socket.disconnect(); socket = null; }
  role        = null;
  roomCode    = null;
  currentCode = '';
  codeCtrl?.reset();
  UI.resetSendUI();
  UI.resetReceiveUI();
}

// ─────────────────────────────────────────────────────────
// URL-based auto-join: /join/:code
// ─────────────────────────────────────────────────────────

function checkJoinURL() {
  const match = location.pathname.match(/^\/join\/([A-Z0-9]{4})$/i);
  if (!match) return;

  const code = match[1].toUpperCase();
  console.log('[App] Auto-joining from URL:', code);

  UI.showView('view-receive');
  codeCtrl?.setCode(code);

  setTimeout(() => joinRoom(code), 500);
}

// ─────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  codeCtrl = UI.setupCodeInputs({
    onChange:  code => {
      currentCode = code;
      UI.$('btn-join').disabled = code.length < 4;
    },
    onSubmit: () => {
      if (currentCode.length >= 4) joinRoom(currentCode.toUpperCase());
    },
  });

  UI.$('btn-send').addEventListener('click', startSending);
  UI.$('btn-receive').addEventListener('click', startReceiving);

  UI.$('back-from-send').addEventListener('click', () => {
    resetAll();
    UI.showView('view-home');
  });
  UI.$('back-from-receive').addEventListener('click', () => {
    resetAll();
    UI.showView('view-home');
  });

  UI.$('btn-copy-code').addEventListener('click', () => {
    if (roomCode) UI.copyToClipboard(roomCode, UI.$('btn-copy-code'));
  });
  UI.$('btn-copy-link').addEventListener('click', () => {
    if (roomCode) {
      UI.copyToClipboard(`${location.origin}/join/${roomCode}`, UI.$('btn-copy-link'));
    }
  });

  const dropZone  = UI.$('drop-zone');
  const fileInput = UI.$('file-input');

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('click', e => {
    if (e.target !== UI.$('btn-choose-files')) fileInput.click();
  });
  UI.$('btn-choose-files').addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener('change', e => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  UI.$('btn-join').addEventListener('click', () => {
    if (currentCode.length >= 4) joinRoom(currentCode.toUpperCase());
  });

  checkJoinURL();
});