// Stockfish Worker Wrapper for Chrome Extension
// Receives WASM URL via first message, then loads Stockfish

console.log('sf-worker.js loaded');
self.postMessage('sf-worker: loaded');

let stockfish = null;
let wasmUrl = null;
let pendingMessages = [];

self.onmessage = function(e) {
  const data = e.data;
  console.log('sf-worker received:', data);

  // First message is init with WASM URL
  if (typeof data === 'object' && data.type === 'init') {
    wasmUrl = data.wasmUrl;
    console.log('sf-worker: Init with WASM URL:', wasmUrl);
    loadStockfish();
    return;
  }

  // UCI commands (strings)
  if (typeof data === 'string') {
    if (stockfish) {
      stockfish.postMessage(data, true);
    } else {
      pendingMessages.push(data);
    }
  }
};

function loadStockfish() {
  try {
    console.log('sf-worker: Loading stockfish.js...');
    importScripts('stockfish.js');

    console.log('sf-worker: STOCKFISH type:', typeof STOCKFISH);

    if (typeof STOCKFISH !== 'function') {
      throw new Error('STOCKFISH is not a function');
    }

    // Create Stockfish instance with WASM path
    stockfish = STOCKFISH(wasmUrl);

    stockfish.onmessage = function(line) {
      self.postMessage(line);
    };

    console.log('sf-worker: Stockfish created');
    console.log('sf-worker: Pending messages:', pendingMessages.length, pendingMessages);

    // Send pending messages
    pendingMessages.forEach(msg => {
      console.log('sf-worker: Sending pending:', msg);
      stockfish.postMessage(msg, true);
    });
    pendingMessages = [];

    // Also send uci directly to make sure
    console.log('sf-worker: Sending uci command');
    stockfish.postMessage('uci', true);

  } catch (err) {
    console.error('sf-worker: Error:', err);
    self.postMessage('error: ' + err.message);
  }
}
