'use strict';

/**
 * ════════════════════════════════════════════════════════════════
 *  TÀI XỈU — VIRTUAL CHART ENGINE  v5.1
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
//  / — DASHBOARD HTML (REDESIGNED v5.1)
// ════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const hist   = history.slice(-CFG.CANVAS_W);
  const pred   = predictByVirtualChart(history);
  const latest = history[history.length - 1];

  if (!latest) return res.send(`<!DOCTYPE html><html><body style="background:#04070f;color:#e0e8ff;font-family:'Courier New',monospace;display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px">
    <div style="font-size:32px;letter-spacing:8px;color:#00ffe7;font-weight:900">TX ENGINE</div>
    <div style="font-size:11px;color:#334;letter-spacing:3px">ĐANG KẾT NỐI NGUỒN DỮ LIỆU...</div>
    <div style="width:200px;height:2px;background:#0d1a2a;margin-top:8px;border-radius:1px;overflow:hidden"><div style="width:40%;height:2px;background:#00ffe7;animation:slide 1.2s ease-in-out infinite" id="bar"></div></div>
    <style>@keyframes slide{0%{margin-left:0}50%{margin-left:60%}100%{margin-left:0}}</style>
    <script>setTimeout(()=>location.reload(),3000)</script></body></html>`);

  const nxtPhien   = String(Number(latest.phien) + 1);
  const taiCount50 = history.slice(-50).filter(h => h.kq === 'T').length;
  const xiuCount50 = history.slice(-50).length - taiCount50;
  const recentWL   = winLoss.slice(-50);
  const wr         = recentWL.length ? Math.round(recentWL.filter(r=>r.win).length/recentWL.length*100)+'%' : '—';
  const pattern50  = history.slice(-50).map(h => h.kq).join('');
  const streak     = pred?.streak ?? analyzeStreak(hist);

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
<title>TX Engine v5.1 · @sewdangcap</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<style>
:root{
  --void:    #04070f;
  --base:    #070c18;
  --surface: #0b1220;
  --raise:   #0f1a2e;
  --border:  rgba(0,255,231,0.07);
  --border2: rgba(0,255,231,0.14);
  --tai:     #00ffe7;
  --tai2:    #00c8b8;
  --xiu:     #ff3d6b;
  --xiu2:    #cc2255;
  --gold:    #ffcc44;
  --purple:  #a855f7;
  --blue:    #3b9eff;
  --muted:   #2a3d5a;
  --dim:     #1a2840;
  --text:    #8ba4c0;
  --bright:  #c8dff0;
  --mono:    'Space Mono', monospace;
  --head:    'Bebas Neue', sans-serif;
  --body:    'DM Sans', sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{
  background:var(--void);
  color:var(--bright);
  font-family:var(--body);
  min-height:100vh;
  font-size:13px;
  line-height:1.5;
}

/* grid noise texture overlay */
body::after{
  content:'';position:fixed;inset:0;
  background-image:
    linear-gradient(rgba(0,255,231,0.015) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,255,231,0.015) 1px, transparent 1px);
  background-size:40px 40px;
  pointer-events:none;z-index:0;
}

.wrap{
  max-width:500px;margin:0 auto;
  padding:0 0 32px;
  position:relative;z-index:1;
}

/* ── TOP NAV ── */
.nav{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 14px;
  border-bottom:1px solid var(--border2);
  background:linear-gradient(180deg,#070e1c,var(--void));
  position:sticky;top:0;z-index:100;
  backdrop-filter:blur(12px);
}
.nav-logo{
  font-family:var(--head);
  font-size:22px;letter-spacing:4px;
  background:linear-gradient(90deg,var(--tai),#7fffd4);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
}
.nav-right{display:flex;align-items:center;gap:10px}
.pulse-ring{
  width:8px;height:8px;border-radius:50%;
  background:var(--tai);
  box-shadow:0 0 0 0 rgba(0,255,231,0.6);
  animation:ping 1.6s cubic-bezier(0,0,0.2,1) infinite;
}
@keyframes ping{
  0%{box-shadow:0 0 0 0 rgba(0,255,231,0.6)}
  70%{box-shadow:0 0 0 8px rgba(0,255,231,0)}
  100%{box-shadow:0 0 0 0 rgba(0,255,231,0)}
}
.nav-session{
  font-family:var(--mono);font-size:9px;
  color:var(--text);letter-spacing:1px;
}

/* ── HERO RESULT BANNER ── */
.hero{
  margin:10px;
  border-radius:8px;
  border:1px solid var(--border2);
  background:var(--surface);
  overflow:hidden;
  position:relative;
}
.hero::before{
  content:'';position:absolute;
  top:-60px;left:-60px;
  width:200px;height:200px;
  border-radius:50%;
  opacity:0.06;
}
.hero.tai::before{background:var(--tai)}
.hero.xiu::before{background:var(--xiu)}
.hero-inner{padding:12px 14px;display:flex;align-items:center;gap:12px;position:relative}
.hero-kq{
  font-family:var(--head);
  font-size:52px;letter-spacing:2px;
  line-height:1;flex-shrink:0;
}
.hero.tai .hero-kq{
  color:var(--tai);
  text-shadow:0 0 40px rgba(0,255,231,0.4),0 0 80px rgba(0,255,231,0.15);
}
.hero.xiu .hero-kq{
  color:var(--xiu);
  text-shadow:0 0 40px rgba(255,61,107,0.4),0 0 80px rgba(255,61,107,0.15);
}
.hero-info{flex:1}
.hero-label{
  font-size:9px;color:var(--text);
  text-transform:uppercase;letter-spacing:2px;
  margin-bottom:3px;
}
.hero-phien{
  font-family:var(--mono);font-size:11px;
  color:var(--muted);margin-bottom:6px;
}
.dice-row{display:flex;gap:4px}
.die{
  width:22px;height:22px;border-radius:4px;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:11px;font-weight:700;
  border:1px solid rgba(255,255,255,0.08);
}
.hero-tong{
  font-family:var(--mono);font-size:11px;
  color:var(--text);margin-left:6px;
  align-self:center;
}

/* ── STAT ROW ── */
.stats{
  display:grid;grid-template-columns:repeat(4,1fr);
  gap:1px;background:var(--border);
  border-top:1px solid var(--border);
  border-bottom:1px solid var(--border);
}
.stat{
  background:var(--base);
  padding:9px 8px;text-align:center;
}
.stat-lbl{
  font-size:8px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.8px;
  margin-bottom:4px;
  font-family:var(--mono);
}
.stat-val{
  font-family:var(--head);font-size:20px;
  line-height:1;
}
.stat-sub{font-size:8px;color:var(--muted);margin-top:2px;font-family:var(--mono)}

/* ── CHART SECTION ── */
.section{padding:10px 10px 4px}
.section-head{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:6px;
}
.section-title{
  font-family:var(--head);
  font-size:13px;letter-spacing:2px;
  color:var(--tai);text-transform:uppercase;
}
.section-meta{
  font-family:var(--mono);font-size:8px;
  color:var(--muted);letter-spacing:.5px;
}
.legend{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.leg{display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:8px;color:var(--muted)}
.leg-line{width:10px;height:2px;border-radius:1px}
.leg-dash{width:10px;height:0;border-top:2px dashed;border-radius:1px}

.card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  padding:10px 8px 8px;
  position:relative;overflow:hidden;
}
.card::after{
  content:'';position:absolute;
  top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--border2),transparent);
}

