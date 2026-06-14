"use strict";
const https  = require("https");
const http   = require("http");

const SOURCE_URL  = "https://apilichsusunwinsew.onrender.com/api/taixiu/history?limit=50";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 600;

let history = [];

// ════════════════════════════════════════════════════════════════════
//  DATA INGESTION (giữ nguyên từ v7)
// ════════════════════════════════════════════════════════════════════
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
  let type = null;
  if (r.includes("TAI") || r.includes("TÀI") || r === "T" || r === "BIG"  || r === "1") type = "T";
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

// ════════════════════════════════════════════════════════════════════
//  CORE MATH
// ════════════════════════════════════════════════════════════════════
function mean(arr) { if (!arr.length) return 0; return arr.reduce((s,v)=>s+v,0)/arr.length; }
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s,v) => s + (v-m)**2, 0) / arr.length);
}

// ════════════════════════════════════════════════════════════════════
//  ALGORITHM v8: SELF-BACKTESTING ENGINE
// ════════════════════════════════════════════════════════════════════
const MIN_WIN_RATE = 0.52;
const MIN_SAMPLE   = 8;

function buildMarkovTable(typeSeq, order) {
  const counts = {};
  for (let i = order; i < typeSeq.length; i++) {
    const key = typeSeq.slice(i - order, i).reverse().join("");
    const next = typeSeq[i - order - 1];
    if (!next) continue;
    if (!counts[key]) counts[key] = { T: 0, X: 0 };
    counts[key][next]++;
  }
  return counts;
}

function predictMarkov(typeSeq, order) {
  if (typeSeq.length < order + MIN_SAMPLE) return null;
  const table = buildMarkovTable(typeSeq, order);
  const curState = typeSeq.slice(0, order).reverse().join("");
  const c = table[curState];
  if (!c) return null;
  const alpha = 0.5;
  const pT = (c.T + alpha) / (c.T + c.X + 2 * alpha);
  const pX = 1 - pT;
  let wins = 0, total = 0;
  for (let i = order + 1; i < typeSeq.length - 1; i++) {
    const state = typeSeq.slice(i, i + order).reverse().join("");
    if (state !== curState) continue;
    const predicted = table[state]
      ? (table[state].T >= table[state].X ? "T" : "X")
      : null;
    if (!predicted) continue;
    const actual = typeSeq[i - 1];
    if (predicted === actual) wins++;
    total++;
  }
  if (total < MIN_SAMPLE) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;
  const pred = pT >= pX ? "T" : "X";
  return {
    signal: pred, winRate: wr,
    conf: 0.50 + (wr - 0.50) * 1.2,
    detail: `Markov-${order} [${curState}] WR=${(wr*100).toFixed(0)}% (${total} mẫu)`,
    source: `Markov-${order}`, sampleCount: total
  };
}

function analyzeStreakCau(typeSeq) {
  if (typeSeq.length < 10) return null;
  const cur = typeSeq[0];
  let streak = 1;
  for (let i = 1; i < typeSeq.length; i++) {
    if (typeSeq[i] === cur) streak++;
    else break;
  }
  if (streak < 2) return null;
  let breakWins = 0, contWins = 0, total = 0;
  for (let i = streak + 1; i < typeSeq.length - 1; i++) {
    if (typeSeq[i] !== cur) continue;
    let len = 0;
    for (let j = i; j < typeSeq.length; j++) {
      if (typeSeq[j] === cur) len++;
      else break;
    }
    if (len !== streak) continue;
    const nextIdx = i - 1;
    if (nextIdx < 0) continue;
    const next = typeSeq[nextIdx];
    if (next === cur) contWins++;
    else breakWins++;
    total++;
  }
  if (total < MIN_SAMPLE) return null;
  const breakRate = breakWins / total;
  const contRate  = contWins  / total;
  if (breakRate > MIN_WIN_RATE) {
    const opp = cur === "T" ? "X" : "T";
    return {
      signal: opp, winRate: breakRate,
      conf: 0.50 + (breakRate - 0.50) * 1.2,
      detail: `Bệt ${streak}×${cur==="T"?"Tài":"Xỉu"} → đảo ${(breakRate*100).toFixed(0)}% (${total} mẫu)`,
      source: "Cầu Bệt", sampleCount: total
    };
  }
  if (contRate > MIN_WIN_RATE && streak <= 3) {
    return {
      signal: cur, winRate: contRate,
      conf: 0.50 + (contRate - 0.50) * 1.2,
      detail: `Bệt ${streak}×${cur==="T"?"Tài":"Xỉu"} → tiếp ${(contRate*100).toFixed(0)}% (${total} mẫu)`,
      source: "Cầu Bệt", sampleCount: total
    };
  }
  return null;
}

