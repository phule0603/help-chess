// Chess Helper - Chess Core
// Luật cờ tối thiểu: FEN, đi nước, sinh nước hợp lệ, SAN, SEE (static exchange evaluation).
// Dùng chung cho content script (global ChessCore) và test Node (module.exports).

(function (root) {
  'use strict';

  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
  const SEE_ORDER = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const QUEEN_DIRS = ROOK_DIRS.concat(BISHOP_DIRS);

  // Square index: a1 = 0, h1 = 7, a8 = 56, h8 = 63
  const fileOf = (sq) => sq & 7;
  const rankOf = (sq) => sq >> 3;
  const sqIndex = (name) => (name.charCodeAt(0) - 97) + (name.charCodeAt(1) - 49) * 8;
  const sqName = (sq) => String.fromCharCode(97 + fileOf(sq)) + String.fromCharCode(49 + rankOf(sq));
  const colorOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null);
  const typeOf = (p) => (p ? p.toLowerCase() : null);
  const opposite = (c) => (c === 'w' ? 'b' : 'w');
  const pieceOf = (color, type) => (color === 'w' ? type.toUpperCase() : type);

  function offset(sq, df, dr) {
    const f = fileOf(sq) + df;
    const r = rankOf(sq) + dr;
    return (f < 0 || f > 7 || r < 0 || r > 7) ? -1 : r * 8 + f;
  }

  const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  const isUci = (s) => typeof s === 'string' && UCI_RE.test(s);

  function parseUci(uci) {
    return { from: sqIndex(uci.slice(0, 2)), to: sqIndex(uci.slice(2, 4)), promo: uci[4] || null };
  }

  // ============ FEN ============

  function parseFen(fen) {
    const parts = String(fen).trim().split(/\s+/);
    const rows = (parts[0] || '').split('/');
    if (rows.length !== 8) throw new Error('Bad FEN: ' + fen);
    const board = new Array(64).fill(null);
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') {
          f += Number(ch);
        } else if (/[pnbrqkPNBRQK]/.test(ch)) {
          if (f > 7) throw new Error('Bad FEN row: ' + rows[r]);
          board[(7 - r) * 8 + f] = ch;
          f++;
        } else {
          throw new Error('Bad FEN char: ' + ch);
        }
      }
      if (f !== 8) throw new Error('Bad FEN row: ' + rows[r]);
    }
    const castling = parts[2] && parts[2] !== '-' ? parts[2] : '';
    const ep = parts[3] && parts[3] !== '-' ? sqIndex(parts[3]) : null;
    return {
      board,
      turn: parts[1] === 'b' ? 'b' : 'w',
      castling,
      ep,
      halfmove: parseInt(parts[4], 10) || 0,
      fullmove: parseInt(parts[5], 10) || 1
    };
  }

  function placementOf(board) {
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = board[r * 8 + f];
        if (p) {
          if (empty) { out += empty; empty = 0; }
          out += p;
        } else {
          empty++;
        }
      }
      if (empty) out += empty;
      if (r > 0) out += '/';
    }
    return out;
  }

  function toFen(pos) {
    return [
      placementOf(pos.board),
      pos.turn,
      pos.castling || '-',
      pos.ep === null || pos.ep === undefined ? '-' : sqName(pos.ep),
      pos.halfmove || 0,
      pos.fullmove || 1
    ].join(' ');
  }

  // Suy quyền nhập thành từ vị trí vua/xe (DOM không cho biết lịch sử nước đi)
  function inferCastling(board) {
    let c = '';
    if (board[4] === 'K') {
      if (board[7] === 'R') c += 'K';
      if (board[0] === 'R') c += 'Q';
    }
    if (board[60] === 'k') {
      if (board[63] === 'r') c += 'k';
      if (board[56] === 'r') c += 'q';
    }
    return c;
  }

  // ============ ATTACKS ============

  // Danh sách ô có quân màu `color` đang tấn công ô `sq`
  function attackers(board, sq, color) {
    const out = [];
    const pawn = pieceOf(color, 'p');
    const pr = color === 'w' ? -1 : 1;
    for (const df of [-1, 1]) {
      const s = offset(sq, df, pr);
      if (s >= 0 && board[s] === pawn) out.push(s);
    }
    const knight = pieceOf(color, 'n');
    for (const [df, dr] of KNIGHT) {
      const s = offset(sq, df, dr);
      if (s >= 0 && board[s] === knight) out.push(s);
    }
    const king = pieceOf(color, 'k');
    for (const [df, dr] of KING) {
      const s = offset(sq, df, dr);
      if (s >= 0 && board[s] === king) out.push(s);
    }
    const slide = (dirs, a, b) => {
      for (const [df, dr] of dirs) {
        let s = sq;
        while ((s = offset(s, df, dr)) >= 0) {
          const p = board[s];
          if (!p) continue;
          if (colorOf(p) === color && (typeOf(p) === a || typeOf(p) === b)) out.push(s);
          break;
        }
      }
    };
    slide(ROOK_DIRS, 'r', 'q');
    slide(BISHOP_DIRS, 'b', 'q');
    return out;
  }

  const isAttacked = (board, sq, color) => attackers(board, sq, color).length > 0;

  function kingSquare(board, color) {
    return board.indexOf(pieceOf(color, 'k'));
  }

  function inCheck(board, color) {
    const k = kingSquare(board, color);
    return k >= 0 && isAttacked(board, k, opposite(color));
  }

  // ============ MOVES ============

  function makeMove(pos, uci) {
    const { from, to, promo } = parseUci(uci);
    const board = pos.board.slice();
    const piece = board[from];
    if (!piece) throw new Error('No piece on ' + sqName(from) + ' for ' + uci);
    const color = colorOf(piece);
    const type = typeOf(piece);

    let captured = board[to];
    let capturedSq = to;
    if (type === 'p' && to === pos.ep && !captured && fileOf(from) !== fileOf(to)) {
      capturedSq = to + (color === 'w' ? -8 : 8);
      captured = board[capturedSq];
      board[capturedSq] = null;
    }

    board[to] = promo ? pieceOf(color, promo) : piece;
    board[from] = null;

    let castle = null;
    if (type === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) {
      const base = rankOf(from) * 8;
      if (fileOf(to) === 6) {
        board[base + 5] = board[base + 7]; board[base + 7] = null; castle = 'K';
      } else {
        board[base + 3] = board[base]; board[base] = null; castle = 'Q';
      }
    }

    let castling = pos.castling || '';
    const strip = (chars) => { for (const ch of chars) castling = castling.replace(ch, ''); };
    if (type === 'k') strip(color === 'w' ? 'KQ' : 'kq');
    for (const s of [from, to]) {
      if (s === 0) strip('Q');
      if (s === 7) strip('K');
      if (s === 56) strip('q');
      if (s === 63) strip('k');
    }

    return {
      board,
      turn: opposite(color),
      castling,
      ep: type === 'p' && Math.abs(to - from) === 16 ? (from + to) / 2 : null,
      halfmove: type === 'p' || captured ? 0 : (pos.halfmove || 0) + 1,
      fullmove: (pos.fullmove || 1) + (color === 'b' ? 1 : 0),
      lastMove: { uci, from, to, piece, captured, capturedSq, promo, castle }
    };
  }

  function pseudoMoves(pos) {
    const { board, turn } = pos;
    const moves = [];
    const opp = opposite(turn);
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (!p || colorOf(p) !== turn) continue;
      const t = typeOf(p);
      const add = (to) => {
        if (t === 'p' && (rankOf(to) === 7 || rankOf(to) === 0)) {
          for (const pr of 'qrbn') moves.push(sqName(sq) + sqName(to) + pr);
        } else {
          moves.push(sqName(sq) + sqName(to));
        }
      };

      if (t === 'p') {
        const dir = turn === 'w' ? 1 : -1;
        const one = offset(sq, 0, dir);
        if (one >= 0 && !board[one]) {
          add(one);
          const two = offset(sq, 0, 2 * dir);
          if (rankOf(sq) === (turn === 'w' ? 1 : 6) && !board[two]) add(two);
        }
        for (const df of [-1, 1]) {
          const c = offset(sq, df, dir);
          if (c < 0) continue;
          if ((board[c] && colorOf(board[c]) === opp) || c === pos.ep) add(c);
        }
      } else if (t === 'n' || t === 'k') {
        for (const [df, dr] of (t === 'n' ? KNIGHT : KING)) {
          const to = offset(sq, df, dr);
          if (to >= 0 && colorOf(board[to]) !== turn) add(to);
        }
        if (t === 'k') {
          const base = turn === 'w' ? 0 : 56;
          const rook = pieceOf(turn, 'r');
          if (sq === base + 4 && !isAttacked(board, sq, opp)) {
            if (pos.castling.includes(turn === 'w' ? 'K' : 'k') && board[base + 7] === rook &&
                !board[base + 5] && !board[base + 6] &&
                !isAttacked(board, base + 5, opp) && !isAttacked(board, base + 6, opp)) {
              moves.push(sqName(sq) + sqName(base + 6));
            }
            if (pos.castling.includes(turn === 'w' ? 'Q' : 'q') && board[base] === rook &&
                !board[base + 1] && !board[base + 2] && !board[base + 3] &&
                !isAttacked(board, base + 3, opp) && !isAttacked(board, base + 2, opp)) {
              moves.push(sqName(sq) + sqName(base + 2));
            }
          }
        }
      } else {
        const dirs = t === 'r' ? ROOK_DIRS : t === 'b' ? BISHOP_DIRS : QUEEN_DIRS;
        for (const [df, dr] of dirs) {
          let to = sq;
          while ((to = offset(to, df, dr)) >= 0) {
            if (!board[to]) { add(to); continue; }
            if (colorOf(board[to]) === opp) add(to);
            break;
          }
        }
      }
    }
    return moves;
  }

  function legalMoves(pos) {
    return pseudoMoves(pos).filter((m) => !inCheck(makeMove(pos, m).board, pos.turn));
  }

  // ============ SAN ============

  function toSan(pos, uci, legal) {
    legal = legal || legalMoves(pos);
    if (!legal.includes(uci)) throw new Error('Illegal move ' + uci + ' in ' + toFen(pos));
    const { from, to, promo } = parseUci(uci);
    const piece = pos.board[from];
    const t = typeOf(piece);
    let san;

    if (t === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) {
      san = fileOf(to) === 6 ? 'O-O' : 'O-O-O';
    } else {
      const isCapture = !!pos.board[to] || (t === 'p' && fileOf(from) !== fileOf(to));
      if (t === 'p') {
        san = (isCapture ? sqName(from)[0] + 'x' : '') + sqName(to) + (promo ? '=' + promo.toUpperCase() : '');
      } else {
        const others = legal
          .filter((m) => m !== uci && m.slice(2, 4) === uci.slice(2, 4) && pos.board[sqIndex(m.slice(0, 2))] === piece)
          .map((m) => sqIndex(m.slice(0, 2)));
        let dis = '';
        if (others.length) {
          if (!others.some((s) => fileOf(s) === fileOf(from))) dis = sqName(from)[0];
          else if (!others.some((s) => rankOf(s) === rankOf(from))) dis = sqName(from)[1];
          else dis = sqName(from);
        }
        san = t.toUpperCase() + dis + (isCapture ? 'x' : '') + sqName(to);
      }
    }

    const next = makeMove(pos, uci);
    if (inCheck(next.board, next.turn)) san += legalMoves(next).length === 0 ? '#' : '+';
    return san;
  }

  function sanToUci(pos, san) {
    const clean = (s) => s.replace(/[+#!?]/g, '').replace(/0/g, 'O');
    const want = clean(san);
    const legal = legalMoves(pos);
    for (const m of legal) {
      if (clean(toSan(pos, m, legal)) === want) return m;
    }
    return null;
  }

  // PV (UCI) -> "1. Nxf7 Kxf7 2. Qh5+" ; dừng khi gặp nước không hợp lệ
  function pvToSan(pos, pv, maxPlies) {
    const out = [];
    let cur = pos;
    let moveNo = pos.fullmove || 1;
    const limit = Math.min(pv.length, maxPlies || pv.length);
    for (let i = 0; i < limit; i++) {
      const uci = pv[i];
      let san;
      try {
        san = toSan(cur, uci);
      } catch (e) {
        break;
      }
      if (cur.turn === 'w') out.push(moveNo + '. ' + san);
      else out.push(i === 0 ? moveNo + '… ' + san : san);
      cur = makeMove(cur, uci);
      if (cur.turn === 'w') moveNo++;
    }
    return out.join(' ');
  }

  // ============ STATIC EXCHANGE EVALUATION ============

  // Quân rẻ nhất của `side` có thể ăn hợp lệ ở `sq` (không để vua mình bị chiếu)
  function leastValuableAttacker(board, sq, side) {
    const list = attackers(board, sq, side).sort((a, b) => SEE_ORDER[typeOf(board[a])] - SEE_ORDER[typeOf(board[b])]);
    for (const from of list) {
      const b = board.slice();
      b[sq] = b[from];
      b[from] = null;
      if (!inCheck(b, side)) return from;
    }
    return -1;
  }

  // Vật chất (tính bằng tốt) mà `side` thắng được nếu bắt đầu trao đổi ở `sq`. Luôn >= 0.
  function see(board, sq, side) {
    if (!board[sq] || colorOf(board[sq]) === side) return 0;
    const b = board.slice();
    const swaps = [];
    let onSquare = VALUES[typeOf(b[sq])];
    let cur = side;
    for (let guard = 0; guard < 32; guard++) {
      const from = leastValuableAttacker(b, sq, cur);
      if (from < 0) break;
      swaps.push(onSquare);
      onSquare = typeOf(b[from]) === 'k' ? 100 : VALUES[typeOf(b[from])];
      b[sq] = b[from];
      b[from] = null;
      cur = opposite(cur);
    }
    let score = 0;
    for (let i = swaps.length - 1; i >= 0; i--) score = Math.max(0, swaps[i] - score);
    return score;
  }

  // Vật chất lớn nhất đối phương thắng được ngay (quân màu `color` bị treo)
  function maxThreat(board, color) {
    const opp = opposite(color);
    let best = { value: 0, square: -1 };
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (!p || colorOf(p) !== color || typeOf(p) === 'k') continue;
      const v = see(board, sq, opp);
      if (v > best.value) best = { value: v, square: sq };
    }
    return best;
  }

  // Kiểm tra vị trí hợp lệ trước khi gửi cho engine (FEN sai có thể làm Stockfish crash)
  function validatePosition(pos) {
    const b = pos.board;
    const count = (p) => b.filter((x) => x === p).length;
    if (count('K') !== 1 || count('k') !== 1) return 'Missing or extra king';
    for (let f = 0; f < 8; f++) {
      if (typeOf(b[f]) === 'p' || typeOf(b[56 + f]) === 'p') return 'Pawn on back rank';
    }
    if (b.filter((x) => colorOf(x) === 'w').length > 16 || b.filter((x) => colorOf(x) === 'b').length > 16) {
      return 'Too many pieces';
    }
    if (inCheck(b, opposite(pos.turn))) return 'Side not to move is in check';
    return null;
  }

  const api = {
    VALUES, NAMES,
    fileOf, rankOf, sqIndex, sqName, colorOf, typeOf, opposite, isUci, parseUci,
    parseFen, toFen, placementOf, inferCastling,
    attackers, isAttacked, inCheck, kingSquare,
    makeMove, pseudoMoves, legalMoves,
    toSan, sanToUci, pvToSan,
    see, maxThreat, validatePosition
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChessCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
