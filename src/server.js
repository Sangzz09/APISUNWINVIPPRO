'use strict';

/**
 * ══════════════════════════════════════════════════════════════
 *  TÀI XỈU — VIRTUAL CHART ENGINE  v2.0
 *  DEV @sewdangcap
 *
 *  Mô phỏng đúng biểu đồ nhà cái (2 chart):
 *    CHART A — Đường Tổng  (Y: 3–18, X: 40 phiên)   [TRỌNG SỐ CAO]
 *    CHART B — 3 Đường Xúc Xắc (Y: 1–6, X: 40 phiên)
 *
 *  Pipeline phân tích kỹ thuật:
 *    A1. Local Extrema Detection   → tìm đỉnh/đáy cục bộ
 *    A2. Geometric Pattern Scan    → W / M / H&S / Cầu Thang / Channel
 *    A3. Linear Slope + Momentum   → độ dốc + dự chiếu phiên kế
 *    A4. Mean-Reversion Gate       → bẻ chiều nếu tổng cực đoan
 *    A5. Support / Resistance Zone → ngưỡng bị bật nhiều lần
 *    B1. Per-Dice Slope            → slope từng xúc xắc
 *    B2. Dice Convergence          → 2/3 hoặc 3/3 đồng pha
 *    META. Adaptive Ensemble       → vote có trọng số + calibrate conf
 *
 *  /sunlon endpoint giữ nguyên format JSON gốc.
 * ══════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = 'https://apilichsusunwinsew.onrender.com/api/taixiu/history';

// ══════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════
const CFG = {
  CANVAS_W:       40,    // số phiên trục X
  MIN_HIST:        8,    // tối thiểu để bắt đầu dự đoán
  TAI_LINE:       11,    // tổng >= 11 → Tài
  MAX_HISTORY:   300,
  CONF_FLOOR:     52,
  CONF_CEIL:      91,

  // Trọng số ensemble (tổng = 1.0)
  W_PATTERN:    0.38,   // Chart A — mẫu hình hình học (ưu tiên cao nhất)
  W_SLOPE:      0.24,   // Chart A — độ dốc / momentum
  W_SR:         0.20,   // Chart A — ngưỡng hỗ trợ / kháng cự
  W_DICE:       0.18,   // Chart B — đồng pha 3 xúc xắc
};

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
let history      = [];   // [{ phien, dice:[d1,d2,d3], tong, kq:'T'|'X' }]
let latestResult = null;
let pendingPred  = null; // { phien, predicted, conf, ... } để đánh giá sau

// win/loss log để tính winrate cho /sunlon
let winLoss = []; // [{ phien, predicted, actual, win, conf }]

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
const isTai     = t => t >= CFG.TAI_LINE;
const kqLabel   = t => (t >= CFG.TAI_LINE ? 'T' : 'X');
const fullLabel = v => (v === 'T' ? 'Tài' : v === 'X' ? 'Xỉu' : null);
const flip      = v => (v === 'T' ? 'X' : 'T');

/** Calibrate confidence từ raw [0.5,1] → [FLOOR,CEIL] */
function calibrateConf(raw) {
  return Math.round(Math.max(CFG.CONF_FLOOR,
    Math.min(CFG.CONF_CEIL,
      CFG.CONF_FLOOR + (raw - 0.5) * 2 * (CFG.CONF_CEIL - CFG.CONF_FLOOR)
    )));
}

// ══════════════════════════════════════════════════════════════
//  BUILD CANVAS — "vẽ" 2 biểu đồ vào bộ nhớ
// ══════════════════════════════════════════════════════════════

/**
 * Từ history (oldest→newest), cắt CANVAS_W phiên cuối.
 *
 * canvasA[i] : number|null   — tổng 3 xúc xắc (3–18)
 * canvasB[i] : [d1,d2,d3]|null — giá trị từng xúc xắc (1–6)
 *
 * Trục X: i=0 → phiên cũ nhất trong cửa sổ
 *         i=N-1 → phiên mới nhất (hiện tại)
 */
function buildCanvas(hist) {
  const slice  = hist.slice(-CFG.CANVAS_W);
  const canvasA = slice.map(h => (typeof h.tong === 'number' ? h.tong : null));
  const canvasB = slice.map(h =>
    Array.isArray(h.dice) && h.dice.length === 3 ? [...h.dice] : null
  );
  return { canvasA, canvasB, len: slice.length };
}

// ══════════════════════════════════════════════════════════════
//  A1 — LOCAL EXTREMA DETECTION
//  Tìm đỉnh (peak) và đáy (trough) cục bộ trên canvasA.
//  Dùng window=2 mỗi bên để lọc nhiễu nhỏ.
// ══════════════════════════════════════════════════════════════

/**
 * @returns {Array<{i,v,type:'peak'|'trough'}>}
 */