function analyzeAlternating(typeSeq) {
  if (typeSeq.length < 8) return null;
  let altLen = 1;
  for (let i = 1; i < Math.min(typeSeq.length, 20); i++) {
    if (typeSeq[i] !== typeSeq[i-1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;
  const expected = typeSeq[0] === "T" ? "X" : "T";
  let wins = 0, total = 0;
  for (let i = altLen + 1; i < typeSeq.length - 1; i++) {
    let len = 0;
    for (let j = i; j < typeSeq.length - 1 && j < i + 30; j++) {
      if (typeSeq[j] !== typeSeq[j+1]) len++;
      else break;
    }
    if (len < altLen) continue;
    const predicted = typeSeq[i] === "T" ? "X" : "T";
    const actual = typeSeq[i - 1];
    if (predicted === actual) wins++;
    total++;
    if (total >= 50) break;
  }
  if (total < MIN_SAMPLE) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;
  return {
    signal: expected, winRate: wr,
    conf: 0.50 + (wr - 0.50) * 1.2,
    detail: `Xen kẽ ${altLen} phiên → ${expected==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`,
    source: "Cầu 1-1", sampleCount: total
  };
}

function analyzeSymmetric(typeSeq) {
  if (typeSeq.length < 12) return null;
  for (const bk of [2, 3, 4]) {
    const cur = typeSeq[0];
    let posInBlock = 0;
    for (let i = 0; i < typeSeq.length; i++) {
      if (typeSeq[i] === cur) posInBlock++;
      else break;
    }
    let prevBlockLen = 0;
    let i = posInBlock;
    const prevType = typeSeq[i];
    for (; i < typeSeq.length; i++) {
      if (typeSeq[i] === prevType) prevBlockLen++;
      else break;
    }
    if (prevBlockLen !== bk) continue;
    const predicted = posInBlock >= bk ? (cur === "T" ? "X" : "T") : cur;
    let wins = 0, total = 0;
    let idx = 0;
    while (idx < typeSeq.length - bk * 2 - 2) {
      const A = typeSeq[idx];
      let lenA = 0;
      let j = idx;
      for (; j < typeSeq.length && typeSeq[j] === A; j++) lenA++;
      if (lenA !== bk) { idx = j + 1; continue; }
      const B = typeSeq[j];
      if (B === A) { idx = j + 1; continue; }
      let lenB = 0;
      let k = j;
      for (; k < typeSeq.length && typeSeq[k] === B; k++) lenB++;
      if (lenB !== bk) { idx = k + 1; continue; }
      const next = typeSeq[k - 1];
      if (k - 1 >= 0) {
        const pred2 = A;
        if (next === pred2) wins++;
        total++;
      }
      idx = k + 1;
    }
    if (total < MIN_SAMPLE) continue;
    const wr = wins / total;
    if (wr < MIN_WIN_RATE) continue;
    return {
      signal: predicted, winRate: wr,
      conf: 0.50 + (wr - 0.50) * 1.2,
      detail: `Cầu ${bk}-${bk} (pos ${posInBlock}/${bk}) WR=${(wr*100).toFixed(0)}% (${total} mẫu)`,
      source: `Cầu ${bk}-${bk}`, sampleCount: total
    };
  }
  return null;
}

function analyzeDiceBalance(hist) {
  if (hist.length < 20) return null;
  const recent = hist.slice(0, 30);
  const countT = recent.filter(h => h.type === "T").length;
  const ratioT = countT / recent.length;
  let wins = 0, total = 0;
  for (let i = 20; i < hist.length - 20; i++) {
    const sub = hist.slice(i, i + 20);
    const pT = sub.filter(h => h.type === "T").length / 20;
    const next20 = hist.slice(Math.max(0, i - 20), i);
    if (next20.length < 10) continue;
    const pT_next = next20.filter(h => h.type === "T").length / next20.length;
    if (pT > 0.60) {
      if (pT_next < 0.50) wins++;
      total++;
    } else if (pT < 0.40) {
      if (pT_next > 0.50) wins++;
      total++;
    }
  }
  if (total < MIN_SAMPLE) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;
  if (ratioT > 0.62) {
    return {
      signal: "X", winRate: wr,
      conf: 0.50 + (wr - 0.50) * 1.2,
      detail: `Cân bằng: Tài ${(ratioT*100).toFixed(0)}% (30p) → hồi quy Xỉu WR=${(wr*100).toFixed(0)}%`,
      source: "Cân Bằng Xúc Xắc", sampleCount: total
    };
  }
  if (ratioT < 0.38) {
    return {
      signal: "T", winRate: wr,
      conf: 0.50 + (wr - 0.50) * 1.2,
      detail: `Cân bằng: Xỉu ${((1-ratioT)*100).toFixed(0)}% (30p) → hồi quy Tài WR=${(wr*100).toFixed(0)}%`,
      source: "Cân Bằng Xúc Xắc", sampleCount: total
    };
  }
  return null;
}

function analyzePattern5(typeSeq) {
  if (typeSeq.length < 20) return null;
  const W = 5;
  const cur = typeSeq.slice(0, W).join("");
  let wins = 0, total = 0;
  for (let i = W; i < typeSeq.length - 1; i++) {
    const pat = typeSeq.slice(i, i + W).join("");
    if (pat !== cur) continue;
    total++;
    if (typeSeq[i - 1] === "T") wins++;
  }
  if (total < MIN_SAMPLE) return null;
  const pT = wins / total;
  const pX = 1 - pT;
  const pred = pT >= pX ? "T" : "X";
  const wr = Math.max(pT, pX);
  if (wr < MIN_WIN_RATE) return null;
  return {
    signal: pred, winRate: wr,
    conf: 0.50 + (wr - 0.50) * 1.2,
    detail: `Pattern [${cur}] → ${pred==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`,
    source: "5-gram Pattern", sampleCount: total
  };
}

// ════════════════════════════════════════════════════════════════════
//  ALGORITHM v9 ADDITION: CHART PATTERN RECOGNITION ENGINE
//  Phân tích hình dạng đồ thị tổng xúc xắc, lưu khuôn mẫu, dự đoán
// ════════════════════════════════════════════════════════════════════

// Kho lưu trữ các khuôn mẫu đồ thị (in-memory, tích lũy theo thời gian)
const chartPatternDB = {
  templates: [],       // { shape, label, outcomes: {T:0, X:0}, id }
  maxTemplates: 200,   // tối đa 200 khuôn mẫu
  minMatchScore: 0.78, // ngưỡng tương đồng hình dạng tối thiểu
};

// Chuẩn hóa chuỗi tổng về dạng z-score để so sánh hình dạng
function normalizeShape(arr) {
  if (arr.length < 2) return arr;
  const m = mean(arr);
  const s = stdDev(arr) || 1;
  return arr.map(v => (v - m) / s);
}

// Mô tả hình dạng đồ thị bằng các đặc trưng:
// slope (xu hướng), curvature (độ cong), peaks/valleys
function extractShapeFeatures(arr) {
  const n = arr.length;
  if (n < 5) return null;
  const norm = normalizeShape(arr);

  // Xu hướng tuyến tính (linear regression slope)
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += norm[i]; sumXY += i * norm[i]; sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Độ cong trung bình (second derivative)
  let curvature = 0;
  for (let i = 1; i < n - 1; i++) {
    curvature += norm[i+1] - 2*norm[i] + norm[i-1];
  }
  curvature /= (n - 2);

  // Phát hiện đỉnh (peaks) và đáy (valleys)
  let peaks = 0, valleys = 0;
  for (let i = 1; i < n - 1; i++) {
    if (norm[i] > norm[i-1] && norm[i] > norm[i+1]) peaks++;
    if (norm[i] < norm[i-1] && norm[i] < norm[i+1]) valleys++;
  }

  // Momentum: nửa sau so với nửa đầu
  const half = Math.floor(n/2);
  const firstHalf = mean(norm.slice(0, half));
  const secondHalf = mean(norm.slice(half));
  const momentum = secondHalf - firstHalf;

  // Biên độ dao động (volatility)
  const volatility = stdDev(norm);

  // Shape fingerprint: quantize các đặc trưng
  const slopeQ  = slope  >  0.15 ? "UP"   : slope  < -0.15 ? "DOWN"  : "FLAT";
  const curvQ   = curvature > 0.05 ? "CONV" : curvature < -0.05 ? "CONC" : "LIN";
  const momQ    = momentum >  0.2  ? "ACC"  : momentum < -0.2  ? "DEC"  : "NEU";
  const volQ    = volatility > 1.2 ? "HIGH" : volatility < 0.5 ? "LOW"  : "MID";
  const peakQ   = peaks >= 3 ? "MULTI" : peaks === 2 ? "DOUBLE" : peaks === 1 ? "SINGLE" : "NONE";

  return {
    slope, curvature, momentum, volatility, peaks, valleys,
    slopeQ, curvQ, momQ, volQ, peakQ,
    fingerprint: `${slopeQ}|${curvQ}|${momQ}|${volQ}|${peakQ}`,
    norm // giữ lại dạng chuẩn hóa để tính correlation
  };
}

// Tính độ tương đồng giữa 2 chuỗi đã chuẩn hóa bằng Pearson correlation
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] - ma, bi = b[i] - mb;
    num += ai * bi; da += ai*ai; db += bi*bi;
  }
  if (!da || !db) return 0;
  return num / Math.sqrt(da * db);
}

