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
//  Mỗi thuật toán tự đánh giá win rate trên lịch sử trước khi vote.
//  Chỉ những thuật toán có win rate > MIN_WIN_RATE mới được vote.
// ════════════════════════════════════════════════════════════════════
const MIN_WIN_RATE = 0.52;  // ngưỡng tối thiểu để signal được tính
const MIN_SAMPLE   = 8;     // số mẫu backtest tối thiểu

// ── 1. MARKOV CHAIN với LAPLACE SMOOTHING ────────────────────────
// Xây bảng xác suất P(next | state) cho state dài 1-4
// Laplace smoothing tránh overfit khi sample nhỏ
function buildMarkovTable(typeSeq, order) {
  const counts = {};
  for (let i = order; i < typeSeq.length; i++) {
    // typeSeq[0] = newest → đọc ngược: oldest first
    const key = typeSeq.slice(i - order, i).reverse().join(""); // oldest→newest
    const next = typeSeq[i - order - 1]; // nhãn kết quả tiếp theo (về phía newer)
    if (!next) continue;
    if (!counts[key]) counts[key] = { T: 0, X: 0 };
    counts[key][next]++;
  }
  return counts;
}

function predictMarkov(typeSeq, order) {
  if (typeSeq.length < order + MIN_SAMPLE) return null;
  const table = buildMarkovTable(typeSeq, order);
  // state hiện tại = order phiên gần nhất (newest first → reverse)
  const curState = typeSeq.slice(0, order).reverse().join("");
  const c = table[curState];
  if (!c) return null;
  const alpha = 0.5; // Laplace smoothing
  const pT = (c.T + alpha) / (c.T + c.X + 2 * alpha);
  const pX = 1 - pT;
  // Backtest: kiểm tra win rate thực của prediction này trong lịch sử
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
    signal: pred,
    winRate: wr,
    conf: 0.50 + (wr - 0.50) * 1.2,
    detail: `Markov-${order} [${curState}] WR=${(wr*100).toFixed(0)}% (${total} mẫu)`,
    source: `Markov-${order}`,
    sampleCount: total
  };
}

