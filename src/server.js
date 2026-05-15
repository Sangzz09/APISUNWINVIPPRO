/**
 * ============================================================
 *  SIC BO PREDICTION API  —  DEV @sewdangcap
 *  v3.0 — Sunwin Rules + Markov Bậc 1-2-3 + Dice Pattern
 * ============================================================
 *
 *  THAY ĐỔI v3.0:
 *  ❌ Loại bỏ hoàn toàn Công Thức 68GB
 *  ✅ MODULE 1 (CHÍNH): Quy Tắc Sunwin — 10 Rules (3 nhóm ưu tiên)
 *  ✅ MODULE 2: Markov Chain Bậc 1-2-3 (hỗ trợ)
 *  ✅ MODULE 3: Dice Pattern Analyzer (hỗ trợ)
 *  ✅ Kết hợp 3 tín hiệu: SunwinRules + Markov + DicePattern
 * ============================================================
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

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
const isTai   = t => t >= 11 && t <= 18;
const isXiu   = t => t >= 3  && t <= 10;
const isChan  = t => t % 2 === 0;
const isLe    = t => t % 2 !== 0;
const label   = t => isTai(t) ? 'T' : 'X';
const fullLabel = t => isTai(t) ? 'Tài' : 'Xỉu';

// ═══════════════════════════════════════════════════════════════
//  MODULE 1 — QUY TẮC SUNWIN (10 Rules, 3 nhóm ưu tiên)
//
//  Quy ước:
//    T1 = kết quả mới nhất (hist[n-1])
//    T2 = trước T1         (hist[n-2])
//    T3 = trước T2         (hist[n-3])
//    T4 = trước T3         (hist[n-4])
//
//  🔴 NHÓM 1: Chuỗi dài  — xét trước (rule 1-4)
//  🟡 NHÓM 2: Chuỗi ngắn — xét thứ 2  (rule 5-9)
//  🟢 NHÓM 3: Dự phòng   — xét cuối   (rule 10)
// ═══════════════════════════════════════════════════════════════
function applySunwinRules(hist) {
  const n = hist.length;
  if (n < 2) return null;

  const T1 = hist[n - 1].tong;
  const T2 = n >= 2 ? hist[n - 2].tong : null;
  const T3 = n >= 3 ? hist[n - 3].tong : null;
  const T4 = n >= 4 ? hist[n - 4].tong : null;

  // ── 🔴 NHÓM 1: Chuỗi dài ─────────────────────────────────

  // Rule 1 — Mẫu 4 tay cố định: 11-17-16-13 → Bẻ Xỉu (dự đoán ~10)
  if (T4 === 11 && T3 === 17 && T2 === 16 && T1 === 13)
    return {
      du_doan: 'Xỉu', rule: 'SW-1', nhom: 1,
      mo_ta: `SunwinR1: Mẫu cố định 11-17-16-13 → Bẻ Xỉu (dự đoán ~10)`
    };

  // Rule 2 — Mẫu 4 tay: TàiLẻ-TàiLẻ-TàiChẵn-TàiChẵn → Theo tiếp Tài
  if (T4 !== null &&
      isTai(T4) && isLe(T4) &&
      isTai(T3) && isLe(T3) &&
      isTai(T2) && isChan(T2) &&
      isTai(T1) && isChan(T1))
    return {
      du_doan: 'Tài', rule: 'SW-2', nhom: 1,
      mo_ta: `SunwinR2: Mẫu TàiLẻ×2→TàiChẵn×2 (${T4}-${T3}-${T2}-${T1}) → Theo tiếp Tài`
    };

  // Rule 3 — Xỉu bệt nhảy lên Tài Chẵn → Bẻ Xỉu
  if (T3 !== null && isXiu(T3) && isXiu(T2) && isTai(T1) && isChan(T1))
    return {
      du_doan: 'Xỉu', rule: 'SW-3', nhom: 1,
      mo_ta: `SunwinR3: Xỉu-Xỉu nhảy lên Tài Chẵn ${T1} → Bẻ xuống Xỉu`
    };

  // Rule 4 — 3 Xỉu liên tiếp → Bẻ Tài
  if (T3 !== null && isXiu(T1) && isXiu(T2) && isXiu(T3))
    return {
      du_doan: 'Tài', rule: 'SW-4', nhom: 1,
      mo_ta: `SunwinR4: 3 Xỉu liên tiếp (${T3}-${T2}-${T1}) → Bẻ lên Tài`
    };

  // ── 🟡 NHÓM 2: Chuỗi ngắn đặc biệt ─────────────────────

  // Rule 5 — Tài Chẵn giảm dần → Đánh tiếp Tài (~11)
  if (T2 !== null && isTai(T2) && isChan(T2) && isTai(T1) && isChan(T1) && T1 < T2)
    return {
      du_doan: 'Tài', rule: 'SW-5', nhom: 2,
      mo_ta: `SunwinR5: Tài Chẵn giảm dần ${T2}→${T1} → Tiếp Tài (dự đoán ~11)`
    };

  // Rule 6 — Tài Chẵn ngang/tăng → Bẻ Xỉu
  if (T2 !== null && isTai(T2) && isChan(T2) && isTai(T1) && isChan(T1) && T1 >= T2)
    return {
      du_doan: 'Xỉu', rule: 'SW-6', nhom: 2,
      mo_ta: `SunwinR6: Tài Chẵn ngang/tăng ${T2}→${T1} → Bẻ qua Xỉu`
    };

  // Rule 7 — Tài Chẵn (kể cả 16) → Tài 11 → Bẻ Xỉu
  if (T2 !== null && isTai(T2) && isChan(T2) && T1 === 11)
    return {
      du_doan: 'Xỉu', rule: 'SW-7', nhom: 2,
      mo_ta: `SunwinR7: Tài Chẵn ${T2} → Tài 11 → Bẻ xuống Xỉu`
    };

  // Rule 8 — Tài Lẻ → Xỉu 10 → Bẻ ngược Tài
  if (T2 !== null && isTai(T2) && isLe(T2) && T1 === 10)
    return {
      du_doan: 'Tài', rule: 'SW-8', nhom: 2,
      mo_ta: `SunwinR8: Tài Lẻ ${T2} → Xỉu 10 → Bẻ ngược lên Tài`
    };

  // Rule 9 — Xỉu Lẻ → Xỉu Chẵn (kể cả 10) → Bẻ Tài
  if (T2 !== null && isXiu(T2) && isLe(T2) && isXiu(T1) && isChan(T1))
    return {
      du_doan: 'Tài', rule: 'SW-9', nhom: 2,
      mo_ta: `SunwinR9: Xỉu Lẻ ${T2} → Xỉu Chẵn ${T1} → Bẻ lên Tài`
    };

  // ── 🟢 NHÓM 3: Dự phòng ──────────────────────────────────

  // Rule 10 — 2 Xỉu liên tiếp (không khớp mẫu trên) → Bẻ Tài
  if (T2 !== null && isXiu(T2) && isXiu(T1))
    return {
      du_doan: 'Tài', rule: 'SW-10', nhom: 3,
      mo_ta: `SunwinR10: 2 Xỉu liên tiếp (${T2}-${T1}) → Bẻ Tài`
    };

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

const MARKOV_WEIGHTS    = { order3: 0.50, order2: 0.30, order1: 0.20 };
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
    details.order3 = {
      key: k3, T: m3.T, X: m3.X, total: m3.total,
      probT: Math.round(m3.T / m3.total * 100),
      probX: Math.round(m3.X / m3.total * 100)
    };
  }

  const k2 = seq[n - 2] + seq[n - 1];
  const m2  = tables.order2[k2];
  if (m2 && m2.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order2;
    scores.T += w * (m2.T / m2.total);
    scores.X += w * (m2.X / m2.total);
    totalWeight += w;
    details.order2 = {
      key: k2, T: m2.T, X: m2.X, total: m2.total,
      probT: Math.round(m2.T / m2.total * 100),
      probX: Math.round(m2.X / m2.total * 100)
    };
  }

  const k1 = seq[n - 1];
  const m1  = tables.order1[k1];
  if (m1 && m1.total >= MARKOV_MIN_SAMPLE) {
    const w = MARKOV_WEIGHTS.order1;
    scores.T += w * (m1.T / m1.total);
    scores.X += w * (m1.X / m1.total);
    totalWeight += w;
    details.order1 = {
      key: k1, T: m1.T, X: m1.X, total: m1.total,
      probT: Math.round(m1.T / m1.total * 100),
      probX: Math.round(m1.X / m1.total * 100)
    };
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
  const [a, b, c] = [...dice].sort((x, y) => x - y);

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

  const recent     = hist.slice(-5);
  const types      = recent.map(h => classifyDice(h.dice));
  const last3Types = types.slice(-3);

  if (last3Types.every(t => t.type === 'triple'))
    return { du_doan: 'Tài', do_tin_cay: 72, mo_ta: 'DicePattern: 3 Triple liên tiếp → đẩy Tài' };

  const last3     = hist.slice(-3);
  const allDouble = last3.every(h => classifyDice(h.dice).type === 'double');
  if (allDouble) {
    const vals = last3.map(h => classifyDice(h.dice).value);
    if (vals[0] > vals[1] && vals[1] > vals[2])
      return {
        du_doan: 'Xỉu', do_tin_cay: 68,
        mo_ta: `DicePattern: Double giảm dần ${vals[0]}→${vals[1]}→${vals[2]} → Xỉu`
      };
  }

  const { freq } = diceFrequency(hist, 20);
  const totalRolls = Object.values(freq).reduce((a, b) => a + b, 0);
  if (totalRolls < 30) return null;

  const high = (freq[5] + freq[6]) / totalRolls;
  const low  = (freq[1] + freq[2]) / totalRolls;

  if (high > 0.46)
    return { du_doan: 'Tài', do_tin_cay: 63, mo_ta: `DicePattern: Mặt 5+6 hot (${Math.round(high * 100)}%) → Tài` };
  if (low  > 0.46)
    return { du_doan: 'Xỉu', do_tin_cay: 63, mo_ta: `DicePattern: Mặt 1+2 hot (${Math.round(low  * 100)}%) → Xỉu` };

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  MODULE 4 — KẾT HỢP 3 TÍN HIỆU
//  Thứ tự ưu tiên: SunwinRules → Markov → DicePattern
// ═══════════════════════════════════════════════════════════════
function combinePrediction(hist) {
  if (hist.length < 2) return { du_doan: 'Tài', do_tin_cay: 50, method: 'default' };

  const totals = hist.map(h => h.tong);
  const seq    = totals.map(label);

  const sunwin = applySunwinRules(hist);
  const mrk    = markovPredict(seq);
  const dice   = dicePatternPredict(hist);

  const votes   = { T: 0, X: 0 };
  const signals = [];

  // SunwinRules: trọng số theo nhóm
  if (sunwin) {
    const v  = sunwin.du_doan === 'Tài' ? 'T' : 'X';
    const wt = sunwin.nhom === 1 ? 4   // Nhóm 1: ưu tiên cao nhất
              : sunwin.nhom === 2 ? 3   // Nhóm 2: ưu tiên cao
              : 1;                      // Nhóm 3: dự phòng
    votes[v] += wt;
    signals.push({ src: 'SunwinRules', pred: sunwin.du_doan, rule: sunwin.rule, nhom: sunwin.nhom });
  }

  // Markov
  if (mrk) {
    const v  = mrk.du_doan === 'Tài' ? 'T' : 'X';
    const wt = mrk.do_tin_cay >= 70 ? 2 : 1;
    votes[v] += wt;
    signals.push({ src: 'Markov', pred: mrk.du_doan, conf: mrk.do_tin_cay, details: mrk.details });
  }

  // DicePattern
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

  // Tính độ tin cậy
  let conf;
  if (!sunwin && !mrk && !dice) {
    conf = 50;
  } else if (sunwin && mrk && mrk.du_doan === sunwin.du_doan) {
    // Sunwin + Markov đồng thuận
    const base = sunwin.nhom === 1 ? 85 : sunwin.nhom === 2 ? 78 : 65;
    conf = Math.min(92, Math.round((mrk.do_tin_cay + base) / 2) + 5);
  } else if (sunwin) {
    // Chỉ Sunwin
    const base = sunwin.nhom === 1 ? 75 : sunwin.nhom === 2 ? 68 : 58;
    conf = Math.max(base, Math.round(agreement * 0.8 + 10));
  } else {
    conf = Math.max(52, Math.round(agreement * 0.75 + 10));
  }

  // Xác định method
  let method;
  if (sunwin && mrk && dice) method = 'sunwin+markov+dice';
  else if (sunwin && mrk)    method = 'sunwin+markov';
  else if (sunwin && dice)   method = 'sunwin+dice';
  else if (sunwin)           method = 'sunwin';
  else if (mrk && dice)      method = 'markov+dice';
  else if (mrk)              method = 'markov';
  else                       method = 'dice';

  // Ưu tiên mo_ta: Nhóm 1 Sunwin > Nhóm 2 > Markov > Dice
  const bestMoTa = sunwin
    ? sunwin.mo_ta
    : mrk
      ? `Markov ${mrk.do_tin_cay}% → ${mrk.du_doan}`
      : dice?.mo_ta ?? 'Không đủ tín hiệu';

  const bestRule = sunwin
    ? sunwin.rule
    : mrk ? 'Markov' : 'DicePattern';

  return {
    du_doan:    winner,
    do_tin_cay: conf,
    rule:       bestRule,
    mo_ta:      bestMoTa,
    method,
    votes,
    signals,
    markov_detail: mrk ? {
      bac1:   mrk.details.order1 || null,
      bac2:   mrk.details.order2 || null,
      bac3:   mrk.details.order3 || null,
      scores: mrk.scores
    } : null
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

    if (!Array.isArray(data) || data.length === 0) {
      console.error('[fetchAndUpdate] Dữ liệu nguồn không phải mảng:', data);
      return null;
    }

    const sorted = [...data].sort((a, b) => a.session - b.session);
    const latest = sorted[sorted.length - 1];

    const existingSessions = new Set(history.map(h => h.phien));

    for (const item of sorted) {
      const phien = String(item.session);
      if (existingSessions.has(phien)) continue;

      const diceArr = Array.isArray(item.dice) && item.dice.length === 3
        ? item.dice.map(Number)
        : null;

      const tong = typeof item.total === 'number'
        ? item.total
        : (diceArr ? diceArr.reduce((a, b) => a + b, 0) : 0);

      const ketQua = item.ket_qua === 'Tài' ? 'T'
                   : item.ket_qua === 'Xỉu' ? 'X'
                   : label(tong);

      history.push({ phien, dice: diceArr, tong, ket_qua: ketQua });
      existingSessions.add(phien);

      // Kiểm tra win/loss cho pending
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

    const latestTotal = typeof latest.total === 'number'
      ? latest.total
      : (Array.isArray(latest.dice) ? latest.dice.reduce((a, b) => a + b, 0) : 0);

    const latestDice     = Array.isArray(latest.dice) ? latest.dice : null;
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
<title>API Tool Tài Xỉu Sunwin v3.0 — DEV @sewdangcap</title>
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
  .badge.hot{background:#da3633}
  .badge.new{background:#9a3fb9}
  footer{margin-top:48px;color:#484f58;font-size:.8rem}
  .algo{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;width:100%;max-width:860px;margin-bottom:24px}
  .algo h3{color:#f0883e;margin-bottom:12px;font-size:.95rem}
  .algo ul{padding-left:18px;color:#8b949e;font-size:.82rem;line-height:2}
  .algo .g1{color:#ff7b72} .algo .g2{color:#e3b341} .algo .g3{color:#3fb950}
</style>
</head>
<body>
<h1>🎲 API Tool Tài Xỉu Sunwin</h1>
<p class="sub">DEV @sewdangcap</p>
<p class="ver">v3.0 — Sunwin Rules (10 quy tắc) + Markov Bậc 1-2-3 + Dice Pattern</p>

<div class="algo">
  <h3>🧠 Thuật toán đang chạy</h3>
  <ul>
    <li><span class="g1">🔴 NHÓM 1 (Ưu tiên cao nhất, trọng số 4):</span> Quy tắc 1-4 — Chuỗi dài</li>
    <li><span class="g2">🟡 NHÓM 2 (Ưu tiên cao, trọng số 3):</span> Quy tắc 5-9 — Chuỗi ngắn đặc biệt</li>
    <li><span class="g3">🟢 NHÓM 3 (Dự phòng, trọng số 1):</span> Quy tắc 10 — Cơ bản</li>
    <li>+ Markov Chain Bậc 1/2/3 (hỗ trợ, trọng số 1-2)</li>
    <li>+ Dice Pattern Analyzer (hỗ trợ, trọng số 1)</li>
  </ul>
</div>

<div class="grid">
  <a class="card" href="/sunlon">
    <span class="badge hot">MAIN</span>
    <h2>⚡ /sunlon</h2>
    <p>Dự đoán realtime. Kết hợp SunwinRules + Markov bậc 3 + Dice Pattern</p>
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
    methodRate[m] = {
      win: s.win, lose: s.lose,
      win_rate: Math.round(s.win / total * 100) + '%'
    };
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
  const recentDiceDetail = [...slice].reverse().slice(0, 20).map(h => {
    const cls = classifyDice(h.dice ? [...h.dice] : null);
    if (cls.type in typeCounts) typeCounts[cls.type]++;
    return {
      phien:    h.phien,
      xuc_xac:  h.dice,
      phan_loai: cls.detail,
      ket_qua:  h.ket_qua === 'T' ? 'Tài' : 'Xỉu'
    };
  });

  const totalRolls = Object.values(freq).reduce((a, b) => a + b, 0);
  const freqPct = {};
  for (const [k, v] of Object.entries(freq))
    freqPct[k] = {
      count: v,
      pct: totalRolls > 0 ? Math.round(v / totalRolls * 100) + '%' : '0%'
    };

  res.json({
    phan_tich_trong: `${n} phiên gần nhất`,
    tan_suat_mat:    freqPct,
    mat_hot:         hot,
    mat_cold:        cold,
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
🎲 API Tool Tài Xỉu Sunwin v3.0 — DEV @sewdangcap
   http://localhost:${PORT}
   Polling: ${SOURCE_API}

   Modules: SunwinRules (10 quy tắc, 3 nhóm) + Markov Bậc 1-2-3 + Dice Pattern
   ❌ Đã loại bỏ: Công Thức 68GB
   Endpoints: /sunlon  /history  /thangthua  /dice-stats  /markov-table
`)
);