function findExtrema(canvasA, wing = 2) {
  const valid = [];
  canvasA.forEach((v, i) => { if (v !== null) valid.push({ i, v }); });
  if (valid.length < wing * 2 + 1) return [];

  const result = [];
  for (let k = wing; k < valid.length - wing; k++) {
    const cur = valid[k].v;
    let isPeak = true, isTrough = true;
    for (let w = 1; w <= wing; w++) {
      if (valid[k - w].v >= cur) isPeak   = false;
      if (valid[k + w].v >= cur) isPeak   = false;
      if (valid[k - w].v <= cur) isTrough = false;
      if (valid[k + w].v <= cur) isTrough = false;
    }
    if (isPeak)   result.push({ i: valid[k].i, v: cur, type: 'peak'   });
    if (isTrough) result.push({ i: valid[k].i, v: cur, type: 'trough' });
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
//  A2 — GEOMETRIC PATTERN SCANNER
//  Đọc chuỗi extrema → nhận diện mẫu hình hình học.
//  Trả về { name, bias:'T'|'X', strength:0–1 } hoặc null.
// ══════════════════════════════════════════════════════════════

function scanPattern(canvasA) {
  const ex = findExtrema(canvasA, 2);
  if (ex.length < 3) return null;

  const n    = ex.length;
  const last = ex[n - 1];
  const raw  = canvasA.filter(v => v !== null);
  const cur  = raw[raw.length - 1]; // tổng phiên mới nhất

  // ── Hàm kiểm tra gần bằng nhau ──────────────────────────
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

  // ── Mẫu W (Double Bottom) ────────────────────────────────
  // Pattern: trough – peak – trough(≈trough1) → breakout lên
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n - 3], ex[n - 2], ex[n - 1]];
    if (e1.type === 'trough' && e2.type === 'peak' && e3.type === 'trough' &&
        near(e1.v, e3.v, 3) && e2.v > e1.v + 2) {
      const neck = e2.v;
      const str  = Math.min(1, 0.55 + (neck - e3.v) / 14);
      // Xác nhận: giá hiện tại đang vươn lên
      const confirmed = cur >= neck - 2;
      return {
        name:     `Mẫu W — Đáy ${Math.round((e1.v + e3.v) / 2)}${confirmed ? ' ✓' : ' (chờ breakout)'}`,
        bias:     'T',
        strength: confirmed ? Math.min(1, str + 0.12) : str * 0.85,
      };
    }
  }

  // ── Mẫu M (Double Top) ───────────────────────────────────
  // Pattern: peak – trough – peak(≈peak1) → breakdown xuống
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n - 3], ex[n - 2], ex[n - 1]];
    if (e1.type === 'peak' && e2.type === 'trough' && e3.type === 'peak' &&
        near(e1.v, e3.v, 3) && e2.v < e1.v - 2) {
      const neck = e2.v;
      const str  = Math.min(1, 0.55 + (e3.v - neck) / 14);
      const confirmed = cur <= neck + 2;
      return {
        name:     `Mẫu M — Đỉnh ${Math.round((e1.v + e3.v) / 2)}${confirmed ? ' ✓' : ' (chờ breakdown)'}`,
        bias:     'X',
        strength: confirmed ? Math.min(1, str + 0.12) : str * 0.85,
      };
    }
  }

  // ── Head & Shoulders (Bearish) ───────────────────────────
  // peak(LS) – trough – peak(HEAD>LS) – trough(≈trough1) – peak(RS<HEAD)
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n - 5);
    if (ls.type === 'peak'   && lt.type === 'trough' &&
        hd.type === 'peak'   && rt.type === 'trough' && rs.type === 'peak' &&
        hd.v > ls.v && hd.v > rs.v &&
        near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3)) {
      const neckline = (lt.v + rt.v) / 2;
      const str = Math.min(1, 0.62 + (hd.v - rs.v) / 14);
      return {
        name:     `Vai-Đầu-Vai Đỉnh ${hd.v} — Kháng cự ${Math.round(neckline)}`,
        bias:     'X',
        strength: str,
      };
    }
  }

  // ── Inverse H&S (Bullish) ────────────────────────────────
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n - 5);
    if (ls.type === 'trough' && lt.type === 'peak'   &&
        hd.type === 'trough' && rt.type === 'peak'   && rs.type === 'trough' &&
        hd.v < ls.v && hd.v < rs.v &&
        near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3)) {
      const neckline = (lt.v + rt.v) / 2;
      const str = Math.min(1, 0.62 + (rs.v - hd.v) / 14);
      return {
        name:     `Vai-Đầu-Vai Đáy ${hd.v} — Hỗ trợ ${Math.round(neckline)}`,
        bias:     'T',
        strength: str,
      };
    }
  }

  // ── Ascending Channel (Cầu Thang Tăng) ──────────────────
  // 3 đỉnh tăng dần + 3 đáy tăng dần
  {
    const peaks   = ex.filter(e => e.type === 'peak').slice(-3);
    const troughs = ex.filter(e => e.type === 'trough').slice(-3);
    if (peaks.length === 3 && troughs.length === 3) {
      const pkUp = peaks[0].v   < peaks[1].v   && peaks[1].v   < peaks[2].v;
      const trUp = troughs[0].v < troughs[1].v && troughs[1].v < troughs[2].v;
      const pkDn = peaks[0].v   > peaks[1].v   && peaks[1].v   > peaks[2].v;
      const trDn = troughs[0].v > troughs[1].v && troughs[1].v > troughs[2].v;

      if (pkUp && trUp) return {
        name:     `Cầu Thang Tăng — Đỉnh ${peaks[2].v} / Đáy ${troughs[2].v}`,
        bias:     'T',
        strength: 0.72,
      };
      if (pkDn && trDn) return {
        name:     `Cầu Thang Giảm — Đỉnh ${peaks[2].v} / Đáy ${troughs[2].v}`,
        bias:     'X',
        strength: 0.72,
      };
    }
  }

  // ── Flag / Pennant ngắn (3 phiên cuối) ──────────────────
  // Sau đà mạnh → nén lại → bứt phá
  if (raw.length >= 6) {
    const impulse = raw[raw.length - 4] - raw[raw.length - 7 < 0 ? 0 : raw.length - 7];
    const consol  = Math.max(...raw.slice(-4)) - Math.min(...raw.slice(-4));
    if (Math.abs(impulse) >= 5 && consol <= 3) {
      const bias = impulse > 0 ? 'T' : 'X';
      return {
        name:     `Flag ${bias === 'T' ? 'Tăng' : 'Giảm'} — Đà ${impulse > 0 ? '+' : ''}${impulse.toFixed(0)}, nén ${consol.toFixed(0)}`,
        bias,
        strength: 0.65,
      };
    }
  }

  // ── Triple Bottom / Top ──────────────────────────────────
  if (n >= 4) {
    const lastTroughs = ex.filter(e => e.type === 'trough').slice(-3);
    if (lastTroughs.length === 3 &&
        near(lastTroughs[0].v, lastTroughs[1].v, 2) &&
        near(lastTroughs[1].v, lastTroughs[2].v, 2)) {
      return {
        name:     `Triple Đáy ${Math.round((lastTroughs[0].v + lastTroughs[1].v + lastTroughs[2].v) / 3)} — Hỗ trợ cứng`,
        bias:     'T',
        strength: 0.75,
      };
    }
    const lastPeaks = ex.filter(e => e.type === 'peak').slice(-3);
    if (lastPeaks.length === 3 &&
        near(lastPeaks[0].v, lastPeaks[1].v, 2) &&
        near(lastPeaks[1].v, lastPeaks[2].v, 2)) {
      return {
        name:     `Triple Đỉnh ${Math.round((lastPeaks[0].v + lastPeaks[1].v + lastPeaks[2].v) / 3)} — Kháng cự cứng`,
        bias:     'X',
        strength: 0.75,
      };
    }
  }

  return null; // Không nhận diện được mẫu nào
}