// ── 2. PHÂN TÍCH CẦU BỆT (streak) ───────────────────────────────
// Đo xem sau chuỗi N cùng loại thì kết quả tiếp theo thường là gì
function analyzeStreakCau(typeSeq) {
  if (typeSeq.length < 10) return null;
  const cur = typeSeq[0];
  let streak = 1;
  for (let i = 1; i < typeSeq.length; i++) {
    if (typeSeq[i] === cur) streak++;
    else break;
  }
  if (streak < 2) return null;

  // Backtest: tìm các lần xuất hiện chuỗi dài y hệt trong lịch sử
  let breakWins = 0, contWins = 0, total = 0;
  for (let i = streak + 1; i < typeSeq.length - 1; i++) {
    // tìm chuỗi streak liên tiếp ending tại i
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

// ── 3. CẦU 1-1 XEN KẼ (alternating) ─────────────────────────────
function analyzeAlternating(typeSeq) {
  if (typeSeq.length < 8) return null;
  // Đo độ dài chuỗi xen kẽ hiện tại
  let altLen = 1;
  for (let i = 1; i < Math.min(typeSeq.length, 20); i++) {
    if (typeSeq[i] !== typeSeq[i-1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;
  const expected = typeSeq[0] === "T" ? "X" : "T";

  // Backtest: sau chuỗi alt >= altLen thì tiếp tục hay không?
  let wins = 0, total = 0;
  for (let i = altLen + 1; i < typeSeq.length - 1; i++) {
    // kiểm tra có chuỗi alt kết thúc tại i không
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

// ── 4. CẦU ĐỐI XỨNG (block N-N) ─────────────────────────────────
function analyzeSymmetric(typeSeq) {
  if (typeSeq.length < 12) return null;
  for (const bk of [2, 3, 4]) {
    // Xác định vị trí trong block hiện tại
    const cur = typeSeq[0];
    let posInBlock = 0;
    for (let i = 0; i < typeSeq.length; i++) {
      if (typeSeq[i] === cur) posInBlock++;
      else break;
    }
    // Xác nhận block trước đó
    let prevBlockLen = 0;
    let i = posInBlock;
    const prevType = typeSeq[i];
    for (; i < typeSeq.length; i++) {
      if (typeSeq[i] === prevType) prevBlockLen++;
      else break;
    }
    if (prevBlockLen !== bk) continue; // block trước không đúng kích thước

    const predicted = posInBlock >= bk ? (cur === "T" ? "X" : "T") : cur;

    // Backtest N-N pattern
    let wins = 0, total = 0;
    let idx = 0;
    while (idx < typeSeq.length - bk * 2 - 2) {
      // Tìm block A dài bk
      const A = typeSeq[idx];
      let lenA = 0;
      let j = idx;
      for (; j < typeSeq.length && typeSeq[j] === A; j++) lenA++;
      if (lenA !== bk) { idx = j + 1; continue; }
      // Block B sau A
      const B = typeSeq[j];
      if (B === A) { idx = j + 1; continue; }
      let lenB = 0;
      let k = j;
      for (; k < typeSeq.length && typeSeq[k] === B; k++) lenB++;
      if (lenB !== bk) { idx = k + 1; continue; }
      // Phiên tiếp theo sau BB là gì?
      const next = typeSeq[k - 1]; // về phía newer (index nhỏ hơn)
      if (k - 1 >= 0) {
        // Sau BB block thường tiếp tục B hay đổi về A?
        const pred2 = A; // dự đoán quay về A (đối xứng)
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

// ── 5. PHÂN TÍCH XÚC XẮC: cân bằng thống kê ────────────────────
// Tổng xúc xắc tuân theo phân phối xác suất biết trước.
// Nếu một số bị thiếu lâu, nó có xu hướng xuất hiện lại.
function analyzeDiceBalance(hist) {
  if (hist.length < 20) return null;
  const recent = hist.slice(0, 30);
  // Đếm tần suất từng tổng (3-18)
  const freqActual = {};
  for (let v = 3; v <= 18; v++) freqActual[v] = 0;
  recent.forEach(h => freqActual[Math.round(h.tong)]++);

  // Tỉ lệ lý thuyết của Tài (11-18) vs Xỉu (3-10): gần 50/50 (thực ra 105/111 cho 3xúc)
  const countT = recent.filter(h => h.type === "T").length;
  const countX = recent.length - countT;
  const ratioT = countT / recent.length;

  // Backtest: sau khi Tài chiếm > 60% trong 20 phiên, 20 phiên tiếp theo thường Xỉu nhiều hơn?
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

// ── 6. PATTERN 5-MER (5-gram fingerprint) ───────────────────────
function analyzePattern5(typeSeq) {
  if (typeSeq.length < 20) return null;
  const W = 5;
  const cur = typeSeq.slice(0, W).join("");
  let wins = 0, total = 0;
  for (let i = W; i < typeSeq.length - 1; i++) {
    const pat = typeSeq.slice(i, i + W).join("");
    if (pat !== cur) continue;
    const predicted = "T"; // placeholder, sẽ tính real distribution
    const actual = typeSeq[i - 1];
    // collect distribution
    total++; // count hits
    if (actual === "T") wins++;
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

// ── 7. BAYESIAN ENSEMBLE ─────────────────────────────────────────
// Kết hợp các signal theo win rate thực tế (không phải trọng số cố định)
// Log-odds aggregation: tránh vấn đề xác suất nhân nhau
function bayesianEnsemble(signals) {
  if (!signals.length) return { pred: "?", prob: 0.50, logOdds: 0 };
  // Prior: 50/50
  let logOdds = 0;
  for (const s of signals) {
    const wr = Math.min(Math.max(s.winRate, 0.50), 0.85); // clamp
    const lr = s.signal === "T"
      ? Math.log(wr / (1 - wr))
      : Math.log((1-wr) / wr);
    // Weight theo sample count (nhiều mẫu = tin hơn)
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

// ── 8. CALIBRATED CONFIDENCE ─────────────────────────────────────
// Compress confidence vào range thực tế [0.50, 0.78]
// Tránh việc hiển thị 95% khi thực tế chỉ đúng 58%
function calibrateConf(rawProb) {
  // Platt scaling-inspired: map logit space về range thực
  const clipped = Math.min(Math.max(rawProb, 0.50), 0.95);
  return 0.50 + (clipped - 0.50) * 0.65; // tối đa ~79%
}

// ── BACKTEST ENGINE: đo win rate tổng của predictor ─────────────
function backtestPredictor(hist, windowSize = 30) {
  if (hist.length < windowSize + 10) return null;
  let wins = 0, total = 0;
  for (let i = 1; i <= Math.min(30, hist.length - windowSize - 1); i++) {
    // Dùng hist[i..i+windowSize] để dự đoán hist[i-1]
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

// ── COLLECT ALL SIGNALS ──────────────────────────────────────────
function collectSignals(typeSeq, hist) {
  const signals = [];
  const add = (r) => { if (r) signals.push(r); };

  // Markov chains bậc 1, 2, 3
  add(predictMarkov(typeSeq, 1));
  add(predictMarkov(typeSeq, 2));
  add(predictMarkov(typeSeq, 3));

  // Cầu patterns
  add(analyzeStreakCau(typeSeq));
  add(analyzeAlternating(typeSeq));
  add(analyzeSymmetric(typeSeq));
  add(analyzePattern5(typeSeq));

  // Dice balance
  if (hist) add(analyzeDiceBalance(hist));

  return signals;
}

// ════════════════════════════════════════════════════════════════════
//  MAIN PREDICTOR v8
// ════════════════════════════════════════════════════════════════════
function predictV8(hist) {
  if (hist.length < 10) {
    return {
      next: "?", nextDisplay: "Chưa đủ dữ liệu", conf: 50, confDisplay: "50%",
      signals: [], backtest: null, typeSeq: []
    };
  }

  const typeSeq = hist.map(h => h.type);
  const signals = collectSignals(typeSeq, hist);
  const { pred, prob } = bayesianEnsemble(signals);
  const conf = calibrateConf(prob);
  const backtest = backtestPredictor(hist, 30);

  // Cầu summary
  const curType = typeSeq[0];
  let streak = 0;
  for (const t of typeSeq) { if (t === curType) streak++; else break; }

  // Pattern display (20 phiên gần nhất)
  const pattern20 = typeSeq.slice(0, 20).join("");

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
    streak,
    curType,
    pattern20,
    votesT: signals.filter(s => s.signal === "T").reduce((s, r) => s + r.winRate, 0).toFixed(2),
    votesX: signals.filter(s => s.signal === "X").reduce((s, r) => s + r.winRate, 0).toFixed(2),
  };
}

// ════════════════════════════════════════════════════════════════════
//  HTML BUILDER v8
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
    return `<tr>
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

  // Bollinger
  const sumArr = pred.sumChart;
  const bolMid = parseFloat(mean(sumArr).toFixed(2));
  const bolSd  = parseFloat(stdDev(sumArr).toFixed(2));
  const bolUp  = parseFloat((bolMid + 2 * bolSd).toFixed(2));
  const bolLow = parseFloat((bolMid - 2 * bolSd).toFixed(2));

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v8 — SUNWIN</title>
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
@media(max-width:620px){.metrics-row{grid-template-columns:repeat(3,1fr)}.pred-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v8 — SUNWIN ⬦</div>
  <div class="hdr-badge">
    <span>Phiên <span class="val">#${h.phien}</span></span>
    <span class="${h.type==='T'?'type-t':'type-x'} val">${h.type==='T'?'Tài':'Xỉu'}</span>
    <span>${h.dice.join('·')}</span>
    <span>Σ <span class="val">${h.tong}</span></span>
    <span style="color:#555">${new Date().toLocaleTimeString('vi-VN')}</span>
  </div>
</div>

<div class="algo-note">
  ⚡ <strong>v8 — Self-Backtesting Engine:</strong> Mỗi signal chỉ được kích hoạt nếu win rate thực &gt; 52% trên dữ liệu lịch sử.
  Hiện có <strong>${pred.signalCount}</strong> signal hợp lệ.
  Backtest 30 phiên gần nhất: <strong style="color:#aaffaa">${btWR}%</strong> (${btTotal} lần kiểm tra).
  Confidence được hiệu chỉnh (calibrated) — không phóng đại.
</div>

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
  <div class="metric-card" style="--accent:#44ff88">
    <div class="metric-label">Tổng Hiện Tại</div>
    <div class="metric-val">${h.tong}</div>
    <div class="metric-sub">${h.dice.join('·')}</div>
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

<div class="chart-wrap">
  <div class="chart-title">📈 Biểu Đồ Tổng + Bollinger Band</div>
  <canvas id="sumChart" height="200"></canvas>
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
const D1_DATA  = ${d1Data};
const D2_DATA  = ${d2Data};
const D3_DATA  = ${d3Data};
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
    const pred = predictV8(history);
    res.writeHead(200, {"Content-Type":"text/html;charset=utf-8"});
    res.end(buildHTML(pred, h)); return;
  }

  if (url.pathname === "/sunlon") {
    if (!history.length) { res.writeHead(503,{"Content-Type":"application/json"}); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const h = history[0], pred = predictV8(history);
    const pattern = history.slice(0,20).map(x=>x.type).reverse().join("");
    res.writeHead(200,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({
      phien: h.phien, xuc_xac: h.dice, ket_qua: h.type==="T"?"Tài":"Xỉu",
      phien_hien_tai: String(Number(h.phien)+1), du_doan: pred.nextDisplay,
      do_tin_cay: pred.confDisplay, backtest_wr: pred.backtest?.wr ?? null,
      signal_count: pred.signalCount, pattern, ver: "v8"
    })); return;
  }

  res.setHeader("Content-Type","application/json;charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");

  if (url.pathname === "/" || url.pathname === "/predict") {
    if (!history.length) { res.writeHead(503); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const h = history[0], pred = predictV8(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: h.phien, xuc_xac: h.dice, tong_hien_tai: h.tong,
      ket_qua_hien: h.type==="T"?"Tài":"Xỉu", phien_du_doan: String(Number(h.phien)+1),
      du_doan: pred.nextDisplay, do_tin_cay: pred.confDisplay,
      backtest_winrate: pred.backtest?.wr ?? null,
      signal_count: pred.signalCount, ver: "v8"
    })); return;
  }

  if (url.pathname === "/predict/detail") {
    if (!history.length) { res.writeHead(503); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const pred = predictV8(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan: pred.nextDisplay, do_tin_cay: pred.confDisplay,
      backtest: pred.backtest, signals: pred.signals,
      pattern20: pred.pattern20, streak: pred.streak, ver: "v8"
    })); return;
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
  res.end(JSON.stringify({loi:"Không tìm thấy", endpoints:["/predict","/predict/detail","/history","/bando","/sunlon","/debug"], ver:"v8"}));

}).listen(PORT, () => {
  console.log("✅  SicBo v8.0 — Self-Backtesting Engine — port " + PORT);
  console.log("    Dashboard : http://localhost:" + PORT + "/bando");
  console.log("    Algorithms: Markov(1/2/3) · Cầu Bệt · Cầu 1-1 · Cầu N-N · 5-gram · Dice Balance");
  console.log("    All signals validated by backtest (WR > 52% required)");
  syncHistory();
  setInterval(syncHistory, 12000);
});
