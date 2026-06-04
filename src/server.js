'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  TÀI XỈU — VIRTUAL CHART ENGINE  v5.0
 *  DEV @sewdangcap
 *
 *  Charts nâng cấp:
 *    CHART A — Candlestick Tổng + Bollinger Bands + SMA
 *              RSI Oscillator (phụ) + Volume Bars
 *    CHART B — 3 Đường Xúc Xắc với Area Fill + Divergence markers
 *              Heatmap Row dưới
 *
 *  Pipeline phân tích kỹ thuật (5 tín hiệu):
 *    1. Geometric Pattern  → W / M / H&S / Cầu Thang / Flag / Triple
 *    2. Linear Slope + Momentum + Mean-Reversion
 *    3. Support / Resistance Zone
 *    4. Dice Convergence (3 xúc xắc đồng pha)
 *    5. Streak / Cầu tâm lý
 *    → Adaptive Ensemble vote có trọng số
 *
 *  Endpoints:
 *    GET /           → Dashboard HTML
 *    GET /sunlon     → JSON dự đoán
 *    GET /canvas     → JSON snapshot 2 biểu đồ
 *    GET /signals    → JSON chi tiết 5 tín hiệu
 *    GET /thongke    → JSON winrate tracking
 *    GET /history    → JSON lịch sử phiên
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

const SOURCE_API = 'https://apilichsusunwinsew.onrender.com/api/taixiu/history?limit=50';

// ════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════
const CFG = {
  CANVAS_W:     50,
  MIN_HIST:      8,
  TAI_LINE:     11,
  MAX_HISTORY:  500,
  CONF_FLOOR:   52,
  CONF_CEIL:    91,
  POLL_MS:      6000,

  W_PATTERN:   0.32,
  W_SLOPE:     0.22,
  W_SR:        0.18,
  W_DICE:      0.16,
  W_STREAK:    0.12,
};

// ════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════
let history      = [];
let latestResult = null;
let pendingPred  = null;
let winLoss      = [];

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
const kqLabel   = t => (t >= CFG.TAI_LINE ? 'T' : 'X');
const fullLabel = v => (v === 'T' ? 'Tài' : v === 'X' ? 'Xỉu' : null);

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
//  TECHNICAL INDICATORS
// ════════════════════════════════════════════════════════════════
function calcSMA(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const slice = data.slice(i - period + 1, i + 1).filter(v => v !== null);
    return slice.length ? +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2) : null;
  });
}

function calcBollingerBands(data, period = 14, mult = 2) {
  const sma = calcSMA(data, period);
  return data.map((_, i) => {
    if (sma[i] === null) return { upper: null, middle: null, lower: null };
    const slice = data.slice(Math.max(0, i - period + 1), i + 1).filter(v => v !== null);
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma[i], 2), 0) / slice.length;
    const sd = Math.sqrt(variance);
    return {
      upper:  +(sma[i] + mult * sd).toFixed(2),
      middle: sma[i],
      lower:  +(sma[i] - mult * sd).toFixed(2),
    };
  });
}

function calcRSI(data, period = 10) {
  const rsi = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period) { rsi.push(null); continue; }
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (data[j] === null || data[j-1] === null) continue;
      const diff = data[j] - data[j-1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    rsi.push(+(100 - 100 / (1 + rs)).toFixed(1));
  }
  return rsi;
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [];
  let prev = null;
  data.forEach(v => {
    if (v === null) { ema.push(null); return; }
    if (prev === null) { prev = v; ema.push(v); return; }
    prev = +(v * k + prev * (1 - k)).toFixed(2);
    ema.push(prev);
  });
  return ema;
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

  if (n >= 3) {
    const [e1, e2, e3] = [ex[n-3], ex[n-2], ex[n-1]];
    if (e1.type === 'trough' && e2.type === 'peak' && e3.type === 'trough' &&
        near(e1.v, e3.v, 3) && e2.v > e1.v + 2) {
      const str = Math.min(1, 0.55 + (e2.v - e3.v) / 14);
      const confirmed = cur >= e2.v - 2;
      return { name: `Mẫu W — Đáy ~${Math.round((e1.v+e3.v)/2)}${confirmed?' ✓':''}`, bias: 'T',
               strength: confirmed ? Math.min(1, str + 0.12) : str * 0.85,
               extrema: ex };
    }
  }
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n-3], ex[n-2], ex[n-1]];
    if (e1.type === 'peak' && e2.type === 'trough' && e3.type === 'peak' &&
        near(e1.v, e3.v, 3) && e2.v < e1.v - 2) {
      const str = Math.min(1, 0.55 + (e3.v - e2.v) / 14);
      const confirmed = cur <= e2.v + 2;
      return { name: `Mẫu M — Đỉnh ~${Math.round((e1.v+e3.v)/2)}${confirmed?' ✓':''}`, bias: 'X',
               strength: confirmed ? Math.min(1, str + 0.12) : str * 0.85,
               extrema: ex };
    }
  }
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n - 5);
    if (ls.type==='peak' && lt.type==='trough' && hd.type==='peak' &&
        rt.type==='trough' && rs.type==='peak' &&
        hd.v > ls.v && hd.v > rs.v && near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3)) {
      return { name: `Vai-Đầu-Vai Đỉnh ${hd.v}`, bias: 'X',
               strength: Math.min(1, 0.62 + (hd.v - rs.v) / 14), extrema: ex };
    }
  }
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n - 5);
    if (ls.type==='trough' && lt.type==='peak' && hd.type==='trough' &&
        rt.type==='peak' && rs.type==='trough' &&
        hd.v < ls.v && hd.v < rs.v && near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3)) {
      return { name: `Vai-Đầu-Vai Đáy ${hd.v}`, bias: 'T',
               strength: Math.min(1, 0.62 + (rs.v - hd.v) / 14), extrema: ex };
    }
  }
  {
    const peaks   = ex.filter(e => e.type === 'peak').slice(-3);
    const troughs = ex.filter(e => e.type === 'trough').slice(-3);
    if (peaks.length === 3 && troughs.length === 3) {
      const pkUp = peaks[0].v   < peaks[1].v   && peaks[1].v   < peaks[2].v;
      const trUp = troughs[0].v < troughs[1].v && troughs[1].v < troughs[2].v;
      const pkDn = peaks[0].v   > peaks[1].v   && peaks[1].v   > peaks[2].v;
      const trDn = troughs[0].v > troughs[1].v && troughs[1].v > troughs[2].v;
      if (pkUp && trUp) return { name: `Cầu Thang Tăng — Đỉnh ${peaks[2].v}`, bias: 'T', strength: 0.72, extrema: ex };
      if (pkDn && trDn) return { name: `Cầu Thang Giảm — Đỉnh ${peaks[2].v}`, bias: 'X', strength: 0.72, extrema: ex };
    }
  }
  if (raw.length >= 6) {
    const impulse = raw[raw.length-4] - raw[Math.max(0, raw.length-7)];
    const consol  = Math.max(...raw.slice(-4)) - Math.min(...raw.slice(-4));
    if (Math.abs(impulse) >= 5 && consol <= 3) {
      const bias = impulse > 0 ? 'T' : 'X';
      return { name: `Flag ${bias==='T'?'Tăng':'Giảm'} Đà${impulse>0?'+':''}${impulse.toFixed(0)}`, bias, strength: 0.65, extrema: ex };
    }
  }
  if (n >= 4) {
    const lt = ex.filter(e => e.type === 'trough').slice(-3);
    if (lt.length === 3 && near(lt[0].v,lt[1].v,2) && near(lt[1].v,lt[2].v,2))
      return { name: `Triple Đáy ~${Math.round((lt[0].v+lt[1].v+lt[2].v)/3)}`, bias: 'T', strength: 0.75, extrema: ex };
    const lp = ex.filter(e => e.type === 'peak').slice(-3);
    if (lp.length === 3 && near(lp[0].v,lp[1].v,2) && near(lp[1].v,lp[2].v,2))
      return { name: `Triple Đỉnh ~${Math.round((lp[0].v+lp[1].v+lp[2].v)/3)}`, bias: 'X', strength: 0.75, extrema: ex };
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
//  C — STREAK / CẦU TÂM LÝ
// ════════════════════════════════════════════════════════════════
function analyzeStreak(hist) {
  if (!hist || hist.length < 3) return { streakBias: null, streakDetail: 'Chưa đủ dữ liệu', streakLen: 0, strength: 0.3 };
  const kqs = hist.slice(-20).map(h => h.kq);
  let streak = 1;
  const last = kqs[kqs.length - 1];
  for (let i = kqs.length - 2; i >= 0; i--) {
    if (kqs[i] === last) streak++;
    else break;
  }
  let streakBias = null, streakDetail = '', strength = 0.3;
  const opposite = last === 'T' ? 'X' : 'T';
  if (streak >= 5) {
    streakBias = opposite; streakDetail = `Cầu ${fullLabel(last)} ${streak} phiên → Đổi chiều`; strength = 0.88;
  } else if (streak >= 3) {
    streakBias = opposite; streakDetail = `Cầu ${fullLabel(last)} ${streak} phiên → Cảnh báo`; strength = 0.65;
  } else if (streak === 2) {
    streakBias = last; streakDetail = `Cầu ${fullLabel(last)} ${streak} phiên → Theo đà`; strength = 0.45;
  } else {
    streakDetail = `Không có cầu rõ`; strength = 0.3;
  }
  if (streak === 1 && kqs.length >= 6) {
    const alt = kqs.slice(-6).every((k, i) => i === 0 || k !== kqs[kqs.length-6+i-1]);
    if (alt) { streakBias = opposite; streakDetail = `Cầu 1-1 xen kẽ → Tiếp tục`; strength = 0.60; }
  }
  return { streakBias, streakDetail, streakLen: streak, strength };
}

// ════════════════════════════════════════════════════════════════
//  META ENSEMBLE
// ════════════════════════════════════════════════════════════════
function ensembleVote(signals) {
  const { pattern, slope, sr, dice, streak } = signals;
  let sT = 0, sX = 0, tW = 0;
  const sources = [];
  const cast = (bias, w, name, detail, str = 1) => {
    if (!bias) return;
    const eff = w * Math.min(1.3, Math.max(0.3, str));
    if (bias === 'T') sT += eff; else sX += eff;
    tW += eff;
    sources.push({ name, bias, biasFull: fullLabel(bias), detail, weight: +eff.toFixed(3) });
  };
  if (pattern?.bias)    cast(pattern.bias,    CFG.W_PATTERN, 'Mẫu hình',         pattern.name,        pattern.strength ?? 0.7);
  if (slope?.slopeBias) cast(slope.slopeBias, CFG.W_SLOPE,   'Slope/Momentum',   slope.detail,        slope.strength   ?? 0.6);
  if (sr?.srBias)       cast(sr.srBias,       CFG.W_SR,      'Hỗ trợ/Kháng cự', sr.srDetail,         0.8);
  if (dice?.diceBias)   cast(dice.diceBias,   CFG.W_DICE,    'Đồng pha Xúc xắc', dice.diceDetail,    dice.convScore/3);
  if (streak?.streakBias) cast(streak.streakBias, CFG.W_STREAK, 'Cầu tâm lý',    streak.streakDetail, streak.strength);
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
  const streak  = analyzeStreak(slice);
  const ens     = ensembleVote({ pattern, slope, sr, dice, streak });
  if (!ens) return null;
  return { ...ens, patternName: ens.patternName ?? 'Không nhận diện mẫu hình', canvasA, slice, streak };
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
      phien:          String(latest.session),
      xuc_xac:        Array.isArray(latest.dice) ? latest.dice.map(Number) : null,
      ket_qua:        fullLabel(latestKq),
      phien_hien_tai: phienN,
      du_doan:        pred ? fullLabel(pred.winner) : null,
      do_tin_cay:     pred ? `${pred.conf}%` : null,
      pattern:        pattern30,
      dev:            '@sewdangcap',
    };
    return latestResult;
  } catch (e) {
    console.error('[fetchAndUpdate]', e.message);
    return null;
  }
}

