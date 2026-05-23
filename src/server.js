/**
 * ============================================================
 *  SIC BO PREDICTION API  —  DEV @sewdangcap
 *  v4.0 — Sunwin Rules + Markov Bậc 1-2-3 + Dice Pattern
 *          + MODULE 5: Cầu / Điểm Số / Vị Xúc Xắc Algorithm
 * ============================================================
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = 'https://apisunlichsu.onrender.com/api/taixiu/history';

// ─── In-memory store ──────────────────────────────────────────
let history = [];
let winLoss = [];

// ─── Helpers ──────────────────────────────────────────────────
const isTai   = t => t >= 11 && t <= 18;
const isXiu   = t => t >= 3  && t <= 10;
const isChan  = t => t % 2 === 0;
const isLe    = t => t % 2 !== 0;
const label   = t => isTai(t) ? 'T' : 'X';
const fullLabel = t => isTai(t) ? 'Tài' : 'Xỉu';

// ═══════════════════════════════════════════════════════════════
//  MODULE 1 — QUY TẮC SUNWIN (10 Rules)
// ═══════════════════════════════════════════════════════════════
function applySunwinRules(hist) {
  const n = hist.length;
  if (n < 2) return null;

  const T1 = hist[n - 1].tong;
  const T2 = n >= 2 ? hist[n - 2].tong : null;
  const T3 = n >= 3 ? hist[n - 3].tong : null;
  const T4 = n >= 4 ? hist[n - 4].tong : null;

  if (T4 === 11 && T3 === 17 && T2 === 16 && T1 === 13)
    return { du_doan: 'Xỉu', rule: 'SW-1', nhom: 1, mo_ta: `SunwinR1: Mẫu cố định 11-17-16-13 → Bẻ Xỉu` };

  if (T4 !== null && isTai(T4) && isLe(T4) && isTai(T3) && isLe(T3) && isTai(T2) && isChan(T2) && isTai(T1) && isChan(T1))
    return { du_doan: 'Tài', rule: 'SW-2', nhom: 1, mo_ta: `SunwinR2: Mẫu TàiLẻ×2→TàiChẵn×2 → Theo tiếp Tài` };

  if (T3 !== null && isXiu(T3) && isXiu(T2) && isTai(T1) && isChan(T1))
    return { du_doan: 'Xỉu', rule: 'SW-3', nhom: 1, mo_ta: `SunwinR3: Xỉu-Xỉu nhảy lên Tài Chẵn → Bẻ Xỉu` };

  if (T3 !== null && isXiu(T1) && isXiu(T2) && isXiu(T3))
    return { du_doan: 'Tài', rule: 'SW-4', nhom: 1, mo_ta: `SunwinR4: 3 Xỉu liên tiếp → Bẻ Tài` };

  if (T2 !== null && isTai(T2) && isChan(T2) && isTai(T1) && isChan(T1) && T1 < T2)
    return { du_doan: 'Tài', rule: 'SW-5', nhom: 2, mo_ta: `SunwinR5: Tài Chẵn giảm dần ${T2}→${T1} → Tiếp Tài` };

  if (T2 !== null && isTai(T2) && isChan(T2) && isTai(T1) && isChan(T1) && T1 >= T2)
    return { du_doan: 'Xỉu', rule: 'SW-6', nhom: 2, mo_ta: `SunwinR6: Tài Chẵn ngang/tăng → Bẻ Xỉu` };

  if (T2 !== null && isTai(T2) && isChan(T2) && T1 === 11)
    return { du_doan: 'Xỉu', rule: 'SW-7', nhom: 2, mo_ta: `SunwinR7: Tài Chẵn ${T2} → Tài 11 → Bẻ Xỉu` };

  if (T2 !== null && (T2 === 13 || T2 === 11) && T1 === 10)
    return { du_doan: 'Xỉu', rule: 'SW-11', nhom: 2, mo_ta: `SunwinR11: Tài Lẻ ${T2} → Xỉu 10 → Theo tiếp Xỉu` };

  if (T2 !== null && isTai(T2) && isLe(T2) && T1 === 10)
    return { du_doan: 'Tài', rule: 'SW-8', nhom: 2, mo_ta: `SunwinR8: Tài Lẻ ${T2} → Xỉu 10 → Bẻ Tài` };

  if (T2 !== null && isXiu(T2) && isLe(T2) && isXiu(T1) && isChan(T1))
    return { du_doan: 'Tài', rule: 'SW-9', nhom: 2, mo_ta: `SunwinR9: Xỉu Lẻ → Xỉu Chẵn → Bẻ Tài` };

  if (T2 !== null && isXiu(T2) && isXiu(T1))
    return { du_doan: 'Tài', rule: 'SW-10', nhom: 3, mo_ta: `SunwinR10: 2 Xỉu liên tiếp → Bẻ Tài` };

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 2 — MARKOV CHAIN BẬC 1 / 2 / 3 / 4
// ═══════════════════════════════════════════════════════════════
function buildMarkovTables(seq) {
  const tables = { order1: {}, order2: {}, order3: {}, order4: {} };
  for (let i = 1; i < seq.length; i++) {
    const k1 = seq[i - 1];
    tables.order1[k1] = tables.order1[k1] || { T: 0, X: 0, total: 0 };
    tables.order1[k1][seq[i]]++;
    tables.order1[k1].total++;
  }
  for (let i = 2; i < seq.length; i++) {
    const k2 = seq[i - 2] + seq[i - 1];
    tables.order2[k2] = tables.order2[k2] || { T: 0, X: 0, total: 0 };
    tables.order2[k2][seq[i]]++;
    tables.order2[k2].total++;
  }
  for (let i = 3; i < seq.length; i++) {
    const k3 = seq[i - 3] + seq[i - 2] + seq[i - 1];
    tables.order3[k3] = tables.order3[k3] || { T: 0, X: 0, total: 0 };
    tables.order3[k3][seq[i]]++;
    tables.order3[k3].total++;
  }
  for (let i = 4; i < seq.length; i++) {
    const k4 = seq[i - 4] + seq[i - 3] + seq[i - 2] + seq[i - 1];
    tables.order4[k4] = tables.order4[k4] || { T: 0, X: 0, total: 0 };
    tables.order4[k4][seq[i]]++;
    tables.order4[k4].total++;
  }
  return tables;
}

const MARKOV_WEIGHTS    = { order4: 0.40, order3: 0.30, order2: 0.20, order1: 0.10 };
const MARKOV_MIN_SAMPLE = 2;

function markovPredict(seq) {
  if (seq.length < 5) return null;
  const tables = buildMarkovTables(seq);
  const n = seq.length;
  const scores = { T: 0, X: 0 };
  const details = {};
  let totalWeight = 0;

  const k4 = seq[n - 4] + seq[n - 3] + seq[n - 2] + seq[n - 1];
  const m4 = tables.order4[k4];
  if (m4 && m4.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order4;
    scores.T += w * (m4.T / m4.total);
    scores.X += w * (m4.X / m4.total);
    totalWeight += w;
    details.order4 = { key: k4, T: m4.T, X: m4.X, total: m4.total };
  }

  const k3 = seq[n - 3] + seq[n - 2] + seq[n - 1];
  const m3 = tables.order3[k3];
  if (m3 && m3.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order3;
    scores.T += w * (m3.T / m3.total);
    scores.X += w * (m3.X / m3.total);
    totalWeight += w;
    details.order3 = { key: k3, T: m3.T, X: m3.X, total: m3.total };
  }

  const k2 = seq[n - 2] + seq[n - 1];
  const m2 = tables.order2[k2];
  if (m2 && m2.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order2;
    scores.T += w * (m2.T / m2.total);
    scores.X += w * (m2.X / m2.total);
    totalWeight += w;
    details.order2 = { key: k2, T: m2.T, X: m2.X, total: m2.total };
  }

  const k1 = seq[n - 1];
  const m1 = tables.order1[k1];
  if (m1 && m1.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order1;
    scores.T += w * (m1.T / m1.total);
    scores.X += w * (m1.X / m1.total);
    totalWeight += w;
    details.order1 = { key: k1, T: m1.T, X: m1.X, total: m1.total };
  }

  if (totalWeight === 0) return null;
  const normT = scores.T / totalWeight;
  const normX = scores.X / totalWeight;
  const pred = normT >= normX ? 'T' : 'X';
  const conf = Math.round(Math.max(normT, normX) * 100);
  return { du_doan: pred === 'T' ? 'Tài' : 'Xỉu', do_tin_cay: conf, details };
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 3 — DICE PATTERN ANALYZER
// ═══════════════════════════════════════════════════════════════
function classifyDice(dice) {
  if (!dice || dice.length !== 3) return { type: 'unknown', value: null };
  const [a, b, c] = [...dice].sort((x, y) => x - y);
  if (a === b && b === c)         return { type: 'triple',   value: a,    detail: `Triple ${a}` };
  if (a === b || b === c)         return { type: 'double',   value: b,    detail: `Double ${a === b ? a : b}` };
  if (c - a === 2 && b - a === 1) return { type: 'sequence', value: null, detail: `Seq ${a}-${b}-${c}` };
  return { type: 'mixed', value: null, detail: `${a}-${b}-${c}` };
}

function diceFrequency(hist, n = 30) {
  const freq = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const slice = hist.slice(-n);
  for (const h of slice) {
    if (!h.dice) continue;
    for (const d of h.dice) {
      if (d >= 1 && d <= 6) freq[d]++;
    }
  }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  return { freq, hot: sorted.slice(0, 2).map(e => Number(e[0])), cold: sorted.slice(-2).map(e => Number(e[0])) };
}

function dicePatternPredict(hist) {
  if (hist.length < 5) return null;
  const recent = hist.slice(-5);
  const types = recent.map(h => classifyDice(h.dice));
  if (types.slice(-3).every(t => t.type === 'triple'))
    return { du_doan: 'Tài', do_tin_cay: 72, mo_ta: 'DicePattern: 3 Triple liên tiếp → Tài' };

  const last3 = hist.slice(-3);
  const allDouble = last3.every(h => classifyDice(h.dice).type === 'double');
  if (allDouble) {
    const vals = last3.map(h => classifyDice(h.dice).value);
    if (vals[0] > vals[1] && vals[1] > vals[2])
      return { du_doan: 'Xỉu', do_tin_cay: 68, mo_ta: `DicePattern: Double giảm ${vals[0]}→${vals[1]}→${vals[2]} → Xỉu` };
  }

  const { freq } = diceFrequency(hist, 20);
  const totalRolls = Object.values(freq).reduce((a, b) => a + b, 0);
  if (totalRolls < 30) return null;
  const high = (freq[5] + freq[6]) / totalRolls;
  const low  = (freq[1] + freq[2]) / totalRolls;
  if (high > 0.46) return { du_doan: 'Tài', do_tin_cay: 63, mo_ta: `DicePattern: Mặt 5+6 hot (${Math.round(high * 100)}%) → Tài` };
  if (low  > 0.46) return { du_doan: 'Xỉu', do_tin_cay: 63, mo_ta: `DicePattern: Mặt 1+2 hot (${Math.round(low  * 100)}%) → Xỉu` };
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 5 — CẦU / ĐIỂM SỐ / VỊ XÚC XẮC ALGORITHM (MỚI)
//  Nguồn: Kinh nghiệm thực chiến Sun Win @sewdangcap v4.0
// ═══════════════════════════════════════════════════════════════

/**
 * Kiểm tra xem mảng xúc xắc có khớp với một combo cụ thể không.
 * So sánh không phân biệt thứ tự.
 * @param {number[]} dice - Mảng 3 giá trị xúc xắc
 * @param {number[]} combo - Combo cần kiểm tra
 */
