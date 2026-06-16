"use strict";
const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://apilichsusunwinsew.onrender.com/api/taixiu/history?limit=50";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 800;

let history = [];

// ═══════════════════════════════════════════════
//  DATA INGESTION
// ═══════════════════════════════════════════════
function fetchSource() {
  return new Promise((resolve, reject) => {
    const u = new URL(SOURCE_URL);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try   { resolve({ ok: true,  body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, raw: raw.slice(0, 1200) }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseSession(s) {
  if (!s || typeof s !== "object") return null;
  const phien = String(s.session ?? s.id ?? s._id ?? s.phien ?? s.sessionId ?? s.session_id ?? "?");
  let dice = null;
  for (const f of ["dice","dices","xucXac","xuc_xac","cubes","cube","results"]) {
    if (Array.isArray(s[f]) && s[f].length >= 3) {
      const d = s[f].slice(0,3).map(Number);
      if (d.every(x => x >= 1 && x <= 6)) { dice = d; break; }
    }
  }
  if (!dice && s.d1 && s.d2 && s.d3) {
    const d = [Number(s.d1), Number(s.d2), Number(s.d3)];
    if (d.every(x => x >= 1 && x <= 6)) dice = d;
  }
  if (!dice) return null;
  const tong = typeof s.total === "number" ? s.total
             : typeof s.point === "number" ? s.point
             : typeof s.sum   === "number" ? s.sum
             : dice.reduce((a,b) => a+b, 0);
  const r = (s.result ?? s.resultTruyenThong ?? s.ketQua ?? s.ket_qua ?? s.type ?? "").toString().toUpperCase();
  let type;
  if      (r.includes("TAI") || r.includes("TÀI") || r === "T" || r === "BIG"   || r === "1") type = "T";
  else if (r.includes("XIU") || r.includes("XỈU") || r === "X" || r === "SMALL" || r === "0") type = "X";
  else type = tong >= 11 ? "T" : "X";
  return { phien, dice, tong, type };
}

function ingest(list) {
  const existing = new Set(history.map(h => h.phien));
  for (const item of list.map(parseSession).filter(Boolean)) {
    if (!existing.has(item.phien)) { history.push(item); existing.add(item.phien); }
  }
  history.sort((a,b) => Number(b.phien) - Number(a.phien));
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
}

async function syncHistory() {
  try {
    const res = await fetchSource();
    if (!res.ok || !res.body) return;
    const body = res.body;
    const list = Array.isArray(body) ? body
               : body.data ?? body.list ?? body.history ?? body.sessions ?? body.items ?? [];
    if (Array.isArray(list)) ingest(list);
  } catch (_) {}
}

// ═══════════════════════════════════════════════
//  MATH HELPERS
// ═══════════════════════════════════════════════
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s,v) => s+v, 0) / arr.length;
}
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s,v) => s+(v-m)**2, 0) / arr.length);
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0,n)), mb = mean(b.slice(0,n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i]-ma, bi = b[i]-mb;
    num += ai*bi; da += ai*ai; db += bi*bi;
  }
  if (!da || !db) return 0;
  return num / Math.sqrt(da * db);
}
function normalize(arr) {
  const m = mean(arr), s = stdDev(arr) || 1;
  return arr.map(v => (v-m)/s);
}
// Temporal decay weight: recent sessions count more
function decayWeight(age, halfLife = 50) {
  return Math.pow(0.5, age / halfLife);
}

// ═══════════════════════════════════════════════
//  THRESHOLDS — STRICT
// ═══════════════════════════════════════════════
const MIN_WR       = 0.55;   // Minimum win rate to qualify
const MIN_N        = 15;     // Minimum sample count
const MIN_AGREE    = 3;      // Minimum signals in agreement to output prediction
const MUTE_WR      = 0.40;   // If recent accuracy below this → mute that algo
const RECENT_CHECK = 20;     // Sessions to check for recent accuracy
const ROLL_WINDOW  = 200;    // Rolling window for pattern building

// ═══════════════════════════════════════════════
//  ADAPTIVE MUTE SYSTEM
//  Tracks recent accuracy per algo; mutes if performing poorly
// ═══════════════════════════════════════════════
const algoRecentPerf = {}; // { algoName: { wins, total, muted } }

function recordAlgoResult(name, correct) {
  if (!algoRecentPerf[name]) algoRecentPerf[name] = { buf: [], muted: false };
  const p = algoRecentPerf[name];
  p.buf.push(correct ? 1 : 0);
  if (p.buf.length > RECENT_CHECK) p.buf.shift();
  if (p.buf.length >= 10) {
    const wr = p.buf.reduce((s,v)=>s+v,0) / p.buf.length;
    p.muted = wr < MUTE_WR;
    p.recentWR = wr;
  }
}

function isMuted(name) {
  return (algoRecentPerf[name]?.muted) === true;
}

function getRecentWR(name) {
  const p = algoRecentPerf[name];
  if (!p || p.buf.length < 5) return null;
  return p.buf.reduce((s,v)=>s+v,0) / p.buf.length;
}

// ═══════════════════════════════════════════════
//  ROLLING WINDOW BACKTEST HELPER
//  Builds model on [trainStart, trainEnd) and tests on trainStart-1
//  Strict holdout — test point never in training
// ═══════════════════════════════════════════════
function rollingTest(hist, buildFn, windowSize = ROLL_WINDOW, testSize = 40) {
  const results = [];
  for (let i = 1; i <= testSize && i + windowSize < hist.length; i++) {
    const train = hist.slice(i, i + windowSize);
    const actual = hist[i-1].type;
    const pred = buildFn(train);
    if (pred === null) { results.push(null); continue; }
    results.push(pred === actual ? 1 : 0);
  }
  const valid = results.filter(r => r !== null);
  if (!valid.length) return { wr: null, n: 0, skipped: results.filter(r=>r===null).length };
  return {
    wr: valid.reduce((s,v)=>s+v,0) / valid.length,
    n: valid.length,
    skipped: results.filter(r=>r===null).length
  };
}

// ═══════════════════════════════════════════════
//  ══════════════════════════════════════════
//  THUẬT TOÁN — ROLLING WINDOW VERSIONS
//  Mỗi algo phải trả về { signal, winRate, sampleCount, source, detail }
//  hoặc null nếu không đủ điều kiện
//  ══════════════════════════════════════════
// ═══════════════════════════════════════════════

// ─── A1: MARKOV CHAIN (Rolling) ───────────────
// Chỉ dùng ROLL_WINDOW phiên gần để build bảng
// Test trên strict holdout
function algoMarkov(hist, order) {
  const name = `Markov-${order}`;
  if (isMuted(name)) return null;
  const data = hist.slice(0, ROLL_WINDOW);
  if (data.length < order + MIN_N + 5) return null;

  const seq = data.map(h => h.type);

  // Build on all but predict on [0]
  const trainSeq = seq.slice(1); // train excludes most recent
  const table = {};
  for (let p = 0; p + order < trainSeq.length; p++) {
    const key = trainSeq.slice(p, p+order).join("");
    const outcome = trainSeq[p+order] ?? null; // wrong direction — fix:
    // Actually we want: given state at p→p+order, what comes BEFORE (newer)
    // seq is newest-first, so seq[0]=newest
    // State = seq[p..p+order-1], outcome = seq[p-1] (one step newer)
    void outcome; // discard above
  }

  // Correct direction: newest-first seq
  // State = seq[p..p+order-1], predict seq[p-1]
  const tbl = {};
  for (let p = order; p < trainSeq.length; p++) {
    const key = trainSeq.slice(p - order, p).join(""); // older context
    const outcome = trainSeq[p - order - 1] ?? null;   // This is wrong too
    void key; void outcome;
  }

  // CORRECT: seq[0] = newest. State = seq[1..order] (what happened), predict seq[0]
  // For training: for each p in [1..len-order-1]:
  //   state = seq[p+1 .. p+order]  (the order sessions before p)
  //   outcome = seq[p]              (what came after that state)
  //   but p=0 is what we predict, so train on p=1..end
  const fullSeq = seq; // newest first
  const trainTable = {};
  for (let p = 1; p + order < fullSeq.length; p++) {
    const stateKey = fullSeq.slice(p, p + order).join(""); // older context (more past)
    const outcome  = fullSeq[p - 1]; // what came next (more recent)
    if (!trainTable[stateKey]) trainTable[stateKey] = { T:0, X:0 };
    trainTable[stateKey][outcome]++;
  }

  const curState = fullSeq.slice(1, 1 + order).join(""); // current context
  const c = trainTable[curState];
  if (!c || (c.T + c.X) < MIN_N) return null;

  const signal = c.T >= c.X ? "T" : "X";
  const wr = Math.max(c.T, c.X) / (c.T + c.X);
  if (wr < MIN_WR) return null;

  // Recent accuracy check
  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  return {
    signal, winRate: wr, sampleCount: c.T + c.X, source: name,
    detail: `State[${curState}]→${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% N=${c.T+c.X}${recentWR!==null?" Gần="+Math.round(recentWR*100)+"%":""}`,
    recentWR
  };
}