/* ── SR TAGS ── */
.sr-row{display:flex;gap:5px;flex-wrap:wrap;padding:5px 2px 0}
.sr-tag{
  font-family:var(--mono);font-size:8px;
  padding:2px 7px;border-radius:3px;
  letter-spacing:.4px;
}
.sr-r{background:rgba(255,61,107,0.08);color:var(--xiu);border:1px solid rgba(255,61,107,0.18)}
.sr-s{background:rgba(0,255,231,0.06);color:var(--tai);border:1px solid rgba(0,255,231,0.15)}

/* ── RSI ── */
.rsi-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 10px 4px;
}
.rsi-lbl{font-family:var(--mono);font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.rsi-val{font-family:var(--mono);font-size:10px;font-weight:700}

/* ── PREDICTION CARD ── */
.pred{
  margin:6px 10px;
  border-radius:8px;
  border:1px solid var(--border2);
  background:var(--surface);
  overflow:hidden;position:relative;
}
.pred-glow{
  position:absolute;
  top:-80px;right:-80px;
  width:200px;height:200px;
  border-radius:50%;opacity:0.07;
}
.pred.tai .pred-glow{background:var(--tai)}
.pred.xiu .pred-glow{background:var(--xiu)}
.pred-top{
  padding:10px 14px 0;
  display:flex;align-items:center;gap:6px;
}
.pred-label-sm{
  font-family:var(--mono);font-size:8px;
  text-transform:uppercase;letter-spacing:1.5px;
  color:var(--muted);
}
.pred-phien{font-family:var(--mono);font-size:8px;color:var(--text)}
.pred-body{padding:6px 14px 12px;display:flex;align-items:center;gap:12px;position:relative}
.pred-big{
  font-family:var(--head);
  font-size:64px;letter-spacing:2px;
  line-height:1;flex-shrink:0;
}
.pred.tai .pred-big{
  color:var(--tai);
  text-shadow:0 0 60px rgba(0,255,231,0.35);
}
.pred.xiu .pred-big{
  color:var(--xiu);
  text-shadow:0 0 60px rgba(255,61,107,0.35);
}
.pred-right{flex:1}
.pred-bars{display:flex;flex-direction:column;gap:5px;margin-bottom:6px}
.bar-row{display:flex;align-items:center;gap:7px}
.bar-name{font-family:var(--mono);font-size:8px;width:24px;flex-shrink:0}
.bar-name.t{color:var(--tai)}.bar-name.x{color:var(--xiu)}
.bar-track{flex:1;height:6px;background:var(--raise);border-radius:3px;overflow:hidden}
.bar-fill{height:6px;border-radius:3px;transition:width .4s}
.bar-fill.t{background:linear-gradient(90deg,var(--tai2),var(--tai))}
.bar-fill.x{background:linear-gradient(90deg,var(--xiu2),var(--xiu))}
.bar-pct{font-family:var(--mono);font-size:8px;width:34px;text-align:right}
.bar-pct.t{color:var(--tai)}.bar-pct.x{color:var(--xiu)}
.pred-pattern{
  font-family:var(--mono);font-size:8px;
  color:var(--purple);line-height:1.5;
  padding:4px 0 0;
}
.pred-streak{
  display:inline-flex;align-items:center;gap:4px;
  margin-top:4px;padding:3px 8px;border-radius:3px;
  font-family:var(--mono);font-size:8px;
}
.pred-streak.hot{background:rgba(255,204,68,0.08);color:var(--gold);border:1px solid rgba(255,204,68,0.18)}
.pred-streak.cool{background:rgba(0,255,231,0.06);color:var(--tai);border:1px solid rgba(0,255,231,0.15)}

/* confidence arc */
.conf-wrap{flex-shrink:0;text-align:center}
.conf-svg{display:block}
.conf-val{
  font-family:var(--head);font-size:22px;
  line-height:1;
}
.conf-sub{font-family:var(--mono);font-size:8px;color:var(--muted);margin-top:2px;letter-spacing:.5px}

/* ── SIGNALS ── */
.sigs{
  display:grid;grid-template-columns:1fr 1fr;
  gap:5px;margin:4px 10px;
}
.sig{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:5px;
  padding:7px 9px 7px 11px;
  position:relative;overflow:hidden;
}
.sig::before{
  content:'';position:absolute;
  left:0;top:0;bottom:0;width:2px;
  border-radius:1px 0 0 1px;
}
.sig.t::before{background:var(--tai)}
.sig.x::before{background:var(--xiu)}
.sig.n::before{background:var(--muted)}
.sig-name{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;font-family:var(--mono)}
.sig-val{font-family:var(--head);font-size:14px;line-height:1}
.sig-val.t{color:var(--tai)}.sig-val.x{color:var(--xiu)}.sig-val.n{color:var(--muted)}
.sig-detail{font-size:8px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono)}
.sig-w{font-size:7px;color:var(--dim);margin-top:2px;font-family:var(--mono)}

