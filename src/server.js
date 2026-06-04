'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  TÀI XỈU — VIRTUAL CHART ENGINE  v3.0
 *  DEV @sewdangcap
 *
 *  Giao diện nhà cái:
 *    CHART A — Đường Tổng  (Y: 3–18, X: 50 phiên)
 *    CHART B — 3 Đường Xúc Xắc (Y: 1–6, X: 50 phiên)
 *             màu: Đỏ / Vàng / Tím
 *
 *  Pipeline phân tích kỹ thuật (4 tín hiệu):
 *    1. Geometric Pattern  → W / M / H&S / Cầu Thang / Flag / Triple
 *    2. Linear Slope + Momentum + Mean-Reversion
 *    3. Support / Resistance Zone
 *    4. Dice Convergence (3 xúc xắc đồng pha)
 *    → Adaptive Ensemble vote có trọng số
 *
 *  Endpoints:
 *    GET /           → Dashboard HTML (giao diện nhà cái)
 *    GET /sunlon     → JSON dự đoán (format gốc)
 *    GET /canvas     → JSON snapshot 2 biểu đồ
 *    GET /signals    → JSON chi tiết 4 tín hiệu
 *    GET /thongke    → JSON winrate tracking
 *    GET /history    → JSON lịch sử phiên
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── ĐỔI URL NÀY NẾU CẦN ─────────────────────────────────────
const SOURCE_API = 'https://apilichsusunwinsew.onrender.com/api/taixiu/history?limit=50';

// ════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════
const CFG = {
  CANVAS_W:     50,    // số phiên hiển thị trên chart
  MIN_HIST:      8,    // min để bắt đầu dự đoán
  TAI_LINE:     11,    // tổng >= 11 → Tài
  MAX_HISTORY:  500,
  CONF_FLOOR:   52,
  CONF_CEIL:    91,
  POLL_MS:      6000,  // poll mỗi 6 giây

  // Trọng số ensemble
  W_PATTERN:   0.38,
  W_SLOPE:     0.24,
  W_SR:        0.20,
  W_DICE:      0.18,
};

// ════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════
let history      = [];   // { phien, dice:[d1,d2,d3], tong, kq:'T'|'X' }
let latestResult = null;
let pendingPred  = null;
let winLoss      = [];

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
const kqLabel   = t  => (t >= CFG.TAI_LINE ? 'T' : 'X');
const fullLabel = v  => (v === 'T' ? 'Tài' : v === 'X' ? 'Xỉu' : null);

function calibrateConf(raw) {
  return Math.round(Math.max(CFG.CONF_FLOOR,
    Math.min(CFG.CONF_CEIL,
      CFG.CONF_FLOOR + (raw - 0.5) * 2 * (CFG.CONF_CEIL - CFG.CONF_FLOOR)
    )));
}

function classifyDice(dice) {
  if (!dice || dice.length !== 3) return '?';
  const [a, b, c] = [...dice].sort((x, y) => x - y);
  if (a === b && b === c)             return `Ba ${a}`;
  if (a === b || b === c)             return `Đôi ${a === b ? a : b}`;
  if (c - a === 2 && b - a === 1)     return `Seri ${a}-${b}-${c}`;
  return `${a}-${b}-${c}`;
}

// ════════════════════════════════════════════════════════════════
//  A1 — LOCAL EXTREMA
// ════════════════════════════════════════════════════════════════
function findExtrema(arr, wing = 2) {
  const v = [];
  arr.forEach((val, i) => { if (val !== null) v.push({ i, v: val }); });
  if (v.length < wing * 2 + 1) return [];
  const r = [];
  for (let k = wing; k < v.length - wing; k++) {
    const cur = v[k].v;
    let isPeak = true, isTrough = true;
    for (let w = 1; w <= wing; w++) {
      if (v[k-w].v >= cur || v[k+w].v >= cur) isPeak   = false;
      if (v[k-w].v <= cur || v[k+w].v <= cur) isTrough = false;
    }
    if (isPeak)   r.push({ i: v[k].i, v: cur, type: 'peak'   });
    if (isTrough) r.push({ i: v[k].i, v: cur, type: 'trough' });
  }
  return r;
}