// ─── A2: MARKOV ADAPTIVE (đảo tự động) ────────
// Phát hiện khi Markov đang sai liên tục → đảo
function algoMarkovInvert(hist) {
  const name = "M-Invert";
  const seq = hist.slice(0, 60).map(h => h.type);
  if (seq.length < 30) return null;

  // Simulate Markov-1 on recent 30
  const W = 30;
  const recentSeq = seq.slice(0, W);
  let wrong = 0, total = 0;

  const tbl = {};
  for (let p = 1; p < recentSeq.length; p++) {
    const k = recentSeq[p]; const o = recentSeq[p-1];
    if (!tbl[k]) tbl[k] = {T:0,X:0};
    tbl[k][o]++;
  }

  for (let p = 1; p < W - 1; p++) {
    const state = recentSeq[p+1];
    const c = tbl[state];
    if (!c || (c.T+c.X) === 0) continue;
    const pred = c.T >= c.X ? "T" : "X";
    if (pred !== recentSeq[p]) wrong++;
    total++;
  }

  if (total < 8) return null;
  const errorRate = wrong / total;
  // Only invert when Markov is consistently wrong (>62% error = we flip to get 62% right)
  if (errorRate < 0.60) return null;

  // Get what Markov-1 would predict, then flip it
  const curState = seq[1];
  const c2 = tbl[curState];
  if (!c2 || (c2.T+c2.X) === 0) return null;
  const markovSays = c2.T >= c2.X ? "T" : "X";
  const signal = markovSays === "T" ? "X" : "T";
  const wr = errorRate; // our inverted win rate

  return {
    signal, winRate: wr, sampleCount: total, source: name,
    detail: `Markov gãy ${(errorRate*100).toFixed(0)}%/30p → đảo sang ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`
  };
}

// ─── A3: STREAK ANALYSIS (cải tiến với decay) ─
function algoStreak(hist) {
  const name = "Streak";
  if (isMuted(name)) return null;
  const seq = hist.slice(0, ROLL_WINDOW).map(h => h.type);
  if (seq.length < MIN_N + 5) return null;

  const curType = seq[0];
  let curStreak = 0;
  for (const t of seq) { if (t === curType) curStreak++; else break; }
  if (curStreak < 2 || curStreak > 12) return null; // Ignore mega-streaks (random noise)

  // Build streak outcome table with temporal decay
  let wBreak = 0, wCont = 0, totalW = 0;
  for (let p = 1; p + curStreak < seq.length; p++) {
    const t = seq[p];
    let len = 0;
    for (let j = p; j < seq.length && seq[j] === t; j++) len++;
    if (len !== curStreak) continue;
    if (p + curStreak < seq.length && seq[p + curStreak] === t) continue;
    const outcome = seq[p-1];
    const w = decayWeight(p, 60); // recent matches count more
    if (outcome !== t) wBreak += w;
    else wCont += w;
    totalW += w;
  }

  if (totalW < 0.5) return null;
  const breakRate = wBreak / totalW;
  const contRate  = wCont  / totalW;
  // Estimate sample count (unweighted)
  let rawTotal = 0;
  for (let p = 1; p + curStreak < seq.length; p++) {
    const t = seq[p]; let len = 0;
    for (let j = p; j < seq.length && seq[j] === t; j++) len++;
    if (len === curStreak && !(p + curStreak < seq.length && seq[p+curStreak] === t)) rawTotal++;
  }
  if (rawTotal < MIN_N) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  if (breakRate > MIN_WR) {
    const sig = curType === "T" ? "X" : "T";
    return { signal: sig, winRate: breakRate, sampleCount: rawTotal, source: name,
      detail: `Bệt ${curStreak}×${curType==="T"?"Tài":"Xỉu"}→đảo WR=${(breakRate*100).toFixed(0)}%(decay) N=${rawTotal}`, recentWR };
  }
  if (contRate > MIN_WR) {
    return { signal: curType, winRate: contRate, sampleCount: rawTotal, source: name,
      detail: `Bệt ${curStreak}×${curType==="T"?"Tài":"Xỉu"}→tiếp WR=${(contRate*100).toFixed(0)}%(decay) N=${rawTotal}`, recentWR };
  }
  return null;
}

// ─── A4: PATTERN MATCH (strict holdout) ────────
// Tìm block 6 phiên giống nhất, chỉ đếm trên train data
function algoPattern(hist) {
  const name = "Pattern6";
  if (isMuted(name)) return null;
  const data = hist.slice(0, ROLL_WINDOW);
  if (data.length < 6 + MIN_N + 2) return null;
  const seq = data.map(h => h.type);
  const curBlock = seq.slice(0, 6).join("");

  let wT = 0, wX = 0, rawN = 0;
  for (let p = 1; p + 6 < seq.length; p++) {
    if (seq.slice(p, p+6).join("") !== curBlock) continue;
    const outcome = seq[p-1];
    const w = decayWeight(p, 80);
    if (outcome === "T") wT += w; else wX += w;
    rawN++;
  }
  if (rawN < MIN_N) return null;
  const total = wT + wX;
  if (total < 0.001) return null;
  const signal = wT >= wX ? "T" : "X";
  const wr = Math.max(wT, wX) / total;
  if (wr < MIN_WR) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  return { signal, winRate: wr, sampleCount: rawN, source: name,
    detail: `Block[${curBlock}]→${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%(decay) N=${rawN}`, recentWR };
}

// ─── A5: ALTERNATING DETECTION ─────────────────
function algoAlternating(hist) {
  const name = "XenKe";
  if (isMuted(name)) return null;
  const seq = hist.slice(0, ROLL_WINDOW).map(h => h.type);
  if (seq.length < MIN_N + 4) return null;

  let altLen = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i-1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;

  const expected = seq[0] === "T" ? "X" : "T";
  let wWin = 0, wTotal = 0, rawN = 0;
  for (let p = 1; p + altLen < seq.length; p++) {
    let L = 1;
    for (let i = p+1; i < seq.length && seq[i] !== seq[i-1]; i++) L++;
    if (L !== altLen) continue;
    if (p + L < seq.length && seq[p+L] !== seq[p+L-1]) continue;
    const pred = seq[p] === "T" ? "X" : "T";
    const w = decayWeight(p, 80);
    if (pred === seq[p-1]) wWin += w;
    wTotal += w;
    rawN++;
    if (rawN >= 50) break;
  }
  if (rawN < MIN_N) return null;
  const wr = wTotal > 0 ? wWin / wTotal : 0;
  if (wr < MIN_WR) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  return { signal: expected, winRate: wr, sampleCount: rawN, source: name,
    detail: `Xen kẽ ${altLen}p→${expected==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%(decay) N=${rawN}`, recentWR };
}

// ─── A6: MEAN REVERSION (strict) ───────────────
function algoMeanReversion(hist) {
  const name = "MeanRev";
  if (isMuted(name)) return null;
  if (hist.length < 80) return null;
  const W = 30;
  const recent = hist.slice(0, W);
  const ratioT = recent.filter(h => h.type==="T").length / W;
  // Only fire when strongly skewed
  if (ratioT > 0.38 && ratioT < 0.62) return null;

  let wins = 0, total = 0;
  for (let p = W; p + W + 10 < hist.length; p++) {
    const r = hist.slice(p, p+W).filter(h=>h.type==="T").length / W;
    const isSkewT = r > 0.62, isSkewX = r < 0.38;
    if (!isSkewT && !isSkewX) continue;
    const next5 = hist.slice(Math.max(0,p-5), p);
    if (next5.length < 3) continue;
    const nT = next5.filter(h=>h.type==="T").length / next5.length;
    if (isSkewT && nT < 0.5) wins++;
    else if (isSkewX && nT > 0.5) wins++;
    total++;
  }
  if (total < MIN_N) return null;
  const wr = wins / total;
  if (wr < MIN_WR) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  const signal = ratioT > 0.62 ? "X" : "T";
  return { signal, winRate: wr, sampleCount: total, source: name,
    detail: `${ratioT>0.62?"Tài":"Xỉu"} ${Math.round(Math.abs(ratioT>0.5?ratioT:1-ratioT)*100)}%/30p→hồi quy WR=${(wr*100).toFixed(0)}%`, recentWR };
}

// ─── A7: MOMENTUM (đa cửa sổ) ──────────────────
function algoMomentum(hist) {
  const name = "Momentum";
  if (isMuted(name)) return null;
  if (hist.length < 50) return null;

  const r5  = hist.slice(0,5) .filter(h=>h.type==="T").length / 5;
  const r10 = hist.slice(0,10).filter(h=>h.type==="T").length / 10;
  const r20 = hist.slice(0,20).filter(h=>h.type==="T").length / 20;

  const allBull = r5 > 0.65 && r10 > 0.60 && r20 > 0.58;
  const allBear = r5 < 0.35 && r10 < 0.40 && r20 < 0.42;
  if (!allBull && !allBear) return null;

  let wins = 0, total = 0;
  for (let p = 20; p + 20 < hist.length; p++) {
    const p5  = hist.slice(p,p+5) .filter(h=>h.type==="T").length/5;
    const p10 = hist.slice(p,p+10).filter(h=>h.type==="T").length/10;
    const p20 = hist.slice(p,p+20).filter(h=>h.type==="T").length/20;
    const isBull = p5>0.65&&p10>0.60&&p20>0.58;
    const isBear = p5<0.35&&p10<0.40&&p20<0.42;
    if (!isBull && !isBear) continue;
    const pred = isBull ? "T" : "X";
    if (pred === hist[p-1].type) wins++;
    total++;
  }
  if (total < MIN_N) return null;
  const wr = wins / total;
  if (wr < MIN_WR) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  const signal = allBull ? "T" : "X";
  return { signal, winRate: wr, sampleCount: total, source: name,
    detail: `Mom ${allBull?"▲":"▼"}[5p:${(r5*100).toFixed(0)}% 10p:${(r10*100).toFixed(0)}% 20p:${(r20*100).toFixed(0)}%] WR=${(wr*100).toFixed(0)}%`, recentWR };
}

// ─── A8: CHART PATTERN (Pearson + temporal) ────
const CHART_W  = 10;
const MIN_CORR = 0.83;
const MAX_DB   = 300;
const chartDB  = [];

