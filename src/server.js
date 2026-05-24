/**
 * ══════════════════════════════════════════════════════════════
 *  TÀI XỈU PREDICTION API  —  DEV @sewdangcap
 *  v5.0 — Thuật toán Cầu Thực Chiến + Markov + Dice + Ensemble
 *
 *  Kiến trúc dự đoán:
 *    TẦNG 1 — Nhận dạng Cầu (Pattern Recognition)
 *    TẦNG 2 — Xác suất Thống kê (Markov + Frequency)
 *    TẦNG 3 — Phân tích Xúc xắc (Dice Analysis)
 *    TẦNG 4 — Ensemble Voting có trọng số động (Meta-learning)
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = 'https://apilichsusunwinsew.onrender.com/api/taixiu/history';

// ══════════════════════════════════════════════════════════════
//  STORE & CONFIG
// ══════════════════════════════════════════════════════════════
let history  = [];   // [{ phien, dice, tong, kq }]   kq = 'T' | 'X'
let winLoss  = [];   // [{ phien, predicted, actual, win, conf, algoName, ... }]

const CFG = {
  MAX_HISTORY:      300,
  MAX_WIN_LOSS:     200,
  ACC_WINDOW:       60,   // cửa sổ tính accuracy mỗi algo
  MIN_SAMPLE_PRED:   4,   // tối thiểu phiên để bắt đầu dự đoán
  CONF_FLOOR:       52,
  CONF_CEIL:        91,
};

// Meta-learning: track accuracy từng algo
const algoMeta = {};   // { algoName: { hits, total, recent[] } }

// ══════════════════════════════════════════════════════════════
//  HELPERS CƠ BẢN
// ══════════════════════════════════════════════════════════════
const isTai = t => t >= 11;
const label = t => (t >= 11 ? 'T' : 'X');
const flip  = v => (v === 'T' ? 'X' : 'T');
const fullLabel = v => (v === 'T' ? 'Tài' : v === 'X' ? 'Xỉu' : null);

/** Lấy chuỗi kq gần nhất, mới nhất ở index 0 */
function getSeq(hist, n = 60) {
  return hist.slice(-n).map(h => h.kq).filter(Boolean).reverse();
}

/** Parse block liên tiếp từ chuỗi seq (index 0 = mới nhất) */
function parseBlocks(seq) {
  const blocks = [];
  let i = 0;
  while (i < seq.length) {
    const val = seq[i];
    let len = 0;
    while (i < seq.length && seq[i] === val) { len++; i++; }
    blocks.push({ val, len });
  }
  return blocks;
}

/** Tính confidence tuyến tính từ raw ratio [0.5, 1.0] → [FLOOR, CEIL] */
function calibrateConf(raw) {
  return Math.round(Math.max(CFG.CONF_FLOOR,
    Math.min(CFG.CONF_CEIL, CFG.CONF_FLOOR + (raw - 0.5) * 2 * (CFG.CONF_CEIL - CFG.CONF_FLOOR))));
}

// ══════════════════════════════════════════════════════════════
//  TẦNG 1 — NHẬN DẠNG CẦU (Pattern Recognition)
// ══════════════════════════════════════════════════════════════
// Mỗi hàm nhận seq (index 0 = mới nhất) và trả về:
//   { vote: 'T'|'X', weight: number, label: string, detail: string }
//   hoặc null nếu không phát hiện được cầu.
// ──────────────────────────────────────────────────────────────

/**
 * CẦU BỆT — Theo streak đang chạy
 * Logic: Streak đang chạy → kỳ vọng tiếp tục.
 *   Streak càng dài → weight giảm (sắp gãy).
 */
function cau_Bet(seq) {
  if (seq.length < 2) return null;
  const cur = seq[0];
  let streak = 0;
  for (const v of seq) {
    if (v === cur) streak++;
    else break;
  }

  //         1    2    3    4    5    6    7+
  const wMap = [0, 1.05, 1.1, 1.0, 0.85, 0.65, 0.45, 0.30];
  const weight = wMap[Math.min(streak, 7)];

  return {
    vote:   cur,
    weight,
    label:  `Cầu Bệt`,
    detail: `Streak ${cur} ${streak} phiên liên tiếp`,
  };
}

/**
 * CẦU 1-1 (XEN KẼ) — Phát hiện dao động T-X-T-X
 * Logic: Kiểm tra tỉ lệ xen kẽ trong N phiên gần nhất.
 *   Nếu ≥ 75% bước là xen kẽ → theo nhịp 1-1.
 */
function cau_11(seq) {
  const CHECK = 8;
  if (seq.length < CHECK) return null;

  const tail = seq.slice(0, CHECK);
  let altCount = 0;
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i] !== tail[i + 1]) altCount++;
  }
  const ratio = altCount / (tail.length - 1);
  if (ratio < 0.75) return null;

  const vote = flip(seq[0]);  // Theo nhịp xen kẽ → next là ngược lại
  return {
    vote,
    weight: 0.8 + ratio * 0.5,
    label:  `Cầu 1-1 Xen Kẽ`,
    detail: `${altCount}/${CHECK - 1} bước xen kẽ (${Math.round(ratio * 100)}%)`,
  };
}

/**
 * CẦU 2-2 — Block đôi xen nhau: XX-TT-XX-TT
 * Logic: Parse blocks, nếu nhiều block có len=2 → theo chiều đang bước.
 */
function cau_22(seq) {
  if (seq.length < 8) return null;
  const blocks = parseBlocks(seq).slice(0, 6);
  if (blocks.length < 3) return null;

  const twoBlocks = blocks.filter(b => b.len === 2).length;
  if (twoBlocks < 3) return null;

  const cur = blocks[0];
  // Nếu block hiện tại đã có ≥ 2 phiên → chuẩn bị đổi
  const vote = cur.len >= 2 ? flip(cur.val) : cur.val;
  return {
    vote,
    weight: 0.85 + (twoBlocks / blocks.length) * 0.4,
    label:  `Cầu 2-2`,
    detail: `${twoBlocks}/${blocks.length} block có len=2`,
  };
}

/**
 * CẦU 3-3 — Block ba xen nhau: XXX-TTT-XXX
 */