(async () => { await fetchAndUpdate(); })();
setInterval(fetchAndUpdate, CFG.POLL_MS);

// ════════════════════════════════════════════════════════════════
//  EXPRESS
// ════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════════
//  / — DASHBOARD HTML
// ════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const hist   = history.slice(-CFG.CANVAS_W);
  const pred   = predictByVirtualChart(history);
  const latest = history[history.length - 1];

  if (!latest) return res.send(`<!DOCTYPE html><html><body style="background:#080c14;color:#e0e8ff;font-family:monospace;padding:2rem;text-align:center">
    <h2 style="color:#4fc8ff">⏳ Đang khởi động...</h2><p>Kết nối API nguồn...</p>
    <script>setTimeout(()=>location.reload(),3000)</script></body></html>`);

  const nxtPhien   = String(Number(latest.phien) + 1);
  const taiCount50 = history.slice(-50).filter(h => h.kq === 'T').length;
  const xiuCount50 = history.slice(-50).length - taiCount50;
  const recentWL   = winLoss.slice(-50);
  const wr         = recentWL.length ? Math.round(recentWL.filter(r=>r.win).length/recentWL.length*100)+'%' : '—';
  const pattern50  = history.slice(-50).map(h => h.kq).join('');
  const streak     = pred?.streak ?? analyzeStreak(hist);

  // ─── Compute indicators server-side ───
  const tongArr   = hist.map(h => h.tong);
  const bb        = calcBollingerBands(tongArr, 14, 2);
  const sma7      = calcSMA(tongArr, 7);
  const ema14     = calcEMA(tongArr, 14);
  const rsiArr    = calcRSI(tongArr, 10);
  const srData    = detectSR(tongArr, 2);

  const chartAData    = JSON.stringify(tongArr);
  const bbUpper       = JSON.stringify(bb.map(b => b.upper));
  const bbMiddle      = JSON.stringify(bb.map(b => b.middle));
  const bbLower       = JSON.stringify(bb.map(b => b.lower));
  const sma7Data      = JSON.stringify(sma7);
  const ema14Data     = JSON.stringify(ema14);
  const rsiData       = JSON.stringify(rsiArr);
  const srZones       = JSON.stringify(srData.zones.slice(0,5));

  const chartBD1    = JSON.stringify(hist.map(h => h.dice ? h.dice[0] : null));
  const chartBD2    = JSON.stringify(hist.map(h => h.dice ? h.dice[1] : null));
  const chartBD3    = JSON.stringify(hist.map(h => h.dice ? h.dice[2] : null));
  const chartLabels = JSON.stringify(hist.map(h => '#' + String(h.phien).slice(-4)));
  const predJson    = pred ? JSON.stringify({
    winner: pred.winner, winnerFull: fullLabel(pred.winner),
    conf: pred.conf, clarity: pred.clarity,
    pctT: pred.votePct.T, pctX: pred.votePct.X,
    patternName: pred.patternName ?? '—',
    sources: pred.sources,
    streak: streak,
    slope: pred.canvasA ? analyzeSlope(pred.canvasA, 8) : null,
  }) : 'null';

  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tài Xỉu — Chart Engine v5.0</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700&family=Rajdhani:wght@400;600;700&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<style>