function updateChartDB(hist) {
  if (hist.length < CHART_W + 2) return;
  for (let p = 1; p + CHART_W <= hist.length; p++) {
    const win  = hist.slice(p, p+CHART_W).map(h=>h.tong).reverse();
    const norm = normalize(win);
    const outcome = hist[p-1].type;
    let bestIdx = -1, bestCorr = -1;
    for (let i = 0; i < chartDB.length; i++) {
      const c = pearson(chartDB[i].norm, norm);
      if (c > bestCorr) { bestCorr = c; bestIdx = i; }
    }
    if (bestCorr >= MIN_CORR && bestIdx >= 0) {
      chartDB[bestIdx].totalSeen++;
      chartDB[bestIdx].wT += outcome==="T" ? 1 : 0;
      chartDB[bestIdx].wX += outcome==="X" ? 1 : 0;
      // Temporal: store last 30 outcomes for decay
      if (!chartDB[bestIdx].recent) chartDB[bestIdx].recent = [];
      chartDB[bestIdx].recent.push({ outcome, age: p });
      if (chartDB[bestIdx].recent.length > 30) chartDB[bestIdx].recent.shift();
    } else {
      chartDB.push({ norm, totalSeen:1, wT:outcome==="T"?1:0, wX:outcome==="X"?1:0, recent:[{outcome,age:p}] });
      if (chartDB.length > MAX_DB) {
        chartDB.sort((a,b)=>b.totalSeen-a.totalSeen);
        chartDB.splice(MAX_DB);
      }
    }
  }
}

function algoChart(hist) {
  const name = "ChartSum";
  if (isMuted(name)) return null;
  if (hist.length < CHART_W + 5) return null;
  updateChartDB(hist);

  const curWin  = hist.slice(0, CHART_W).map(h=>h.tong).reverse();
  const curNorm = normalize(curWin);

  let wT = 0, wX = 0, totalSeen = 0;
  const matches = [];
  for (const entry of chartDB) {
    if (entry.totalSeen < 6) continue;
    const corr = pearson(entry.norm, curNorm);
    if (corr < MIN_CORR) continue;
    // Use temporal-decayed weights from recent outcomes
    let dWT = 0, dWX = 0;
    for (const r of (entry.recent || [])) {
      const w = decayWeight(r.age, 60) * corr;
      if (r.outcome === "T") dWT += w; else dWX += w;
    }
    wT += dWT; wX += dWX;
    totalSeen += entry.totalSeen;
    matches.push(entry);
  }
  if (!matches.length || (wT+wX) < 0.001) return null;
  const prob = wT / (wT+wX);
  const signal = prob >= 0.5 ? "T" : "X";
  const wr = Math.max(prob, 1-prob);
  if (wr < MIN_WR) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  return { signal, winRate: wr, sampleCount: totalSeen, source: name,
    detail: `Hình dạng tổng ${matches.length} khớp→${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`, recentWR };
}

// ─── A9: DICE PATH ANALYSIS ────────────────────
// Phân tích "đường đi" của 3 xúc xắc trong 8 phiên gần
// Tính slope, momentum, convergence của từng xúc xắc
// So sánh với lịch sử để dự đoán
const DICE_DB = [[], [], []]; // per-dice pattern DB
const DICE_W  = 8;
const DICE_MIN_CORR = 0.80;

function updateDicePathDB(hist) {
  if (hist.length < DICE_W + 2) return;
  for (let di = 0; di < 3; di++) {
    const db = DICE_DB[di];
    for (let p = 1; p + DICE_W <= hist.length; p++) {
      const win  = hist.slice(p, p+DICE_W).map(h=>h.dice[di]).reverse();
      const norm = normalize(win);
      const outcome = hist[p-1].type;
      let bestIdx = -1, bestCorr = -1;
      for (let i = 0; i < db.length; i++) {
        const c = pearson(db[i].norm, norm);
        if (c > bestCorr) { bestCorr = c; bestIdx = i; }
      }
      if (bestCorr >= DICE_MIN_CORR && bestIdx >= 0) {
        db[bestIdx].totalSeen++;
        if (outcome==="T") db[bestIdx].wT++; else db[bestIdx].wX++;
      } else {
        db.push({ norm, totalSeen:1, wT:outcome==="T"?1:0, wX:outcome==="X"?1:0 });
        if (db.length > 150) {
          db.sort((a,b)=>b.totalSeen-a.totalSeen);
          db.splice(150);
        }
      }
    }
  }
}

function algoDicePath(hist) {
  const name = "DicePath";
  if (isMuted(name)) return null;
  if (hist.length < DICE_W + 8) return null;
  updateDicePathDB(hist);

  let totalWT = 0, totalWX = 0, activeCount = 0;
  const perDice = [];

  for (let di = 0; di < 3; di++) {
    const db = DICE_DB[di];
    const curWin  = hist.slice(0, DICE_W).map(h=>h.dice[di]).reverse();
    const curNorm = normalize(curWin);
    let wT = 0, wX = 0, n = 0;
    for (const entry of db) {
      if (entry.totalSeen < 5) continue;
      const corr = pearson(entry.norm, curNorm);
      if (corr < DICE_MIN_CORR) continue;
      const w = corr * Math.log(1 + entry.totalSeen);
      wT += w * (entry.wT / entry.totalSeen);
      wX += w * (entry.wX / entry.totalSeen);
      n += entry.totalSeen;
    }
    if ((wT+wX) < 0.001) { perDice.push(null); continue; }
    const prob = wT/(wT+wX);
    const sig = prob >= 0.5 ? "T" : "X";
    const wr = Math.max(prob, 1-prob);
    perDice.push({ sig, wr, n });
    totalWT += wT; totalWX += wX;
    activeCount++;
  }

  if (activeCount < 2) return null; // Need at least 2 dice agreeing
  const prob = totalWT / (totalWT + totalWX);
  const signal = prob >= 0.5 ? "T" : "X";
  const wr = Math.max(prob, 1-prob);
  if (wr < MIN_WR) return null;

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR + 0.05) return null;

  const dStr = perDice.map((d,i) => d ? `D${i+1}:${d.sig==="T"?"▲":"▼"}${(d.wr*100).toFixed(0)}%` : `D${i+1}:?`).join(" ");
  return { signal, winRate: wr, sampleCount: Math.round((totalWT+totalWX)*10), source: name,
    detail: `[${dStr}]→${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`,
    perDice, recentWR };
}

// ─── A10: DICE TREND (slope analysis) ──────────
function algoDiceTrend(hist) {
  const name = "DiceTrend";
  if (isMuted(name)) return null;
  if (hist.length < 25) return null;
  const W = 6;

  function slope(vals) {
    const n = vals.length; if (n < 2) return 0;
    let sx=0,sy=0,sxy=0,sx2=0;
    for (let i=0;i<n;i++){sx+=i;sy+=vals[i];sxy+=i*vals[i];sx2+=i*i;}
    const d=n*sx2-sx*sx; return d?(n*sxy-sx*sy)/d:0;
  }
  function tc(s){ return s>0.35?"U":s<-0.35?"D":"F"; }

  const tbl = {};
  const data = hist.slice(0, ROLL_WINDOW);
  for (let p = W; p < data.length; p++) {
    const win = data.slice(p, p+W).map(h=>h.dice).reverse();
    const key = [0,1,2].map(di=>tc(slope(win.map(d=>d[di])))).join("");
    const o = data[p-1].type;
    if (!tbl[key]) tbl[key]={T:0,X:0};
    tbl[key][o]++;
  }

  const curWin = hist.slice(0, W).map(h=>h.dice).reverse();
  const curKey = [0,1,2].map(di=>tc(slope(curWin.map(d=>d[di])))).join("");
  const c = tbl[curKey];
  if (!c||(c.T+c.X)<MIN_N) return null;
  const wr = Math.max(c.T,c.X)/(c.T+c.X);
  if (wr < MIN_WR) return null;
  const signal = c.T>=c.X?"T":"X";

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR+0.05) return null;

  const lab={U:"↑",D:"↓",F:"→"};
  const tStr = curKey.split("").map((k,i)=>`D${i+1}${lab[k]}`).join(" ");
  return { signal, winRate:wr, sampleCount:c.T+c.X, source:name,
    detail:`[${tStr}]→${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% N=${c.T+c.X}`, recentWR };
}

// ─── A11: DICE SUM ZONE MARKOV ─────────────────
function algoDiceSumZone(hist) {
  const name = "SumZone";
  if (isMuted(name)) return null;
  const data = hist.slice(0, ROLL_WINDOW);
  if (data.length < 35) return null;

  function zone(t){ return t<=7?"L":t<=10?"ML":t<=13?"MH":"H"; }
  const tbl = {};
  for (let p = 2; p < data.length; p++) {
    const key = zone(data[p].tong)+zone(data[p-1].tong);
    const o = data[p-2].type; // predict 2 ahead
    if (!tbl[key]) tbl[key]={T:0,X:0};
    tbl[key][o]++;
  }
  const curKey = zone(data[0].tong)+zone(data[1].tong);
  const c = tbl[curKey];
  if (!c||(c.T+c.X)<MIN_N) return null;
  const wr = Math.max(c.T,c.X)/(c.T+c.X);
  if (wr < MIN_WR) return null;
  const signal = c.T>=c.X?"T":"X";

  const recentWR = getRecentWR(name);
  if (recentWR !== null && recentWR < MUTE_WR+0.05) return null;

  const zNames={L:"Thấp",ML:"T.Thấp",MH:"T.Cao",H:"Cao"};
  return { signal, winRate:wr, sampleCount:c.T+c.X, source:name,
    detail:`Vùng[${zNames[curKey.slice(0,curKey.length/2>2?2:1)]}→${zNames[curKey.slice(-1)]}]→${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% N=${c.T+c.X}`, recentWR };
}