function cau_33(seq) {
  if (seq.length < 12) return null;
  const blocks = parseBlocks(seq).slice(0, 6);
  if (blocks.length < 3) return null;

  const threeBlocks = blocks.filter(b => b.len >= 3).length;
  if (threeBlocks < 2) return null;

  const cur = blocks[0];
  const vote = cur.len >= 3 ? flip(cur.val) : cur.val;
  return {
    vote,
    weight: 0.95 + (threeBlocks / blocks.length) * 0.45,
    label:  `Cầu 3-3`,
    detail: `${threeBlocks}/${blocks.length} block có len≥3`,
  };
}

/**
 * CẦU 1-2 — Pattern: A-BB-A-BB (1 rồi 2)
 * Logic: Đọc chuỗi block, phát hiện pattern len [1, 2, 1, 2, ...]
 */
function cau_12(seq) {
  if (seq.length < 9) return null;
  const blocks = parseBlocks(seq).slice(0, 6);
  if (blocks.length < 4) return null;

  // Kiểm tra pattern lens: [2,1,2,1,...] hoặc [1,2,1,2,...]
  const lens = blocks.map(b => (b.len >= 2 ? 2 : 1));
  let patternScore = 0;
  for (let i = 0; i < lens.length - 1; i++) {
    if (lens[i] !== lens[i + 1]) patternScore++;
  }
  if (patternScore < Math.ceil((lens.length - 1) * 0.6)) return null;

  // Dự đoán theo block tiếp theo trong pattern
  const curLen = blocks[0].len;
  const nextExpectedLen = curLen === 1 ? 2 : 1;

  let vote;
  if (nextExpectedLen === 2 && curLen < 2) {
    vote = blocks[0].val;  // Tiếp tục block hiện tại lên đủ 2
  } else {
    vote = flip(blocks[0].val);  // Đổi sang block mới
  }

  return {
    vote,
    weight: 0.8 + (patternScore / (lens.length - 1)) * 0.5,
    label:  `Cầu 1-2`,
    detail: `Pattern 1-2 (${patternScore} bước đổi nhịp)`,
  };
}

/**
 * CẦU 2-1 — Pattern: AA-B-AA-B (2 rồi 1)
 */
function cau_21(seq) {
  if (seq.length < 9) return null;
  const blocks = parseBlocks(seq).slice(0, 6);
  if (blocks.length < 4) return null;

  // Phát hiện pattern: len[0]=2, len[1]=1, len[2]=2, len[3]=1...
  const lens = blocks.map(b => b.len);
  let match = 0;
  for (let i = 0; i < Math.min(lens.length - 1, 5); i++) {
    const expect = i % 2 === 0 ? 2 : 1;
    if (lens[i] === expect || (expect === 2 && lens[i] >= 2)) match++;
  }
  if (match < 3) return null;

  const curLen  = blocks[0].len;
  const curIdx  = 0; // Hiện đang ở index 0 của pattern
  // Xem idx 0 cần len bao nhiêu
  const needLen = curIdx % 2 === 0 ? 2 : 1;

  let vote;
  if (curLen < needLen) {
    vote = blocks[0].val; // Chưa đủ → tiếp tục
  } else {
    vote = flip(blocks[0].val); // Đủ rồi → đổi
  }

  return {
    vote,
    weight: 0.8 + (match / 5) * 0.45,
    label:  `Cầu 2-1`,
    detail: `Pattern 2-1 (khớp ${match}/5 block)`,
  };
}

/**
 * CẦU GÃY — Streak cũ dài vừa bị gãy → theo chiều mới
 * Logic: Phiên mới nhất khác phiên liền trước, streak cũ ≥ 3 → trend gãy.
 *   Streak cũ càng dài → weight cao hơn (đảo chiều rõ).
 */
function cau_Gay(seq) {
  if (seq.length < 5) return null;
  if (seq[0] === seq[1]) return null;  // Chưa gãy

  // Đo streak cũ (bắt đầu từ seq[1])
  let oldStreak = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[1]) oldStreak++;
    else break;
  }
  if (oldStreak < 3) return null;

  return {
    vote:   seq[0],  // Theo chiều mới sau khi gãy
    weight: 0.9 + Math.min(oldStreak * 0.07, 0.45),
    label:  `Cầu Gãy`,
    detail: `Streak cũ ${oldStreak} phiên vừa gãy → chiều mới ${fullLabel(seq[0])}`,
  };
}

/**
 * CẦU ZIG-ZAG NGẮN — Phát hiện chuỗi xen kẽ ngắn (3 phiên) vừa xuất hiện
 *   rồi dự đoán sẽ bệt.
 * Logic: 3 phiên gần nhất là T-X-T hoặc X-T-X nhưng trước đó là bệt
 *   → zigzag ngắn sắp bệt lại.
 */
function cau_ZigZag(seq) {
  if (seq.length < 7) return null;

  const top3 = seq.slice(0, 3);
  const isZig = top3[0] !== top3[1] && top3[1] !== top3[2] && top3[0] === top3[2];
  if (!isZig) return null;

  // Kiểm tra trước đó có bệt không
  const before = seq.slice(3, 7);
  let prevStreak = 0;
  for (const v of before) {
    if (v === before[0]) prevStreak++;
    else break;
  }
  if (prevStreak < 2) return null;

  // ZigZag ngắn giữa 2 cầu bệt → kỳ vọng quay lại bệt theo chiều sau zigzag
  return {
    vote:   seq[0],  // Theo chiều phiên mới nhất của zigzag
    weight: 0.80,
    label:  `Cầu Zig-Zag Ngắn`,
    detail: `3 phiên xen kẽ giữa 2 cầu bệt → theo ${fullLabel(seq[0])}`,
  };
}

/**
 * CẦU LƯỢN SÓNG — Blocks dao động độ dài: 1-3-1-3 hoặc 2-4-2-4
 *   Phát hiện nhịp tăng/giảm độ dài block xen kẽ.
 */
