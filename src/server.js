/**
 * ============================================================
 *  SIC BO PREDICTION API  —  DEV @sewdangcap
 *  v2.0 — Công Thức 68GB + Markov Bậc 1-2-3 + Dice Pattern
 * ============================================================
 *
 *  NÂNG CẤP v2.0:
 *  ✅ Markov Bậc 3 với trọng số phân tách rõ ràng
 *  ✅ Lưu dữ liệu xúc xắc đầy đủ (dice[0], dice[1], dice[2])
 *  ✅ Thuật toán Dice Pattern (Triple / Double / Sum-sequence)
 *  ✅ Dice Frequency Map — theo dõi tần suất từng giá trị mặt xúc xắc
 *  ✅ Kết hợp 4 tín hiệu: 68GB + Markov + DicePattern + DiceFreq
 * ============================================================
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SỬA: JSON nguồn có dạng [{"session":3100114,"dice":[1,1,5],"total":7,"ket_qua":"Xỉu"}]
const SOURCE_API = 'https://apisunlichsu.onrender.com/api/taixiu/history';

// ─── In-memory store ──────────────────────────────────────────
/**
 * history[i] = {
 *   phien:   string,
 *   dice:    [d1, d2, d3],
 *   tong:    number,
 *   ket_qua: 'T' | 'X'
 * }
 */
let history = [];
let winLoss = [];

// ─── Helpers cơ bản ───────────────────────────────────────────
const isTai    = t => t >= 11 && t <= 18;
const isXiu    = t => t >= 3  && t <= 10;
const isChan   = t => t % 2 === 0;
const isLe     = t => t % 2 !== 0;
const label    = t => isTai(t) ? 'T' : 'X';
const fullLabel = t => isTai(t) ? 'Tài' : 'Xỉu';