// ═══════════════════════════════════════════════
//  ADAPTIVE ALGO TRAINING
//  Run after every new session to update mute states
// ═══════════════════════════════════════════════
let lastTrainPhien = null;
function trainAdaptive(hist) {
  if (hist.length < 30) return;
  const newestPhien = hist[0].phien;
  if (newestPhien === lastTrainPhien) return;
  lastTrainPhien = newestPhien;

  // For each of the last 25 sessions, simulate what each algo predicted
  // and record if correct
  const algoFns = [
    (h) => algoMarkov(h, 1),
    (h) => algoMarkov(h, 2),
    (h) => algoMarkov(h, 3),
    (h) => algoStreak(h),
    (h) => algoPattern(h),
    (h) => algoAlternating(h),
    (h) => algoMeanReversion(h),
    (h) => algoMomentum(h),
    (h) => algoChart(h),
    (h) => algoDicePath(h),
    (h) => algoDiceTrend(h),
    (h) => algoDiceSumZone(h),
  ];

  for (let i = 1; i <= Math.min(25, hist.length - 30); i++) {
    const subHist = hist.slice(i);
    const actual  = hist[i-1].type;
    for (const fn of algoFns) {
      try {
        const sig = fn(subHist);
        if (!sig) continue;
        recordAlgoResult(sig.source, sig.signal === actual);
      } catch(_) {}
    }
  }
}

// ═══════════════════════════════════════════════
//  COLLECT ALL SIGNALS
// ═══════════════════════════════════════════════
function collectSignals(hist) {
  const results = [];
  const add = r => { if (r) results.push(r); };
  add(algoMarkov(hist, 1));
  add(algoMarkov(hist, 2));
  add(algoMarkov(hist, 3));
  add(algoMarkovInvert(hist));
  add(algoStreak(hist));
  add(algoAlternating(hist));
  add(algoPattern(hist));
  add(algoMeanReversion(hist));
  add(algoMomentum(hist));
  add(algoChart(hist));
  add(algoDicePath(hist));
  add(algoDiceTrend(hist));
  add(algoDiceSumZone(hist));
  return results;
}

// ═══════════════════════════════════════════════
//  ENSEMBLE — STRICT CONSENSUS
// ═══════════════════════════════════════════════
function ensemble(signals) {
  if (!signals.length) return { signal: null, confidence: 0.5, cntT:0, cntX:0, ratio:0 };
  const cntT = signals.filter(s=>s.signal==="T").length;
  const cntX = signals.filter(s=>s.signal==="X").length;
  const total = signals.length;

  // Must have majority + minimum count
  if (Math.max(cntT,cntX) < MIN_AGREE) {
    return { signal: null, confidence: 0.5, cntT, cntX, ratio: Math.max(cntT,cntX)/total };
  }
  // Must be clear majority (not 3T vs 3X)
  const ratio = Math.max(cntT,cntX) / total;
  if (ratio < 0.58 && total >= 5) {
    return { signal: null, confidence: 0.5, cntT, cntX, ratio };
  }

  // Weighted vote
  let wT = 0, wX = 0;
  for (const s of signals) {
    const recentBonus = s.recentWR != null ? (s.recentWR > 0.55 ? 1.4 : s.recentWR > 0.50 ? 1.1 : 0.8) : 1.0;
    const w = s.winRate * Math.log(1 + s.sampleCount) * recentBonus;
    if (s.signal==="T") wT+=w; else wX+=w;
  }
  const tot = wT+wX;
  if (!tot) return { signal:null, confidence:0.5, cntT, cntX, ratio };

  const signal = wT>=wX?"T":"X";
  const rawConf = Math.max(wT,wX)/tot;
  // Scale confidence: 50% base + up to 30% from WR + ratio bonus
  const conf = Math.min(0.85, 0.50 + (rawConf-0.50)*0.7 + ratio*0.08);

  return { signal, confidence: conf, cntT, cntX, ratio };
}

// ═══════════════════════════════════════════════
//  BACKTEST (strict rolling)
// ═══════════════════════════════════════════════
function backtest(hist, trials = 40) {
  if (hist.length < trials + ROLL_WINDOW) return null;
  let wins=0, total=0, skipped=0;
  for (let i = 1; i <= trials; i++) {
    const sub = hist.slice(i);
    const sigs = collectSignals(sub);
    const { signal } = ensemble(sigs);
    if (!signal) { skipped++; continue; }
    if (signal === hist[i-1].type) wins++;
    total++;
  }
  if (!total) return null;
  return { wins, total, skipped, wr: wins/total };
}

// ═══════════════════════════════════════════════
//  8-SESSION PATH ANALYSIS
//  Tính toán chi tiết đường đi của 3 xúc xắc và tổng
// ═══════════════════════════════════════════════
function pathAnalysis(hist) {
  const W = 8;
  const slice = hist.slice(0, W);
  if (slice.length < W) return null;

  // Per-dice stats
  const dice = [0,1,2].map(di => {
    const vals = slice.map(h=>h.dice[di]).reverse(); // old→new
    const m    = mean(vals);
    const sd   = stdDev(vals);
    const last = vals[vals.length-1];
    const prev = vals[vals.length-2];
    // Slope via linear regression
    const n = vals.length;
    let sx=0,sy=0,sxy=0,sx2=0;
    for (let i=0;i<n;i++){sx+=i;sy+=vals[i];sxy+=i*vals[i];sx2+=i*i;}
    const d=n*sx2-sx*sx;
    const s = d?(n*sxy-sx*sy)/d:0;
    const trend = s>0.3?"↑":s<-0.3?"↓":"→";
    // Detect acceleration: compare first half slope vs second half slope
    const h1 = vals.slice(0,4), h2 = vals.slice(4);
    const s1 = mean(h1), s2 = mean(h2);
    const accel = s2-s1;
    return { vals, mean:m.toFixed(2), sd:sd.toFixed(2), slope:s.toFixed(3), trend, last, prev, accel:accel.toFixed(2) };
  });

  // Tổng path
  const sums = slice.map(h=>h.tong).reverse();
  const sumMean  = mean(sums);
  const sumSd    = stdDev(sums);
  const sumNorm  = normalize(sums);
  const sumLast  = sums[sums.length-1];
  const sumTrend = sums[sums.length-1] > sums[sums.length-2] ? "↑" : sums[sums.length-1] < sums[sums.length-2] ? "↓" : "→";

  // Pattern recognition on 8-session window
  const types = slice.map(h=>h.type).reverse();
  const typeStr = types.join("");

  // Detect sub-patterns
  let subPattern = "Hỗn hợp";
  if (typeStr === "TTTTTTTT") subPattern = "Cầu Tài 8";
  else if (typeStr === "XXXXXXXX") subPattern = "Cầu Xỉu 8";
  else if (/^(TT|XX)/.test(typeStr) && typeStr.length === 8) {
    const pairs = typeStr.match(/../g);
    if (pairs && new Set(pairs).size === 1) subPattern = "Bệt kép";
  } else if (typeStr.split("").every((c,i,a)=>i===0||c!==a[i-1])) subPattern = "Xen kẽ hoàn toàn";
  else {
    // Count transitions
    let trans = 0;
    for (let i=1;i<typeStr.length;i++) if(typeStr[i]!==typeStr[i-1]) trans++;
    if (trans >= 6) subPattern = "Xen kẽ nhiều";
    else if (trans <= 2) subPattern = "Bệt dài";
    else subPattern = "Hỗn hợp";
  }

  // Convergence: are dice converging or diverging?
  const diceRange = (i) => Math.max(...dice[i].vals.slice(-3)) - Math.min(...dice[i].vals.slice(-3));
  const convergence = [0,1,2].map(diceRange);
  const isConverging = convergence.every(r=>r<=2);
  const isDiverging  = convergence.some(r=>r>=4);

  return {
    dice, sums, sumNorm, sumMean:sumMean.toFixed(2), sumSd:sumSd.toFixed(2), sumLast, sumTrend,
    types, typeStr, subPattern, convergence, isConverging, isDiverging
  };
}

// ═══════════════════════════════════════════════
//  MAIN PREDICT
// ═══════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 30) {
    return {
      next:null, nextDisplay:"Chưa đủ dữ liệu", confidence:0.5, confDisplay:"50%",
      signals:[], backtest:null, typeSeq:[], sumChart:[], streak:0, curType:"?",
      chartDBSize:chartDB.length, cntT:0, cntX:0, path:null, mutedAlgos:[]
    };
  }

  trainAdaptive(hist);

  const signals  = collectSignals(hist);
  const { signal, confidence, cntT, cntX, ratio } = ensemble(signals);
  const bt       = backtest(hist, 40);
  const path     = pathAnalysis(hist);

  const seq = hist.map(h=>h.type);
  const curType = seq[0];
  let streak = 0;
  for (const t of seq) { if(t===curType) streak++; else break; }

  const vT = signals.filter(s=>s.signal==="T").reduce((s,r)=>s+r.winRate,0);
  const vX = signals.filter(s=>s.signal==="X").reduce((s,r)=>s+r.winRate,0);

  const diceStats = [0,1,2].map(di => ({
    avg: mean(hist.slice(0,20).map(h=>h.dice[di])).toFixed(2),
    std: stdDev(hist.slice(0,20).map(h=>h.dice[di])).toFixed(2),
    recent: hist.slice(0,8).map(h=>h.dice[di])
  }));

  const mutedAlgos = Object.entries(algoRecentPerf)
    .filter(([,v])=>v.muted)
    .map(([k,v])=>({name:k, recentWR: v.recentWR?.toFixed?.(2)||"?"}));

  return {
    next:signal,
    nextDisplay: signal==="T"?"Tài":signal==="X"?"Xỉu":"Chờ",
    confidence, confDisplay: Math.round(confidence*100)+"%",
    signals, signalCount:signals.length,
    cntT, cntX, ratio,
    backtest:bt, typeSeq:seq.slice(0,25),
    sumChart:hist.slice(0,25).map(h=>h.tong),
    diceCharts:{
      d1:hist.slice(0,25).map(h=>h.dice[0]),
      d2:hist.slice(0,25).map(h=>h.dice[1]),
      d3:hist.slice(0,25).map(h=>h.dice[2]),
    },
    streak, curType,
    votesT:vT.toFixed(2), votesX:vX.toFixed(2),
    chartDBSize:chartDB.length,
    diceStats, path, mutedAlgos,
    diceDBSizes:DICE_DB.map(db=>db.length),
  };
}