/* ── WEIGHT BARS ── */
.weights{
  margin:4px 10px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;
  padding:9px 11px;
}
.w-title{
  font-family:var(--mono);font-size:8px;
  color:var(--muted);text-transform:uppercase;
  letter-spacing:.8px;margin-bottom:7px;
}
.w-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.w-row:last-child{margin-bottom:0}
.w-name{font-family:var(--mono);font-size:8px;color:var(--text);width:76px;flex-shrink:0}
.w-track{flex:1;height:4px;background:var(--raise);border-radius:2px;overflow:hidden}
.w-fill{height:4px;border-radius:2px;transition:width .4s}
.w-pct{font-family:var(--mono);font-size:8px;width:28px;text-align:right}

/* ── HISTORY ── */
.hist{
  margin:6px 10px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:6px;overflow:hidden;
}
.hist-hdr{
  font-family:var(--mono);font-size:8px;
  color:var(--muted);text-transform:uppercase;
  letter-spacing:.8px;
  padding:7px 11px;
  background:var(--raise);
  border-bottom:1px solid var(--border);
}
.hist-table{width:100%;border-collapse:collapse}
.hist-table tr{border-bottom:1px solid rgba(255,255,255,0.025)}
.hist-table tr:last-child{border-bottom:none}
.hist-table tr:hover td{background:rgba(0,255,231,0.02)}
.hist-table td{padding:4px 8px;font-size:10px}
.htd-n{font-family:var(--mono);font-size:8px;color:var(--muted)}
.chip{
  display:inline-block;padding:1px 8px;border-radius:3px;
  font-family:var(--mono);font-size:9px;font-weight:700;
}
.chip.t{background:rgba(0,255,231,0.07);color:var(--tai);border:1px solid rgba(0,255,231,0.15)}
.chip.x{background:rgba(255,61,107,0.07);color:var(--xiu);border:1px solid rgba(255,61,107,0.15)}
.dset{display:flex;gap:2px}
.dv{
  width:17px;height:17px;border-radius:3px;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:9px;font-weight:700;
  border:1px solid rgba(255,255,255,0.05);
}
.htd-sum{
  font-family:var(--mono);font-size:10px;
  font-weight:700;text-align:right;
}

/* ── PATTERN GRID ── */
.pattern-sec{padding:6px 10px}
.pat-lbl{font-family:var(--mono);font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px}
.pat-grid{display:flex;flex-wrap:wrap;gap:2px}
.pb{
  width:15px;height:15px;border-radius:2px;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:7px;font-weight:700;
}
.pb-t{background:rgba(0,255,231,0.08);color:var(--tai);border:1px solid rgba(0,255,231,0.12)}
.pb-x{background:rgba(255,61,107,0.08);color:var(--xiu);border:1px solid rgba(255,61,107,0.12)}
.pat-stats{display:flex;gap:14px;padding:5px 0 0;font-family:var(--mono);font-size:9px}