// ══════════════════════════════════════════════════════════════
//  A3 — SLOPE ANALYZER (Linear Regression)
//  Tính vector độ dốc trên W phiên gần nhất của canvasA.
// ══════════════════════════════════════════════════════════════

function analyzeSlope(canvasA, win = 5) {
  const pts = canvasA
    .map((v, i) => ({ v, i }))
    .filter(p => p.v !== null)
    .slice(-win);

  if (pts.length < 3) return null;

  // Linear regression
  const n = pts.length;
  let sX = 0, sY = 0, sXY = 0, sX2 = 0;
  pts.forEach(({ v }, idx) => { sX += idx; sY += v; sXY += idx * v; sX2 += idx * idx; });
  const denom = n * sX2 - sX * sX;
  const slope = denom ? (n * sXY - sX * sY) / denom : 0;

  const lastVal  = pts[n - 1].v;
  const projNext = Math.round(Math.max(3, Math.min(18, lastVal + slope)));

  // Mean-reversion: bẻ ngược nếu quá cực đoan
  const MEAN = 10.5;
  const meanRevert =
    (projNext >= 16 && slope > 0.5) ||  // cắm lên quá cao
    (projNext <= 5  && slope < -0.5);   // lao xuống quá thấp

  // Momentum: so sánh nửa đầu vs nửa cuối cửa sổ
  const half   = Math.floor(pts.length / 2);
  const avgOld = pts.slice(0, half).reduce((s, p) => s + p.v, 0) / half;
  const avgNew = pts.slice(half).reduce((s, p)  => s + p.v, 0) / (pts.length - half);
  const momentum = avgNew - avgOld; // dương = đà tăng

  let slopeBias = null;
  let detail    = '';

  if (meanRevert) {
    slopeBias = projNext >= 16 ? 'X' : 'T';
    detail = `Hồi quy trung bình: tổng ${lastVal} → proj ${projNext} quá ${projNext >= 16 ? 'cao' : 'thấp'} → bẻ ${slopeBias === 'T' ? 'lên Tài' : 'xuống Xỉu'}`;
  } else if (Math.abs(slope) >= 0.8) {
    slopeBias = slope > 0 ? 'T' : 'X';
    detail = `Slope mạnh ${slope > 0 ? '▲' : '▼'} ${slope.toFixed(2)}/phiên | proj ${projNext} | momentum ${momentum.toFixed(1)}`;
  } else if (Math.abs(slope) >= 0.35) {
    slopeBias = slope > 0 ? 'T' : 'X';
    detail = `Slope vừa ${slope > 0 ? '▲' : '▼'} ${slope.toFixed(2)}/phiên | proj ${projNext}`;
  } else {
    // Slope phẳng → dùng momentum
    if (Math.abs(momentum) >= 1.5) {
      slopeBias = momentum > 0 ? 'T' : 'X';
      detail = `Slope phẳng, momentum ${momentum > 0 ? '▲' : '▼'} ${momentum.toFixed(1)} → ${slopeBias === 'T' ? 'Tài' : 'Xỉu'}`;
    } else {
      detail = `Slope phẳng (${slope.toFixed(2)}), tổng ${lastVal}, không xu hướng`;
    }
  }

  return {
    slope:      +slope.toFixed(3),
    lastVal,
    projNext,
    momentum:   +momentum.toFixed(2),
    meanRevert,
    slopeBias,
    detail,
    // Strength: cao hơn nếu slope mạnh hoặc meanRevert
    strength:   meanRevert ? 0.85 : Math.min(1, 0.45 + Math.abs(slope) / 3 + Math.abs(momentum) / 10),
  };
}

