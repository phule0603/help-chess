// Chess Helper - Content Script
// Đọc bàn cờ từ chess.com và hiển thị gợi ý nước đi.
// Brilliant mode: tìm nước "!!" (hy sinh quân đúng) - chỉ hoạt động khi chơi với máy / phân tích.

(function () {
  'use strict';

  const C = window.ChessCore;
  const BD = window.BrilliantDetector;

  // ============ STATE ============

  let isEnabled = true;
  let brilliantMode = false;
  let brilliantDepth = 18;
  let currentFen = '';
  let analysisDepth = getRandomDepth();
  let playerColor = 'white';
  let panel = null;
  let engineReady = false;
  let analysisSeq = 0;
  let currentAnalysis = null; // { id, fen, depth, brilliant, lines: {multipv: info} }
  let turnCache = { placement: null, turn: null };

  function getRandomDepth() {
    return Math.floor(Math.random() * 6) + 10; // 10-15
  }

  const PIECE_MAP = {
    'wp': 'P', 'wn': 'N', 'wb': 'B', 'wr': 'R', 'wq': 'Q', 'wk': 'K',
    'bp': 'p', 'bn': 'n', 'bb': 'b', 'br': 'r', 'bq': 'q', 'bk': 'k'
  };

  // ============ PAGE TYPE ============

  // 'analysis' | 'computer' | 'other'
  function getPageMode() {
    const p = location.pathname.replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/i, '');
    if (/^\/(analysis|game-review)(\/|$)/.test(p)) return 'analysis';
    if (/^\/play\/computer(\/|$)/.test(p) || /^\/game\/computer\//.test(p)) return 'computer';
    return 'other';
  }

  const brilliantAllowed = () => getPageMode() !== 'other';
  const brilliantActive = () => brilliantMode && brilliantAllowed();

  // ============ ENGINE ============

  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
      return true;
    } catch (err) {
      updatePanel({ status: 'Extension reloaded - refresh page' });
      return false;
    }
  }

  function initStockfish() {
    if (send({ type: 'SF_INIT' })) updatePanel({ status: 'Loading engine...' });
  }

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'SF_READY':
        engineReady = true;
        if (!currentAnalysis) updatePanel({ status: 'Engine ready' });
        break;
      case 'SF_OUTPUT':
        if (currentAnalysis && message.id === currentAnalysis.id) handleUCIOutput(message.line);
        break;
      case 'SF_ERROR':
        console.error('Chess Helper engine error:', message.error);
        currentAnalysis = null;
        currentFen = '';
        updatePanel({ status: 'Engine error: ' + message.error });
        break;
      case 'TOGGLE':
        setEnabled(message.enabled);
        break;
      case 'SET_DEPTH':
        analysisDepth = Math.max(10, Math.min(20, message.depth));
        syncDepthSlider();
        if (isEnabled) { currentFen = ''; analyzePosition(); }
        break;
    }
  });

  function handleUCIOutput(line) {
    const a = currentAnalysis;
    if (!a) return;

    const info = BD.parseInfo(line);
    if (info) {
      engineReady = true;
      if (!info.bound) a.lines[info.multipv] = info;
      if (info.multipv === 1) {
        updatePanel({ status: `${a.brilliant ? 'Brilliant search' : 'Depth'} ${info.depth}/${a.depth}...` });
      }
      return;
    }

    if (!line.startsWith('bestmove')) return;
    const bestMove = line.split(' ')[1];
    currentAnalysis = null;

    if (!a.brilliant) {
      analysisDepth = getRandomDepth();
      syncDepthSlider();
    }

    clearArrows();
    if (!bestMove || bestMove === '(none)') {
      updatePanel({ bestMove: '-', eval: '-', moves: [], status: 'No legal moves', brilliant: null });
      return;
    }

    const lines = Object.values(a.lines).sort((x, y) => x.multipv - y.multipv);
    const top = lines[0] || { move: bestMove, score: { type: 'cp', value: 0 } };

    let result = null;
    if (a.brilliant) {
      try {
        result = BD.classify(a.fen, lines);
      } catch (err) {
        console.error('Brilliant classify failed:', err);
      }
    }

    const special = result && (result.brilliant || result.great);
    const svg = createArrowLayer();
    if (svg) {
      lines.slice(1, 3).forEach((l) => {
        if (!special || l.move !== special.move) drawArrow(svg, l.move, 'alt');
      });
      if (!special || special.move !== bestMove) drawArrow(svg, bestMove, 'best');
      if (special) {
        drawArrow(svg, special.move, special.type);
        drawBadge(svg, special.move.slice(2, 4), special.type === 'brilliant' ? '!!' : '!', special.type);
      }
    }

    updatePanel({
      bestMove: formatMove(bestMove),
      eval: formatScore(top.score),
      moves: lines.slice(0, 3).map((l) => ({ move: formatMove(l.move), eval: formatScore(l.score) })),
      status: a.brilliant ? `Done (d${a.depth})` : `Ready (next: d${analysisDepth})`,
      brilliant: a.brilliant ? (result || { brilliant: null, great: null }) : null
    });
  }

  function doAnalyze(fen, depth, brilliant) {
    currentAnalysis = { id: ++analysisSeq, fen, depth, brilliant, lines: {} };
    if (!engineReady) updatePanel({ status: 'Loading engine...' });
    send({
      type: 'SF_ANALYZE',
      id: currentAnalysis.id,
      fen,
      depth,
      multipv: brilliant ? 5 : 3
    });
  }

  function stopAnalysis() {
    if (currentAnalysis) send({ type: 'SF_STOP' });
    currentAnalysis = null;
  }

  // ============ BOARD READING ============

  function findBoard() {
    return document.querySelector('wc-chess-board, chess-board, .board');
  }

  // "square-14" -> index (a4 = 24)
  function squareFromEl(el) {
    for (const cls of el.classList) {
      const m = cls.match(/^square-(\d)(\d)$/);
      if (m) {
        const file = parseInt(m[1], 10) - 1;
        const rank = parseInt(m[2], 10) - 1;
        if (file >= 0 && file < 8 && rank >= 0 && rank < 8) return rank * 8 + file;
      }
    }
    return -1;
  }

  function readBoardArray(board) {
    const arr = new Array(64).fill(null);
    board.querySelectorAll('.piece').forEach((el) => {
      if (el.classList.contains('dragging')) return;
      let piece = null;
      for (const cls of el.classList) if (PIECE_MAP[cls]) piece = PIECE_MAP[cls];
      const sq = squareFromEl(el);
      if (piece && sq >= 0) arr[sq] = piece;
    });
    return arr;
  }

  function getHighlightSquares(board) {
    const set = new Set();
    board.querySelectorAll('.highlight').forEach((el) => {
      const sq = squareFromEl(el);
      if (sq >= 0) set.add(sq);
    });
    return [...set];
  }

  // Đọc DOM -> FEN đầy đủ (lượt đi, quyền nhập thành, bắt tốt qua đường)
  function getBoardFen() {
    const board = findBoard();
    if (!board) return null;
    const arr = readBoardArray(board);
    const highlights = getHighlightSquares(board);
    const turn = detectTurn(arr, highlights);
    const pos = {
      board: arr,
      turn,
      castling: C.inferCastling(arr),
      ep: detectEnPassant(arr, highlights, turn),
      halfmove: 0,
      fullmove: 1
    };
    const error = C.validatePosition(pos);
    if (error) return { error };
    return { fen: C.toFen(pos), turn };
  }

  function colorFromLastMove(arr, highlights) {
    if (!highlights.length || highlights.length > 4) return null;
    const colors = new Set(highlights.map((sq) => C.colorOf(arr[sq])).filter(Boolean));
    return colors.size === 1 ? [...colors][0] : null;
  }

  function detectTurn(arr, highlights) {
    const placement = C.placementOf(arr);
    let turn = null;

    // 1. Đồng hồ đang chạy (ván có giờ)
    const active = document.querySelector('.clock-component.clock-player-turn, .clock-player-turn');
    if (active) {
      if (active.classList.contains('clock-white')) turn = 'w';
      else if (active.classList.contains('clock-black')) turn = 'b';
      else if (active.classList.contains('clock-bottom')) turn = playerColor === 'white' ? 'w' : 'b';
      else if (active.classList.contains('clock-top')) turn = playerColor === 'white' ? 'b' : 'w';
    }

    // 2. Ô highlight nước vừa đi: quân đứng ở đó là bên vừa đi
    if (!turn) {
      const mover = colorFromLastMove(arr, highlights);
      if (mover) turn = C.opposite(mover);
    }

    // 3. Nước đang chọn trong move list
    if (!turn) {
      const sel = document.querySelector('.node .selected, .node.selected, [data-ply].selected');
      const node = sel && sel.closest('[data-ply], .node');
      if (node) {
        if (node.classList.contains('white-move')) turn = 'b';
        else if (node.classList.contains('black-move')) turn = 'w';
        else if (node.dataset.ply) turn = parseInt(node.dataset.ply, 10) % 2 === 1 ? 'b' : 'w';
      }
    }

    // 4. Không chắc chắn: giữ kết quả cũ nếu thế cờ chưa đổi (vd. đang chọn quân), không thì trắng đi
    if (!turn) turn = turnCache.placement === placement && turnCache.turn ? turnCache.turn : 'w';

    turnCache = { placement, turn };
    return turn;
  }

  function detectEnPassant(arr, highlights, turn) {
    const mover = C.opposite(turn);
    const pawn = mover === 'w' ? 'P' : 'p';
    for (const to of highlights) {
      if (arr[to] !== pawn) continue;
      const from = to + (mover === 'w' ? -16 : 16);
      const mid = (from + to) / 2;
      if (from >= 0 && from < 64 && highlights.includes(from) && !arr[from] && !arr[mid] &&
          C.rankOf(to) === (mover === 'w' ? 3 : 4)) {
        return mid;
      }
    }
    return null;
  }

  function detectPlayerColor() {
    const board = findBoard();
    if (!board) return 'white';
    if (board.classList.contains('flipped')) return 'black';
    if (board.hasAttribute('is-flipped') || board.getAttribute('data-flipped') === 'true') return 'black';

    // Đối chiếu vị trí hiển thị của các quân với ô của chúng (thay cho heuristic vị trí vua cũ,
    // vốn sai khi vua trắng lên nửa trên bàn cờ trong tàn cuộc)
    const br = board.getBoundingClientRect();
    if (br.height < 10) return playerColor;
    let normal = 0, flipped = 0;
    board.querySelectorAll('.piece').forEach((el) => {
      const sq = squareFromEl(el);
      if (sq < 0) return;
      const r = el.getBoundingClientRect();
      const row = Math.floor(((r.top + r.height / 2) - br.top) / br.height * 8);
      if (row === 7 - C.rankOf(sq)) normal++;
      else if (row === C.rankOf(sq)) flipped++;
    });
    if (normal === flipped) return playerColor;
    return flipped > normal ? 'black' : 'white';
  }

  // ============ UI PANEL ============

  function createPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'chess-helper-panel';
    panel.innerHTML = `
      <div class="ch-header">
        <span class="ch-title">Chess Helper</span>
        <label class="ch-toggle">
          <input type="checkbox" id="ch-enabled" checked>
          <span class="ch-slider"></span>
        </label>
      </div>
      <div class="ch-content">
        <div class="ch-section">
          <div class="ch-label">Best Move</div>
          <div class="ch-best-move" id="ch-best-move">-</div>
        </div>
        <div class="ch-section">
          <div class="ch-label">Evaluation</div>
          <div class="ch-eval" id="ch-eval">0.0</div>
        </div>
        <div class="ch-section">
          <div class="ch-label">Top Moves</div>
          <div class="ch-moves-list" id="ch-moves-list">
            <div class="ch-move-item">-</div>
          </div>
        </div>
        <div class="ch-section ch-brilliant-section">
          <div class="ch-row">
            <span class="ch-label ch-label-inline">Brilliant mode <span class="ch-bang">!!</span></span>
            <label class="ch-toggle ch-toggle-brilliant">
              <input type="checkbox" id="ch-brilliant">
              <span class="ch-slider"></span>
            </label>
          </div>
          <div id="ch-brilliant-body" class="ch-brilliant-body" hidden>
            <div class="ch-label">Search depth: <span id="ch-bdepth-value">${brilliantDepth}</span></div>
            <input type="range" id="ch-bdepth" min="12" max="24" value="${brilliantDepth}">
            <div id="ch-brilliant-result" class="ch-brilliant-result"></div>
          </div>
        </div>
        <div class="ch-section" id="ch-depth-section">
          <div class="ch-label">Depth: <span id="ch-depth-value">${analysisDepth}</span></div>
          <input type="range" id="ch-depth" min="10" max="20" value="${analysisDepth}">
        </div>
        <div class="ch-status" id="ch-status">Loading engine...</div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ch-enabled').addEventListener('change', (e) => {
      setEnabled(e.target.checked);
      store({ enabled: isEnabled });
    });

    document.getElementById('ch-depth').addEventListener('input', (e) => {
      analysisDepth = parseInt(e.target.value, 10);
      document.getElementById('ch-depth-value').textContent = analysisDepth;
    });
    document.getElementById('ch-depth').addEventListener('change', () => {
      if (isEnabled && !brilliantActive()) { currentFen = ''; analyzePosition(); }
    });

    document.getElementById('ch-brilliant').addEventListener('change', (e) => {
      setBrilliantMode(e.target.checked);
      store({ brilliantMode });
    });

    document.getElementById('ch-bdepth').addEventListener('input', (e) => {
      brilliantDepth = parseInt(e.target.value, 10);
      document.getElementById('ch-bdepth-value').textContent = brilliantDepth;
    });
    document.getElementById('ch-bdepth').addEventListener('change', () => {
      store({ brilliantDepth });
      if (isEnabled && brilliantActive()) { currentFen = ''; analyzePosition(); }
    });

    renderBrilliantSection(null);
  }

  function store(obj) {
    try { chrome.storage.local.set(obj); } catch (err) { /* extension reloaded */ }
  }

  function setEnabled(value) {
    isEnabled = value;
    const cb = document.getElementById('ch-enabled');
    if (cb) cb.checked = value;
    if (isEnabled) {
      currentFen = '';
      analyzePosition();
    } else {
      stopAnalysis();
      clearArrows();
      updatePanel({ bestMove: '-', eval: '-', moves: [], status: 'Disabled', brilliant: null });
    }
  }

  function setBrilliantMode(value) {
    brilliantMode = value;
    const cb = document.getElementById('ch-brilliant');
    if (cb) cb.checked = value;
    renderBrilliantSection(null);
    currentFen = '';
    if (isEnabled) analyzePosition();
  }

  function syncDepthSlider() {
    const slider = document.getElementById('ch-depth');
    const value = document.getElementById('ch-depth-value');
    if (slider) slider.value = analysisDepth;
    if (value) value.textContent = analysisDepth;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // result: undefined = giữ nguyên, null = trạng thái chờ, object = kết quả classify
  function renderBrilliantSection(result) {
    const body = document.getElementById('ch-brilliant-body');
    const box = document.getElementById('ch-brilliant-result');
    const depthSection = document.getElementById('ch-depth-section');
    if (!body || !box) return;

    body.hidden = !brilliantMode;
    if (depthSection) depthSection.hidden = brilliantActive();
    if (!brilliantMode) return;

    if (!brilliantAllowed()) {
      box.className = 'ch-brilliant-result ch-b-muted';
      box.textContent = 'Only works vs Computer (Play → Computer) or on Analysis / Game Review pages.';
      return;
    }

    if (!result) {
      box.className = 'ch-brilliant-result ch-b-muted';
      box.textContent = 'Searching for sacrifices...';
      return;
    }

    const hit = result.brilliant || result.great;
    if (!hit) {
      box.className = 'ch-brilliant-result ch-b-muted';
      box.textContent = 'No brilliant move in this position.';
      return;
    }

    const isBrilliant = hit.type === 'brilliant';
    const sac = hit.sacrificed
      ? `Sacrifices the ${hit.sacrificed.name}${hit.sacrificed.square ? ' on ' + hit.sacrificed.square : ''}`
      : 'Only move that keeps the advantage';
    box.className = 'ch-brilliant-result ' + (isBrilliant ? 'ch-b-brilliant' : 'ch-b-great');
    box.innerHTML = `
      <div class="ch-b-head"><span class="ch-b-tag">${isBrilliant ? '!!' : '!'}</span>
        <span class="ch-b-move">${escapeHtml(hit.san)}</span>
        <span class="ch-b-eval">${escapeHtml(formatScore(hit.score))}</span></div>
      <div class="ch-b-detail">${isBrilliant ? 'Brilliant' : 'Great move'} · ${escapeHtml(sac)}</div>
      <div class="ch-b-pv">${escapeHtml(hit.pvSan)}</div>`;
  }

  function updatePanel({ bestMove, eval: evaluation, moves, status, brilliant }) {
    const bestMoveEl = document.getElementById('ch-best-move');
    const evalEl = document.getElementById('ch-eval');
    const movesListEl = document.getElementById('ch-moves-list');
    const statusEl = document.getElementById('ch-status');

    if (bestMoveEl && bestMove !== undefined) bestMoveEl.textContent = bestMove;

    if (evalEl && evaluation !== undefined) {
      evalEl.textContent = evaluation;
      evalEl.className = 'ch-eval';
      const s = String(evaluation);
      if (s.startsWith('#')) {
        evalEl.classList.add(s.startsWith('#-') ? 'ch-eval-bad' : 'ch-eval-good');
      } else {
        const n = parseFloat(s);
        if (!isNaN(n)) {
          if (n > 0.5) evalEl.classList.add('ch-eval-good');
          else if (n < -0.5) evalEl.classList.add('ch-eval-bad');
        }
      }
    }

    if (movesListEl && moves) {
      movesListEl.innerHTML = moves.slice(0, 3).map((m, i) =>
        `<div class="ch-move-item">${i + 1}. ${escapeHtml(m.move)} (${escapeHtml(m.eval)})</div>`
      ).join('') || '<div class="ch-move-item">-</div>';
    }

    if (statusEl && status !== undefined) statusEl.textContent = status;
    if (brilliant !== undefined) renderBrilliantSection(brilliant);
  }

  // ============ ANALYSIS ============

  function analyzePosition() {
    if (!isEnabled) return;

    const read = getBoardFen();
    if (!read) {
      updatePanel({ status: 'Board not found' });
      return;
    }
    if (read.error) {
      // Thường do đọc DOM giữa lúc quân đang di chuyển - đợi mutation tiếp theo
      updatePanel({ status: 'Waiting for board (' + read.error + ')' });
      return;
    }

    const brilliant = brilliantActive();
    const mode = getPageMode();
    const myTurn = read.turn === (playerColor === 'white' ? 'w' : 'b');

    // Trang phân tích: phân tích cả hai bên. Đang chơi: chỉ phân tích lượt của mình.
    if (mode !== 'analysis' && !myTurn) {
      currentFen = '';
      stopAnalysis();
      clearArrows();
      updatePanel({ bestMove: '-', eval: '-', moves: [], status: "Opponent's turn",
        brilliant: brilliantMode ? null : undefined });
      if (brilliantMode && brilliantAllowed()) {
        const box = document.getElementById('ch-brilliant-result');
        if (box) box.textContent = "Waiting for your turn...";
      }
      return;
    }

    const key = read.fen + (brilliant ? '|b' + brilliantDepth : '');
    if (key === currentFen) return;
    currentFen = key;

    clearArrows();
    updatePanel({ bestMove: '...', status: 'Analyzing...', brilliant: brilliantMode ? null : undefined });
    doAnalyze(read.fen, brilliant ? brilliantDepth : analysisDepth, brilliant);
  }

  function formatMove(uciMove) {
    if (!uciMove || uciMove.length < 4) return uciMove || '-';
    const from = uciMove.substring(0, 2);
    const to = uciMove.substring(2, 4);
    const promotion = uciMove[4] || '';
    return `${from.toUpperCase()} → ${to.toUpperCase()}${promotion ? '=' + promotion.toUpperCase() : ''}`;
  }

  function formatScore(score) {
    if (!score) return '0.0';
    if (score.type === 'mate') return '#' + score.value;
    const pawns = score.value / 100;
    return (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
  }

  // ============ ARROW DRAWING ============

  let arrowSvg = null;

  const ARROW_STYLES = {
    best: { color: 'rgba(0, 180, 80, 0.85)', width: 18 },
    alt: { color: 'rgba(0, 120, 215, 0.7)', width: 12 },
    brilliant: { color: 'rgba(27, 172, 166, 0.95)', width: 20 },
    great: { color: 'rgba(92, 139, 176, 0.95)', width: 18 }
  };

  // Tạo 1 lớp SVG cho cả lượt vẽ (trước đây mỗi mũi tên xóa SVG cũ -> chỉ còn mũi tên cuối)
  function createArrowLayer() {
    const board = findBoard();
    if (!board) return null;
    clearArrows();

    arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.id = 'ch-arrow-svg';
    arrowSvg.setAttribute('viewBox', '0 0 800 800');
    arrowSvg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;';

    const markers = Object.entries(ARROW_STYLES).map(([name, s]) =>
      `<marker id="ch-head-${name}" markerWidth="12" markerHeight="8" refX="10" refY="4" orient="auto">
         <polygon points="0 0, 12 4, 0 8" fill="${s.color}" /></marker>`).join('');
    arrowSvg.innerHTML = `<defs>${markers}</defs>`;

    if (window.getComputedStyle(board).position === 'static') board.style.position = 'relative';
    board.appendChild(arrowSvg);
    return arrowSvg;
  }

  function squareToCoords(sq) {
    const file = sq.charCodeAt(0) - 97;
    const rank = parseInt(sq[1], 10) - 1;
    if (playerColor === 'black') return { x: (7 - file) * 100 + 50, y: rank * 100 + 50 };
    return { x: file * 100 + 50, y: (7 - rank) * 100 + 50 };
  }

  function drawArrow(svg, uci, kind) {
    if (!uci || uci.length < 4) return;
    const style = ARROW_STYLES[kind] || ARROW_STYLES.alt;
    const from = squareToCoords(uci.slice(0, 2));
    const to = squareToCoords(uci.slice(2, 4));
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x - (dx / len) * 15);
    line.setAttribute('y2', to.y - (dy / len) * 15);
    line.setAttribute('stroke', style.color);
    line.setAttribute('stroke-width', style.width);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('marker-end', `url(#ch-head-${kind in ARROW_STYLES ? kind : 'alt'})`);
    svg.appendChild(line);

    if (kind !== 'alt') {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', from.x);
      circle.setAttribute('cy', from.y);
      circle.setAttribute('r', '20');
      circle.setAttribute('fill', style.color.replace(/[\d.]+\)$/, '0.3)'));
      svg.appendChild(circle);
    }
  }

  // Huy hiệu "!!" ở góc trên phải ô đích
  function drawBadge(svg, sq, text, kind) {
    const c = squareToCoords(sq);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = `
      <circle cx="${c.x + 32}" cy="${c.y - 32}" r="22" fill="${kind === 'brilliant' ? '#1baca6' : '#5c8bb0'}" stroke="#fff" stroke-width="4"/>
      <text x="${c.x + 32}" y="${c.y - 23}" text-anchor="middle" font-size="26" font-weight="800"
            font-family="Arial, sans-serif" fill="#fff">${text}</text>`;
    svg.appendChild(g);
  }

  function clearArrows() {
    if (arrowSvg && arrowSvg.parentNode) arrowSvg.parentNode.removeChild(arrowSvg);
    arrowSvg = null;
  }

  // ============ OBSERVERS ============

  let observedBoard = null;
  let observedClocks = [];
  let boardObserver = null;
  let clockObserver = null;
  let lastPath = location.pathname;

  // Bỏ qua mutation do chính extension gây ra (vẽ/xóa mũi tên)
  function isOwnMutation(r) {
    if (r.target && r.target.closest && r.target.closest('#ch-arrow-svg')) return true;
    if (r.type === 'childList') {
      const nodes = [...r.addedNodes, ...r.removedNodes];
      return nodes.length > 0 && nodes.every((n) => n.id === 'ch-arrow-svg');
    }
    return false;
  }

  function triggerAnalysis() {
    clearTimeout(window.chessHelperDebounce);
    window.chessHelperDebounce = setTimeout(() => {
      const newColor = detectPlayerColor();
      if (newColor !== playerColor) {
        playerColor = newColor;
        currentFen = '';
        clearArrows();
      }
      if (isEnabled) analyzePosition();
    }, 300);
  }

  // Gắn lại observer khi chess.com thay bàn cờ / đồng hồ (điều hướng SPA, ván mới)
  function attachObservers() {
    const board = findBoard();
    const clocks = [...document.querySelectorAll('.clock-bottom, .clock-top')];
    const sameClocks = clocks.length === observedClocks.length && clocks.every((c, i) => c === observedClocks[i]);

    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      currentFen = '';
      renderBrilliantSection(null);
      triggerAnalysis();
    }
    if (board === observedBoard && sameClocks) return;

    if (boardObserver) boardObserver.disconnect();
    if (clockObserver) clockObserver.disconnect();
    observedBoard = board;
    observedClocks = clocks;
    if (!board) return;

    arrowSvg = null;
    currentFen = '';
    playerColor = detectPlayerColor();

    boardObserver = new MutationObserver((records) => {
      if (records.every(isOwnMutation)) return;
      triggerAnalysis();
    });
    boardObserver.observe(board, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'is-flipped', 'data-flipped']
    });

    clockObserver = new MutationObserver(triggerAnalysis);
    clocks.forEach((clock) => clockObserver.observe(clock, { attributes: true, attributeFilter: ['class'] }));

    triggerAnalysis();
  }

  // ============ INIT ============

  function init() {
    try {
      chrome.storage.local.get(['enabled', 'brilliantMode', 'brilliantDepth'], (result) => {
        if (result.enabled !== undefined) isEnabled = result.enabled;
        if (result.brilliantMode !== undefined) brilliantMode = !!result.brilliantMode;
        if (result.brilliantDepth) brilliantDepth = result.brilliantDepth;

        createPanel();
        document.getElementById('ch-enabled').checked = isEnabled;
        document.getElementById('ch-brilliant').checked = brilliantMode;
        renderBrilliantSection(null);
        initStockfish();
        attachObservers();
        setInterval(attachObservers, 1000);
      });

      // Đồng bộ khi bật/tắt từ popup
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.brilliantMode && changes.brilliantMode.newValue !== brilliantMode) {
          setBrilliantMode(!!changes.brilliantMode.newValue);
        }
      });
    } catch (err) {
      createPanel();
      updatePanel({ status: 'Extension reloaded - refresh page' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