function diceMatch(dice, combo) {
  if (!dice || dice.length !== 3) return false;
  const sorted = [...dice].sort((a, b) => a - b);
  const sortedCombo = [...combo].sort((a, b) => a - b);
  return sorted[0] === sortedCombo[0] && sorted[1] === sortedCombo[1] && sorted[2] === sortedCombo[2];
}

/**
 * Phát hiện cầu 1-1 (xen kẽ Tài/Xỉu) trong lịch sử gần nhất.
 * @param {string[]} seq - Mảng 'T'/'X' gần nhất
 * @param {number} minLen - Độ dài tối thiểu cầu để xác nhận
 */
function detectCau11(seq, minLen = 4) {
  if (seq.length < minLen) return false;
  const tail = seq.slice(-minLen);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] === tail[i - 1]) return false;
  }
  return true;
}

/**
 * Phát hiện cầu 1-2 (1 lần rồi 2 lần, xen kẽ).
 * Pattern: A, B, B, A, B, B, ...
 * @param {string[]} seq
 */
function detectCau12(seq) {
  if (seq.length < 6) return false;
  const tail = seq.slice(-6);
  // Pattern 1: A B B A B B
  return (
    tail[0] !== tail[1] &&
    tail[1] === tail[2] &&
    tail[3] !== tail[4] &&
    tail[4] === tail[5] &&
    tail[0] === tail[3] &&
    tail[1] === tail[4]
  );
}