// ══════════════════════════════════════════════════════════════
//  A4 — SUPPORT / RESISTANCE ZONE DETECTOR
//  Cluster các cực trị → tìm mốc bị "bật" nhiều lần.
// ══════════════════════════════════════════════════════════════

function detectSR(canvasA, minTouches = 3) {
  const valid = canvasA.filter(v => v !== null);
  if (valid.length < 10) return { zones: [], srBias: null, srDetail: 'Chưa đủ dữ liệu' };

  // Thu thập cực trị
  const exPts = [];
  for (let i = 1; i < valid.length - 1; i++) {
    if (valid[i] > valid[i - 1] && valid[i] >= valid[i + 1]) exPts.push({ v: valid[i], role: 'res' });
    if (valid[i] < valid[i - 1] && valid[i] <= valid[i + 1]) exPts.push({ v: valid[i], role: 'sup' });
  }

  // Gom vào bin theo giá trị làm tròn, merge ±1
  const bins = {};
  for (const e of exPts) {
    const k = Math.round(e.v);
    if (!bins[k]) bins[k] = { level: k, res: 0, sup: 0 };
    bins[k][e.role]++;
  }
  const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
  const zones = [];
  const seen  = new Set();
  for (const k of keys) {
    if (seen.has(k)) continue;
    const b = { ...bins[k] };
    if (bins[k + 1]) {
      b.res   += bins[k + 1].res;
      b.sup   += bins[k + 1].sup;
      b.level  = +((k + k + 1) / 2).toFixed(1);
      seen.add(k + 1);
    }
    b.touches = b.res + b.sup;
    b.type    = b.res >= b.sup ? 'resistance' : 'support';
    if (b.touches >= minTouches) zones.push(b);
  }
  zones.sort((a, b) => b.touches - a.touches);

  // Đánh giá vị trí tổng hiện tại
  const cur = valid[valid.length - 1];
  let srBias = null, srDetail = 'Không có ngưỡng S/R nổi bật';

  for (const z of zones.slice(0, 3)) {
    const diff = cur - z.level;
    if (z.type === 'resistance') {
      if (Math.abs(diff) <= 1.5) {
        srBias   = 'X';
        srDetail = `Đụng kháng cự ${z.level} (chạm ${z.touches} lần) → áp lực giảm`;
        break;
      } else if (diff > 0) {
        srBias   = 'T';
        srDetail = `Vượt kháng cự ${z.level} → momentum tăng`;
        break;
      }
    } else {
      if (Math.abs(diff) <= 1.5) {
        srBias   = 'T';
        srDetail = `Chạm hỗ trợ ${z.level} (chạm ${z.touches} lần) → lực bật tăng`;
        break;
      } else if (diff < 0) {
        srBias   = 'X';
        srDetail = `Thủng hỗ trợ ${z.level} → áp lực tiếp tục giảm`;
        break;
      }
    }
  }

  return { zones: zones.slice(0, 4), srBias, srDetail };
}

// ══════════════════════════════════════════════════════════════
//  B1+B2 — DICE CONVERGENCE (Chart B)
//  Tính slope riêng mỗi xúc xắc → đồng pha 2/3 hoặc 3/3.
// ══════════════════════════════════════════════════════════════

