// Offscreen document - chạy Stockfish trong Web Worker
// Mỗi lệnh phân tích có id + tabId; output được gắn id để content script bỏ qua kết quả cũ.

let worker = null;
let isReady = false;
let searching = false;
let current = null;   // { id, tabId, stopped }
let pending = null;   // request chờ chạy (engine chưa sẵn sàng hoặc đang dừng search cũ)
const readyWaiters = new Set();

function send(msg) {
  chrome.runtime.sendMessage(Object.assign({ source: 'offscreen' }, msg)).catch(() => {});
}

function cmd(c) {
  if (worker) worker.postMessage(c);
}

function resetWorker() {
  try { if (worker) worker.terminate(); } catch (e) {}
  worker = null;
  isReady = false;
  searching = false;
  current = null;
}

function initStockfish() {
  if (worker) {
    if (isReady) flushReady();
    return;
  }
  try {
    worker = new Worker(chrome.runtime.getURL('lib/sf-worker.js'));
    worker.onmessage = (e) => onLine(e.data);
    worker.onerror = (e) => {
      console.error('Stockfish worker error:', e.message);
      const tabs = [...readyWaiters, current && current.tabId].filter((t) => t != null);
      resetWorker();
      tabs.forEach((tabId) => send({ type: 'SF_ERROR', tabId, error: e.message || 'Worker crashed' }));
    };
    worker.postMessage({ type: 'init', wasmUrl: chrome.runtime.getURL('lib/stockfish.wasm') });
    cmd('uci');
  } catch (err) {
    console.error('Failed to create worker:', err);
    resetWorker();
  }
}

function flushReady() {
  readyWaiters.forEach((tabId) => send({ type: 'SF_READY', tabId }));
  readyWaiters.clear();
}

function start(req) {
  current = { id: req.id, tabId: req.tabId, stopped: false };
  searching = true;
  cmd('setoption name MultiPV value ' + Math.max(1, Math.min(5, req.multipv || 1)));
  cmd('position fen ' + req.fen);
  cmd('go depth ' + req.depth);
}

function analyze(req) {
  if (!isReady) {
    pending = req;
    initStockfish();
    return;
  }
  if (searching) {
    // Dừng search cũ, chạy request mới khi nhận bestmove của search cũ
    pending = req;
    if (current) current.stopped = true;
    cmd('stop');
    return;
  }
  start(req);
}

function onLine(line) {
  if (typeof line !== 'string') return;

  if (line.includes('uciok')) {
    cmd('isready');
    return;
  }
  if (line.includes('readyok')) {
    if (!isReady) {
      isReady = true;
      flushReady();
      if (pending) { const p = pending; pending = null; start(p); }
    }
    return;
  }

  if (line.startsWith('info') && line.includes(' pv ') && current && !current.stopped) {
    send({ type: 'SF_OUTPUT', id: current.id, tabId: current.tabId, line });
    return;
  }

  if (line.startsWith('bestmove')) {
    searching = false;
    const finished = current;
    current = null;
    if (pending) {
      const p = pending; pending = null; start(p);
      return; // bestmove của search đã hủy -> bỏ
    }
    if (finished && !finished.stopped) {
      send({ type: 'SF_OUTPUT', id: finished.id, tabId: finished.tabId, line });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'SF_INIT':
      if (message.tabId != null) readyWaiters.add(message.tabId);
      initStockfish();
      break;
    case 'SF_ANALYZE':
      analyze(message);
      break;
    case 'SF_STOP':
      pending = null;
      if (searching && current) {
        current.stopped = true;
        cmd('stop');
      }
      break;
  }
  sendResponse({ ok: true });
});

initStockfish();
