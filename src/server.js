/**
 * ============================================================
 *  SIC BO PREDICTION API  —  DEV @sewdangcap
 *  v3.0 — Sunwin Rules + Markov Bậc 1-2-3 + Dice Pattern
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

  if (T2 !== null && isTai(T2) && isLe(T2) && T1 === 10)
    return { du_doan: 'Tài', rule: 'SW-8', nhom: 2, mo_ta: `SunwinR8: Tài Lẻ ${T2} → Xỉu 10 → Bẻ Tài` };

  if (T2 !== null && isXiu(T2) && isLe(T2) && isXiu(T1) && isChan(T1))
    return { du_doan: 'Tài', rule: 'SW-9', nhom: 2, mo_ta: `SunwinR9: Xỉu Lẻ → Xỉu Chẵn → Bẻ Tài` };

  if (T2 !== null && isXiu(T2) && isXiu(T1))
    return { du_doan: 'Tài', rule: 'SW-10', nhom: 3, mo_ta: `SunwinR10: 2 Xỉu liên tiếp → Bẻ Tài` };

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
  const n = seq.length;
  const scores = { T: 0, X: 0 };
  const details = {};
  let totalWeight = 0;

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
//  MODULE 4 — KẾT HỢP 3 TÍN HIỆU
// ═══════════════════════════════════════════════════════════════
function combinePrediction(hist) {
  if (hist.length < 2) return { du_doan: 'Tài', do_tin_cay: 50, rule: '-', mo_ta: 'Không đủ dữ liệu', method: 'default' };

  const seq    = hist.map(h => h.tong).map(label);
  const sunwin = applySunwinRules(hist);
  const mrk    = markovPredict(seq);
  const dice   = dicePatternPredict(hist);

  const votes = { T: 0, X: 0 };
  const signals = [];

  if (sunwin) {
    const v  = sunwin.du_doan === 'Tài' ? 'T' : 'X';
    const wt = sunwin.nhom === 1 ? 4 : sunwin.nhom === 2 ? 3 : 1;
    votes[v] += wt;
    signals.push({ src: 'SunwinRules', pred: sunwin.du_doan, rule: sunwin.rule });
  }
  if (mrk) {
    const v  = mrk.du_doan === 'Tài' ? 'T' : 'X';
    votes[v] += mrk.do_tin_cay >= 70 ? 2 : 1;
    signals.push({ src: 'Markov', pred: mrk.du_doan, conf: mrk.do_tin_cay });
  }
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

  let conf;
  if (sunwin && mrk && mrk.du_doan === sunwin.du_doan) {
    const base = sunwin.nhom === 1 ? 85 : sunwin.nhom === 2 ? 78 : 65;
    conf = Math.min(92, Math.round((mrk.do_tin_cay + base) / 2) + 5);
  } else if (sunwin) {
    const base = sunwin.nhom === 1 ? 75 : sunwin.nhom === 2 ? 68 : 58;
    conf = Math.max(base, Math.round(agreement * 0.8 + 10));
  } else {
    conf = Math.max(52, Math.round(agreement * 0.75 + 10));
  }

  let method;
  if (sunwin && mrk && dice)   method = 'sunwin+markov+dice';
  else if (sunwin && mrk)      method = 'sunwin+markov';
  else if (sunwin && dice)     method = 'sunwin+dice';
  else if (sunwin)             method = 'sunwin';
  else if (mrk && dice)        method = 'markov+dice';
  else if (mrk)                method = 'markov';
  else                         method = 'dice';

  const mo_ta = sunwin ? sunwin.mo_ta
    : mrk ? `Markov ${mrk.do_tin_cay}% → ${mrk.du_doan}`
    : dice?.mo_ta ?? 'Không đủ tín hiệu';

  return {
    du_doan:    winner,
    do_tin_cay: conf,
    rule:       sunwin?.rule ?? (mrk ? 'Markov' : 'DicePattern'),
    mo_ta,
    method,
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
      do_tin_cay:    predict.do_tin_cay + '%',
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
<title>API Tài Xỉu Sunwin v3.0 — @sewdangcap</title>
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
    max-width:800px;
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
  footer{margin-top:48px;color:#484f58;font-size:.8rem}
</style>
</head>
<body>
<h1>🎲 API Tài Xỉu Sunwin</h1>
<p class="sub">DEV @sewdangcap</p>
<p class="ver">v3.0 — SunwinRules + Markov Bậc 1-2-3 + Dice Pattern</p>

<div class="grid">
  <a class="card" href="/sunlon">
    <span class="icon">⚡</span>
    <h2>Dự đoán realtime</h2>
    <p>Kết quả phiên hiện tại + dự đoán phiên tiếp theo. Cập nhật mỗi 5 giây.</p>
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

// ── /thongke (thống kê rõ ràng từng phiên + tổng) ────────────
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

  // Method stats
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
    id:         '@sewdangcap',
    // ── TỔNG QUAN ────────────────────────────────────────────
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
    // ── CHI TIẾT TỪNG PHIÊN ──────────────────────────────────
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

// ── /thangthua (giữ lại để không break client cũ) ────────────
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
    endpoints: ['/', '/sunlon', '/thongke', '/history', '/dice-stats', '/markov-table']
  })
);

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`
🎲 API Tài Xỉu Sunwin v3.0 — DEV @sewdangcap
   http://localhost:${PORT}
   Polling: ${SOURCE_API}
   Endpoints: /sunlon  /thongke  /history  /dice-stats  /markov-table
`)
);