// ═══════════════════════════════════════════════════════════════
//  MODULE 1 — CÔNG THỨC 68GB (giữ nguyên logic gốc)
// ═══════════════════════════════════════════════════════════════
function apply68GB(totals) {
  const n = totals.length;
  if (n < 2) return null;

  const t0 = totals[n - 1];
  const t1 = totals[n - 2];
  const t2 = n >= 3 ? totals[n - 3] : null;
  const t3 = n >= 4 ? totals[n - 4] : null;

  // Rule 1.1 — Bộ 3 Xỉu Chẵn
  if (n >= 3 && t0 === t1 && t1 === t2 && isXiu(t0) && isChan(t0)) {
    if (t0 === 10) return { du_doan: 'Xỉu', rule: '1.1-NL', mo_ta: 'CT68 R1.1 Ngoại lệ 10-10-10 → Tiếp Xỉu' };
    return { du_doan: 'Tài', rule: '1.1', mo_ta: `CT68 R1.1 Bộ 3 Xỉu Chẵn ${t0}×3 → Bẻ Tài` };
  }
  // Rule 1.2 — Bộ 3 Xỉu Lẻ
  if (n >= 3 && t0 === t1 && t1 === t2 && isXiu(t0) && isLe(t0))
    return { du_doan: 'Xỉu', rule: '1.2', mo_ta: `CT68 R1.2 Bộ 3 Xỉu Lẻ ${t0}×3 → Tiếp Xỉu` };
  // Rule 1.3 — Max Tài
  if (t0 === 16 || t0 === 17)
    return { du_doan: 'Xỉu', rule: '1.3', mo_ta: `CT68 R1.3 Max Tài (${t0}) → Bẻ Xỉu` };
  // Rule 1.4 — Kép 11 sau bệt Xỉu
  if (n >= 4 && t0 === 11 && t1 === 11 && isXiu(t2) && isXiu(t3))
    return { du_doan: 'Tài', rule: '1.4', mo_ta: `CT68 R1.4 Kép 11 sau bệt Xỉu → Tiếp Tài` };

  // Rule 2.x — Kép (cặp đôi)
  if (t0 === t1) {
    if (isXiu(t0) && isChan(t0)) return { du_doan: 'Xỉu', rule: '2.1', mo_ta: `CT68 R2.1 Kép Xỉu Chẵn ${t0}×2 → Tiếp Xỉu` };
    if (isXiu(t0) && isLe(t0))   return { du_doan: 'Tài', rule: '2.2', mo_ta: `CT68 R2.2 Kép Xỉu Lẻ ${t0}×2 → Bẻ Tài` };
    if (isTai(t0) && isChan(t0)) return { du_doan: 'Xỉu', rule: '2.3', mo_ta: `CT68 R2.3 Kép Tài Chẵn ${t0}×2 → Bẻ Xỉu` };
    if (isTai(t0) && isLe(t0))   return { du_doan: 'Tài', rule: '2.4', mo_ta: `CT68 R2.4 Kép Tài Lẻ ${t0}×2 → Tiếp Tài` };
  }

  // Rule 3.1 — Bệt 5
  if (n >= 5) {
    const last5 = totals.slice(n - 5);
    if (last5.every(v => label(v) === label(last5[0])))
      return { du_doan: isTai(t0) ? 'Xỉu' : 'Tài', rule: '3.1', mo_ta: `CT68 R3.1 Bệt 5 ${label(t0)} → Bẻ` };
  }
  // Rule 3.2 — Bệt suy yếu
  if (n >= 3) {
    let bietLen = 0, bietStart = null;
    for (let i = n - 1; i >= 0; i--) {
      if (label(totals[i]) === label(t0)) { bietLen++; if (bietStart === null) bietStart = totals[i]; }
      else break;
    }
    if (bietLen >= 3 && t0 <= bietStart)
      return { du_doan: isTai(t0) ? 'Xỉu' : 'Tài', rule: '3.2', mo_ta: `CT68 R3.2 Bệt suy yếu (${bietLen} tay) → Bẻ` };
  }

  // Rule 4.x — Cầu 1-1
  if (n >= 3) {
    if (isXiu(t0) && isTai(t1) && isXiu(t2) && t0 === t2)
      return { du_doan: 'Tài', rule: '4.1', mo_ta: `CT68 R4.1 Cầu 1-1 đặc biệt ${t2}-${t1}-${t0} → Bệt Tài` };
    if (isXiu(t0) && isTai(t1) && isXiu(t2) && t2 > t0)
      return { du_doan: 'Xỉu', rule: '4.2', mo_ta: `CT68 R4.2 Phá cầu 1-1 (${t2}-${t1}-${t0}) → Bẻ Xỉu` };
    if (isXiu(t0) && isTai(t1) && isXiu(t2))
      return { du_doan: 'Tài', rule: '4.3', mo_ta: `CT68 R4.3 Tạo cầu 1-1 → Bẻ lên Tài` };
  }

  // Rule 5.x — 2 Xỉu
  if (isXiu(t0) && isXiu(t1)) {
    if (isChan(t0) !== isChan(t1))
      return { du_doan: 'Tài', rule: '5.1', mo_ta: `CT68 R5.1 2 Xỉu Chẵn/Lẻ xen (${t1}-${t0}) → Bẻ Tài` };
    if (t0 < t1)
      return { du_doan: 'Xỉu', rule: '5.2', mo_ta: `CT68 R5.2 Xỉu lùi (${t1}→${t0}) → Tiếp Xỉu` };
  }

  // Rule 6.x — 2 Tài
  if (isTai(t0) && isTai(t1)) {
    const diff = t0 - t1;
    if (diff < 0)
      return { du_doan: 'Xỉu', rule: '6.1', mo_ta: `CT68 R6.1 Tài lùi (${t1}→${t0}) → Bẻ Xỉu` };
    if (diff === 1) {
      if (t2 !== null && t2 === t0)
        return { du_doan: 'Tài', rule: '6.3-NL', mo_ta: `CT68 R6.3 NL Zíc zắc (${t2}-${t1}-${t0}) → Theo 2 Tài` };
      return { du_doan: 'Xỉu', rule: '6.3', mo_ta: `CT68 R6.3 Tài tiến liền kề (${t1}→${t0}) → Bẻ Xỉu` };
    }
    if (diff >= 2)
      return { du_doan: 'Tài', rule: '6.2', mo_ta: `CT68 R6.2 Tài tiến mạnh (${t1}→${t0}) → Tiếp Tài` };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 2 — MARKOV CHAIN BẬC 1 / 2 / 3
// ═══════════════════════════════════════════════════════════════
function buildMarkovTables(seq) {
  const tables = { order1: {}, order2: {}, order3: {} };

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

  return tables;
}

const MARKOV_WEIGHTS   = { order3: 0.50, order2: 0.30, order1: 0.20 };
const MARKOV_MIN_SAMPLE = 2;

function markovPredict(seq) {
  if (seq.length < 4) return null;

  const tables = buildMarkovTables(seq);
  const n      = seq.length;
  const scores = { T: 0, X: 0 };
  const details = {};
  let totalWeight = 0;

  const k3 = seq[n - 3] + seq[n - 2] + seq[n - 1];
  const m3  = tables.order3[k3];
  if (m3 && m3.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order3;
    scores.T += w * (m3.T / m3.total);
    scores.X += w * (m3.X / m3.total);
    totalWeight += w;
    details.order3 = { key: k3, T: m3.T, X: m3.X, total: m3.total, probT: Math.round(m3.T / m3.total * 100), probX: Math.round(m3.X / m3.total * 100) };
  }

  const k2 = seq[n - 2] + seq[n - 1];
  const m2  = tables.order2[k2];
  if (m2 && m2.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order2;
    scores.T += w * (m2.T / m2.total);
    scores.X += w * (m2.X / m2.total);
    totalWeight += w;
    details.order2 = { key: k2, T: m2.T, X: m2.X, total: m2.total, probT: Math.round(m2.T / m2.total * 100), probX: Math.round(m2.X / m2.total * 100) };
  }

  const k1 = seq[n - 1];
  const m1  = tables.order1[k1];
  if (m1 && m1.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order1;
    scores.T += w * (m1.T / m1.total);
    scores.X += w * (m1.X / m1.total);
    totalWeight += w;
    details.order1 = { key: k1, T: m1.T, X: m1.X, total: m1.total, probT: Math.round(m1.T / m1.total * 100), probX: Math.round(m1.X / m1.total * 100) };
  }

  if (totalWeight === 0) return null;

  const normT = scores.T / totalWeight;
  const normX = scores.X / totalWeight;
  const pred  = normT >= normX ? 'T' : 'X';
  const conf  = Math.round(Math.max(normT, normX) * 100);

  return {
    du_doan:    pred === 'T' ? 'Tài' : 'Xỉu',
    do_tin_cay: conf,
    details,
    scores: { T: Math.round(normT * 100), X: Math.round(normX * 100) }
  };
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 3 — DICE PATTERN ANALYZER
// ═══════════════════════════════════════════════════════════════
function classifyDice(dice) {
  if (!dice || dice.length !== 3) return { type: 'unknown', value: null };
  const [a, b, c] = dice.sort((x, y) => x - y);

  if (a === b && b === c)         return { type: 'triple',   value: a,    detail: `Triple ${a}` };
  if (a === b || b === c)         return { type: 'double',   value: b,    detail: `Double ${a === b ? a : b}` };
  if (c - a === 2 && b - a === 1) return { type: 'sequence', value: null, detail: `Seq ${a}-${b}-${c}` };
  return { type: 'mixed', value: null, detail: `${a}-${b}-${c}` };
}

function diceFrequency(hist, n = 30) {
  const freq  = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const slice = hist.slice(-n);

  for (const h of slice) {
    if (!h.dice) continue;
    for (const d of h.dice) {
      if (d >= 1 && d <= 6) freq[d]++;
    }
  }

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const hot    = sorted.slice(0, 2).map(e => Number(e[0]));
  const cold   = sorted.slice(-2).map(e => Number(e[0]));
  return { freq, hot, cold };
}

function dicePatternPredict(hist) {
  if (hist.length < 5) return null;

  const recent = hist.slice(-5);
  const types  = recent.map(h => classifyDice(h.dice));

  const last3Types = types.slice(-3);
  if (last3Types.every(t => t.type === 'triple'))
    return { du_doan: 'Tài', do_tin_cay: 72, mo_ta: 'DicePattern: 3 Triple liên tiếp → đẩy Tài' };

  const last3     = hist.slice(-3);
  const allDouble = last3.every(h => classifyDice(h.dice).type === 'double');
  if (allDouble) {
    const vals = last3.map(h => classifyDice(h.dice).value);
    if (vals[0] > vals[1] && vals[1] > vals[2])
      return { du_doan: 'Xỉu', do_tin_cay: 68, mo_ta: `DicePattern: Double giảm dần ${vals[0]}→${vals[1]}→${vals[2]} → Xỉu` };
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
//  MODULE 4 — KẾT HỢP 4 TÍN HIỆU
// ═══════════════════════════════════════════════════════════════
function combinePrediction(hist) {
  if (hist.length < 2) return { du_doan: 'Tài', do_tin_cay: 50, method: 'default' };

  const totals = hist.map(h => h.tong);
  const seq    = totals.map(label);

  const r68  = apply68GB(totals);
  const mrk  = markovPredict(seq);
  const dice = dicePatternPredict(hist);

  const votes   = { T: 0, X: 0 };
  const signals = [];

  if (r68) {
    const v = r68.du_doan === 'Tài' ? 'T' : 'X';
    votes[v] += 3;
    signals.push({ src: '68GB', pred: r68.du_doan, rule: r68.rule });
  }
  if (mrk) {
    const v  = mrk.du_doan === 'Tài' ? 'T' : 'X';
    const wt = mrk.do_tin_cay >= 70 ? 2 : 1;
    votes[v] += wt;
    signals.push({ src: 'Markov', pred: mrk.du_doan, conf: mrk.do_tin_cay, details: mrk.details });
  }
  if (dice) {
    const v = dice.du_doan === 'Tài' ? 'T' : 'X';
    votes[v] += 1;
    signals.push({ src: 'DicePattern', pred: dice.du_doan, conf: dice.do_tin_cay });
  }

  const totalVotes  = votes.T + votes.X;
  if (totalVotes === 0) return { du_doan: 'Tài', do_tin_cay: 50, method: 'default' };

  const winner      = votes.T >= votes.X ? 'Tài' : 'Xỉu';
  const winnerVotes = Math.max(votes.T, votes.X);
  const agreement   = Math.round(winnerVotes / totalVotes * 100);

  let conf;
  if (!r68 && !mrk && !dice) {
    conf = 50;
  } else if (r68 && mrk && mrk.du_doan === r68.du_doan) {
    conf = Math.min(92, Math.round((mrk.do_tin_cay + 75) / 2) + 10);
  } else if (r68) {
    conf = Math.max(58, Math.round(agreement * 0.8 + 15));
  } else {
    conf = Math.max(52, Math.round(agreement * 0.75 + 10));
  }

  let method;
  if (r68 && mrk && dice) method = 'full-combo';
  else if (r68 && mrk)    method = 'combo';
  else if (r68)            method = '68gb';
  else if (mrk)            method = 'markov';
  else                     method = 'dice';

  return {
    du_doan:    winner,
    do_tin_cay: conf,
    rule:       r68 ? r68.rule  : (mrk ? 'Markov' : 'DicePattern'),
    mo_ta:      r68 ? r68.mo_ta : (dice ? dice.mo_ta : `Markov ${mrk?.do_tin_cay}%`),
    method,
    votes,
    signals,
    markov_detail: mrk ? {
      bac1: mrk.details.order1 || null,
      bac2: mrk.details.order2 || null,
      bac3: mrk.details.order3 || null,
      scores: mrk.scores
    } : null
  };
}

// ═══════════════════════════════════════════════════════════════
//  FETCH & UPDATE
//  ── CHỈ SỬA PHẦN NÀY để khớp JSON nguồn ──
//  JSON nguồn: [{"session":3100114,"dice":[1,1,5],"total":7,"ket_qua":"Xỉu"}]
// ═══════════════════════════════════════════════════════════════
let pendingPrediction = null;

async function fetchAndUpdate() {
  try {
    const res  = await fetch(SOURCE_API, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      console.error('[fetchAndUpdate] Dữ liệu nguồn không phải mảng:', data);
      return null;
    }

    // ── SỬA: sort theo session (số phiên) ──
    const sorted = [...data].sort((a, b) => a.session - b.session);
    const latest = sorted[sorted.length - 1];

    const existingSessions = new Set(history.map(h => h.phien));

    for (const item of sorted) {
      const phien = String(item.session);
      if (existingSessions.has(phien)) continue;

      // ── SỬA: đọc dice và total đúng field ──
      const diceArr = Array.isArray(item.dice) && item.dice.length === 3
        ? item.dice.map(Number)
        : null;

      const tong = typeof item.total === 'number'
        ? item.total
        : (diceArr ? diceArr.reduce((a, b) => a + b, 0) : 0);

      // ── SỬA: ket_qua từ nguồn là "Tài"/"Xỉu" → convert sang T/X ──
      const ketQua = item.ket_qua === 'Tài' ? 'T'
                   : item.ket_qua === 'Xỉu' ? 'X'
                   : label(tong); // fallback: tính từ tổng

      history.push({
        phien,
        dice:    diceArr,
        tong,
        ket_qua: ketQua
      });
      existingSessions.add(phien);

      // ── Kiểm tra win/loss cho pending prediction ──
      if (pendingPrediction && String(pendingPrediction.phien_du_doan) === phien) {
        const win = pendingPrediction.du_doan_raw === ketQua;
        winLoss.push({
          phien,
          du_doan:      pendingPrediction.du_doan,
          ket_qua_thuc: fullLabel(tong),
          win,
          do_tin_cay:   pendingPrediction.do_tin_cay,
          method:       pendingPrediction.method
        });
        if (winLoss.length >= 200) winLoss = winLoss.slice(-100);
        pendingPrediction = null;
      }
    }

    if (history.length > 200) history = history.slice(-200);

    // ── Tính dự đoán ──
    const predict   = combinePrediction(history);
    const pattern   = history.slice(-25).map(h => h.ket_qua).join('').toLowerCase();
    const phienNext = String(latest.session + 1);

    pendingPrediction = {
      phien_du_doan: phienNext,
      du_doan:       predict.du_doan,
      du_doan_raw:   predict.du_doan === 'Tài' ? 'T' : 'X',
      do_tin_cay:    predict.do_tin_cay,
      rule:          predict.rule,
      method:        predict.method
    };

    // ── SỬA: total phiên mới nhất đọc từ item.total ──
    const latestTotal = typeof latest.total === 'number'
      ? latest.total
      : (Array.isArray(latest.dice) ? latest.dice.reduce((a, b) => a + b, 0) : 0);

    const latestDice    = Array.isArray(latest.dice) ? latest.dice : null;
    const latestDiceInfo = latestDice ? classifyDice([...latestDice]) : null;

    return {
      phien_hien_tai:    latest.session,
      ket_qua:           fullLabel(latestTotal),
      xuc_xac:           latestDice,
      xuc_xac_phan_loai: latestDiceInfo ? latestDiceInfo.detail : null,
      phien_du_doan:     Number(phienNext),
      du_doan:           predict.du_doan,
      do_tin_cay:        predict.do_tin_cay + '%',
      rule:              predict.rule,
      mo_ta:             predict.mo_ta,
      method:            predict.method,
      votes:             predict.votes,
      signals:           predict.signals,
      markov_detail:     predict.markov_detail,
      pattern,
      id:                '@sewdangcap'
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
<title>API Tool Tài Xỉu Sunwin v2.0 — DEV @sewdangcap</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
  h1{font-size:2rem;font-weight:700;margin-bottom:6px;color:#58a6ff}
  .sub{color:#8b949e;font-size:.9rem;margin-bottom:8px}
  .ver{color:#3fb950;font-size:.8rem;margin-bottom:36px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;width:100%;max-width:860px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;cursor:pointer;transition:all .2s;text-decoration:none;color:inherit}
  .card:hover{border-color:#58a6ff;transform:translateY(-2px);box-shadow:0 8px 24px rgba(88,166,255,.15)}
  .card h2{font-size:1.1rem;margin-bottom:8px;color:#58a6ff}
  .card p{font-size:.82rem;color:#8b949e;line-height:1.6}
  .badge{display:inline-block;background:#238636;color:#fff;font-size:.7rem;padding:2px 8px;border-radius:20px;margin-bottom:10px}
  .badge.new{background:#9a3fb9}
  footer{margin-top:48px;color:#484f58;font-size:.8rem}
</style>
</head>
<body>
<h1>🎲 API Tool Tài Xỉu Sunwin</h1>
<p class="sub">DEV @sewdangcap</p>
<p class="ver">v2.0 — 68GB + Markov Bậc 1-2-3 + Dice Pattern</p>
<div class="grid">
  <a class="card" href="/sunlon">
    <span class="badge">JSON</span>
    <h2>⚡ /sunlon</h2>
    <p>Dự đoán realtime. Kết hợp 4 tín hiệu: 68GB + Markov bậc 3 + Dice Pattern + Vote system</p>
  </a>
  <a class="card" href="/history">
    <span class="badge">JSON</span>
    <h2>📜 /history</h2>
    <p>Lịch sử 50 phiên gần nhất kèm xúc xắc, tổng điểm, phân loại (Triple/Double/Seq)</p>
  </a>
  <a class="card" href="/thangthua">
    <span class="badge">JSON</span>
    <h2>📊 /thangthua</h2>
    <p>Thống kê win/lose, win rate, method nào hiệu quả nhất</p>
  </a>
  <a class="card" href="/dice-stats">
    <span class="badge new">NEW</span>
    <h2>🎲 /dice-stats</h2>
    <p>Phân tích tần suất mặt xúc xắc, mặt hot/cold, tỉ lệ Triple/Double trong 30 phiên</p>
  </a>
  <a class="card" href="/markov-table">
    <span class="badge new">NEW</span>
    <h2>🔢 /markov-table</h2>
    <p>Bảng chuyển trạng thái Markov bậc 1, 2, 3 toàn bộ history</p>
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

// ── /history ──────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const data  = history.slice(-limit).reverse().map(h => ({
    phien:             h.phien,
    xuc_xac:           h.dice,
    xuc_xac_phan_loai: h.dice ? classifyDice([...h.dice]).detail : null,
    tong:              h.tong,
    ket_qua:           h.ket_qua === 'T' ? 'Tài' : 'Xỉu'
  }));
  res.json({ total: history.length, hien_thi: data.length, data, id: '@sewdangcap' });
});

// ── /thangthua ────────────────────────────────────────────────
app.get('/thangthua', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const slice = winLoss.slice(-limit).reverse();
  const wins  = slice.filter(r => r.win).length;
  const loses = slice.length - wins;
  const rate  = slice.length ? Math.round(wins / slice.length * 100) : 0;

  const methodStats = {};
  for (const r of slice) {
    const m = r.method || 'unknown';
    methodStats[m] = methodStats[m] || { win: 0, lose: 0 };
    r.win ? methodStats[m].win++ : methodStats[m].lose++;
  }
  const methodRate = {};
  for (const [m, s] of Object.entries(methodStats)) {
    const total = s.win + s.lose;
    methodRate[m] = { win: s.win, lose: s.lose, win_rate: Math.round(s.win / total * 100) + '%' };
  }

  res.json({
    tong_phien: slice.length,
    win: wins, lose: loses,
    win_rate: rate + '%',
    theo_method: methodRate,
    chi_tiet: slice.map(r => ({
      phien:        r.phien,
      du_doan:      r.du_doan,
      ket_qua_thuc: r.ket_qua_thuc,
      do_tin_cay:   r.do_tin_cay + '%',
      method:       r.method,
      ket_luan:     r.win ? '✅ THẮNG' : '❌ THUA'
    })),
    id: '@sewdangcap'
  });
});

// ── /dice-stats ───────────────────────────────────────────────
app.get('/dice-stats', (req, res) => {
  const n = Math.min(Number(req.query.n) || 30, 200);
  if (history.length < 3) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const { freq, hot, cold } = diceFrequency(history, n);
  const slice = history.slice(-n);

  const typeCounts = { triple: 0, double: 0, sequence: 0, mixed: 0 };
  const recentDiceDetail = slice.reverse().slice(0, 20).map(h => {
    const cls = classifyDice(h.dice ? [...h.dice] : null);
    if (cls.type in typeCounts) typeCounts[cls.type]++;
    return { phien: h.phien, xuc_xac: h.dice, phan_loai: cls.detail, ket_qua: h.ket_qua === 'T' ? 'Tài' : 'Xỉu' };
  });

  const totalRolls = Object.values(freq).reduce((a, b) => a + b, 0);
  const freqPct = {};
  for (const [k, v] of Object.entries(freq))
    freqPct[k] = { count: v, pct: totalRolls > 0 ? Math.round(v / totalRolls * 100) + '%' : '0%' };

  res.json({
    phan_tich_trong: `${n} phiên gần nhất`,
    tan_suat_mat: freqPct,
    mat_hot: hot,
    mat_cold: cold,
    ty_le_loai: {
      triple:   { count: typeCounts.triple,   pct: Math.round(typeCounts.triple   / slice.length * 100) + '%' },
      double:   { count: typeCounts.double,   pct: Math.round(typeCounts.double   / slice.length * 100) + '%' },
      sequence: { count: typeCounts.sequence, pct: Math.round(typeCounts.sequence / slice.length * 100) + '%' },
      mixed:    { count: typeCounts.mixed,    pct: Math.round(typeCounts.mixed    / slice.length * 100) + '%' }
    },
    chi_tiet_20_phien: recentDiceDetail,
    id: '@sewdangcap'
  });
});

// ── /markov-table ─────────────────────────────────────────────
app.get('/markov-table', (req, res) => {
  if (history.length < 5) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const seq    = history.map(h => h.ket_qua);
  const tables = buildMarkovTables(seq);

  const formatTable = (tbl) => {
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
    tong_phien_phan_tich: history.length,
    bac_1: formatTable(tables.order1),
    bac_2: formatTable(tables.order2),
    bac_3: formatTable(tables.order3),
    ghi_chu: 'T=Tài, X=Xỉu. probT/probX = xác suất phiên tiếp theo sau khuôn mẫu tương ứng',
    id: '@sewdangcap'
  });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({
    error: 'Endpoint không tồn tại',
    endpoints: ['/', '/sunlon', '/history', '/thangthua', '/dice-stats', '/markov-table']
  })
);

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`
🎲 API Tool Tài Xỉu Sunwin v2.0 — DEV @sewdangcap
   http://localhost:${PORT}
   Polling: ${SOURCE_API}

   Modules: 68GB + Markov Bậc 1-2-3 + Dice Pattern + Dice Frequency
   New endpoints: /dice-stats  /markov-table
`)
);
