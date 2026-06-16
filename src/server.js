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
//  SIGNAL THRESHOLDS — THẮT CHẶT
// ═══════════════════════════════════════════════
const MIN_WIN_RATE  = 0.54;  // Tăng từ 0.52 → 0.54 để loại signal yếu
const MIN_SAMPLES   = 12;    // Tăng từ 8 → 12 để đảm bảo độ tin cậy
const CONSENSUS_MIN = 2;     // Tối thiểu 2 signal đồng thuận mới ra kết quả

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 1: MARKOV ĐA BẬC (cải tiến)
//  Thêm "decay check": nếu 10 phiên gần nhất WR < 45% thì bỏ
// ═══════════════════════════════════════════════
function markov(seq, order) {
  if (seq.length < order + 1 + MIN_SAMPLES) return null;

  // Xây bảng chuyển trạng thái
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

  // Tính WR lịch sử (không tính 20 phiên gần nhất = anti-overfit)
  let wins = 0, total = 0;
  const testEnd = seq.length - order - 1;
  for (let p = 1; p <= testEnd; p++) {
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

  // DECAY CHECK: Kiểm tra 15 phiên gần nhất — nếu đang gãy thì giảm weight
  let recentWins = 0, recentTotal = 0;
  for (let p = 1; p <= Math.min(15, seq.length - order - 1); p++) {
    const st = seq.slice(p, p + order).join("");
    if (st !== curState) continue;
    const tb = table[st];
    const pred = (tb.T >= tb.X) ? "T" : "X";
    if (pred === seq[p - 1]) recentWins++;
    recentTotal++;
  }
  // Nếu gần đây đang sai nhiều (< 40%) → skip hoàn toàn
  if (recentTotal >= 4 && (recentWins / recentTotal) < 0.40) return null;

  return {
    signal, winRate: wr, sampleCount: total,
    source: `Markov-${order}`,
    detail: `State [${curState}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu${recentTotal>0?", gần="+recentWins+"/"+recentTotal:""})`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 2: MARKOV CHỐNG GÃY (Anti-Streak Markov)
//  Phát hiện khi Markov đang trong chu kỳ "gãy liên tục"
//  → Tự động đảo signal khi phát hiện pattern gãy
// ═══════════════════════════════════════════════
function markovAntiBreak(seq) {
  if (seq.length < 30) return null;

  // Mô phỏng Markov-1 và Markov-2 trên lịch sử gần
  const W = 20; // cửa sổ kiểm tra
  const recentSeq = seq.slice(0, W);

  // Đếm số lần Markov-1 đúng/sai trong W phiên gần
  let m1Wins = 0, m1Total = 0;
  for (let p = 1; p < W - 1; p++) {
    const state = recentSeq[p];
    const table = {};
    for (let j = p + 1; j < recentSeq.length; j++) {
      const s = recentSeq[j], o = recentSeq[j-1];
      if (!table[s]) table[s] = {T:0,X:0};
      table[s][o]++;
    }
    const c = table[state];
    if (!c || (c.T+c.X) === 0) continue;
    const pred = c.T >= c.X ? "T" : "X";
    if (pred === recentSeq[p-1]) m1Wins++;
    m1Total++;
  }

  if (m1Total < 8) return null;
  const recentWR = m1Wins / m1Total;

  // Nếu Markov-1 đang "gãy" liên tục (WR < 35% trong 20 phiên gần)
  // → thì ta NÊN đảo kết quả của Markov-1
  if (recentWR < 0.35) {
    // Tính Markov-1 bình thường rồi đảo
    const state = seq[0];
    const tbl = {};
    for (let p = 1; p < seq.length; p++) {
      const s = seq[p], o = seq[p-1];
      if (!tbl[s]) tbl[s] = {T:0,X:0};
      tbl[s][o]++;
    }
    const c = tbl[state];
    if (!c || (c.T+c.X) < MIN_SAMPLES) return null;
    const rawSignal = c.T >= c.X ? "T" : "X";
    const signal = rawSignal === "T" ? "X" : "T"; // ĐẢO
    const invertedWR = 1 - recentWR; // WR khi đảo
    if (invertedWR < MIN_WIN_RATE) return null;
    return {
      signal, winRate: invertedWR, sampleCount: m1Total,
      source: "Anti-Break",
      detail: `Markov đang gãy (${(recentWR*100).toFixed(0)}%/20p) → đảo sang ${signal==="T"?"Tài":"Xỉu"} WR=${(invertedWR*100).toFixed(0)}%`
    };
  }

  return null;
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 3: CẦU BỆT (cải tiến với decay)
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
  let recentBreak = 0, recentCont = 0, recentTotal = 0;

  for (let p = 1; p <= seq.length - curStreak - 1; p++) {
    const t = seq[p];
    let len = 0;
    for (let j = p; j < seq.length && seq[j] === t; j++) len++;
    if (len !== curStreak) continue;
    if (p + curStreak < seq.length && seq[p + curStreak] === t) continue;
    const outcome = seq[p - 1];
    if (outcome === t) contCount++;
    else               breakCount++;
    // Theo dõi 20 phiên gần nhất
    if (p <= 20) {
      recentTotal++;
      if (outcome !== t) recentBreak++; else recentCont++;
    }
  }
  const total = breakCount + contCount;
  if (total < MIN_SAMPLES) return null;

  const breakRate = breakCount / total;
  const contRate  = contCount  / total;

  // Kiểm tra decay: nếu 20 phiên gần đây đang gãy thì skip
  if (recentTotal >= 4) {
    const recentBreakRate = recentBreak / recentTotal;
    const recentContRate  = recentCont  / recentTotal;
    if (breakRate > MIN_WIN_RATE && recentBreakRate < 0.35) return null;
    if (contRate  > MIN_WIN_RATE && recentContRate  < 0.35) return null;
  }

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
//  THUẬT TOÁN 4: CẦU XEN KẼ (cải tiến)
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
//  THUẬT TOÁN 5: PATTERN BLOCK (thay N-gram thô)
//  So sánh block 6 phiên hiện tại với toàn bộ lịch sử
//  Tìm block giống nhất (không cần exact match) → vote
// ═══════════════════════════════════════════════
function patternBlock(seq, blockSize = 6) {
  if (seq.length < blockSize + MIN_SAMPLES + 1) return null;

  const curBlock = seq.slice(0, blockSize).join("");
  const countMap = {};

  for (let p = 1; p + blockSize <= seq.length; p++) {
    const block = seq.slice(p, p + blockSize).join("");
    if (block !== curBlock) continue;
    const outcome = seq[p - 1];
    if (!countMap[outcome]) countMap[outcome] = 0;
    countMap[outcome]++;
  }

  const cT = countMap["T"] || 0;
  const cX = countMap["X"] || 0;
  const total = cT + cX;
  if (total < MIN_SAMPLES) return null;
  const wr = Math.max(cT, cX) / total;
  if (wr < MIN_WIN_RATE) return null;

  const signal = cT >= cX ? "T" : "X";
  return {
    signal, winRate: wr, sampleCount: total, source: "Block Pattern",
    detail: `Block [${curBlock}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 6: CÂN BẰNG (Mean Reversion) - cải tiến
// ═══════════════════════════════════════════════
function meanReversion(hist) {
  if (hist.length < 60) return null;
  const W = 30;
  const recent = hist.slice(0, W);
  const ratioT = recent.filter(h => h.type === "T").length / W;

  // Chỉ kích hoạt khi lệch mạnh
  if (ratioT >= 0.38 && ratioT <= 0.62) return null;

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
  return { signal: "T", winRate: wr, sampleCount: total, source: "Cân Bằng",
    detail: `Xỉu ${((1-ratioT)*100).toFixed(0)}%/30p → hồi quy Tài WR=${(wr*100).toFixed(0)}%` };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 7: CHART PATTERN (Tổng) - giữ nguyên nhưng nâng ngưỡng
// ═══════════════════════════════════════════════
const CHART_W  = 10;
const MIN_CORR = 0.82;  // Tăng từ 0.80 → 0.82
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
    if (entry.totalSeen < 5) continue; // Tăng ngưỡng từ 3 → 5
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
//  THUẬT TOÁN 8: DICE TREND (cải tiến, giữ lại)
//  Phân tích xu hướng từng xúc xắc rồi vote
// ═══════════════════════════════════════════════
function diceTrend(hist) {
  if (hist.length < 25) return null;
  const W = 6; // tăng từ 5 → 6

  function slope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += vals[i]; sxy += i*vals[i]; sx2 += i*i; }
    const d = n*sx2 - sx*sx;
    return d ? (n*sxy - sx*sy) / d : 0;
  }

  function trendCode(s) { return s > 0.4 ? "U" : s < -0.4 ? "D" : "F"; } // Tăng ngưỡng

  const table = {};
  for (let p = W; p < hist.length; p++) {
    const window = hist.slice(p, p + W).map(h => h.dice).reverse();
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
//  THUẬT TOÁN 9: DICE SUM MARKOV (MỚI)
//  Phân nhóm tổng xúc xắc theo vùng: 3-7 (Thấp), 8-13 (Trung), 14-18 (Cao)
//  Markov bậc 2 trên nhóm tổng → dự đoán T/X
// ═══════════════════════════════════════════════
function diceSumMarkov(hist) {
  if (hist.length < 30) return null;

  function groupSum(tong) {
    if (tong <= 7)  return "L";
    if (tong <= 13) return "M";
    return "H";
  }

  const ORDER = 2;
  const seq = hist.map(h => groupSum(h.tong));

  const table = {};
  for (let p = 1; p + ORDER <= seq.length; p++) {
    const key = seq.slice(p, p + ORDER).join("");
    const outcome = hist[p - 1].type;
    if (!table[key]) table[key] = { T: 0, X: 0 };
    table[key][outcome]++;
  }

  const curKey = seq.slice(0, ORDER).join("");
  const c = table[curKey];
  if (!c || (c.T + c.X) < MIN_SAMPLES) return null;
  const wr = Math.max(c.T, c.X) / (c.T + c.X);
  if (wr < MIN_WIN_RATE) return null;
  const signal = c.T >= c.X ? "T" : "X";

  const groupNames = { L: "Thấp", M: "Trung", H: "Cao" };
  const keyStr = curKey.split("").map(k => groupNames[k]).join("→");

  return {
    signal, winRate: wr, sampleCount: c.T + c.X,
    source: "Sum Markov",
    detail: `Vùng tổng [${keyStr}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${c.T+c.X} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 10: MOMENTUM (MỚI)
//  Đo "momentum" T/X trong 5, 10, 20 phiên gần
//  Khi cả 3 cùng chiều và tỷ lệ đủ mạnh → tín hiệu
// ═══════════════════════════════════════════════
function momentum(hist) {
  if (hist.length < 40) return null;

  const windows = [5, 10, 20];
  const ratios  = windows.map(w => {
    const slice = hist.slice(0, w);
    return slice.filter(h => h.type === "T").length / w;
  });

  // Kiểm tra cả 3 cùng chiều
  const allBullish = ratios.every(r => r > 0.60);
  const allBearish = ratios.every(r => r < 0.40);

  if (!allBullish && !allBearish) return null;

  // Tính WR lịch sử: khi cùng momentum → tiếp tục hay đảo?
  let wins = 0, total = 0;
  for (let p = 20; p + 20 < hist.length; p++) {
    const r5  = hist.slice(p, p+5) .filter(h => h.type==="T").length / 5;
    const r10 = hist.slice(p, p+10).filter(h => h.type==="T").length / 10;
    const r20 = hist.slice(p, p+20).filter(h => h.type==="T").length / 20;
    const isBull = r5 > 0.60 && r10 > 0.60 && r20 > 0.60;
    const isBear = r5 < 0.40 && r10 < 0.40 && r20 < 0.40;
    if (!isBull && !isBear) continue;
    const pred = isBull ? "T" : "X";
    const actual = hist[p - 1].type;
    if (pred === actual) wins++;
    total++;
  }

  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;

  const signal = allBullish ? "T" : "X";
  const strength = allBullish
    ? ratios.map(r => (r*100).toFixed(0)+"%").join("/")
    : ratios.map(r => ((1-r)*100).toFixed(0)+"%").join("/");

  return {
    signal, winRate: wr, sampleCount: total,
    source: "Momentum",
    detail: `Momentum ${allBullish?"Tài":"Xỉu"} [${strength}] WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 11: DOUBLE AFTER BREAK (MỚI)
//  Phát hiện pattern "gãy kép": sau khi cầu bệt gãy 1 lần
//  lần tiếp theo nó thường gãy tiếp hay tiếp tục?
// ═══════════════════════════════════════════════
function doubleAfterBreak(seq) {
  if (seq.length < 40) return null;

  // Tìm vị trí các "gãy cầu": chuyển từ AAAA... → B
  // Sau đó xem phiên kế tiếp là T hay X
  let wins = 0, total = 0;
  let lastBreakType = null; // Loại phiên sau khi gãy

  for (let i = 2; i < seq.length - 1; i++) {
    // Tìm cầu bệt
    if (seq[i] === seq[i+1] && seq[i] !== seq[i-1]) {
      // Đây là điểm gãy: seq[i-1] khác seq[i]
      // Phiên gãy là seq[i-1], phiên sau gãy là seq[i]
      if (lastBreakType !== null) {
        // Sau lần gãy trước, lần gãy này theo sau là loại gì?
        total++;
        if (seq[i-1] !== lastBreakType) wins++;
      }
      lastBreakType = seq[i-1];
    }
  }

  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;

  // Áp dụng: tìm gãy gần nhất
  let lastBreakInSeq = null;
  for (let i = 2; i < Math.min(20, seq.length - 1); i++) {
    if (seq[i] === seq[i+1] && seq[i] !== seq[i-1]) {
      lastBreakInSeq = seq[i-1];
      break;
    }
  }
  if (lastBreakInSeq === null) return null;

  const signal = lastBreakInSeq === "T" ? "X" : "T"; // Thường đảo kiểu sau gãy kép

  return {
    signal, winRate: wr, sampleCount: total,
    source: "Double Break",
    detail: `Sau gãy [${lastBreakInSeq==="T"?"Tài":"Xỉu"}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  ENSEMBLE (cải tiến — có consensus filter)
// ═══════════════════════════════════════════════
function ensemble(signals) {
  if (!signals.length) return { signal: null, confidence: 0.5, consensus: 0 };

  // Đếm consensus
  const cntT = signals.filter(s => s.signal === "T").length;
  const cntX = signals.filter(s => s.signal === "X").length;
  const total = signals.length;

  // Consensus: tỷ lệ đồng thuận
  const consensusRatio = Math.max(cntT, cntX) / total;

  // Nếu không đạt consensus tối thiểu → trả về null (không cược)
  if (Math.max(cntT, cntX) < CONSENSUS_MIN) {
    return { signal: null, confidence: 0.5, consensus: consensusRatio };
  }

  // Weighted voting với winRate và sampleCount
  let wT = 0, wX = 0;
  for (const s of signals) {
    // Weight = winRate * log(samples) * (extra bonus nếu WR > 60%)
    const bonus = s.winRate > 0.60 ? 1.3 : 1.0;
    const w = s.winRate * Math.log(1 + s.sampleCount) * bonus;
    if (s.signal === "T") wT += w;
    else                  wX += w;
  }
  const tot = wT + wX;
  if (tot < 0.001) return { signal: null, confidence: 0.5, consensus: consensusRatio };

  const signal = wT >= wX ? "T" : "X";
  const rawConf = Math.max(wT, wX) / tot;

  // Điều chỉnh confidence theo consensus
  const confBase = 0.50 + Math.min(rawConf - 0.50, 0.30);
  const confAdj  = confBase * (0.7 + 0.3 * consensusRatio); // penalize thấp consensus

  return { signal, confidence: Math.min(confAdj, 0.85), consensus: consensusRatio, cntT, cntX };
}

// ═══════════════════════════════════════════════
//  BACKTEST (cải tiến)
// ═══════════════════════════════════════════════
function backtestSystem(hist, trials = 40) {
  if (hist.length < trials + 25) return null;
  let wins = 0, total = 0, skipped = 0;
  for (let i = 1; i <= trials; i++) {
    const subHist = hist.slice(i);
    if (subHist.length < 25) continue;
    const subSeq  = subHist.map(h => h.type);
    const sigs    = collectSignals(subSeq, subHist);
    if (!sigs.length) { skipped++; continue; }
    const { signal } = ensemble(sigs);
    if (!signal) { skipped++; continue; } // không cược khi không đủ consensus
    const actual = hist[i-1].type;
    if (signal === actual) wins++;
    total++;
  }
  if (!total) return null;
  return { wins, total, skipped, wr: wins / total };
}

// ═══════════════════════════════════════════════
//  COLLECT ALL SIGNALS (bỏ các algo gây nhiễu)
// ═══════════════════════════════════════════════
function collectSignals(seq, hist) {
  const results = [];
  const add = (r) => { if (r) results.push(r); };

  // === CORE SEQUENCE ALGORITHMS ===
  add(markov(seq, 1));
  add(markov(seq, 2));
  add(markov(seq, 3));
  add(markovAntiBreak(seq));   // MỚI: Markov chống gãy
  add(streakCau(seq));
  add(alternating(seq));
  add(patternBlock(seq, 6));   // Thay N-gram thô

  // === STATISTICAL ALGORITHMS ===
  if (hist) add(meanReversion(hist));
  if (hist) add(momentum(hist));     // MỚI
  if (hist) add(doubleAfterBreak(seq)); // MỚI

  // === CHART / DICE ALGORITHMS (chọn lọc) ===
  if (hist) add(predictChart(hist));
  if (hist) add(diceTrend(hist));
  if (hist) add(diceSumMarkov(hist)); // MỚI: Thay thế diceGroupMarkov

  // BỎ: Chart Xúc Xắc (tốn RAM, ít mẫu), Dice Corr (quá thưa), DiceGroupMarkov (trùng lặp)

  return results;
}

// ═══════════════════════════════════════════════
//  MAIN PREDICT
// ═══════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 20) {
    return { next: null, nextDisplay: "Chưa đủ dữ liệu", confidence: 0.5, confDisplay: "50%",
      signals: [], backtest: null, typeSeq: [], sumChart: [], streak: 0, curType: "?",
      chartDBSize: chartDB.length, consensus: 0 };
  }
  const seq     = hist.map(h => h.type);
  const signals = collectSignals(seq, hist);
  const { signal, confidence, consensus, cntT, cntX } = ensemble(signals);
  const backtest = backtestSystem(hist, 40);
  const curType = seq[0];
  let streak = 0;
  for (const t of seq) { if (t === curType) streak++; else break; }
  const chartSig = signals.find(s => s.source === "Chart Tổng");
  const vT = signals.filter(s => s.signal === "T").reduce((s,r) => s + r.winRate, 0);
  const vX = signals.filter(s => s.signal === "X").reduce((s,r) => s + r.winRate, 0);

  // Dice stats
  const diceStats = [0,1,2].map(di => {
    const vals = hist.slice(0, 20).map(h => h.dice[di]);
    return { avg: mean(vals).toFixed(2), std: stdDev(vals).toFixed(2),
             recent: hist.slice(0,5).map(h => h.dice[di]) };
  });

  return {
    next: signal, nextDisplay: signal === "T" ? "Tài" : signal === "X" ? "Xỉu" : "Chờ",
    confidence, confDisplay: Math.round(confidence * 100) + "%",
    signals, signalCount: signals.length,
    consensus, cntT: cntT||0, cntX: cntX||0,
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
    diceStats,
  };
}

// ═══════════════════════════════════════════════
//  DICE FREQUENCY ANALYSIS
// ═══════════════════════════════════════════════
function diceFreqAnalysis(hist, n = 50) {
  const slice = hist.slice(0, Math.min(n, hist.length));
  return [0,1,2].map(di => {
    const freq = [0,0,0,0,0,0,0];
    for (const h of slice) freq[h.dice[di]]++;
    return freq.slice(1);
  });
}

// ═══════════════════════════════════════════════
//  HTML BUILDER (v12 — thiết kế lại)
// ═══════════════════════════════════════════════
function buildHTML(pred, h) {
  const n = Math.min(pred.sumChart.length, 25);
  const labels  = JSON.stringify(Array.from({length:n}, (_,i) => String(Number(h.phien) - (n-1-i))));
  const sumData = JSON.stringify([...pred.sumChart.slice(0,n)].reverse());
  const d1Data  = JSON.stringify([...pred.diceCharts.d1.slice(0,n)].reverse());
  const d2Data  = JSON.stringify([...pred.diceCharts.d2.slice(0,n)].reverse());
  const d3Data  = JSON.stringify([...pred.diceCharts.d3.slice(0,n)].reverse());
  const typeData= JSON.stringify([...pred.typeSeq.slice(0,n)].reverse());
  const freqs   = diceFreqAnalysis(history, 50);
  const freqJSON= JSON.stringify(freqs);

  const noSignal  = pred.next === null;
  const isTai     = pred.next === "T";
  const predColor = noSignal ? "#888888" : (isTai ? "#f5c842" : "#a070ff");
  const predBg    = noSignal ? "rgba(100,100,100,0.08)" : (isTai ? "rgba(245,200,66,0.10)" : "rgba(160,112,255,0.10)");
  const btWR      = pred.backtest ? (pred.backtest.wr * 100).toFixed(1) : "N/A";
  const btTotal   = pred.backtest ? pred.backtest.total : 0;
  const btSkip    = pred.backtest ? (pred.backtest.skipped||0) : 0;
  const confPct   = Math.round(pred.confidence * 100);
  const consensusPct = Math.round((pred.consensus||0) * 100);

  const sumArr    = pred.sumChart;
  const bolMid    = parseFloat(mean(sumArr).toFixed(2));
  const bolSd     = parseFloat(stdDev(sumArr).toFixed(2));
  const bolUp     = parseFloat((bolMid + 2*bolSd).toFixed(2));
  const bolLow    = parseFloat((bolMid - 2*bolSd).toFixed(2));
  const vT  = Number(pred.votesT), vX = Number(pred.votesX);
  const pctT = (vT+vX) > 0 ? Math.round(vT/(vT+vX)*100) : 50;
  const pctX = 100 - pctT;

  const sigRows = pred.signals.map(s => {
    const isT = s.signal === "T";
    const isDice = s.source.includes("Dice") || s.source.includes("Sum");
    const isNew  = ["Anti-Break","Momentum","Double Break","Block Pattern","Sum Markov"].includes(s.source);
    const srcColor = isNew ? "#66eecc" : isDice ? "#66ddaa" : "#c8a040";
    return `<tr>
      <td class="td-src" style="color:${srcColor}">${s.source}${isNew?' <span class="new-badge">NEW</span>':''}</td>
      <td class="${isT?"sig-t":"sig-x"}">${isT?"▲ Tài":"▼ Xỉu"}</td>
      <td class="td-wr">${(s.winRate*100).toFixed(0)}%</td>
      <td class="td-n">${s.sampleCount}</td>
      <td class="td-detail">${s.detail}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;padding:8px;font-size:.78rem">Chưa đủ mẫu — đang tích lũy dữ liệu</td></tr>`;

  const topDB = [...chartDB].filter(e => e.totalSeen >= 5)
    .sort((a,b) => b.totalSeen - a.totalSeen).slice(0, 6);
  const dbRows = topDB.map((e,i) => {
    const total = e.totalSeen;
    const pred2 = e.winsT >= e.winsX ? "T" : "X";
    const wr = Math.max(e.winsT, e.winsX) / total;
    return `<tr>
      <td class="td-src">#${i+1}</td>
      <td style="color:#7a8a70;font-size:.62rem;max-width:120px">${e.label}</td>
      <td class="${pred2==="T"?"sig-t":"sig-x"}">${pred2==="T"?"▲ T":"▼ X"}</td>
      <td class="td-wr">${(wr*100).toFixed(0)}%</td>
      <td class="td-n">${total}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;font-size:.75rem;padding:6px">Đang xây dựng kho mẫu...</td></tr>`;

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

  // Algo health indicators
  const algoNames = ["Markov-1","Markov-2","Markov-3","Anti-Break","Cầu Bệt","Cầu 1-1","Block Pattern","Cân Bằng","Momentum","Double Break","Chart Tổng","Dice Trend","Sum Markov"];
  const activeAlgos = new Set(pred.signals.map(s => s.source));
  const algoStatusHTML = algoNames.map(name => {
    const active = activeAlgos.has(name);
    const sig = pred.signals.find(s => s.source === name);
    const col = !active ? "#333" : sig?.signal === "T" ? "#c8900a" : "#6010c0";
    const border = !active ? "#222" : sig?.signal === "T" ? "#f5c842" : "#a070ff";
    return `<div class="algo-pill" style="border-color:${border};background:${col}20">
      <span style="color:${active?(sig?.signal==="T"?"#f5c842":"#a070ff"):"#444"}">${active?(sig?.signal==="T"?"▲":"▼"):"·"}</span>
      <span style="color:${active?"#ccc":"#444"};font-size:.62rem">${name}</span>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v12 — SUNWIN</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#c8960a;--gl:#f5c842;--tai:#f5c842;--xiu:#a070ff;
  --bg:#0a0800;--bg2:#120c02;--bg3:#1a1103;--bdr:rgba(180,130,10,.22);
  --txt:#e8d8a0;--dim:#8a6a30;
  --d1:#f5a642;--d2:#42c8f5;--d3:#a0f542;
  --new:#66eecc;
  --mono:'Share Tech Mono',monospace;--head:'Rajdhani',sans-serif;
}
body{background:var(--bg);min-height:100vh;color:var(--txt);font-family:var(--head);padding:10px}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;
  background:linear-gradient(135deg,#1a0800,#0a0400,#1a0800);
  border:1px solid var(--bdr);border-radius:10px;padding:10px 16px;margin-bottom:10px;
  box-shadow:0 2px 20px rgba(200,150,10,.08)}
.hdr-title{font-size:1.2rem;font-weight:700;letter-spacing:4px;
  background:linear-gradient(90deg,#ffa500,#ffd700,#fff4a0,#ffd700,#ffa500);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hdr-right{font-family:var(--mono);font-size:.76rem;color:var(--dim);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.hdr-right .v{color:var(--gl);font-weight:bold}
.hdr-right .ct{color:var(--tai)} .hdr-right .cx{color:var(--xiu)}

/* METRICS */
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px}
.mc{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px;position:relative;overflow:hidden}
.mc::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--ac,var(--gold))}
.mc-lbl{font-size:.58rem;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}
.mc-val{font-size:1.45rem;font-weight:700;font-family:var(--mono);color:var(--ac,var(--gl));line-height:1}
.mc-sub{font-size:.60rem;color:var(--dim);margin-top:3px}

/* CARDS */
.card{background:var(--bg2);border:1px solid var(--bdr);border-radius:10px;padding:12px;margin-bottom:10px}
.card-title{font-size:.62rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim);margin-bottom:10px}

/* BEAD ROAD */
.bead-road{display:flex;flex-wrap:wrap;gap:5px;padding:4px 0}
.bead{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:.68rem;font-weight:700;position:relative}
.bt{background:radial-gradient(circle at 35% 30%,#ffe060,#c8900a,#7a4f00);color:#fff5cc;box-shadow:0 0 6px rgba(200,150,10,.5)}
.bx{background:radial-gradient(circle at 35% 30%,#c490ff,#7820ef,#3a0090);color:#e8d8ff;box-shadow:0 0 6px rgba(130,60,255,.5)}
.bead-new::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid #fff;opacity:.6;animation:blink 1s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:.2}50%{opacity:.8}}

/* VOTE BAR */
.vote-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.05);margin:6px 0}
.vt{background:linear-gradient(90deg,#c8800a,#f5c842)}
.vx{background:linear-gradient(90deg,#6010c0,#a070ff)}
.vote-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:.72rem}

/* CONSENSUS BAR */
.consensus-row{display:flex;align-items:center;gap:10px;margin:6px 0;font-family:var(--mono);font-size:.72rem}
.consensus-bar{flex:1;height:8px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.05)}
.consensus-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#ff6040,#ffaa40,#40ff80)}

/* LAYOUT */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.pred-row{display:grid;grid-template-columns:200px 1fr;gap:10px;margin-bottom:10px}

/* PREDICTION CARD */
.pred-main{background:${predBg};border:2px solid ${predColor};border-radius:12px;padding:16px;text-align:center;
  box-shadow:0 0 30px ${predColor}25}
.pred-lbl{font-size:.60rem;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.pred-val{font-size:3rem;font-weight:700;color:${predColor};text-shadow:0 0 25px ${predColor};line-height:1.1;margin:4px 0}
.conf-track{height:5px;background:rgba(255,255,255,.1);border-radius:3px;margin:6px 0;overflow:hidden}
.conf-fill{height:100%;border-radius:3px;background:${predColor};width:${confPct}%}
.bt-badge{display:inline-block;font-family:var(--mono);font-size:.64rem;padding:2px 8px;border-radius:4px;
  background:rgba(100,220,100,.12);border:1px solid rgba(100,220,100,.25);color:#80dd80;margin-top:4px}
.no-signal-badge{display:inline-block;font-family:var(--mono);font-size:.64rem;padding:4px 10px;border-radius:6px;
  background:rgba(255,200,80,.10);border:1px solid rgba(255,200,80,.3);color:#ffcc60;margin-top:4px}

/* SIGNAL TABLE */
.sig-table{width:100%;border-collapse:collapse;font-size:.68rem}
.sig-table th{color:var(--dim);padding:4px 5px;border-bottom:1px solid var(--bdr);text-align:left;
  font-weight:400;font-size:.58rem;text-transform:uppercase}
.sig-table td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:top}
.td-src{font-family:var(--mono);font-size:.63rem;white-space:nowrap}
.sig-t{color:var(--tai);font-weight:700;white-space:nowrap}
.sig-x{color:var(--xiu);font-weight:700;white-space:nowrap}
.td-wr{font-family:var(--mono);font-size:.72rem;color:#88cc88;text-align:right;white-space:nowrap}
.td-n{font-family:var(--mono);font-size:.62rem;color:#555;text-align:right}
.td-detail{color:#6a5030;font-size:.62rem;line-height:1.3}
.new-badge{font-size:.50rem;background:rgba(100,238,200,.15);border:1px solid rgba(100,238,200,.35);
  color:var(--new);padding:1px 4px;border-radius:3px;vertical-align:middle}

/* ALGO STATUS */
.algo-grid{display:flex;flex-wrap:wrap;gap:6px;padding:4px 0}
.algo-pill{display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:5px;border:1px solid;
  font-family:var(--mono)}

/* SECTION HDR */
.section-hdr{font-size:.58rem;text-transform:uppercase;letter-spacing:2px;color:#5a4010;
  margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(160,110,30,.15)}

/* DICE STATS */
.dice-stats-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px}
.dstat{background:var(--bg2);border:1px solid rgba(255,255,255,.07);border-top:2px solid var(--dc,#888);border-radius:8px;padding:8px 10px}
.dstat-lbl{font-size:.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:2px}
.dstat-avg{font-size:1.3rem;font-weight:700;font-family:var(--mono);line-height:1}
.dstat-sub{font-size:.58rem;color:var(--dim);margin-bottom:6px}
.dstat-hist{display:flex;align-items:flex-end;gap:3px;height:28px}
.dv{display:flex;align-items:center;justify-content:center;min-width:18px;border-radius:2px 2px 0 0;
  font-size:.55rem;color:#000;font-family:var(--mono);font-weight:700;opacity:.85}

/* PATTERN DB */
.pdb{background:var(--bg2);border:1px solid rgba(100,200,150,.2);border-radius:10px;padding:12px;margin-bottom:10px}
.pdb-title{font-size:.62rem;text-transform:uppercase;letter-spacing:1.5px;color:#50aa80;
  margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}

/* INFO NOTE */
.info-note{background:rgba(100,200,100,.04);border:1px solid rgba(100,200,100,.12);border-radius:8px;
  padding:8px 12px;margin-bottom:10px;font-size:.68rem;color:#70aa70;line-height:1.6}
.info-note strong{color:#90cc90}

@media(max-width:620px){
  .metrics,.dice-stats-row{grid-template-columns:repeat(2,1fr)}
  .pred-row,.two-col,.three-col{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v12 — SUNWIN ⬦</div>
  <div class="hdr-right">
    <span>Phiên <span class="v">#${h.phien}</span></span>
    <span class="${h.type==="T"?"ct":"cx"} v">${h.type==="T"?"Tài":"Xỉu"}</span>
    <span style="color:var(--d1)">${h.dice[0]}</span>·<span style="color:var(--d2)">${h.dice[1]}</span>·<span style="color:var(--d3)">${h.dice[2]}</span>
    <span>Σ <span class="v">${h.tong}</span></span>
    <span style="color:#555">${new Date().toLocaleTimeString("vi-VN")}</span>
  </div>
</div>

<div class="info-note">
  🛡 <strong>v12 — Cải Tiến Chống Gãy:</strong>
  Decay Check trên tất cả Markov · <strong style="color:var(--new)">Anti-Break Markov</strong> (tự đảo khi đang gãy) ·
  <strong style="color:var(--new)">Momentum</strong> (3 cửa sổ) ·
  <strong style="color:var(--new)">Double Break</strong> ·
  <strong style="color:var(--new)">Sum Markov</strong> (vùng tổng) ·
  Consensus Filter (≥${CONSENSUS_MIN} đồng thuận) · Ngưỡng WR ≥ ${(MIN_WIN_RATE*100).toFixed(0)}% · Mẫu ≥ ${MIN_SAMPLES} ·
  BT(bỏ qua khi không đủ): <strong style="color:#aaffaa">${btWR}%</strong> / ${btTotal} phiên (skip ${btSkip})
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
  <div class="mc" style="--ac:#66eecc">
    <div class="mc-lbl">Consensus</div>
    <div class="mc-val">${consensusPct}%</div>
    <div class="mc-sub">${pred.cntT}T / ${pred.cntX}X signal</div>
  </div>
</div>

<div class="section-hdr">⬤ Trạng Thái Thuật Toán</div>
<div class="card">
  <div class="card-title">Hoạt động = màu · ▲ Tài · ▼ Xỉu · · = chưa đủ mẫu</div>
  <div class="algo-grid">${algoStatusHTML}</div>
</div>

<div class="section-hdr">⬤ Phân Tích Từng Xúc Xắc</div>
<div class="dice-stats-row">${diceStatHTML}</div>

<div class="section-hdr">⬤ Đồ Thị 3 Xúc Xắc (25 Phiên)</div>
<div class="three-col">
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d1)">🎲 Xúc Xắc 1</div><canvas id="d1Chart" height="160"></canvas></div>
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d2)">🎲 Xúc Xắc 2</div><canvas id="d2Chart" height="160"></canvas></div>
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d3)">🎲 Xúc Xắc 3</div><canvas id="d3Chart" height="160"></canvas></div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Phân Bổ Tần Suất Xúc Xắc (50 Phiên)</div>
<div class="three-col">
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d1)">Tần Suất D1</div><canvas id="freq1Chart" height="120"></canvas></div>
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d2)">Tần Suất D2</div><canvas id="freq2Chart" height="120"></canvas></div>
  <div class="card" style="margin-bottom:0"><div class="card-title" style="color:var(--d3)">Tần Suất D3</div><canvas id="freq3Chart" height="120"></canvas></div>
</div>

<div class="section-hdr" style="margin-top:10px">⬤ Đồ Thị Tổng & Hình Dạng</div>
<div class="two-col">
  <div class="card" style="margin-bottom:0">
    <div class="card-title">📈 Biểu Đồ Tổng + Bollinger Band</div>
    <canvas id="sumChart" height="220"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title">📊 Hình Dạng Z-score (10 phiên)</div>
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
  <div class="consensus-row" style="margin-top:8px">
    <span style="color:var(--dim);font-size:.65rem">Consensus</span>
    <div class="consensus-bar"><div class="consensus-fill" style="width:${consensusPct}%"></div></div>
    <span>${consensusPct}%</span>
    <span style="color:${pred.cntT>pred.cntX?"var(--tai)":"var(--xiu)"};font-size:.72rem">${pred.cntT}T · ${pred.cntX}X</span>
  </div>
</div>

<div class="pred-row">
  <div class="pred-main">
    <div class="pred-lbl">Phiên Tiếp Theo</div>
    <div style="font-size:.7rem;color:var(--dim)">#${Number(h.phien)+1}</div>
    <div class="pred-val">${pred.nextDisplay}</div>
    ${noSignal
      ? `<div class="no-signal-badge">⚠ Không đủ đồng thuận — Nên chờ</div>`
      : `<div class="conf-track"><div class="conf-fill"></div></div>
         <div style="font-family:var(--mono);font-size:1rem;color:#fff">${confPct}%</div>`
    }
    <div class="bt-badge">Backtest: ${btWR}% / ${btTotal}p (skip ${btSkip})</div>
  </div>
  <div class="card" style="margin-bottom:0;overflow:hidden">
    <div class="card-title">${pred.signalCount} tín hiệu (WR≥${(MIN_WIN_RATE*100).toFixed(0)}%, N≥${MIN_SAMPLES}) — <span style="color:var(--new)">xanh = mới v12</span></div>
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
    <span style="font-family:var(--mono);font-size:.70rem;color:#66ddaa">${chartDB.length} mẫu</span>
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

const beadEl = document.getElementById('beadRoad');
[...TYPE_DATA].forEach((t,i) => {
  const b = document.createElement('div');
  b.className = 'bead '+(t==='T'?'bt':'bx')+(i===TYPE_DATA.length-1?' bead-new':'');
  b.textContent = t;
  beadEl.appendChild(b);
});

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
      tension: 0.3, fill: {target:'origin', above: color.replace(')',',0.05)').replace('rgb','rgba')}
    }]},
    options: {
      responsive:true, animation:{duration:400},
      layout:{padding:{top:8,bottom:4}},
      scales:{
        y:{min:0.5,max:6.5,ticks:{stepSize:1,color:'#6a5020',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(160,110,30,.08)'}},
        x:{ticks:{color:'#6a5020',maxTicksLimit:10,font:{size:8,family:'Share Tech Mono'}},grid:{color:'rgba(160,110,30,.05)'}}
      },
      plugins:{
        legend:{display:false},
        annotation:{annotations:{mid:{type:'line',scaleID:'y',value:3.5,borderColor:'rgba(255,255,255,.08)',borderWidth:1,borderDash:[4,4]}}},
        tooltip:{backgroundColor:'rgba(8,6,2,.95)',titleColor:'#ffd700',bodyColor:'#f0d0a0',callbacks:{label:ctx=>label+': '+ctx.parsed.y}}
      }
    }
  });
}
makeDiceChart('d1Chart', D1_DATA, 'rgb(245,166,66)', 'D1');
makeDiceChart('d2Chart', D2_DATA, 'rgb(66,200,245)', 'D2');
makeDiceChart('d3Chart', D3_DATA, 'rgb(160,245,66)', 'D3');

function makeFreqChart(id, freqData, color) {
  const ctx = document.getElementById(id).getContext('2d');
  const total = freqData.reduce((a,b)=>a+b,0)||1;
  const pcts  = freqData.map(v => parseFloat((v/total*100).toFixed(1)));
  const expected = 100/6;
  new Chart(ctx, {
    type:'bar',
    data:{labels:['1','2','3','4','5','6'],datasets:[{
      label:'Tần suất %',data:pcts,
      backgroundColor:pcts.map(p=>p>expected+3?color:p<expected-3?'rgba(255,100,100,.5)':'rgba(180,180,180,.25)'),
      borderColor:color,borderWidth:1.2,borderRadius:3
    }]},
    options:{
      responsive:true,animation:{duration:300},layout:{padding:{top:6}},
      scales:{
        y:{beginAtZero:true,ticks:{color:'#6a5020',font:{size:9,family:'Share Tech Mono'},callback:v=>v+'%'},grid:{color:'rgba(160,110,30,.07)'}},
        x:{ticks:{color:color,font:{size:10,family:'Share Tech Mono'}},grid:{display:false}}
      },
      plugins:{
        legend:{display:false},
        annotation:{annotations:{exp:{type:'line',scaleID:'y',value:expected,borderColor:'rgba(255,255,255,.18)',borderWidth:1,borderDash:[4,4]}}},
        tooltip:{backgroundColor:'rgba(8,6,2,.95)',callbacks:{label:c=>c.parsed.y+'% ('+freqData[c.dataIndex]+')'}}
      }
    }
  });
}
makeFreqChart('freq1Chart',FREQS[0],'#f5a642');
makeFreqChart('freq2Chart',FREQS[1],'#42c8f5');
makeFreqChart('freq3Chart',FREQS[2],'#a0f542');

const numberedPts={
  id:'numberedPts',
  afterDatasetsDraw(chart){
    const ctx=chart.ctx;const meta=chart.getDatasetMeta(3);
    if(!meta)return;
    meta.data.forEach((pt,i)=>{
      const val=SUM_DATA[i];if(val==null)return;
      const isTai=val>=11,R=14;
      ctx.save();ctx.beginPath();ctx.arc(pt.x+1.5,pt.y+2,R,0,Math.PI*2);
      ctx.fillStyle='rgba(0,0,0,.35)';ctx.fill();ctx.restore();
      const g=ctx.createRadialGradient(pt.x-R*.3,pt.y-R*.35,R*.05,pt.x,pt.y,R);
      if(isTai){g.addColorStop(0,'#ffe060');g.addColorStop(.45,'#c8900a');g.addColorStop(1,'#7a4f00');}
      else{g.addColorStop(0,'#c490ff');g.addColorStop(.45,'#7820ef');g.addColorStop(1,'#2a0060');}
      ctx.save();ctx.beginPath();ctx.arc(pt.x,pt.y,R,0,Math.PI*2);
      ctx.fillStyle=g;ctx.fill();
      ctx.strokeStyle=isTai?'#f5c842':'#a070ff';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();
      ctx.save();ctx.fillStyle='#fff';ctx.font='bold 10px Share Tech Mono,monospace';
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.shadowColor='rgba(0,0,0,.8)';ctx.shadowBlur=3;
      ctx.fillText(val,pt.x,pt.y);ctx.restore();
    });
  }
};

new Chart(document.getElementById('sumChart').getContext('2d'),{
  type:'line',plugins:[numberedPts],
  data:{labels:LABELS,datasets:[
    {label:'BB Upper',data:Array(N).fill(BOLL_UP),borderColor:'rgba(100,180,255,.20)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:false,tension:0,order:10},
    {label:'BB Lower',data:Array(N).fill(BOLL_LOW),borderColor:'rgba(100,180,255,.20)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:{target:'-1',above:'rgba(100,180,255,.04)'},tension:0,order:10},
    {label:'BB Mid',data:Array(N).fill(BOLL_MID),borderColor:'rgba(100,180,255,.12)',borderWidth:1,borderDash:[6,5],pointRadius:0,fill:false,tension:0,order:10},
    {label:'Tổng',data:SUM_DATA,borderColor:'rgba(210,175,80,.65)',borderWidth:2,
      pointRadius:16,pointHoverRadius:18,
      pointBackgroundColor:SUM_DATA.map(v=>v>=11?'#b07800':'#5010a0'),
      pointBorderColor:SUM_DATA.map(v=>v>=11?'#f5c842':'#a070ff'),
      pointBorderWidth:2,tension:0,fill:false,order:0}
  ]},
  options:{responsive:true,animation:{duration:500},layout:{padding:{top:18,bottom:6,left:4,right:4}},
    scales:{
      y:{min:3,max:18,ticks:{color:'#8a6030',stepSize:3,font:{size:11,family:'Share Tech Mono'}},grid:{color:'rgba(160,110,30,.12)'}},
      x:{ticks:{color:'#7a5020',maxTicksLimit:15,font:{size:9,family:'Share Tech Mono'}},grid:{color:'rgba(160,110,30,.07)'}}
    },
    plugins:{legend:{display:false},
      annotation:{annotations:{
        mid:{type:'line',scaleID:'y',value:10.5,borderColor:'rgba(255,255,255,.08)',borderWidth:1,borderDash:[6,5]},
        taiZ:{type:'box',scaleID:'y',yMin:11,yMax:18,backgroundColor:'rgba(245,200,66,.025)',borderWidth:0},
        xiuZ:{type:'box',scaleID:'y',yMin:3,yMax:10.5,backgroundColor:'rgba(160,112,255,.025)',borderWidth:0},
      }},
      tooltip:{backgroundColor:'rgba(8,6,2,.95)',titleColor:'#ffd700',bodyColor:'#f0d0a0',
        callbacks:{label:ctx=>{const v=ctx.parsed.y;if(ctx.dataset.label!=='Tổng')return ctx.dataset.label+': '+v.toFixed(1);return'Tổng: '+v+' → '+(v>=11?'🟡 Tài':'🟣 Xỉu');}}}
    }
  }
});

(function(){
  const raw=SUM_DATA.slice(-10);if(raw.length<2)return;
  const m=raw.reduce((s,v)=>s+v,0)/raw.length;
  const sd=Math.sqrt(raw.reduce((s,v)=>s+(v-m)**2,0)/raw.length)||1;
  const norm=raw.map(v=>(v-m)/sd);
  new Chart(document.getElementById('shapeChart').getContext('2d'),{
    type:'line',
    data:{labels:raw.map((_,i)=>String(i+1)),datasets:[{
      label:'Z-score',data:norm,
      borderColor:'rgba(100,220,150,.8)',borderWidth:2.5,
      pointRadius:norm.map((_,i)=>i===norm.length-1?8:4),
      pointBackgroundColor:norm.map((v,i)=>i===norm.length-1?'#44ff88':v>=0?'rgba(245,200,66,.75)':'rgba(160,112,255,.75)'),
      pointBorderColor:'#222',pointBorderWidth:1,tension:.35,
      fill:{target:'origin',above:'rgba(245,200,66,.06)',below:'rgba(160,112,255,.06)'}
    }]},
    options:{responsive:true,animation:{duration:600},layout:{padding:{top:12,bottom:6}},
      scales:{
        y:{ticks:{color:'#5a7a60',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(100,200,120,.08)'},title:{display:true,text:'Z-score',color:'#456050',font:{size:10}}},
        x:{ticks:{color:'#456050',font:{size:10,family:'Share Tech Mono'}},grid:{color:'rgba(100,200,120,.05)'},title:{display:true,text:'Phiên (cũ→mới)',color:'#456050',font:{size:10}}}
      },
      plugins:{legend:{display:false},
        annotation:{annotations:{zero:{type:'line',scaleID:'y',value:0,borderColor:'rgba(255,255,255,.12)',borderWidth:1,borderDash:[4,4]}}},
        tooltip:{backgroundColor:'rgba(5,15,8,.95)',callbacks:{label:ctx=>{const v=ctx.parsed.y;return'Z: '+(v>=0?'+':'')+v.toFixed(2)+' ('+(v>=0?'Tài':'Xỉu')+')';}}}
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
      consensus: Math.round((p.consensus||0)*100)+"%",
      signal_count_T: p.cntT, signal_count_X: p.cntX,
      backtest_winrate: p.backtest?.wr ?? null,
      signal_count: p.signalCount,
      chart_db_size: p.chartDBSize,
      ver: "v12"
    })); return;
  }

  if (url.pathname === "/predict/detail") {
    if (!history.length) { noData(); return; }
    const p = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan: p.nextDisplay, do_tin_cay: p.confDisplay,
      consensus: p.consensus, cntT: p.cntT, cntX: p.cntX,
      backtest: p.backtest, signals: p.signals, streak: p.streak,
      chart_signal: p.chartSignal, dice_stats: p.diceStats,
      chart_db_size: p.chartDBSize, ver: "v12"
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
      consensus: Math.round((p.consensus||0)*100)+"%",
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

  if (url.pathname === "/patterns") {
    const top = [...chartDB].filter(e => e.totalSeen >= 5)
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
    endpoints: ["/predict","/predict/detail","/history","/bando","/sunlon","/patterns","/debug"],
    ver: "v12"
  }));

}).listen(PORT, () => {
  console.log(`✅  SicBo v12.0 — Chống Gãy & Consensus Filter — port ${PORT}`);
  console.log(`    Dashboard   : http://localhost:${PORT}/bando`);
  console.log(`    API         : http://localhost:${PORT}/predict`);
  console.log(`    Patterns    : http://localhost:${PORT}/patterns`);
  console.log(`    Algorithms:`);
  console.log(`      Markov(1/2/3) + Decay Check   ← chống gãy`);
  console.log(`      Anti-Break Markov              ← TỰ ĐẢO khi đang gãy liên tục`);
  console.log(`      Cầu Bệt + Decay Check          ← chống gãy`);
  console.log(`      Cầu Xen Kẽ`);
  console.log(`      Block Pattern (thay N-gram)    ← chính xác hơn`);
  console.log(`      Cân Bằng (Mean Reversion)`);
  console.log(`      Momentum (5/10/20 phiên)       ← MỚI`);
  console.log(`      Double After Break             ← MỚI`);
  console.log(`      Chart Tổng (Pearson+Bollinger) ← ngưỡng 0.82`);
  console.log(`      Dice Trend (slope 3 xúc xắc)`);
  console.log(`      Sum Markov (vùng tổng)         ← MỚI, thay DiceGroupMarkov`);
  console.log(`      Consensus Filter: ≥${CONSENSUS_MIN} đồng thuận mới ra kết quả`);
  console.log(`      WR ngưỡng: ≥${(MIN_WIN_RATE*100).toFixed(0)}%  Mẫu ngưỡng: ≥${MIN_SAMPLES}`);
  syncHistory();
  setInterval(syncHistory, 12000);
});