// ════════════════════════════════════════════════════════════════
//  A2 — PATTERN SCANNER
// ════════════════════════════════════════════════════════════════
function scanPattern(arr) {
  const ex  = findExtrema(arr, 2);
  if (ex.length < 3) return null;
  const n   = ex.length;
  const raw = arr.filter(v => v !== null);
  const cur = raw[raw.length - 1];
  const near = (a, b, t = 2) => Math.abs(a - b) <= t;

  // W bottom
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n-3], ex[n-2], ex[n-1]];
    if (e1.type === 'trough' && e2.type === 'peak' && e3.type === 'trough' &&
        near(e1.v, e3.v, 3) && e2.v > e1.v + 2) {
      const str = Math.min(1, 0.55 + (e2.v - e3.v) / 14);
      const confirmed = cur >= e2.v - 2;
      return { name: `Mẫu W — Đáy ~${Math.round((e1.v+e3.v)/2)}${confirmed?' ✓':''}`, bias: 'T',
               strength: confirmed ? Math.min(1, str + 0.12) : str * 0.85 };
    }
  }
  // M top
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n-3], ex[n-2], ex[n-1]];
    if (e1.type === 'peak' && e2.type === 'trough' && e3.type === 'peak' &&
        near(e1.v, e3.v, 3) && e2.v < e1.v - 2) {
      const str = Math.min(1, 0.55 + (e3.v - e2.v) / 14);
      const confirmed = cur <= e2.v + 2;
      return { name: `Mẫu M — Đỉnh ~${Math.round((e1.v+e3.v)/2)}${confirmed?' ✓':''}`, bias: 'X',
               strength: confirmed ? Math.min(1, str + 0.12) : str * 0.85 };
    }
  }
  // Head & Shoulders
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n - 5);
    if (ls.type==='peak' && lt.type==='trough' && hd.type==='peak' &&
        rt.type==='trough' && rs.type==='peak' &&
        hd.v > ls.v && hd.v > rs.v && near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3)) {
      return { name: `Vai-Đầu-Vai Đỉnh ${hd.v}`, bias: 'X',
               strength: Math.min(1, 0.62 + (hd.v - rs.v) / 14) };
    }
  }
  // Inverse H&S
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n - 5);
    if (ls.type==='trough' && lt.type==='peak' && hd.type==='trough' &&
        rt.type==='peak' && rs.type==='trough' &&
        hd.v < ls.v && hd.v < rs.v && near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3)) {
      return { name: `Vai-Đầu-Vai Đáy ${hd.v}`, bias: 'T',
               strength: Math.min(1, 0.62 + (rs.v - hd.v) / 14) };
    }
  }
  // Ascending / Descending Channel
  {
    const peaks   = ex.filter(e => e.type === 'peak').slice(-3);
    const troughs = ex.filter(e => e.type === 'trough').slice(-3);
    if (peaks.length === 3 && troughs.length === 3) {
      const pkUp = peaks[0].v   < peaks[1].v   && peaks[1].v   < peaks[2].v;
      const trUp = troughs[0].v < troughs[1].v && troughs[1].v < troughs[2].v;
      const pkDn = peaks[0].v   > peaks[1].v   && peaks[1].v   > peaks[2].v;
      const trDn = troughs[0].v > troughs[1].v && troughs[1].v > troughs[2].v;
      if (pkUp && trUp) return { name: `Cầu Thang Tăng — Đỉnh ${peaks[2].v}`,   bias: 'T', strength: 0.72 };
      if (pkDn && trDn) return { name: `Cầu Thang Giảm — Đỉnh ${peaks[2].v}`,   bias: 'X', strength: 0.72 };
    }
  }
  // Flag
  if (raw.length >= 6) {
    const impulse = raw[raw.length-4] - raw[Math.max(0, raw.length-7)];
    const consol  = Math.max(...raw.slice(-4)) - Math.min(...raw.slice(-4));
    if (Math.abs(impulse) >= 5 && consol <= 3) {
      const bias = impulse > 0 ? 'T' : 'X';
      return { name: `Flag ${bias==='T'?'Tăng':'Giảm'} Đà${impulse>0?'+':''}${impulse.toFixed(0)}`, bias, strength: 0.65 };
    }
  }
  // Triple Bottom / Top
  if (n >= 4) {
    const lt = ex.filter(e => e.type === 'trough').slice(-3);
    if (lt.length === 3 && near(lt[0].v,lt[1].v,2) && near(lt[1].v,lt[2].v,2))
      return { name: `Triple Đáy ~${Math.round((lt[0].v+lt[1].v+lt[2].v)/3)}`, bias: 'T', strength: 0.75 };
    const lp = ex.filter(e => e.type === 'peak').slice(-3);
    if (lp.length === 3 && near(lp[0].v,lp[1].v,2) && near(lp[1].v,lp[2].v,2))
      return { name: `Triple Đỉnh ~${Math.round((lp[0].v+lp[1].v+lp[2].v)/3)}`, bias: 'X', strength: 0.75 };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
//  A3 — SLOPE ANALYZER
// ════════════════════════════════════════════════════════════════
function analyzeSlope(arr, win = 8) {
  const pts = arr.filter(v => v !== null).slice(-win).map((v, i) => ({ v, i }));
  if (pts.length < 3) return null;
  const n = pts.length;
  let sX = 0, sY = 0, sXY = 0, sX2 = 0;
  pts.forEach(({ v }, i) => { sX += i; sY += v; sXY += i*v; sX2 += i*i; });
  const denom = n*sX2 - sX*sX;
  const slope = denom ? (n*sXY - sX*sY) / denom : 0;
  const last  = pts[n-1].v;
  const proj  = Math.round(Math.max(3, Math.min(18, last + slope)));
  const mr    = (proj >= 16 && slope > 0.5) || (proj <= 5 && slope < -0.5);
  const h     = Math.floor(n / 2);
  const mo    = pts.slice(h).reduce((s,p)=>s+p.v,0)/(n-h) - pts.slice(0,h).reduce((s,p)=>s+p.v,0)/h;
  let slopeBias = null, detail = '';
  if (mr)                     { slopeBias = proj>=16?'X':'T'; detail = `Hồi quy — proj ${proj}`; }
  else if (Math.abs(slope)>=.8){ slopeBias = slope>0?'T':'X'; detail = `Slope mạnh ${slope>0?'▲':'▼'} ${slope.toFixed(2)}/p`; }
  else if (Math.abs(slope)>=.3){ slopeBias = slope>0?'T':'X'; detail = `Slope ${slope>0?'▲':'▼'} ${slope.toFixed(2)}/p`; }
  else if (Math.abs(mo)>=1.2)  { slopeBias = mo>0?'T':'X';    detail = `Momentum ${mo>0?'▲':'▼'} ${mo.toFixed(1)}`; }
  else                          { detail = `Slope phẳng (${slope.toFixed(2)})`; }
  return { slope: +slope.toFixed(3), last, proj, momentum: +mo.toFixed(2), mr, slopeBias, detail,
           strength: mr ? 0.85 : Math.min(1, 0.45 + Math.abs(slope)/3 + Math.abs(mo)/10) };
}

// ════════════════════════════════════════════════════════════════
//  A4 — SUPPORT / RESISTANCE
// ════════════════════════════════════════════════════════════════
function detectSR(arr, minT = 2) {
  const v = arr.filter(x => x !== null);
  if (v.length < 8) return { zones: [], srBias: null, srDetail: 'Chưa đủ dữ liệu' };
  const ep = [];
  for (let i = 1; i < v.length-1; i++) {
    if (v[i] > v[i-1] && v[i] >= v[i+1]) ep.push({ v: v[i], r: 'res' });
    if (v[i] < v[i-1] && v[i] <= v[i+1]) ep.push({ v: v[i], r: 'sup' });
  }
  const bins = {};
  for (const e of ep) {
    const k = Math.round(e.v);
    if (!bins[k]) bins[k] = { level: k, res: 0, sup: 0 };
    bins[k][e.r]++;
  }
  const keys = Object.keys(bins).map(Number).sort((a,b)=>a-b);
  const zones = [], seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) continue;
    const b = { ...bins[k] };
    if (bins[k+1]) { b.res += bins[k+1].res; b.sup += bins[k+1].sup; b.level = +((k+k+1)/2).toFixed(1); seen.add(k+1); }
    b.touches = b.res + b.sup;
    b.type    = b.res >= b.sup ? 'resistance' : 'support';
    if (b.touches >= minT) zones.push(b);
  }
  zones.sort((a,b) => b.touches - a.touches);
  const cur = v[v.length-1];
  let srBias = null, srDetail = 'Không có S/R nổi bật';
  for (const z of zones.slice(0, 3)) {
    const diff = cur - z.level;
    if (z.type === 'resistance') {
      if (Math.abs(diff) <= 1.5) { srBias='X'; srDetail=`Kháng cự ${z.level} (${z.touches}x)`; break; }
      if (diff > 0)               { srBias='T'; srDetail=`Vượt kháng cự ${z.level}`;             break; }
    } else {
      if (Math.abs(diff) <= 1.5) { srBias='T'; srDetail=`Hỗ trợ ${z.level} (${z.touches}x)`;    break; }
      if (diff < 0)               { srBias='X'; srDetail=`Thủng hỗ trợ ${z.level}`;              break; }
    }
  }
  return { zones: zones.slice(0, 4), srBias, srDetail };
}

