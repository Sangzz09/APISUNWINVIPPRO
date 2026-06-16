"use strict";
const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://apilichsusunwinsew.onrender.com/api/taixiu/history?limit=50";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 600;

let history = [];

// ═══════════════════════════════════════════════
//  DATA INGESTION
// ═══════════════════════════════════════════════
function fetchSource() {
  return new Promise((resolve, reject) => {
    const u   = new URL(SOURCE_URL);
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
  return Math.sqrt(arr.reduce((s,v) => s + (v-m)**2, 0) / arr.length);
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

// ═══════════════════════════════════════════════
//  SIGNAL INTERFACE
// ═══════════════════════════════════════════════
const MIN_WIN_RATE = 0.52;
const MIN_SAMPLES  = 8;

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 1: MARKOV CHAIN
// ═══════════════════════════════════════════════
function markov(seq, order) {
  if (seq.length < order + 1 + MIN_SAMPLES) return null;
  const table = {};
  for (let p = 1; p <= seq.length - order; p++) {
    const stateKey = seq.slice(p, p + order).join("");
    const outcome  = seq[p - 1];
    if (!table[stateKey]) table[stateKey] = { T: 0, X: 0 };
    table[stateKey][outcome]++;
  }
  const curState = seq.slice(0, order).join("");
  const c = table[curState];
  if (!c || (c.T + c.X) === 0) return null;
  const signal = c.T >= c.X ? "T" : "X";
  let wins = 0, total = 0;
  for (let p = 1; p <= seq.length - order - 1; p++) {
    const st = seq.slice(p, p + order).join("");
    if (st !== curState) continue;
    const tb = table[st];
    const pred = (tb.T >= tb.X) ? "T" : "X";
    const actual = seq[p - 1];
    if (pred === actual) wins++;
    total++;
  }
  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;
  return {
    signal, winRate: wr, sampleCount: total,
    source: `Markov-${order}`,
    detail: `State [${curState}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 2: CẦU BỆT
// ═══════════════════════════════════════════════
function streakCau(seq) {
  if (seq.length < MIN_SAMPLES + 3) return null;
  const curType = seq[0];
  let curStreak = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] === curType) curStreak++;
    else break;
  }
  if (curStreak < 2) return null;
  let breakCount = 0, contCount = 0;
  for (let p = 1; p <= seq.length - curStreak - 1; p++) {
    const t = seq[p];
    let len = 0;
    for (let j = p; j < seq.length && seq[j] === t; j++) len++;
    if (len !== curStreak) continue;
    if (p + curStreak < seq.length && seq[p + curStreak] === t) continue;
    const outcome = seq[p - 1];
    if (outcome === t) contCount++;
    else               breakCount++;
  }
  const total = breakCount + contCount;
  if (total < MIN_SAMPLES) return null;
  const breakRate = breakCount / total;
  const contRate  = contCount  / total;
  if (breakRate > MIN_WIN_RATE) {
    const opp = curType === "T" ? "X" : "T";
    return { signal: opp, winRate: breakRate, sampleCount: total, source: "Cầu Bệt",
      detail: `Bệt ${curStreak}×${curType==="T"?"Tài":"Xỉu"} → đảo WR=${(breakRate*100).toFixed(0)}% (${total} mẫu)` };
  }
  if (contRate > MIN_WIN_RATE) {
    return { signal: curType, winRate: contRate, sampleCount: total, source: "Cầu Bệt",
      detail: `Bệt ${curStreak}×${curType==="T"?"Tài":"Xỉu"} → tiếp WR=${(contRate*100).toFixed(0)}% (${total} mẫu)` };
  }
  return null;
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 3: CẦU XEN KẼ
// ═══════════════════════════════════════════════
function alternating(seq) {
  if (seq.length < MIN_SAMPLES + 4) return null;
  let altLen = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i-1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;
  const expectedIfAlt = seq[0] === "T" ? "X" : "T";
  let wins = 0, total = 0;
  for (let p = 1; p + altLen <= seq.length; p++) {
    let L = 1;
    for (let i = p+1; i < seq.length; i++) {
      if (seq[i] !== seq[i-1]) L++;
      else break;
    }
    if (L !== altLen) continue;
    if (p + L < seq.length && seq[p+L] !== seq[p+L-1]) continue;
    const predictedOutcome = seq[p] === "T" ? "X" : "T";
    const actual = seq[p - 1];
    if (predictedOutcome === actual) wins++;
    total++;
    if (total >= 60) break;
  }
  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;
  return { signal: expectedIfAlt, winRate: wr, sampleCount: total, source: "Cầu 1-1",
    detail: `Xen kẽ ${altLen} phiên → ${expectedIfAlt==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)` };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 4: N-GRAM PATTERN
// ═══════════════════════════════════════════════
function ngram(seq, n) {
  if (seq.length < n + MIN_SAMPLES + 1) return null;
  const curPat = seq.slice(0, n).join("");
  let countT = 0, countX = 0;
  for (let p = 1; p + n <= seq.length; p++) {
    if (seq.slice(p, p+n).join("") !== curPat) continue;
    if (seq[p-1] === "T") countT++;
    else countX++;
  }
  const total = countT + countX;
  if (total < MIN_SAMPLES) return null;
  const signal = countT >= countX ? "T" : "X";
  const wr = Math.max(countT, countX) / total;
  if (wr < MIN_WIN_RATE) return null;
  return { signal, winRate: wr, sampleCount: total, source: `${n}-gram`,
    detail: `Pattern [${curPat}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)` };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 5: CÂN BẰNG (Mean Reversion)
// ═══════════════════════════════════════════════
function meanReversion(hist) {
  if (hist.length < 60) return null;
  const W = 30;
  const recent = hist.slice(0, W);
  const ratioT = recent.filter(h => h.type === "T").length / W;
  let wins = 0, total = 0;
  for (let p = W; p + W < hist.length; p++) {
    const window = hist.slice(p, p + W);
    const r = window.filter(h => h.type === "T").length / W;
    const next10 = hist.slice(p - 10, p);
    if (next10.length < 5) continue;
    const nextT = next10.filter(h => h.type === "T").length / next10.length;
    if (r > 0.62) { total++; if (nextT < 0.50) wins++; }
    else if (r < 0.38) { total++; if (nextT > 0.50) wins++; }
  }
  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;
  if (ratioT > 0.62) {
    return { signal: "X", winRate: wr, sampleCount: total, source: "Cân Bằng",
      detail: `Tài ${(ratioT*100).toFixed(0)}%/30p → hồi quy Xỉu WR=${(wr*100).toFixed(0)}%` };
  }
  if (ratioT < 0.38) {
    return { signal: "T", winRate: wr, sampleCount: total, source: "Cân Bằng",
      detail: `Xỉu ${((1-ratioT)*100).toFixed(0)}%/30p → hồi quy Tài WR=${(wr*100).toFixed(0)}%` };
  }
  return null;
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 6: CHART PATTERN (Tổng)
// ═══════════════════════════════════════════════
const CHART_W  = 10;
const MIN_CORR = 0.80;
const MAX_DB   = 300;
const chartDB  = [];

function shapeLabel(normArr) {
  const n = normArr.length;
  const half = Math.floor(n/2);
  const first = mean(normArr.slice(0, half));
  const second = mean(normArr.slice(half));
  const slope = second - first;
  const mid = normArr[Math.floor(n/2)];
  const avgEdge = (normArr[0] + normArr[n-1]) / 2;
  const curv = mid - avgEdge;
  let s = slope > 0.3 ? "Tăng" : slope < -0.3 ? "Giảm" : "Ngang";
  let c = curv > 0.3 ? "-Lồi" : curv < -0.3 ? "-Lõm" : "";
  const vol = stdDev(normArr);
  let v = vol > 1.3 ? " Dao Động" : vol < 0.5 ? " Ổn Định" : "";
  return s + c + v;
}

function updateChartDB(hist) {
  if (hist.length < CHART_W + 2) return;
  for (let p = 1; p + CHART_W <= hist.length; p++) {
    const window = hist.slice(p, p + CHART_W).map(h => h.tong).reverse();
    const norm = normalize(window);
    const outcome = hist[p - 1].type;
    let bestIdx = -1, bestCorr = -1;
    for (let i = 0; i < chartDB.length; i++) {
      const corr = pearson(chartDB[i].normShape, norm);
      if (corr > bestCorr) { bestCorr = corr; bestIdx = i; }
    }
    if (bestCorr >= MIN_CORR && bestIdx >= 0) {
      chartDB[bestIdx].totalSeen++;
      if (outcome === "T") chartDB[bestIdx].winsT++;
      else chartDB[bestIdx].winsX++;
    } else {
      chartDB.push({ normShape: norm, label: shapeLabel(norm), totalSeen: 1,
        winsT: outcome === "T" ? 1 : 0, winsX: outcome === "X" ? 1 : 0 });
      if (chartDB.length > MAX_DB) {
        chartDB.sort((a,b) => b.totalSeen - a.totalSeen);
        chartDB.splice(MAX_DB);
      }
    }
  }
}

function predictChart(hist) {
  if (hist.length < CHART_W + 2) return null;
  updateChartDB(hist);
  const curWindow = hist.slice(0, CHART_W).map(h => h.tong).reverse();
  const curNorm   = normalize(curWindow);
  const curLabel  = shapeLabel(curNorm);
  const matches = [];
  for (const entry of chartDB) {
    if (entry.totalSeen < 3) continue;
    const corr = pearson(entry.normShape, curNorm);
    if (corr >= MIN_CORR) matches.push({ entry, corr });
  }
  if (!matches.length) return null;
  let wT = 0, wX = 0;
  for (const { entry, corr } of matches) {
    const total = entry.totalSeen;
    const w = corr * Math.log(1 + total);
    wT += w * (entry.winsT / total);
    wX += w * (entry.winsX / total);
  }
  if (wT + wX < 0.001) return null;
  const prob = wT / (wT + wX);
  const signal = prob >= 0.5 ? "T" : "X";
  const wr = Math.max(prob, 1-prob);
  if (wr < MIN_WIN_RATE) return null;
  const totalSeen = matches.reduce((s, m) => s + m.entry.totalSeen, 0);
  return { signal, winRate: wr, sampleCount: totalSeen, source: "Chart Tổng",
    detail: `[${curLabel}] khớp ${matches.length} mẫu → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`,
    shapeName: curLabel, matchCount: matches.length };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 7: DICE INDIVIDUAL CHART PATTERN
//  Phân tích hình dạng đồ thị từng xúc xắc (d1, d2, d3) riêng lẻ
//  Mỗi xúc xắc có DB pattern riêng → vote tổng hợp
// ═══════════════════════════════════════════════
const DICE_W   = 8;   // cửa sổ 8 phiên cho từng xúc xắc
const DICE_MIN_CORR = 0.78;
const DICE_MAX_DB   = 200;
const diceDB = [[], [], []]; // DB cho d1, d2, d3

function updateDiceDB(hist) {
  if (hist.length < DICE_W + 2) return;
  for (let di = 0; di < 3; di++) {
    const db = diceDB[di];
    for (let p = 1; p + DICE_W <= hist.length; p++) {
      const window = hist.slice(p, p + DICE_W).map(h => h.dice[di]).reverse();
      const norm = normalize(window);
      const outcome = hist[p - 1].type;
      let bestIdx = -1, bestCorr = -1;
      for (let i = 0; i < db.length; i++) {
        const corr = pearson(db[i].normShape, norm);
        if (corr > bestCorr) { bestCorr = corr; bestIdx = i; }
      }
      if (bestCorr >= DICE_MIN_CORR && bestIdx >= 0) {
        db[bestIdx].totalSeen++;
        if (outcome === "T") db[bestIdx].winsT++;
        else db[bestIdx].winsX++;
      } else {
        db.push({ normShape: norm, totalSeen: 1,
          winsT: outcome === "T" ? 1 : 0, winsX: outcome === "X" ? 1 : 0 });
        if (db.length > DICE_MAX_DB) {
          db.sort((a,b) => b.totalSeen - a.totalSeen);
          db.splice(DICE_MAX_DB);
        }
      }
    }
  }
}

function predictDice(hist) {
  if (hist.length < DICE_W + 2) return null;
  updateDiceDB(hist);
  let totalWT = 0, totalWX = 0, totalSamples = 0, activeCount = 0;
  const diceSignals = [];

  for (let di = 0; di < 3; di++) {
    const db = diceDB[di];
    const curWindow = hist.slice(0, DICE_W).map(h => h.dice[di]).reverse();
    const curNorm   = normalize(curWindow);
    const matches = [];
    for (const entry of db) {
      if (entry.totalSeen < 3) continue;
      const corr = pearson(entry.normShape, curNorm);
      if (corr >= DICE_MIN_CORR) matches.push({ entry, corr });
    }
    if (!matches.length) { diceSignals.push(null); continue; }
    let wT = 0, wX = 0;
    for (const { entry, corr } of matches) {
      const total = entry.totalSeen;
      const w = corr * Math.log(1 + total);
      wT += w * (entry.winsT / total);
      wX += w * (entry.winsX / total);
    }
    if (wT + wX < 0.001) { diceSignals.push(null); continue; }
    const prob = wT / (wT + wX);
    const sig = prob >= 0.5 ? "T" : "X";
    const wr = Math.max(prob, 1-prob);
    const seen = matches.reduce((s, m) => s + m.entry.totalSeen, 0);
    diceSignals.push({ signal: sig, winRate: wr, sampleCount: seen, dice: di+1 });
    totalWT += wT; totalWX += wX;
    totalSamples += seen;
    activeCount++;
  }

  if (activeCount === 0) return null;
  const prob = totalWT / (totalWT + totalWX);
  const signal = prob >= 0.5 ? "T" : "X";
  const wr = Math.max(prob, 1-prob);
  if (wr < MIN_WIN_RATE) return null;

  // Build detail string
  const diceLabels = diceSignals.map((ds, i) => {
    if (!ds) return `D${i+1}:?`;
    return `D${i+1}:${ds.signal==="T"?"▲":"▼"}${(ds.winRate*100).toFixed(0)}%`;
  }).join(" ");

  return {
    signal, winRate: wr, sampleCount: Math.round(totalSamples / Math.max(activeCount,1)),
    source: "Chart Xúc Xắc",
    detail: `[${diceLabels}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`,
    diceSignals
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 8: DICE MARKOV
//  Mỗi xúc xắc có xu hướng lặp lại giá trị không?
//  Phân nhóm: thấp(1-2), trung(3-4), cao(5-6) → Markov 1 bậc
// ═══════════════════════════════════════════════
function diceGroupMarkov(hist) {
  if (hist.length < MIN_SAMPLES + 5) return null;

  function group(v) { return v <= 2 ? "L" : v <= 4 ? "M" : "H"; }

  const results = [];
  for (let di = 0; di < 3; di++) {
    const seq = hist.map(h => group(h.dice[di]));
    // State = current group, xem tổng tiếp theo là T hay X
    const table = {};
    for (let p = 1; p < seq.length; p++) {
      const key = seq[p]; // trạng thái tại p
      const outcome = hist[p-1].type; // kết quả phiên mới hơn
      if (!table[key]) table[key] = { T: 0, X: 0 };
      table[key][outcome]++;
    }
    const curGroup = seq[0];
    const c = table[curGroup];
    if (!c || (c.T + c.X) < MIN_SAMPLES) continue;
    const wr = Math.max(c.T, c.X) / (c.T + c.X);
    if (wr < MIN_WIN_RATE) continue;
    const sig = c.T >= c.X ? "T" : "X";
    results.push({ dice: di+1, group: curGroup, sig, wr, n: c.T + c.X });
  }

  if (!results.length) return null;
  // Vote theo weight
  let wT = 0, wX = 0, totalN = 0;
  for (const r of results) {
    const w = r.wr * Math.log(1 + r.n);
    if (r.sig === "T") wT += w; else wX += w;
    totalN += r.n;
  }
  const signal = wT >= wX ? "T" : "X";
  const prob = Math.max(wT, wX) / (wT + wX);
  if (prob < MIN_WIN_RATE) return null;

  const groups = {"L":"Thấp","M":"Trung","H":"Cao"};
  const detail = results.map(r => `D${r.dice}(${groups[r.group]}):${r.sig==="T"?"▲":"▼"}`).join(" ");
  return {
    signal, winRate: prob, sampleCount: Math.round(totalN/results.length),
    source: "Dice Markov",
    detail: `[${detail}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(prob*100).toFixed(0)}%`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 9: DICE CORRELATION
//  Phân tích tương quan giữa 3 xúc xắc
//  Khi d1 cao & d2 cao → xu hướng Tài mạnh hơn không?
//  Encode: {d1_grp, d2_grp, d3_grp} → T/X count
// ═══════════════════════════════════════════════
function diceCorrelation(hist) {
  if (hist.length < 30) return null;
  function group(v) { return v <= 3 ? "L" : "H"; } // đơn giản: Thấp/Cao

  const table = {};
  for (let p = 1; p < hist.length; p++) {
    const h = hist[p];
    const key = `${group(h.dice[0])},${group(h.dice[1])},${group(h.dice[2])}`;
    const outcome = hist[p-1].type;
    if (!table[key]) table[key] = { T: 0, X: 0 };
    table[key][outcome]++;
  }

  // Trạng thái xúc xắc hiện tại
  const cur = hist[0];
  const curKey = `${group(cur.dice[0])},${group(cur.dice[1])},${group(cur.dice[2])}`;
  const c = table[curKey];
  if (!c || (c.T + c.X) < MIN_SAMPLES) return null;
  const wr = Math.max(c.T, c.X) / (c.T + c.X);
  if (wr < MIN_WIN_RATE) return null;
  const signal = c.T >= c.X ? "T" : "X";

  return {
    signal, winRate: wr, sampleCount: c.T + c.X,
    source: "Dice Corr",
    detail: `Tổ hợp [${curKey}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${c.T+c.X} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 10: DICE SUM TREND
//  Phân tích xu hướng từng xúc xắc (tăng/giảm/ngang) trong 5 phiên gần
//  rồi dự đoán kết quả tiếp theo
// ═══════════════════════════════════════════════
function diceTrend(hist) {
  if (hist.length < 20) return null;
  const W = 5;

  // Tính slope cho từng xúc xắc
  function slope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += vals[i]; sxy += i*vals[i]; sx2 += i*i; }
    const d = n*sx2 - sx*sx;
    return d ? (n*sxy - sx*sy) / d : 0;
  }

  function trendCode(s) { return s > 0.3 ? "U" : s < -0.3 ? "D" : "F"; }

  // Xây bảng: key = trendCode của 3 xúc xắc (UUU, UDF,...) → {T,X}
  const table = {};
  for (let p = W; p < hist.length; p++) {
    const window = hist.slice(p, p + W).map(h => h.dice).reverse(); // cũ→mới
    const slopes = [0,1,2].map(di => slope(window.map(d => d[di])));
    const key = slopes.map(trendCode).join("");
    const outcome = hist[p-1].type;
    if (!table[key]) table[key] = { T: 0, X: 0 };
    table[key][outcome]++;
  }

  const curWindow = hist.slice(0, W).map(h => h.dice).reverse();
  const curSlopes = [0,1,2].map(di => slope(curWindow.map(d => d[di])));
  const curKey = curSlopes.map(trendCode).join("");
  const c = table[curKey];
  if (!c || (c.T + c.X) < MIN_SAMPLES) return null;
  const wr = Math.max(c.T, c.X) / (c.T + c.X);
  if (wr < MIN_WIN_RATE) return null;
  const signal = c.T >= c.X ? "T" : "X";
  const labels = { U: "↑", D: "↓", F: "→" };
  const trendStr = curSlopes.map((s,i) => `D${i+1}${labels[trendCode(s)]}`).join(" ");

  return {
    signal, winRate: wr, sampleCount: c.T + c.X,
    source: "Dice Trend",
    detail: `[${trendStr}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${c.T+c.X} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  ENSEMBLE
// ═══════════════════════════════════════════════
function ensemble(signals) {
  if (!signals.length) return { signal: null, confidence: 0.5 };
  let wT = 0, wX = 0;
  for (const s of signals) {
    const w = s.winRate * Math.log(1 + s.sampleCount);
    if (s.signal === "T") wT += w;
    else                  wX += w;
  }
  const total = wT + wX;
  if (total < 0.001) return { signal: null, confidence: 0.5 };
  const signal = wT >= wX ? "T" : "X";
  const rawConf = Math.max(wT, wX) / total;
  const confidence = 0.50 + Math.min(rawConf - 0.50, 0.30);
  return { signal, confidence };
}

// ═══════════════════════════════════════════════
//  BACKTEST
// ═══════════════════════════════════════════════
function backtestSystem(hist, trials = 30) {
  if (hist.length < trials + 20) return null;
  let wins = 0, total = 0;
  for (let i = 1; i <= trials; i++) {
    const subHist = hist.slice(i);
    if (subHist.length < 20) continue;
    const subSeq  = subHist.map(h => h.type);
    const sigs    = collectSignals(subSeq, subHist);
    if (!sigs.length) continue;
    const { signal } = ensemble(sigs);
    if (!signal) continue;
    const actual = hist[i-1].type;
    if (signal === actual) wins++;
    total++;
  }
  if (!total) return null;
  return { wins, total, wr: wins / total };
}

// ═══════════════════════════════════════════════
//  COLLECT ALL SIGNALS
// ═══════════════════════════════════════════════
function collectSignals(seq, hist) {
  const results = [];
  const add = (r) => { if (r) results.push(r); };
  add(markov(seq, 1));
  add(markov(seq, 2));
  add(markov(seq, 3));
  add(streakCau(seq));
  add(alternating(seq));
  add(ngram(seq, 5));
  add(ngram(seq, 4));
  if (hist) add(meanReversion(hist));
  if (hist) add(predictChart(hist));
  if (hist) add(predictDice(hist));
  if (hist) add(diceGroupMarkov(hist));
  if (hist) add(diceCorrelation(hist));
  if (hist) add(diceTrend(hist));
  return results;
}

// ═══════════════════════════════════════════════
//  MAIN PREDICT
// ═══════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 15) {
    return { next: null, nextDisplay: "Chưa đủ dữ liệu", confidence: 0.5, confDisplay: "50%",
      signals: [], backtest: null, typeSeq: [], sumChart: [], streak: 0, curType: "?",
      chartDBSize: chartDB.length, diceSig: null };
  }
  const seq     = hist.map(h => h.type);
  const signals = collectSignals(seq, hist);
  const { signal, confidence } = ensemble(signals);
  const backtest = backtestSystem(hist, 30);
  const curType = seq[0];
  let streak = 0;
  for (const t of seq) { if (t === curType) streak++; else break; }
  const chartSig = signals.find(s => s.source === "Chart Tổng");
  const diceSig  = signals.find(s => s.source === "Chart Xúc Xắc");
  const vT = signals.filter(s => s.signal === "T").reduce((s,r) => s + r.winRate, 0);
  const vX = signals.filter(s => s.signal === "X").reduce((s,r) => s + r.winRate, 0);

  // Dice stats: avg, trend
  const diceStats = [0,1,2].map(di => {
    const vals = hist.slice(0, 20).map(h => h.dice[di]);
    return { avg: mean(vals).toFixed(2), std: stdDev(vals).toFixed(2),
             recent: hist.slice(0,5).map(h => h.dice[di]) };
  });

  return {
    next: signal, nextDisplay: signal === "T" ? "Tài" : signal === "X" ? "Xỉu" : "?",
    confidence, confDisplay: Math.round(confidence * 100) + "%",
    signals, signalCount: signals.length,
    backtest, typeSeq: seq.slice(0, 25),
    sumChart: hist.slice(0, 25).map(h => h.tong),
    diceCharts: {
      d1: hist.slice(0, 25).map(h => h.dice[0]),
      d2: hist.slice(0, 25).map(h => h.dice[1]),
      d3: hist.slice(0, 25).map(h => h.dice[2]),
    },
    streak, curType,
    votesT: vT.toFixed(2), votesX: vX.toFixed(2),
    chartDBSize: chartDB.length,
    chartSignal: chartSig || null,
    currentShape: chartSig ? chartSig.shapeName : null,
    diceSig: diceSig || null,
    diceStats,
    diceDBSizes: diceDB.map(db => db.length),
  };
}

// ═══════════════════════════════════════════════
//  DICE FREQUENCY ANALYSIS
// ═══════════════════════════════════════════════
function diceFreqAnalysis(hist, n = 50) {
  const slice = hist.slice(0, Math.min(n, hist.length));
  return [0,1,2].map(di => {
    const freq = [0,0,0,0,0,0,0]; // idx 1-6
    for (const h of slice) freq[h.dice[di]]++;
    return freq.slice(1); // [count for 1, count for 2, ... count for 6]
  });
}

// ═══════════════════════════════════════════════
//  HTML BUILDER
// ═══════════════════════════════════════════════
function buildHTML(pred, h) {
  const n = Math.min(pred.sumChart.length, 25);
  const labels  = JSON.stringify(Array.from({length:n}, (_,i) => String(Number(h.phien) - (n-1-i))));
  const sumData = JSON.stringify([...pred.sumChart.slice(0,n)].reverse());
  const d1Data  = JSON.stringify([...pred.diceCharts.d1.slice(0,n)].reverse());
  const d2Data  = JSON.stringify([...pred.diceCharts.d2.slice(0,n)].reverse());
  const d3Data  = JSON.stringify([...pred.diceCharts.d3.slice(0,n)].reverse());
  const typeData = JSON.stringify([...pred.typeSeq.slice(0,n)].reverse());

  // Dice freq
  const freqs = diceFreqAnalysis(history, 50);
  const freqJSON = JSON.stringify(freqs);

  const isTai     = pred.next === "T";
  const predColor = isTai ? "#f5c842" : "#a070ff";
  const predBg    = isTai ? "rgba(245,200,66,0.10)" : "rgba(160,112,255,0.10)";
  const btWR      = pred.backtest ? (pred.backtest.wr * 100).toFixed(1) : "N/A";
  const btTotal   = pred.backtest ? pred.backtest.total : 0;
  const confPct   = Math.round(pred.confidence * 100);
  const sumArr    = pred.sumChart;
  const bolMid    = parseFloat(mean(sumArr).toFixed(2));
  const bolSd     = parseFloat(stdDev(sumArr).toFixed(2));
  const bolUp     = parseFloat((bolMid + 2*bolSd).toFixed(2));
  const bolLow    = parseFloat((bolMid - 2*bolSd).toFixed(2));
  const vT  = Number(pred.votesT), vX = Number(pred.votesX);
  const pctT = (vT+vX) > 0 ? Math.round(vT/(vT+vX)*100) : 50;
  const pctX = 100 - pctT;

  // Dice signal display
  const diceSigRows = pred.diceSig ? pred.diceSig.diceSignals.map((ds, i) => {
    if (!ds) return `<span class="dice-sig-nil">D${i+1}: ?</span>`;
    const col = ds.signal === "T" ? "#f5c842" : "#a070ff";
    return `<span class="dice-sig-item" style="border-color:${col}">
      <span style="color:${col}">D${i+1}</span>
      <span style="color:${col};font-weight:700">${ds.signal==="T"?"▲":"▼"}${(ds.winRate*100).toFixed(0)}%</span>
    </span>`;
  }).join("") : '<span style="color:#555;font-size:.7rem">Đang xây dựng kho...</span>';

  const sigRows = pred.signals.map(s => {
    const isT = s.signal === "T";
    const srcColor = s.source.includes("Dice") || s.source.includes("Chart Xúc") ? "#66ddaa" : "#8a6a30";
    return `<tr>
      <td class="td-src" style="color:${srcColor}">${s.source}</td>
      <td class="${isT?"sig-t":"sig-x"}">${isT?"▲ Tài":"▼ Xỉu"}</td>
      <td class="td-wr">${(s.winRate*100).toFixed(0)}%</td>
      <td class="td-n">${s.sampleCount}</td>
      <td class="td-detail">${s.detail}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;padding:8px;font-size:.78rem">Chưa đủ mẫu</td></tr>`;

  const topDB = [...chartDB].filter(e => e.totalSeen >= 3)
    .sort((a,b) => b.totalSeen - a.totalSeen).slice(0, 6);
  const dbRows = topDB.map((e,i) => {
    const total = e.totalSeen;
    const pT = e.winsT / total;
    const pred2 = pT >= pT ? (e.winsT >= e.winsX ? "T" : "X") : "X";
    const wr = Math.max(e.winsT, e.winsX) / total;
    return `<tr>
      <td class="td-src">#${i+1}</td>
      <td style="color:#7a8a70;font-size:.62rem;max-width:120px">${e.label}</td>
      <td class="${pred2==="T"?"sig-t":"sig-x"}">${pred2==="T"?"▲ T":"▼ X"}</td>
      <td class="td-wr">${(wr*100).toFixed(0)}%</td>
      <td class="td-n">${total}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;font-size:.75rem;padding:6px">Đang xây dựng...</td></tr>`;

  const diceStatHTML = [0,1,2].map(di => {
    const ds = pred.diceStats[di];
    const col = ["#f5a642","#42c8f5","#a0f542"][di];
    return `<div class="dstat" style="--dc:${col}">
      <div class="dstat-lbl">Xúc Xắc ${di+1}</div>
      <div class="dstat-avg" style="color:${col}">${ds.avg}</div>
      <div class="dstat-sub">±${ds.std}</div>
      <div class="dstat-hist">${ds.recent.map(v => `<span class="dv" style="height:${(v/6*100).toFixed(0)}%;background:${col}">${v}</span>`).join("")}</div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v11 — SUNWIN</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#c8960a;--gl:#f5c842;--tai:#f5c842;--xiu:#a070ff;
  --bg:#0d0900;--bg2:#160e03;--bg3:#1e1404;--bdr:rgba(180,130,10,.28);
  --txt:#e8d8a0;--dim:#9a7a40;
  --d1:#f5a642;--d2:#42c8f5;--d3:#a0f542;
  --mono:'Share Tech Mono',monospace;--head:'Rajdhani',sans-serif;
}
body{background:var(--bg);min-height:100vh;color:var(--txt);font-family:var(--head);padding:10px}
.hdr{display:flex;align-items:center;justify-content:space-between;
  background:linear-gradient(90deg,#1e0a00,#0f0600,#1e0a00);
  border:1px solid var(--bdr);border-radius:10px;padding:10px 16px;margin-bottom:10px}
.hdr-title{font-size:1.25rem;font-weight:700;letter-spacing:4px;
  background:linear-gradient(90deg,#ffa500,#ffd700,#fff4a0,#ffd700,#ffa500);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hdr-right{font-family:var(--mono);font-size:.78rem;color:var(--dim);display:flex;gap:14px;align-items:center}
.hdr-right .v{color:var(--gl);font-weight:bold}
.hdr-right .ct{color:var(--tai)} .hdr-right .cx{color:var(--xiu)}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px}
.mc{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px;position:relative;overflow:hidden}
.mc::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--ac,var(--gold))}
.mc-lbl{font-size:.60rem;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}
.mc-val{font-size:1.5rem;font-weight:700;font-family:var(--mono);color:var(--ac,var(--gl));line-height:1}
.mc-sub{font-size:.62rem;color:var(--dim);margin-top:3px}
.card{background:var(--bg2);border:1px solid var(--bdr);border-radius:10px;padding:12px;margin-bottom:10px}
.card-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim);margin-bottom:10px}
.bead-road{display:flex;flex-wrap:wrap;gap:5px;padding:4px 0}
.bead{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:.68rem;font-weight:700;position:relative}
.bt{background:radial-gradient(circle at 35% 30%,#ffe060,#c8900a,#7a4f00);color:#fff5cc;box-shadow:0 0 6px rgba(200,150,10,.5)}
.bx{background:radial-gradient(circle at 35% 30%,#c490ff,#7820ef,#3a0090);color:#e8d8ff;box-shadow:0 0 6px rgba(130,60,255,.5)}
.bead-new::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid #fff;opacity:.6;animation:blink 1s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:.2}50%{opacity:.8}}
.vote-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.05);margin:6px 0}
.vt{background:linear-gradient(90deg,#c8800a,#f5c842)}
.vx{background:linear-gradient(90deg,#6010c0,#a070ff)}
.vote-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:.72rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.pred-row{display:grid;grid-template-columns:180px 1fr;gap:10px;margin-bottom:10px}
.pred-main{background:${predBg};border:2px solid ${predColor};border-radius:12px;padding:16px;text-align:center;box-shadow:0 0 20px ${predColor}30}
.pred-lbl{font-size:.62rem;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.pred-val{font-size:3rem;font-weight:700;color:${predColor};text-shadow:0 0 20px ${predColor};line-height:1.1;margin:4px 0}
.conf-track{height:5px;background:rgba(255,255,255,.1);border-radius:3px;margin:6px 0;overflow:hidden}
.conf-fill{height:100%;border-radius:3px;background:${predColor};width:${confPct}%}
.bt-badge{display:inline-block;font-family:var(--mono);font-size:.65rem;padding:2px 8px;border-radius:4px;
  background:rgba(100,220,100,.12);border:1px solid rgba(100,220,100,.25);color:#80dd80;margin-top:6px}
.sig-table{width:100%;border-collapse:collapse;font-size:.68rem}
.sig-table th{color:var(--dim);padding:3px 5px;border-bottom:1px solid var(--bdr);text-align:left;font-weight:400;font-size:.60rem;text-transform:uppercase}
.sig-table td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:top}
.td-src{color:#8a6a30;font-family:var(--mono);font-size:.64rem;white-space:nowrap}
.sig-t{color:var(--tai);font-weight:700;white-space:nowrap}
.sig-x{color:var(--xiu);font-weight:700;white-space:nowrap}
.td-wr{font-family:var(--mono);font-size:.72rem;color:#88cc88;text-align:right;white-space:nowrap}
.td-n{font-family:var(--mono);font-size:.64rem;color:#666;text-align:right}
.td-detail{color:#7a6040;font-size:.63rem;line-height:1.3}
.algo-note{background:rgba(100,200,100,.05);border:1px solid rgba(100,200,100,.15);border-radius:8px;
  padding:8px 12px;margin-bottom:10px;font-size:.70rem;color:#80bb80;line-height:1.6}
.shape-info{display:flex;align-items:center;gap:10px;background:rgba(100,200,150,.08);
  border:1px solid rgba(100,200,150,.2);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:.72rem;color:#90cca8}
.pdb{background:var(--bg2);border:1px solid rgba(100,200,150,.25);border-radius:10px;padding:12px;margin-bottom:10px}
.pdb-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1.5px;color:#60bb90;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.db-stat-row{display:flex;gap:10px;font-family:var(--mono);font-size:.72rem}
.db-stat{background:rgba(100,200,150,.08);border:1px solid rgba(100,200,150,.18);border-radius:5px;padding:3px 10px}
.db-stat .v{color:#66ddaa;font-weight:bold}
/* Dice stats */
.dice-stats-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px}
.dstat{background:var(--bg2);border:1px solid rgba(255,255,255,.08);border-top:2px solid var(--dc,#888);border-radius:8px;padding:8px 10px}
.dstat-lbl{font-size:.58rem;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:2px}
.dstat-avg{font-size:1.4rem;font-weight:700;font-family:var(--mono);line-height:1}
.dstat-sub{font-size:.60rem;color:var(--dim);margin-bottom:6px}
.dstat-hist{display:flex;align-items:flex-end;gap:3px;height:30px}
.dv{display:flex;align-items:center;justify-content:center;min-width:18px;border-radius:2px 2px 0 0;font-size:.55rem;color:#000;font-family:var(--mono);font-weight:700;opacity:.85}
/* Dice signal row */
.dice-sig-row{display:flex;gap:8px;flex-wrap:wrap;padding:4px 0}
.dice-sig-item{display:flex;gap:6px;align-items:center;font-family:var(--mono);font-size:.72rem;
  padding:2px 8px;border-radius:4px;border:1px solid;background:rgba(100,200,150,.06)}
.dice-sig-nil{font-family:var(--mono);font-size:.70rem;color:#555;padding:2px 8px}
/* Section separator */
.section-hdr{font-size:.60rem;text-transform:uppercase;letter-spacing:2px;color:#6a5020;
  margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(160,110,30,.18)}
@media(max-width:620px){.metrics,.dice-stats-row{grid-template-columns:repeat(2,1fr)}.pred-row,.two-col,.three-col{grid-template-columns:1fr}}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v11 — SUNWIN ⬦</div>
  <div class="hdr-right">
    <span>Phiên <span class="v">#${h.phien}</span></span>
    <span class="${h.type==="T"?"ct":"cx"} v">${h.type==="T"?"Tài":"Xỉu"}</span>
    <span style="color:var(--d1)">${h.dice[0]}</span>·<span style="color:var(--d2)">${h.dice[1]}</span>·<span style="color:var(--d3)">${h.dice[2]}</span>
    <span>Σ <span class="v">${h.tong}</span></span>
    <span style="color:#555">${new Date().toLocaleTimeString("vi-VN")}</span>
  </div>
</div>

<div class="algo-note">
  ⚡ <strong>v11 — Phân Tích 3 Xúc Xắc:</strong>
  Markov(1/2/3) · Cầu Bệt · Xen Kẽ · N-gram(4/5) · Cân Bằng · Chart Tổng ·
  <strong style="color:#66ddaa">Chart Xúc Xắc</strong> ·
  <strong style="color:#66ddaa">Dice Markov</strong> ·
  <strong style="color:#66ddaa">Dice Corr</strong> ·
  <strong style="color:#66ddaa">Dice Trend</strong> |
  <strong>${pred.signalCount}</strong> signal ·
  Kho tổng: <strong style="color:#88ddaa">${pred.chartDBSize}</strong> ·
  Kho D1/D2/D3: <strong style="color:#88ddaa">${pred.diceDBSizes.join("/")}</strong> ·
  BT: <strong style="color:#aaffaa">${btWR}%</strong>
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
  <div class="mc" style="--ac:#88cc88">
    <div class="mc-lbl">Backtest WR</div>
    <div class="mc-val">${btWR}%</div>
    <div class="mc-sub">${btTotal} phiên test</div>
  </div>
  <div class="mc" style="--ac:#ff9944">
    <div class="mc-lbl">Cầu Hiện Tại</div>
    <div class="mc-val">${pred.streak}</div>
    <div class="mc-sub">${pred.curType==="T"?"Tài":"Xỉu"} liên tiếp</div>
  </div>
  <div class="mc" style="--ac:#66ddaa">
    <div class="mc-lbl">Kho Dice</div>
    <div class="mc-val">${pred.diceDBSizes.reduce((a,b)=>a+b,0)}</div>
    <div class="mc-sub">mẫu 3 xúc xắc</div>
  </div>
</div>

<div class="section-hdr">⬤ Phân Tích Từng Xúc Xắc</div>

<div class="dice-stats-row">
  ${diceStatHTML}
</div>

${pred.diceSig
  ? `<div class="card" style="margin-bottom:10px">
      <div class="card-title" style="color:#66ddaa">📊 Tín Hiệu Chart Xúc Xắc — ${pred.diceSig.signal==="T"?"▲ Tài":"▼ Xỉu"} WR=${(pred.diceSig.winRate*100).toFixed(0)}%</div>
      <div class="dice-sig-row">${diceSigRows}</div>
     </div>`
  : `<div class="card" style="margin-bottom:10px;opacity:.5">
      <div class="card-title" style="color:#66ddaa">📊 Chart Xúc Xắc — Đang xây dựng kho mẫu...</div>
     </div>`}

<div class="section-hdr">⬤ Đồ Thị 3 Xúc Xắc (25 Phiên)</div>

<div class="three-col">
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:var(--d1)">🎲 Xúc Xắc 1</div>
    <canvas id="d1Chart" height="160"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:var(--d2)">🎲 Xúc Xắc 2</div>
    <canvas id="d2Chart" height="160"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:var(--d3)">🎲 Xúc Xắc 3</div>
    <canvas id="d3Chart" height="160"></canvas>
  </div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Phân Bổ Tần Suất Xúc Xắc (50 Phiên)</div>

<div class="three-col">
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:var(--d1)">Tần Suất D1</div>
    <canvas id="freq1Chart" height="130"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:var(--d2)">Tần Suất D2</div>
    <canvas id="freq2Chart" height="130"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title" style="color:var(--d3)">Tần Suất D3</div>
    <canvas id="freq3Chart" height="130"></canvas>
  </div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Đồ Thị Tổng & Hình Dạng</div>

<div class="two-col">
  <div class="card" style="margin-bottom:0">
    <div class="card-title">📈 Biểu Đồ Tổng + Bollinger Band</div>
    <canvas id="sumChart" height="220"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title">📊 Hình Dạng Z-score (Tổng)</div>
    <canvas id="shapeChart" height="220"></canvas>
  </div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Cầu & Tổng Hợp Signal</div>

<div class="card">
  <div class="card-title">⬤ Cầu Hạt — 25 Phiên</div>
  <div class="bead-road" id="beadRoad"></div>
</div>

<div class="card">
  <div class="card-title">⚖ Phân Bổ Win-Rate Signals</div>
  <div class="vote-bar">
    <div class="vt" style="width:${pctT}%"></div>
    <div class="vx" style="width:${pctX}%"></div>
  </div>
  <div class="vote-labels">
    <span style="color:var(--tai)">▲ Tài ${pctT}% (${pred.votesT})</span>
    <span style="color:var(--xiu)">▼ Xỉu ${pctX}% (${pred.votesX})</span>
  </div>
</div>

<div class="pred-row">
  <div class="pred-main">
    <div class="pred-lbl">Phiên Tiếp Theo</div>
    <div style="font-size:.7rem;color:var(--dim)">#${Number(h.phien)+1}</div>
    <div class="pred-val">${pred.nextDisplay}</div>
    <div class="conf-track"><div class="conf-fill"></div></div>
    <div style="font-family:var(--mono);font-size:1rem;color:#fff">${confPct}%</div>
    <div class="bt-badge">Backtest: ${btWR}% / ${btTotal} phiên</div>
  </div>
  <div class="card" style="margin-bottom:0;overflow:hidden">
    <div class="card-title">${pred.signalCount} tín hiệu đã qua backtest (WR &gt; 52%) — <span style="color:#66ddaa">xanh = dice</span></div>
    <div style="max-height:300px;overflow-y:auto">
      <table class="sig-table">
        <thead><tr><th>Thuật Toán</th><th>Signal</th><th>WR%</th><th>N</th><th>Chi Tiết</th></tr></thead>
        <tbody>${sigRows}</tbody>
      </table>
    </div>
  </div>
</div>

<div class="pdb">
  <div class="pdb-title">
    <span>🗂 Kho Khuôn Mẫu Tổng</span>
    <div class="db-stat-row">
      <div class="db-stat">Tổng: <span class="v">${chartDB.length}</span></div>
      <div class="db-stat">D1/D2/D3: <span class="v">${pred.diceDBSizes.join("/")}</span></div>
    </div>
  </div>
  <div style="overflow-x:auto">
    <table class="sig-table">
      <thead><tr><th>#</th><th>Tên Mẫu</th><th>Dự Đoán</th><th>WR%</th><th>Lần Gặp</th></tr></thead>
      <tbody>${dbRows}</tbody>
    </table>
  </div>
</div>

<script>
Chart.register(window['chartjs-plugin-annotation']);
const LABELS   = ${labels};
const SUM_DATA = ${sumData};
const D1_DATA  = ${d1Data};
const D2_DATA  = ${d2Data};
const D3_DATA  = ${d3Data};
const TYPE_DATA = ${typeData};
const FREQS    = ${freqJSON};
const N = SUM_DATA.length;
const BOLL_UP  = ${bolUp};
const BOLL_MID = ${bolMid};
const BOLL_LOW = ${bolLow};

// Bead road
const beadEl = document.getElementById('beadRoad');
[...TYPE_DATA].forEach((t,i) => {
  const b = document.createElement('div');
  b.className = 'bead '+(t==='T'?'bt':'bx')+(i===TYPE_DATA.length-1?' bead-new':'');
  b.textContent = t;
  beadEl.appendChild(b);
});

// Helper: make mini dice chart
function makeDiceChart(id, data, color, label) {
  const ctx = document.getElementById(id).getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: { labels: LABELS, datasets: [{
      label: label, data: data,
      borderColor: color, borderWidth: 2,
      pointRadius: 5, pointHoverRadius: 7,
      pointBackgroundColor: data.map(v => {
        const alpha = 0.3 + (v/6)*0.7;
        return color.replace(')',','+alpha+')').replace('rgb','rgba');
      }),
      pointBorderColor: color, pointBorderWidth: 1.5,
      tension: 0.3, fill: {target:'origin', above: color.replace(')',',0.06)').replace('rgb','rgba')}
    }]},
    options: {
      responsive: true, animation: {duration: 400},
      layout: {padding: {top:8, bottom:4}},
      scales: {
        y: { min: 0.5, max: 6.5, ticks: {stepSize:1, color:'#7a6030', font:{size:10,family:'Share Tech Mono'}},
             grid: {color:'rgba(160,110,30,.10)'}},
        x: { ticks: {color:'#7a6030', maxTicksLimit:10, font:{size:8,family:'Share Tech Mono'}},
             grid: {color:'rgba(160,110,30,.06)'}}
      },
      plugins: {
        legend: {display:false},
        annotation: {annotations:{
          mid: {type:'line',scaleID:'y',value:3.5,borderColor:'rgba(255,255,255,.10)',borderWidth:1,borderDash:[4,4]}
        }},
        tooltip: {backgroundColor:'rgba(10,8,4,.95)',titleColor:'#ffd700',bodyColor:'#f0d0a0',
          callbacks: {label: ctx => label + ': ' + ctx.parsed.y}}
      }
    }
  });
}

makeDiceChart('d1Chart', D1_DATA, 'rgb(245,166,66)', 'D1');
makeDiceChart('d2Chart', D2_DATA, 'rgb(66,200,245)', 'D2');
makeDiceChart('d3Chart', D3_DATA, 'rgb(160,245,66)', 'D3');

// Frequency bar charts
function makeFreqChart(id, freqData, color) {
  const ctx = document.getElementById(id).getContext('2d');
  const total = freqData.reduce((a,b)=>a+b,0)||1;
  const pcts  = freqData.map(v => parseFloat((v/total*100).toFixed(1)));
  const expected = 100/6;
  new Chart(ctx, {
    type: 'bar',
    data: { labels: ['1','2','3','4','5','6'], datasets: [{
      label: 'Tần suất %', data: pcts,
      backgroundColor: pcts.map(p => p > expected+3 ? color : p < expected-3 ?
        'rgba(255,100,100,.6)' : 'rgba(180,180,180,.3)'),
      borderColor: color, borderWidth: 1.2, borderRadius: 3
    }]},
    options: {
      responsive: true, animation: {duration:300},
      layout: {padding: {top:6}},
      scales: {
        y: { beginAtZero:true, ticks:{color:'#7a6030',font:{size:9,family:'Share Tech Mono'},callback:v=>v+'%'},
             grid:{color:'rgba(160,110,30,.08)'}},
        x: { ticks:{color:color,font:{size:10,family:'Share Tech Mono'}},
             grid:{display:false}}
      },
      plugins: {
        legend:{display:false},
        annotation:{annotations:{
          exp:{type:'line',scaleID:'y',value:expected,borderColor:'rgba(255,255,255,.20)',borderWidth:1,borderDash:[4,4]}
        }},
        tooltip:{backgroundColor:'rgba(10,8,4,.95)',callbacks:{label:c=>c.parsed.y+'% ('+freqData[c.dataIndex]+' lần)'}}
      }
    }
  });
}

makeFreqChart('freq1Chart', FREQS[0], '#f5a642');
makeFreqChart('freq2Chart', FREQS[1], '#42c8f5');
makeFreqChart('freq3Chart', FREQS[2], '#a0f542');

// Numbered-circle plugin for sum chart
const numberedPts = {
  id:'numberedPts',
  afterDatasetsDraw(chart){
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(3);
    if(!meta) return;
    meta.data.forEach((pt,i)=>{
      const val = SUM_DATA[i];
      if(val==null) return;
      const isTai = val>=11, R=14;
      ctx.save();
      ctx.beginPath(); ctx.arc(pt.x+1.5,pt.y+2,R,0,Math.PI*2);
      ctx.fillStyle='rgba(0,0,0,.4)'; ctx.fill(); ctx.restore();
      const g=ctx.createRadialGradient(pt.x-R*.3,pt.y-R*.35,R*.05,pt.x,pt.y,R);
      if(isTai){g.addColorStop(0,'#ffe060');g.addColorStop(.45,'#c8900a');g.addColorStop(1,'#7a4f00');}
      else{g.addColorStop(0,'#c490ff');g.addColorStop(.45,'#7820ef');g.addColorStop(1,'#2a0060');}
      ctx.save();
      ctx.beginPath(); ctx.arc(pt.x,pt.y,R,0,Math.PI*2);
      ctx.fillStyle=g; ctx.fill();
      ctx.strokeStyle=isTai?'#f5c842':'#a070ff'; ctx.lineWidth=1.8; ctx.stroke(); ctx.restore();
      ctx.save();
      ctx.fillStyle='#fff'; ctx.font='bold 10px Share Tech Mono,monospace';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.shadowColor='rgba(0,0,0,.8)'; ctx.shadowBlur=3;
      ctx.fillText(val,pt.x,pt.y); ctx.restore();
    });
  }
};

new Chart(document.getElementById('sumChart').getContext('2d'),{
  type:'line', plugins:[numberedPts],
  data:{labels:LABELS,datasets:[
    {label:'BB Upper',data:Array(N).fill(BOLL_UP),borderColor:'rgba(100,180,255,.22)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false,tension:0,order:10},
    {label:'BB Lower',data:Array(N).fill(BOLL_LOW),borderColor:'rgba(100,180,255,.22)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:{target:'-1',above:'rgba(100,180,255,.05)'},tension:0,order:10},
    {label:'BB Mid',data:Array(N).fill(BOLL_MID),borderColor:'rgba(100,180,255,.13)',borderWidth:1,borderDash:[6,5],pointRadius:0,fill:false,tension:0,order:10},
    {label:'Tổng',data:SUM_DATA,borderColor:'rgba(210,175,80,.75)',borderWidth:2.5,
      pointRadius:16,pointHoverRadius:18,
      pointBackgroundColor:SUM_DATA.map(v=>v>=11?'#b07800':'#5010a0'),
      pointBorderColor:SUM_DATA.map(v=>v>=11?'#f5c842':'#a070ff'),
      pointBorderWidth:2,tension:0,fill:false,order:0}
  ]},
  options:{responsive:true,animation:{duration:500},layout:{padding:{top:18,bottom:6,left:4,right:4}},
    scales:{
      y:{min:3,max:18,ticks:{color:'#9a7040',stepSize:3,font:{size:11,family:'Share Tech Mono'}},grid:{color:'rgba(160,110,30,.14)'}},
      x:{ticks:{color:'#8a6030',maxTicksLimit:15,font:{size:9,family:'Share Tech Mono'}},grid:{color:'rgba(160,110,30,.08)'}}
    },
    plugins:{legend:{display:false},
      annotation:{annotations:{
        mid:{type:'line',scaleID:'y',value:10.5,borderColor:'rgba(255,255,255,.10)',borderWidth:1,borderDash:[6,5]},
        taiZ:{type:'box',scaleID:'y',yMin:11,yMax:18,backgroundColor:'rgba(245,200,66,.03)',borderWidth:0},
        xiuZ:{type:'box',scaleID:'y',yMin:3,yMax:10.5,backgroundColor:'rgba(160,112,255,.03)',borderWidth:0},
      }},
      tooltip:{backgroundColor:'rgba(10,8,4,.95)',titleColor:'#ffd700',bodyColor:'#f0d0a0',
        callbacks:{label:ctx=>{const v=ctx.parsed.y;if(ctx.dataset.label!=='Tổng')return ctx.dataset.label+': '+v.toFixed(1);return'Tổng: '+v+' → '+(v>=11?'🟡 Tài':'🟣 Xỉu');}}}
    }
  }
});

// Shape chart
(function(){
  const raw=SUM_DATA.slice(-10);
  if(raw.length<2)return;
  const m=raw.reduce((s,v)=>s+v,0)/raw.length;
  const sd=Math.sqrt(raw.reduce((s,v)=>s+(v-m)**2,0)/raw.length)||1;
  const norm=raw.map(v=>(v-m)/sd);
  const shapeLabels=raw.map((_,i)=>String(i+1));
  new Chart(document.getElementById('shapeChart').getContext('2d'),{
    type:'line',
    data:{labels:shapeLabels,datasets:[{
      label:'Z-score',data:norm,
      borderColor:'rgba(100,220,150,.85)',borderWidth:2.5,
      pointRadius:norm.map((_,i)=>i===norm.length-1?8:5),
      pointBackgroundColor:norm.map((v,i)=>i===norm.length-1?'#44ff88':v>=0?'rgba(245,200,66,.8)':'rgba(160,112,255,.8)'),
      pointBorderColor:'#333',pointBorderWidth:1,tension:.35,
      fill:{target:'origin',above:'rgba(245,200,66,.07)',below:'rgba(160,112,255,.07)'}
    }]},
    options:{responsive:true,animation:{duration:600},layout:{padding:{top:12,bottom:6}},
      scales:{
        y:{ticks:{color:'#6a8a70',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(100,200,120,.10)'},title:{display:true,text:'Z-score',color:'#507050',font:{size:10}}},
        x:{ticks:{color:'#507050',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(100,200,120,.06)'},title:{display:true,text:'Phiên (cũ→mới)',color:'#507050',font:{size:10}}}
      },
      plugins:{legend:{display:false},
        annotation:{annotations:{zero:{type:'line',scaleID:'y',value:0,borderColor:'rgba(255,255,255,.15)',borderWidth:1,borderDash:[4,4]}}},
        tooltip:{backgroundColor:'rgba(10,20,12,.95)',callbacks:{label:ctx=>{const v=ctx.parsed.y;return'Z: '+(v>=0?'+':'')+v.toFixed(2)+' ('+(v>=0?'Tài':'Xỉu')+')';}}}
      }
    }
  });
})();

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
    res.writeHead(204, {"Access-Control-Allow-Origin":"*"});
    res.end(); return;
  }

  await syncHistory();

  const noData = (code=503, msg="Chưa có dữ liệu") => {
    res.writeHead(code, {"Content-Type":"application/json;charset=utf-8","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({loi: msg}));
  };

  if (url.pathname === "/bando") {
    if (!history.length) { noData(); return; }
    const h = history[0];
    const pred = predict(history);
    res.writeHead(200, {"Content-Type":"text/html;charset=utf-8"});
    res.end(buildHTML(pred, h)); return;
  }

  res.setHeader("Content-Type","application/json;charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");

  if (url.pathname === "/" || url.pathname === "/predict") {
    if (!history.length) { noData(); return; }
    const h = history[0], p = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: h.phien, xuc_xac: h.dice, tong_hien_tai: h.tong,
      ket_qua_hien: h.type==="T"?"Tài":"Xỉu",
      phien_du_doan: String(Number(h.phien)+1),
      du_doan: p.nextDisplay, do_tin_cay: p.confDisplay,
      backtest_winrate: p.backtest?.wr ?? null,
      signal_count: p.signalCount, current_shape: p.currentShape,
      chart_db_size: p.chartDBSize, dice_db_sizes: p.diceDBSizes,
      ver: "v11"
    })); return;
  }

  if (url.pathname === "/predict/detail") {
    if (!history.length) { noData(); return; }
    const p = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan: p.nextDisplay, do_tin_cay: p.confDisplay,
      backtest: p.backtest, signals: p.signals, streak: p.streak,
      chart_signal: p.chartSignal, dice_signal: p.diceSig,
      dice_stats: p.diceStats, chart_db_size: p.chartDBSize,
      dice_db_sizes: p.diceDBSizes, ver: "v11"
    })); return;
  }

  if (url.pathname === "/sunlon") {
    if (!history.length) { noData(); return; }
    const h = history[0], p = predict(history);
    const pattern = history.slice(0, 30).map(x => x.type).reverse().join("");
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: Number(h.phien), ket_qua: h.type === "T" ? "Tai" : "Xiu",
      xuc_xac: h.dice, phien_du_doan: Number(h.phien) + 1,
      du_doan: p.next === "T" ? "Tai" : "Xiu", do_tin_cay: p.confDisplay,
      pattern, id: "@sewdangcap"
    })); return;
  }

  if (url.pathname === "/history") {
    const lim = Math.min(parseInt(url.searchParams.get("limit")||"20"), 200);
    res.writeHead(200);
    res.end(JSON.stringify({
      tong_so: history.length,
      du_lieu: history.slice(0,lim).map(h=>({
        phien: h.phien, xuc_xac: h.dice, tong: h.tong,
        ket_qua: h.type==="T"?"Tài":"Xỉu"
      }))
    })); return;
  }

  if (url.pathname === "/dice/analysis") {
    if (!history.length) { noData(); return; }
    const freqs = diceFreqAnalysis(history, 50);
    const p = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      freq_50_phien: [0,1,2].map(di => ({
        xuc_xac: di+1,
        gia_tri: [1,2,3,4,5,6].map((v,i) => ({gia_tri: v, so_lan: freqs[di][i]}))
      })),
      dice_db_sizes: p.diceDBSizes,
      dice_stats: p.diceStats,
      dice_signal: p.diceSig,
      ver: "v11"
    }, null, 2)); return;
  }

  if (url.pathname === "/patterns") {
    const top = [...chartDB].filter(e => e.totalSeen >= 2)
      .sort((a,b) => b.totalSeen - a.totalSeen).slice(0, 20)
      .map((e,i) => {
        const total = e.totalSeen;
        const pT = e.winsT / total;
        return { rank: i+1, label: e.label, totalSeen: total,
                 winRateT: pT, winRateX: 1-pT,
                 predictedNext: pT >= 0.5 ? "T" : "X" };
      });
    res.writeHead(200);
    res.end(JSON.stringify({ total: chartDB.length, top }, null, 2)); return;
  }

  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e=>({loi:e.message}));
    res.writeHead(200); res.end(JSON.stringify(r, null, 2)); return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    loi: "Không tìm thấy",
    endpoints: ["/predict","/predict/detail","/history","/bando","/sunlon","/patterns","/dice/analysis","/debug"],
    ver: "v11"
  }));

}).listen(PORT, () => {
  console.log(`✅  SicBo v11.0 — Phân Tích 3 Xúc Xắc — port ${PORT}`);
  console.log(`    Dashboard   : http://localhost:${PORT}/bando`);
  console.log(`    API         : http://localhost:${PORT}/predict`);
  console.log(`    Dice Anal.  : http://localhost:${PORT}/dice/analysis`);
  console.log(`    Patterns    : http://localhost:${PORT}/patterns`);
  console.log(`    Algorithms:`);
  console.log(`      [Cũ]  Markov(1/2/3), Cầu Bệt, Xen Kẽ, N-gram(4/5), Cân Bằng, Chart Tổng`);
  console.log(`      [Mới] Chart Xúc Xắc — z-norm Pearson trên từng D1/D2/D3`);
  console.log(`      [Mới] Dice Markov   — Thấp/Trung/Cao Markov từng xúc xắc`);
  console.log(`      [Mới] Dice Corr     — Tổ hợp 3 xúc xắc (8 nhóm)`);
  console.log(`      [Mới] Dice Trend    — Slope↑↓→ từng xúc xắc trong 5 phiên`);
  syncHistory();
  setInterval(syncHistory, 12000);
});
