'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║     TÀI XỈU — VIRTUAL CHART ENGINE  v6.0 — Casino-Grade Engine         ║
 * ║     DEV @sewdangcap                                                      ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  10 Thuật toán phân tích kỹ thuật:                                      ║
 * ║   1. Geometric Pattern  (W/M/H&S/Stairs/Flag/Triple)                    ║
 * ║   2. Linear Slope + Momentum + Mean-Reversion                           ║
 * ║   3. Support / Resistance Zone                                          ║
 * ║   4. Dice Convergence (3 xúc xắc đồng pha)                             ║
 * ║   5. Streak / Cầu tâm lý                                               ║
 * ║   6. RSI Momentum Oscillator                                            ║
 * ║   7. MACD Crossover                                                     ║
 * ║   8. Bollinger Band Squeeze                                             ║
 * ║   9. Fibonacci Retracement                                              ║
 * ║  10. Pattern Hash Fingerprinting                                        ║
 * ║  + ATR Trend Filter (bộ lọc tín hiệu yếu)                              ║
 * ║  + Entropy Analysis (đo độ ngẫu nhiên)                                 ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Endpoints:                                                             ║
 * ║    GET /        → Dashboard HTML                                        ║
 * ║    GET /sunlon  → JSON dự đoán                                          ║
 * ║    GET /canvas  → JSON snapshot 2 biểu đồ                              ║
 * ║    GET /signals → JSON chi tiết 10 tín hiệu                            ║
 * ║    GET /thongke → JSON winrate tracking                                 ║
 * ║    GET /history → JSON lịch sử phiên                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
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
  CANVAS_W:   50,
  MIN_HIST:    8,
  TAI_LINE:   11,
  MAX_HISTORY:500,
  CONF_FLOOR: 52,
  CONF_CEIL:  91,
  POLL_MS:   6000,

  // Trọng số ensemble v6 — streak & pattern ưu tiên cao nhất
  W_STREAK:   4.5,
  W_PATTERN:  4.0,
  W_HASH:     4.0,
  W_RSI:      3.8,
  W_MACD:     3.5,
  W_BOLL:     3.5,
  W_SLOPE:    3.2,
  W_SR:       3.0,
  W_FIBO:     2.8,
  W_DICE:     2.5,
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
  if (a === b && b === c)           return `Ba ${a}`;
  if (a === b || b === c)           return `Đôi ${a === b ? a : b}`;
  if (c - a === 2 && b - a === 1)   return `Seri ${a}-${b}-${c}`;
  return `${a}-${b}-${c}`;
}

