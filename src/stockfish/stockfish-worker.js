// Stockfish Worker Wrapper
// Nhận message từ content script và chuyển đổi giữa format của chúng ta và UCI protocol

let isReady = false;
let pendingAnalysis = null;
let currentAnalysis = null;

// Tạo nested worker chạy stockfish
let stockfishWorker = null;

function initStockfish() {
  try {
    // Lấy URL của stockfish.min.js
    const stockfishUrl = self.location.href.replace(
      'src/stockfish/stockfish-worker.js',
      'lib/stockfish.min.js'
    );

    // Tạo worker từ stockfish.min.js
    // Stockfish sẽ tự tìm .wasm file cùng thư mục
    stockfishWorker = new Worker(stockfishUrl);

    stockfishWorker.onmessage = function(e) {
      handleStockfishOutput(e.data);
    };

    stockfishWorker.onerror = function(e) {
      console.error('Stockfish worker error:', e);
      postMessage({ type: 'ERROR', error: e.message || 'Worker error' });
    };

    // Initialize UCI
    stockfishWorker.postMessage('uci');

  } catch (error) {
    console.error('Failed to init Stockfish:', error);
    postMessage({ type: 'ERROR', error: error.message });
  }
}

// Handle Stockfish UCI output
function handleStockfishOutput(line) {
  if (typeof line !== 'string') return;

  console.log('SF:', line);

  if (line === 'uciok') {
    // Set options
    stockfishWorker.postMessage('setoption name Threads value 1');
    stockfishWorker.postMessage('setoption name Hash value 64');
    stockfishWorker.postMessage('isready');
  }

  if (line === 'readyok') {
    isReady = true;
    postMessage({ type: 'READY' });

    // Process pending analysis
    if (pendingAnalysis) {
      analyze(pendingAnalysis);
      pendingAnalysis = null;
    }
  }

  // Parse info lines for evaluation
  if (line.startsWith('info') && line.includes('score')) {
    parseInfoLine(line);
  }

  // Best move found
  if (line.startsWith('bestmove')) {
    const parts = line.split(' ');
    const bestMove = parts[1];
    const ponderMove = parts[3] || null;

    if (currentAnalysis) {
      postMessage({
        type: 'RESULT',
        requestId: currentAnalysis.requestId,
        bestMove: bestMove,
        ponderMove: ponderMove,
        evaluation: currentAnalysis.evaluation,
        topMoves: currentAnalysis.topMoves || []
      });
      currentAnalysis = null;
    }
  }
}

// Parse info line để lấy evaluation
function parseInfoLine(line) {
  if (!currentAnalysis) return;

  const depthMatch = line.match(/depth (\d+)/);
  const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
  const pvMatch = line.match(/pv (.+)/);
  const multipvMatch = line.match(/multipv (\d+)/);

  if (scoreMatch) {
    const scoreType = scoreMatch[1];
    const scoreValue = parseInt(scoreMatch[2]);

    let evaluation;
    if (scoreType === 'mate') {
      evaluation = scoreValue > 0 ? `M${scoreValue}` : `M${scoreValue}`;
    } else {
      evaluation = scoreValue;
    }

    const depth = depthMatch ? parseInt(depthMatch[1]) : 0;
    const pv = pvMatch ? pvMatch[1].split(' ')[0] : null;
    const multipv = multipvMatch ? parseInt(multipvMatch[1]) : 1;

    if (multipv === 1) {
      currentAnalysis.evaluation = evaluation;
      currentAnalysis.depth = depth;
    }

    // Track top moves
    if (pv && depth >= currentAnalysis.targetDepth - 2) {
      if (!currentAnalysis.topMoves) {
        currentAnalysis.topMoves = [];
      }

      const existingIndex = currentAnalysis.topMoves.findIndex(m => m.move === pv);
      if (existingIndex >= 0) {
        currentAnalysis.topMoves[existingIndex] = { move: pv, eval: evaluation, depth };
      } else if (currentAnalysis.topMoves.length < 5) {
        currentAnalysis.topMoves.push({ move: pv, eval: evaluation, depth });
      }
    }

    // Send progress update
    postMessage({
      type: 'PROGRESS',
      requestId: currentAnalysis.requestId,
      depth: depth,
      evaluation: evaluation
    });
  }
}

// Analyze position
function analyze({ fen, depth, requestId }) {
  if (!isReady || !stockfishWorker) {
    pendingAnalysis = { fen, depth, requestId };
    return;
  }

  // Stop previous analysis
  stockfishWorker.postMessage('stop');

  currentAnalysis = {
    requestId,
    targetDepth: depth,
    evaluation: 0,
    topMoves: []
  };

  // Set position and go
  stockfishWorker.postMessage('ucinewgame');
  stockfishWorker.postMessage(`position fen ${fen}`);
  stockfishWorker.postMessage(`go depth ${depth}`);
}

// Stop analysis
function stopAnalysis() {
  if (stockfishWorker) {
    stockfishWorker.postMessage('stop');
  }
  currentAnalysis = null;
}

// Handle messages from main thread
onmessage = function(e) {
  const { type, ...data } = e.data;

  switch (type) {
    case 'INIT':
      initStockfish();
      break;
    case 'ANALYZE':
      analyze(data);
      break;
    case 'STOP':
      stopAnalysis();
      break;
  }
};

// Auto-init
initStockfish();