/**
 * MODULE 5 CORE — Thuật toán Cầu + Điểm Số + Vị Xúc Xắc
 *
 * Trả về:
 *   { du_doan: 'Tài'|'Xỉu'|null, luot_danh: 'TÀI'|'XỈU'|'WAIT', do_tin_cay_label: 'Cao'|'Trung bình'|'Thấp', do_tin_cay: number, rule: string, mo_ta: string }
 *   Hoặc null nếu không có tín hiệu.
 *
 * @param {Array} hist - Mảng history đầy đủ
 */
function m5Predict(hist) {
  const n = hist.length;
  if (n < 2) return null;

  const current = hist[n - 1];           // tay mới nhất (đã có kết quả)
  const prev    = n >= 2 ? hist[n - 2] : null;
  const prev2   = n >= 3 ? hist[n - 3] : null;
  const prev3   = n >= 4 ? hist[n - 4] : null;

  const tong  = current.tong;
  const dice  = current.dice;             // mảng 3 số, có thể null

  // Chuỗi T/X gần nhất để phát hiện cầu
  const seq = hist.map(h => h.ket_qua);  // 'T' hoặc 'X'

  // ────────────────────────────────────────────────────────────
  // PHẦN 1 — BỘ LỌC CẦU ĐẶC BIỆT (ưu tiên cao nhất)
  // ────────────────────────────────────────────────────────────

  // Quy tắc 1.1 — Phá Cầu 1-1
  // Nếu đang đi cầu xen kẽ VÀ tổng hiện tại là 13 hoặc 14 → Bẻ cầu
  if (detectCau11(seq, 4) && (tong === 13 || tong === 14)) {
    const nextLabel = seq[n - 1] === 'T' ? 'Xỉu' : 'Tài'; // ngược lại nhịp 1-1
    return {
      du_doan:          nextLabel,
      luot_danh:        nextLabel === 'Tài' ? 'TÀI' : 'XỈU',
      do_tin_cay_label: 'Trung bình',
      do_tin_cay:       62,
      rule:             'M5-CAU11',
      mo_ta:            `M5: Cầu 1-1 + Tổng ${tong} → Bẻ cầu sang ${nextLabel} (Volume nhỏ)`
    };
  }

  // Quy tắc 1.2 — Dấu hiệu Bệt Tài: t-2=14, t-1=13
  if (prev && prev2 && prev2.tong === 14 && prev.tong === 13) {
    return {
      du_doan:          'Tài',
      luot_danh:        'TÀI',
      do_tin_cay_label: 'Trung bình',
      do_tin_cay:       65,
      rule:             'M5-BET-TAI',
      mo_ta:            `M5: Dấu hiệu Bệt Tài (14→13) → Tài (thăm dò, dừng nếu thua 2 ván)`
    };
  }

  // Quy tắc 1.3 — Cầu 1-2 + Xỉu tiếp theo
  if (detectCau12(seq)) {
    return {
      du_doan:          'Xỉu',
      luot_danh:        'XỈU',
      do_tin_cay_label: 'Trung bình',
      do_tin_cay:       63,
      rule:             'M5-CAU12',
      mo_ta:            `M5: Cầu 1-2 + Chấm Trắng → Kép Xỉu cao → Xỉu`
    };
  }

  // ────────────────────────────────────────────────────────────
  // PHẦN 2 — BỘ LỌC ĐIỂM SỐ & VỊ XÚC XẮC
  // ────────────────────────────────────────────────────────────

  switch (tong) {

    // ── Nhóm XỈU chắc chắn ──────────────────────────────────
    case 3:
      return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 100, rule: 'M5-T3', mo_ta: 'M5: Tổng 3 → Xỉu (100%)' };

    case 5:
      return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 100, rule: 'M5-T5', mo_ta: 'M5: Tổng 5 → Xỉu (100%)' };

    case 15:
      return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Cao', do_tin_cay: 90, rule: 'M5-T15', mo_ta: 'M5: Tổng 15 → Tài (Auto)' };

    case 18:
      return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Cao', do_tin_cay: 85, rule: 'M5-T18', mo_ta: 'M5: Tổng 18 → Tài (giữ cầu)' };

    // ── Tổng 4 ──────────────────────────────────────────────
    case 4:
      return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Trung bình', do_tin_cay: 68, rule: 'M5-T4', mo_ta: 'M5: Tổng 4 → Xỉu (68%)' };

    // ── Tổng 6 — Cầu lừa → WAIT ─────────────────────────────
    case 6:
      return { du_doan: null, luot_danh: 'WAIT', do_tin_cay_label: 'Thấp', do_tin_cay: 0, rule: 'M5-T6', mo_ta: 'M5: Tổng 6 — Cầu lừa (Bịp) → WAIT 1 tay' };

    // ── Tổng 7 — Phụ thuộc vị xúc xắc ──────────────────────
    case 7: {
      const xiu7Combos = [[1,2,4],[2,2,3],[1,3,3]];
      const isXiu7 = dice && xiu7Combos.some(c => diceMatch(dice, c));
      if (isXiu7) {
        return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 89, rule: 'M5-T7-X', mo_ta: `M5: Tổng 7 vị ${dice} → 89% Xỉu (khả năng nhảy 10)` };
      } else {
        return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Trung bình', do_tin_cay: 65, rule: 'M5-T7-T', mo_ta: `M5: Tổng 7 vị khác → Tài` };
      }
    }

    // ── Tổng 8 — Phụ thuộc vị xúc xắc ──────────────────────
    case 8: {
      if (dice && diceMatch(dice, [1,3,4])) {
        return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 80, rule: 'M5-T8-X', mo_ta: `M5: Tổng 8 vị [1,3,4] → Auto Xỉu` };
      }
      return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Trung bình', do_tin_cay: 62, rule: 'M5-T8-T', mo_ta: `M5: Tổng 8 vị còn lại → Tài` };
    }

    // ── Tổng 9 — Phụ thuộc vị xúc xắc ──────────────────────
    case 9: {
      if (dice && diceMatch(dice, [2,3,4])) {
        return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Trung bình', do_tin_cay: 70, rule: 'M5-T9-X', mo_ta: `M5: Tổng 9 vị [2,3,4] → Xỉu` };
      }
      return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Thấp', do_tin_cay: 52, rule: 'M5-T9-T', mo_ta: `M5: Tổng 9 vị còn lại → Tài (50/50)` };
    }

    // ── Tổng 10 — Phụ thuộc ván liền trước ─────────────────
    case 10: {
      // Nếu t-1 là 'Đen' (trong context này: ký hiệu kết quả XỈU – tạm hiểu prev.ket_qua === 'X')
      const prevIsX = prev && prev.ket_qua === 'X';
      if (prevIsX) {
        return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Trung bình', do_tin_cay: 68, rule: 'M5-T10-T', mo_ta: 'M5: Tổng 10 sau Xỉu → Sẽ lên 12-13 rồi 11 → Tài' };
      }
      return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Trung bình', do_tin_cay: 65, rule: 'M5-T10-X', mo_ta: 'M5: Tổng 10 (còn lại) → Auto Xỉu' };
    }

    // ── Tổng 11 — Cầu nát → WAIT ────────────────────────────
    case 11:
      return { du_doan: null, luot_danh: 'WAIT', do_tin_cay_label: 'Thấp', do_tin_cay: 0, rule: 'M5-T11', mo_ta: 'M5: Tổng 11 — Cầu nát, khó đoán → WAIT 1 tay' };

    // ── Tổng 12 — Phụ thuộc vị xúc xắc ─────────────────────
    case 12: {
      const xiu12Combos = [[2,4,6],[1,5,6],[3,3,6],[2,5,5]];
      const isXiu12 = dice && xiu12Combos.some(c => diceMatch(dice, c));
      if (isXiu12) {
        return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 82, rule: 'M5-T12-X', mo_ta: `M5: Tổng 12 vị ${dice} → Auto Xỉu` };
      }
      return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Trung bình', do_tin_cay: 68, rule: 'M5-T12-T', mo_ta: `M5: Tổng 12 vị còn lại → Tài` };
    }

    // ── Tổng 13 — Phụ thuộc vị xúc xắc ─────────────────────
    case 13: {
      const xiu13Combos = [[5,5,3],[6,6,1],[1,3,5],[1,3,6]];
      // Lưu ý: [5,5,3] tổng = 13, [6,6,1] tổng = 13, [1,3,5] tổng = 9 → loại [1,3,5] vì sai tổng
      // Chỉ dùng các combo tổng đúng = 13: [5,5,3], [6,6,1], [1,6,6]=[6,6,1], [4,3,6],[2,5,6],...
      // Giữ nguyên theo đặc tả gốc (tác giả có thể dùng combo riêng)
      const isXiu13 = dice && xiu13Combos.some(c => diceMatch(dice, c));
      if (isXiu13) {
        return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 80, rule: 'M5-T13-X', mo_ta: `M5: Tổng 13 vị ${dice} → Auto Xỉu` };
      }
      return { du_doan: 'Tài', luot_danh: 'TÀI', do_tin_cay_label: 'Trung bình', do_tin_cay: 67, rule: 'M5-T13-T', mo_ta: `M5: Tổng 13 vị còn lại → Tài` };
    }

    // ── Tổng 14 — 50/50 → WAIT ──────────────────────────────
    case 14:
      return { du_doan: null, luot_danh: 'WAIT', do_tin_cay_label: 'Thấp', do_tin_cay: 0, rule: 'M5-T14', mo_ta: 'M5: Tổng 14 — Xác suất 50/50 → WAIT bảo toàn vốn' };

    // ── Tổng 16 — Xỉu cao ───────────────────────────────────
    case 16:
      return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 78, rule: 'M5-T16', mo_ta: 'M5: Tổng 16 → Xỉu (tỉ lệ cao)' };

    // ── Tổng 17 — Xỉu bay thẳng xuống ──────────────────────
    case 17:
      return { du_doan: 'Xỉu', luot_danh: 'XỈU', do_tin_cay_label: 'Cao', do_tin_cay: 82, rule: 'M5-T17', mo_ta: 'M5: Tổng 17 → Xỉu (bay thẳng xuống 10)' };

    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 4 — KẾT HỢP 4 TÍN HIỆU (nâng cấp từ 3 lên 4)