function analyzeDice(canvasB, win = 6) {
  const slopes = [0, 1, 2].map(di => {
    const vals = canvasB
      .map(row => (Array.isArray(row) ? row[di] : null))
      .filter(v => v !== null)
      .slice(-win);

    if (vals.length < 3) return null;

    const n = vals.length;
    let sX = 0, sY = 0, sXY = 0, sX2 = 0;
    vals.forEach((v, i) => { sX += i; sY += v; sXY += i * v; sX2 += i * i; });
    const denom = n * sX2 - sX * sX;
    return denom ? (n * sXY - sX * sY) / denom : 0;
  });

  const valid = slopes.filter(s => s !== null);
  if (valid.length < 2) return { diceBias: null, diceDetail: 'Thiếu dữ liệu xúc xắc', convScore: 0 };

  const up   = valid.filter(s => s >  0.12).length;
  const down = valid.filter(s => s < -0.12).length;
  const flat = valid.length - up - down;

  // Tính tổng slope trung bình của từng xúc xắc → ước tổng tiếp theo
  const avgSlope = valid.reduce((a, s) => a + s, 0) / valid.length;
  const lastDice = canvasB.filter(r => r !== null).slice(-1)[0];
  const lastSum  = lastDice ? lastDice.reduce((a, b) => a + b, 0) : null;
  const projSum  = lastSum !== null ? +(lastSum + avgSlope * 3).toFixed(1) : null;

  let diceBias = null, diceDetail = '', convScore = 0;

  if (up >= 2 || down >= 2) {
    convScore = Math.max(up, down);
    diceBias  = up >= down ? 'T' : 'X';
    const dir = diceBias === 'T' ? '▲ đồng loạt tăng' : '▼ đồng loạt giảm';
    diceDetail = `${convScore}/3 xúc xắc ${dir}` +
      (projSum !== null ? ` | proj tổng ≈ ${projSum}` : '');
  } else {
    diceDetail = `Xúc xắc phân kỳ (↑${up} ↓${down} →${flat})` +
      (projSum !== null ? ` | proj tổng ≈ ${projSum}` : '');
  }

  return { diceBias, diceDetail, convScore, slopes, avgSlope: +avgSlope.toFixed(3), projSum };
}

// ══════════════════════════════════════════════════════════════
//  META ENSEMBLE — Tổng hợp 4 tín hiệu → vote có trọng số
// ══════════════════════════════════════════════════════════════

function ensembleVote(signals) {
  const { pattern, slope, sr, dice } = signals;

  let scoreT = 0, scoreX = 0, totalW = 0;
  const sources = [];

  const cast = (bias, w, name, detail, strength = 1) => {
    if (!bias || w <= 0) return;
    const eff = w * Math.min(1.3, Math.max(0.3, strength));
    if (bias === 'T') scoreT += eff;
    else              scoreX += eff;
    totalW += eff;
    sources.push({ name, bias, biasFull: fullLabel(bias), detail, weight: +eff.toFixed(3) });
  };

  // Chart A — Pattern (trọng số cao nhất)
  if (pattern?.bias) {
    cast(pattern.bias, CFG.W_PATTERN, 'Mẫu hình', pattern.name, pattern.strength ?? 0.7);
  }

  // Chart A — Slope + Mean-Reversion
  if (slope?.slopeBias) {
    cast(slope.slopeBias, CFG.W_SLOPE, 'Slope / Momentum', slope.detail, slope.strength ?? 0.6);
  }

  // Chart A — S/R
  if (sr?.srBias) {
    cast(sr.srBias, CFG.W_SR, 'Hỗ trợ / Kháng cự', sr.srDetail, 0.8);
  }

  // Chart B — Dice Convergence
  if (dice?.diceBias) {
    cast(dice.diceBias, CFG.W_DICE, 'Đồng pha Xúc xắc', dice.diceDetail, dice.convScore / 3);
  }

  if (totalW === 0) return null;

  const rawT   = scoreT / totalW;
  const rawX   = scoreX / totalW;
  const winner = rawT >= rawX ? 'T' : 'X';
  const rawConf = Math.max(rawT, rawX);
  const conf   = calibrateConf(rawConf);

  let clarity;
  if (rawConf >= 0.74)      clarity = 'Rõ ràng';
  else if (rawConf >= 0.63) clarity = 'Khá rõ';
  else if (rawConf >= 0.56) clarity = 'Trung bình';
  else                      clarity = 'Không rõ – Cân nhắc bỏ qua';

  return {
    winner,
    winnerFull: fullLabel(winner),
    conf,
    rawConf:   +rawConf.toFixed(4),
    clarity,
    votes:     { T: +scoreT.toFixed(3), X: +scoreX.toFixed(3) },
    votePct:   { T: `${(rawT * 100).toFixed(1)}%`, X: `${(rawX * 100).toFixed(1)}%` },
    sources,
    patternName: pattern?.name ?? null,
  };
}