:root {
  --bg:        #080c14;
  --bg2:       #0d1220;
  --bg3:       #111826;
  --border:    rgba(64,140,255,0.12);
  --border2:   rgba(64,140,255,0.22);
  --tai:       #00e5a0;
  --xiu:       #ff4f6e;
  --tai-dim:   rgba(0,229,160,0.12);
  --xiu-dim:   rgba(255,79,110,0.12);
  --accent:    #4fc8ff;
  --accent2:   #a78bfa;
  --gold:      #f0b429;
  --text:      #c8d8f0;
  --muted:     #4a5a7a;
  --label:     #2a3a5a;
  --font-mono: 'JetBrains Mono', monospace;
  --font-head: 'Rajdhani', sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:var(--font-mono);min-height:100vh;font-size:13px}

/* scanline overlay */
body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.03) 2px,rgba(0,0,0,0.03) 4px);pointer-events:none;z-index:0}

.wrap{max-width:520px;margin:0 auto;padding:0 0 24px;position:relative;z-index:1}

/* ── HEADER ── */
.hdr{
  background:linear-gradient(180deg,#0f1828 0%,#080c14 100%);
  border-bottom:1px solid var(--border2);
  padding:10px 16px;
  display:flex;align-items:center;justify-content:space-between;
}
.hdr-title{font-family:var(--font-head);font-size:16px;font-weight:700;letter-spacing:2px;color:#fff}
.hdr-title span{color:var(--accent)}
.hdr-sub{font-size:9px;color:var(--muted);letter-spacing:1px}
.live-row{display:flex;align-items:center;gap:6px}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--tai);box-shadow:0 0 8px var(--tai);animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(0.8)}}
.live-txt{font-size:9px;color:var(--tai);letter-spacing:.5px}

/* ── SESSION BAR ── */
.sess-bar{display:flex;align-items:center;justify-content:space-between;padding:7px 14px;border-bottom:1px solid var(--border);background:var(--bg2)}
.sess-l{font-size:10px;color:var(--muted)}
.sess-v{font-family:var(--font-head);font-size:13px;font-weight:700;color:var(--accent)}
.sess-kq{font-family:var(--font-head);font-size:11px;font-weight:700;padding:2px 10px;border-radius:3px}
.sess-kq.tai{background:var(--tai-dim);color:var(--tai);border:1px solid rgba(0,229,160,0.25)}
.sess-kq.xiu{background:var(--xiu-dim);color:var(--xiu);border:1px solid rgba(255,79,110,0.25)}
.dice-inline{display:flex;gap:3px;align-items:center}
.dv{width:18px;height:18px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;font-family:var(--font-head)}

/* ── METRICS ── */
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.mc{background:var(--bg2);padding:8px 6px;text-align:center}
.mc-l{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
.mc-v{font-family:var(--font-head);font-size:17px;font-weight:700;line-height:1}
.mc-s{font-size:8px;color:var(--muted);margin-top:2px}

/* ── CHART CONTAINER ── */
.chart-wrap{padding:10px 10px 4px}
.chart-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.chart-title{font-family:var(--font-head);font-size:11px;font-weight:700;letter-spacing:1px;color:var(--accent);text-transform:uppercase}
.chart-badge{font-size:8px;padding:2px 7px;border-radius:2px;letter-spacing:.5px}
.chart-badge.tai{background:var(--tai-dim);color:var(--tai);border:1px solid rgba(0,229,160,0.2)}
.chart-badge.xiu{background:var(--xiu-dim);color:var(--xiu);border:1px solid rgba(255,79,110,0.2)}
.chart-badge.neu{background:rgba(79,200,255,0.08);color:var(--accent);border:1px solid rgba(79,200,255,0.15)}
.chart-legend{display:flex;gap:10px;align-items:center}
.leg-item{display:flex;align-items:center;gap:4px;font-size:8px;color:var(--muted)}
.leg-dot{width:8px;height:2px;border-radius:1px}
.leg-dashed{width:8px;height:0;border-top:2px dashed;border-radius:1px}

.cbox{
  background:var(--bg3);
  border:1px solid var(--border);
  border-radius:6px;
  padding:8px 6px 6px;
  position:relative;
  overflow:hidden;
}
.cbox::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(15,25,50,0.4) 0%,transparent 30%);
  pointer-events:none;
}

/* chart sub-label */
.chart-sub{font-size:8px;color:var(--label);text-align:right;margin-top:3px;padding-right:4px}

/* ── SR LEGEND ── */
.sr-legend{display:flex;gap:6px;flex-wrap:wrap;padding:4px 4px;margin-top:2px}
.sr-tag{font-size:8px;padding:1px 6px;border-radius:2px;font-family:var(--font-head)}
.sr-res{background:rgba(255,79,110,0.1);color:var(--xiu);border:1px solid rgba(255,79,110,0.2)}
.sr-sup{background:rgba(0,229,160,0.1);color:var(--tai);border:1px solid rgba(0,229,160,0.2)}