// ════════════════════════════════════════════════════════════════
//  1. LOCAL EXTREMA
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
//  2. PATTERN SCANNER (Geometric)
// ════════════════════════════════════════════════════════════════
function scanPattern(arr) {
  const ex  = findExtrema(arr, 2);
  if (ex.length < 3) return null;
  const n   = ex.length;
  const raw = arr.filter(v => v !== null);
  const cur = raw[raw.length - 1];
  const near = (a, b, t = 2) => Math.abs(a - b) <= t;

  // W-bottom
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n-3], ex[n-2], ex[n-1]];
    if (e1.type==='trough' && e2.type==='peak' && e3.type==='trough' &&
        near(e1.v, e3.v, 3) && e2.v > e1.v + 2) {
      const str = Math.min(1, 0.55 + (e2.v - e3.v) / 14);
      const confirmed = cur >= e2.v - 2;
      return { name: `Mẫu W — Đáy ~${Math.round((e1.v+e3.v)/2)}${confirmed?' ✓':''}`,
               bias: 'T', strength: confirmed ? Math.min(1, str+0.12) : str*0.85 };
    }
  }
  // M-top
  if (n >= 3) {
    const [e1, e2, e3] = [ex[n-3], ex[n-2], ex[n-1]];
    if (e1.type==='peak' && e2.type==='trough' && e3.type==='peak' &&
        near(e1.v, e3.v, 3) && e2.v < e1.v - 2) {
      const str = Math.min(1, 0.55 + (e3.v - e2.v) / 14);
      const confirmed = cur <= e2.v + 2;
      return { name: `Mẫu M — Đỉnh ~${Math.round((e1.v+e3.v)/2)}${confirmed?' ✓':''}`,
               bias: 'X', strength: confirmed ? Math.min(1, str+0.12) : str*0.85 };
    }
  }
  // Head & Shoulders
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n-5);
    if (ls.type==='peak' && lt.type==='trough' && hd.type==='peak' &&
        rt.type==='trough' && rs.type==='peak' &&
        hd.v > ls.v && hd.v > rs.v && near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3))
      return { name: `Vai-Đầu-Vai Đỉnh ${hd.v}`, bias: 'X',
               strength: Math.min(1, 0.62 + (hd.v - rs.v) / 14) };
  }
  if (n >= 5) {
    const [ls, lt, hd, rt, rs] = ex.slice(n-5);
    if (ls.type==='trough' && lt.type==='peak' && hd.type==='trough' &&
        rt.type==='peak' && rs.type==='trough' &&
        hd.v < ls.v && hd.v < rs.v && near(ls.v, rs.v, 3) && near(lt.v, rt.v, 3))
      return { name: `Vai-Đầu-Vai Đáy ${hd.v}`, bias: 'T',
               strength: Math.min(1, 0.62 + (rs.v - hd.v) / 14) };
  }
  // Ascending/Descending Stairs
  {
    const peaks   = ex.filter(e => e.type==='peak').slice(-3);
    const troughs = ex.filter(e => e.type==='trough').slice(-3);
    if (peaks.length===3 && troughs.length===3) {
      const pkUp = peaks[0].v   < peaks[1].v   && peaks[1].v   < peaks[2].v;
      const trUp = troughs[0].v < troughs[1].v && troughs[1].v < troughs[2].v;
      const pkDn = peaks[0].v   > peaks[1].v   && peaks[1].v   > peaks[2].v;
      const trDn = troughs[0].v > troughs[1].v && troughs[1].v > troughs[2].v;
      if (pkUp && trUp) return { name: `Cầu Thang Tăng — Đỉnh ${peaks[2].v}`, bias:'T', strength:0.72 };
      if (pkDn && trDn) return { name: `Cầu Thang Giảm — Đỉnh ${peaks[2].v}`, bias:'X', strength:0.72 };
    }
  }
  // Flag
  if (raw.length >= 6) {
    const impulse = raw[raw.length-4] - raw[Math.max(0, raw.length-7)];
    const consol  = Math.max(...raw.slice(-4)) - Math.min(...raw.slice(-4));
    if (Math.abs(impulse)>=5 && consol<=3) {
      const bias = impulse > 0 ? 'T' : 'X';
      return { name: `Flag ${bias==='T'?'Tăng':'Giảm'} Đà${impulse>0?'+':''}${impulse.toFixed(0)}`,
               bias, strength: 0.65 };
    }
  }
  // Triple Top/Bottom
  if (n >= 4) {
    const lt = ex.filter(e => e.type==='trough').slice(-3);
    if (lt.length===3 && near(lt[0].v,lt[1].v,2) && near(lt[1].v,lt[2].v,2))
      return { name: `Triple Đáy ~${Math.round((lt[0].v+lt[1].v+lt[2].v)/3)}`, bias:'T', strength:0.75 };
    const lp = ex.filter(e => e.type==='peak').slice(-3);
    if (lp.length===3 && near(lp[0].v,lp[1].v,2) && near(lp[1].v,lp[2].v,2))
      return { name: `Triple Đỉnh ~${Math.round((lp[0].v+lp[1].v+lp[2].v)/3)}`, bias:'X', strength:0.75 };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
//  3. SLOPE ANALYZER
// ════════════════════════════════════════════════════════════════
function analyzeSlope(arr, win = 8) {
  const pts = arr.filter(v => v!==null).slice(-win).map((v,i) => ({ v, i }));
  if (pts.length < 3) return null;
  const n = pts.length;
  let sX=0, sY=0, sXY=0, sX2=0;
  pts.forEach(({ v }, i) => { sX+=i; sY+=v; sXY+=i*v; sX2+=i*i; });
  const denom = n*sX2 - sX*sX;
  const slope = denom ? (n*sXY - sX*sY) / denom : 0;
  const last  = pts[n-1].v;
  const proj  = Math.round(Math.max(3, Math.min(18, last + slope)));
  const mr    = (proj >= 16 && slope > 0.5) || (proj <= 5 && slope < -0.5);
  const h     = Math.floor(n/2);
  const mo    = pts.slice(h).reduce((s,p)=>s+p.v,0)/(n-h)
              - pts.slice(0,h).reduce((s,p)=>s+p.v,0)/h;
  let slopeBias = null, detail = '';
  if (mr)                     { slopeBias=proj>=16?'X':'T'; detail=`Hồi quy — proj ${proj}`; }
  else if (Math.abs(slope)>=.8){ slopeBias=slope>0?'T':'X'; detail=`Slope mạnh ${slope>0?'▲':'▼'} ${slope.toFixed(2)}/p`; }
  else if (Math.abs(slope)>=.3){ slopeBias=slope>0?'T':'X'; detail=`Slope ${slope>0?'▲':'▼'} ${slope.toFixed(2)}/p`; }
  else if (Math.abs(mo)>=1.2)  { slopeBias=mo>0?'T':'X';   detail=`Momentum ${mo>0?'▲':'▼'} ${mo.toFixed(1)}`; }
  else                          { detail=`Slope phẳng (${slope.toFixed(2)})`; }
  return { slope:+slope.toFixed(3), last, proj, momentum:+mo.toFixed(2), mr, slopeBias, detail,
           strength: mr ? 0.85 : Math.min(1, 0.45+Math.abs(slope)/3+Math.abs(mo)/10) };
}

// ════════════════════════════════════════════════════════════════
//  4. SUPPORT / RESISTANCE
// ════════════════════════════════════════════════════════════════
function detectSR(arr, minT = 2) {
  const v = arr.filter(x => x!==null);
  if (v.length < 8) return { zones:[], srBias:null, srDetail:'Chưa đủ dữ liệu' };
  const ep = [];
  for (let i=1; i<v.length-1; i++) {
    if (v[i]>v[i-1] && v[i]>=v[i+1]) ep.push({ v:v[i], r:'res' });
    if (v[i]<v[i-1] && v[i]<=v[i+1]) ep.push({ v:v[i], r:'sup' });
  }
  const bins = {};
  for (const e of ep) {
    const k = Math.round(e.v);
    if (!bins[k]) bins[k] = { level:k, res:0, sup:0 };
    bins[k][e.r]++;
  }
  const keys = Object.keys(bins).map(Number).sort((a,b)=>a-b);
  const zones=[], seen=new Set();
  for (const k of keys) {
    if (seen.has(k)) continue;
    const b = { ...bins[k] };
    if (bins[k+1]) { b.res+=bins[k+1].res; b.sup+=bins[k+1].sup; b.level=+((k+k+1)/2).toFixed(1); seen.add(k+1); }
    b.touches = b.res+b.sup;
    b.type    = b.res>=b.sup ? 'resistance' : 'support';
    if (b.touches >= minT) zones.push(b);
  }
  zones.sort((a,b) => b.touches-a.touches);
  const cur = v[v.length-1];
  let srBias=null, srDetail='Không có S/R nổi bật';
  for (const z of zones.slice(0,3)) {
    const diff = cur - z.level;
    if (z.type==='resistance') {
      if (Math.abs(diff)<=1.5) { srBias='X'; srDetail=`Kháng cự ${z.level} (${z.touches}x)`; break; }
      if (diff>0)               { srBias='T'; srDetail=`Vượt kháng cự ${z.level}`;             break; }
    } else {
      if (Math.abs(diff)<=1.5) { srBias='T'; srDetail=`Hỗ trợ ${z.level} (${z.touches}x)`;    break; }
      if (diff<0)               { srBias='X'; srDetail=`Thủng hỗ trợ ${z.level}`;              break; }
    }
  }
  return { zones:zones.slice(0,4), srBias, srDetail };
}

// ════════════════════════════════════════════════════════════════
//  5. DICE CONVERGENCE
// ════════════════════════════════════════════════════════════════
function analyzeDice(hist, win = 8) {
  const slopes = [0,1,2].map(di => {
    const vals = hist.map(h => Array.isArray(h.dice)?h.dice[di]:null)
                     .filter(v => v!==null).slice(-win);
    if (vals.length < 3) return null;
    const n=vals.length; let sX=0,sY=0,sXY=0,sX2=0;
    vals.forEach((v,i) => { sX+=i; sY+=v; sXY+=i*v; sX2+=i*i; });
    const d=n*sX2-sX*sX;
    return d ? (n*sXY-sX*sY)/d : 0;
  });
  const valid = slopes.filter(s => s!==null);
  if (valid.length<2) return { diceBias:null, diceDetail:'Thiếu dữ liệu xúc xắc', convScore:0 };
  const up   = valid.filter(s => s> 0.12).length;
  const down = valid.filter(s => s<-0.12).length;
  const avg  = valid.reduce((a,s)=>a+s,0)/valid.length;
  const last = hist.filter(h=>h.dice).slice(-1)[0];
  const proj = last ? +(last.dice.reduce((a,b)=>a+b,0)+avg*3).toFixed(1) : null;
  let diceBias=null, diceDetail='', convScore=0;
  if (up>=2 || down>=2) {
    convScore = Math.max(up,down);
    diceBias  = up>=down?'T':'X';
    diceDetail= `${convScore}/3 xúc xắc ${up>=down?'▲ tăng':'▼ giảm'}${proj?' | proj≈'+proj:''}`;
  } else {
    diceDetail= `Phân kỳ (↑${up} ↓${down})${proj?' | proj≈'+proj:''}`;
  }
  return { diceBias, diceDetail, convScore, avgSlope:+avg.toFixed(3), proj };
}

// ════════════════════════════════════════════════════════════════
//  6. STREAK / CẦU TÂM LÝ
// ════════════════════════════════════════════════════════════════
function analyzeStreak(hist) {
  if (!hist || hist.length < 3)
    return { streakBias:null, streakDetail:'Chưa đủ dữ liệu', streakLen:0, strength:0.3 };
  const kqs   = hist.slice(-20).map(h => h.kq);
  let streak  = 1;
  const last  = kqs[kqs.length-1];
  for (let i=kqs.length-2; i>=0; i--) {
    if (kqs[i]===last) streak++; else break;
  }
  let streakBias=null, streakDetail='', strength=0.3;
  const opposite = last==='T'?'X':'T';
  if (streak>=5) {
    streakBias=opposite; streakDetail=`Cầu ${fullLabel(last)} ${streak} phiên → Đổi chiều`; strength=0.88;
  } else if (streak>=3) {
    streakBias=opposite; streakDetail=`Cầu ${fullLabel(last)} ${streak} phiên → Cảnh báo`;  strength=0.65;
  } else if (streak===2) {
    streakBias=last;     streakDetail=`Cầu ${fullLabel(last)} ${streak} phiên → Theo đà`;   strength=0.45;
  } else {
    streakDetail=`Không có cầu rõ`; strength=0.3;
  }
  // Cầu 1-1 xen kẽ
  if (streak===1 && kqs.length>=6) {
    const alt = kqs.slice(-6).every((k,i) => i===0 || k!==kqs[kqs.length-6+i-1]);
    if (alt) { streakBias=opposite; streakDetail=`Cầu 1-1 xen kẽ → Tiếp tục`; strength=0.60; }
  }
  return { streakBias, streakDetail, streakLen:streak, strength };
}

// ════════════════════════════════════════════════════════════════
//  7. RSI MOMENTUM OSCILLATOR
// ════════════════════════════════════════════════════════════════
function calcRSI(arr, period = 10) {
  const v = arr.filter(x => x!==null);
  if (v.length < period+1) return { rsiBias:null, rsiDetail:'Chưa đủ dữ liệu RSI', rsiValue:null, strength:0 };
  const changes = v.slice(-period-1).map((val,i,a) => i>0?val-a[i-1]:0).slice(1);
  const gains   = changes.map(c => c>0?c:0);
  const losses  = changes.map(c => c<0?Math.abs(c):0);
  const avgGain = gains.reduce((a,b)=>a+b,0)/period;
  const avgLoss = losses.reduce((a,b)=>a+b,0)/period;
  if (avgLoss===0) {
    const rsiValue = 100;
    return { rsiBias:'X', rsiDetail:`RSI ${rsiValue} — Quá mua`, rsiValue, strength:0.90 };
  }
  const rs       = avgGain/avgLoss;
  const rsiValue = +(100 - 100/(1+rs)).toFixed(1);
  let rsiBias=null, rsiDetail='', strength=0.5;
  if (rsiValue>=75)      { rsiBias='X'; rsiDetail=`RSI ${rsiValue} — Quá mua mạnh`;   strength=0.90; }
  else if (rsiValue>=65) { rsiBias='X'; rsiDetail=`RSI ${rsiValue} — Vùng quá mua`;   strength=0.72; }
  else if (rsiValue<=25) { rsiBias='T'; rsiDetail=`RSI ${rsiValue} — Quá bán mạnh`;   strength=0.90; }
  else if (rsiValue<=35) { rsiBias='T'; rsiDetail=`RSI ${rsiValue} — Vùng quá bán`;   strength=0.72; }
  else if (rsiValue>=50) { rsiBias='T'; rsiDetail=`RSI ${rsiValue} — Vùng trung lập+`; strength=0.42; }
  else                   { rsiBias='X'; rsiDetail=`RSI ${rsiValue} — Vùng trung lập-`; strength=0.42; }
  return { rsiBias, rsiDetail, rsiValue, strength };
}

// ════════════════════════════════════════════════════════════════
//  8. MACD CROSSOVER
// ════════════════════════════════════════════════════════════════
function calcMACD(arr, fast=6, slow=13, signal=4) {
  const v = arr.filter(x => x!==null);
  if (v.length < slow+signal) return { macdBias:null, macdDetail:'Chưa đủ dữ liệu MACD', strength:0 };
  const ema = (data, period) => {
    const k = 2/(period+1);
    let e   = data.slice(0,period).reduce((a,b)=>a+b,0)/period;
    return data.slice(period).reduce((acc,val) => {
      e = val*k + e*(1-k);
      acc.push(e);
      return acc;
    }, [e]);
  };
  const emaFast   = ema(v, fast);
  const emaSlow   = ema(v, slow);
  const macdLine  = emaFast.slice(-emaSlow.length).map((f,i) => f - emaSlow[i]);
  if (macdLine.length < signal+1)
    return { macdBias:null, macdDetail:'Chưa đủ dữ liệu MACD', strength:0 };
  const signalLine = ema(macdLine, signal);
  const n          = Math.min(macdLine.length, signalLine.length);
  const ml         = macdLine.slice(-n);
  const sl         = signalLine.slice(-n);
  const curMacd    = ml[n-1], curSig = sl[n-1];
  const preMacd    = ml[n-2], preSig = sl[n-2];
  const histogram  = curMacd - curSig;
  let macdBias=null, macdDetail='', strength=0.5;
  if (preMacd<=preSig && curMacd>curSig) {
    macdBias='T'; macdDetail=`MACD Golden Cross ▲ hist=${histogram.toFixed(2)}`; strength=0.85;
  } else if (preMacd>=preSig && curMacd<curSig) {
    macdBias='X'; macdDetail=`MACD Death Cross ▼ hist=${histogram.toFixed(2)}`;  strength=0.85;
  } else if (curMacd>curSig && histogram>0) {
    macdBias='T'; macdDetail=`MACD Bullish hist=+${histogram.toFixed(2)}`; strength=0.58;
  } else {
    macdBias='X'; macdDetail=`MACD Bearish hist=${histogram.toFixed(2)}`;  strength=0.55;
  }
  return { macdBias, macdDetail, macdValue:+curMacd.toFixed(3), signalValue:+curSig.toFixed(3),
           histogram:+histogram.toFixed(3), strength };
}

// ════════════════════════════════════════════════════════════════
//  9. BOLLINGER BANDS
// ════════════════════════════════════════════════════════════════
function calcBollinger(arr, period=14, mult=2.0) {
  const v = arr.filter(x => x!==null);
  if (v.length < period) return { bollBias:null, bollDetail:'Chưa đủ dữ liệu Bollinger', strength:0, upper:null, lower:null, middle:null };
  const win  = v.slice(-period);
  const mean = win.reduce((a,b)=>a+b,0)/period;
  const std  = Math.sqrt(win.reduce((s,x)=>s+(x-mean)**2,0)/period);
  const upper = +(mean + mult*std).toFixed(2);
  const lower = +(mean - mult*std).toFixed(2);
  const bandwidth = +((upper-lower)/mean).toFixed(4);
  const cur       = v[v.length-1];
  let bollBias=null, bollDetail='', strength=0.5;
  const squeeze = bandwidth < 0.25;
  if (cur >= upper-0.3) {
    bollBias='X'; bollDetail=`BB Chạm dải trên ${upper}${squeeze?' | Squeeze':''}`; strength=0.82;
  } else if (cur <= lower+0.3) {
    bollBias='T'; bollDetail=`BB Chạm dải dưới ${lower}${squeeze?' | Squeeze':''}`; strength=0.82;
  } else if (squeeze) {
    bollBias=null; bollDetail=`BB Squeeze — Bandwidth ${(bandwidth*100).toFixed(1)}%`; strength=0.45;
  } else {
    const pct = (cur-lower)/(upper-lower);
    bollBias=pct>0.5?'T':'X';
    bollDetail=`BB %B=${(pct*100).toFixed(0)}% (${lower}–${upper})`; strength=0.40;
  }
  return { bollBias, bollDetail, upper, lower, middle:+mean.toFixed(2), bandwidth, strength };
}

// ════════════════════════════════════════════════════════════════
//  10. FIBONACCI RETRACEMENT
// ════════════════════════════════════════════════════════════════
function calcFibonacci(arr, lookback=20) {
  const v = arr.filter(x => x!==null).slice(-lookback);
  if (v.length < 6) return { fiboBias:null, fiboDetail:'Chưa đủ dữ liệu Fibo', strength:0 };
  const hi  = Math.max(...v);
  const lo  = Math.min(...v);
  const rng = hi - lo;
  if (rng < 2) return { fiboBias:null, fiboDetail:`Fibo range quá hẹp (${rng})`, strength:0 };
  const cur    = v[v.length-1];
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
    .map(r => ({ ratio:r, price: +(hi - r*rng).toFixed(2) }));
  let closest=null, minDist=Infinity;
  for (const lv of levels) {
    const d = Math.abs(cur - lv.price);
    if (d < minDist) { minDist=d; closest=lv; }
  }
  let fiboBias=null, fiboDetail='', strength=0.5;
  if (minDist <= 0.8) {
    const pct = (cur-lo)/rng;
    if (closest.ratio>=0.618) {
      fiboBias='T'; fiboDetail=`Fibo ${(closest.ratio*100).toFixed(1)}% Hỗ trợ mạnh (${closest.price})`; strength=0.80;
    } else if (closest.ratio<=0.382) {
      fiboBias='X'; fiboDetail=`Fibo ${(closest.ratio*100).toFixed(1)}% Kháng cự mạnh (${closest.price})`; strength=0.80;
    } else {
      fiboBias=pct>0.5?'T':'X';
      fiboDetail=`Fibo ${(closest.ratio*100).toFixed(1)}% (${closest.price}) — ${fiboBias==='T'?'vùng mua':'vùng bán'}`; strength=0.58;
    }
  } else {
    const pct = (cur-lo)/rng;
    fiboBias = pct>0.618?'X':pct<0.382?'T':null;
    fiboDetail = `Fibo range ${lo}–${hi} | cur=${cur} | ${fiboBias??'Trung lập'}`; strength=0.40;
  }
  return { fiboBias, fiboDetail, levels, hiLo:{ hi, lo }, strength };
}

// ════════════════════════════════════════════════════════════════
//  11. ATR TREND FILTER
// ════════════════════════════════════════════════════════════════
function calcATR(arr, period=10) {
  const v = arr.filter(x => x!==null);
  if (v.length < period+1) return { atr:null, trending:false };
  const trs = v.slice(-period-1).map((val,i,a) => i>0?Math.abs(val-a[i-1]):0).slice(1);
  const atr  = +(trs.reduce((a,b)=>a+b,0)/period).toFixed(3);
  return { atr, trending: atr >= 1.2 };
}

// ════════════════════════════════════════════════════════════════
//  12. ENTROPY ANALYSIS
// ════════════════════════════════════════════════════════════════
function calcEntropy(hist, win=30) {
  const kqs = hist.slice(-win).map(h => h.kq);
  if (kqs.length < 10) return { entropy:null, entropyDetail:'', bias:null };
  const t = kqs.filter(k=>k==='T').length;
  const x = kqs.length - t;
  const pt = t/kqs.length, px = x/kqs.length;
  const h  = -(pt>0?pt*Math.log2(pt):0) - (px>0?px*Math.log2(px):0);
  const entropy = +h.toFixed(4);
  let bias=null, entropyDetail='';
  if (pt > 0.65)      { bias='X'; entropyDetail=`Entropy ${entropy} — Quá lệch Tài (${t}/${kqs.length})`; }
  else if (px > 0.65) { bias='T'; entropyDetail=`Entropy ${entropy} — Quá lệch Xỉu (${x}/${kqs.length})`; }
  else                { entropyDetail=`Entropy ${entropy} — Cân bằng T${t}/X${x}`; }
  return { entropy, entropyDetail, bias, tCount:t, xCount:x };
}

// ════════════════════════════════════════════════════════════════
//  13. PATTERN HASH FINGERPRINTING
// ════════════════════════════════════════════════════════════════
function patternHash(hist, lookLen=5) {
  if (hist.length < lookLen*2+1) return { hashBias:null, hashDetail:'Chưa đủ dữ liệu hash', strength:0 };
  const kqs     = hist.map(h => h.kq);
  const pattern = kqs.slice(-(lookLen)).join('');
  const search  = kqs.slice(0, -(lookLen));
  const matches = [];
  for (let i=0; i<=search.length-lookLen; i++) {
    if (search.slice(i, i+lookLen).join('')===pattern)
      matches.push(kqs[i+lookLen]);
  }
  if (!matches.length) return { hashBias:null, hashDetail:`Hash "${pattern}" — Chưa từng gặp`, strength:0 };
  const tNext = matches.filter(m=>m==='T').length;
  const xNext = matches.filter(m=>m==='X').length;
  const total = matches.length;
  const bias  = tNext>=xNext?'T':'X';
  const pct   = Math.round(Math.max(tNext,xNext)/total*100);
  const strength = Math.min(1, 0.40 + total*0.06 + pct*0.003);
  return {
    hashBias:bias,
    hashDetail:`Hash "${pattern}" → ${tNext}T/${xNext}X (${pct}% ${fullLabel(bias)}) [${total} mẫu]`,
    pattern, matches:total, tNext, xNext, strength,
  };
}

// ════════════════════════════════════════════════════════════════
//  META ENSEMBLE v6
// ════════════════════════════════════════════════════════════════
function ensembleVote(signals) {
  const { pattern, slope, sr, dice, streak, rsi, macd, boll, fibo, hash, atr } = signals;
  let sT=0, sX=0, tW=0;
  const sources = [];
  const cast = (bias, w, name, detail, str=1) => {
    if (!bias) return;
    // ATR filter: nếu không trending, giảm trọng số slope/sr
    let eff = w * Math.min(1.3, Math.max(0.3, str));
    if (atr && !atr.trending && (name==='Slope/Momentum' || name==='Hỗ trợ/Kháng cự'))
      eff *= 0.7;
    if (bias==='T') sT+=eff; else sX+=eff;
    tW+=eff;
    sources.push({ name, bias, biasFull:fullLabel(bias), detail, weight:+eff.toFixed(3) });
  };
  if (streak?.streakBias)   cast(streak.streakBias,  CFG.W_STREAK,  'Cầu tâm lý',          streak.streakDetail,  streak.strength);
  if (pattern?.bias)        cast(pattern.bias,        CFG.W_PATTERN, 'Mẫu hình',             pattern.name,         pattern.strength ?? 0.7);
  if (hash?.hashBias)       cast(hash.hashBias,       CFG.W_HASH,    'Pattern Hash',         hash.hashDetail,      hash.strength);
  if (rsi?.rsiBias)         cast(rsi.rsiBias,         CFG.W_RSI,     'RSI Oscillator',       rsi.rsiDetail,        rsi.strength);
  if (macd?.macdBias)       cast(macd.macdBias,       CFG.W_MACD,    'MACD Crossover',       macd.macdDetail,      macd.strength);
  if (boll?.bollBias)       cast(boll.bollBias,       CFG.W_BOLL,    'Bollinger Band',       boll.bollDetail,      boll.strength);
  if (slope?.slopeBias)     cast(slope.slopeBias,     CFG.W_SLOPE,   'Slope/Momentum',       slope.detail,         slope.strength ?? 0.6);
  if (sr?.srBias)           cast(sr.srBias,           CFG.W_SR,      'Hỗ trợ/Kháng cự',     sr.srDetail,          0.8);
  if (fibo?.fiboBias)       cast(fibo.fiboBias,       CFG.W_FIBO,    'Fibonacci',            fibo.fiboDetail,      fibo.strength);
  if (dice?.diceBias)       cast(dice.diceBias,       CFG.W_DICE,    'Đồng pha Xúc xắc',    dice.diceDetail,      dice.convScore/3);
  if (!tW) return null;
  const rT=sT/tW, rX=sX/tW;
  const winner  = rT>=rX?'T':'X';
  const rawConf = Math.max(rT,rX);
  const conf    = calibrateConf(rawConf);
  const clarity = rawConf>=.74?'Rõ ràng':rawConf>=.63?'Khá rõ':rawConf>=.56?'Trung bình':'Không rõ';
  return { winner, winnerFull:fullLabel(winner), conf, rawConf:+rawConf.toFixed(4),
           clarity, votes:{ T:+sT.toFixed(3), X:+sX.toFixed(3) },
           votePct:{ T:`${(rT*100).toFixed(1)}%`, X:`${(rX*100).toFixed(1)}%` },
           sources, patternName:pattern?.name ?? null };
}

// ════════════════════════════════════════════════════════════════
//  MAIN PREDICT v6
// ════════════════════════════════════════════════════════════════
function predictV6(hist) {
  if (!hist || hist.length < CFG.MIN_HIST) return null;
  const slice   = hist.slice(-CFG.CANVAS_W);
  const canvasA = slice.map(h => typeof h.tong==='number'?h.tong:null);
  const pattern = scanPattern(canvasA);
  const slope   = analyzeSlope(canvasA, 8);
  const sr      = detectSR(canvasA, 2);
  const dice    = analyzeDice(slice, 8);
  const streak  = analyzeStreak(slice);
  const rsi     = calcRSI(canvasA, 10);
  const macd    = calcMACD(canvasA, 6, 13, 4);
  const boll    = calcBollinger(canvasA, 14, 2.0);
  const fibo    = calcFibonacci(canvasA, 20);
  const hash    = patternHash(slice, 5);
  const atr     = calcATR(canvasA, 10);
  const entropy = calcEntropy(slice, 30);
  const ens     = ensembleVote({ pattern, slope, sr, dice, streak, rsi, macd, boll, fibo, hash, atr });
  if (!ens) return null;
  return {
    ...ens,
    patternName: ens.patternName ?? 'Không nhận diện mẫu hình',
    canvasA, slice, streak,
    signals: { pattern, slope, sr, dice, streak, rsi, macd, boll, fibo, hash, atr, entropy },
  };
}

// ════════════════════════════════════════════════════════════════
//  FETCH & POLLING
// ════════════════════════════════════════════════════════════════
async function fetchAndUpdate() {
  try {
    const res   = await fetch(SOURCE_API, { signal: AbortSignal.timeout(10000) });
    const data  = await res.json();
    const items = Array.isArray(data.data)?data.data:Array.isArray(data)?data:[];
    if (!items.length) return null;
    const sorted   = [...items].sort((a,b) => a.session-b.session);
    const latest   = sorted[sorted.length-1];
    const knownSet = new Set(history.map(h => h.phien));
    for (const item of sorted) {
      const phien = String(item.session);
      if (knownSet.has(phien)) continue;
      const dice  = Array.isArray(item.dice)&&item.dice.length===3 ? item.dice.map(Number) : null;
      const tong  = typeof item.total==='number' ? item.total : (dice?dice.reduce((a,b)=>a+b,0):0);
      const kq    = item.result==='Tài'?'T':item.result==='Xỉu'?'X':kqLabel(tong);
      history.push({ phien, dice, tong, kq });
      knownSet.add(phien);
      if (pendingPred?.phien===phien) {
        const win = pendingPred.predicted===kq;
        winLoss.push({ phien, predicted:pendingPred.predicted, actual:kq, win, conf:pendingPred.conf });
        if (winLoss.length>200) winLoss=winLoss.slice(-100);
        pendingPred=null;
      }
    }
    if (history.length>CFG.MAX_HISTORY) history=history.slice(-CFG.MAX_HISTORY);
    const pred    = predictV6(history);
    const phienN  = String(Number(latest.session)+1);
    if (pred) pendingPred={ phien:phienN, predicted:pred.winner, conf:pred.conf };
    const recentWL = winLoss.slice(-50);
    const wins     = recentWL.filter(r=>r.win).length;
    const winRate  = recentWL.length?`${Math.round(wins/recentWL.length*100)}%`:'Chưa có';
    const latestTong = typeof latest.total==='number'?latest.total:(Array.isArray(latest.dice)?latest.dice.reduce((a,b)=>a+b,0):0);
    const latestKq   = kqLabel(latestTong);
    latestResult = {
      phien:          String(latest.session),
      xuc_xac:        Array.isArray(latest.dice)?latest.dice.map(Number):null,
      ket_qua:        fullLabel(latestKq),
      phien_hien_tai: phienN,
      du_doan:        pred?fullLabel(pred.winner):null,
      do_tin_cay:     pred?`${pred.conf}%`:null,
      muc_do:         pred?.clarity??null,
      pattern:        history.slice(-50).map(h=>h.kq).join(''),
      dev:            '@sewdangcap',
    };
    return latestResult;
  } catch(e) {
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
//  / — DASHBOARD HTML (Casino style)
// ════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const hist   = history.slice(-CFG.CANVAS_W);
  const pred   = predictV6(history);
  const latest = history[history.length-1];

  if (!latest) return res.send(`<!DOCTYPE html><html><body style="background:#0a0015;color:#e8d8ff;font-family:sans-serif;padding:2rem;text-align:center">
    <h2 style="color:#f5c842">⏳ Đang khởi động...</h2><p>Kết nối API nguồn...</p>
    <script>setTimeout(()=>location.reload(),3000)</script></body></html>`);

  const nxtPhien    = String(Number(latest.phien)+1);
  const taiCount50  = history.slice(-50).filter(h=>h.kq==='T').length;
  const xiuCount50  = history.slice(-50).length - taiCount50;
  const recentWL    = winLoss.slice(-50);
  const wr          = recentWL.length?Math.round(recentWL.filter(r=>r.win).length/recentWL.length*100)+'%':'—';
  const pattern50   = history.slice(-50).map(h=>h.kq).join('');
  const streak      = pred?.streak ?? analyzeStreak(hist);
  const boll        = pred?.signals?.boll ?? calcBollinger(hist.map(h=>h.tong),14,2.0);

  const chartAData  = JSON.stringify(hist.map(h=>h.tong));
  const chartBD1    = JSON.stringify(hist.map(h=>h.dice?h.dice[0]:null));
  const chartBD2    = JSON.stringify(hist.map(h=>h.dice?h.dice[1]:null));
  const chartBD3    = JSON.stringify(hist.map(h=>h.dice?h.dice[2]:null));
  const chartLabels = JSON.stringify(hist.map(h=>'#'+String(h.phien).slice(-4)));
  const bollUpper   = boll.upper;
  const bollLower   = boll.lower;
  const bollMiddle  = boll.middle;
  const predJson    = pred ? JSON.stringify({
    winner:pred.winner, winnerFull:fullLabel(pred.winner),
    conf:pred.conf, clarity:pred.clarity,
    pctT:pred.votePct.T, pctX:pred.votePct.X,
    patternName:pred.patternName??'—',
    sources:pred.sources,
    streak:streak,
  }) : 'null';

  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tài Xỉu — Chart Engine v6.0</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#0a0015;color:#e8d8ff;font-family:'Segoe UI',Tahoma,sans-serif;min-height:100vh}
.wrap{max-width:480px;margin:0 auto;padding:0 0 20px}
.title-bar{background:linear-gradient(180deg,#6a3fa0,#4a2070);text-align:center;padding:11px 16px;border-bottom:2px solid #8b5fd0;position:relative}
.title-bar::before,.title-bar::after{content:'';position:absolute;top:50%;transform:translateY(-50%);width:28px;height:2px;background:#f5c842}
.title-bar::before{left:10px}.title-bar::after{right:10px}
.title-bar h1{color:#f0e8ff;font-size:15px;font-weight:700;letter-spacing:1px}
.title-bar small{color:#b090d0;font-size:9px;display:block;margin-top:2px}
.session-info{text-align:center;padding:7px 0 1px;font-size:13px;font-weight:700;color:#f0d8ff}
.session-sub{text-align:center;font-size:12px;color:#c0a0f0;padding-bottom:4px}
.chart-section{padding:6px 10px}
.chart-lbl{font-size:9px;color:#7050a0;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px}
.chart-box{background:rgba(0,0,0,0.3);border:1px solid rgba(160,100,255,0.2);border-radius:8px;padding:8px 6px 4px}
.dice-leg{display:flex;justify-content:center;gap:16px;padding:5px 0 2px;font-size:10px}
.dl{display:flex;align-items:center;gap:4px}
.ld{width:11px;height:11px;border-radius:50%;border:2px solid rgba(255,255,255,0.4)}
.pred-box{margin:5px 10px;background:rgba(0,0,0,0.4);border:1px solid rgba(180,100,255,0.25);border-radius:10px;padding:10px 14px}
.pred-hdr{font-size:9px;color:#7050a0;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.pred-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pred-main{font-size:38px;font-weight:800;line-height:1}
.pred-main.tai{color:#00e676}.pred-main.xiu{color:#ff6b35}
.pred-pct{font-size:11px;color:#9070b0;margin-top:3px}
.pred-pat{font-size:10px;color:#b090d0;margin-top:2px}
.pred-streak{font-size:10px;margin-top:3px;padding:3px 8px;border-radius:4px;display:inline-block}
.pred-streak.warn{background:rgba(255,200,0,0.12);color:#f5c842;border:1px solid rgba(245,200,66,0.25)}
.pred-streak.safe{background:rgba(0,230,118,0.1);color:#00e676;border:1px solid rgba(0,230,118,0.2)}
.conf-wrap{text-align:center;flex-shrink:0}
.conf-ring{position:relative;width:76px;height:76px;display:inline-block}
.conf-ring canvas{position:absolute;top:0;left:0}
.conf-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.conf-pct{font-size:19px;font-weight:700}
.conf-lbl{font-size:9px;color:#8060a0;margin-top:1px}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:5px 10px}
.sig{background:rgba(0,0,0,0.3);border:1px solid rgba(160,100,255,0.15);border-radius:7px;padding:6px 9px}
.sig-name{font-size:9px;color:#6040a0;text-transform:uppercase;letter-spacing:.4px}
.sig-val{font-size:11px;font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sig-val.tai{color:#00e676}.sig-val.xiu{color:#ff6b35}.sig-val.neu{color:#c0a0e0}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:6px 10px}
.mc{background:rgba(0,0,0,0.3);border:1px solid rgba(160,100,255,0.15);border-radius:7px;padding:7px 6px;text-align:center}
.mc-l{font-size:8px;color:#6040a0;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
.mc-v{font-size:16px;font-weight:700}
.mc-s{font-size:9px;color:#7050a0;margin-top:1px}
.hist-box{margin:5px 10px;background:rgba(0,0,0,0.3);border:1px solid rgba(160,100,255,0.15);border-radius:8px;padding:8px 10px}
.hist-hdr{font-size:9px;color:#7050a0;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.hist-row{display:grid;grid-template-columns:44px 48px 1fr 30px;gap:4px;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px}
.hist-row:last-child{border-bottom:none}
.kq-pill{display:inline-block;padding:2px 6px;border-radius:20px;font-size:9px;font-weight:700;text-align:center}
.kq-pill.tai{background:rgba(0,230,118,0.12);color:#00e676;border:1px solid rgba(0,230,118,0.2)}
.kq-pill.xiu{background:rgba(255,107,53,0.12);color:#ff6b35;border:1px solid rgba(255,107,53,0.2)}
.dice-set{display:flex;gap:2px}
.d{width:15px;height:15px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff}
.d-r{background:#c0281e}.d-y{background:#b08900}.d-p{background:#6b28b0}
.pat-wrap{display:flex;flex-wrap:wrap;gap:2px;padding:6px 10px}
.pb{width:17px;height:17px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700}
.pb-t{background:rgba(0,230,118,0.15);color:#00e676}
.pb-x{background:rgba(255,107,53,0.15);color:#ff6b35}
.pat-stats{display:flex;justify-content:center;gap:18px;padding:3px 0 6px;font-size:11px}
.btns{display:flex;justify-content:space-around;padding:8px 10px 0;gap:8px}
.gbtn{flex:1;padding:9px 6px;border-radius:24px;border:none;font-size:11px;font-weight:800;letter-spacing:.8px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;transition:opacity .15s}
.gbtn:active{opacity:.75}
.gbtn-p{background:linear-gradient(180deg,#9060d0,#5a2888);color:#fff;border:2px solid #c080f0}
.gbtn-g{background:linear-gradient(180deg,#f0c030,#b08000);color:#2a1000;border:2px solid #f5c842}
.gbtn-r{background:linear-gradient(180deg,#ff4455,#b01020);color:#fff;border:2px solid #ff7788}
.footer{text-align:center;font-size:9px;color:rgba(180,120,255,0.3);padding:8px 0 0;display:flex;justify-content:center;gap:12px}
.footer a{color:rgba(160,100,255,0.5);text-decoration:none}
.live-dot{width:6px;height:6px;border-radius:50%;background:#00e676;display:inline-block;animation:pulse 1.4s infinite;margin-right:3px;vertical-align:middle}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
.v6-badge{display:inline-block;background:rgba(245,200,66,0.15);color:#f5c842;border:1px solid rgba(245,200,66,0.3);border-radius:3px;font-size:8px;padding:1px 5px;margin-left:6px;vertical-align:middle}
</style>
</head>
<body>
<div class="wrap">
<div class="title-bar">
  <h1>Tài Xỉu Chart Engine <span class="v6-badge">v6.0</span></h1>
  <small>10 Thuật toán · RSI · MACD · Bollinger · Fibonacci · Hash</small>
</div>
<div class="session-info">
  <span class="live-dot"></span>
  Phiên gần nhất: <b>#${latest.phien}</b>
</div>
<div class="session-sub">
  ${latest.kq==='T'?'Tài':'Xỉu'}(${latest.dice?latest.dice.join('-'):latest.tong})
</div>
<div class="metrics">
  <div class="mc">
    <div class="mc-l">Kết quả</div>
    <div class="mc-v" style="color:${latest.kq==='T'?'#00e676':'#ff6b35'};font-size:14px">${latest.kq==='T'?'TÀI':'XỈU'}</div>
    <div class="mc-s">${latest.tong}</div>
  </div>
  <div class="mc">
    <div class="mc-l">Dự đoán</div>
    <div class="mc-v" style="color:${pred?(pred.winner==='T'?'#00e676':'#ff6b35'):'#7050a0'};font-size:14px">${pred?fullLabel(pred.winner):'...'}</div>
    <div class="mc-s">#${nxtPhien.slice(-5)}</div>
  </div>
  <div class="mc">
    <div class="mc-l">Tài/Xỉu</div>
    <div class="mc-v" style="font-size:14px">${taiCount50}<span style="color:#5040a0">/</span>${xiuCount50}</div>
    <div class="mc-s">50 phiên</div>
  </div>
  <div class="mc">
    <div class="mc-l">Win rate</div>
    <div class="mc-v" style="color:#f5c842;font-size:14px">${wr}</div>
    <div class="mc-s">${recentWL.length}p theo dõi</div>
  </div>
</div>
<!-- CHART A with Bollinger -->
<div class="chart-section">
  <div class="chart-lbl">Chart A — Đường Tổng + Bollinger Bands</div>
  <div class="chart-box">
    <div style="position:relative;height:190px"><canvas id="cvA"></canvas></div>
  </div>
</div>
<!-- CHART B -->
<div class="chart-section" style="padding-top:3px">
  <div class="chart-lbl">Chart B — 3 Xúc Xắc (1–6)</div>
  <div class="chart-box">
    <div style="position:relative;height:155px"><canvas id="cvB"></canvas></div>
  </div>
  <div class="dice-leg">
    <div class="dl"><div class="ld" style="background:#d03040;border-color:#ff8090"></div><span style="color:#ff8090">Xúc xắc 1</span></div>
    <div class="dl"><div class="ld" style="background:#c09000;border-color:#f5c842"></div><span style="color:#f5c842">Xúc xắc 2</span></div>
    <div class="dl"><div class="ld" style="background:#7030b0;border-color:#b060e0"></div><span style="color:#b060e0">Xúc xắc 3</span></div>
  </div>
</div>
<!-- PREDICTION -->
${pred?`
<div class="pred-box">
  <div class="pred-hdr">Dự đoán phiên #${nxtPhien.slice(-5)}</div>
  <div class="pred-row">
    <div>
      <div class="pred-main ${pred.winner==='T'?'tai':'xiu'}">${fullLabel(pred.winner)}</div>
      <div class="pred-pct">Tài ${pred.votePct.T} · Xỉu ${pred.votePct.X}</div>
      <div class="pred-pat">${pred.patternName??'—'}</div>
      ${streak?.streakDetail?`<div class="pred-streak ${streak.streakLen>=3?'warn':'safe'}">⚡ ${streak.streakDetail}</div>`:''}
    </div>
    <div class="conf-wrap">
      <div class="conf-ring">
        <canvas id="cvConf" width="76" height="76"></canvas>
        <div class="conf-center">
          <span class="conf-pct" style="color:${pred.winner==='T'?'#00e676':'#ff6b35'}">${pred.conf}%</span>
          <span class="conf-lbl">${pred.clarity}</span>
        </div>
      </div>
    </div>
  </div>
</div>`:`<div class="pred-box" style="text-align:center;padding:1.2rem;color:#6040a0">Đang phân tích...</div>`}
<!-- SIGNALS (show up to 8) -->
<div class="sigs">
  ${(pred?.sources??[]).slice(0,8).map(s=>`
  <div class="sig">
    <div class="sig-name">${s.name}</div>
    <div class="sig-val ${s.bias==='T'?'tai':s.bias==='X'?'xiu':'neu'}">${s.biasFull??'—'} · ${s.detail.slice(0,26)}</div>
  </div>`).join('')}
</div>
<!-- HISTORY -->
<div class="hist-box">
  <div class="hist-hdr">Lịch sử 15 phiên gần nhất</div>
  ${history.slice(-15).reverse().map(h=>`
  <div class="hist-row">
    <span style="color:#6040a0">#${String(h.phien).slice(-5)}</span>
    <span class="kq-pill ${h.kq==='T'?'tai':'xiu'}">${fullLabel(h.kq)}</span>
    <span class="dice-set">${h.dice?['d-r','d-y','d-p'].map((c,i)=>`<span class="d ${c}">${h.dice[i]}</span>`).join(''):'–'}</span>
    <span style="font-weight:700;text-align:right;color:${h.kq==='T'?'#00e676':'#ff6b35'}">${h.tong}</span>
  </div>`).join('')}
</div>
<!-- PATTERN 50 -->
<div class="pat-wrap">
  ${pattern50.split('').map(c=>`<span class="pb ${c==='T'?'pb-t':'pb-x'}">${c}</span>`).join('')}
</div>
<div class="pat-stats">
  <span style="color:#00e676;font-weight:700">T: ${taiCount50}</span>
  <span style="color:#4030a0">|</span>
  <span style="color:#ff6b35;font-weight:700">X: ${xiuCount50}</span>
  <span style="color:#4030a0">|</span>
  <span style="color:#8060b0;font-size:10px">${((taiCount50/Math.max(1,taiCount50+xiuCount50))*100).toFixed(0)}% Tài</span>
</div>
<!-- BUTTONS -->
<div class="btns">
  <button class="gbtn gbtn-p"><span>✔</span> XÍ NGẦU</button>
  <button class="gbtn gbtn-g"><span>✔</span> XÍ NGẦU</button>
  <button class="gbtn gbtn-r"><span>✔</span> XÍ NGẦU</button>
</div>
<!-- FOOTER -->
<div class="footer">
  <span>Chart Engine v6.0 · @sewdangcap</span>
  <a href="/sunlon">API</a>
  <a href="/signals">Signals</a>
  <a href="/thongke">Thống kê</a>
  <a href="/history">History</a>
</div>
</div>

<script>
const DATA_A    = ${chartAData};
const DATA_B1   = ${chartBD1};
const DATA_B2   = ${chartBD2};
const DATA_B3   = ${chartBD3};
const LABELS    = ${chartLabels};
const PRED      = ${predJson};
const TAI_LINE  = ${CFG.TAI_LINE};
const BOLL_UP   = ${bollUpper??'null'};
const BOLL_LO   = ${bollLower??'null'};
const BOLL_MID  = ${bollMiddle??'null'};

const ptColors = DATA_A.map(v=>v===null?'rgba(255,255,255,.2)':v>=TAI_LINE?'#00e676':'#ff6b35');
const ptSizes  = DATA_A.map((_,i)=>i===DATA_A.length-1?8:4);

const bollUpArr  = DATA_A.map(()=>BOLL_UP);
const bollLoArr  = DATA_A.map(()=>BOLL_LO);
const bollMidArr = DATA_A.map(()=>BOLL_MID);

new Chart(document.getElementById('cvA'),{
  type:'line',
  data:{ labels:LABELS, datasets:[
    { data:DATA_A, borderColor:'rgba(220,200,255,0.7)', backgroundColor:'rgba(120,60,200,0.06)',
      borderWidth:2, pointBackgroundColor:ptColors, pointBorderColor:'rgba(255,255,255,0.15)',
      pointBorderWidth:2, pointRadius:ptSizes, tension:0.28, fill:true, order:1 },
    { data:bollUpArr,  borderColor:'rgba(245,200,66,0.45)', borderWidth:1.5, borderDash:[4,3],
      pointRadius:0, tension:0, fill:false, label:'BB Upper', order:2 },
    { data:bollLoArr,  borderColor:'rgba(100,200,255,0.45)', borderWidth:1.5, borderDash:[4,3],
      pointRadius:0, tension:0, fill:false, label:'BB Lower', order:3 },
    { data:bollMidArr, borderColor:'rgba(200,150,255,0.25)', borderWidth:1, borderDash:[2,4],
      pointRadius:0, tension:0, fill:false, label:'BB Mid', order:4 },
  ]},
  options:{
    responsive:true,maintainAspectRatio:false,
    plugins:{
      legend:{display:false},
      tooltip:{backgroundColor:'rgba(10,0,21,0.95)',titleColor:'#b090d0',bodyColor:'#f0d8ff',
        borderColor:'rgba(160,100,255,0.3)',borderWidth:1,
        callbacks:{label:c=>c.dataset.label&&c.dataset.label!=='undefined'?
          c.dataset.label+': '+c.parsed.y:
          'Tổng: '+c.parsed.y+' — '+(c.parsed.y>=TAI_LINE?'TÀI':'XỈU')}}
    },
    scales:{
      x:{ticks:{font:{size:8},color:'rgba(180,130,255,0.45)',maxTicksLimit:12,maxRotation:0},
         grid:{color:'rgba(140,80,200,0.1)'},border:{color:'rgba(140,80,200,0.2)'}},
      y:{min:2,max:19,
         ticks:{font:{size:8},color:'rgba(180,130,255,0.45)',stepSize:3,callback:v=>v===TAI_LINE?v+'—':v},
         grid:{color:ctx=>ctx.tick.value===TAI_LINE?'rgba(245,200,66,0.22)':'rgba(140,80,200,0.1)'},
         border:{color:'rgba(140,80,200,0.2)'}},
    }
  }
});

new Chart(document.getElementById('cvB'),{
  type:'line',
  data:{ labels:LABELS, datasets:[
    {label:'D1',data:DATA_B1,borderColor:'#d03040',backgroundColor:'transparent',borderWidth:2,pointBackgroundColor:'#d03040',pointRadius:4,tension:0.28},
    {label:'D2',data:DATA_B2,borderColor:'#b09000',backgroundColor:'transparent',borderWidth:2,pointBackgroundColor:'#b09000',pointRadius:4,tension:0.28},
    {label:'D3',data:DATA_B3,borderColor:'#7030b0',backgroundColor:'transparent',borderWidth:2,pointBackgroundColor:'#7030b0',pointRadius:4,tension:0.28},
  ]},
  options:{
    responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(10,0,21,0.95)',titleColor:'#b090d0',bodyColor:'#f0d8ff',borderColor:'rgba(160,100,255,0.3)',borderWidth:1}},
    scales:{
      x:{ticks:{font:{size:8},color:'rgba(180,130,255,0.45)',maxTicksLimit:12,maxRotation:0},grid:{color:'rgba(140,80,200,0.1)'},border:{color:'rgba(140,80,200,0.2)'}},
      y:{min:0,max:7,ticks:{font:{size:8},color:'rgba(180,130,255,0.45)',stepSize:1},grid:{color:'rgba(140,80,200,0.1)'},border:{color:'rgba(140,80,200,0.2)'}},
    }
  }
});

if(PRED){
  const cv=document.getElementById('cvConf');
  if(cv){
    const ctx=cv.getContext('2d');
    const col=PRED.winner==='T'?'#00e676':'#ff6b35';
    const pct=PRED.conf/100;
    ctx.clearRect(0,0,76,76);
    ctx.beginPath();ctx.arc(38,38,28,0,Math.PI*2);ctx.strokeStyle='rgba(255,255,255,0.07)';ctx.lineWidth=5;ctx.stroke();
    ctx.beginPath();ctx.arc(38,38,28,-Math.PI/2,-Math.PI/2+Math.PI*2*pct);ctx.strokeStyle=col;ctx.lineWidth=5;ctx.lineCap='round';ctx.stroke();
  }
}

setTimeout(()=>location.reload(), ${CFG.POLL_MS});
</script>
</body>
</html>`);
});

// ════════════════════════════════════════════════════════════════
//  /sunlon — JSON dự đoán
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
//  /canvas — Snapshot 2 biểu đồ
// ════════════════════════════════════════════════════════════════
app.get('/canvas', (req, res) => {
  if (history.length < CFG.MIN_HIST) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const slice  = history.slice(-CFG.CANVAS_W);
  const phiens = slice.map(h => Number(h.phien));
  res.json({
    id:'@sewdangcap',
    canvas_width:slice.length,
    chart_A:{
      mo_ta:'Đường Tổng — trục Y: 3–18 — Tài≥11 / Xỉu<11',
      y_min:3,y_max:18,
      data:phiens.map((p,i)=>({ phien:p, tong:slice[i].tong, kq:fullLabel(slice[i].kq) })),
    },
    chart_B:{
      mo_ta:'3 Đường Xúc Xắc — Đỏ/Vàng/Tím — trục Y: 1–6',
      y_min:1,y_max:6,
      data:phiens.map((p,i)=>({ phien:p, d1:slice[i].dice?.[0]??null, d2:slice[i].dice?.[1]??null, d3:slice[i].dice?.[2]??null })),
    },
  });
});

// ════════════════════════════════════════════════════════════════
//  /signals — Chi tiết 10 tín hiệu v6
// ════════════════════════════════════════════════════════════════
app.get('/signals', (req, res) => {
  if (history.length < CFG.MIN_HIST) return res.status(503).json({ error: 'Chưa đủ dữ liệu' });
  const slice   = history.slice(-CFG.CANVAS_W);
  const canvasA = slice.map(h => h.tong);
  const pred    = predictV6(history);
  const sig     = pred?.signals ?? {};
  const ens     = pred ? { du_doan:fullLabel(pred.winner), do_tin_cay:`${pred.conf}%`, muc_do:pred.clarity, ty_le:pred.votePct } : null;
  res.json({
    id:'@sewdangcap',
    phien_du_doan: latestResult?.phien_hien_tai ?? null,
    ket_luan: ens,
    tin_hieu:{
      '1_geometric_pattern':  sig.pattern ? { ten:sig.pattern.name, bias:fullLabel(sig.pattern.bias), suc_manh:+sig.pattern.strength.toFixed(2) } : { ten:'Không nhận diện', bias:null },
      '2_slope_momentum':     sig.slope   ? { slope:sig.slope.slope, proj:sig.slope.proj, bias:fullLabel(sig.slope.slopeBias), chi_tiet:sig.slope.detail } : { chi_tiet:'N/A' },
      '3_support_resistance': { bias:fullLabel(sig.sr?.srBias), chi_tiet:sig.sr?.srDetail, zones:sig.sr?.zones },
      '4_dice_convergence':   { bias:fullLabel(sig.dice?.diceBias), chi_tiet:sig.dice?.diceDetail, conv:`${sig.dice?.convScore}/3` },
      '5_streak_cam_ly':      { bias:fullLabel(sig.streak?.streakBias), chi_tiet:sig.streak?.streakDetail, do_dai:sig.streak?.streakLen },
      '6_rsi':                { rsi:sig.rsi?.rsiValue, bias:fullLabel(sig.rsi?.rsiBias), chi_tiet:sig.rsi?.rsiDetail },
      '7_macd':               { macd:sig.macd?.macdValue, signal:sig.macd?.signalValue, hist:sig.macd?.histogram, bias:fullLabel(sig.macd?.macdBias), chi_tiet:sig.macd?.macdDetail },
      '8_bollinger':          { upper:sig.boll?.upper, lower:sig.boll?.lower, middle:sig.boll?.middle, bandwidth:sig.boll?.bandwidth, bias:fullLabel(sig.boll?.bollBias), chi_tiet:sig.boll?.bollDetail },
      '9_fibonacci':          { bias:fullLabel(sig.fibo?.fiboBias), chi_tiet:sig.fibo?.fiboDetail },
      '10_pattern_hash':      { bias:fullLabel(sig.hash?.hashBias), chi_tiet:sig.hash?.hashDetail, matches:sig.hash?.matches },
      'atr_filter':           { atr:sig.atr?.atr, trending:sig.atr?.trending },
      'entropy':              { value:sig.entropy?.entropy, chi_tiet:sig.entropy?.entropyDetail },
    },
    trong_so:{
      'Streak':   CFG.W_STREAK,
      'Pattern':  CFG.W_PATTERN,
      'Hash':     CFG.W_HASH,
      'RSI':      CFG.W_RSI,
      'MACD':     CFG.W_MACD,
      'Bollinger':CFG.W_BOLL,
      'Slope':    CFG.W_SLOPE,
      'SR':       CFG.W_SR,
      'Fibonacci':CFG.W_FIBO,
      'Dice':     CFG.W_DICE,
    },
    nguon_bieu_quyet: pred?.sources ?? [],
  });
});

// ════════════════════════════════════════════════════════════════
//  /thongke — Win rate tracking
// ════════════════════════════════════════════════════════════════
app.get('/thongke', (req, res) => {
  const slice = winLoss.slice(-50).reverse();
  const wins  = slice.filter(r=>r.win).length;
  const rate  = slice.length?Math.round(wins/slice.length*100):0;
  let streak=0, st=null;
  for (const r of slice) { if(st===null){st=r.win;streak=1;}else if(r.win===st)streak++;else break; }
  res.json({
    id:'@sewdangcap',
    tong_quan:{ tong_phien:slice.length, thang:wins, thua:slice.length-wins, win_rate:`${rate}%`,
                streak:streak>0?`${streak} ${st?'THẮNG':'THUA'} liên tiếp`:'Chưa có' },
    chi_tiet:slice.map((r,i)=>({ stt:i+1, phien:Number(r.phien), du_doan:fullLabel(r.predicted),
                                  ket_qua_thuc:fullLabel(r.actual), do_tin_cay:`${r.conf}%`,
                                  ket_luan:r.win?'✅ THẮNG':'❌ THUA' })),
  });
});

// ════════════════════════════════════════════════════════════════
//  /history — Lịch sử phiên
// ════════════════════════════════════════════════════════════════
app.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit)||50, 500);
  res.json({
    id:'@sewdangcap',
    tong:history.length,
    data:history.slice(-limit).reverse().map(h=>({
      phien:Number(h.phien), xuc_xac:h.dice,
      phan_loai:h.dice?classifyDice(h.dice):'-',
      tong:h.tong, ket_qua:fullLabel(h.kq),
    })),
  });
});

// ════════════════════════════════════════════════════════════════
//  404
// ════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({
  error:'Endpoint không tồn tại',
  endpoints:['/', '/sunlon', '/canvas', '/signals', '/thongke', '/history'],
}));

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`
╔═══════════════════════════════════════════════════════╗
║   Virtual Chart Engine v6.0 — @sewdangcap            ║
║   http://localhost:${PORT}                               ║
╠═══════════════════════════════════════════════════════╣
║   10 Algorithms: Pattern · Slope · SR · Dice         ║
║                  Streak · RSI · MACD · Bollinger      ║
║                  Fibonacci · PatternHash              ║
║   + ATR Filter · Entropy Analysis                    ║
╠═══════════════════════════════════════════════════════╣
║   /          → Dashboard HTML                        ║
║   /sunlon    → JSON dự đoán                          ║
║   /canvas    → JSON biểu đồ                         ║
║   /signals   → JSON 10 tín hiệu                     ║
║   /thongke   → JSON winrate                         ║
║   /history   → JSON lịch sử                         ║
╚═══════════════════════════════════════════════════════╝
`));