function cau_LuongSong(seq) {
  if (seq.length < 14) return null;
  const blocks = parseBlocks(seq).slice(0, 7);
  if (blocks.length < 5) return null;

  const lens = blocks.map(b => b.len);
  // Đếm số lần độ dài block xen kẽ cao-thấp hoặc thấp-cao
  let waveCount = 0;
  for (let i = 0; i < lens.length - 2; i++) {
    const isValley = lens[i] > lens[i + 1] && lens[i + 1] < lens[i + 2];
    const isPeak   = lens[i] < lens[i + 1] && lens[i + 1] > lens[i + 2];
    if (isValley || isPeak) waveCount++;
  }
  if (waveCount < 2) return null;

  // Dự đoán dựa trên xu hướng block hiện tại
  const curLen  = lens[0];
  const prevLen = lens[1] ?? 1;
  let vote;
  if (curLen > prevLen) {
    // Block đang dài ra → sắp rút ngắn và đổi chiều
    vote = flip(blocks[0].val);
  } else {
    // Block đang ngắn lại → theo tiếp
    vote = blocks[0].val;
  }

  return {
    vote,
    weight: 0.72 + (waveCount / (lens.length - 2)) * 0.35,
    label:  `Cầu Lượn Sóng`,
    detail: `${waveCount} đỉnh/đáy sóng trong ${blocks.length} block`,
  };
}

/**
 * CẦU KÉP — 2 lần liên tiếp cùng chiều rồi đổi (pattern AABB)
 *   Phát hiện bằng cách nhìn 8 phiên gần nhất.
 */
function cau_Kep(seq) {
  if (seq.length < 8) return null;
  const top8 = seq.slice(0, 8);

  // Nhóm thành cặp
  const pairs = [];
  for (let i = 0; i < 8; i += 2) {
    if (top8[i] === top8[i + 1]) pairs.push({ same: true, val: top8[i] });
    else pairs.push({ same: false });
  }
  const allSamePair = pairs.filter(p => p.same).length;
  if (allSamePair < 3) return null;

  // Nếu cặp mới nhất đã có 2 phiên same → đổi
  if (pairs[0].same) {
    return {
      vote:   flip(pairs[0].val),
      weight: 0.85 + (allSamePair / 4) * 0.35,
      label:  `Cầu Kép (AABB)`,
      detail: `${allSamePair}/4 cặp đôi trong 8 phiên → Đổi sang ${fullLabel(flip(pairs[0].val))}`,
    };
  }
  return null;
}

/**
 * CẦU 1-3 — Pattern: A-BBB-A-BBB
 */
function cau_13(seq) {
  if (seq.length < 12) return null;
  const blocks = parseBlocks(seq).slice(0, 6);
  if (blocks.length < 4) return null;

  const lens = blocks.map(b => b.len);
  // Kiểm tra xen kẽ 1 và 3
  let matchScore = 0;
  for (let i = 0; i < Math.min(lens.length, 6); i++) {
    const expected = i % 2 === 0 ? 3 : 1;
    if (Math.abs(lens[i] - expected) <= 1) matchScore++;
  }
  if (matchScore < 3) return null;

  const curLen = blocks[0].len;
  let vote;
  if (curLen < 3 && blocks.length > 1 && blocks[1].len === 1) {
    vote = blocks[0].val;  // Đang xây block 3, tiếp tục
  } else if (curLen >= 3) {
    vote = flip(blocks[0].val);  // Đủ 3 rồi → đổi
  } else {
    return null;
  }

  return {
    vote,
    weight: 0.82 + (matchScore / 6) * 0.38,
    label:  `Cầu 1-3`,
    detail: `Pattern 1-3 (khớp ${matchScore}/6 block)`,
  };
}

// ══════════════════════════════════════════════════════════════
//  TẦNG 2 — THỐNG KÊ XÁC SUẤT (Statistical)
// ══════════════════════════════════════════════════════════════

/**
 * MARKOV CHAIN BẬC 1–4 — Weighted ensemble
 * Bậc cao hơn có weight cao hơn nhưng cần nhiều mẫu hơn.
 */
function algo_Markov(hist) {
  const seq = hist.map(h => h.kq).filter(Boolean);
  if (seq.length < 6) return null;
  const n = seq.length;

  // Build tables ngược (mới nhất ở đầu → oldest ở cuối)
  // Nhưng seq đã được lưu theo thứ tự cũ → mới
  // hist[0] = cũ nhất, hist[n-1] = mới nhất
  // seq[i] tương ứng hist[i].kq

  const build = (order) => {
    const tbl = {};
    for (let i = order; i < seq.length; i++) {
      const key = seq.slice(i - order, i).join('');
      const next = seq[i];
      if (!tbl[key]) tbl[key] = { T: 0, X: 0 };
      tbl[key][next]++;
    }
    return tbl;
  };

  const scores  = { T: 0, X: 0 };
  let   totW    = 0;
  const details = {};

  const orders = [
    { order: 4, w: 0.40, minSample: 2 },
    { order: 3, w: 0.30, minSample: 2 },
    { order: 2, w: 0.20, minSample: 2 },
    { order: 1, w: 0.10, minSample: 3 },
  ];

  for (const { order, w, minSample } of orders) {
    if (seq.length <= order) continue;
    const tbl = build(order);
    const key = seq.slice(n - order, n).join('');
    const row = tbl[key];
    if (!row) continue;
    const total = row.T + row.X;
    if (total < minSample) continue;
    scores.T += w * (row.T / total);
    scores.X += w * (row.X / total);
    totW += w;
    details[`bac${order}`] = { key, T: row.T, X: row.X, total,
      probT: `${Math.round(row.T / total * 100)}%`,
      probX: `${Math.round(row.X / total * 100)}%` };
  }

  if (totW === 0) return null;
  const normT = scores.T / totW;
  const normX = scores.X / totW;
  const vote  = normT >= normX ? 'T' : 'X';
  const raw   = Math.max(normT, normX);

  return {
    vote,
    weight: 0.7 + raw * 0.6,
    label:  `Markov Bậc 1-4`,
    detail: `T=${(normT * 100).toFixed(1)}% X=${(normX * 100).toFixed(1)}%`,
    markovDetails: details,
  };
}

/**
 * MEAN REVERSION — Nếu T hoặc X chiếm quá nhiều → bù lại
 * Ngưỡng lệch ≥ 10% so với 50/50.
 */