// Phân loại hình dạng đồ thị theo tên gọi trực quan
function classifyChartShape(features) {
  const { slopeQ, curvQ, momQ, peakQ, volatility, peaks, valleys } = features;
  if (volatility > 1.5 && peaks >= 3) return "Zigzag Mạnh";
  if (slopeQ === "UP"   && curvQ === "CONV") return "Hình V ngược (Đỉnh)";
  if (slopeQ === "DOWN" && curvQ === "CONC") return "Hình V (Đáy)";
  if (slopeQ === "UP"   && momQ  === "ACC")  return "Tăng Tốc";
  if (slopeQ === "DOWN" && momQ  === "DEC")  return "Giảm Tốc";
  if (slopeQ === "FLAT" && volatility < 0.6) return "Nằm Ngang Ổn Định";
  if (slopeQ === "FLAT" && volatility > 1.0) return "Dao Động Ngang";
  if (peakQ === "DOUBLE" && slopeQ !== "DOWN") return "Hai Đỉnh";
  if (valleys >= 2 && slopeQ !== "UP") return "Hai Đáy";
  if (momQ === "ACC"  && slopeQ !== "DOWN") return "Tăng Momentum";
  if (momQ === "DEC"  && slopeQ !== "UP")  return "Giảm Momentum";
  return `Hỗn Hợp (${slopeQ}/${curvQ})`;
}

// Cập nhật kho khuôn mẫu với cửa sổ lịch sử mới
function updateChartPatternDB(hist) {
  if (hist.length < 16) return;
  const WINDOW = 10; // cửa sổ 10 phiên để nhận dạng mẫu

  for (let i = WINDOW + 1; i < Math.min(hist.length - 1, 100); i++) {
    const window = hist.slice(i, i + WINDOW).map(h => h.tong).reverse();
    const outcome = hist[i - 1].type; // kết quả ngay sau cửa sổ
    const features = extractShapeFeatures(window);
    if (!features) continue;

    // Tìm khuôn mẫu tương tự trong DB
    let bestMatch = null, bestScore = 0;
    for (const tmpl of chartPatternDB.templates) {
      if (tmpl.norm.length !== features.norm.length) continue;
      const score = pearsonCorrelation(tmpl.norm, features.norm);
      if (score > bestScore) { bestScore = score; bestMatch = tmpl; }
    }

    if (bestScore >= chartPatternDB.minMatchScore && bestMatch) {
      // Cập nhật khuôn mẫu hiện có
      bestMatch.outcomes[outcome]++;
      bestMatch.totalSeen++;
    } else {
      // Tạo khuôn mẫu mới
      const label = classifyChartShape(features);
      chartPatternDB.templates.push({
        id: chartPatternDB.templates.length + 1,
        shape: features.fingerprint,
        label,
        features,
        norm: features.norm,
        window: [...window],
        outcomes: { T: outcome === "T" ? 1 : 0, X: outcome === "X" ? 1 : 0 },
        totalSeen: 1,
        createdAt: Date.now()
      });
      // Giới hạn kích thước DB
      if (chartPatternDB.templates.length > chartPatternDB.maxTemplates) {
        // Xóa khuôn mẫu ít gặp nhất
        chartPatternDB.templates.sort((a,b) => b.totalSeen - a.totalSeen);
        chartPatternDB.templates = chartPatternDB.templates.slice(0, chartPatternDB.maxTemplates);
      }
    }
  }
}

// Dự đoán dựa trên khuôn mẫu đồ thị hiện tại
function predictChartPattern(hist) {
  if (hist.length < 12) return null;
  const WINDOW = 10;
  const currentWindow = hist.slice(0, WINDOW).map(h => h.tong).reverse();
  const features = extractShapeFeatures(currentWindow);
  if (!features) return null;

  // Cập nhật DB trước
  updateChartPatternDB(hist);

  // Tìm các khuôn mẫu phù hợp nhất
  const matches = [];
  for (const tmpl of chartPatternDB.templates) {
    if (tmpl.norm.length !== features.norm.length) continue;
    const score = pearsonCorrelation(tmpl.norm, features.norm);
    if (score >= chartPatternDB.minMatchScore) {
      const total = tmpl.outcomes.T + tmpl.outcomes.X;
      if (total >= 3) {
        matches.push({ ...tmpl, score, total });
      }
    }
  }

  if (!matches.length) return null;
  // Tổng hợp vote có trọng số theo score và totalSeen
  let wT = 0, wX = 0;
  for (const m of matches) {
    const w = m.score * Math.log(1 + m.totalSeen);
    const pT = m.outcomes.T / m.total;
    wT += w * pT;
    wX += w * (1 - pT);
  }

  if (wT + wX < 0.001) return null;
  const pT = wT / (wT + wX);
  const pred = pT >= 0.5 ? "T" : "X";
  const wr = Math.max(pT, 1 - pT);
  if (wr < MIN_WIN_RATE) return null;

  const shapeName = classifyChartShape(features);
  const topMatch = matches.sort((a,b) => b.score - a.score)[0];

  return {
    signal: pred, winRate: wr,
    conf: 0.50 + (wr - 0.50) * 1.2,
    detail: `Đồ thị [${shapeName}] khớp ${matches.length} mẫu (best ${(topMatch.score*100).toFixed(0)}%) → ${pred==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`,
    source: "Chart Pattern",
    sampleCount: matches.reduce((s, m) => s + m.totalSeen, 0),
    shapeName,
    matchCount: matches.length,
    features,
    topMatchLabel: topMatch.label
  };
}

