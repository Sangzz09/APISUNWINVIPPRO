/**
 * ============================================================
 *  SIC BO PREDICTION API  —  DEV @sewdangcap
 *  Kết hợp: Công Thức 68GB + Markov Chain Bậc 1-2-3
 *  Deploy: Render.com  |  Node.js 18+
 * ============================================================
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Source API ───────────────────────────────────────────────
const SOURCE_API = 'https://apisunw-wspro.onrender.com/api/taixiu/history';

// ─── In-memory store ─────────────────────────────────────────
let history    = [];   // rolling 200 phiên
let winLoss    = [];   // { phien, du_doan, ket_qua_thuc, win }

// ─── Helpers ─────────────────────────────────────────────────
const isTai  = t => t >= 11 && t <= 18;
const isXiu  = t => t >= 3  && t <= 10;
const isChan = t => t % 2 === 0;
const isLe   = t => t % 2 !== 0;
const label  = t => isTai(t) ? 'T' : 'X';
const fullLabel = t => isTai(t) ? 'Tài' : 'Xỉu';

// ─────────────────────────────────────────────────────────────
//  CÔNG THỨC 68GB
// ─────────────────────────────────────────────────────────────
function apply68GB(totals) {
  const n = totals.length;
  if (n < 2) return null;

  const t0 = totals[n - 1];
  const t1 = totals[n - 2];
  const t2 = n >= 3 ? totals[n - 3] : null;
  const t3 = n >= 4 ? totals[n - 4] : null;

  if (n >= 3 && t0 === t1 && t1 === t2 && isXiu(t0) && isChan(t0)) {
    if (t0 === 10) return { du_doan: 'Xỉu', rule: '1.1-NL', mo_ta: 'CT68 R1.1 Ngoại lệ 10-10-10 → Tiếp Xỉu' };
    return { du_doan: 'Tài', rule: '1.1', mo_ta: `CT68 R1.1 Bộ 3 Xỉu Chẵn ${t0}-${t0}-${t0} → Bẻ Tài` };
  }
  if (n >= 3 && t0 === t1 && t1 === t2 && isXiu(t0) && isLe(t0)) {
    return { du_doan: 'Xỉu', rule: '1.2', mo_ta: `CT68 R1.2 Bộ 3 Xỉu Lẻ ${t0}-${t0}-${t0} → Tiếp Xỉu` };
  }
  if (t0 === 16 || t0 === 17) {
    return { du_doan: 'Xỉu', rule: '1.3', mo_ta: `CT68 R1.3 Max Tài (${t0}) → Bẻ Xỉu` };
  }
  if (n >= 4 && t0 === 11 && t1 === 11 && isXiu(t2) && isXiu(t3)) {
    return { du_doan: 'Tài', rule: '1.4', mo_ta: `CT68 R1.4 Kép 11 sau bệt Xỉu → Tiếp Tài` };
  }

  if (t0 === t1) {
    if (isXiu(t0) && isChan(t0))
      return { du_doan: 'Xỉu', rule: '2.1', mo_ta: `CT68 R2.1 Kép Xỉu Chẵn ${t0}-${t0} → Tiếp Xỉu` };
    if (isXiu(t0) && isLe(t0))
      return { du_doan: 'Tài', rule: '2.2', mo_ta: `CT68 R2.2 Kép Xỉu Lẻ ${t0}-${t0} → Bẻ Tài` };
    if (isTai(t0) && isChan(t0))
      return { du_doan: 'Xỉu', rule: '2.3', mo_ta: `CT68 R2.3 Kép Tài Chẵn ${t0}-${t0} → Bẻ Xỉu` };
    if (isTai(t0) && isLe(t0))
      return { du_doan: 'Tài', rule: '2.4', mo_ta: `CT68 R2.4 Kép Tài Lẻ ${t0}-${t0} → Tiếp Tài` };
  }

  if (n >= 5) {
    const last5 = totals.slice(n - 5);
    const allSame = last5.every(v => label(v) === label(last5[0]));
    if (allSame)
      return { du_doan: isTai(t0) ? 'Xỉu' : 'Tài', rule: '3.1', mo_ta: `CT68 R3.1 Bệt 5 ${label(t0)} → Bẻ` };
  }
  if (n >= 3) {
    let bietLen = 0, bietStart = null;
    for (let i = n - 1; i >= 0; i--) {
      if (label(totals[i]) === label(t0)) { bietLen++; bietStart = totals[i]; }
      else break;
    }
    if (bietLen >= 3 && t0 <= bietStart)
      return { du_doan: isTai(t0) ? 'Xỉu' : 'Tài', rule: '3.2', mo_ta: `CT68 R3.2 Bệt suy yếu (${bietLen} tay) → Bẻ` };
  }

  if (n >= 3) {
    if (isXiu(t0) && isTai(t1) && isXiu(t2) && t0 === t2)
      return { du_doan: 'Tài', rule: '4.1', mo_ta: `CT68 R4.1 Cầu 1-1 đặc biệt ${t2}-${t1}-${t0} → Bệt Tài 3 tay` };
    if (isXiu(t0) && isTai(t1) && isXiu(t2) && t2 > t0)
      return { du_doan: 'Xỉu', rule: '4.2', mo_ta: `CT68 R4.2 Phá cầu 1-1 (${t2}-${t1}-${t0}) → Bẻ Xỉu` };
    if (isXiu(t0) && isTai(t1) && isXiu(t2))
      return { du_doan: 'Tài', rule: '4.3', mo_ta: `CT68 R4.3 Tạo cầu 1-1 → Bẻ lên Tài` };
  }

  if (isXiu(t0) && isXiu(t1)) {
    if (isChan(t0) !== isChan(t1))
      return { du_doan: 'Tài', rule: '5.1', mo_ta: `CT68 R5.1 2 Xỉu Chẵn/Lẻ xen (${t1}-${t0}) → Bẻ Tài` };
    if (t0 < t1)
      return { du_doan: 'Xỉu', rule: '5.2', mo_ta: `CT68 R5.2 Xỉu lùi (${t1}→${t0}) → Tiếp Xỉu` };
  }

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

// ─────────────────────────────────────────────────────────────
//  MARKOV CHAIN BẬC 1-2-3
// ─────────────────────────────────────────────────────────────
function buildMarkov(seq) {
  const m = { order1: {}, order2: {}, order3: {} };
  for (let i = 1; i < seq.length; i++) {
    const k1 = seq[i - 1];
    m.order1[k1] = m.order1[k1] || { T: 0, X: 0 };
    m.order1[k1][seq[i]]++;
  }
  for (let i = 2; i < seq.length; i++) {
    const k2 = seq[i - 2] + seq[i - 1];
    m.order2[k2] = m.order2[k2] || { T: 0, X: 0 };
    m.order2[k2][seq[i]]++;
  }
  for (let i = 3; i < seq.length; i++) {
    const k3 = seq[i - 3] + seq[i - 2] + seq[i - 1];
    m.order3[k3] = m.order3[k3] || { T: 0, X: 0 };
    m.order3[k3][seq[i]]++;
  }
  return m;
}

function markovPredict(seq) {
  if (seq.length < 4) return null;
  const m = buildMarkov(seq);
  const n = seq.length;
  const scores = { T: 0, X: 0 };

  const k3 = seq[n - 3] + seq[n - 2] + seq[n - 1];
  if (m.order3[k3]) {
    const { T = 0, X = 0 } = m.order3[k3];
    const tot = T + X;
    if (tot > 0) { scores.T += 3 * T / tot; scores.X += 3 * X / tot; }
  }
  const k2 = seq[n - 2] + seq[n - 1];
  if (m.order2[k2]) {
    const { T = 0, X = 0 } = m.order2[k2];
    const tot = T + X;
    if (tot > 0) { scores.T += 2 * T / tot; scores.X += 2 * X / tot; }
  }
  const k1 = seq[n - 1];
  if (m.order1[k1]) {
    const { T = 0, X = 0 } = m.order1[k1];
    const tot = T + X;
    if (tot > 0) { scores.T += T / tot; scores.X += X / tot; }
  }

  const total = scores.T + scores.X;
  if (total === 0) return null;
  const pred  = scores.T >= scores.X ? 'T' : 'X';
  const conf  = Math.round(Math.max(scores.T, scores.X) / total * 100);
  return { du_doan: pred === 'T' ? 'Tài' : 'Xỉu', do_tin_cay: conf };
}

// ─────────────────────────────────────────────────────────────
//  KẾT HỢP: 68GB + MARKOV
// ─────────────────────────────────────────────────────────────
function combinePrediction(totals) {
  if (totals.length < 2) return { du_doan: 'Tài', do_tin_cay: 50, method: 'default' };

  const seq = totals.map(label);
  const r68 = apply68GB(totals);
  const mrk = markovPredict(seq);

  if (!r68 && !mrk) return { du_doan: 'Tài', do_tin_cay: 50, method: 'default' };
  if (!r68) return { ...mrk, rule: 'Markov', mo_ta: `Markov Bậc 1-2-3 → ${mrk.du_doan}`, method: 'markov' };
  if (!mrk) return { ...r68, do_tin_cay: 65, method: '68gb' };

  if (r68.du_doan === mrk.du_doan) {
    const conf = Math.min(95, Math.round((mrk.do_tin_cay + 75) / 2) + 10);
    return { du_doan: r68.du_doan, do_tin_cay: conf, rule: r68.rule, mo_ta: r68.mo_ta + ' | Markov đồng thuận', method: 'combo' };
  }
  const conf = Math.max(55, Math.round(mrk.do_tin_cay * 0.4 + 60 * 0.6));
  return { du_doan: r68.du_doan, do_tin_cay: conf, rule: r68.rule, mo_ta: r68.mo_ta + ' | Markov bất đồng', method: '68gb-priority' };
}

// ─────────────────────────────────────────────────────────────
//  FETCH dữ liệu nguồn & cập nhật history
// ─────────────────────────────────────────────────────────────
let lastPhien = null;
let pendingPrediction = null;

async function fetchAndUpdate() {
  try {
    const res  = await fetch(SOURCE_API, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();

    const phien   = String(data.phien);
    const xucXac  = data.xuc_xac || null;
    const tong    = Array.isArray(xucXac) ? xucXac.reduce((a, b) => a + b, 0) : 0;

    if (lastPhien && phien !== lastPhien) {
      history.push({ phien, xuc_xac: xucXac, tong, ket_qua: label(tong) });
      if (history.length > 200) history.shift();

      if (pendingPrediction && String(pendingPrediction.phien_du_doan) === phien) {
        const win = pendingPrediction.du_doan_raw === label(tong);
        winLoss.push({
          phien,
          du_doan:      pendingPrediction.du_doan,
          ket_qua_thuc: fullLabel(tong),
          win,
          do_tin_cay:   pendingPrediction.do_tin_cay
        });
        if (winLoss.length > 200) winLoss.shift();
      }
    }

    lastPhien = phien;

    const totals  = history.map(h => h.tong);
    const predict = combinePrediction(totals);
    const pattern = history.slice(-25).map(h => h.ket_qua).join('').toLowerCase();
    const phienNext = String(Number(data.phien_hien_tai));

    pendingPrediction = {
      phien_du_doan: phienNext,
      du_doan:       predict.du_doan,
      du_doan_raw:   predict.du_doan === 'Tài' ? 'T' : 'X',
      do_tin_cay:    predict.do_tin_cay,
      rule:          predict.rule  || 'default',
      mo_ta:         predict.mo_ta || 'Không đủ dữ liệu',
      method:        predict.method
    };

    // ── Chỉ trả về các field yêu cầu ──
    return {
      phien_hien_tai: Number(data.phien_hien_tai),
      ket_qua:        fullLabel(tong),
      xuc_xac:        xucXac,
      phien_du_doan:  Number(phienNext),
      du_doan:        predict.du_doan,
      do_tin_cay:     predict.do_tin_cay + '%',
      pattern:        pattern || (data.pattern || ''),
      id:             '@sewdangcap'
    };

  } catch (e) {
    console.error('[fetchAndUpdate]', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  POLLING mỗi 5 giây
// ─────────────────────────────────────────────────────────────
let latestData = null;
async function poll() {
  const d = await fetchAndUpdate();
  if (d) latestData = d;
}
poll();
setInterval(poll, 5000);

// ─────────────────────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  HOME  —  HTML điều hướng (ĐÃ CẬP NHẬT TITLE)
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>API Tool Tài Xỉu Sunwin — DEV @sewdangcap</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
  h1{font-size:2rem;font-weight:700;margin-bottom:6px;color:#58a6ff}
  .sub{color:#8b949e;font-size:.9rem;margin-bottom:40px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;width:100%;max-width:900px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;cursor:pointer;transition:all .2s;text-decoration:none;color:inherit}
  .card:hover{border-color:#58a6ff;transform:translateY(-2px);box-shadow:0 8px 24px rgba(88,166,255,.15)}
  .card h2{font-size:1.1rem;margin-bottom:8px;color:#58a6ff}
  .card p{font-size:.85rem;color:#8b949e;line-height:1.5}
  .badge{display:inline-block;background:#238636;color:#fff;font-size:.7rem;padding:2px 8px;border-radius:20px;margin-bottom:10px}
  footer{margin-top:48px;color:#484f58;font-size:.8rem}
</style>
</head>
<body>
<h1>API Tool Tài Xỉu Sunwin</h1>
<p class="sub">Được dev bởi @sewdangcap</p>
<div class="grid">
  <a class="card" href="/sunlon">
    <span class="badge">JSON</span>
    <h2>⚡ /sunlon</h2>
    <p>Dự đoán phiên tiếp theo — JSON realtime kết hợp 68GB + Markov</p>
  </a>
  <a class="card" href="/history">
    <span class="badge">JSON</span>
    <h2>📜 /history</h2>
    <p>Lịch sử 50 phiên gần nhất với tổng điểm xúc xắc</p>
  </a>
  <a class="card" href="/thangthua">
    <span class="badge">JSON</span>
    <h2>📊 /thangthua</h2>
    <p>Thống kê thắng / thua — Win rate, tổng win/lose từng phiên</p>
  </a>
  <a class="card" href="/id">
    <span class="badge">INFO</span>
    <h2>👤 /id</h2>
    <p>Thông tin dev &amp; liên hệ Telegram @sewdangcap</p>
  </a>
</div>
<footer>© 2025 DEV @sewdangcap — All rights reserved</footer>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────
//  /sunlon  —  JSON dự đoán chính (fields tinh gọn)
// ─────────────────────────────────────────────────────────────
app.get('/sunlon', async (req, res) => {
  if (!latestData) {
    const d = await fetchAndUpdate();
    if (d) latestData = d;
  }
  if (!latestData) return res.status(503).json({ error: 'Đang tải dữ liệu, thử lại sau...' });
  res.json(latestData);
});

// ─────────────────────────────────────────────────────────────
//  /history  —  Lịch sử phiên
// ─────────────────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const data  = history.slice(-limit).reverse().map(h => ({
    phien:    h.phien,
    xuc_xac:  h.xuc_xac,
    tong:     h.tong,
    ket_qua:  h.ket_qua === 'T' ? 'Tài' : 'Xỉu'
  }));
  res.json({
    total:    history.length,
    hien_thi: data.length,
    data,
    id: '@sewdangcap'
  });
});

// ─────────────────────────────────────────────────────────────
//  /thangthua  —  Thống kê W/L
// ─────────────────────────────────────────────────────────────
app.get('/thangthua', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const slice = winLoss.slice(-limit).reverse();
  const wins  = slice.filter(r => r.win).length;
  const loses = slice.length - wins;
  const rate  = slice.length ? Math.round(wins / slice.length * 100) : 0;

  res.json({
    tong_phien: slice.length,
    win:        wins,
    lose:       loses,
    win_rate:   rate + '%',
    chi_tiet:   slice.map(r => ({
      phien:        r.phien,
      du_doan:      r.du_doan,
      ket_qua_thuc: r.ket_qua_thuc,
      do_tin_cay:   r.do_tin_cay + '%',
      ket_luan:     r.win ? '✅ THẮNG' : '❌ THUA'
    })),
    id: '@sewdangcap'
  });
});

// ─────────────────────────────────────────────────────────────
//  /id  —  Thông tin dev
// ─────────────────────────────────────────────────────────────
app.get('/id', (req, res) => {
  res.json({
    ten_du_an: 'API Tool Tài Xỉu Sunwin',
    mo_ta:     'Dự đoán Tài Xỉu kết hợp Công Thức 68GB + Markov Chain Bậc 1-2-3',
    phac_do:   [
      'Công Thức 68GB Bàn Xanh (6 quy tắc, 20+ nhánh)',
      'Markov Chain Bậc 1 (trọng số 1)',
      'Markov Chain Bậc 2 (trọng số 2)',
      'Markov Chain Bậc 3 (trọng số 3)',
      'Kết hợp: ưu tiên 68GB, Markov tăng/giảm độ tin cậy'
    ],
    dev:        '@sewdangcap',
    telegram:   'https://t.me/sewdangcap',
    endpoints:  ['/', '/sunlon', '/history', '/thangthua', '/id'],
    source_api: SOURCE_API,
    version:    '1.0.0'
  });
});

// ─────────────────────────────────────────────────────────────
//  404
// ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Endpoint không tồn tại', endpoints: ['/', '/sunlon', '/history', '/thangthua', '/id'] }));

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`\n🎲 API Tool Tài Xỉu Sunwin — DEV @sewdangcap\n   http://localhost:${PORT}\n   Polling source: ${SOURCE_API}\n`));