// ══════════════════════════════════════════════════════════════
//  MAIN PREDICT — chạy toàn bộ pipeline
// ══════════════════════════════════════════════════════════════

function predictByVirtualChart(hist) {
  if (!hist || hist.length < CFG.MIN_HIST) return null;

  // 1. Vẽ canvas vào bộ nhớ
  const { canvasA, canvasB } = buildCanvas(hist);

  // 2. Phân tích 4 tín hiệu
  const pattern = scanPattern(canvasA);
  const slope   = analyzeSlope(canvasA, 5);
  const sr      = detectSR(canvasA, 3);
  const dice    = analyzeDice(canvasB, 6);

  // 3. Ensemble
  const ens = ensembleVote({ pattern, slope, sr, dice });
  if (!ens) return null;

  return {
    winner:     ens.winner,
    conf:       ens.conf,
    clarity:    ens.clarity,
    patternName: ens.patternName ?? 'Không nhận diện mẫu hình',
    votePct:    ens.votePct,
    sources:    ens.sources,
    // snapshot canvas để debug
    canvasA_last10: canvasA.slice(-10),
    srZones:    sr.zones,
  };
}

// ══════════════════════════════════════════════════════════════
//  FETCH & POLLING
// ══════════════════════════════════════════════════════════════

function classifyDice(dice) {
  if (!dice || dice.length !== 3) return '?';
  const [a, b, c] = [...dice].sort((x, y) => x - y);
  if (a === b && b === c)               return `Ba ${a}`;
  if (a === b || b === c)               return `Đôi ${a === b ? a : b}`;
  if (c - a === 2 && b - a === 1)       return `Seri ${a}-${b}-${c}`;
  return `${a}-${b}-${c}`;
}

async function fetchAndUpdate() {
  try {
    const res  = await fetch(SOURCE_API, { signal: AbortSignal.timeout(9000) });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;

    const sorted   = [...data].sort((a, b) => a.session - b.session);
    const latest   = sorted[sorted.length - 1];
    const knownSet = new Set(history.map(h => h.phien));

    // Nạp phiên mới vào history
    for (const item of sorted) {
      const phien = String(item.session);
      if (knownSet.has(phien)) continue;

      const dice = Array.isArray(item.dice) && item.dice.length === 3
        ? item.dice.map(Number) : null;
      const tong = typeof item.total === 'number'
        ? item.total : (dice ? dice.reduce((a, b) => a + b, 0) : 0);
      const kq = item.ket_qua === 'Tài' ? 'T'
               : item.ket_qua === 'Xỉu' ? 'X'
               : (tong >= CFG.TAI_LINE  ? 'T' : 'X');

      history.push({ phien, dice, tong, kq });
      knownSet.add(phien);

      // Đánh giá dự đoán pending
      if (pendingPred?.phien === phien) {
        const win = pendingPred.predicted === kq;
        winLoss.push({ phien, predicted: pendingPred.predicted, actual: kq, win, conf: pendingPred.conf });
        if (winLoss.length > 200) winLoss = winLoss.slice(-100);
        pendingPred = null;
      }
    }

    if (history.length > CFG.MAX_HISTORY) history = history.slice(-CFG.MAX_HISTORY);

    // Chạy dự đoán
    const pred    = predictByVirtualChart(history);
    const phienN  = String(Number(latest.session) + 1);

    if (pred) {
      pendingPred = { phien: phienN, predicted: pred.winner, conf: pred.conf };
    }

    // Tính winrate
    const recentWL = winLoss.slice(-50);
    const wins  = recentWL.filter(r => r.win).length;
    const winRate = recentWL.length ? `${Math.round(wins / recentWL.length * 100)}%` : 'Chưa có';

    // Build pattern string
    const pattern30 = history.slice(-30).map(h => h.kq).join('');

    const latestTong = typeof latest.total === 'number' ? latest.total
      : (Array.isArray(latest.dice) ? latest.dice.reduce((a, b) => a + b, 0) : 0);
    const latestKq = latestTong >= CFG.TAI_LINE ? 'T' : 'X';

    // ── /sunlon format — giữ nguyên cấu trúc gốc ──────────
    latestResult = {
      id:            '@sewdangcap',
      phien:         latest.session,
      ket_qua:       fullLabel(latestKq),
      tong:          latestTong,
      xuc_xac:       Array.isArray(latest.dice) ? latest.dice.map(Number) : null,
      phan_loai:     Array.isArray(latest.dice) ? classifyDice(latest.dice.map(Number)) : null,
      phien_du_doan: Number(phienN),
      du_doan: pred ? {
        ket_qua:       fullLabel(pred.winner),
        luot_danh:     pred.winner === 'T' ? 'TÀI' : 'XỈU',
        do_tin_cay:    `${pred.conf}%`,
        muc_do:        pred.clarity,
        ty_le:         pred.votePct,
        cau_noi_bat:   pred.patternName,     // tên mẫu hình thay cho tên cầu
        so_algo:       `${pred.sources.length}/4 tín hiệu`,
      } : null,
      win_rate:      winRate,
      pattern:       pattern30,
    };

    return latestResult;

  } catch (e) {
    console.error('[fetchAndUpdate]', e.message);
    return null;
  }
}