// Thống kê kho khuôn mẫu
function getPatternDBStats() {
  const total = chartPatternDB.templates.length;
  if (!total) return { total: 0, shapes: [], topPatterns: [] };

  const shapeCounts = {};
  chartPatternDB.templates.forEach(t => {
    shapeCounts[t.label] = (shapeCounts[t.label] || 0) + t.totalSeen;
  });

  const topPatterns = chartPatternDB.templates
    .filter(t => t.totalSeen >= 3)
    .sort((a, b) => b.totalSeen - a.totalSeen)
    .slice(0, 10)
    .map(t => {
      const tot = t.outcomes.T + t.outcomes.X;
      const wrT = tot > 0 ? t.outcomes.T / tot : 0.5;
      return {
        id: t.id, label: t.label, shape: t.shape,
        totalSeen: t.totalSeen,
        winRateT: wrT, winRateX: 1 - wrT,
        predictedNext: wrT >= 0.5 ? "T" : "X"
      };
    });

  return { total, shapeCounts, topPatterns };
}

// ════════════════════════════════════════════════════════════════════
//  BAYESIAN ENSEMBLE + CALIBRATION
// ════════════════════════════════════════════════════════════════════
function bayesianEnsemble(signals) {
  if (!signals.length) return { pred: "?", prob: 0.50, logOdds: 0 };
  let logOdds = 0;
  for (const s of signals) {
    const wr = Math.min(Math.max(s.winRate, 0.50), 0.85);
    const lr = s.signal === "T"
      ? Math.log(wr / (1 - wr))
      : Math.log((1-wr) / wr);
    const weight = Math.log(1 + s.sampleCount / 10);
    logOdds += lr * weight;
  }
  const prob = 1 / (1 + Math.exp(-logOdds));
  return {
    pred: prob >= 0.50 ? "T" : "X",
    prob: prob >= 0.50 ? prob : 1 - prob,
    logOdds
  };
}

function calibrateConf(rawProb) {
  const clipped = Math.min(Math.max(rawProb, 0.50), 0.95);
  return 0.50 + (clipped - 0.50) * 0.65;
}

function backtestPredictor(hist, windowSize = 30) {
  if (hist.length < windowSize + 10) return null;
  let wins = 0, total = 0;
  for (let i = 1; i <= Math.min(30, hist.length - windowSize - 1); i++) {
    const subHist = hist.slice(i, i + windowSize);
    if (subHist.length < 10) continue;
    const subSeq = subHist.map(h => h.type);
    const signals = collectSignals(subSeq, subHist);
    if (!signals.length) continue;
    const { pred } = bayesianEnsemble(signals);
    const actual = hist[i - 1].type;
    if (pred === actual) wins++;
    total++;
  }
  if (!total) return null;
  return { wins, total, wr: wins / total };
}

function collectSignals(typeSeq, hist) {
  const signals = [];
  const add = (r) => { if (r) signals.push(r); };
  add(predictMarkov(typeSeq, 1));
  add(predictMarkov(typeSeq, 2));
  add(predictMarkov(typeSeq, 3));
  add(analyzeStreakCau(typeSeq));
  add(analyzeAlternating(typeSeq));
  add(analyzeSymmetric(typeSeq));
  add(analyzePattern5(typeSeq));
  if (hist) add(analyzeDiceBalance(hist));
  if (hist) add(predictChartPattern(hist));
  return signals;
}

// ════════════════════════════════════════════════════════════════════
//  MAIN PREDICTOR v9
// ════════════════════════════════════════════════════════════════════
function predictV9(hist) {
  if (hist.length < 10) {
    return {
      next: "?", nextDisplay: "Chưa đủ dữ liệu", conf: 50, confDisplay: "50%",
      signals: [], backtest: null, typeSeq: [], patternDBStats: getPatternDBStats()
    };
  }

  const typeSeq = hist.map(h => h.type);
  const signals = collectSignals(typeSeq, hist);
  const { pred, prob } = bayesianEnsemble(signals);
  const conf = calibrateConf(prob);
  const backtest = backtestPredictor(hist, 30);

  const curType = typeSeq[0];
  let streak = 0;
  for (const t of typeSeq) { if (t === curType) streak++; else break; }

  const pattern20 = typeSeq.slice(0, 20).join("");

  // Chart pattern riêng
  const chartSig = signals.find(s => s.source === "Chart Pattern");

  return {
    next: pred === "?" ? "?" : pred,
    nextDisplay: pred === "T" ? "Tài" : pred === "X" ? "Xỉu" : "?",
    conf: Math.round(conf * 100),
    confDisplay: Math.round(conf * 100) + "%",
    signals,
    signalCount: signals.length,
    backtest,
    typeSeq: typeSeq.slice(0, 25),
    sumChart: hist.slice(0, 25).map(h => h.tong),
    diceCharts: {
      d1: hist.slice(0, 25).map(h => h.dice[0]),
      d2: hist.slice(0, 25).map(h => h.dice[1]),
      d3: hist.slice(0, 25).map(h => h.dice[2]),
    },
    streak, curType, pattern20,
    votesT: signals.filter(s => s.signal === "T").reduce((s, r) => s + r.winRate, 0).toFixed(2),
    votesX: signals.filter(s => s.signal === "X").reduce((s, r) => s + r.winRate, 0).toFixed(2),
    patternDBStats: getPatternDBStats(),
    chartSignal: chartSig || null,
    currentShape: chartSig ? chartSig.shapeName : null,
  };
}