// ═══════════════════════════════════════════════════════════════
function combinePrediction(hist) {
  if (hist.length < 2) return { du_doan: 'Tài', do_tin_cay: 50, rule: '-', mo_ta: 'Không đủ dữ liệu', method: 'default' };

  const seq    = hist.map(h => h.tong).map(label);
  const sunwin = applySunwinRules(hist);
  const mrk    = markovPredict(seq);
  const dice   = dicePatternPredict(hist);
  const m5     = m5Predict(hist);

  // ── Nếu M5 ra WAIT → ưu tiên dừng lệnh ──────────────────
  if (m5 && m5.luot_danh === 'WAIT') {
    return {
      du_doan:    null,
      do_tin_cay: 0,
      rule:       m5.rule,
      mo_ta:      m5.mo_ta,
      method:     'M5-WAIT',
      luot_danh:  'WAIT',
      votes:      { T: 0, X: 0 },
      signals:    [{ src: 'M5-ScorePos', pred: 'WAIT', rule: m5.rule }]
    };
  }

  const votes = { T: 0, X: 0 };
  const signals = [];

  // ── Sunwin Rules (trọng số cao nhất) ─────────────────────
  if (sunwin) {
    const v  = sunwin.du_doan === 'Tài' ? 'T' : 'X';
    const wt = sunwin.nhom === 1 ? 4 : sunwin.nhom === 2 ? 3 : 1;
    votes[v] += wt;
    signals.push({ src: 'SunwinRules', pred: sunwin.du_doan, rule: sunwin.rule });
  }

  // ── Module 5 — Cầu/Điểm/Vị (trọng số = 3, ngang SW nhóm 2) ──
  if (m5 && m5.du_doan !== null) {
    const v  = m5.du_doan === 'Tài' ? 'T' : 'X';
    // Tín hiệu do_tin_cay cao → trọng số tăng
    const wt = m5.do_tin_cay >= 80 ? 4 : m5.do_tin_cay >= 65 ? 3 : 2;
    votes[v] += wt;
    signals.push({ src: 'M5-ScorePos', pred: m5.du_doan, rule: m5.rule, conf: m5.do_tin_cay });
  }

  // ── Markov ────────────────────────────────────────────────
  if (mrk) {
    const v  = mrk.du_doan === 'Tài' ? 'T' : 'X';
    votes[v] += mrk.do_tin_cay >= 70 ? 2 : 1;
    signals.push({ src: 'Markov', pred: mrk.du_doan, conf: mrk.do_tin_cay });
  }

  // ── Dice Pattern ─────────────────────────────────────────
  if (dice) {
    const v = dice.du_doan === 'Tài' ? 'T' : 'X';
    votes[v] += 1;
    signals.push({ src: 'DicePattern', pred: dice.du_doan, conf: dice.do_tin_cay });
  }

  const totalVotes = votes.T + votes.X;
  if (totalVotes === 0) return { du_doan: 'Tài', do_tin_cay: 50, rule: '-', mo_ta: 'Không đủ tín hiệu', method: 'default' };

  const winner      = votes.T >= votes.X ? 'Tài' : 'Xỉu';
  const winnerVotes = Math.max(votes.T, votes.X);
  const agreement   = Math.round(winnerVotes / totalVotes * 100);

  // ── Tính confidence ───────────────────────────────────────
  let conf;
  const m5Active = m5 && m5.du_doan !== null;

  if (sunwin && m5Active && mrk) {
    const m5Agrees = m5.du_doan === sunwin.du_doan;
    const mrkAgrees = mrk.du_doan === sunwin.du_doan;
    if (m5Agrees && mrkAgrees) {
      const base = sunwin.nhom === 1 ? 88 : 80;
      conf = Math.min(94, Math.round((mrk.do_tin_cay + base + m5.do_tin_cay) / 3) + 6);
    } else if (m5Agrees || mrkAgrees) {
      const base = sunwin.nhom === 1 ? 82 : 72;
      conf = Math.min(90, Math.round((base + (m5Active ? m5.do_tin_cay : 50)) / 2) + 4);
    } else {
      conf = Math.max(55, Math.round(agreement * 0.75 + 12));
    }
  } else if (sunwin && mrk && mrk.du_doan === sunwin.du_doan) {
    const base = sunwin.nhom === 1 ? 85 : sunwin.nhom === 2 ? 78 : 65;
    conf = Math.min(92, Math.round((mrk.do_tin_cay + base) / 2) + 5);
  } else if (m5Active && mrk && m5.du_doan === mrk.du_doan) {
    conf = Math.min(88, Math.round((m5.do_tin_cay + mrk.do_tin_cay) / 2) + 4);
  } else if (sunwin) {
    const base = sunwin.nhom === 1 ? 75 : sunwin.nhom === 2 ? 68 : 58;
    conf = Math.max(base, Math.round(agreement * 0.8 + 10));
  } else if (m5Active) {
    conf = Math.max(55, Math.round(m5.do_tin_cay * 0.9));
  } else {
    conf = Math.max(52, Math.round(agreement * 0.75 + 10));
  }

  // ── Method string ────────────────────────────────────────
  const parts = [];
  if (sunwin)   parts.push('sunwin');
  if (m5Active) parts.push('m5-scorepos');
  if (mrk)      parts.push('markov');
  if (dice)     parts.push('dice');
  const method = parts.length ? parts.join('+') : 'default';

  const mo_ta = m5Active ? m5.mo_ta
    : sunwin ? sunwin.mo_ta
    : mrk ? `Markov ${mrk.do_tin_cay}% → ${mrk.du_doan}`
    : dice?.mo_ta ?? 'Không đủ tín hiệu';

  return {
    du_doan:    winner,
    do_tin_cay: conf,
    rule:       m5?.rule ?? sunwin?.rule ?? (mrk ? 'Markov' : 'DicePattern'),
    mo_ta,
    method,
    luot_danh:  winner === 'Tài' ? 'TÀI' : 'XỈU',
    votes,
    signals
  };
}