function algo_MeanReversion(hist) {
  const seq = hist.slice(-40).map(h => h.kq).filter(Boolean);
  if (seq.length < 15) return null;

  const tai = seq.filter(v => v === 'T').length;
  const pT  = tai / seq.length;
  const dev = pT - 0.5;

  if (Math.abs(dev) < 0.10) return null;

  const vote   = dev > 0 ? 'X' : 'T';
  const strength = Math.min(Math.abs(dev) * 2, 1);

  return {
    vote,
    weight: 0.55 + strength * 0.65,
    label:  `Mean Reversion`,
    detail: `Tài chiếm ${(pT * 100).toFixed(1)}% (lệch ${dev > 0 ? '+' : ''}${(dev * 100).toFixed(1)}%)`,
  };
}

/**
 * ENTROPY & MOMENTUM — Đo tính hỗn loạn + xu hướng gần
 *   Entropy thấp = cầu ổn định → theo momentum
 *   Entropy cao  = hỗn loạn → bù lại chiều lệch
 */
function algo_EntropyMomentum(hist) {
  const seq = hist.slice(-25).map(h => h.kq).filter(Boolean);
  if (seq.length < 10) return null;

  const tai = seq.filter(v => v === 'T').length;
  const pT  = tai / seq.length;
  const pX  = 1 - pT;
  const eps = 1e-9;
  const H   = -(pT * Math.log2(pT + eps) + pX * Math.log2(pX + eps));

  // Momentum: chuỗi 10 phiên gần nhất (index 0 = mới nhất)
  const recent = [...seq].reverse().slice(0, 10);
  let momentum = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    const w = Math.pow(0.82, i);
    momentum += (recent[i] === recent[i + 1] ? 1 : -1) * w;
  }

  let vote;
  if (H < 0.85) {
    // Ổn định → theo momentum
    vote = momentum >= 0 ? recent[0] : flip(recent[0]);
  } else {
    // Hỗn loạn → revert về chiều ít
    vote = pT < pX ? 'T' : 'X';
  }

  return {
    vote,
    weight: 0.62 + (1 - H) * 0.55,
    label:  `Entropy & Momentum`,
    detail: `H=${H.toFixed(2)}, M=${momentum.toFixed(2)}`,
  };
}

/**
 * PATTERN MATCHING — Tìm chuỗi quá khứ giống nhất → dự đoán theo sau đó
 * Window 6 phiên, so sánh trong 150 phiên lịch sử.
 */
function algo_PatternMatch(hist, windowSize = 6) {
  const raw = hist.map(h => h.kq).filter(Boolean);
  if (raw.length < windowSize * 2 + 3) return null;

  // raw: oldest→newest
  const n       = raw.length;
  const recent  = raw.slice(n - windowSize); // 6 phiên mới nhất

  const candidates = [];
  const maxScore   = windowSize;

  for (let i = 0; i <= n - windowSize - 1; i++) {
    const candidate = raw.slice(i, i + windowSize);
    let score = 0;
    for (let j = 0; j < windowSize; j++) {
      if (recent[j] === candidate[j]) score += Math.pow(0.88, windowSize - 1 - j);
    }
    const next = raw[i + windowSize];
    if (next) candidates.push({ score, next });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 7);

  const normMax = (1 - Math.pow(0.88, windowSize)) / (1 - 0.88);
  if (top[0].score < normMax * 0.45) return null;

  const votes = { T: 0, X: 0 };
  for (const c of top) {
    const w = c.score / normMax;
    votes[c.next] += w;
  }

  const total = votes.T + votes.X || 1;
  const vote  = votes.T >= votes.X ? 'T' : 'X';
  const raw2  = Math.max(votes.T, votes.X) / total;

  return {
    vote,
    weight: 0.6 + raw2 * 0.85,
    label:  `Pattern Matching`,
    detail: `Best match ${(top[0].score / normMax * 100).toFixed(0)}%, top-7 vote T=${votes.T.toFixed(2)} X=${votes.X.toFixed(2)}`,
  };
}

/**
 * AUTOCORRELATION — Phát hiện chu kỳ lặp lại (lag 2–8)
 */
function algo_Autocorr(hist) {
  const raw = hist.slice(-60).map(h => h.kq).filter(Boolean);
  if (raw.length < 20) return null;

  const bin = raw.map(v => (v === 'T' ? 1 : -1));
  const n   = bin.length;

  let bestLag = -1, bestAbsCorr = -1, bestRawCorr = 0;
  for (let lag = 2; lag <= 8; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) corr += bin[i] * bin[i + lag];
    corr /= (n - lag);
    if (Math.abs(corr) > bestAbsCorr) {
      bestAbsCorr = Math.abs(corr);
      bestRawCorr = corr;
      bestLag     = lag;
    }
  }

  if (bestAbsCorr < 0.18 || bestLag < 2) return null;

  // Phiên cách bestLag so với hiện tại
  const refVal = raw[n - 1 - bestLag];
  const curVal = raw[n - 1];

  let vote;
  if (bestRawCorr > 0) {
    // Tương quan dương → lặp lại pattern
    vote = refVal === curVal ? curVal : flip(curVal);
  } else {
    // Tương quan âm → đảo ngược
    vote = refVal !== curVal ? curVal : flip(curVal);
  }

  return {
    vote,
    weight: 0.52 + bestAbsCorr * 0.75,
    label:  `Autocorrelation`,
    detail: `Lag=${bestLag}, corr=${bestRawCorr.toFixed(3)}`,
  };
}

// ══════════════════════════════════════════════════════════════
//  TẦNG 3 — PHÂN TÍCH XÚC XẮC (Dice Analysis)
// ══════════════════════════════════════════════════════════════

/** Phân loại xúc xắc */
function classifyDice(dice) {
  if (!dice || dice.length !== 3) return { type: 'unknown', detail: '?' };
  const [a, b, c] = [...dice].sort((x, y) => x - y);
  if (a === b && b === c)         return { type: 'triple',   detail: `Ba ${a}` };
  if (a === b || b === c)         return { type: 'double',   detail: `Đôi ${a === b ? a : b}` };
  if (c - a === 2 && b - a === 1) return { type: 'sequence', detail: `Seri ${a}-${b}-${c}` };
  return { type: 'mixed', detail: `${a}-${b}-${c}` };
}

/**
 * DICE FREQUENCY — Kỳ vọng tổng dựa trên tần suất mặt xúc xắc
 *   hot face → expected total cao/thấp → vote T/X
 */