// ════════════════════════════════════════════════════════════════════
//  HTML BUILDER v9
// ════════════════════════════════════════════════════════════════════
function buildHTML(pred, h) {
  if (!pred || pred.next === "?") return "<h2>Không đủ dữ liệu</h2>";

  const n = pred.sumChart.length;
  const labels = JSON.stringify(Array.from({length:n}, (_,i) => String(Number(h.phien) - (n - 1 - i))));
  const sumData = JSON.stringify([...pred.sumChart].reverse());
  const d1Data  = JSON.stringify([...pred.diceCharts.d1].reverse());
  const d2Data  = JSON.stringify([...pred.diceCharts.d2].reverse());
  const d3Data  = JSON.stringify([...pred.diceCharts.d3].reverse());
  const typeData = JSON.stringify([...pred.typeSeq].reverse());

  const isTai = pred.next === "T";
  const predColor = isTai ? "#f5c842" : "#a070ff";
  const predBg    = isTai ? "rgba(245,200,66,0.10)" : "rgba(160,112,255,0.10)";

  const btWR = pred.backtest ? (pred.backtest.wr * 100).toFixed(1) : "N/A";
  const btTotal = pred.backtest ? pred.backtest.total : 0;

  const sigRows = pred.signals.map(s => {
    const isSigT = s.signal === "T";
    const isChart = s.source === "Chart Pattern";
    return `<tr${isChart ? ' style="background:rgba(100,200,150,0.06)"' : ''}>
      <td class="src-td">${s.source}</td>
      <td class="${isSigT ? "sig-t" : "sig-x"}">${isSigT ? "▲ Tài" : "▼ Xỉu"}</td>
      <td class="wr-td">${(s.winRate * 100).toFixed(0)}%</td>
      <td class="n-td">${s.sampleCount}</td>
      <td class="detail-td">${s.detail}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;padding:8px;font-size:.8rem">Chưa đủ mẫu để kích hoạt tín hiệu</td></tr>`;

  const pctT = Number(pred.votesT) + Number(pred.votesX) > 0
    ? Math.round(Number(pred.votesT) / (Number(pred.votesT) + Number(pred.votesX)) * 100)
    : 50;
  const pctX = 100 - pctT;

  const sumArr = pred.sumChart;
  const bolMid = parseFloat(mean(sumArr).toFixed(2));
  const bolSd  = parseFloat(stdDev(sumArr).toFixed(2));
  const bolUp  = parseFloat((bolMid + 2 * bolSd).toFixed(2));
  const bolLow = parseFloat((bolMid - 2 * bolSd).toFixed(2));

  // Pattern DB stats
  const db = pred.patternDBStats;
  const topPatternsHTML = db.topPatterns.length > 0
    ? db.topPatterns.map(p => {
        const wrPct = Math.max(p.winRateT, p.winRateX) * 100;
        const isTp = p.predictedNext === "T";
        return `<tr>
          <td class="src-td">#${p.id}</td>
          <td style="color:#9a8060;font-size:.62rem;max-width:120px">${p.label}</td>
          <td class="${isTp?'sig-t':'sig-x'}">${isTp?"▲ T":"▼ X"}</td>
          <td class="wr-td">${wrPct.toFixed(0)}%</td>
          <td class="n-td">${p.totalSeen}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" style="color:#555;font-size:.75rem;padding:6px">Đang xây dựng kho mẫu...</td></tr>`;

  const shapeInfoHTML = pred.chartSignal
    ? `<div class="shape-badge">
        <span class="shape-icon">📊</span>
        <span>Hình dạng hiện tại: <strong style="color:#88eebb">${pred.chartSignal.shapeName}</strong></span>
        <span class="shape-match">Khớp ${pred.chartSignal.matchCount} mẫu lịch sử</span>
      </div>`
    : `<div class="shape-badge" style="opacity:0.5">📊 Đang phân tích hình dạng đồ thị...</div>`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v9 — SUNWIN</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#c8960a;--gold-lite:#f5c842;--tai:#f5c842;--xiu:#a070ff;
  --bg:#0d0900;--bg2:#160e03;--bg3:#1e1404;--border:rgba(180,130,10,0.28);
  --text:#e8d8a0;--text-dim:#9a7a40;
  --mono:'Share Tech Mono',monospace;--head:'Rajdhani',sans-serif;
  --chart-green:#44cc88;
}
body{background:var(--bg);min-height:100vh;color:var(--text);font-family:var(--head);padding:10px;}
.hdr{display:flex;align-items:center;justify-content:space-between;
  background:linear-gradient(90deg,#1e0a00,#0f0600,#1e0a00);
  border:1px solid var(--border);border-radius:10px;padding:10px 16px;margin-bottom:10px;}
.hdr-title{font-size:1.25rem;font-weight:700;letter-spacing:4px;
  background:linear-gradient(90deg,#ffa500,#ffd700,#fff4a0,#ffd700,#ffa500);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.hdr-badge{display:flex;gap:14px;font-family:var(--mono);font-size:.78rem;color:var(--text-dim);align-items:center;}
.hdr-badge .val{color:var(--gold-lite);font-weight:bold;}
.hdr-badge .type-t{color:var(--tai);}
.hdr-badge .type-x{color:var(--xiu);}
.metrics-row{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px;}
.metric-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;position:relative;overflow:hidden;}
.metric-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent,var(--gold));}
.metric-label{font-size:.60rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;}
.metric-val{font-size:1.5rem;font-weight:700;font-family:var(--mono);color:var(--accent,var(--gold-lite));line-height:1;}
.metric-sub{font-size:.62rem;color:var(--text-dim);margin-top:3px;}
.chart-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;}
.chart-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-dim);margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.bead-section{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;}
.bead-road{display:flex;flex-wrap:wrap;gap:5px;padding:6px 0;}
.bead{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.68rem;font-weight:700;position:relative;}
.bead-t{background:radial-gradient(circle at 35% 30%,#ffe060,#c8900a,#7a4f00);color:#fff5cc;box-shadow:0 0 6px rgba(200,150,10,0.50);}
.bead-x{background:radial-gradient(circle at 35% 30%,#c490ff,#7820ef,#3a0090);color:#e8d8ff;box-shadow:0 0 6px rgba(130,60,255,0.50);}
.bead-new::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid #fff;opacity:0.6;animation:blink 1s ease-in-out infinite;}
@keyframes blink{0%,100%{opacity:0.2}50%{opacity:0.8}}
.vote-wrap{margin:8px 0 4px;}
.vote-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.05);}
.vote-t{background:linear-gradient(90deg,#c8800a,#f5c842);}
.vote-x{background:linear-gradient(90deg,#6010c0,#a070ff);}
.vote-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:.72rem;margin-top:4px;}
.pred-row{display:grid;grid-template-columns:180px 1fr;gap:10px;margin-bottom:10px;}
.pred-main{background:${predBg};border:2px solid ${predColor};border-radius:12px;padding:16px;text-align:center;box-shadow:0 0 20px ${predColor}30;}
.pred-label{font-size:.62rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;}
.pred-val{font-size:3rem;font-weight:700;color:${predColor};text-shadow:0 0 20px ${predColor};line-height:1.1;margin:4px 0;}
.pred-conf{font-family:var(--mono);font-size:1rem;color:#fff;margin-top:2px;}
.conf-track{height:5px;background:rgba(255,255,255,0.1);border-radius:3px;margin:6px 0;overflow:hidden;}
.conf-fill{height:100%;border-radius:3px;background:${predColor};width:${pred.conf}%;}
.backtest-badge{display:inline-block;font-family:var(--mono);font-size:.65rem;padding:2px 8px;
  border-radius:4px;background:rgba(100,220,100,0.12);border:1px solid rgba(100,220,100,0.25);
  color:#80dd80;margin-top:6px;}
.signals-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;overflow:hidden;}
.signals-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);margin-bottom:6px;display:flex;justify-content:space-between;}
.sig-table{width:100%;border-collapse:collapse;font-size:.68rem;}
.sig-table th{color:var(--text-dim);padding:3px 5px;border-bottom:1px solid var(--border);text-align:left;font-weight:400;font-size:.60rem;text-transform:uppercase;}
.sig-table td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:top;}
.src-td{color:#8a6a30;font-family:var(--mono);font-size:.64rem;white-space:nowrap;}
.sig-t{color:var(--tai);font-weight:700;white-space:nowrap;}
.sig-x{color:var(--xiu);font-weight:700;white-space:nowrap;}
.wr-td{font-family:var(--mono);font-size:.72rem;color:#88cc88;text-align:right;white-space:nowrap;}
.n-td{font-family:var(--mono);font-size:.64rem;color:#666;text-align:right;}
.detail-td{color:#7a6040;font-size:.63rem;line-height:1.3;}
.algo-note{background:rgba(100,200,100,0.05);border:1px solid rgba(100,200,100,0.15);border-radius:8px;
  padding:8px 12px;margin-bottom:10px;font-size:.70rem;color:#80bb80;line-height:1.6;}
/* Chart Pattern DB styles */
.pattern-db{background:var(--bg2);border:1px solid rgba(100,200,150,0.25);border-radius:10px;padding:12px;margin-bottom:10px;}
.pattern-db-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1.5px;color:#60bb90;margin-bottom:10px;display:flex;align-items:center;gap:8px;justify-content:space-between;}
.db-stats{display:flex;gap:12px;font-family:var(--mono);font-size:.72rem;}
.db-stat{background:rgba(100,200,150,0.08);border:1px solid rgba(100,200,150,0.18);border-radius:5px;padding:4px 10px;}
.db-stat .v{color:#66ddaa;font-weight:bold;}
.shape-badge{display:flex;align-items:center;gap:10px;background:rgba(100,200,150,0.08);
  border:1px solid rgba(100,200,150,0.20);border-radius:8px;padding:8px 12px;margin-bottom:10px;
  font-size:.72rem;color:#90cca8;}
.shape-icon{font-size:1.2rem;}
.shape-match{font-family:var(--mono);font-size:.65rem;color:#50aa70;margin-left:auto;}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;}
.chart-canvas-wrap{position:relative;}
@media(max-width:620px){.metrics-row{grid-template-columns:repeat(3,1fr)}.pred-row{grid-template-columns:1fr}.two-col{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v9 — SUNWIN ⬦</div>
  <div class="hdr-badge">
    <span>Phiên <span class="val">#${h.phien}</span></span>
    <span class="${h.type==='T'?'type-t':'type-x'} val">${h.type==='T'?'Tài':'Xỉu'}</span>
    <span>${h.dice.join('·')}</span>
    <span>Σ <span class="val">${h.tong}</span></span>
    <span style="color:#555">${new Date().toLocaleTimeString('vi-VN')}</span>
  </div>
</div>

<div class="algo-note">
  ⚡ <strong>v9 — Chart Pattern Recognition:</strong> Tự động trích xuất hình dạng đồ thị, lưu thành khuôn mẫu, so khớp với lịch sử.
  Hiện có <strong>${pred.signalCount}</strong> signal hợp lệ · Kho mẫu: <strong style="color:#88ddaa">${db.total}</strong> mẫu.
  Backtest 30 phiên: <strong style="color:#aaffaa">${btWR}%</strong>.
</div>

${shapeInfoHTML}

<div class="metrics-row">
  <div class="metric-card" style="--accent:${predColor}">
    <div class="metric-label">Dự Đoán</div>
    <div class="metric-val">${pred.nextDisplay}</div>
    <div class="metric-sub">Phiên #${Number(h.phien)+1}</div>
  </div>
  <div class="metric-card" style="--accent:#44aaff">
    <div class="metric-label">Confidence</div>
    <div class="metric-val">${pred.conf}%</div>
    <div class="metric-sub">${pred.signalCount} signals</div>
  </div>
  <div class="metric-card" style="--accent:#88cc88">
    <div class="metric-label">Backtest WR</div>
    <div class="metric-val">${btWR}%</div>
    <div class="metric-sub">${btTotal} phiên test</div>
  </div>
  <div class="metric-card" style="--accent:#ff9944">
    <div class="metric-label">Cầu Hiện Tại</div>
    <div class="metric-val">${pred.streak}</div>
    <div class="metric-sub">${pred.curType==='T'?'Tài':'Xỉu'} liên tiếp</div>
  </div>
  <div class="metric-card" style="--accent:var(--chart-green)">
    <div class="metric-label">Khuôn Mẫu</div>
    <div class="metric-val">${db.total}</div>
    <div class="metric-sub">mẫu đồ thị</div>
  </div>
</div>

<div class="bead-section">
  <div class="chart-title">⬤ Cầu Hạt — 25 Phiên | Chuỗi: <span style="color:var(--gold-lite);margin-left:6px;font-family:var(--mono)" id="patStr"></span></div>
  <div class="bead-road" id="beadRoad"></div>
</div>

<div class="chart-wrap" style="padding:12px 14px">
  <div class="chart-title">⚖ Phân Bổ Win-Rate Signals</div>
  <div class="vote-wrap">
    <div class="vote-bar">
      <div class="vote-t" style="width:${pctT}%"></div>
      <div class="vote-x" style="width:${pctX}%"></div>
    </div>
    <div class="vote-labels">
      <span style="color:var(--tai)">▲ Tài ${pctT}% (${pred.votesT})</span>
      <span style="color:var(--xiu)">▼ Xỉu ${pctX}% (${pred.votesX})</span>
    </div>
  </div>
</div>

<div class="two-col">
  <div class="chart-wrap" style="margin-bottom:0">
    <div class="chart-title">📈 Biểu Đồ Tổng + Bollinger Band</div>
    <canvas id="sumChart" height="220"></canvas>
  </div>
  <div class="chart-wrap" style="margin-bottom:0">
    <div class="chart-title">📊 Hình Dạng Đồ Thị (Chuẩn Hóa)</div>
    <canvas id="shapeChart" height="220"></canvas>
  </div>
</div>

<div class="pattern-db" style="margin-top:10px">
  <div class="pattern-db-title">
    <span>🗂 Kho Khuôn Mẫu Đồ Thị</span>
    <div class="db-stats">
      <div class="db-stat">Tổng: <span class="v">${db.total}</span></div>
      <div class="db-stat">Hình dạng: <span class="v">${Object.keys(db.shapeCounts||{}).length}</span></div>
    </div>
  </div>
  <div style="overflow-x:auto">
  <table class="sig-table">
    <thead><tr><th>#</th><th>Tên Mẫu</th><th>Dự Đoán</th><th>WR%</th><th>Lần Gặp</th></tr></thead>
    <tbody>${topPatternsHTML}</tbody>
  </table>
  </div>
</div>

<div class="pred-row">
  <div class="pred-main">
    <div class="pred-label">Phiên Tiếp Theo</div>
    <div style="font-size:.7rem;color:var(--text-dim)">#${Number(h.phien)+1}</div>
    <div class="pred-val">${pred.nextDisplay}</div>
    <div class="conf-track"><div class="conf-fill"></div></div>
    <div class="pred-conf">${pred.conf}%</div>
    <div class="backtest-badge">Backtest: ${btWR}% / ${btTotal} phiên</div>
  </div>
  <div class="signals-wrap">
    <div class="signals-title">
      <span>${pred.signalCount} tín hiệu đã qua backtest (WR &gt; 52%)</span>
    </div>
    <div style="max-height:300px;overflow-y:auto;">
    <table class="sig-table">
      <thead><tr><th>Thuật Toán</th><th>Signal</th><th>WR%</th><th>N</th><th>Chi Tiết</th></tr></thead>
      <tbody>${sigRows}</tbody>
    </table>
    </div>
  </div>
</div>

<script>
Chart.register(window['chartjs-plugin-annotation']);
const LABELS   = ${labels};
const SUM_DATA = ${sumData};
const TYPE_DATA = ${typeData};
const N = SUM_DATA.length;
const BOLL_UP  = ${bolUp};
const BOLL_MID = ${bolMid};
const BOLL_LOW = ${bolLow};

// Bead road
const beadEl = document.getElementById('beadRoad');
document.getElementById('patStr').textContent = [...TYPE_DATA].join('');
[...TYPE_DATA].forEach((t,i) => {
  const b = document.createElement('div');
  b.className = 'bead bead-'+(t==='T'?'t':'x')+(i===TYPE_DATA.length-1?' bead-new':'');
  b.textContent = t;
  beadEl.appendChild(b);
});

// Numbered point plugin
const numberedPts = {
  id: 'numberedPts',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(3);
    if (!meta) return;
    meta.data.forEach((pt, i) => {
      const val = SUM_DATA[i];
      if (val == null) return;
      const isTai = val >= 11, R = 14;
      ctx.save();
      ctx.beginPath(); ctx.arc(pt.x+1.5, pt.y+2, R, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill(); ctx.restore();
      const g = ctx.createRadialGradient(pt.x-R*.3, pt.y-R*.35, R*.05, pt.x, pt.y, R);
      if (isTai) { g.addColorStop(0,'#ffe060'); g.addColorStop(.45,'#c8900a'); g.addColorStop(1,'#7a4f00'); }
      else        { g.addColorStop(0,'#c490ff'); g.addColorStop(.45,'#7820ef'); g.addColorStop(1,'#2a0060'); }
      ctx.save();
      ctx.beginPath(); ctx.arc(pt.x, pt.y, R, 0, Math.PI*2);
      ctx.fillStyle=g; ctx.fill();
      ctx.strokeStyle = isTai ? '#f5c842' : '#a070ff';
      ctx.lineWidth=1.8; ctx.stroke(); ctx.restore();
      ctx.save();
      ctx.fillStyle='#fff'; ctx.font='bold 10px Share Tech Mono,monospace';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.shadowColor='rgba(0,0,0,0.8)'; ctx.shadowBlur=3;
      ctx.fillText(val, pt.x, pt.y); ctx.restore();
    });
  }
};

new Chart(document.getElementById('sumChart').getContext('2d'), {
  type: 'line',
  plugins: [numberedPts],
  data: { labels: LABELS, datasets: [
    { label:'BB Upper', data: Array(N).fill(BOLL_UP),
      borderColor:'rgba(100,180,255,0.22)', borderWidth:1, borderDash:[3,4],
      pointRadius:0, fill:false, tension:0, order:10 },
    { label:'BB Lower', data: Array(N).fill(BOLL_LOW),
      borderColor:'rgba(100,180,255,0.22)', borderWidth:1, borderDash:[3,4],
      pointRadius:0,
      fill: { target:'-1', above:'rgba(100,180,255,0.05)', below:'rgba(100,180,255,0.05)' },
      tension:0, order:10 },
    { label:'BB Mid', data: Array(N).fill(BOLL_MID),
      borderColor:'rgba(100,180,255,0.13)', borderWidth:1, borderDash:[6,5],
      pointRadius:0, fill:false, tension:0, order:10 },
    { label:'Tổng', data: SUM_DATA,
      borderColor:'rgba(210,175,80,0.75)', borderWidth:2.5,
      pointRadius:16, pointHoverRadius:18,
      pointBackgroundColor: SUM_DATA.map(v => v>=11?'#b07800':'#5010a0'),
      pointBorderColor: SUM_DATA.map(v => v>=11?'#f5c842':'#a070ff'),
      pointBorderWidth:2, tension:0, fill:false, order:0 }
  ]},
  options: {
    responsive:true, animation:{duration:500},
    layout:{padding:{top:18,bottom:6,left:4,right:4}},
    scales: {
      y: { min:3, max:18,
           ticks:{color:'#9a7040',stepSize:3,font:{size:11,family:'Share Tech Mono'}},
           grid:{color:'rgba(160,110,30,0.14)'} },
      x: { ticks:{color:'#8a6030',maxTicksLimit:15,font:{size:9,family:'Share Tech Mono'}},
           grid:{color:'rgba(160,110,30,0.08)'} }
    },
    plugins: {
      legend:{display:false},
      annotation:{annotations:{
        mid:{type:'line',scaleID:'y',value:10.5,borderColor:'rgba(255,255,255,0.10)',borderWidth:1,borderDash:[6,5]},
        taiZ:{type:'box',scaleID:'y',yMin:11,yMax:18,backgroundColor:'rgba(245,200,66,0.03)',borderWidth:0},
        xiuZ:{type:'box',scaleID:'y',yMin:3,yMax:10.5,backgroundColor:'rgba(160,112,255,0.03)',borderWidth:0},
      }},
      tooltip:{
        backgroundColor:'rgba(10,8,4,0.95)',titleColor:'#ffd700',bodyColor:'#f0d0a0',
        callbacks:{label:ctx => {
          const v=ctx.parsed.y;
          if(ctx.dataset.label!=='Tổng') return ctx.dataset.label+': '+v.toFixed(1);
          return 'Tổng: '+v+' → '+(v>=11?'🟡 Tài':'🟣 Xỉu');
        }}
      }
    }
  }
});

// Shape Chart: hiển thị chuỗi chuẩn hóa 10 phiên gần nhất
(function() {
  const raw = SUM_DATA.slice(-10);
  if (raw.length < 2) return;
  const m = raw.reduce((s,v)=>s+v,0)/raw.length;
  const sd = Math.sqrt(raw.reduce((s,v)=>s+(v-m)**2,0)/raw.length) || 1;
  const norm = raw.map(v => (v - m) / sd);
  const shapeLabels = raw.map((_,i) => String(i+1));

  new Chart(document.getElementById('shapeChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: shapeLabels,
      datasets: [{
        label: 'Hình Dạng (Z-score)',
        data: norm,
        borderColor: 'rgba(100,220,150,0.85)',
        borderWidth: 2.5,
        pointRadius: norm.map((v,i) => i === norm.length-1 ? 8 : 5),
        pointBackgroundColor: norm.map((v,i) => {
          if (i === norm.length-1) return '#44ff88';
          return v >= 0 ? 'rgba(245,200,66,0.8)' : 'rgba(160,112,255,0.8)';
        }),
        pointBorderColor: '#333',
        pointBorderWidth: 1,
        tension: 0.35,
        fill: { target: 'origin', above: 'rgba(245,200,66,0.07)', below: 'rgba(160,112,255,0.07)' }
      }]
    },
    options: {
      responsive:true, animation:{duration:600},
      layout:{padding:{top:12,bottom:6}},
      scales: {
        y: { ticks:{color:'#6a8a70',font:{size:10,family:'Share Tech Mono'}},
             grid:{color:'rgba(100,200,120,0.10)'},
             title:{display:true,text:'Z-score',color:'#507050',font:{size:10}} },
        x: { ticks:{color:'#507050',font:{size:10,family:'Share Tech Mono'}},
             grid:{color:'rgba(100,200,120,0.06)'},
             title:{display:true,text:'Phiên (cũ→mới)',color:'#507050',font:{size:10}} }
      },
      plugins:{
        legend:{display:false},
        annotation:{annotations:{
          zero:{type:'line',scaleID:'y',value:0,borderColor:'rgba(255,255,255,0.15)',borderWidth:1,borderDash:[4,4]},
          pos1:{type:'line',scaleID:'y',value:1,borderColor:'rgba(245,200,66,0.20)',borderWidth:1,borderDash:[2,4]},
          neg1:{type:'line',scaleID:'y',value:-1,borderColor:'rgba(160,112,255,0.20)',borderWidth:1,borderDash:[2,4]},
        }},
        tooltip:{
          backgroundColor:'rgba(10,20,12,0.95)',
          callbacks:{label:ctx=>{ const v=ctx.parsed.y; return 'Z: '+(v>=0?'+':'')+v.toFixed(2)+' ('+(v>=0?'Tài':'Xỉu')+')'; }}
        }
      }
    }
  });
})();

setTimeout(() => location.reload(), 12000);
<\/script>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════
//  HTTP SERVER
// ════════════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") { res.writeHead(204, {"Access-Control-Allow-Origin":"*"}); res.end(); return; }
  await syncHistory();

  if (url.pathname === "/bando") {
    if (!history.length) { res.writeHead(503,{"Content-Type":"text/plain;charset=utf-8"}); res.end("Chưa có dữ liệu"); return; }
    const h = history[0];
    const pred = predictV9(history);
    res.writeHead(200, {"Content-Type":"text/html;charset=utf-8"});
    res.end(buildHTML(pred, h)); return;
  }

  if (url.pathname === "/sunlon") {
    if (!history.length) { res.writeHead(503,{"Content-Type":"application/json"}); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const h = history[0], pred = predictV9(history);
    const pattern = history.slice(0,20).map(x=>x.type).reverse().join("");
    res.writeHead(200,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({
      phien: h.phien, xuc_xac: h.dice, ket_qua: h.type==="T"?"Tài":"Xỉu",
      phien_hien_tai: String(Number(h.phien)+1), du_doan: pred.nextDisplay,
      do_tin_cay: pred.confDisplay, backtest_wr: pred.backtest?.wr ?? null,
      signal_count: pred.signalCount, pattern,
      current_shape: pred.currentShape,
      pattern_db_size: pred.patternDBStats.total,
      ver: "v9"
    })); return;
  }

  res.setHeader("Content-Type","application/json;charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");

  if (url.pathname === "/" || url.pathname === "/predict") {
    if (!history.length) { res.writeHead(503); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const h = history[0], pred = predictV9(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: h.phien, xuc_xac: h.dice, tong_hien_tai: h.tong,
      ket_qua_hien: h.type==="T"?"Tài":"Xỉu", phien_du_doan: String(Number(h.phien)+1),
      du_doan: pred.nextDisplay, do_tin_cay: pred.confDisplay,
      backtest_winrate: pred.backtest?.wr ?? null,
      signal_count: pred.signalCount,
      current_shape: pred.currentShape,
      pattern_db_size: pred.patternDBStats.total,
      ver: "v9"
    })); return;
  }

  if (url.pathname === "/predict/detail") {
    if (!history.length) { res.writeHead(503); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const pred = predictV9(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan: pred.nextDisplay, do_tin_cay: pred.confDisplay,
      backtest: pred.backtest, signals: pred.signals,
      pattern20: pred.pattern20, streak: pred.streak,
      chart_signal: pred.chartSignal,
      pattern_db: pred.patternDBStats,
      ver: "v9"
    })); return;
  }

  if (url.pathname === "/patterns") {
    res.writeHead(200);
    res.end(JSON.stringify(getPatternDBStats(), null, 2)); return;
  }

  if (url.pathname === "/history") {
    const lim = Math.min(parseInt(url.searchParams.get("limit")||"20"), 200);
    res.writeHead(200);
    res.end(JSON.stringify({
      tong_so: history.length,
      du_lieu: history.slice(0,lim).map(h => ({phien:h.phien,xuc_xac:h.dice,tong:h.tong,ket_qua:h.type==="T"?"Tài":"Xỉu"}))
    })); return;
  }

  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e=>({loi:e.message}));
    res.writeHead(200); res.end(JSON.stringify(r,null,2)); return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    loi:"Không tìm thấy",
    endpoints:["/predict","/predict/detail","/history","/bando","/sunlon","/patterns","/debug"],
    ver:"v9"
  }));

}).listen(PORT, () => {
  console.log("✅  SicBo v9.0 — Chart Pattern Recognition Engine — port " + PORT);
  console.log("    Dashboard : http://localhost:" + PORT + "/bando");
  console.log("    Patterns  : http://localhost:" + PORT + "/patterns");
  console.log("    Algorithms: Markov(1/2/3) · Cầu Bệt · Cầu 1-1 · Cầu N-N · 5-gram · Dice Balance · Chart Pattern");
  console.log("    Chart Pattern: Z-score normalization · Pearson correlation · Shape fingerprinting");
  syncHistory();
  setInterval(syncHistory, 12000);
});