// ════════════════════════════════════════════════════════════════
//  B — DICE CONVERGENCE
// ════════════════════════════════════════════════════════════════
function analyzeDice(hist, win = 8) {
  const slopes = [0, 1, 2].map(di => {
    const vals = hist.map(h => Array.isArray(h.dice) ? h.dice[di] : null)
                     .filter(v => v !== null).slice(-win);
    if (vals.length < 3) return null;
    const n = vals.length;
    let sX=0, sY=0, sXY=0, sX2=0;
    vals.forEach((v,i) => { sX+=i; sY+=v; sXY+=i*v; sX2+=i*i; });
    const d = n*sX2 - sX*sX;
    return d ? (n*sXY - sX*sY) / d : 0;
  });
  const valid = slopes.filter(s => s !== null);
  if (valid.length < 2) return { diceBias: null, diceDetail: 'Thiếu dữ liệu xúc xắc', convScore: 0 };
  const up   = valid.filter(s => s >  0.12).length;
  const down = valid.filter(s => s < -0.12).length;
  const avg  = valid.reduce((a,s) => a+s, 0) / valid.length;
  const last = hist.filter(h => h.dice).slice(-1)[0];
  const proj = last ? +(last.dice.reduce((a,b)=>a+b,0) + avg*3).toFixed(1) : null;
  let diceBias = null, diceDetail = '', convScore = 0;
  if (up >= 2 || down >= 2) {
    convScore = Math.max(up, down);
    diceBias  = up >= down ? 'T' : 'X';
    diceDetail = `${convScore}/3 xúc xắc ${up>=down?'▲ tăng':'▼ giảm'}${proj?' | proj≈'+proj:''}`;
  } else {
    diceDetail = `Phân kỳ (↑${up} ↓${down})${proj?' | proj≈'+proj:''}`;
  }
  return { diceBias, diceDetail, convScore, avgSlope: +avg.toFixed(3), proj };
}

// ════════════════════════════════════════════════════════════════
//  META ENSEMBLE
// ════════════════════════════════════════════════════════════════
function ensembleVote(signals) {
  const { pattern, slope, sr, dice } = signals;
  let sT = 0, sX = 0, tW = 0;
  const sources = [];
  const cast = (bias, w, name, detail, str = 1) => {
    if (!bias) return;
    const eff = w * Math.min(1.3, Math.max(0.3, str));
    if (bias === 'T') sT += eff; else sX += eff;
    tW += eff;
    sources.push({ name, bias, biasFull: fullLabel(bias), detail, weight: +eff.toFixed(3) });
  };
  if (pattern?.bias) cast(pattern.bias, CFG.W_PATTERN, 'Mẫu hình',       pattern.name,       pattern.strength ?? 0.7);
  if (slope?.slopeBias) cast(slope.slopeBias, CFG.W_SLOPE, 'Slope/Momentum', slope.detail,    slope.strength   ?? 0.6);
  if (sr?.srBias)    cast(sr.srBias,       CFG.W_SR,      'Hỗ trợ/Kháng cự', sr.srDetail,   0.8);
  if (dice?.diceBias)cast(dice.diceBias,   CFG.W_DICE,    'Đồng pha Xúc xắc', dice.diceDetail, dice.convScore/3);
  if (!tW) return null;
  const rT = sT/tW, rX = sX/tW;
  const winner = rT >= rX ? 'T' : 'X';
  const rawConf = Math.max(rT, rX);
  const conf    = calibrateConf(rawConf);
  const clarity = rawConf>=.74?'Rõ ràng':rawConf>=.63?'Khá rõ':rawConf>=.56?'Trung bình':'Không rõ';
  return { winner, winnerFull: fullLabel(winner), conf, rawConf: +rawConf.toFixed(4),
           clarity, votes: { T: +sT.toFixed(3), X: +sX.toFixed(3) },
           votePct: { T: `${(rT*100).toFixed(1)}%`, X: `${(rX*100).toFixed(1)}%` },
           sources, patternName: pattern?.name ?? null };
}