// ═══════════════════════════════════════════════════════════════
//  FETCH & UPDATE
// ═══════════════════════════════════════════════════════════════
let pendingPrediction = null;

async function fetchAndUpdate() {
  try {
    const res  = await fetch(SOURCE_API, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) return null;

    const sorted = [...data].sort((a, b) => a.session - b.session);
    const latest = sorted[sorted.length - 1];

    const existingSessions = new Set(history.map(h => h.phien));

    for (const item of sorted) {
      const phien = String(item.session);
      if (existingSessions.has(phien)) continue;

      const diceArr = Array.isArray(item.dice) && item.dice.length === 3
        ? item.dice.map(Number) : null;

      const tong = typeof item.total === 'number'
        ? item.total : (diceArr ? diceArr.reduce((a, b) => a + b, 0) : 0);

      const ketQua = item.ket_qua === 'Tài' ? 'T'
                   : item.ket_qua === 'Xỉu' ? 'X'
                   : label(tong);

      history.push({ phien, dice: diceArr, tong, ket_qua: ketQua });
      existingSessions.add(phien);

      if (pendingPrediction && String(pendingPrediction.phien_du_doan) === phien) {
        const win = pendingPrediction.du_doan_raw === ketQua;
        winLoss.push({
          phien,
          du_doan:      pendingPrediction.du_doan,
          ket_qua_thuc: fullLabel(tong),
          tong,
          win,
          do_tin_cay:   pendingPrediction.do_tin_cay,
          method:       pendingPrediction.method,
          rule:         pendingPrediction.rule
        });
        if (winLoss.length >= 200) winLoss = winLoss.slice(-100);
        pendingPrediction = null;
      }
    }

    if (history.length > 200) history = history.slice(-200);

    const predict   = combinePrediction(history);
    const phienNext = String(latest.session + 1);
    const pattern   = history.slice(-25).map(h => h.ket_qua).join('').toLowerCase();

    pendingPrediction = {
      phien_du_doan: phienNext,
      du_doan:       predict.du_doan,
      du_doan_raw:   predict.du_doan === 'Tài' ? 'T' : 'X',
      do_tin_cay:    predict.do_tin_cay,
      rule:          predict.rule,
      method:        predict.method
    };

    const latestTotal = typeof latest.total === 'number'
      ? latest.total : (Array.isArray(latest.dice) ? latest.dice.reduce((a, b) => a + b, 0) : 0);

    const latestDice = Array.isArray(latest.dice) ? latest.dice.map(Number) : null;

    return {
      id:            '@sewdangcap',
      phien:         latest.session,
      ket_qua:       fullLabel(latestTotal),
      xuc_xac:       latestDice,
      phien_du_doan: Number(phienNext),
      du_doan:       predict.du_doan,
      luot_danh:     predict.luot_danh ?? (predict.du_doan ? (predict.du_doan === 'Tài' ? 'TÀI' : 'XỈU') : 'WAIT'),
      do_tin_cay:    predict.do_tin_cay + '%',
      rule:          predict.rule,
      mo_ta:         predict.mo_ta,
      method:        predict.method,
      signals:       predict.signals,
      pattern
    };

  } catch (e) {
    console.error('[fetchAndUpdate]', e.message);
    return null;
  }
}