/* ── ACTION BUTTONS ── */
.actions{display:flex;gap:6px;padding:10px 10px 0}
.btn{
  flex:1;padding:11px;border-radius:5px;border:none;
  cursor:pointer;
  font-family:var(--head);font-size:13px;
  letter-spacing:2px;text-transform:uppercase;
  transition:all .15s;
  position:relative;overflow:hidden;
}
.btn::after{
  content:'';position:absolute;inset:0;
  background:rgba(255,255,255,0);
  transition:background .15s;
}
.btn:active::after{background:rgba(255,255,255,0.08)}
.btn-t{
  background:linear-gradient(135deg,#004d3d,#006654);
  color:var(--tai);border:1px solid rgba(0,255,231,0.25);
  box-shadow:0 0 20px rgba(0,255,231,0.08);
}
.btn-t:hover{box-shadow:0 0 30px rgba(0,255,231,0.15);border-color:rgba(0,255,231,0.4)}
.btn-m{
  background:linear-gradient(135deg,#1a1400,#2a2200);
  color:var(--gold);border:1px solid rgba(255,204,68,0.2);
}
.btn-m:hover{border-color:rgba(255,204,68,0.35)}
.btn-x{
  background:linear-gradient(135deg,#4d0015,#660020);
  color:var(--xiu);border:1px solid rgba(255,61,107,0.25);
  box-shadow:0 0 20px rgba(255,61,107,0.08);
}
.btn-x:hover{box-shadow:0 0 30px rgba(255,61,107,0.15);border-color:rgba(255,61,107,0.4)}

/* ── FOOTER ── */
.footer{
  display:flex;justify-content:center;align-items:center;
  gap:16px;padding:12px 0 0;
  font-family:var(--mono);font-size:8px;color:var(--dim);
  letter-spacing:.5px;
}
.footer a{color:var(--muted);text-decoration:none;transition:color .2s}
.footer a:hover{color:var(--tai)}
.footer-sep{color:var(--dim)}

/* chart sub note */
.chart-note{
  font-family:var(--mono);font-size:7px;
  color:var(--muted);text-align:right;
  padding:3px 2px 0;letter-spacing:.3px;
}
</style>
</head>
<body>
<div class="wrap">

<!-- NAV -->
<div class="nav">
  <div class="nav-logo">TX ENGINE</div>
  <div class="nav-right">
    <div class="nav-session">v5.1 · @sewdangcap</div>
    <div class="pulse-ring"></div>
  </div>
</div>

<!-- HERO RESULT -->
<div class="hero ${latest.kq==='T'?'tai':'xiu'}">
  <div class="hero-inner">
    <div class="hero-kq">${latest.kq==='T'?'TÀI':'XỈU'}</div>
    <div class="hero-info">
      <div class="hero-label">Phiên gần nhất</div>
      <div class="hero-phien">PHIÊN #${latest.phien}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <div class="dice-row">
          ${latest.dice ? ['#1a3d2b','#3d2e00','#2a1a4d'].map((c,i)=>`<div class="die" style="background:${c}">${latest.dice[i]}</div>`).join('') : ''}
        </div>
        <div class="hero-tong">Tổng: <strong style="color:${latest.kq==='T'?'var(--tai)':'var(--xiu)'}">${latest.tong}</strong></div>
      </div>
    </div>
  </div>
  <div style="height:2px;background:linear-gradient(90deg,transparent,${latest.kq==='T'?'var(--tai)':'var(--xiu)'},transparent);opacity:0.3"></div>
</div>

<!-- STATS -->
<div class="stats">
  <div class="stat">
    <div class="stat-lbl">KẾT QUẢ</div>
    <div class="stat-val" style="color:${latest.kq==='T'?'var(--tai)':'var(--xiu)'}">${latest.kq==='T'?'TÀI':'XỈU'}</div>
    <div class="stat-sub">${latest.tong}/18</div>
  </div>
  <div class="stat">
    <div class="stat-lbl">DỰ ĐOÁN</div>
    <div class="stat-val" style="color:${pred?(pred.winner==='T'?'var(--tai)':'var(--xiu)'):'var(--muted)'}">${pred?fullLabel(pred.winner):'···'}</div>
    <div class="stat-sub">#${nxtPhien.slice(-5)}</div>
  </div>
  <div class="stat">
    <div class="stat-lbl">T / X</div>
    <div class="stat-val"><span style="color:var(--tai)">${taiCount50}</span><span style="color:var(--muted);font-size:13px"> / </span><span style="color:var(--xiu)">${xiuCount50}</span></div>
    <div class="stat-sub">50 phiên</div>
  </div>
  <div class="stat">
    <div class="stat-lbl">WIN RATE</div>
    <div class="stat-val" style="color:var(--gold)">${wr}</div>
    <div class="stat-sub">${recentWL.length}p</div>
  </div>
</div>

<!-- CHART A -->
<div class="section">
  <div class="section-head">
    <div class="section-title">Chart A — Tổng</div>
    <div class="legend">
      <div class="leg"><div class="leg-line" style="background:var(--blue)"></div>EMA14</div>
      <div class="leg"><div class="leg-line" style="background:var(--gold)"></div>SMA7</div>
      <div class="leg"><div class="leg-dash" style="border-color:var(--purple);opacity:.5"></div>BB</div>
    </div>
  </div>
  <div class="card">
    <div style="height:195px;position:relative"><canvas id="cvA"></canvas></div>
  </div>
  <div class="sr-row" id="srLegend"></div>
  <div class="chart-note">BB 14×2σ · SMA7 · EMA14 · Vàng: ranh giới Tài/Xỉu</div>
</div>

<!-- RSI -->
<div class="section" style="padding-top:0">
  <div class="rsi-head">
    <div class="rsi-lbl">RSI(10) Oscillator</div>
    <div class="rsi-val" id="rsiVal"></div>
  </div>
  <div class="card">
    <div style="height:65px;position:relative"><canvas id="cvRSI"></canvas></div>
  </div>
</div>

<!-- CHART B -->
<div class="section" style="padding-top:2px">
  <div class="section-head">
    <div class="section-title">Chart B — 3 Xúc Xắc</div>
    <div class="legend">
      <div class="leg"><div class="leg-line" style="background:#ff5060"></div>D1</div>
      <div class="leg"><div class="leg-line" style="background:#e8c000"></div>D2</div>
      <div class="leg"><div class="leg-line" style="background:#9060e0"></div>D3</div>
    </div>
  </div>
  <div class="card">
    <div style="height:160px;position:relative"><canvas id="cvB"></canvas></div>
  </div>
  <div style="display:flex;gap:1px;margin-top:4px;border-radius:3px;overflow:hidden" id="heatmap"></div>
  <div class="chart-note">Xanh = Tài · Đỏ = Xỉu</div>
</div>

<!-- PREDICTION -->
${pred ? `
<div class="pred ${pred.winner==='T'?'tai':'xiu'}">
  <div class="pred-glow"></div>
  <div class="pred-top">
    <div class="pred-label-sm">Dự đoán phiên</div>
    <div class="pred-phien">#${nxtPhien.slice(-5)}</div>
  </div>
  <div class="pred-body">
    <div class="pred-big">${fullLabel(pred.winner)}</div>
    <div class="pred-right">
      <div class="pred-bars">
        <div class="bar-row">
          <div class="bar-name t">TÀI</div>
          <div class="bar-track"><div class="bar-fill t" style="width:${pred.votePct.T}"></div></div>
          <div class="bar-pct t">${pred.votePct.T}</div>
        </div>
        <div class="bar-row">
          <div class="bar-name x">XỈU</div>
          <div class="bar-track"><div class="bar-fill x" style="width:${pred.votePct.X}"></div></div>
          <div class="bar-pct x">${pred.votePct.X}</div>
        </div>
      </div>
      <div class="pred-pattern">📐 ${pred.patternName ?? '—'}</div>
      ${streak?.streakDetail ? `<div class="pred-streak ${streak.streakLen>=3?'hot':'cool'}">⚡ ${streak.streakDetail}</div>` : ''}
    </div>
    <div class="conf-wrap">
      <svg class="conf-svg" width="76" height="76" viewBox="0 0 76 76">
        <circle cx="38" cy="38" r="30" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="5"/>
        <circle cx="38" cy="38" r="30" fill="none"
          stroke="${pred.winner==='T'?'#00ffe7':'#ff3d6b'}"
          stroke-width="5" stroke-linecap="round"
          stroke-dasharray="${(pred.conf/100)*188.5} 188.5"
          transform="rotate(-90 38 38)"
          style="filter:drop-shadow(0 0 6px ${pred.winner==='T'?'rgba(0,255,231,0.6)':'rgba(255,61,107,0.6)'})"
        />
        <text x="38" y="35" text-anchor="middle" fill="${pred.winner==='T'?'#00ffe7':'#ff3d6b'}"
          font-family="'Bebas Neue',sans-serif" font-size="16" letter-spacing="1">${pred.conf}%</text>
        <text x="38" y="47" text-anchor="middle" fill="#2a3d5a"
          font-family="'Space Mono',monospace" font-size="6">${pred.clarity}</text>
      </svg>
    </div>
  </div>
</div>` : `<div style="text-align:center;padding:20px;color:var(--muted);font-family:var(--mono);font-size:10px">⏳ Đang phân tích...</div>`}

<!-- SIGNALS -->
<div class="sigs">
  ${(pred?.sources ?? []).map(s=>`
  <div class="sig ${s.bias==='T'?'t':s.bias==='X'?'x':'n'}">
    <div class="sig-name">${s.name}</div>
    <div class="sig-val ${s.bias==='T'?'t':s.bias==='X'?'x':'n'}">${s.biasFull??'—'}</div>
    <div class="sig-detail">${s.detail}</div>
    <div class="sig-w">W: ${s.weight}</div>
  </div>`).join('')}
</div>

<!-- WEIGHTS -->
<div class="weights">
  <div class="w-title">Trọng số Ensemble</div>
  ${(pred?.sources??[]).map(s=>{
    const tot = (pred?.sources??[]).reduce((a,b)=>a+b.weight,0);
    const pct = Math.round(s.weight/tot*100);
    const col = s.bias==='T'?'var(--tai)':s.bias==='X'?'var(--xiu)':'var(--muted)';
    return `<div class="w-row">
      <div class="w-name">${s.name}</div>
      <div class="w-track"><div class="w-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="w-pct" style="color:${col}">${pct}%</div>
    </div>`;
  }).join('')}
</div>

<!-- HISTORY -->
<div class="hist">
  <div class="hist-hdr">Lịch sử 15 phiên gần nhất</div>
  <table class="hist-table">
    <tr style="background:var(--raise)">
      <td class="htd-n" style="padding:4px 8px">PHIÊN</td>
      <td class="htd-n">KQ</td>
      <td class="htd-n">XÚC XẮC</td>
      <td class="htd-n" style="text-align:right">TỔNG</td>
    </tr>
    ${history.slice(-15).reverse().map(h=>`
    <tr>
      <td class="htd-n">#${String(h.phien).slice(-5)}</td>
      <td><span class="chip ${h.kq==='T'?'t':'x'}">${fullLabel(h.kq)}</span></td>
      <td><div class="dset">${h.dice?['#1a3d2b','#3d2e00','#2a1a4d'].map((c,i)=>`<div class="dv" style="background:${c}">${h.dice[i]}</div>`).join(''):'—'}</div></td>
      <td class="htd-sum" style="color:${h.kq==='T'?'var(--tai)':'var(--xiu)'}">${h.tong}</td>
    </tr>`).join('')}
  </table>
</div>

<!-- PATTERN 50 -->
<div class="pattern-sec">
  <div class="pat-lbl">Chuỗi 50 phiên gần nhất</div>
  <div class="pat-grid">
    ${pattern50.split('').map(c=>`<span class="pb ${c==='T'?'pb-t':'pb-x'}">${c}</span>`).join('')}
  </div>
  <div class="pat-stats">
    <span style="color:var(--tai)">T: ${taiCount50}</span>
    <span style="color:var(--muted)">·</span>
    <span style="color:var(--xiu)">X: ${xiuCount50}</span>
    <span style="color:var(--muted)">·</span>
    <span style="color:var(--muted)">${((taiCount50/Math.max(1,taiCount50+xiuCount50))*100).toFixed(0)}% Tài</span>
  </div>
</div>

<!-- ACTIONS -->
<div class="actions">
  <button class="btn btn-t">▲ TÀI</button>
  <button class="btn btn-m">⚡ PHÂN TÍCH</button>
  <button class="btn btn-x">▼ XỈU</button>
</div>

<!-- FOOTER -->
<div class="footer">
  <span>Chart Engine v5.1</span>
  <span class="footer-sep">·</span>
  <a href="/sunlon">API</a>
  <a href="/signals">Signals</a>
  <a href="/thongke">Thống kê</a>
  <a href="/history">History</a>
</div>

</div>

<script>
Chart.register(window['chartjs-plugin-annotation']);

const DATA_A   = ${chartAData};
const BB_U     = ${bbUpper};
const BB_M     = ${bbMiddle};
const BB_L     = ${bbLower};
const SMA7     = ${sma7Data};
const EMA14    = ${ema14Data};
const RSI      = ${rsiData};
const SR       = ${srZones};
const D1       = ${chartBD1};
const D2       = ${chartBD2};
const D3       = ${chartBD3};
const LABELS   = ${chartLabels};
const PRED     = ${predJson};
const TAI_LINE = ${CFG.TAI_LINE};

const TAI  = '#00ffe7';
const XIU  = '#ff3d6b';
const GOLD = '#ffcc44';
const BLUE = '#3b9eff';
const PURP = '#a855f7';

// point colors Chart A
const ptCol  = DATA_A.map(v => v===null?'rgba(255,255,255,.1)':v>=TAI_LINE?TAI:XIU);
const ptBord = DATA_A.map(v => v>=TAI_LINE?'rgba(0,255,231,0.35)':'rgba(255,61,107,0.35)');
const ptSz   = DATA_A.map((_,i)=>i===DATA_A.length-1?10:3.5);
const ptSt   = DATA_A.map((_,i)=>i===DATA_A.length-1?'rectRot':'circle');

// SR annotations
function srAnnotations(){
  const a={};
  SR.forEach((z,i)=>{
    a['z'+i]={
      type:'line',yMin:z.level,yMax:z.level,
      borderColor:z.type==='resistance'?'rgba(255,61,107,0.3)':'rgba(0,255,231,0.3)',
      borderWidth:1,borderDash:[4,3],
      label:{display:true,content:z.level+(z.type==='resistance'?' R':' S')+'×'+z.touches,
        position:'end',color:z.type==='resistance'?XIU:TAI,
        font:{size:7,family:'Space Mono'},
        backgroundColor:'rgba(4,7,15,0.9)',
        padding:{x:4,y:2},
        yAdjust:z.type==='resistance'?-10:10}};
  });
  a.tai={type:'line',yMin:TAI_LINE,yMax:TAI_LINE,
    borderColor:'rgba(255,204,68,0.35)',borderWidth:1.5,borderDash:[6,4],
    label:{display:true,content:'TÀI ≥'+TAI_LINE,position:'start',color:GOLD,
      font:{size:7,family:'Space Mono'},backgroundColor:'rgba(4,7,15,0.9)',padding:{x:4,y:2}}};
  return a;
}

// Chart A
new Chart(document.getElementById('cvA'),{
  type:'line',
  data:{labels:LABELS,datasets:[
    // BB Upper
    {data:BB_U,borderColor:'rgba(168,85,247,0.35)',borderWidth:1,borderDash:[3,2],
     pointRadius:0,fill:'+2',backgroundColor:'rgba(168,85,247,0.03)',tension:0.3,order:5},
    // BB Mid
    {data:BB_M,borderColor:'rgba(168,85,247,0.5)',borderWidth:1,borderDash:[4,3],
     pointRadius:0,fill:false,tension:0.3,order:4},
    // BB Lower
    {data:BB_L,borderColor:'rgba(168,85,247,0.35)',borderWidth:1,borderDash:[3,2],
     pointRadius:0,fill:false,tension:0.3,order:5},
    // SMA7
    {data:SMA7,borderColor:'rgba(255,204,68,0.65)',borderWidth:1.5,
     pointRadius:0,fill:false,tension:0.3,order:2},
    // EMA14
    {data:EMA14,borderColor:'rgba(59,158,255,0.75)',borderWidth:1.5,
     pointRadius:0,fill:false,tension:0.3,order:1},
    // Main
    {data:DATA_A,
     borderColor:'rgba(200,223,240,0.7)',
     backgroundColor:ctx=>{
       const g=ctx.chart.ctx.createLinearGradient(0,0,0,195);
       g.addColorStop(0,'rgba(0,255,231,0.1)');
       g.addColorStop(0.5,'rgba(59,158,255,0.04)');
       g.addColorStop(1,'rgba(255,61,107,0.07)');
       return g;
     },
     borderWidth:2,
     pointBackgroundColor:ptCol,pointBorderColor:ptBord,
     pointBorderWidth:1.5,pointRadius:ptSz,pointStyle:ptSt,
     pointHoverRadius:9,tension:0.28,fill:true,order:0}
  ]},
  options:{
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{
        backgroundColor:'rgba(4,7,15,0.96)',
        titleColor:BLUE,bodyColor:'#8ba4c0',
        borderColor:'rgba(0,255,231,0.12)',borderWidth:1,
        titleFont:{family:'Space Mono',size:9},
        bodyFont:{family:'Space Mono',size:9},
        callbacks:{
          title:i=>'Phiên '+LABELS[i[0].dataIndex],
          label:c=>{
            const v=c.parsed.y;if(v===null)return null;
            const ns=['BB↑','BB mid','BB↓','SMA7','EMA14','Tổng'];
            if(c.datasetIndex===5)return ns[5]+': '+v+' — '+(v>=TAI_LINE?'TÀI':'XỈU');
            return ns[c.datasetIndex]+': '+v;
          }
        }
      },
      annotation:{annotations:srAnnotations()}
    },
    scales:{
      x:{ticks:{font:{size:7,family:'Space Mono'},color:'rgba(42,61,90,0.9)',maxTicksLimit:10,maxRotation:0},
         grid:{color:'rgba(15,26,46,0.8)'},border:{color:'rgba(15,26,46,0.9)'}},
      y:{min:2,max:19,
         ticks:{font:{size:8,family:'Space Mono'},color:'rgba(42,61,90,0.9)',stepSize:3,
                callback:v=>v===TAI_LINE?v+'─':v},
         grid:{color:c=>c.tick.value===TAI_LINE?'rgba(255,204,68,0.15)':'rgba(15,26,46,0.7)',
               lineWidth:c=>c.tick.value===TAI_LINE?1.5:1},
         border:{color:'rgba(15,26,46,0.9)'}}
    }
  }
});

// SR legend
const srEl=document.getElementById('srLegend');
if(srEl) SR.forEach(z=>{
  const t=document.createElement('span');
  t.className='sr-tag '+(z.type==='resistance'?'sr-r':'sr-s');
  t.textContent=(z.type==='resistance'?'R ':'S ')+z.level+' ×'+z.touches;
  srEl.appendChild(t);
});

// RSI value display
const lastRSI=RSI.filter(v=>v!==null).slice(-1)[0];
const rsiEl=document.getElementById('rsiVal');
if(rsiEl&&lastRSI!==undefined){
  const col=lastRSI>70?XIU:lastRSI<30?TAI:BLUE;
  rsiEl.textContent='RSI '+(+lastRSI.toFixed(1))+(lastRSI>70?' OB':lastRSI<30?' OS':'');
  rsiEl.style.color=col;
}

// Chart RSI
new Chart(document.getElementById('cvRSI'),{
  type:'line',
  data:{labels:LABELS,datasets:[{
    data:RSI,
    borderColor:RSI.map(v=>v===null?'transparent':v>70?XIU:v<30?TAI:BLUE),
    backgroundColor:ctx=>{
      const g=ctx.chart.ctx.createLinearGradient(0,0,0,65);
      g.addColorStop(0,'rgba(59,158,255,0.12)');g.addColorStop(1,'rgba(59,158,255,0.01)');return g;},
    borderWidth:1.5,fill:true,tension:0.4,
    pointRadius:RSI.map((v,i)=>{
      if(v===null)return 0;
      if(i===RSI.length-1)return 4;
      return v>70||v<30?3:0;
    }),
    pointBackgroundColor:RSI.map(v=>v>70?XIU:v<30?TAI:BLUE)
  }]},
  options:{
    responsive:true,maintainAspectRatio:false,
    plugins:{
      legend:{display:false},
      tooltip:{backgroundColor:'rgba(4,7,15,0.96)',bodyColor:'#8ba4c0',
               borderColor:'rgba(0,255,231,0.1)',borderWidth:1,
               bodyFont:{family:'Space Mono',size:9},
               callbacks:{label:c=>'RSI: '+c.parsed.y}},
      annotation:{annotations:{
        ob:{type:'line',yMin:70,yMax:70,borderColor:'rgba(255,61,107,0.3)',borderWidth:1,borderDash:[3,2],
            label:{display:true,content:'OB 70',position:'end',color:XIU,
                   font:{size:7,family:'Space Mono'},backgroundColor:'rgba(4,7,15,0.9)',padding:{x:3,y:1}}},
        os:{type:'line',yMin:30,yMax:30,borderColor:'rgba(0,255,231,0.3)',borderWidth:1,borderDash:[3,2],
            label:{display:true,content:'OS 30',position:'end',color:TAI,
                   font:{size:7,family:'Space Mono'},backgroundColor:'rgba(4,7,15,0.9)',padding:{x:3,y:1}}},
        mid:{type:'line',yMin:50,yMax:50,borderColor:'rgba(59,158,255,0.1)',borderWidth:1,borderDash:[2,4]},
      }}
    },
    scales:{
      x:{display:false},
      y:{min:0,max:100,
         ticks:{font:{size:7,family:'Space Mono'},color:'rgba(42,61,90,0.9)',stepSize:25,
                callback:v=>v===70?'OB':v===30?'OS':v===50?'50':''},
         grid:{color:'rgba(15,26,46,0.6)'},border:{color:'rgba(15,26,46,0.9)'}}
    }
  }
});

// Chart B
new Chart(document.getElementById('cvB'),{
  type:'line',
  data:{labels:LABELS,datasets:[
    {label:'D1',data:D1,
     borderColor:'#e03050',
     backgroundColor:ctx=>{const g=ctx.chart.ctx.createLinearGradient(0,0,0,160);g.addColorStop(0,'rgba(224,48,80,0.15)');g.addColorStop(1,'rgba(224,48,80,0.01)');return g;},
     borderWidth:2,fill:true,tension:0.35,
     pointBackgroundColor:D1.map((v,i)=>{
       if(i===D1.length-1)return '#e03050';
       if(D2[i]!==null&&D3[i]!==null&&D1[i]===D2[i]&&D2[i]===D3[i])return '#fff';
       return '#e03050';
     }),
     pointRadius:D1.map((v,i)=>i===D1.length-1?8:D2[i]!==null&&D3[i]!==null&&D1[i]===D2[i]&&D2[i]===D3[i]?6:3),
     pointBorderColor:'rgba(224,48,80,0.35)',pointBorderWidth:1.5},
    {label:'D2',data:D2,
     borderColor:'#d4a800',
     backgroundColor:ctx=>{const g=ctx.chart.ctx.createLinearGradient(0,0,0,160);g.addColorStop(0,'rgba(212,168,0,0.1)');g.addColorStop(1,'rgba(212,168,0,0.01)');return g;},
     borderWidth:2,fill:false,tension:0.35,
     pointBackgroundColor:'#d4a800',pointBorderColor:'rgba(212,168,0,0.35)',
     pointBorderWidth:1.5,
     pointRadius:D2.map((_,i)=>i===D2.length-1?8:3)},
    {label:'D3',data:D3,
     borderColor:'#7840c0',
     backgroundColor:ctx=>{const g=ctx.chart.ctx.createLinearGradient(0,0,0,160);g.addColorStop(0,'rgba(120,64,192,0.1)');g.addColorStop(1,'rgba(120,64,192,0.01)');return g;},
     borderWidth:2,fill:false,tension:0.35,
     pointBackgroundColor:'#7840c0',pointBorderColor:'rgba(120,64,192,0.35)',
     pointBorderWidth:1.5,
     pointRadius:D3.map((_,i)=>i===D3.length-1?8:3)},
  ]},
  options:{
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{
        backgroundColor:'rgba(4,7,15,0.96)',titleColor:BLUE,bodyColor:'#8ba4c0',
        borderColor:'rgba(0,255,231,0.1)',borderWidth:1,
        titleFont:{family:'Space Mono',size:9},bodyFont:{family:'Space Mono',size:9},
        callbacks:{
          title:i=>'Phiên '+LABELS[i[0].dataIndex],
          label:c=>['D1','D2','D3'][c.datasetIndex]+': '+c.parsed.y,
          afterBody:i=>{
            const idx=i[0].dataIndex;
            const s=(D1[idx]||0)+(D2[idx]||0)+(D3[idx]||0);
            return['Tổng: '+s+' — '+(s>=TAI_LINE?'TÀI':'XỈU')];
          }
        }
      },
      annotation:{annotations:{
        avg:{type:'line',yMin:3.5,yMax:3.5,
          borderColor:'rgba(59,158,255,0.18)',borderWidth:1,borderDash:[3,3],
          label:{display:true,content:'AVG 3.5',position:'start',color:BLUE,
                 font:{size:7,family:'Space Mono'},backgroundColor:'rgba(4,7,15,0.9)',padding:{x:3,y:1}}}
      }}
    },
    scales:{
      x:{ticks:{font:{size:7,family:'Space Mono'},color:'rgba(42,61,90,0.9)',maxTicksLimit:10,maxRotation:0},
         grid:{color:'rgba(15,26,46,0.7)'},border:{color:'rgba(15,26,46,0.9)'}},
      y:{min:0,max:7,
         ticks:{font:{size:8,family:'Space Mono'},color:'rgba(42,61,90,0.9)',stepSize:1,callback:v=>v===0?'':v},
         grid:{color:'rgba(15,26,46,0.6)'},border:{color:'rgba(15,26,46,0.9)'}}
    }
  }
});

// Heatmap
const hm=document.getElementById('heatmap');
if(hm){
  DATA_A.slice(-30).forEach(v=>{
    const el=document.createElement('div');
    el.style.flex='1';el.style.height='10px';
    if(v===null) el.style.background='rgba(255,255,255,0.02)';
    else if(v>=TAI_LINE) el.style.background='rgba(0,255,231,'+(0.12+((v-11)/7)*0.45)+')';
    else el.style.background='rgba(255,61,107,'+(0.12+((11-v)/8)*0.45)+')';
    if(v!==null) el.title=(v>=TAI_LINE?'TÀI':'XỈU')+' '+v;
    hm.appendChild(el);
  });
}

setTimeout(()=>location.reload(),${CFG.POLL_MS});
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
║  Virtual Chart Engine v5.1 — @sewdangcap         ║
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