// ════════════════════════════════════════════════════════════════
//  MAIN PREDICT
// ════════════════════════════════════════════════════════════════
function predictByVirtualChart(hist) {
  if (!hist || hist.length < CFG.MIN_HIST) return null;
  const slice   = hist.slice(-CFG.CANVAS_W);
  const canvasA = slice.map(h => typeof h.tong === 'number' ? h.tong : null);
  const pattern = scanPattern(canvasA);
  const slope   = analyzeSlope(canvasA, 8);
  const sr      = detectSR(canvasA, 2);
  const dice    = analyzeDice(slice, 8);
  const ens     = ensembleVote({ pattern, slope, sr, dice });
  if (!ens) return null;
  return { ...ens, patternName: ens.patternName ?? 'Không nhận diện mẫu hình', canvasA, slice };
}

// ════════════════════════════════════════════════════════════════
//  FETCH & POLLING
// ════════════════════════════════════════════════════════════════
async function fetchAndUpdate() {
  try {
    const res  = await fetch(SOURCE_API, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const items = Array.isArray(data.data) ? data.data
                : Array.isArray(data)      ? data : [];
    if (!items.length) return null;

    const sorted   = [...items].sort((a, b) => a.session - b.session);
    const latest   = sorted[sorted.length - 1];
    const knownSet = new Set(history.map(h => h.phien));

    for (const item of sorted) {
      const phien = String(item.session);
      if (knownSet.has(phien)) continue;
      const dice = Array.isArray(item.dice) && item.dice.length === 3
        ? item.dice.map(Number) : null;
      const tong = typeof item.total === 'number'
        ? item.total : (dice ? dice.reduce((a,b)=>a+b,0) : 0);
      const kq = item.result === 'Tài' ? 'T'
               : item.result === 'Xỉu' ? 'X'
               : kqLabel(tong);
      history.push({ phien, dice, tong, kq });
      knownSet.add(phien);
      // Đánh giá pending
      if (pendingPred?.phien === phien) {
        const win = pendingPred.predicted === kq;
        winLoss.push({ phien, predicted: pendingPred.predicted, actual: kq, win, conf: pendingPred.conf });
        if (winLoss.length > 200) winLoss = winLoss.slice(-100);
        pendingPred = null;
      }
    }
    if (history.length > CFG.MAX_HISTORY) history = history.slice(-CFG.MAX_HISTORY);

    const pred    = predictByVirtualChart(history);
    const phienN  = String(Number(latest.session) + 1);
    if (pred) pendingPred = { phien: phienN, predicted: pred.winner, conf: pred.conf };

    const recentWL = winLoss.slice(-50);
    const wins     = recentWL.filter(r => r.win).length;
    const winRate  = recentWL.length ? `${Math.round(wins/recentWL.length*100)}%` : 'Chưa có';
    const pattern30 = history.slice(-50).map(h => h.kq).join('');
    const latestTong = typeof latest.total === 'number' ? latest.total
      : (Array.isArray(latest.dice) ? latest.dice.reduce((a,b)=>a+b,0) : 0);
    const latestKq = kqLabel(latestTong);

    latestResult = {
      id:            '@sewdangcap',
      phien:         latest.session,
      ket_qua:       fullLabel(latestKq),
      tong:          latestTong,
      xuc_xac:       Array.isArray(latest.dice) ? latest.dice.map(Number) : null,
      phan_loai:     Array.isArray(latest.dice) ? classifyDice(latest.dice.map(Number)) : null,
      phien_du_doan: Number(phienN),
      du_doan: pred ? {
        ket_qua:     fullLabel(pred.winner),
        luot_danh:   pred.winner === 'T' ? 'TÀI' : 'XỈU',
        do_tin_cay:  `${pred.conf}%`,
        muc_do:      pred.clarity,
        ty_le:       pred.votePct,
        cau_noi_bat: pred.patternName,
        so_algo:     `${pred.sources.length}/4 tín hiệu`,
      } : null,
      win_rate: winRate,
      pattern:  pattern30,
    };
    return latestResult;
  } catch (e) {
    console.error('[fetchAndUpdate]', e.message);
    return null;
  }
}

// Khởi động + polling
(async () => { await fetchAndUpdate(); })();
setInterval(fetchAndUpdate, CFG.POLL_MS);

// ════════════════════════════════════════════════════════════════
//  EXPRESS
// ════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());

// ── / — Dashboard HTML (giao diện nhà cái) ───────────────────
app.get('/', (req, res) => {
  const hist   = history.slice(-CFG.CANVAS_W);
  const pred   = predictByVirtualChart(history);
  const latest = history[history.length - 1];

  if (!latest) return res.send(`<!DOCTYPE html><html><body style="background:#0d051a;color:#e8d8ff;font-family:sans-serif;padding:2rem;text-align:center">
    <h2 style="color:#f5c842">Đang khởi động...</h2><p>Kết nối API nguồn...</p></body></html>`);

  const nxtPhien = String(Number(latest.phien) + 1);

  // Build data JSON để nhúng vào HTML
  const chartAData = JSON.stringify(hist.map(h => h.tong));
  const chartBD1   = JSON.stringify(hist.map(h => h.dice ? h.dice[0] : null));
  const chartBD2   = JSON.stringify(hist.map(h => h.dice ? h.dice[1] : null));
  const chartBD3   = JSON.stringify(hist.map(h => h.dice ? h.dice[2] : null));
  const chartLabels= JSON.stringify(hist.map(h => '#' + String(h.phien).slice(-4)));
  const histJson   = JSON.stringify(history.slice(-15).reverse());
  const pattern50  = history.slice(-50).map(h => h.kq).join('');
  const taiCount   = history.slice(-50).filter(h => h.kq === 'T').length;
  const xiuCount   = history.slice(-50).length - taiCount;
  const recentWL   = winLoss.slice(-50);
  const wr         = recentWL.length ? Math.round(recentWL.filter(r=>r.win).length/recentWL.length*100)+'%' : 'Chưa có';

  const predJson   = pred ? JSON.stringify({
    winner: pred.winner, winnerFull: fullLabel(pred.winner),
    conf: pred.conf, clarity: pred.clarity,
    pctT: pred.votePct.T, pctX: pred.votePct.X,
    patternName: pred.patternName ?? 'Không nhận diện mẫu hình',
    sources: pred.sources,
  }) : 'null';

  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tài Xỉu — Virtual Chart Engine v3.0</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#1a0a2e;--bg2:#120720;--bg3:#0d051a;
  --purple:#b366ff;--gold:#f5c842;--red:#ff4466;
  --tai:#00e676;--xiu:#ff6b35;
  --text:#e8d8ff;--text2:#9b7fc4;
  --border:rgba(180,120,255,.18);
}
body{background:var(--bg3);color:var(--text);font-family:'Segoe UI',sans-serif;min-height:100vh}
.wrap{max-width:800px;margin:0 auto;padding:14px}

.hdr{text-align:center;margin-bottom:12px;padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:12px}
.hdr h1{font-size:16px;font-weight:700;color:var(--gold);letter-spacing:.05em}
.hdr-info{font-size:12px;color:var(--text2);margin-top:4px;display:flex;justify-content:center;gap:16px;flex-wrap:wrap}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--tai);display:inline-block;animation:pulse 1.4s infinite;margin-right:4px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

.chart-box{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px}
.chart-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.chart-hdr span{font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
.chart-hdr .kq{font-size:13px;font-weight:700}
.chart-hdr .kq.tai{color:var(--tai)}
.chart-hdr .kq.xiu{color:var(--xiu)}
.legend{display:flex;gap:12px;font-size:10px;color:var(--text2);margin-top:6px}
.leg-dot{width:10px;height:4px;border-radius:2px;display:inline-block;margin-right:4px;vertical-align:middle}

.pred-box{background:linear-gradient(135deg,rgba(100,40,200,.3),rgba(30,10,60,.5));border:1px solid rgba(180,100,255,.3);border-radius:12px;padding:14px;margin-bottom:10px}
.pred-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.pred-left{}
.pred-label{font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px}
.pred-val{font-size:40px;font-weight:800;line-height:1}
.pred-val.tai{color:var(--tai);text-shadow:0 0 20px rgba(0,230,118,.4)}
.pred-val.xiu{color:var(--xiu);text-shadow:0 0 20px rgba(255,107,53,.4)}
.pred-pct{font-size:12px;margin-top:5px;color:var(--text2)}
.pred-pattern{font-size:10px;color:rgba(200,150,255,.6);margin-top:3px}
.conf-wrap{display:flex;flex-direction:column;align-items:center;flex-shrink:0}
.conf-ring{position:relative;width:80px;height:80px}
.conf-ring canvas{position:absolute;top:0;left:0}
.conf-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.conf-pct{font-size:18px;font-weight:700}
.conf-lbl{font-size:9px;color:var(--text2);margin-top:1px}

.sigs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.sig{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;padding:8px 10px}
.sig-name{font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em}
.sig-val{font-size:12px;font-weight:600;margin-top:2px}
.sig-val.tai{color:var(--tai)}
.sig-val.xiu{color:var(--xiu)}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.mini-box{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px}
.mini-box h3{font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}

.hist-row{display:grid;grid-template-columns:48px 56px 1fr 34px;gap:4px;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px}
.hist-row:last-child{border-bottom:none}
.kq-pill{display:inline-block;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:700;text-align:center}
.kq-pill.tai{background:rgba(0,230,118,.15);color:var(--tai);border:1px solid rgba(0,230,118,.25)}
.kq-pill.xiu{background:rgba(255,107,53,.15);color:var(--xiu);border:1px solid rgba(255,107,53,.25)}
.dice-set{display:flex;gap:2px}
.d{width:16px;height:16px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff}
.d.r{background:#c0392b}.d.y{background:#c59a00}.d.p{background:#7b2fbf}

.pat-wrap{display:flex;gap:2px;flex-wrap:wrap}
.pb{width:17px;height:17px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700}
.pb.t{background:rgba(0,230,118,.2);color:var(--tai)}
.pb.x{background:rgba(255,107,53,.2);color:var(--xiu)}

.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
.mc{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px}
.mc-l{font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.mc-v{font-size:20px;font-weight:600}
.mc-s{font-size:10px;color:var(--text2);margin-top:2px}

.refresh-btn{width:100%;padding:10px;background:rgba(140,60,255,.15);border:1px solid rgba(180,100,255,.25);border-radius:8px;color:var(--text);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .2s}
.refresh-btn:hover{background:rgba(140,60,255,.3)}
</style>
</head>
<body>
<div class="wrap">

<div class="hdr">
  <h1>📈 Virtual Chart Engine v3.0 — @sewdangcap</h1>
  <div class="hdr-info">
    <span><span class="live-dot"></span>LIVE</span>
    <span>Phiên mới nhất: <b>#${latest.phien}</b></span>
    <span>Kết quả: <b style="color:${latest.kq==='T'?'#00e676':'#ff6b35'}">${fullLabel(latest.kq)} (${latest.tong})</b></span>
    <span>Win rate: <b style="color:#f5c842">${wr}</b></span>
  </div>
</div>

<div class="metrics">
  <div class="mc"><div class="mc-l">Phiên hiện tại</div><div class="mc-v">#${String(latest.phien).slice(-5)}</div><div class="mc-s">${fullLabel(latest.kq)} · ${latest.tong}</div></div>
  <div class="mc"><div class="mc-l">Dự đoán phiên</div><div class="mc-v" style="color:${pred?(pred.winner==='T'?'#00e676':'#ff6b35'):'var(--text2)'}">${pred?fullLabel(pred.winner):'...'}</div><div class="mc-s">#${nxtPhien.slice(-5)}</div></div>
  <div class="mc"><div class="mc-l">Tài / Xỉu (50p)</div><div class="mc-v">${taiCount}/${xiuCount}</div><div class="mc-s">${((taiCount/Math.max(1,taiCount+xiuCount))*100).toFixed(0)}% Tài</div></div>
  <div class="mc"><div class="mc-l">Tổng phiên lưu</div><div class="mc-v">${history.length}</div><div class="mc-s">cập nhật liên tục</div></div>
</div>

<!-- CHART A -->
<div class="chart-box">
  <div class="chart-hdr">
    <span>Chart A — Đường Tổng (3–18)</span>
    <span class="kq ${latest.kq==='T'?'tai':'xiu'}">${latest.kq==='T'?'TÀI':'XỈU'} ${latest.tong}</span>
  </div>
  <div style="position:relative;height:200px">
    <canvas id="cvA"></canvas>
  </div>
  <div class="legend">
    <span><span class="leg-dot" style="background:#00e676"></span>Tài ≥11</span>
    <span><span class="leg-dot" style="background:#ff6b35"></span>Xỉu &lt;11</span>
    <span style="color:rgba(200,150,255,.4)">● trắng = đường tổng</span>
  </div>
</div>

<!-- CHART B -->
<div class="chart-box">
  <div class="chart-hdr">
    <span>Chart B — 3 Xúc Xắc (1–6)</span>
    <span style="display:flex;gap:10px;align-items:center">
      <span style="color:#ff4466;font-size:10px">● Đỏ D1</span>
      <span style="color:#f5c842;font-size:10px">● Vàng D2</span>
      <span style="color:#b366ff;font-size:10px">● Tím D3</span>
    </span>
  </div>
  <div style="position:relative;height:180px">
    <canvas id="cvB"></canvas>
  </div>
</div>

<!-- PREDICTION -->
${pred ? `
<div class="pred-box">
  <div class="pred-row">
    <div class="pred-left">
      <div class="pred-label">Dự đoán phiên #${nxtPhien.slice(-5)}</div>
      <div class="pred-val ${pred.winner==='T'?'tai':'xiu'}">${fullLabel(pred.winner)}</div>
      <div class="pred-pct">Tài ${pred.votePct.T} · Xỉu ${pred.votePct.X}</div>
      <div class="pred-pattern">${pred.patternName ?? 'Không nhận diện mẫu hình'}</div>
    </div>
    <div class="conf-wrap">
      <div class="conf-ring">
        <canvas id="cvConf" width="80" height="80"></canvas>
        <div class="conf-center">
          <span class="conf-pct" style="color:${pred.winner==='T'?'#00e676':'#ff6b35'}">${pred.conf}%</span>
          <span class="conf-lbl">${pred.clarity}</span>
        </div>
      </div>
    </div>
  </div>
  <div class="sigs">
    ${pred.sources.map(s=>`<div class="sig"><div class="sig-name">${s.name}</div><div class="sig-val ${s.bias==='T'?'tai':'xiu'}">${fullLabel(s.bias)} — ${s.detail.slice(0,30)}</div></div>`).join('')}
  </div>
</div>` : `<div class="pred-box" style="text-align:center;padding:1.5rem;color:var(--text2)">Đang phân tích...</div>`}

<div class="grid2">
  <div class="mini-box">
    <h3>Lịch sử 15 phiên gần nhất</h3>
    ${history.slice(-15).reverse().map(h=>`
    <div class="hist-row">
      <span style="color:var(--text2)">#${String(h.phien).slice(-5)}</span>
      <span class="kq-pill ${h.kq==='T'?'tai':'xiu'}">${fullLabel(h.kq)}</span>
      <span class="dice-set">${h.dice?['r','y','p'].map((c,i)=>`<span class="d ${c}">${h.dice[i]}</span>`).join(''):'–'}</span>
      <span style="font-weight:600;text-align:right">${h.tong}</span>
    </div>`).join('')}
  </div>
  <div class="mini-box">
    <h3>Chuỗi cầu 50 phiên</h3>
    <div style="font-size:10px;color:var(--text2);margin-bottom:6px;display:flex;gap:10px">
      <span style="color:#00e676">T: ${taiCount}</span>
      <span style="color:#ff6b35">X: ${xiuCount}</span>
    </div>
    <div class="pat-wrap">${pattern50.split('').map(c=>`<span class="pb ${c.toLowerCase()}">${c}</span>`).join('')}</div>
    <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:9px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Trọng số algo</div>
      ${[['Mẫu hình',38],['Slope',24],['S/R',20],['Xúc xắc',18]].map(([n,w])=>`
      <div style="display:flex;justify-content:space-between;font-size:10px;padding:2px 0;color:var(--text2)">
        <span>${n}</span><span style="font-weight:600;color:var(--text)">${w}%</span>
      </div>`).join('')}
    </div>
  </div>
</div>

<button class="refresh-btn" onclick="location.reload()">
  ↻ Làm mới trang &nbsp;|&nbsp; Tự cập nhật mỗi ${CFG.POLL_MS/1000}s
</button>

<div style="text-align:center;font-size:10px;color:rgba(200,150,255,.3);margin-top:10px;padding-bottom:10px">
  Virtual Chart Engine v3.0 · DEV @sewdangcap · 
  <a href="/sunlon" style="color:rgba(180,100,255,.5)">API JSON</a> ·
  <a href="/signals" style="color:rgba(180,100,255,.5)">Signals</a> ·
  <a href="/thongke" style="color:rgba(180,100,255,.5)">Thống kê</a>
</div>
</div><!-- /wrap -->

<script>
const DATA_A   = ${chartAData};
const DATA_B1  = ${chartBD1};
const DATA_B2  = ${chartBD2};
const DATA_B3  = ${chartBD3};
const LABELS   = ${chartLabels};
const PRED     = ${predJson};
const HIST     = ${histJson};

const ptColors = DATA_A.map(v => v === null ? 'rgba(255,255,255,.3)' : (v >= 11 ? '#00e676' : '#ff6b35'));
const ptSizes  = DATA_A.map((_, i) => i === DATA_A.length-1 ? 7 : 4);

new Chart(document.getElementById('cvA'), {
  type: 'line',
  data: { labels: LABELS, datasets: [{
    data: DATA_A, borderColor: 'rgba(255,255,255,.65)',
    backgroundColor: 'rgba(255,255,255,.03)',
    borderWidth: 2, pointBackgroundColor: ptColors,
    pointBorderColor: ptColors, pointRadius: ptSizes,
    pointHoverRadius: 8, tension: 0.35, fill: true,
  }]},
  options: { responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>'Tổng: '+c.parsed.y+' — '+(c.parsed.y>=11?'Tài':'Xỉu')}}},
    scales:{
      x:{ticks:{font:{size:8},color:'rgba(200,150,255,.45)',maxTicksLimit:14,maxRotation:0},grid:{color:'rgba(180,100,255,.07)'},border:{color:'rgba(180,100,255,.15)'}},
      y:{min:2,max:19,ticks:{font:{size:9},color:'rgba(200,150,255,.45)',stepSize:3},grid:{color:'rgba(180,100,255,.07)'},border:{color:'rgba(180,100,255,.15)'}},
    }
  }
});

new Chart(document.getElementById('cvB'), {
  type: 'line',
  data: { labels: LABELS, datasets: [
    {label:'D1',data:DATA_B1,borderColor:'#ff4466',backgroundColor:'transparent',borderWidth:2,pointBackgroundColor:'#ff4466',pointRadius:3,tension:.3},
    {label:'D2',data:DATA_B2,borderColor:'#f5c842',backgroundColor:'transparent',borderWidth:2,pointBackgroundColor:'#f5c842',pointRadius:3,tension:.3},
    {label:'D3',data:DATA_B3,borderColor:'#b366ff',backgroundColor:'transparent',borderWidth:2,pointBackgroundColor:'#b366ff',pointRadius:3,tension:.3},
  ]},
  options:{ responsive:true, maintainAspectRatio:false,
    plugins:{legend:{display:false}},
    scales:{
      x:{ticks:{font:{size:8},color:'rgba(200,150,255,.45)',maxTicksLimit:14,maxRotation:0},grid:{color:'rgba(180,100,255,.07)'},border:{color:'rgba(180,100,255,.15)'}},
      y:{min:0,max:7,ticks:{font:{size:9},color:'rgba(200,150,255,.45)',stepSize:1},grid:{color:'rgba(180,100,255,.07)'},border:{color:'rgba(180,100,255,.15)'}},
    }
  }
});

if (PRED) {
  const cv  = document.getElementById('cvConf');
  const ctx = cv.getContext('2d');
  const col = PRED.winner === 'T' ? '#00e676' : '#ff6b35';
  const pct = PRED.conf / 100;
  ctx.beginPath(); ctx.arc(40,40,30,0,Math.PI*2);
  ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=6; ctx.stroke();
  ctx.beginPath(); ctx.arc(40,40,30,-Math.PI/2,-Math.PI/2+Math.PI*2*pct);
  ctx.strokeStyle=col; ctx.lineWidth=6; ctx.lineCap='round'; ctx.stroke();
}

// Auto reload
setTimeout(() => location.reload(), ${CFG.POLL_MS});
</script>
</body>
</html>`);
});

// ── /sunlon — JSON gốc ───────────────────────────────────────
app.get('/sunlon', async (req, res) => {
  if (!latestResult) {
    const d = await fetchAndUpdate();
    if (!d) return res.status(503).json({ error: 'Đang khởi động, thử lại sau...' });
  }
  res.json(latestResult);
});

// ── /canvas — Snapshot 2 biểu đồ ────────────────────────────
app.get('/canvas', (req, res) => {
  if (history.length < CFG.MIN_HIST)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const slice  = history.slice(-CFG.CANVAS_W);
  const phiens = slice.map(h => Number(h.phien));
  res.json({
    id: '@sewdangcap',
    canvas_width: slice.length,
    chart_A: {
      mo_ta: 'Đường Tổng — trục Y: 3–18', y_min: 3, y_max: 18,
      data: phiens.map((p, i) => ({ phien: p, tong: slice[i].tong })),
    },
    chart_B: {
      mo_ta: '3 Đường Xúc Xắc — Đỏ/Vàng/Tím — trục Y: 1–6', y_min: 1, y_max: 6,
      data: phiens.map((p, i) => ({
        phien: p, d1: slice[i].dice?.[0]??null,
        d2: slice[i].dice?.[1]??null, d3: slice[i].dice?.[2]??null,
      })),
    },
  });
});

// ── /signals — Chi tiết 4 tín hiệu ──────────────────────────
app.get('/signals', (req, res) => {
  if (history.length < CFG.MIN_HIST)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const slice   = history.slice(-CFG.CANVAS_W);
  const canvasA = slice.map(h => h.tong);
  const pattern = scanPattern(canvasA);
  const slope   = analyzeSlope(canvasA, 8);
  const sr      = detectSR(canvasA, 2);
  const dice    = analyzeDice(slice, 8);
  const ens     = ensembleVote({ pattern, slope, sr, dice });
  res.json({
    id: '@sewdangcap',
    ket_luan: ens ? { du_doan: fullLabel(ens.winner), do_tin_cay: `${ens.conf}%`, muc_do: ens.clarity } : null,
    tin_hieu: {
      chart_A_pattern: pattern
        ? { ten: pattern.name, bias: fullLabel(pattern.bias), suc_manh: +pattern.strength.toFixed(2) }
        : { ten: 'Không nhận diện', bias: null },
      chart_A_slope: slope
        ? { slope: slope.slope, lastVal: slope.last, projNext: slope.proj, bias: fullLabel(slope.slopeBias), chi_tiet: slope.detail }
        : { chi_tiet: 'Không đủ dữ liệu' },
      chart_A_sr: { bias: fullLabel(sr.srBias), chi_tiet: sr.srDetail, zones: sr.zones },
      chart_B_dice: { bias: fullLabel(dice.diceBias), chi_tiet: dice.diceDetail, conv: `${dice.convScore}/3` },
    },
    nguon_bieu_quyet: ens?.sources ?? [],
    trong_so: { 'Pattern': CFG.W_PATTERN, 'Slope': CFG.W_SLOPE, 'SR': CFG.W_SR, 'Dice': CFG.W_DICE },
  });
});

// ── /thongke ─────────────────────────────────────────────────
app.get('/thongke', (req, res) => {
  const slice = winLoss.slice(-50).reverse();
  const wins  = slice.filter(r => r.win).length;
  const rate  = slice.length ? Math.round(wins/slice.length*100) : 0;
  let streak = 0, st = null;
  for (const r of slice) { if (st===null){st=r.win;streak=1;} else if(r.win===st)streak++; else break; }
  res.json({
    id: '@sewdangcap',
    tong_quan: { tong_phien: slice.length, thang: wins, thua: slice.length-wins, win_rate: `${rate}%`,
      streak: streak>0?`${streak} ${st?'THẮNG':'THUA'} liên tiếp`:'Chưa có' },
    chi_tiet: slice.map((r,i) => ({
      stt: i+1, phien: Number(r.phien), du_doan: fullLabel(r.predicted),
      ket_qua_thuc: fullLabel(r.actual), do_tin_cay: `${r.conf}%`,
      ket_luan: r.win?'✅ THẮNG':'❌ THUA',
    })),
  });
});

// ── /history ─────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit)||50, 500);
  res.json({
    id: '@sewdangcap',
    tong: history.length,
    data: history.slice(-limit).reverse().map(h => ({
      phien: Number(h.phien), xuc_xac: h.dice,
      phan_loai: h.dice ? classifyDice(h.dice) : '-',
      tong: h.tong, ket_qua: fullLabel(h.kq),
    })),
  });
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({
  error: 'Endpoint không tồn tại',
  endpoints: ['/', '/sunlon', '/canvas', '/signals', '/thongke', '/history'],
}));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`
╔════════════════════════════════════════════╗
║  Virtual Chart Engine v3.0 — @sewdangcap  ║
║  http://localhost:${PORT}                      ║
╠════════════════════════════════════════════╣
║  Canvas  : ${CFG.CANVAS_W} phiên / Min hist: ${CFG.MIN_HIST} phiên     ║
║  Poll    : mỗi ${CFG.POLL_MS/1000}s                          ║
║  Weights : Pat ${CFG.W_PATTERN} · Slp ${CFG.W_SLOPE} · SR ${CFG.W_SR} · Dice ${CFG.W_DICE} ║
╠════════════════════════════════════════════╣
║  /          → Dashboard HTML               ║
║  /sunlon    → JSON dự đoán                 ║
║  /canvas    → JSON biểu đồ                 ║
║  /signals   → JSON 4 tín hiệu              ║
║  /thongke   → JSON winrate                 ║
║  /history   → JSON lịch sử                 ║
╚════════════════════════════════════════════╝
`));