function diceFreqAnalysis(hist, n=50) {
  const slice = hist.slice(0, Math.min(n, hist.length));
  return [0,1,2].map(di=>{
    const freq=[0,0,0,0,0,0,0];
    for(const h of slice) freq[h.dice[di]]++;
    return freq.slice(1);
  });
}

// ═══════════════════════════════════════════════
//  HTML — v13
// ═══════════════════════════════════════════════
function buildHTML(pred, h) {
  const n = Math.min(pred.sumChart.length, 25);
  const labels  = JSON.stringify(Array.from({length:n},(_,i)=>String(Number(h.phien)-(n-1-i))));
  const sumData = JSON.stringify([...pred.sumChart.slice(0,n)].reverse());
  const d1Data  = JSON.stringify([...pred.diceCharts.d1.slice(0,n)].reverse());
  const d2Data  = JSON.stringify([...pred.diceCharts.d2.slice(0,n)].reverse());
  const d3Data  = JSON.stringify([...pred.diceCharts.d3.slice(0,n)].reverse());
  const typeData= JSON.stringify([...pred.typeSeq.slice(0,n)].reverse());
  const freqs   = diceFreqAnalysis(history, 50);
  const freqJSON= JSON.stringify(freqs);
  const path    = pred.path;

  // 8-session path data for chart
  const path8Labels = path ? JSON.stringify(Array.from({length:8},(_,i)=>String(Number(h.phien)-7+i))) : "[]";
  const path8D1 = path ? JSON.stringify(path.dice[0].vals) : "[]";
  const path8D2 = path ? JSON.stringify(path.dice[1].vals) : "[]";
  const path8D3 = path ? JSON.stringify(path.dice[2].vals) : "[]";
  const path8Sum= path ? JSON.stringify(path.sums) : "[]";

  const noSignal  = pred.next === null;
  const isTai     = pred.next === "T";
  const predColor = noSignal?"#666":(isTai?"#f5c842":"#a070ff");
  const predBg    = noSignal?"rgba(80,80,80,.08)":(isTai?"rgba(245,200,66,.10)":"rgba(160,112,255,.10)");
  const confPct   = Math.round(pred.confidence*100);
  const consensusPct = Math.round((pred.ratio||0)*100);
  const btWR      = pred.backtest?(pred.backtest.wr*100).toFixed(1):"N/A";
  const btTotal   = pred.backtest?pred.backtest.total:0;
  const btSkip    = pred.backtest?(pred.backtest.skipped||0):0;

  const bolMid = parseFloat(mean(pred.sumChart).toFixed(2));
  const bolSd  = parseFloat(stdDev(pred.sumChart).toFixed(2));
  const bolUp  = parseFloat((bolMid+2*bolSd).toFixed(2));
  const bolLow = parseFloat((bolMid-2*bolSd).toFixed(2));

  const vT=Number(pred.votesT),vX=Number(pred.votesX);
  const pctT=(vT+vX)>0?Math.round(vT/(vT+vX)*100):50;
  const pctX=100-pctT;

  // Signal rows
  const sigRows = pred.signals.map(s=>{
    const isT=s.signal==="T";
    const rwr = s.recentWR!=null?`<span style="color:${s.recentWR>0.55?"#88ee88":s.recentWR<0.45?"#ee6666":"#aaa"};font-size:.60rem"> Gần:${Math.round(s.recentWR*100)}%</span>`:"";
    return `<tr>
      <td class="td-src">${s.source}</td>
      <td class="${isT?"sig-t":"sig-x"}">${isT?"▲ Tài":"▼ Xỉu"}</td>
      <td class="td-wr">${(s.winRate*100).toFixed(0)}%${rwr}</td>
      <td class="td-n">${s.sampleCount}</td>
      <td class="td-detail">${s.detail}</td>
    </tr>`;
  }).join("")||`<tr><td colspan="5" style="color:#555;padding:8px;font-size:.78rem">Đang tích lũy dữ liệu...</td></tr>`;

  // Muted algos
  const mutedHTML = pred.mutedAlgos.length
    ? pred.mutedAlgos.map(m=>`<span class="muted-badge">${m.name} ${Math.round(Number(m.recentWR)*100)}%</span>`).join("")
    : `<span style="color:#406030;font-size:.65rem">Không có — tất cả đang hoạt động</span>`;

  // Path analysis HTML
  let pathHTML = "";
  if (path) {
    const diceColors = ["#f5a642","#42c8f5","#a0f542"];
    const dicePathRows = [0,1,2].map(di=>{
      const d = path.dice[di];
      const trendColor = d.trend==="↑"?"#88ee88":d.trend==="↓"?"#ee6666":"#aaa";
      const accelVal = parseFloat(d.accel);
      const accelStr = accelVal>0?"▲加速":"▼减速";
      const minibar = d.vals.map(v=>`<span style="display:inline-block;width:16px;height:${(v/6*28).toFixed(0)}px;background:${diceColors[di]};opacity:.85;border-radius:2px 2px 0 0;margin-right:2px;vertical-align:bottom;font-size:0"></span>`).join("");
      return `<div class="path-dice-row" style="border-left:3px solid ${diceColors[di]}">
        <div class="pdl">
          <span style="color:${diceColors[di]};font-weight:700">D${di+1}</span>
          <span style="color:${trendColor};font-size:1.2rem">${d.trend}</span>
          <span style="font-family:var(--mono);font-size:.72rem">${d.mean}±${d.sd}</span>
        </div>
        <div class="pdv">${minibar}</div>
        <div class="pddetail">
          <span>Slope: <b style="color:${parseFloat(d.slope)>0?"#88ee88":parseFloat(d.slope)<0?"#ee6666":"#aaa"}">${d.slope}</b></span>
          <span>5-8p: <b>${d.vals.slice(0,4).join("-")}</b></span>
          <span>1-4p: <b>${d.vals.slice(4).join("-")}</b></span>
          ${Math.abs(accelVal)>0.3?`<span style="color:${accelVal>0?"#88ee88":"#ee6666"}">${accelVal>0?"Tăng tốc":"Giảm tốc"}</span>`:""}
        </div>
      </div>`;
    }).join("");

    const convColor = path.isConverging?"#88ee88":path.isDiverging?"#ee6666":"#aaa";
    const convText  = path.isConverging?"Hội tụ (ổn định)":path.isDiverging?"Phân kỳ (biến động)":"Trung tính";

    const typeBeads = path.types.map((t,i)=>`<div class="pbead ${t==="T"?"pbt":"pbx"}" style="${i===path.types.length-1?"border:2px solid #fff":""}">${t}</div>`).join("");

    pathHTML = `
<div class="section-hdr">⬤ Phân Tích Đường Đi 8 Phiên Gần Nhất</div>
<div class="path-container">
  <div class="path-header">
    <div>
      <span class="path-label">Pattern:</span>
      <span class="path-pattern">${path.subPattern}</span>
    </div>
    <div>
      <span class="path-label">Tổng hướng:</span>
      <span style="color:${path.sumTrend==="↑"?"#88ee88":path.sumTrend==="↓"?"#ee6666":"#aaa"};font-size:1.1rem">${path.sumTrend}</span>
      <span style="font-family:var(--mono);font-size:.75rem">${path.sumMean}±${path.sumSd}</span>
    </div>
    <div>
      <span class="path-label">Xúc xắc:</span>
      <span style="color:${convColor}">${convText}</span>
    </div>
  </div>
  <div class="path-types">${typeBeads}</div>
  <div class="path-dice-section">${dicePathRows}</div>
  <div class="path-sums">
    <span class="path-label">Tổng 8p:</span>
    ${path.sums.map((s,i)=>`<span class="psum ${s>=11?"pst":"psx"}" style="${i===path.sums.length-1?"font-size:1rem;font-weight:700":""}">${s}</span>`).join("")}
  </div>
</div>

<div class="section-hdr">⬤ Đồ Thị Đường Đi 8 Phiên (Chi Tiết)</div>
<div class="two-col">
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:#ccaa44">📍 Đường Đi Tổng (8 phiên)</div>
    <canvas id="path8SumChart" height="200"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:#66ccaa">📍 Đường Đi 3 Xúc Xắc (8 phiên)</div>
    <canvas id="path8DiceChart" height="200"></canvas>
  </div>
</div>`;
  }

  const diceStatHTML = [0,1,2].map(di=>{
    const ds=pred.diceStats[di];
    const col=["#f5a642","#42c8f5","#a0f542"][di];
    return `<div class="dstat" style="--dc:${col}">
      <div class="dstat-lbl">Xúc Xắc ${di+1}</div>
      <div class="dstat-avg" style="color:${col}">${ds.avg}</div>
      <div class="dstat-sub">±${ds.std}</div>
      <div class="dstat-hist">${ds.recent.map(v=>`<span class="dv" style="height:${(v/6*100).toFixed(0)}%;background:${col}">${v}</span>`).join("")}</div>
    </div>`;
  }).join("");

  const topDB=[...chartDB].filter(e=>e.totalSeen>=6).sort((a,b)=>b.totalSeen-a.totalSeen).slice(0,5);
  const dbRows=topDB.map((e,i)=>{
    const wr=Math.max(e.wT,e.wX)/e.totalSeen;
    const p2=e.wT>=e.wX?"T":"X";
    return `<tr><td class="td-src">#${i+1}</td><td class="${p2==="T"?"sig-t":"sig-x"}">${p2==="T"?"▲":"▼"}</td><td class="td-wr">${(wr*100).toFixed(0)}%</td><td class="td-n">${e.totalSeen}</td></tr>`;
  }).join("")||`<tr><td colspan="4" style="color:#555;font-size:.72rem;padding:6px">Đang xây dựng...</td></tr>`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v13 — SUNWIN</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --tai:#f5c842;--xiu:#a070ff;
  --bg:#080600;--bg2:#100900;--bdr:rgba(180,130,10,.18);
  --txt:#e0d090;--dim:#806020;
  --d1:#f5a642;--d2:#42c8f5;--d3:#a0f542;
  --mono:'Share Tech Mono',monospace;--head:'Rajdhani',sans-serif;
}
body{background:var(--bg);min-height:100vh;color:var(--txt);font-family:var(--head);padding:10px}
.hdr{display:flex;align-items:center;justify-content:space-between;
  background:linear-gradient(135deg,#180a00,#080300,#180a00);
  border:1px solid var(--bdr);border-radius:10px;padding:10px 16px;margin-bottom:10px}
.hdr-title{font-size:1.15rem;font-weight:700;letter-spacing:4px;
  background:linear-gradient(90deg,#ff8800,#ffd700,#fff080,#ffd700,#ff8800);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hdr-right{font-family:var(--mono);font-size:.74rem;color:var(--dim);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.hdr-right .v{color:#f5c842;font-weight:bold}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px}
.mc{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:9px 12px;position:relative;overflow:hidden}
.mc::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--ac,#c8960a)}
.mc-lbl{font-size:.57rem;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}
.mc-val{font-size:1.4rem;font-weight:700;font-family:var(--mono);color:var(--ac,#f5c842);line-height:1}
.mc-sub{font-size:.58rem;color:var(--dim);margin-top:3px}
.card{background:var(--bg2);border:1px solid var(--bdr);border-radius:10px;padding:12px;margin-bottom:10px}
.card-title{font-size:.60rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim);margin-bottom:10px}
.bead-road{display:flex;flex-wrap:wrap;gap:5px;padding:4px 0}
.bead{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.68rem;font-weight:700}
.bt{background:radial-gradient(circle at 35% 30%,#ffe060,#c8900a,#7a4f00);color:#fff5cc;box-shadow:0 0 6px rgba(200,150,10,.45)}
.bx{background:radial-gradient(circle at 35% 30%,#c490ff,#7820ef,#3a0090);color:#e8d8ff;box-shadow:0 0 6px rgba(130,60,255,.45)}
.vote-bar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.05);margin:6px 0}
.vt{background:linear-gradient(90deg,#c8700a,#f5c842)}
.vx{background:linear-gradient(90deg,#5010b0,#a070ff)}
.vote-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:.70rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.pred-row{display:grid;grid-template-columns:190px 1fr;gap:10px;margin-bottom:10px}
.pred-main{background:${predBg};border:2px solid ${predColor};border-radius:12px;padding:16px;text-align:center;box-shadow:0 0 30px ${predColor}20}
.pred-lbl{font-size:.58rem;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.pred-val{font-size:2.8rem;font-weight:700;color:${predColor};text-shadow:0 0 20px ${predColor};line-height:1.1;margin:4px 0}
.conf-track{height:4px;background:rgba(255,255,255,.08);border-radius:2px;margin:6px 0;overflow:hidden}
.conf-fill{height:100%;background:${predColor};width:${confPct}%;border-radius:2px}
.bt-badge{font-family:var(--mono);font-size:.62rem;padding:2px 8px;border-radius:4px;
  background:rgba(100,220,100,.10);border:1px solid rgba(100,220,100,.22);color:#70cc70;display:inline-block;margin-top:4px}
.skip-badge{font-family:var(--mono);font-size:.68rem;padding:4px 10px;border-radius:6px;
  background:rgba(255,180,40,.10);border:1px solid rgba(255,180,40,.30);color:#ffcc60;display:inline-block;margin-top:4px}
.sig-table{width:100%;border-collapse:collapse;font-size:.67rem}
.sig-table th{color:var(--dim);padding:3px 5px;border-bottom:1px solid var(--bdr);text-align:left;font-weight:400;font-size:.57rem;text-transform:uppercase}
.sig-table td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:top}
.td-src{font-family:var(--mono);font-size:.63rem;white-space:nowrap;color:#a88040}
.sig-t{color:var(--tai);font-weight:700;white-space:nowrap}
.sig-x{color:var(--xiu);font-weight:700;white-space:nowrap}
.td-wr{font-family:var(--mono);font-size:.70rem;color:#78bb78;text-align:right;white-space:nowrap}
.td-n{font-family:var(--mono);font-size:.60rem;color:#444;text-align:right}
.td-detail{color:#604820;font-size:.60rem;line-height:1.4}
.section-hdr{font-size:.56rem;text-transform:uppercase;letter-spacing:2px;color:#503810;margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(160,110,30,.12)}
.dice-stats-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px}
.dstat{background:var(--bg2);border:1px solid rgba(255,255,255,.06);border-top:2px solid var(--dc,#888);border-radius:8px;padding:8px 10px}
.dstat-lbl{font-size:.55rem;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:2px}
.dstat-avg{font-size:1.25rem;font-weight:700;font-family:var(--mono);line-height:1}
.dstat-sub{font-size:.57rem;color:var(--dim);margin-bottom:5px}
.dstat-hist{display:flex;align-items:flex-end;gap:3px;height:28px}
.dv{display:flex;align-items:center;justify-content:center;min-width:18px;border-radius:2px 2px 0 0;font-size:.53rem;color:#000;font-family:var(--mono);font-weight:700;opacity:.85}
.muted-badge{font-family:var(--mono);font-size:.60rem;background:rgba(255,80,60,.12);border:1px solid rgba(255,80,60,.28);color:#ee7766;padding:2px 7px;border-radius:4px;display:inline-block;margin:2px}
/* PATH ANALYSIS */
.path-container{background:var(--bg2);border:1px solid rgba(100,200,150,.18);border-radius:10px;padding:12px;margin-bottom:10px}
.path-header{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px;font-size:.72rem;align-items:center}
.path-label{color:var(--dim);font-size:.60rem;text-transform:uppercase;letter-spacing:1px;margin-right:5px}
.path-pattern{color:#88ccaa;font-weight:600;font-family:var(--mono)}
.path-types{display:flex;gap:5px;margin-bottom:10px;flex-wrap:wrap}
.pbead{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.70rem;font-weight:700}
.pbt{background:radial-gradient(circle at 35% 30%,#ffe060,#c8900a,#7a4f00);color:#fff5cc}
.pbx{background:radial-gradient(circle at 35% 30%,#c490ff,#7820ef,#3a0090);color:#e8d8ff}
.path-dice-section{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.path-dice-row{padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.03);border-left:3px solid #888;display:grid;grid-template-columns:100px auto 1fr;align-items:center;gap:10px}
.pdl{display:flex;align-items:center;gap:8px;font-family:var(--mono)}
.pdv{display:flex;align-items:flex-end;gap:2px;height:30px}
.pddetail{display:flex;gap:10px;font-family:var(--mono);font-size:.62rem;color:#706040;flex-wrap:wrap}
.path-sums{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.psum{font-family:var(--mono);font-size:.75rem;padding:2px 6px;border-radius:4px}
.pst{background:rgba(245,200,66,.15);color:#f5c842;border:1px solid rgba(245,200,66,.3)}
.psx{background:rgba(160,112,255,.15);color:#a070ff;border:1px solid rgba(160,112,255,.3)}
@media(max-width:620px){.metrics,.dice-stats-row,.three-col{grid-template-columns:repeat(2,1fr)}.two-col,.pred-row{grid-template-columns:1fr}.path-dice-row{grid-template-columns:70px auto 1fr}}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v13 — SUNWIN ⬦</div>
  <div class="hdr-right">
    <span>Phiên <span class="v">#${h.phien}</span></span>
    <span style="color:${h.type==="T"?"var(--tai)":"var(--xiu)"};font-weight:700">${h.type==="T"?"Tài":"Xỉu"}</span>
    <span style="color:var(--d1)">${h.dice[0]}</span>·<span style="color:var(--d2)">${h.dice[1]}</span>·<span style="color:var(--d3)">${h.dice[2]}</span>
    <span>Σ <span class="v">${h.tong}</span></span>
    <span style="color:#444">${new Date().toLocaleTimeString("vi-VN")}</span>
  </div>
</div>

<div class="metrics">
  <div class="mc" style="--ac:${predColor}">
    <div class="mc-lbl">Dự Đoán</div>
    <div class="mc-val">${pred.nextDisplay}</div>
    <div class="mc-sub">Phiên #${Number(h.phien)+1}</div>
  </div>
  <div class="mc" style="--ac:#44aaff">
    <div class="mc-lbl">Confidence</div>
    <div class="mc-val">${confPct}%</div>
    <div class="mc-sub">${pred.signalCount} signals</div>
  </div>
  <div class="mc" style="--ac:#78cc78">
    <div class="mc-lbl">Backtest WR</div>
    <div class="mc-val">${btWR}%</div>
    <div class="mc-sub">${btTotal}p / skip ${btSkip}</div>
  </div>
  <div class="mc" style="--ac:#ff9944">
    <div class="mc-lbl">Cầu Hiện Tại</div>
    <div class="mc-val">${pred.streak}</div>
    <div class="mc-sub">${pred.curType==="T"?"Tài":"Xỉu"} liên tiếp</div>
  </div>
  <div class="mc" style="--ac:#66eecc">
    <div class="mc-lbl">Consensus</div>
    <div class="mc-val">${consensusPct}%</div>
    <div class="mc-sub">${pred.cntT}▲ · ${pred.cntX}▼ signal</div>
  </div>
</div>

<div class="card">
  <div class="card-title">🔇 Thuật toán bị tắt (đang gãy) — Muted</div>
  <div>${mutedHTML}</div>
</div>

${pathHTML}

<div class="section-hdr">⬤ Đồ Thị 25 Phiên — Tổng & 3 Xúc Xắc</div>
<div class="card" style="margin-bottom:8px">
  <div class="card-title">📈 Biểu Đồ Tổng + Bollinger</div>
  <canvas id="sumChart" height="210"></canvas>
</div>

<div class="three-col">
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d1)">🎲 Xúc Xắc 1</div><canvas id="d1Chart" height="140"></canvas></div>
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d2)">🎲 Xúc Xắc 2</div><canvas id="d2Chart" height="140"></canvas></div>
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d3)">🎲 Xúc Xắc 3</div><canvas id="d3Chart" height="140"></canvas></div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Tần Suất Xúc Xắc (50 Phiên)</div>
<div class="three-col">
  <div class="card" style="margin-bottom:0"><canvas id="freq1Chart" height="110"></canvas></div>
  <div class="card" style="margin-bottom:0"><canvas id="freq2Chart" height="110"></canvas></div>
  <div class="card" style="margin-bottom:0"><canvas id="freq3Chart" height="110"></canvas></div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Thống Kê Xúc Xắc</div>
<div class="dice-stats-row">${diceStatHTML}</div>

<div class="section-hdr">⬤ Cầu & Dự Đoán</div>

<div class="card">
  <div class="card-title">⬤ Cầu Hạt — 25 Phiên</div>
  <div class="bead-road" id="beadRoad"></div>
</div>

<div class="card">
  <div class="card-title">⚖ Phân Bổ Signal</div>
  <div class="vote-bar">
    <div class="vt" style="width:${pctT}%"></div>
    <div class="vx" style="width:${pctX}%"></div>
  </div>
  <div class="vote-labels">
    <span style="color:var(--tai)">▲ Tài ${pctT}% (${pred.cntT} signal)</span>
    <span style="color:var(--xiu)">▼ Xỉu ${pctX}% (${pred.cntX} signal)</span>
  </div>
</div>

<div class="pred-row">
  <div class="pred-main">
    <div class="pred-lbl">Phiên Tiếp Theo</div>
    <div style="font-size:.65rem;color:var(--dim)">#${Number(h.phien)+1}</div>
    <div class="pred-val">${pred.nextDisplay}</div>
    ${noSignal
      ? `<div class="skip-badge">⚠ Tín hiệu mâu thuẫn — Nên BỎ PHIÊN</div>`
      : `<div class="conf-track"><div class="conf-fill"></div></div>
         <div style="font-family:var(--mono);font-size:.95rem;color:#fff">${confPct}% — ${pred.cntT}T/${pred.cntX}X</div>`
    }
    <div class="bt-badge">BT: ${btWR}% / ${btTotal}p</div>
  </div>
  <div class="card" style="margin-bottom:0;overflow:hidden">
    <div class="card-title">${pred.signalCount} tín hiệu đạt ngưỡng WR≥55% N≥15</div>
    <div style="max-height:290px;overflow-y:auto">
      <table class="sig-table">
        <thead><tr><th>Algo</th><th>Signal</th><th>WR%</th><th>N</th><th>Chi Tiết</th></tr></thead>
        <tbody>${sigRows}</tbody>
      </table>
    </div>
  </div>
</div>

<div class="card">
  <div class="card-title" style="display:flex;justify-content:space-between">
    <span>🗂 Kho Chart Tổng</span>
    <span style="font-family:var(--mono);font-size:.70rem;color:#66bbaa">${chartDB.length} mẫu · D1/D2/D3: ${pred.diceDBSizes.join("/")}</span>
  </div>
  <table class="sig-table">
    <thead><tr><th>#</th><th>Pred</th><th>WR%</th><th>N</th></tr></thead>
    <tbody>${dbRows}</tbody>
  </table>
</div>

<script>
Chart.register(window['chartjs-plugin-annotation']);
const LABELS=${labels},SUM_DATA=${sumData};
const D1_DATA=${d1Data},D2_DATA=${d2Data},D3_DATA=${d3Data};
const TYPE_DATA=${typeData},FREQS=${freqJSON};
const N=SUM_DATA.length;
const BOLL_UP=${bolUp},BOLL_MID=${bolMid},BOLL_LOW=${bolLow};
const P8L=${path8Labels},P8D1=${path8D1},P8D2=${path8D2},P8D3=${path8D3},P8S=${path8Sum};

// Bead road
const beadEl=document.getElementById('beadRoad');
[...TYPE_DATA].forEach((t,i)=>{
  const b=document.createElement('div');
  b.className='bead '+(t==='T'?'bt':'bx');
  b.textContent=t;
  if(i===TYPE_DATA.length-1){b.style.outline='2px solid #fff';b.style.outlineOffset='2px';}
  beadEl.appendChild(b);
});

// Sum chart with numbered circles
const numberedPts={id:'numberedPts',afterDatasetsDraw(chart){
  const ctx=chart.ctx,meta=chart.getDatasetMeta(3);if(!meta)return;
  meta.data.forEach((pt,i)=>{
    const val=SUM_DATA[i];if(val==null)return;
    const isTai=val>=11,R=13;
    const g=ctx.createRadialGradient(pt.x-R*.3,pt.y-R*.35,R*.05,pt.x,pt.y,R);
    if(isTai){g.addColorStop(0,'#ffe060');g.addColorStop(.5,'#c8900a');g.addColorStop(1,'#7a4f00');}
    else{g.addColorStop(0,'#c490ff');g.addColorStop(.5,'#7820ef');g.addColorStop(1,'#2a0060');}
    ctx.save();ctx.beginPath();ctx.arc(pt.x,pt.y,R,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    ctx.strokeStyle=isTai?'#f5c842':'#a070ff';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();
    ctx.save();ctx.fillStyle='#fff';ctx.font='bold 9px Share Tech Mono,monospace';
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(val,pt.x,pt.y);ctx.restore();
  });
}};

new Chart(document.getElementById('sumChart'),{type:'line',plugins:[numberedPts],
  data:{labels:LABELS,datasets:[
    {label:'BB+',data:Array(N).fill(BOLL_UP),borderColor:'rgba(100,180,255,.18)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false,tension:0,order:10},
    {label:'BB-',data:Array(N).fill(BOLL_LOW),borderColor:'rgba(100,180,255,.18)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:{target:'-1',above:'rgba(100,180,255,.04)'},tension:0,order:10},
    {label:'Mid',data:Array(N).fill(BOLL_MID),borderColor:'rgba(100,180,255,.10)',borderWidth:1,borderDash:[6,5],pointRadius:0,fill:false,tension:0,order:10},
    {label:'Tổng',data:SUM_DATA,borderColor:'rgba(200,165,70,.6)',borderWidth:2,
      pointRadius:15,pointHoverRadius:17,
      pointBackgroundColor:SUM_DATA.map(v=>v>=11?'#a07000':'#4a0090'),
      pointBorderColor:SUM_DATA.map(v=>v>=11?'#f5c842':'#a070ff'),
      pointBorderWidth:2,tension:0,fill:false,order:0}
  ]},
  options:{responsive:true,animation:{duration:400},layout:{padding:{top:16,bottom:4,left:4,right:4}},
    scales:{
      y:{min:3,max:18,ticks:{color:'#806020',stepSize:3,font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.10)'}},
      x:{ticks:{color:'#604010',maxTicksLimit:15,font:{size:8,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.06)'}}
    },
    plugins:{legend:{display:false},
      annotation:{annotations:{
        mid:{type:'line',scaleID:'y',value:10.5,borderColor:'rgba(255,255,255,.07)',borderWidth:1,borderDash:[6,5]},
      }},
      tooltip:{backgroundColor:'rgba(6,4,0,.95)',titleColor:'#ffd700',bodyColor:'#e0c080',
        callbacks:{label:c=>{const v=c.parsed.y;if(c.dataset.label!=='Tổng')return c.dataset.label+': '+v.toFixed(1);return'Tổng: '+v+' → '+(v>=11?'🟡 Tài':'🟣 Xỉu');}}}
    }
  }
});

// Dice charts (25p)
function makeDiceChart(id,data,color,label){
  new Chart(document.getElementById(id),{type:'line',
    data:{labels:LABELS,datasets:[{
      label,data,borderColor:color,borderWidth:1.8,
      pointRadius:4,pointHoverRadius:6,
      pointBackgroundColor:data.map(v=>{const a=0.3+(v/6)*0.7;return color.replace(')',','+a+')').replace('rgb','rgba');}),
      pointBorderColor:color,pointBorderWidth:1.2,tension:0.3,
      fill:{target:'origin',above:color.replace(')',',0.05)').replace('rgb','rgba')}
    }]},
    options:{responsive:true,animation:{duration:300},layout:{padding:{top:6,bottom:2}},
      scales:{
        y:{min:0.5,max:6.5,ticks:{stepSize:1,color:'#604010',font:{size:9,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.07)'}},
        x:{ticks:{color:'#604010',maxTicksLimit:10,font:{size:7,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.04)'}}
      },
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(6,4,0,.95)',callbacks:{label:c=>label+': '+c.parsed.y}}}
    }
  });
}
makeDiceChart('d1Chart',D1_DATA,'rgb(245,166,66)','D1');
makeDiceChart('d2Chart',D2_DATA,'rgb(66,200,245)','D2');
makeDiceChart('d3Chart',D3_DATA,'rgb(160,245,66)','D3');

// Freq charts
function makeFreqChart(id,fData,color){
  const tot=fData.reduce((a,b)=>a+b,0)||1;
  const pcts=fData.map(v=>parseFloat((v/tot*100).toFixed(1)));
  const exp=100/6;
  new Chart(document.getElementById(id),{type:'bar',
    data:{labels:['1','2','3','4','5','6'],datasets:[{
      data:pcts,
      backgroundColor:pcts.map(p=>p>exp+3?color:p<exp-3?'rgba(255,90,90,.45)':'rgba(160,160,160,.22)'),
      borderColor:color,borderWidth:1,borderRadius:3
    }]},
    options:{responsive:true,animation:{duration:200},layout:{padding:{top:4}},
      scales:{
        y:{beginAtZero:true,ticks:{color:'#604010',font:{size:8,family:'Share Tech Mono'},callback:v=>v+'%'},grid:{color:'rgba(150,100,20,.07)'}},
        x:{ticks:{color:color,font:{size:10,family:'Share Tech Mono'}},grid:{display:false}}
      },
      plugins:{legend:{display:false},
        annotation:{annotations:{exp:{type:'line',scaleID:'y',value:exp,borderColor:'rgba(255,255,255,.15)',borderWidth:1,borderDash:[4,4]}}},
        tooltip:{backgroundColor:'rgba(6,4,0,.95)',callbacks:{label:c=>c.parsed.y+'% ('+fData[c.dataIndex]+')'}}
      }
    }
  });
}
makeFreqChart('freq1Chart',FREQS[0],'#f5a642');
makeFreqChart('freq2Chart',FREQS[1],'#42c8f5');
makeFreqChart('freq3Chart',FREQS[2],'#a0f542');

// 8-session path charts
if(P8S.length>=8){
  const pathOpts={responsive:true,animation:{duration:500},layout:{padding:{top:12,bottom:4}},
    plugins:{legend:{labels:{color:'#a09060',font:{size:10,family:'Share Tech Mono'},boxWidth:12}},
      tooltip:{backgroundColor:'rgba(6,4,0,.95)',titleColor:'#ffd700',bodyColor:'#e0c080'}}};

  new Chart(document.getElementById('path8SumChart'),{type:'line',
    data:{labels:P8L,datasets:[{
      label:'Tổng',data:P8S,
      borderColor:'rgba(245,200,80,.9)',borderWidth:2.5,
      pointRadius:P8S.map((_,i)=>i===P8S.length-1?10:7),
      pointBackgroundColor:P8S.map((v,i)=>{
        if(i===P8S.length-1) return v>=11?'#ffe040':'#c060ff';
        return v>=11?'#b07800':'#4a0090';
      }),
      pointBorderColor:P8S.map(v=>v>=11?'#f5c842':'#a070ff'),
      pointBorderWidth:2,tension:0.3,fill:{target:'origin',above:'rgba(245,200,80,.07)',below:'rgba(245,200,80,.03)'}
    }]},
    options:{...pathOpts,scales:{
      y:{min:3,max:18,ticks:{stepSize:3,color:'#806020',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.10)'},
        afterFit(a){a.width=36;}},
      x:{ticks:{color:'#806020',font:{size:9,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.07)'}}
    },plugins:{...pathOpts.plugins,
      annotation:{annotations:{
        mid:{type:'line',scaleID:'y',value:10.5,borderColor:'rgba(255,255,255,.10)',borderWidth:1,borderDash:[5,5]},
        tai:{type:'box',scaleID:'y',yMin:11,yMax:18,backgroundColor:'rgba(245,200,66,.04)',borderWidth:0},
        xiu:{type:'box',scaleID:'y',yMin:3,yMax:10.5,backgroundColor:'rgba(160,112,255,.04)',borderWidth:0},
      }}
    }}
  });

  new Chart(document.getElementById('path8DiceChart'),{type:'line',
    data:{labels:P8L,datasets:[
      {label:'D1',data:P8D1,borderColor:'rgba(245,166,66,.9)',borderWidth:2,pointRadius:P8D1.map((_,i)=>i===P8D1.length-1?8:5),
        pointBackgroundColor:'rgba(245,166,66,.8)',pointBorderColor:'#f5a642',pointBorderWidth:1.5,tension:0.3,fill:false},
      {label:'D2',data:P8D2,borderColor:'rgba(66,200,245,.9)',borderWidth:2,pointRadius:P8D2.map((_,i)=>i===P8D2.length-1?8:5),
        pointBackgroundColor:'rgba(66,200,245,.8)',pointBorderColor:'#42c8f5',pointBorderWidth:1.5,tension:0.3,fill:false},
      {label:'D3',data:P8D3,borderColor:'rgba(160,245,66,.9)',borderWidth:2,pointRadius:P8D3.map((_,i)=>i===P8D3.length-1?8:5),
        pointBackgroundColor:'rgba(160,245,66,.8)',pointBorderColor:'#a0f542',pointBorderWidth:1.5,tension:0.3,fill:false},
    ]},
    options:{...pathOpts,scales:{
      y:{min:0.5,max:6.5,ticks:{stepSize:1,color:'#806020',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.10)'},
        afterFit(a){a.width=36;}},
      x:{ticks:{color:'#806020',font:{size:9,family:'Share Tech Mono'}},grid:{color:'rgba(150,100,20,.07)'}}
    },plugins:{...pathOpts.plugins,
      annotation:{annotations:{mid:{type:'line',scaleID:'y',value:3.5,borderColor:'rgba(255,255,255,.08)',borderWidth:1,borderDash:[4,4]}}}
    }}
  });
}

setTimeout(()=>location.reload(),12000);
<\/script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {"Access-Control-Allow-Origin":"*"}); res.end(); return;
  }
  await syncHistory();

  const noData = (code=503, msg="Chưa có dữ liệu") => {
    res.writeHead(code, {"Content-Type":"application/json;charset=utf-8","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({loi:msg}));
  };

  if (url.pathname === "/bando") {
    if (!history.length) { noData(); return; }
    const pred = predict(history);
    res.writeHead(200, {"Content-Type":"text/html;charset=utf-8"});
    res.end(buildHTML(pred, history[0])); return;
  }

  res.setHeader("Content-Type","application/json;charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");

  if (url.pathname==="/"||url.pathname==="/predict") {
    if (!history.length){noData();return;}
    const h=history[0],p=predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai:h.phien, xuc_xac:h.dice, tong:h.tong,
      ket_qua_hien:h.type==="T"?"Tài":"Xỉu",
      phien_du_doan:String(Number(h.phien)+1),
      du_doan:p.nextDisplay, do_tin_cay:p.confDisplay,
      consensus_pct:Math.round((p.ratio||0)*100)+"%",
      signals_T:p.cntT, signals_X:p.cntX,
      backtest_wr:p.backtest?.wr??null,
      signal_count:p.signalCount,
      muted_algos:p.mutedAlgos.map(m=>m.name),
      ver:"v13"
    }));return;
  }

  if (url.pathname==="/predict/detail") {
    if (!history.length){noData();return;}
    const p=predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan:p.nextDisplay, do_tin_cay:p.confDisplay,
      consensus:p.ratio, cntT:p.cntT, cntX:p.cntX,
      backtest:p.backtest, signals:p.signals,
      streak:p.streak, path:p.path,
      muted_algos:p.mutedAlgos,
      chart_db:chartDB.length, dice_db:DICE_DB.map(d=>d.length),
      ver:"v13"
    }));return;
  }

  if (url.pathname==="/sunlon") {
    if (!history.length){noData();return;}
    const h=history[0],p=predict(history);
    const pattern=history.slice(0,30).map(x=>x.type).reverse().join("");
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai:Number(h.phien),ket_qua:h.type==="T"?"Tai":"Xiu",
      xuc_xac:h.dice,phien_du_doan:Number(h.phien)+1,
      du_doan:p.next==="T"?"Tai":"Xiu",do_tin_cay:p.confDisplay,
      pattern,id:"@sewdangcap"
    }));return;
  }

  if (url.pathname==="/history") {
    const lim=Math.min(parseInt(url.searchParams.get("limit")||"20"),200);
    res.writeHead(200);
    res.end(JSON.stringify({tong_so:history.length,
      du_lieu:history.slice(0,lim).map(h=>({phien:h.phien,xuc_xac:h.dice,tong:h.tong,ket_qua:h.type==="T"?"Tài":"Xỉu"}))}));
    return;
  }

  if (url.pathname==="/algo/status") {
    res.writeHead(200);
    res.end(JSON.stringify(
      Object.entries(algoRecentPerf).map(([k,v])=>({
        name:k, muted:v.muted,
        recentWR:v.buf.length?v.buf.reduce((s,x)=>s+x,0)/v.buf.length:null,
        samples:v.buf.length
      })), null, 2));
    return;
  }

  if (url.pathname==="/debug") {
    const r=await fetchSource().catch(e=>({loi:e.message}));
    res.writeHead(200);res.end(JSON.stringify(r,null,2));return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    loi:"Không tìm thấy",
    endpoints:["/","/predict","/predict/detail","/history","/bando","/sunlon","/algo/status","/debug"],
    ver:"v13"
  }));

}).listen(PORT, ()=>{
  console.log(`✅  SicBo v13.0 — Rolling Window + Adaptive Mute + 8-Session Path — port ${PORT}`);
  console.log(`    Dashboard   : http://localhost:${PORT}/bando`);
  console.log(`    API         : http://localhost:${PORT}/predict`);
  console.log(`    Algo Status : http://localhost:${PORT}/algo/status`);
  console.log(`\n    Architecture:`);
  console.log(`    ┌─ Rolling Window: ${ROLL_WINDOW}p (không dùng toàn bộ lịch sử)`);
  console.log(`    ├─ Temporal Decay: recent sessions weighted more (halfLife=60p)`);
  console.log(`    ├─ Adaptive Mute: algo bị tắt nếu recent WR < ${MUTE_WR*100}%`);
  console.log(`    ├─ Strict Consensus: cần ≥${MIN_AGREE} signal đồng thuận`);
  console.log(`    ├─ Ngưỡng: WR≥${MIN_WR*100}%, N≥${MIN_N}`);
  console.log(`    └─ 8-Session Path Analysis: dice trajectory + pattern detection`);
  console.log(`\n    Thuật toán:`);
  console.log(`    Markov-1/2/3 (rolling+decay) · M-Invert (anti-gãy) · Streak (decay)`);
  console.log(`    Pattern6 (decay) · XenKe (decay) · MeanRev · Momentum`);
  console.log(`    ChartSum (Pearson+decay) · DicePath (8p,3dice) · DiceTrend · SumZone`);
  syncHistory();
  setInterval(syncHistory, 12000);
});