// ─── Polling mỗi 5 giây ───────────────────────────────────────
let latestData = null;
async function poll() {
  const d = await fetchAndUpdate();
  if (d) latestData = d;
}
poll();
setInterval(poll, 5000);

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// ── HOME ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>API Tài Xỉu Sunwin v4.0 — @sewdangcap</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:#0d1117;
    color:#e6edf3;
    font-family:'Segoe UI',sans-serif;
    min-height:100vh;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    padding:24px;
  }
  h1{font-size:2rem;font-weight:700;margin-bottom:6px;color:#58a6ff}
  .sub{color:#8b949e;font-size:.9rem;margin-bottom:6px}
  .ver{color:#3fb950;font-size:.8rem;margin-bottom:40px;font-weight:600}
  .grid{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
    gap:16px;
    width:100%;
    max-width:900px;
  }
  .card{
    background:#161b22;
    border:1px solid #30363d;
    border-radius:12px;
    padding:28px 24px;
    cursor:pointer;
    transition:all .2s;
    text-decoration:none;
    color:inherit;
    display:block;
  }
  .card:hover{
    border-color:#58a6ff;
    transform:translateY(-3px);
    box-shadow:0 10px 30px rgba(88,166,255,.15);
  }
  .card .icon{font-size:2rem;margin-bottom:12px;display:block}
  .card h2{font-size:1.05rem;margin-bottom:8px;color:#58a6ff;font-weight:600}
  .card p{font-size:.82rem;color:#8b949e;line-height:1.65}
  .card .path{
    display:inline-block;
    margin-top:14px;
    font-size:.75rem;
    color:#3fb950;
    background:#1a2e1a;
    border:1px solid #2ea04326;
    padding:3px 10px;
    border-radius:20px;
    font-family:monospace;
  }
  .badge-new{
    display:inline-block;
    background:#f97316;
    color:#fff;
    font-size:.65rem;
    font-weight:700;
    padding:2px 7px;
    border-radius:20px;
    margin-left:6px;
    vertical-align:middle;
  }
  footer{margin-top:48px;color:#484f58;font-size:.8rem}
</style>
</head>
<body>
<h1>🎲 API Tài Xỉu Sunwin</h1>
<p class="sub">DEV @sewdangcap</p>
<p class="ver">v4.0 — SunwinRules + Markov Bậc 1-4 + Dice Pattern + Cầu/Điểm/Vị Algorithm</p>

<div class="grid">
  <a class="card" href="/sunlon">
    <span class="icon">⚡</span>
    <h2>Dự đoán realtime</h2>
    <p>Kết quả phiên hiện tại + dự đoán phiên tiếp theo. Cập nhật mỗi 5 giây. Bao gồm lệnh WAIT khi cần bảo toàn vốn.</p>
    <span class="path">GET /sunlon</span>
  </a>

  <a class="card" href="/thongke">
    <span class="icon">📊</span>
    <h2>Thống kê thắng / thua</h2>
    <p>Chi tiết từng phiên đã dự đoán: kết quả thực tế, đúng/sai, tổng win rate.</p>
    <span class="path">GET /thongke</span>
  </a>

  <a class="card" href="/history">
    <span class="icon">📜</span>
    <h2>Lịch sử phiên</h2>
    <p>50 phiên gần nhất: xúc xắc, tổng, phân loại (Triple / Double / Seq / Mixed).</p>
    <span class="path">GET /history</span>
  </a>

  <a class="card" href="/m5-debug">
    <span class="icon">🧠</span>
    <h2>Debug Module 5 <span class="badge-new">NEW</span></h2>
    <p>Xem chi tiết tín hiệu từ thuật toán Cầu + Điểm Số + Vị Xúc Xắc cho phiên hiện tại.</p>
    <span class="path">GET /m5-debug</span>
  </a>
</div>

<footer>© 2025 DEV @sewdangcap — All rights reserved</footer>
</body>
</html>`);
});

// ── /sunlon ───────────────────────────────────────────────────
app.get('/sunlon', async (req, res) => {
  if (!latestData) {
    const d = await fetchAndUpdate();
    if (d) latestData = d;
  }
  if (!latestData) return res.status(503).json({ error: 'Đang tải dữ liệu, thử lại sau...' });
  res.json(latestData);
});

// ── /thongke ─────────────────────────────────────────────────
app.get('/thongke', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const slice = winLoss.slice(-limit).reverse();

  const wins  = slice.filter(r => r.win).length;
  const loses = slice.length - wins;
  const rate  = slice.length ? Math.round(wins / slice.length * 100) : 0;

  let streak = 0, streakType = null;
  for (const r of slice) {
    if (streakType === null) { streakType = r.win; streak = 1; }
    else if (r.win === streakType) streak++;
    else break;
  }

  const methodStats = {};
  for (const r of slice) {
    const m = r.method || 'unknown';
    methodStats[m] = methodStats[m] || { win: 0, lose: 0 };
    r.win ? methodStats[m].win++ : methodStats[m].lose++;
  }
  const theo_method = {};
  for (const [m, s] of Object.entries(methodStats)) {
    const total = s.win + s.lose;
    theo_method[m] = {
      win:      s.win,
      lose:     s.lose,
      win_rate: Math.round(s.win / total * 100) + '%'
    };
  }

  res.json({
    id: '@sewdangcap',
    tong_quan: {
      tong_phien: slice.length,
      thang:      wins,
      thua:       loses,
      win_rate:   rate + '%',
      streak_hien_tai: streak > 0
        ? `${streak} ${streakType ? 'THẮNG' : 'THUA'} liên tiếp`
        : 'Chưa có dữ liệu'
    },
    theo_method,
    chi_tiet: slice.map((r, i) => ({
      stt:          i + 1,
      phien:        Number(r.phien),
      du_doan:      r.du_doan,
      ket_qua_thuc: r.ket_qua_thuc,
      tong_diem:    r.tong ?? null,
      do_tin_cay:   r.do_tin_cay + '%',
      method:       r.method,
      rule:         r.rule ?? '-',
      ket_luan:     r.win ? '✅ THẮNG' : '❌ THUA'
    }))
  });
});

// ── /thangthua (redirect legacy) ─────────────────────────────
app.get('/thangthua', (req, res) => res.redirect('/thongke'));

// ── /history ──────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const data  = history.slice(-limit).reverse().map(h => ({
    phien:      Number(h.phien),
    xuc_xac:    h.dice,
    phan_loai:  h.dice ? classifyDice([...h.dice]).detail : null,
    tong:       h.tong,
    ket_qua:    h.ket_qua === 'T' ? 'Tài' : 'Xỉu'
  }));
  res.json({
    id:       '@sewdangcap',
    tong:     history.length,
    hien_thi: data.length,
    data
  });
});

// ── /m5-debug (NEW) ───────────────────────────────────────────
// Trả về toàn bộ tín hiệu từ Module 5 cho phiên hiện tại
app.get('/m5-debug', (req, res) => {
  if (history.length < 2) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const n = history.length;
  const current = history[n - 1];
  const seq = history.map(h => h.ket_qua);

  const m5Result = m5Predict(history);
  const isCau11  = detectCau11(seq, 4);
  const isCau12  = detectCau12(seq);

  res.json({
    id:              '@sewdangcap',
    phien_hien_tai:  Number(current.phien),
    tong_diem:       current.tong,
    xuc_xac:         current.dice,
    ket_qua:         current.ket_qua === 'T' ? 'Tài' : 'Xỉu',
    phan_tich_cau: {
      cau_11_dang_di:  isCau11,
      cau_12_dang_di:  isCau12,
      chuoi_gan_nhat:  seq.slice(-10).join('')
    },
    m5_ket_qua: m5Result
      ? {
          luot_danh:        m5Result.luot_danh,
          du_doan:          m5Result.du_doan,
          do_tin_cay:       m5Result.do_tin_cay + (m5Result.do_tin_cay > 0 ? '%' : ''),
          do_tin_cay_label: m5Result.do_tin_cay_label,
          rule:             m5Result.rule,
          mo_ta:            m5Result.mo_ta
        }
      : { luot_danh: 'SKIP', mo_ta: 'Tổng không nằm trong bảng M5, dùng module khác' }
  });
});

// ── /dice-stats ───────────────────────────────────────────────
app.get('/dice-stats', (req, res) => {
  const n = Math.min(Number(req.query.n) || 30, 200);
  if (history.length < 3) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const { freq, hot, cold } = diceFrequency(history, n);
  const slice = history.slice(-n);
  const typeCounts = { triple: 0, double: 0, sequence: 0, mixed: 0 };

  for (const h of slice) {
    const cls = classifyDice(h.dice ? [...h.dice] : null);
    if (cls.type in typeCounts) typeCounts[cls.type]++;
  }

  const totalRolls = Object.values(freq).reduce((a, b) => a + b, 0);
  const freqPct = {};
  for (const [k, v] of Object.entries(freq))
    freqPct[k] = { count: v, pct: totalRolls > 0 ? Math.round(v / totalRolls * 100) + '%' : '0%' };

  res.json({
    id:              '@sewdangcap',
    phan_tich_trong: `${n} phiên gần nhất`,
    tan_suat_mat:    freqPct,
    mat_hot:         hot,
    mat_cold:        cold,
    ty_le_loai: {
      triple:   { count: typeCounts.triple,   pct: Math.round(typeCounts.triple   / slice.length * 100) + '%' },
      double:   { count: typeCounts.double,   pct: Math.round(typeCounts.double   / slice.length * 100) + '%' },
      sequence: { count: typeCounts.sequence, pct: Math.round(typeCounts.sequence / slice.length * 100) + '%' },
      mixed:    { count: typeCounts.mixed,    pct: Math.round(typeCounts.mixed    / slice.length * 100) + '%' }
    }
  });
});

// ── /markov-table ─────────────────────────────────────────────
app.get('/markov-table', (req, res) => {
  if (history.length < 5) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const seq    = history.map(h => h.ket_qua);
  const tables = buildMarkovTables(seq);

  const fmt = (tbl) => {
    const out = {};
    for (const [k, v] of Object.entries(tbl)) {
      const total = v.T + v.X;
      out[k] = {
        T: v.T, X: v.X, total,
        probT: total > 0 ? Math.round(v.T / total * 100) + '%' : '-',
        probX: total > 0 ? Math.round(v.X / total * 100) + '%' : '-'
      };
    }
    return out;
  };

  res.json({
    id:                   '@sewdangcap',
    tong_phien_phan_tich: history.length,
    bac_1: fmt(tables.order1),
    bac_2: fmt(tables.order2),
    bac_3: fmt(tables.order3),
    ghi_chu: 'T=Tài, X=Xỉu. probT/probX = xác suất phiên tiếp theo'
  });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({
    error:     'Endpoint không tồn tại',
    endpoints: ['/', '/sunlon', '/thongke', '/history', '/dice-stats', '/markov-table', '/m5-debug']
  })
);

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`
🎲 API Tài Xỉu Sunwin v4.0 — DEV @sewdangcap
   http://localhost:${PORT}
   Polling: ${SOURCE_API}
   Endpoints: /sunlon  /thongke  /history  /dice-stats  /markov-table  /m5-debug
`)
);