function algo_DiceFreq(hist) {
  const recent = hist.filter(h => h.dice?.length === 3).slice(-25);
  if (recent.length < 8) return null;

  const freq = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let total  = 0;
  for (const h of recent) {
    for (const d of h.dice) {
      if (d >= 1 && d <= 6) { freq[d]++; total++; }
    }
  }
  if (total < 15) return null;

  let expPerDie = 0;
  for (let f = 1; f <= 6; f++) expPerDie += f * (freq[f] / total);
  const expTotal = expPerDie * 3;
  const dev      = Math.abs(expTotal - 10.5) / 3.5;
  if (dev < 0.08) return null;

  const vote  = expTotal >= 10.5 ? 'T' : 'X';
  const hot   = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => +e[0]);

  return {
    vote,
    weight: 0.50 + dev * 0.55,
    label:  `Dice Frequency`,
    detail: `E[tổng]=${expTotal.toFixed(2)}, mặt nóng: ${hot.join(',')}`,
    freq,
  };
}

/**
 * DICE STREAK — Nếu 3 phiên liên tiếp cùng loại (triple/double) → xu hướng
 */
function algo_DiceStreak(hist) {
  const recent = hist.slice(-5).filter(h => h.dice?.length === 3);
  if (recent.length < 3) return null;

  const types = recent.map(h => classifyDice(h.dice).type);
  const last3  = types.slice(-3);

  if (last3.every(t => t === 'triple')) {
    const tong = recent[recent.length - 1].tong;
    return {
      vote:   tong >= 11 ? 'T' : 'X',
      weight: 0.70,
      label:  `Dice Triple Streak`,
      detail: `3 phiên ba xúc xắc liên tiếp`,
    };
  }

  if (last3.every(t => t === 'double')) {
    // Giá trị double đang tăng/giảm?
    const vals = recent.slice(-3).map(h => {
      const cls = classifyDice(h.dice);
      return cls.type === 'double' ? h.tong : null;
    }).filter(v => v !== null);

    if (vals.length === 3) {
      const trend = vals[2] > vals[1] && vals[1] > vals[0] ? 'T'
                  : vals[2] < vals[1] && vals[1] < vals[0] ? 'X'
                  : null;
      if (trend) return {
        vote:   trend,
        weight: 0.65,
        label:  `Dice Double Trend`,
        detail: `Double tổng ${vals.join('→')} (${trend === 'T' ? 'tăng→Tài' : 'giảm→Xỉu'})`,
      };
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
//  META-LEARNING — Tracking độ chính xác từng algo
// ══════════════════════════════════════════════════════════════

function updateMeta(name, predicted, actual) {
  if (!algoMeta[name]) algoMeta[name] = { hits: 0, total: 0, recent: [] };
  const m     = algoMeta[name];
  const isHit = predicted === actual ? 1 : 0;
  m.recent.push(isHit);
  if (m.recent.length > CFG.ACC_WINDOW) m.recent.shift();
  m.hits  = m.recent.reduce((a, b) => a + b, 0);
  m.total = m.recent.length;
}

/**
 * Tính weight điều chỉnh dựa trên accuracy gần nhất.
 *   acc 50% → scale 1.0
 *   acc 65% → scale ~2.0
 *   acc 35% → scale ~0.1
 */
function adjustedWeight(name, base) {
  const m = algoMeta[name];
  if (!m || m.total < 10) return base;
  const acc   = m.hits / m.total;
  const scale = Math.max(0.10, Math.min(2.2, (acc - 0.36) / 0.14));
  return base * scale;
}

// ══════════════════════════════════════════════════════════════
//  TẦNG 4 — ENSEMBLE VOTING
// ══════════════════════════════════════════════════════════════

const ALGO_LIST = [
  // Tầng 1: Cầu
  { name: 'cauBet',       group: 'cau',  fn: hist => cau_Bet(getSeq(hist))       },
  { name: 'cau11',        group: 'cau',  fn: hist => cau_11(getSeq(hist))        },
  { name: 'cau22',        group: 'cau',  fn: hist => cau_22(getSeq(hist))        },
  { name: 'cau33',        group: 'cau',  fn: hist => cau_33(getSeq(hist))        },
  { name: 'cau12',        group: 'cau',  fn: hist => cau_12(getSeq(hist))        },
  { name: 'cau21',        group: 'cau',  fn: hist => cau_21(getSeq(hist))        },
  { name: 'cauGay',       group: 'cau',  fn: hist => cau_Gay(getSeq(hist))       },
  { name: 'cauZigZag',    group: 'cau',  fn: hist => cau_ZigZag(getSeq(hist))    },
  { name: 'cauLuongSong', group: 'cau',  fn: hist => cau_LuongSong(getSeq(hist)) },
  { name: 'cauKep',       group: 'cau',  fn: hist => cau_Kep(getSeq(hist))       },
  { name: 'cau13',        group: 'cau',  fn: hist => cau_13(getSeq(hist))        },
  // Tầng 2: Thống kê
  { name: 'markov',       group: 'stat', fn: algo_Markov            },
  { name: 'meanRev',      group: 'stat', fn: algo_MeanReversion     },
  { name: 'entropy',      group: 'stat', fn: algo_EntropyMomentum   },
  { name: 'patternMatch', group: 'stat', fn: algo_PatternMatch      },
  { name: 'autocorr',     group: 'stat', fn: algo_Autocorr          },
  // Tầng 3: Xúc xắc
  { name: 'diceFreq',     group: 'dice', fn: algo_DiceFreq          },
  { name: 'diceStreak',   group: 'dice', fn: algo_DiceStreak        },
];

// Hệ số nhóm (cân bằng tỉ trọng giữa 3 tầng)
const GROUP_COEFF = { cau: 1.0, stat: 1.05, dice: 0.80 };

function ensembleVote(hist) {
  if (hist.length < CFG.MIN_SAMPLE_PRED) return null;

  const votes    = { T: 0, X: 0 };
  const details  = [];
  let   totalW   = 0;

  for (const { name, group, fn } of ALGO_LIST) {
    let r = null;
    try { r = fn(hist); } catch {}

    if (!r) {
      details.push({ name, group, vote: null, status: 'N/A' });
      continue;
    }

    const baseW = r.weight ?? 1.0;
    const adjW  = adjustedWeight(name, baseW) * (GROUP_COEFF[group] ?? 1.0);

    votes[r.vote] += adjW;
    totalW        += adjW;

    const m = algoMeta[name];
    details.push({
      name,
      group,
      label:    r.label,
      vote:     r.vote,
      voteLabel: fullLabel(r.vote),
      detail:   r.detail,
      baseW:    +baseW.toFixed(3),
      adjW:     +adjW.toFixed(3),
      accuracy: m && m.total >= 10
        ? `${(m.hits / m.total * 100).toFixed(1)}% (${m.hits}/${m.total})`
        : 'chưa đủ mẫu',
    });
  }

  if (totalW === 0) return null;

  const rawT    = votes.T / totalW;
  const rawX    = votes.X / totalW;
  const winner  = rawT >= rawX ? 'T' : 'X';
  const rawConf = Math.max(rawT, rawX);
  const conf    = calibrateConf(rawConf);

  const voted   = details.filter(d => d.vote !== null);
  const forWin  = voted.filter(d => d.vote === winner).length;

  let clarity;
  if (rawConf >= 0.74) clarity = 'Rõ ràng';
  else if (rawConf >= 0.63) clarity = 'Khá rõ';
  else if (rawConf >= 0.56) clarity = 'Trung bình';
  else clarity = 'Không rõ – Cân nhắc bỏ qua';

  // Phát hiện cầu đang chạy nổi bật nhất
  const cauAlgos = details.filter(d => d.group === 'cau' && d.vote === winner);
  const topCau   = cauAlgos.sort((a, b) => b.adjW - a.adjW)[0];

  return {
    winner,
    conf,
    rawConf:  +rawConf.toFixed(4),
    clarity,
    votes:    { T: +votes.T.toFixed(3), X: +votes.X.toFixed(3) },
    votePct:  { T: `${(rawT * 100).toFixed(1)}%`, X: `${(rawX * 100).toFixed(1)}%` },
    algoVoted: `${forWin}/${voted.length}`,
    topCau:   topCau?.label ?? null,
    details,
  };
}

// ══════════════════════════════════════════════════════════════
//  FETCH & UPDATE
// ══════════════════════════════════════════════════════════════

let latestResult    = null;
let pendingPred     = null;  // { phien, predicted, conf, algoVoted }

async function fetchAndUpdate() {
  try {
    const res  = await fetch(SOURCE_API, { signal: AbortSignal.timeout(9000) });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;

    const sorted  = [...data].sort((a, b) => a.session - b.session);
    const latest  = sorted[sorted.length - 1];
    const knownSet = new Set(history.map(h => h.phien));

    for (const item of sorted) {
      const phien = String(item.session);
      if (knownSet.has(phien)) continue;

      const dice = Array.isArray(item.dice) && item.dice.length === 3
        ? item.dice.map(Number) : null;
      const tong = typeof item.total === 'number'
        ? item.total : (dice ? dice.reduce((a, b) => a + b, 0) : 0);
      const kq = item.ket_qua === 'Tài' ? 'T'
               : item.ket_qua === 'Xỉu' ? 'X'
               : (tong >= 3 ? label(tong) : null);

      if (!kq) continue;
      history.push({ phien, dice, tong, kq });
      knownSet.add(phien);

      // Đánh giá dự đoán cũ
      if (pendingPred && pendingPred.phien === phien) {
        const win = pendingPred.predicted === kq;

        // Cập nhật meta-learning cho từng algo
        if (pendingPred.algoVotes) {
          for (const [name, vote] of Object.entries(pendingPred.algoVotes)) {
            updateMeta(name, vote, kq);
          }
        }

        winLoss.push({
          phien,
          predicted:    fullLabel(pendingPred.predicted),
          actual:       fullLabel(kq),
          tong,
          win,
          conf:         pendingPred.conf,
          topCau:       pendingPred.topCau,
          algoVoted:    pendingPred.algoVoted,
          clarity:      pendingPred.clarity,
        });
        if (winLoss.length > CFG.MAX_WIN_LOSS) winLoss = winLoss.slice(-100);
        pendingPred = null;
      }
    }

    if (history.length > CFG.MAX_HISTORY) history = history.slice(-CFG.MAX_HISTORY);

    // Dự đoán phiên tiếp theo
    const ens     = ensembleVote(history);
    const phienN  = String(Number(latest.session) + 1);

    if (ens) {
      // Ghi nhận để đánh giá sau
      const algoVotes = {};
      for (const d of ens.details) {
        if (d.vote) algoVotes[d.name] = d.vote;
      }
      pendingPred = {
        phien:      phienN,
        predicted:  ens.winner,
        conf:       ens.conf,
        topCau:     ens.topCau,
        algoVoted:  ens.algoVoted,
        clarity:    ens.clarity,
        algoVotes,
      };
    }

    const latestTong = typeof latest.total === 'number'
      ? latest.total
      : (Array.isArray(latest.dice) ? latest.dice.reduce((a, b) => a + b, 0) : 0);
    const latestKq = latestTong >= 3 ? label(latestTong) : null;
    const pattern  = history.slice(-30).map(h => h.kq).join('');

    latestResult = {
      id:            '@sewdangcap',
      phien:         latest.session,
      ket_qua:       fullLabel(latestKq),
      tong:          latestTong,
      xuc_xac:       Array.isArray(latest.dice) ? latest.dice.map(Number) : null,
      phan_loai:     Array.isArray(latest.dice) ? classifyDice(latest.dice.map(Number)).detail : null,
      phien_du_doan: Number(phienN),
      du_doan: ens ? {
        ket_qua:     fullLabel(ens.winner),
        luot_danh:   ens.winner === 'T' ? 'TÀI' : 'XỈU',
        do_tin_cay:  `${ens.conf}%`,
        muc_do:      ens.clarity,
        ty_le:       ens.votePct,
        cau_noi_bat: ens.topCau,
        so_algo:     ens.algoVoted,
      } : null,
      pattern: pattern.split('').map(v => (v === 'T' ? 'T' : 'X')).join(''),
    };

    return latestResult;

  } catch (e) {
    console.error('[fetchAndUpdate]', e.message);
    return null;
  }
}

// ─── Polling mỗi 5 giây ───────────────────────────────────────
(async () => { await fetchAndUpdate(); })();
setInterval(fetchAndUpdate, 5000);

// ══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// ── / — Dashboard ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tài Xỉu API v5.0 — @sewdangcap</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',sans-serif;
    min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:24px}
  h1{font-size:2rem;font-weight:700;margin-bottom:6px;color:#58a6ff}
  .sub{color:#8b949e;font-size:.9rem;margin-bottom:4px}
  .ver{color:#3fb950;font-size:.8rem;margin-bottom:36px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
    gap:14px;width:100%;max-width:1000px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;
    padding:24px 20px;cursor:pointer;transition:all .2s;text-decoration:none;
    color:inherit;display:block}
  .card:hover{border-color:#58a6ff;transform:translateY(-3px);
    box-shadow:0 10px 30px rgba(88,166,255,.15)}
  .card .icon{font-size:1.8rem;margin-bottom:10px;display:block}
  .card h2{font-size:1rem;margin-bottom:6px;color:#58a6ff;font-weight:600}
  .card p{font-size:.8rem;color:#8b949e;line-height:1.6}
  .card .path{display:inline-block;margin-top:12px;font-size:.72rem;
    color:#3fb950;background:#1a2e1a;border:1px solid #2ea04326;
    padding:2px 9px;border-radius:20px;font-family:monospace}
  .badge{display:inline-block;background:#f97316;color:#fff;font-size:.62rem;
    font-weight:700;padding:2px 6px;border-radius:20px;margin-left:4px;vertical-align:middle}
  footer{margin-top:40px;color:#484f58;font-size:.78rem}
</style>
</head>
<body>
<h1>🎲 Tài Xỉu Prediction API</h1>
<p class="sub">DEV @sewdangcap</p>
<p class="ver">v5.0 — Cầu Thực Chiến + Markov 1-4 + Dice + Ensemble Meta-learning</p>
<div class="grid">
  <a class="card" href="/sunlon">
    <span class="icon">⚡</span>
    <h2>Dự đoán Realtime</h2>
    <p>Kết quả mới nhất + dự đoán phiên tiếp theo với ensemble 18 thuật toán.</p>
    <span class="path">GET /sunlon</span>
  </a>
  <a class="card" href="/cau-debug">
    <span class="icon">🔍</span>
    <h2>Debug Cầu <span class="badge">NEW</span></h2>
    <p>Xem chi tiết vote từng thuật toán cầu + thống kê cho phiên hiện tại.</p>
    <span class="path">GET /cau-debug</span>
  </a>
  <a class="card" href="/thongke">
    <span class="icon">📊</span>
    <h2>Thống kê Thắng/Thua</h2>
    <p>Win rate, streak, phân tích theo độ tin cậy và loại cầu.</p>
    <span class="path">GET /thongke</span>
  </a>
  <a class="card" href="/history">
    <span class="icon">📜</span>
    <h2>Lịch sử Phiên</h2>
    <p>50 phiên gần nhất: xúc xắc, tổng, phân loại Triple/Double/Seri.</p>
    <span class="path">GET /history</span>
  </a>
  <a class="card" href="/markov-table">
    <span class="icon">🧮</span>
    <h2>Bảng Markov</h2>
    <p>Ma trận chuyển trạng thái bậc 1–4 từ toàn bộ lịch sử.</p>
    <span class="path">GET /markov-table</span>
  </a>
  <a class="card" href="/dice-stats">
    <span class="icon">🎲</span>
    <h2>Thống kê Xúc xắc</h2>
    <p>Tần suất mặt, mặt nóng/lạnh, tỉ lệ Triple/Double/Seri.</p>
    <span class="path">GET /dice-stats</span>
  </a>
  <a class="card" href="/algo-accuracy">
    <span class="icon">🏆</span>
    <h2>Xếp hạng Thuật toán</h2>
    <p>Độ chính xác từng thuật toán, tự động điều chỉnh trọng số theo thời gian.</p>
    <span class="path">GET /algo-accuracy</span>
  </a>
</div>
<footer>© 2025 DEV @sewdangcap — All rights reserved</footer>
</body>
</html>`);
});

// ── /sunlon — Dự đoán realtime ──────────────────────────────
app.get('/sunlon', async (req, res) => {
  if (!latestResult) {
    const d = await fetchAndUpdate();
    if (!d) return res.status(503).json({ error: 'Đang khởi động, thử lại sau...' });
  }
  res.json(latestResult);
});

// ── /cau-debug — Chi tiết từng algo ──────────────────────────
app.get('/cau-debug', (req, res) => {
  if (history.length < CFG.MIN_SAMPLE_PRED)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const ens     = ensembleVote(history);
  const cur     = history[history.length - 1];
  const seq     = getSeq(history, 30);
  const blocks  = parseBlocks(seq).slice(0, 8);

  res.json({
    id:            '@sewdangcap',
    phien_hien_tai: Number(cur.phien),
    tong:          cur.tong,
    xuc_xac:       cur.dice,
    ket_qua:       fullLabel(cur.kq),
    chuoi_20_phien_gan_nhat: seq.slice(0, 20).join(''),
    phan_tich_block: blocks.map(b => ({ val: fullLabel(b.val), len: b.len })),
    ket_qua_ensemble: ens ? {
      du_doan:     fullLabel(ens.winner),
      do_tin_cay:  `${ens.conf}%`,
      muc_do:      ens.clarity,
      ty_le_bieu_quyet: ens.votePct,
      cau_noi_bat: ens.topCau,
      so_algo_bieu_quyet: ens.algoVoted,
    } : null,
    chi_tiet_algo: ens ? ens.details.map(d => ({
      nhom:     d.group,
      ten:      d.label ?? d.name,
      bieu_quyet: d.vote ? fullLabel(d.vote) : 'Không tham gia',
      chi_tiet: d.detail ?? '-',
      trong_so: d.adjW ?? 0,
      accuracy: d.accuracy ?? '-',
    })) : [],
  });
});

// ── /thongke — Thống kê thắng thua ───────────────────────────
app.get('/thongke', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const slice = winLoss.slice(-limit).reverse();
  const wins  = slice.filter(r => r.win).length;
  const loses = slice.length - wins;
  const rate  = slice.length ? Math.round(wins / slice.length * 100) : 0;

  // Streak hiện tại
  let streak = 0, streakType = null;
  for (const r of slice) {
    if (streakType === null) { streakType = r.win; streak = 1; }
    else if (r.win === streakType) streak++;
    else break;
  }

  // Phân tích theo confidence tier
  const tiers = { cao: { win: 0, total: 0 }, tb: { win: 0, total: 0 }, thap: { win: 0, total: 0 } };
  for (const r of slice) {
    const tier = r.conf >= 75 ? 'cao' : r.conf >= 62 ? 'tb' : 'thap';
    tiers[tier].total++;
    if (r.win) tiers[tier].win++;
  }
  const theo_do_tin_cay = {};
  for (const [k, v] of Object.entries(tiers)) {
    theo_do_tin_cay[k === 'cao' ? '≥75%' : k === 'tb' ? '62–74%' : '<62%'] = {
      win:      v.win,
      total:    v.total,
      win_rate: v.total ? `${Math.round(v.win / v.total * 100)}%` : '-',
    };
  }

  res.json({
    id: '@sewdangcap',
    tong_quan: {
      tong_phien:      slice.length,
      thang:           wins,
      thua:            loses,
      win_rate:        `${rate}%`,
      streak_hien_tai: streak > 0
        ? `${streak} ${streakType ? 'THẮNG' : 'THUA'} liên tiếp`
        : 'Chưa có dữ liệu',
    },
    theo_do_tin_cay,
    chi_tiet: slice.slice(0, limit).map((r, i) => ({
      stt:          i + 1,
      phien:        Number(r.phien),
      du_doan:      r.predicted,
      ket_qua_thuc: r.actual,
      tong:         r.tong,
      do_tin_cay:   `${r.conf}%`,
      muc_do:       r.clarity,
      cau_noi_bat:  r.topCau,
      ket_luan:     r.win ? '✅ THẮNG' : '❌ THUA',
    })),
  });
});

// ── /history ──────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const data  = history.slice(-limit).reverse().map(h => ({
    phien:     Number(h.phien),
    xuc_xac:   h.dice,
    phan_loai: h.dice ? classifyDice(h.dice).detail : '-',
    tong:      h.tong,
    ket_qua:   fullLabel(h.kq),
  }));
  const pattern = history.slice(-30).map(h => h.kq).join('');
  res.json({ id: '@sewdangcap', tong: history.length, pattern, data });
});

// ── /markov-table ─────────────────────────────────────────────
app.get('/markov-table', (req, res) => {
  if (history.length < 5)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const raw = history.map(h => h.kq).filter(Boolean);
  const n   = raw.length;

  const build = (order) => {
    const tbl = {};
    for (let i = order; i < n; i++) {
      const key = raw.slice(i - order, i).join('');
      const nxt = raw[i];
      if (!tbl[key]) tbl[key] = { T: 0, X: 0 };
      tbl[key][nxt]++;
    }
    const out = {};
    for (const [k, v] of Object.entries(tbl)) {
      const tot = v.T + v.X;
      out[k] = { T: v.T, X: v.X, total: tot,
        probT: `${Math.round(v.T / tot * 100)}%`,
        probX: `${Math.round(v.X / tot * 100)}%` };
    }
    return out;
  };

  res.json({
    id: '@sewdangcap',
    tong_phien: n,
    bac_1: build(1),
    bac_2: build(2),
    bac_3: build(3),
    ghi_chu: 'Key = chuỗi phiên trước (T/X). probT/probX = xác suất phiên tiếp.',
  });
});

// ── /dice-stats ───────────────────────────────────────────────
app.get('/dice-stats', (req, res) => {
  const n = Math.min(Number(req.query.n) || 30, 200);
  const slice = history.filter(h => h.dice?.length === 3).slice(-n);
  if (slice.length < 3) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const freq = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let   tot  = 0;
  for (const h of slice) for (const d of h.dice) { if (d >= 1 && d <= 6) { freq[d]++; tot++; } }

  const typeCount = { triple: 0, double: 0, sequence: 0, mixed: 0, unknown: 0 };
  for (const h of slice) {
    const cls = classifyDice(h.dice);
    typeCount[cls.type] = (typeCount[cls.type] ?? 0) + 1;
  }

  const freqPct = {};
  for (const [k, v] of Object.entries(freq))
    freqPct[k] = { count: v, pct: tot ? `${Math.round(v / tot * 100)}%` : '0%' };

  const hot  = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => +e[0]);
  const cold = Object.entries(freq).sort((a, b) => a[1] - b[1]).slice(0, 2).map(e => +e[0]);

  res.json({
    id: '@sewdangcap',
    phan_tich: `${slice.length} phiên gần nhất`,
    tan_suat_mat: freqPct,
    mat_hot: hot, mat_cold: cold,
    ty_le_loai: Object.fromEntries(
      Object.entries(typeCount).map(([k, v]) => [k, {
        count: v, pct: `${Math.round(v / slice.length * 100)}%`
      }])
    ),
  });
});

// ── /algo-accuracy — Xếp hạng thuật toán ─────────────────────
app.get('/algo-accuracy', (req, res) => {
  const ranking = ALGO_LIST.map(({ name, group }) => {
    const m = algoMeta[name];
    return {
      name,
      group,
      accuracy: m && m.total >= 10 ? `${(m.hits / m.total * 100).toFixed(1)}%` : 'chưa đủ mẫu',
      hits:     m?.hits ?? 0,
      total:    m?.total ?? 0,
    };
  })
  .filter(r => r.total >= 5)
  .sort((a, b) => parseFloat(b.accuracy) - parseFloat(a.accuracy));

  res.json({
    id:      '@sewdangcap',
    window:  CFG.ACC_WINDOW,
    ranking,
    ghi_chu: `Trọng số algo tự điều chỉnh sau mỗi ${CFG.ACC_WINDOW} phiên đánh giá.`,
  });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({
    error: 'Endpoint không tồn tại',
    endpoints: ['/', '/sunlon', '/cau-debug', '/thongke', '/history',
                '/markov-table', '/dice-stats', '/algo-accuracy'],
  })
);

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`
🎲 Tài Xỉu API v5.0 — DEV @sewdangcap
   http://localhost:${PORT}
   Source: ${SOURCE_API}
   Algorithms: Cầu×11 + Markov + Stat×5 + Dice×2 = 18 thuật toán
   Endpoints: /sunlon  /cau-debug  /thongke  /history
              /markov-table  /dice-stats  /algo-accuracy
`)
);
