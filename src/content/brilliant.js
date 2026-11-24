// Chess Helper - Brilliant move detector
// Phân loại nước "!!" (brilliant) và "!" (great) từ kết quả MultiPV của Stockfish.
//
// Brilliant (gần với tiêu chí chess.com):
//   1. Nước đi là một sự hy sinh quân: sau nước đi, đối phương ăn được một quân (>= mã/tượng)
//      và mình lỗ >= 1 tốt sau chuỗi trao đổi (tính bằng SEE), phần lỗ do chính nước này tạo ra.
//      (Hy sinh tốt / gambit không tính.)
//   2. Nước đi là tốt nhất hoặc gần tốt nhất (sụt win% <= nearBestWinPct).
//   3. Sau nước đi thế cờ không tệ (eval >= minEvalCp).
//   4. Không phải đang thắng áp đảo sẵn bằng một nước "bình thường" (trừ khi hy sinh dẫn tới chiếu hết).
//   5. Không đang bị chiếu, và có nhiều hơn một nước hợp lệ.
// Great: nước duy nhất giữ được kết quả - bỏ xa nước thứ hai (>= greatGapWinPct win%), các nước khác
//   không còn ưu thế rõ, không phải ăn lại quân đơn giản hay chiếu hết 1 nước.

(function (root) {
  'use strict';

  const C = root.ChessCore || (typeof require === 'function' ? require('./chess-core.js') : null);

  const DEFAULTS = {
    sacMinLoss: 1,         // lỗ tối thiểu (tốt) sau trao đổi: mã đổi 2 tốt = 1, hy sinh chất lượng = 2
    sacMinPiece: 3,        // quân bị dâng phải >= mã/tượng (không tính gambit tốt)
    nearBestWinPct: 3,     // cho phép kém nước tốt nhất tối đa 3% win
    minEvalCp: -50,        // sau nước đi không được thua quá 0.5
    alreadyWinningCp: 500, // nếu có nước thường >= +5 thì hy sinh không còn "brilliant"
    greatGapWinPct: 20,    // great: nước tốt nhất hơn nước thứ hai >= 20% win
    greatMinEvalCp: -100,  // great: sau nước đi không thua quá 1.0
    greatMaxSecondWin: 70  // great: nước thứ hai không còn ưu thế rõ (< 70% win ~ +2.3)
  };

  const MATE_CP = 100000;

  function scoreToCp(score) {
    if (!score) return 0;
    if (score.type === 'mate') {
      if (score.value === 0) return -MATE_CP;
      return score.value > 0 ? MATE_CP - score.value * 100 : -MATE_CP - score.value * 100;
    }
    return score.value;
  }

  const isMate = (score) => score && score.type === 'mate' && score.value > 0;

  // Win probability (công thức lichess), 0..100 cho bên đang đi
  function winPct(cp) {
    const c = Math.max(-2000, Math.min(2000, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
  }

  // Cán cân vật chất tĩnh sau một nước đi: ăn được bao nhiêu, rồi đối phương ăn lại tối đa bao nhiêu
  function materialAfter(pos, uci) {
    const next = C.makeMove(pos, uci);
    const lm = next.lastMove;
    let gain = lm.captured ? C.VALUES[C.typeOf(lm.captured)] : 0;
    if (lm.promo) gain += C.VALUES[lm.promo] - 1;
    const threat = C.maxThreat(next.board, pos.turn);
    return {
      next,
      gain,
      threat: threat.value,
      square: threat.square,
      piece: threat.square >= 0 ? next.board[threat.square] : null,
      net: gain - threat.value
    };
  }

  // Kết quả vật chất tốt nhất bên đi có thể đạt bằng một nước bất kỳ (vd. rút quân bị đuổi về chỗ an toàn)
  function bestStaticNet(pos, legal) {
    let best = -Infinity;
    for (const m of legal || C.legalMoves(pos)) best = Math.max(best, materialAfter(pos, m).net);
    return best === -Infinity ? 0 : best;
  }

  // Phân tích một nước đi có phải hy sinh không
  function sacrificeInfo(pos, uci, options, baseline) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (baseline === undefined) baseline = bestStaticNet(pos);
    const m = materialAfter(pos, uci);
    const pieceValue = m.piece ? C.VALUES[C.typeOf(m.piece)] : 0;

    // Quân bị dâng phải do CHÍNH nước này đưa vào thế bị ăn: là quân vừa đi, hoặc bị đe dọa nặng hơn
    // trước (vd. rút quân bảo vệ, mở đường). Quân đã treo sẵn mà đối phương không dám ăn (quân "độc")
    // thì không tính lại ở mỗi nước.
    let fresh = false;
    if (m.square >= 0) {
      if (m.square === m.next.lastMove.to || pos.board[m.square] !== m.piece) fresh = true;
      else fresh = m.threat > C.see(pos.board, m.square, C.opposite(pos.turn));
    }

    // Hy sinh = dâng một quân (>= mã/tượng), lỗ >= sacMinLoss sau trao đổi, và lỗ nhiều hơn
    // so với nước "an toàn" nhất có thể (desperado với quân đằng nào cũng mất thì không tính)
    const isSacrifice = fresh &&
      pieceValue >= o.sacMinPiece &&
      m.net <= -o.sacMinLoss &&
      m.net <= baseline - o.sacMinLoss;

    return {
      isSacrifice,
      gain: m.gain,
      threat: m.threat,
      net: m.net,
      baseline,
      square: m.square,
      piece: m.piece,
      givesCheck: C.inCheck(m.next.board, m.next.turn)
    };
  }

  // lines: [{ multipv, move, score: {type:'cp'|'mate', value}, depth, pv: [uci...] }]
  function classify(fen, lines, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const result = { brilliant: null, great: null, candidates: [] };

    let pos;
    try {
      pos = C.parseFen(fen);
    } catch (e) {
      return result;
    }

    const legal = C.legalMoves(pos);
    const valid = (lines || [])
      .filter((l) => l && l.move && legal.includes(l.move))
      .sort((a, b) => a.multipv - b.multipv);
    if (!valid.length || legal.length < 2) return result;

    const checked = C.inCheck(pos.board, pos.turn);
    const baseline = bestStaticNet(pos, legal);
    const analyzed = valid.map((l) => {
      const cp = scoreToCp(l.score);
      return Object.assign({}, l, {
        cp,
        win: winPct(cp),
        sac: sacrificeInfo(pos, l.move, o, baseline),
        san: C.toSan(pos, l.move, legal)
      });
    });
    result.candidates = analyzed;

    const best = analyzed[0];
    const bestQuiet = analyzed.find((a) => !a.sac.isSacrifice) || null;

    const describe = (a, type) => ({
      type,
      move: a.move,
      san: a.san,
      score: a.score,
      cp: a.cp,
      depth: a.depth,
      pv: a.pv || [a.move],
      pvSan: C.pvToSan(pos, a.pv && a.pv.length ? a.pv : [a.move], 10),
      sacrificed: a.sac.isSacrifice ? {
        piece: C.typeOf(a.sac.piece),
        name: C.NAMES[C.typeOf(a.sac.piece)] || 'material',
        square: a.sac.square >= 0 ? C.sqName(a.sac.square) : null,
        net: a.sac.net
      } : null
    });

    if (!checked) {
      for (const a of analyzed) {
        if (!a.sac.isSacrifice) continue;
        if (best.win - a.win > o.nearBestWinPct) continue;
        if (a.cp < o.minEvalCp) continue;
        // Có nước thường tốt ngang/hơn thì hy sinh là không cần thiết (trừ khi chính nó là nước số 1)
        if (bestQuiet && a !== best && a.cp <= bestQuiet.cp) continue;
        // Đã thắng áp đảo bằng nước thường -> không brilliant, trừ khi hy sinh chiếu hết nhanh hơn
        const fasterMate = isMate(a.score) &&
          (!isMate(bestQuiet && bestQuiet.score) || a.score.value < bestQuiet.score.value);
        if (bestQuiet && bestQuiet.cp >= o.alreadyWinningCp && !fasterMate) continue;
        result.brilliant = describe(a, 'brilliant');
        break;
      }
    }

    if (!result.brilliant && !checked && analyzed.length >= 2) {
      const second = analyzed[1];
      const simpleCapture = best.sac.gain > 0 && best.sac.net >= 0;
      const mateInOne = best.score.type === 'mate' && best.score.value === 1;
      if (best.win - second.win >= o.greatGapWinPct && best.cp >= o.greatMinEvalCp &&
          second.win < o.greatMaxSecondWin && !simpleCapture && !mateInOne) {
        result.great = describe(best, 'great');
      }
    }

    return result;
  }

  // "info depth 16 seldepth 25 multipv 2 score cp -192 ... pv h5d1 f6e4 ... bmc 1.02"
  // -> { depth, multipv, score, pv, bound } ; null nếu không phải dòng có PV
  function parseInfo(line) {
    if (typeof line !== 'string' || !line.startsWith('info ') || line.indexOf(' pv ') < 0) return null;
    const depth = line.match(/\bdepth (\d+)/);
    const score = line.match(/\bscore (cp|mate) (-?\d+)/);
    if (!depth || !score) return null;
    const multipv = line.match(/\bmultipv (\d+)/);
    const pv = [];
    for (const tok of line.slice(line.indexOf(' pv ') + 4).split(/\s+/)) {
      if (!C.isUci(tok)) break; // chess.com build thêm "bmc x.xx" sau PV
      pv.push(tok);
    }
    if (!pv.length) return null;
    return {
      depth: parseInt(depth[1], 10),
      multipv: multipv ? parseInt(multipv[1], 10) : 1,
      score: { type: score[1], value: parseInt(score[2], 10) },
      bound: /\b(lowerbound|upperbound)\b/.test(line),
      move: pv[0],
      pv
    };
  }

  const api = { classify, sacrificeInfo, materialAfter, bestStaticNet, parseInfo, scoreToCp, winPct, DEFAULTS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BrilliantDetector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