/* ── RSI PANEL ── */
.rsi-wrap{margin-top:4px}
.rsi-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}
.rsi-lbl{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.rsi-val{font-size:9px;font-weight:600}

/* ── PREDICTION ── */
.pred-box{
  margin:6px 10px;
  background:var(--bg2);
  border:1px solid var(--border2);
  border-radius:6px;
  padding:12px 14px;
  position:relative;
  overflow:hidden;
}
.pred-box::after{
  content:'';position:absolute;top:0;left:0;right:0;height:2px;
}
.pred-box.tai::after{background:linear-gradient(90deg,transparent,var(--tai),transparent)}
.pred-box.xiu::after{background:linear-gradient(90deg,transparent,var(--xiu),transparent)}
.pred-hdr{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.pred-hdr::after{content:'';flex:1;height:1px;background:var(--border)}
.pred-main-row{display:flex;align-items:center;justify-content:space-between}
.pred-label{font-family:var(--font-head);font-size:46px;font-weight:700;line-height:1;letter-spacing:1px}
.pred-label.tai{color:var(--tai);text-shadow:0 0 30px rgba(0,229,160,0.3)}
.pred-label.xiu{color:var(--xiu);text-shadow:0 0 30px rgba(255,79,110,0.3)}
.pred-details{flex:1;padding-left:14px}
.pred-pct-row{display:flex;gap:8px;margin-bottom:4px}
.pred-pct-bar{flex:1}
.pct-lbl{font-size:8px;color:var(--muted);margin-bottom:2px;display:flex;justify-content:space-between}
.pct-track{height:4px;background:var(--bg3);border-radius:2px;overflow:hidden}
.pct-fill-t{height:4px;background:var(--tai);border-radius:2px;transition:width .3s}
.pct-fill-x{height:4px;background:var(--xiu);border-radius:2px;transition:width .3s}
.pred-pattern{font-size:9px;color:var(--accent2);margin-top:5px;line-height:1.4}
.pred-streak{font-size:9px;margin-top:4px;padding:3px 8px;border-radius:3px;display:inline-block}
.pred-streak.warn{background:rgba(240,180,41,0.1);color:var(--gold);border:1px solid rgba(240,180,41,0.2)}
.pred-streak.safe{background:var(--tai-dim);color:var(--tai);border:1px solid rgba(0,229,160,0.2)}

/* ── CONF RING ── */
.conf-wrap{flex-shrink:0;text-align:center}
.conf-ring{position:relative;width:80px;height:80px;display:inline-block}
.conf-ring canvas{position:absolute;top:0;left:0}
.conf-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.conf-pct{font-family:var(--font-head);font-size:20px;font-weight:700;line-height:1}
.conf-lbl{font-size:8px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:.5px}

/* ── SIGNALS ── */
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:5px 10px}
.sig{background:var(--bg2);border:1px solid var(--border);border-radius:5px;padding:7px 9px;position:relative;overflow:hidden}
.sig::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px}
.sig.tai::before{background:var(--tai)}
.sig.xiu::before{background:var(--xiu)}
.sig.neu::before{background:var(--muted)}
.sig-name{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.sig-bias{font-family:var(--font-head);font-size:13px;font-weight:700;line-height:1}
.sig-bias.tai{color:var(--tai)}.sig-bias.xiu{color:var(--xiu)}.sig-bias.neu{color:var(--muted)}
.sig-detail{font-size:9px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sig-w{font-size:8px;color:var(--label);margin-top:2px}

/* ── WEIGHT BARS ── */
.wbars{margin:5px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;padding:8px 10px}
.wbar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.wbar-row:last-child{margin-bottom:0}
.wbar-name{font-size:8px;color:var(--muted);width:72px;flex-shrink:0;text-transform:uppercase;letter-spacing:.3px}
.wbar-track{flex:1;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden}
.wbar-fill{height:5px;border-radius:3px}
.wbar-v{font-size:9px;width:40px;text-align:right;flex-shrink:0;font-family:var(--font-head);font-weight:600}

/* ── HISTORY ── */
.hist-box{margin:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;overflow:hidden}
.hist-hdr{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;padding:7px 10px;border-bottom:1px solid var(--border);background:var(--bg3)}
.hist-table{width:100%;border-collapse:collapse}
.hist-table td{padding:4px 8px;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.03)}
.hist-table tr:last-child td{border-bottom:none}
.hist-table tr:hover td{background:rgba(79,200,255,0.03)}
.kq-chip{display:inline-block;padding:1px 7px;border-radius:2px;font-family:var(--font-head);font-size:10px;font-weight:700}
.kq-chip.tai{background:var(--tai-dim);color:var(--tai);border:1px solid rgba(0,229,160,0.2)}
.kq-chip.xiu{background:var(--xiu-dim);color:var(--xiu);border:1px solid rgba(255,79,110,0.2)}
.pnum{color:var(--muted);font-size:9px}
.dset{display:flex;gap:2px}
.dk{width:16px;height:16px;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;font-family:var(--font-head)}

/* ── PATTERN 50 ── */
.pat-section{padding:6px 10px}
.pat-lbl{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.pat-grid{display:flex;flex-wrap:wrap;gap:2px}
.pb{width:16px;height:16px;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;font-family:var(--font-head)}
.pb-t{background:var(--tai-dim);color:var(--tai);border:1px solid rgba(0,229,160,0.15)}
.pb-x{background:var(--xiu-dim);color:var(--xiu);border:1px solid rgba(255,79,110,0.15)}
.pat-stats{display:flex;gap:16px;padding:5px 0 0;font-size:10px}

/* ── BTNS ── */
.btns{display:flex;gap:6px;padding:10px 10px 0}
.gbtn{
  flex:1;padding:10px 8px;border-radius:4px;border:none;
  font-family:var(--font-head);font-size:12px;font-weight:700;letter-spacing:1px;
  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;
  transition:opacity .12s,transform .12s;
  text-transform:uppercase;
}
.gbtn:active{opacity:.7;transform:scale(0.97)}
.gbtn-t{background:linear-gradient(180deg,#00c888,#008855);color:#fff;border:1px solid rgba(0,229,160,0.4)}
.gbtn-g{background:linear-gradient(180deg,#c88800,#886600);color:#fff;border:1px solid rgba(240,180,41,0.4)}
.gbtn-x{background:linear-gradient(180deg,#cc3050,#881030);color:#fff;border:1px solid rgba(255,79,110,0.4)}

/* ── FOOTER ── */
.footer{text-align:center;font-size:8px;color:var(--label);padding:10px 0 0;display:flex;justify-content:center;gap:14px}
.footer a{color:var(--muted);text-decoration:none;transition:color .2s}
.footer a:hover{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">

<!-- HEADER -->
<div class="hdr">
  <div>
    <div class="hdr-title"><span>TX</span> CHART ENGINE</div>
    <div class="hdr-sub">VIRTUAL ANALYSIS · V5.0 · @SEWDANGCAP</div>
  </div>
  <div class="live-row">
    <div class="live-dot"></div>
    <div class="live-txt">LIVE</div>
  </div>
</div>

<!-- SESSION BAR -->
<div class="sess-bar">
  <div>
    <div class="sess-l">PHIÊN GẦN NHẤT</div>
    <div class="sess-v">#${latest.phien}</div>
  </div>
  <div class="dice-inline">
    ${latest.dice ? ['#c0281e','#b08900','#6b28b0'].map((c,i)=>`<div class="dv" style="background:${c}">${latest.dice[i]}</div>`).join('') : `<span style="color:var(--muted)">${latest.tong}</span>`}
  </div>
  <div class="sess-kq ${latest.kq==='T'?'tai':'xiu'}">${latest.kq==='T'?'TÀI':'XỈU'} ${latest.tong}</div>
</div>

<!-- METRICS -->
<div class="metrics">
  <div class="mc">
    <div class="mc-l">Kết quả</div>
    <div class="mc-v" style="color:${latest.kq==='T'?'var(--tai)':'var(--xiu)'}">${latest.kq==='T'?'TÀI':'XỈU'}</div>
    <div class="mc-s">${latest.tong}/18</div>
  </div>
  <div class="mc">
    <div class="mc-l">Dự đoán</div>
    <div class="mc-v" style="color:${pred?(pred.winner==='T'?'var(--tai)':'var(--xiu)'):'var(--muted)'}">${pred?fullLabel(pred.winner):'...'}</div>
    <div class="mc-s">#${nxtPhien.slice(-5)}</div>
  </div>
  <div class="mc">
    <div class="mc-l">Tài / Xỉu</div>
    <div class="mc-v"><span style="color:var(--tai)">${taiCount50}</span><span style="color:var(--muted);font-size:11px">/</span><span style="color:var(--xiu)">${xiuCount50}</span></div>
    <div class="mc-s">50 phiên</div>
  </div>
  <div class="mc">
    <div class="mc-l">Win Rate</div>
    <div class="mc-v" style="color:var(--gold)">${wr}</div>
    <div class="mc-s">${recentWL.length}p theo dõi</div>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- CHART A: Tổng + BB + SMA + EMA            -->
<!-- ═══════════════════════════════════════════ -->
<div class="chart-wrap">
  <div class="chart-header">
    <div class="chart-title">Chart A — Tổng</div>
    <div class="chart-legend">
      <div class="leg-item"><div class="leg-dot" style="background:var(--accent);height:2px"></div>EMA14</div>
      <div class="leg-item"><div class="leg-dot" style="background:var(--gold);height:2px"></div>SMA7</div>
      <div class="leg-item"><div class="leg-dashed" style="border-color:rgba(167,139,250,0.5)"></div>BB</div>
    </div>
  </div>
  <div class="cbox">
    <div style="position:relative;height:200px"><canvas id="cvA"></canvas></div>
  </div>
  <!-- SR zones -->
  <div class="sr-legend" id="srLegend"></div>
  <div class="chart-sub">Bollinger Bands 14×2σ · SMA7 · EMA14 · Đường vàng: Tài/Xỉu ranh giới</div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- CHART A2: RSI                              -->
<!-- ═══════════════════════════════════════════ -->
<div class="chart-wrap" style="padding-top:0">
  <div class="rsi-wrap">
    <div class="rsi-header">
      <div class="rsi-lbl">RSI(10) Oscillator</div>
      <div class="rsi-val" id="rsiCurrent" style="color:var(--accent)"></div>
    </div>
    <div class="cbox">
      <div style="position:relative;height:70px"><canvas id="cvRSI"></canvas></div>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════ -->
<!-- CHART B: 3 Xúc Xắc                        -->
<!-- ═══════════════════════════════════════════ -->
<div class="chart-wrap" style="padding-top:2px">
  <div class="chart-header">
    <div class="chart-title">Chart B — 3 Xúc Xắc</div>
    <div class="chart-legend">
      <div class="leg-item"><div class="leg-dot" style="background:#e85060"></div>D1</div>
      <div class="leg-item"><div class="leg-dot" style="background:#d4a020"></div>D2</div>
      <div class="leg-item"><div class="leg-dot" style="background:#9050d0"></div>D3</div>
    </div>
  </div>
  <div class="cbox">
    <div style="position:relative;height:170px"><canvas id="cvB"></canvas></div>
  </div>
  <!-- Heatmap -->
  <div style="margin-top:4px;display:flex;gap:1px" id="diceHeat"></div>
  <div class="chart-sub">Màu nền: Xanh = Tài · Đỏ = Xỉu</div>
</div>

<!-- PREDICTION BOX -->
${pred ? `
<div class="pred-box ${pred.winner==='T'?'tai':'xiu'}">
  <div class="pred-hdr">DỰ ĐOÁN PHIÊN #${nxtPhien.slice(-5)}</div>
  <div class="pred-main-row">
    <div class="pred-label ${pred.winner==='T'?'tai':'xiu'}">${fullLabel(pred.winner)}</div>
    <div class="pred-details">
      <div class="pred-pct-row">
        <div class="pred-pct-bar">
          <div class="pct-lbl"><span style="color:var(--tai)">TÀI</span><span>${pred.votePct.T}</span></div>
          <div class="pct-track"><div class="pct-fill-t" style="width:${pred.votePct.T}"></div></div>
        </div>
        <div class="pred-pct-bar">
          <div class="pct-lbl"><span style="color:var(--xiu)">XỈU</span><span>${pred.votePct.X}</span></div>
          <div class="pct-track"><div class="pct-fill-x" style="width:${pred.votePct.X}"></div></div>
        </div>
      </div>
      <div class="pred-pattern">📐 ${pred.patternName ?? '—'}</div>
      ${streak?.streakDetail ? `<div class="pred-streak ${streak.streakLen>=3?'warn':'safe'}">⚡ ${streak.streakDetail}</div>` : ''}
    </div>
    <div class="conf-wrap">
      <div class="conf-ring">
        <canvas id="cvConf" width="80" height="80"></canvas>
        <div class="conf-center">
          <span class="conf-pct" style="color:${pred.winner==='T'?'var(--tai)':'var(--xiu)'}">${pred.conf}%</span>
          <span class="conf-lbl">${pred.clarity}</span>
        </div>
      </div>
    </div>
  </div>
</div>` : `<div class="pred-box" style="text-align:center;padding:1.5rem;color:var(--muted)">⏳ Đang phân tích...</div>`}

<!-- SIGNALS GRID -->
<div class="sigs">
  ${(pred?.sources ?? []).map(s=>`
  <div class="sig ${s.bias==='T'?'tai':s.bias==='X'?'xiu':'neu'}">
    <div class="sig-name">${s.name}</div>
    <div class="sig-bias ${s.bias==='T'?'tai':s.bias==='X'?'xiu':'neu'}">${s.biasFull??'—'}</div>
    <div class="sig-detail">${s.detail}</div>
    <div class="sig-w">W: ${s.weight}</div>
  </div>`).join('')}
</div>

<!-- WEIGHT BARS -->
<div class="wbars">
  <div style="font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Trọng số Ensemble</div>
  ${(pred?.sources ?? []).map(s=>{
    const pct = Math.round(s.weight / (pred?.sources??[]).reduce((a,b)=>a+b.weight,0) * 100);
    const col = s.bias==='T'?'var(--tai)':s.bias==='X'?'var(--xiu)':'var(--muted)';
    return `<div class="wbar-row">
      <div class="wbar-name">${s.name}</div>
      <div class="wbar-track"><div class="wbar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="wbar-v" style="color:${col}">${pct}%</div>
    </div>`;
  }).join('')}
</div>

<!-- HISTORY TABLE -->
<div class="hist-box">
  <div class="hist-hdr">LỊCH SỬ 15 PHIÊN GẦN NHẤT</div>
  <table class="hist-table">
    <tr style="background:var(--bg3)">
      <td style="color:var(--muted);font-size:8px;padding:4px 8px">PHIÊN</td>
      <td style="color:var(--muted);font-size:8px">KẾT QUẢ</td>
      <td style="color:var(--muted);font-size:8px">XÚC XẮC</td>
      <td style="color:var(--muted);font-size:8px;text-align:right">TỔNG</td>
    </tr>
    ${history.slice(-15).reverse().map(h=>`
    <tr>
      <td class="pnum">#${String(h.phien).slice(-5)}</td>
      <td><span class="kq-chip ${h.kq==='T'?'tai':'xiu'}">${fullLabel(h.kq)}</span></td>
      <td><div class="dset">${h.dice?['#c0281e','#b08900','#6b28b0'].map((c,i)=>`<div class="dk" style="background:${c}">${h.dice[i]}</div>`).join(''):'–'}</div></td>
      <td style="font-weight:700;text-align:right;color:${h.kq==='T'?'var(--tai)':'var(--xiu)'}">${h.tong}</td>
    </tr>`).join('')}
  </table>
</div>

<!-- PATTERN 50 -->
<div class="pat-section">
  <div class="pat-lbl">Chuỗi 50 phiên gần nhất</div>
  <div class="pat-grid">
    ${pattern50.split('').map(c=>`<span class="pb ${c==='T'?'pb-t':'pb-x'}">${c}</span>`).join('')}
  </div>
  <div class="pat-stats">
    <span style="color:var(--tai);font-weight:700">T: ${taiCount50}</span>
    <span style="color:var(--muted)">|</span>
    <span style="color:var(--xiu);font-weight:700">X: ${xiuCount50}</span>
    <span style="color:var(--muted)">|</span>
    <span style="color:var(--muted)">${((taiCount50/Math.max(1,taiCount50+xiuCount50))*100).toFixed(0)}% Tài</span>
  </div>
</div>

<!-- BUTTONS -->
<div class="btns">
  <button class="gbtn gbtn-t">▲ TÀI</button>
  <button class="gbtn gbtn-g">⚡ PHÂN TÍCH</button>
  <button class="gbtn gbtn-x">▼ XỈU</button>
</div>

<!-- FOOTER -->
<div class="footer">
  <span>Chart Engine v5.0 · @sewdangcap</span>
  <a href="/sunlon">API</a>
  <a href="/signals">Signals</a>
  <a href="/thongke">Thống kê</a>
  <a href="/history">History</a>
</div>

</div><!-- /wrap -->

<script>
Chart.register(window['chartjs-plugin-annotation']);

const DATA_A    = ${chartAData};
const BB_UPPER  = ${bbUpper};
const BB_MID    = ${bbMiddle};
const BB_LOWER  = ${bbLower};
const SMA7_D    = ${sma7Data};
const EMA14_D   = ${ema14Data};
const RSI_D     = ${rsiData};
const SR_ZONES  = ${srZones};
const DATA_B1   = ${chartBD1};
const DATA_B2   = ${chartBD2};
const DATA_B3   = ${chartBD3};
const LABELS    = ${chartLabels};
const PRED      = ${predJson};
const TAI_LINE  = ${CFG.TAI_LINE};

// ── Colors ──
const C_TAI  = '#00e5a0';
const C_XIU  = '#ff4f6e';
const C_ACC  = '#4fc8ff';
const C_GOLD = '#f0b429';
const C_PRP  = '#a78bfa';

// ── Point colors for Chart A ──
const ptColor  = DATA_A.map(v => v===null?'rgba(255,255,255,.15)':v>=TAI_LINE?C_TAI:C_XIU);
const ptBorder = DATA_A.map(v => v>=TAI_LINE?'rgba(0,229,160,0.4)':'rgba(255,79,110,0.4)');
const ptSize   = DATA_A.map((_,i) => i===DATA_A.length-1 ? 9 : 4);
const ptStyle  = DATA_A.map((_,i) => i===DATA_A.length-1 ? 'rectRot' : 'circle');

// ── Build S/R annotation ──
function buildSRAnnotations() {
  const ann = {};
  SR_ZONES.forEach((z, i) => {
    ann['sr'+i] = {
      type: 'line',
      yMin: z.level, yMax: z.level,
      borderColor: z.type==='resistance' ? 'rgba(255,79,110,0.35)' : 'rgba(0,229,160,0.35)',
      borderWidth: 1,
      borderDash: [4, 3],
      label: {
        display: true,
        content: z.level + (z.type==='resistance'?' R':' S') + '×'+z.touches,
        position: 'end',
        color: z.type==='resistance' ? C_XIU : C_TAI,
        font: { size: 8, family: 'JetBrains Mono' },
        backgroundColor: 'rgba(8,12,20,0.85)',
        padding: { x: 4, y: 2 },
        yAdjust: z.type==='resistance' ? -10 : 10,
      }
    };
  });
  // Tai/Xiu line
  ann['taiLine'] = {
    type: 'line',
    yMin: TAI_LINE, yMax: TAI_LINE,
    borderColor: 'rgba(240,180,41,0.4)',
    borderWidth: 1.5,
    borderDash: [6,4],
    label: {
      display: true,
      content: 'TÀI ≥ ' + TAI_LINE,
      position: 'start',
      color: C_GOLD,
      font: { size: 8, family: 'JetBrains Mono' },
      backgroundColor: 'rgba(8,12,20,0.85)',
      padding: { x: 4, y: 2 },
    }
  };
  return ann;
}

// ── Chart A ──
new Chart(document.getElementById('cvA'), {
  type: 'line',
  data: {
    labels: LABELS,
    datasets: [
      // BB Upper
      {
        data: BB_UPPER,
        borderColor: 'rgba(167,139,250,0.4)',
        backgroundColor: 'rgba(167,139,250,0.04)',
        borderWidth: 1,
        borderDash: [3, 2],
        pointRadius: 0,
        fill: '+2',
        tension: 0.3,
        order: 4,
      },
      // BB Middle (SMA14)
      {
        data: BB_MID,
        borderColor: 'rgba(167,139,250,0.6)',
        borderWidth: 1,
        borderDash: [4, 3],
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 3,
      },
      // BB Lower
      {
        data: BB_LOWER,
        borderColor: 'rgba(167,139,250,0.4)',
        backgroundColor: 'rgba(167,139,250,0.04)',
        borderWidth: 1,
        borderDash: [3, 2],
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 4,
      },
      // SMA7
      {
        data: SMA7_D,
        borderColor: 'rgba(240,180,41,0.7)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 2,
      },
      // EMA14
      {
        data: EMA14_D,
        borderColor: 'rgba(79,200,255,0.8)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 1,
      },
      // Main line
      {
        data: DATA_A,
        borderColor: 'rgba(220,230,255,0.75)',
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 200);
          g.addColorStop(0, 'rgba(0,229,160,0.12)');
          g.addColorStop(0.5, 'rgba(79,200,255,0.04)');
          g.addColorStop(1, 'rgba(255,79,110,0.08)');
          return g;
        },
        borderWidth: 2,
        pointBackgroundColor: ptColor,
        pointBorderColor: ptBorder,
        pointBorderWidth: 2,
        pointRadius: ptSize,
        pointStyle: ptStyle,
        pointHoverRadius: 10,
        tension: 0.28,
        fill: true,
        order: 0,
      },
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(8,12,20,0.95)',
        titleColor: '#4fc8ff',
        bodyColor: '#c8d8f0',
        borderColor: 'rgba(64,140,255,0.2)',
        borderWidth: 1,
        titleFont: { family: 'JetBrains Mono', size: 9 },
        bodyFont: { family: 'JetBrains Mono', size: 9 },
        callbacks: {
          title: items => 'Phiên ' + LABELS[items[0].dataIndex],
          label: ctx => {
            const labels = ['BB Upper','BB Mid','BB Lower','SMA7','EMA14','Tổng'];
            const v = ctx.parsed.y;
            if (v === null) return null;
            if (ctx.datasetIndex === 5) return \`\${labels[ctx.datasetIndex]}: \${v} — \${v>=TAI_LINE?'TÀI':'XỈU'}\`;
            return \`\${labels[ctx.datasetIndex]}: \${v}\`;
          }
        }
      },
      annotation: {
        annotations: buildSRAnnotations()
      }
    },
    scales: {
      x: {
        ticks: { font: { size: 7, family: 'JetBrains Mono' }, color: 'rgba(74,90,122,0.8)', maxTicksLimit: 10, maxRotation: 0 },
        grid: { color: 'rgba(30,45,80,0.6)', lineWidth: 1 },
        border: { color: 'rgba(30,45,80,0.8)' },
      },
      y: {
        min: 2, max: 19,
        ticks: {
          font: { size: 8, family: 'JetBrains Mono' }, color: 'rgba(74,90,122,0.9)', stepSize: 3,
          callback: v => v === TAI_LINE ? v + '─' : v
        },
        grid: {
          color: ctx => ctx.tick.value === TAI_LINE ? 'rgba(240,180,41,0.2)' : 'rgba(30,45,80,0.5)',
          lineWidth: ctx => ctx.tick.value === TAI_LINE ? 1.5 : 1,
        },
        border: { color: 'rgba(30,45,80,0.8)' },
      },
    }
  }
});

// ── SR Legend ──
const srEl = document.getElementById('srLegend');
if (srEl) {
  SR_ZONES.forEach(z => {
    const tag = document.createElement('span');
    tag.className = 'sr-tag ' + (z.type==='resistance'?'sr-res':'sr-sup');
    tag.textContent = (z.type==='resistance'?'R':'S') + ' ' + z.level + ' ×' + z.touches;
    srEl.appendChild(tag);
  });
}

// ── Chart RSI ──
const rsiCurrent = RSI_D.filter(v=>v!==null).slice(-1)[0];
const rsiEl = document.getElementById('rsiCurrent');
if (rsiEl && rsiCurrent !== undefined) {
  const col = rsiCurrent > 70 ? C_XIU : rsiCurrent < 30 ? C_TAI : C_ACC;
  rsiEl.textContent = 'RSI ' + rsiCurrent + (rsiCurrent>70?' OB':rsiCurrent<30?' OS':'');
  rsiEl.style.color = col;
}

new Chart(document.getElementById('cvRSI'), {
  type: 'line',
  data: {
    labels: LABELS,
    datasets: [{
      data: RSI_D,
      borderColor: RSI_D.map(v => v===null?'transparent':v>70?C_XIU:v<30?C_TAI:C_ACC),
      backgroundColor: ctx => {
        const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 70);
        g.addColorStop(0, 'rgba(79,200,255,0.15)');
        g.addColorStop(1, 'rgba(79,200,255,0.01)');
        return g;
      },
      borderWidth: 1.5,
      pointRadius: RSI_D.map((v,i) => {
        if (v===null) return 0;
        if (i===RSI_D.length-1) return 5;
        return v>70||v<30 ? 3 : 0;
      }),
      pointBackgroundColor: RSI_D.map(v => v>70?C_XIU:v<30?C_TAI:C_ACC),
      fill: true,
      tension: 0.4,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(8,12,20,0.95)',
        bodyColor: '#c8d8f0',
        borderColor: 'rgba(64,140,255,0.2)',
        borderWidth: 1,
        bodyFont: { family: 'JetBrains Mono', size: 9 },
        callbacks: { label: c => 'RSI: ' + c.parsed.y }
      },
      annotation: {
        annotations: {
          ob: { type:'line', yMin:70, yMax:70, borderColor:'rgba(255,79,110,0.35)', borderWidth:1, borderDash:[3,2],
                label:{display:true,content:'OB 70',position:'end',color:C_XIU,font:{size:7,family:'JetBrains Mono'},backgroundColor:'rgba(8,12,20,0.85)',padding:{x:3,y:1}} },
          os: { type:'line', yMin:30, yMax:30, borderColor:'rgba(0,229,160,0.35)', borderWidth:1, borderDash:[3,2],
                label:{display:true,content:'OS 30',position:'end',color:C_TAI,font:{size:7,family:'JetBrains Mono'},backgroundColor:'rgba(8,12,20,0.85)',padding:{x:3,y:1}} },
          mid: { type:'line', yMin:50, yMax:50, borderColor:'rgba(79,200,255,0.15)', borderWidth:1, borderDash:[2,4] },
        }
      }
    },
    scales: {
      x: { display: false },
      y: {
        min: 0, max: 100,
        ticks: { font:{size:7,family:'JetBrains Mono'}, color:'rgba(74,90,122,0.8)', stepSize:25,
                 callback: v => v===70?'OB':v===30?'OS':v===50?'50':'' },
        grid: { color:'rgba(30,45,80,0.4)' },
        border: { color:'rgba(30,45,80,0.8)' },
      }
    }
  }
});

// ── Chart B (3 Dice) ──
// Detect divergence points: where dice move in opposite directions
const divPoints = DATA_B1.map((v, i) => {
  if (i===0||v===null||DATA_B2[i]===null||DATA_B3[i]===null) return null;
  if (DATA_B1[i-1]===null) return null;
  const d1 = Math.sign(DATA_B1[i]-DATA_B1[i-1]);
  const d2 = Math.sign(DATA_B2[i]-DATA_B2[i-1]);
  const d3 = Math.sign(DATA_B3[i]-DATA_B3[i-1]);
  const allSame = d1===d2 && d2===d3 && d1!==0;
  return allSame ? DATA_A[i] : null; // convergence point
});

new Chart(document.getElementById('cvB'), {
  type: 'line',
  data: {
    labels: LABELS,
    datasets: [
      {
        label: 'D1', data: DATA_B1,
        borderColor: '#d04050',
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0,0,0,170);
          g.addColorStop(0,'rgba(208,64,80,0.18)');
          g.addColorStop(1,'rgba(208,64,80,0.01)');
          return g;
        },
        borderWidth: 2,
        pointBackgroundColor: DATA_B1.map((v,i)=>{
          if (i===DATA_B1.length-1) return '#d04050';
          if (DATA_B2[i]!==null&&DATA_B3[i]!==null&&DATA_B1[i]===DATA_B2[i]&&DATA_B2[i]===DATA_B3[i]) return '#fff';
          return '#d04050';
        }),
        pointRadius: DATA_B1.map((v,i)=>{
          if (i===DATA_B1.length-1) return 7;
          if (DATA_B2[i]!==null&&DATA_B3[i]!==null&&DATA_B1[i]===DATA_B2[i]&&DATA_B2[i]===DATA_B3[i]) return 7;
          return 3;
        }),
        pointBorderColor: 'rgba(208,64,80,0.4)',
        pointBorderWidth: 2,
        tension: 0.35, fill: true,
      },
      {
        label: 'D2', data: DATA_B2,
        borderColor: '#c8a000',
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0,0,0,170);
          g.addColorStop(0,'rgba(200,160,0,0.12)');
          g.addColorStop(1,'rgba(200,160,0,0.01)');
          return g;
        },
        borderWidth: 2,
        pointBackgroundColor: '#c8a000',
        pointBorderColor: 'rgba(200,160,0,0.4)',
        pointBorderWidth: 2,
        pointRadius: DATA_B2.map((_,i)=>i===DATA_B2.length-1?7:3),
        tension: 0.35, fill: false,
      },
      {
        label: 'D3', data: DATA_B3,
        borderColor: '#8840c0',
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0,0,0,170);
          g.addColorStop(0,'rgba(136,64,192,0.12)');
          g.addColorStop(1,'rgba(136,64,192,0.01)');
          return g;
        },
        borderWidth: 2,
        pointBackgroundColor: '#8840c0',
        pointBorderColor: 'rgba(136,64,192,0.4)',
        pointBorderWidth: 2,
        pointRadius: DATA_B3.map((_,i)=>i===DATA_B3.length-1?7:3),
        tension: 0.35, fill: false,
      },
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(8,12,20,0.95)',
        titleColor: C_ACC,
        bodyColor: '#c8d8f0',
        borderColor: 'rgba(64,140,255,0.2)',
        borderWidth: 1,
        titleFont: { family: 'JetBrains Mono', size: 9 },
        bodyFont: { family: 'JetBrains Mono', size: 9 },
        callbacks: {
          title: items => 'Phiên ' + LABELS[items[0].dataIndex],
          label: ctx => ['D1','D2','D3'][ctx.datasetIndex] + ': ' + ctx.parsed.y,
          afterBody: items => {
            const i = items[0].dataIndex;
            const s = (DATA_B1[i]||0)+(DATA_B2[i]||0)+(DATA_B3[i]||0);
            return ['Tổng: ' + s + ' — ' + (s>=11?'TÀI':'XỈU')];
          }
        }
      },
      annotation: {
        annotations: {
          // Average line
          avg: {
            type: 'line', yMin: 3.5, yMax: 3.5,
            borderColor: 'rgba(79,200,255,0.2)', borderWidth: 1, borderDash: [3,3],
            label: { display:true, content:'AVG 3.5', position:'start', color: C_ACC,
                     font:{size:7,family:'JetBrains Mono'}, backgroundColor:'rgba(8,12,20,0.85)', padding:{x:3,y:1} }
          }
        }
      }
    },
    scales: {
      x: {
        ticks: { font:{size:7,family:'JetBrains Mono'}, color:'rgba(74,90,122,0.8)', maxTicksLimit:10, maxRotation:0 },
        grid: { color:'rgba(30,45,80,0.5)' },
        border: { color:'rgba(30,45,80,0.8)' },
      },
      y: {
        min: 0, max: 7,
        ticks: { font:{size:8,family:'JetBrains Mono'}, color:'rgba(74,90,122,0.9)', stepSize:1,
                 callback: v => v===0?'':v },
        grid: { color:'rgba(30,45,80,0.5)' },
        border: { color:'rgba(30,45,80,0.8)' },
      }
    }
  }
});

// ── Dice Heatmap ──
const heatEl = document.getElementById('diceHeat');
if (heatEl) {
  const last30 = DATA_A.slice(-30);
  last30.forEach((v, i) => {
    const el = document.createElement('div');
    el.style.cssText = 'flex:1;height:12px;border-radius:1px;';
    if (v===null) { el.style.background='rgba(255,255,255,0.03)'; }
    else if (v>=TAI_LINE) { el.style.background='rgba(0,229,160,'+(0.15+((v-11)/7)*0.5)+')'; }
    else { el.style.background='rgba(255,79,110,'+(0.15+((11-v)/8)*0.5)+')'; }
    el.title = v!==null ? (v>=TAI_LINE?'TÀI':'XỈU')+' '+v : '?';
    heatEl.appendChild(el);
  });
}

// ── Confidence Ring ──
if (PRED) {
  const cv = document.getElementById('cvConf');
  if (cv) {
    const ctx = cv.getContext('2d');
    const col = PRED.winner==='T' ? C_TAI : C_XIU;
    const pct = PRED.conf/100;
    const cx=40, cy=40, r=30;
    ctx.clearRect(0,0,80,80);
    // Track
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=6; ctx.stroke();
    // Glow
    ctx.shadowBlur=12; ctx.shadowColor=col;
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+Math.PI*2*pct);
    ctx.strokeStyle=col; ctx.lineWidth=6; ctx.lineCap='round'; ctx.stroke();
    ctx.shadowBlur=0;
    // Tick marks
    for(let t=0;t<12;t++){
      const a=-Math.PI/2+t/12*Math.PI*2;
      const r1=28, r2=32;
      ctx.beginPath();
      ctx.moveTo(cx+Math.cos(a)*r1, cy+Math.sin(a)*r1);
      ctx.lineTo(cx+Math.cos(a)*r2, cy+Math.sin(a)*r2);
      ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1; ctx.stroke();
    }
  }
}

// ── Auto reload ──
setTimeout(()=>location.reload(), ${CFG.POLL_MS});
</script>
</body>
</html>`);
});

// ════════════════════════════════════════════════════════════════
//  /sunlon
// ════════════════════════════════════════════════════════════════
app.get('/sunlon', async (req, res) => {
  if (!latestResult) {
    const d = await fetchAndUpdate();
    if (!d) return res.status(503).json({ error: 'Đang khởi động, thử lại sau...' });
  }
  res.json(latestResult);
});
app.get('/api/sunlon', async (req, res) => {
  if (!latestResult) {
    const d = await fetchAndUpdate();
    if (!d) return res.status(503).json({ error: 'Đang khởi động, thử lại sau...' });
  }
  res.json(latestResult);
});

// ════════════════════════════════════════════════════════════════
//  /canvas
// ════════════════════════════════════════════════════════════════
app.get('/canvas', (req, res) => {
  if (history.length < CFG.MIN_HIST)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const slice  = history.slice(-CFG.CANVAS_W);
  const phiens = slice.map(h => Number(h.phien));
  const tongArr = slice.map(h => h.tong);
  const bb = calcBollingerBands(tongArr, 14, 2);
  res.json({
    id: '@sewdangcap',
    canvas_width: slice.length,
    chart_A: {
      mo_ta: 'Đường Tổng + Bollinger Bands + SMA7 + EMA14 + RSI10',
      y_min: 3, y_max: 18,
      data: phiens.map((p, i) => ({
        phien: p, tong: slice[i].tong, kq: fullLabel(slice[i].kq),
        bb_upper: bb[i].upper, bb_mid: bb[i].middle, bb_lower: bb[i].lower,
        sma7: calcSMA(tongArr, 7)[i],
        ema14: calcEMA(tongArr, 14)[i],
        rsi10: calcRSI(tongArr, 10)[i],
      })),
    },
    chart_B: {
      mo_ta: '3 Đường Xúc Xắc — Đỏ/Vàng/Tím — trục Y: 1–6',
      y_min: 1, y_max: 6,
      data: phiens.map((p, i) => ({
        phien: p,
        d1: slice[i].dice?.[0] ?? null,
        d2: slice[i].dice?.[1] ?? null,
        d3: slice[i].dice?.[2] ?? null,
      })),
    },
    sr_zones: detectSR(tongArr, 2).zones,
  });
});

// ════════════════════════════════════════════════════════════════
//  /signals
// ════════════════════════════════════════════════════════════════
app.get('/signals', (req, res) => {
  if (history.length < CFG.MIN_HIST)
    return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const slice   = history.slice(-CFG.CANVAS_W);
  const canvasA = slice.map(h => h.tong);
  const pattern = scanPattern(canvasA);
  const slope   = analyzeSlope(canvasA, 8);
  const sr      = detectSR(canvasA, 2);
  const dice    = analyzeDice(slice, 8);
  const streak  = analyzeStreak(slice);
  const ens     = ensembleVote({ pattern, slope, sr, dice, streak });
  const rsi     = calcRSI(canvasA, 10);
  const lastRSI = rsi.filter(v=>v!==null).slice(-1)[0];
  res.json({
    id: '@sewdangcap',
    ket_luan: ens ? { du_doan: fullLabel(ens.winner), do_tin_cay: `${ens.conf}%`, muc_do: ens.clarity,
                      ty_le: ens.votePct } : null,
    tin_hieu: {
      chart_A_pattern: pattern
        ? { ten: pattern.name, bias: fullLabel(pattern.bias), suc_manh: +pattern.strength.toFixed(2) }
        : { ten: 'Không nhận diện', bias: null },
      chart_A_slope: slope
        ? { slope: slope.slope, lastVal: slope.last, projNext: slope.proj, bias: fullLabel(slope.slopeBias), chi_tiet: slope.detail }
        : { chi_tiet: 'Không đủ dữ liệu' },
      chart_A_sr: { bias: fullLabel(sr.srBias), chi_tiet: sr.srDetail, zones: sr.zones },
      chart_A_rsi: { value: lastRSI, signal: lastRSI>70?'Overbought→Xỉu':lastRSI<30?'Oversold→Tài':'Trung lập' },
      chart_B_dice: { bias: fullLabel(dice.diceBias), chi_tiet: dice.diceDetail, conv: `${dice.convScore}/3` },
      streak_tam_ly: { bias: fullLabel(streak.streakBias), chi_tiet: streak.streakDetail,
                       do_dai_cau: streak.streakLen, suc_manh: streak.strength },
    },
    nguon_bieu_quyet: ens?.sources ?? [],
    trong_so: {
      'Pattern': CFG.W_PATTERN, 'Slope': CFG.W_SLOPE,
      'SR': CFG.W_SR, 'Dice': CFG.W_DICE, 'Streak': CFG.W_STREAK,
    },
  });
});

// ════════════════════════════════════════════════════════════════
//  /thongke
// ════════════════════════════════════════════════════════════════
app.get('/thongke', (req, res) => {
  const slice = winLoss.slice(-50).reverse();
  const wins  = slice.filter(r => r.win).length;
  const rate  = slice.length ? Math.round(wins/slice.length*100) : 0;
  let streak = 0, st = null;
  for (const r of slice) { if (st===null){st=r.win;streak=1;} else if(r.win===st)streak++; else break; }
  res.json({
    id: '@sewdangcap',
    tong_quan: {
      tong_phien: slice.length, thang: wins, thua: slice.length - wins,
      win_rate: `${rate}%`,
      streak: streak > 0 ? `${streak} ${st?'THẮNG':'THUA'} liên tiếp` : 'Chưa có',
    },
    chi_tiet: slice.map((r, i) => ({
      stt: i + 1, phien: Number(r.phien),
      du_doan: fullLabel(r.predicted), ket_qua_thuc: fullLabel(r.actual),
      do_tin_cay: `${r.conf}%`, ket_luan: r.win ? '✅ THẮNG' : '❌ THUA',
    })),
  });
});

// ════════════════════════════════════════════════════════════════
//  /history
// ════════════════════════════════════════════════════════════════
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
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

// ════════════════════════════════════════════════════════════════
//  404
// ════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({
  error: 'Endpoint không tồn tại',
  endpoints: ['/', '/sunlon', '/canvas', '/signals', '/thongke', '/history'],
}));

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`
╔═══════════════════════════════════════════════════╗
║  Virtual Chart Engine v5.0 — @sewdangcap         ║
║  http://localhost:${PORT}                             ║
╠═══════════════════════════════════════════════════╣
║  Charts: BB14×2σ · SMA7 · EMA14 · RSI10 · S/R   ║
║  Canvas: ${CFG.CANVAS_W} phiên / Min hist: ${CFG.MIN_HIST} phiên         ║
║  Poll:   mỗi ${CFG.POLL_MS/1000}s                             ║
╠═══════════════════════════════════════════════════╣
║  /          → Dashboard HTML                      ║
║  /sunlon    → JSON dự đoán                        ║
║  /canvas    → JSON biểu đồ + indicators           ║
║  /signals   → JSON 5 tín hiệu + RSI               ║
║  /thongke   → JSON winrate                        ║
║  /history   → JSON lịch sử                        ║
╚═══════════════════════════════════════════════════╝
`));