(async () => { await fetchAndUpdate(); })();
setInterval(fetchAndUpdate, 5000);

// ══════════════════════════════════════════════════════════════
//  EXPRESS MIDDLEWARE
// ══════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// ── / — Dashboard ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Virtual Chart Engine v2.0 — @sewdangcap</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0c12;color:#e2e8f0;font-family:'Segoe UI',sans-serif;
    min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:24px}
  h1{font-size:2rem;font-weight:800;margin-bottom:4px;
    background:linear-gradient(90deg,#f59e0b,#ef4444);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:#64748b;font-size:.82rem;margin-bottom:6px}
  .ver{color:#10b981;font-size:.78rem;font-weight:600;margin-bottom:32px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
    gap:14px;width:100%;max-width:960px}
  .card{background:#111827;border:1px solid #1e293b;border-radius:12px;
    padding:22px 18px;text-decoration:none;color:inherit;display:block;transition:all .2s}
  .card:hover{border-color:#f59e0b;transform:translateY(-2px);
    box-shadow:0 8px 24px rgba(245,158,11,.12)}
  .card .icon{font-size:1.6rem;margin-bottom:8px;display:block}
  .card h2{font-size:.92rem;color:#f59e0b;margin-bottom:5px;font-weight:600}
  .card p{font-size:.76rem;color:#64748b;line-height:1.55}
  .path{display:inline-block;margin-top:10px;font-size:.7rem;color:#10b981;
    background:#052e16;border:1px solid #065f4620;padding:2px 8px;
    border-radius:20px;font-family:monospace}
  .badge{display:inline-block;background:#ef4444;color:#fff;font-size:.58rem;
    font-weight:700;padding:1px 6px;border-radius:20px;margin-left:4px;vertical-align:middle}
  footer{margin-top:36px;color:#374151;font-size:.75rem}
</style>
</head>
<body>
<h1>📈 Virtual Chart Engine</h1>
<p class="sub">DEV @sewdangcap</p>
<p class="ver">v2.0 — Technical Analysis · Pattern · Slope · S/R · Dice Convergence</p>
<div class="grid">
  <a class="card" href="/sunlon">
    <span class="icon">⚡</span>
    <h2>Dự đoán Realtime <span class="badge">MAIN</span></h2>
    <p>Kết quả mới nhất + dự đoán phiên tiếp theo. Format JSON gốc giữ nguyên.</p>
    <span class="path">GET /sunlon</span>
  </a>
  <a class="card" href="/canvas">
    <span class="icon">📊</span>
    <h2>Canvas Snapshot</h2>
    <p>Xem dữ liệu thô của 2 biểu đồ ngầm: Chart A (Tổng) + Chart B (3 Xúc xắc).</p>
    <span class="path">GET /canvas</span>
  </a>
  <a class="card" href="/signals">
    <span class="icon">🔍</span>
    <h2>Chi tiết Tín hiệu</h2>
    <p>Breakdown 4 tín hiệu kỹ thuật: Pattern / Slope / S&R / Dice với trọng số.</p>
    <span class="path">GET /signals</span>
  </a>
  <a class="card" href="/thongke">
    <span class="icon">📋</span>
    <h2>Thống kê Thắng/Thua</h2>
    <p>Win rate 50 phiên gần nhất theo dõi kết quả dự đoán thực tế.</p>
    <span class="path">GET /thongke</span>
  </a>
  <a class="card" href="/history">
    <span class="icon">📜</span>
    <h2>Lịch sử Phiên</h2>
    <p>50 phiên gần nhất: xúc xắc, tổng, kết quả.</p>
    <span class="path">GET /history</span>
  </a>
</div>
<footer>© 2025 DEV @sewdangcap — Virtual Chart Engine</footer>
</body>
</html>`);
});

// ── /sunlon — FORMAT JSON GỐC (giữ nguyên) ───────────────────
app.get('/sunlon', async (req, res) => {
  if (!latestResult) {
    const d = await fetchAndUpdate();
    if (!d) return res.status(503).json({ error: 'Đang khởi động, thử lại sau...' });
  }
  res.json(latestResult);
});

// ── /canvas — Snapshot 2 biểu đồ ngầm ────────────────────────
app.get('/canvas', (req, res) => {
  if (history.length < CFG.MIN_HIST)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const { canvasA, canvasB, len } = buildCanvas(history);
  const phiens = history.slice(-CFG.CANVAS_W).map(h => Number(h.phien));

  res.json({
    id:          '@sewdangcap',
    canvas_width: len,
    chart_A: {
      mo_ta:       'Đường Tổng — trục Y: 3–18',
      y_min: 3, y_max: 18,
      data: phiens.map((p, i) => ({ phien: p, tong: canvasA[i] })),
    },
    chart_B: {
      mo_ta:       '3 Đường Xúc Xắc — trục Y: 1–6 (màu: đỏ/vàng/tím)',
      y_min: 1, y_max: 6,
      data: phiens.map((p, i) => ({
        phien: p,
        d1: canvasB[i]?.[0] ?? null,
        d2: canvasB[i]?.[1] ?? null,
        d3: canvasB[i]?.[2] ?? null,
      })),
    },
  });
});

// ── /signals — Chi tiết 4 tín hiệu ───────────────────────────
app.get('/signals', (req, res) => {
  if (history.length < CFG.MIN_HIST)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });

  const { canvasA, canvasB } = buildCanvas(history);
  const pattern = scanPattern(canvasA);
  const slope   = analyzeSlope(canvasA, 5);
  const sr      = detectSR(canvasA, 3);
  const dice    = analyzeDice(canvasB, 6);
  const ens     = ensembleVote({ pattern, slope, sr, dice });

  res.json({
    id: '@sewdangcap',
    ket_luan: ens ? {
      du_doan:    fullLabel(ens.winner),
      do_tin_cay: `${ens.conf}%`,
      muc_do:     ens.clarity,
    } : null,
    tin_hieu: {
      chart_A_pattern: pattern
        ? { ten: pattern.name, bias: fullLabel(pattern.bias), suc_manh: +pattern.strength.toFixed(2) }
        : { ten: 'Không nhận diện được', bias: null },
      chart_A_slope: slope
        ? { slope: slope.slope, lastVal: slope.lastVal, projNext: slope.projNext,
            meanRevert: slope.meanRevert, bias: fullLabel(slope.slopeBias), chi_tiet: slope.detail }
        : { chi_tiet: 'Không đủ dữ liệu' },
      chart_A_sr: { bias: fullLabel(sr.srBias), chi_tiet: sr.srDetail, zones: sr.zones },
      chart_B_dice: { bias: fullLabel(dice.diceBias), chi_tiet: dice.diceDetail,
                      conv: `${dice.convScore}/3`, avgSlope: dice.avgSlope },
    },
    nguon_bieu_quyet: ens?.sources ?? [],
    trong_so_cau_hinh: {
      'Pattern hình học': CFG.W_PATTERN,
      'Slope / Momentum': CFG.W_SLOPE,
      'Hỗ trợ / Kháng cự': CFG.W_SR,
      'Đồng pha Xúc xắc': CFG.W_DICE,
    },
  });
});

// ── /thongke — Winrate tracking ───────────────────────────────
app.get('/thongke', (req, res) => {
  const slice = winLoss.slice(-50).reverse();
  const wins  = slice.filter(r => r.win).length;
  const rate  = slice.length ? Math.round(wins / slice.length * 100) : 0;

  let streak = 0, streakType = null;
  for (const r of slice) {
    if (streakType === null) { streakType = r.win; streak = 1; }
    else if (r.win === streakType) streak++;
    else break;
  }

  res.json({
    id: '@sewdangcap',
    tong_quan: {
      tong_phien:      slice.length,
      thang:           wins,
      thua:            slice.length - wins,
      win_rate:        `${rate}%`,
      streak_hien_tai: streak > 0
        ? `${streak} ${streakType ? 'THẮNG' : 'THUA'} liên tiếp`
        : 'Chưa có dữ liệu',
    },
    chi_tiet: slice.map((r, i) => ({
      stt:          i + 1,
      phien:        Number(r.phien),
      du_doan:      fullLabel(r.predicted),
      ket_qua_thuc: fullLabel(r.actual),
      do_tin_cay:   `${r.conf}%`,
      ket_luan:     r.win ? '✅ THẮNG' : '❌ THUA',
    })),
  });
});

// ── /history ──────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({
    id:   '@sewdangcap',
    tong: history.length,
    data: history.slice(-limit).reverse().map(h => ({
      phien:     Number(h.phien),
      xuc_xac:   h.dice,
      phan_loai: h.dice ? classifyDice(h.dice) : '-',
      tong:      h.tong,
      ket_qua:   fullLabel(h.kq),
    })),
  });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({
    error: 'Endpoint không tồn tại',
    endpoints: ['/', '/sunlon', '/canvas', '/signals', '/thongke', '/history'],
  })
);

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`
📈 Virtual Chart Engine v2.0 — @sewdangcap
   http://localhost:${PORT}
   Canvas: ${CFG.CANVAS_W} phiên | Min history: ${CFG.MIN_HIST} phiên
   Weights: Pattern ${CFG.W_PATTERN} · Slope ${CFG.W_SLOPE} · S/R ${CFG.W_SR} · Dice ${CFG.W_DICE}
   Endpoints: /sunlon  /canvas  /signals  /thongke  /history
`)
);
