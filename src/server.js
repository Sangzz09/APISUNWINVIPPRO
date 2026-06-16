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
//  signal: "T" | "X"
//  winRate: tỷ lệ thắng thực tế trên lịch sử [0..1]
//  sampleCount: số mẫu backtest
//  source: tên thuật toán
//  detail: mô tả chi tiết
// ═══════════════════════════════════════════════
const MIN_WIN_RATE = 0.52;
const MIN_SAMPLES  = 8;

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 1: MARKOV CHAIN
//  Ý tưởng: Dựa vào trạng thái hiện tại (chuỗi order phiên gần nhất)
//  để dự đoán phiên tiếp theo.
//
//  Cấu trúc dữ liệu: history[0] = mới nhất, history[N-1] = cũ nhất
//  seq[0] = kết quả phiên mới nhất
//
//  Để xây bảng Markov:
//    Với mỗi vị trí i (0-indexed, mới→cũ):
//      state = seq[i..i+order-1] (i=0 là mới nhất)
//      outcome = seq[i+order] = kết quả phiên TRƯỚC state đó (cũ hơn 1 bước)
//    => Tức là: biết "order phiên vừa xong", dự đoán "phiên tiếp theo"
//    Nhưng history đang sắp xếp mới→cũ, nên "phiên tiếp theo" (trong tương lai)
//    tương ứng với index nhỏ hơn.
//
//  Dự đoán phiên tiếp theo:
//    state hiện tại = seq[0..order-1]
//    tra bảng → kết quả phổ biến nhất
//
//  Backtest tại vị trí i (i >= order):
//    state = seq[i..i+order-1]
//    thực tế kết quả tiếp theo (phiên mới hơn) = seq[i-1]  (vì i-1 < i)
// ═══════════════════════════════════════════════
function markov(seq, order) {
  // seq: mảng "T"/"X", seq[0]=mới nhất
  // Cần ít nhất: order (state) + 1 (outcome) + MIN_SAMPLES (backtest)
  if (seq.length < order + 1 + MIN_SAMPLES) return null;

  // Xây bảng: key = state string (order ký tự, chiều mới→cũ), value = {T,X}
  const table = {};
  // Duyệt từ i = order đến length-1
  // state = seq[i-order .. i-1] (chỉ số i-order = cũ hơn, i-1 = gần hơn)
  // => state string đọc theo chiều mới→cũ: seq[i-1], seq[i-2], ..., seq[i-order]
  // outcome = seq[i-order-1] = phiên mới hơn state, chính là kết quả "tiếp theo"
  //           NHƯNG vì seq sắp mới→cũ, phiên mới hơn = index NHỎ hơn
  //           => Khi state bắt đầu tại position (i-order), kết quả tiếp theo = seq[i-order-1]
  // Tổng quát hơn: hãy đặt lại: state tại start position p (mới→cũ, p=0 là mới nhất)
  //   state = seq[p..p+order-1]
  //   outcome = seq[p-1] ← phiên mới hơn (nếu p > 0)
  // Vậy duyệt p từ 1 đến length-order:

  for (let p = 1; p <= seq.length - order; p++) {
    const stateKey = seq.slice(p, p + order).join("");
    const outcome  = seq[p - 1]; // phiên tiếp theo (mới hơn)
    if (!table[stateKey]) table[stateKey] = { T: 0, X: 0 };
    table[stateKey][outcome]++;
  }

  // State hiện tại: seq[0..order-1]
  const curState = seq.slice(0, order).join("");
  const c = table[curState];
  if (!c || (c.T + c.X) === 0) return null;

  const signal = c.T >= c.X ? "T" : "X";

  // Backtest: với mỗi p từ 1..length-order, kiểm tra dự đoán có đúng không
  let wins = 0, total = 0;
  for (let p = 1; p <= seq.length - order - 1; p++) {
    // Bỏ qua state hiện tại (p=0)
    const st = seq.slice(p, p + order).join("");
    if (st !== curState) continue;
    // Dự đoán dựa trên bảng (loại trừ chính phiên này khỏi bảng? Không cần với N đủ lớn)
    // Kết quả dự đoán theo bảng tại thời điểm p:
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
    signal,
    winRate: wr,
    sampleCount: total,
    source: `Markov-${order}`,
    detail: `State [${curState}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 2: CẦU BỆT (Streak Analysis)
//  Ý tưởng: Sau k phiên liên tiếp cùng loại, phiên tiếp theo là gì?
//  Backtest đúng: đếm bao nhiêu lần sau k-bệt thì đảo, bao nhiêu lần tiếp
// ═══════════════════════════════════════════════
function streakCau(seq) {
  if (seq.length < MIN_SAMPLES + 3) return null;

  // Đo streak hiện tại
  const curType = seq[0];
  let curStreak = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] === curType) curStreak++;
    else break;
  }
  if (curStreak < 2) return null; // cần ít nhất bệt 2

  // Backtest: tìm tất cả vị trí trong lịch sử có bệt đúng bằng curStreak cùng loại
  // rồi xem phiên tiếp theo (mới hơn = index nhỏ hơn) là gì
  let breakCount = 0, contCount = 0;

  // Duyệt: với mỗi vị trí p trong seq (p = vị trí kết thúc streak)
  // tức là seq[p..p+curStreak-1] đều cùng loại, và seq[p+curStreak] khác loại (hoặc hết)
  // outcome = seq[p-1]
  for (let p = 1; p <= seq.length - curStreak - 1; p++) {
    // Kiểm tra streak tại p
    const t = seq[p];
    let len = 0;
    for (let j = p; j < seq.length && seq[j] === t; j++) len++;
    if (len < curStreak) continue;
    // Kiểm tra phiên trước streak (p+len) khác loại → đây đúng là kết thúc 1 streak
    // (để tránh đếm trùng trong streak dài hơn)
    if (len !== curStreak) continue;
    // Kiểm tra biên: phiên sau streak (cũ hơn) nếu còn phải khác loại
    if (p + curStreak < seq.length && seq[p + curStreak] === t) continue;

    const outcome = seq[p - 1]; // phiên ngay sau streak (mới hơn)
    if (outcome === t) contCount++;  // tiếp tục streak
    else               breakCount++; // đảo chiều
  }

  const total = breakCount + contCount;
  if (total < MIN_SAMPLES) return null;

  const breakRate = breakCount / total;
  const contRate  = contCount  / total;

  if (breakRate > MIN_WIN_RATE) {
    const opp = curType === "T" ? "X" : "T";
    return {
      signal: opp,
      winRate: breakRate,
      sampleCount: total,
      source: "Cầu Bệt",
      detail: `Bệt ${curStreak}×${curType==="T"?"Tài":"Xỉu"} → đảo WR=${(breakRate*100).toFixed(0)}% (${total} mẫu)`
    };
  }
  if (contRate > MIN_WIN_RATE) {
    return {
      signal: curType,
      winRate: contRate,
      sampleCount: total,
      source: "Cầu Bệt",
      detail: `Bệt ${curStreak}×${curType==="T"?"Tài":"Xỉu"} → tiếp WR=${(contRate*100).toFixed(0)}% (${total} mẫu)`
    };
  }
  return null;
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 3: CẦU XEN KẼ (1-1 Alternating)
//  Ý tưởng: Sau chuỗi xen kẽ dài, phiên tiếp theo có xen kẽ tiếp không?
// ═══════════════════════════════════════════════
function alternating(seq) {
  if (seq.length < MIN_SAMPLES + 4) return null;

  // Đo độ dài chuỗi xen kẽ hiện tại (từ đầu seq)
  let altLen = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i-1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;

  // Kết quả tiếp theo nếu xen kẽ tiếp
  const expectedIfAlt = seq[0] === "T" ? "X" : "T";

  // Backtest: tìm các chuỗi xen kẽ dài đúng altLen trong lịch sử
  // Chuỗi xen kẽ tại position p có độ dài L:
  //   seq[p..p+L-1] xen kẽ, seq[p-1] ≠ seq[p] (hoặc p=0), seq[p+L] = seq[p+L-1] (hoặc hết)
  // outcome = seq[p-1]
  let wins = 0, total = 0;

  for (let p = 1; p + altLen <= seq.length; p++) {
    // Đo độ dài chuỗi xen kẽ bắt đầu tại p
    let L = 1;
    for (let i = p+1; i < seq.length; i++) {
      if (seq[i] !== seq[i-1]) L++;
      else break;
    }
    if (L !== altLen) continue;
    // Đảm bảo biên trước đó (p+L) không xen kẽ (để không đếm trùng)
    if (p + L < seq.length && seq[p+L] !== seq[p+L-1]) continue;

    const predictedOutcome = seq[p] === "T" ? "X" : "T"; // nếu tiếp tục xen kẽ
    const actual = seq[p - 1];
    if (predictedOutcome === actual) wins++;
    total++;
    if (total >= 60) break;
  }

  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;

  return {
    signal: expectedIfAlt,
    winRate: wr,
    sampleCount: total,
    source: "Cầu 1-1",
    detail: `Xen kẽ ${altLen} phiên → ${expectedIfAlt==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 4: 5-GRAM PATTERN
//  Ý tưởng: Chuỗi 5 phiên gần nhất giống hệt trong quá khứ → tiếp theo là gì?
// ═══════════════════════════════════════════════
function ngram(seq, n) {
  if (seq.length < n + MIN_SAMPLES + 1) return null;

  const curPat = seq.slice(0, n).join("");

  // Tìm tất cả vị trí p (p >= 1) sao cho seq[p..p+n-1] == curPat
  // outcome = seq[p-1]
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

  return {
    signal,
    winRate: wr,
    sampleCount: total,
    source: `${n}-gram`,
    detail: `Pattern [${curPat}] → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}% (${total} mẫu)`
  };
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 5: CÂN BẰNG (Mean Reversion)
//  Ý tưởng: 30 phiên gần Tài nhiều → hồi quy về Xỉu (và ngược lại)
//  Backtest: Trong lịch sử, sau 30 phiên lệch >62% Tài, 20 phiên tiếp có < 50% Tài không?
// ═══════════════════════════════════════════════
function meanReversion(hist) {
  if (hist.length < 60) return null;

  const W = 30; // cửa sổ quan sát
  const recent = hist.slice(0, W);
  const ratioT = recent.filter(h => h.type === "T").length / W;

  // Backtest
  let wins = 0, total = 0;
  for (let p = W; p + W < hist.length; p++) {
    const window = hist.slice(p, p + W);
    const r = window.filter(h => h.type === "T").length / W;
    const next10 = hist.slice(p - 10, p); // 10 phiên tiếp theo (mới hơn)
    if (next10.length < 5) continue;
    const nextT = next10.filter(h => h.type === "T").length / next10.length;
    if (r > 0.62) {
      total++;
      if (nextT < 0.50) wins++; // dự đoán Xỉu
    } else if (r < 0.38) {
      total++;
      if (nextT > 0.50) wins++; // dự đoán Tài
    }
  }

  if (total < MIN_SAMPLES) return null;
  const wr = wins / total;
  if (wr < MIN_WIN_RATE) return null;

  if (ratioT > 0.62) {
    return {
      signal: "X",
      winRate: wr,
      sampleCount: total,
      source: "Cân Bằng",
      detail: `Tài ${(ratioT*100).toFixed(0)}%/30p → hồi quy Xỉu WR=${(wr*100).toFixed(0)}%`
    };
  }
  if (ratioT < 0.38) {
    return {
      signal: "T",
      winRate: wr,
      sampleCount: total,
      source: "Cân Bằng",
      detail: `Xỉu ${((1-ratioT)*100).toFixed(0)}%/30p → hồi quy Tài WR=${(wr*100).toFixed(0)}%`
    };
  }
  return null;
}

// ═══════════════════════════════════════════════
//  THUẬT TOÁN 6: CHART PATTERN (Hình Dạng Đồ Thị)
//
//  Ý tưởng ĐÚNG:
//    - Lấy cửa sổ W phiên liên tiếp (chuỗi tổng xúc xắc)
//    - Chuẩn hóa về z-score → "hình dạng" không phụ thuộc mức tuyệt đối
//    - Lưu kho: mỗi mẫu = {shape (z-score), outcome T/X ngay sau cửa sổ}
//    - Khi dự đoán: lấy W phiên gần nhất, chuẩn hóa, tìm các mẫu tương tự
//      trong kho (Pearson correlation cao), voting theo outcome
//
//  Lưu ý index:
//    hist[0] = phiên mới nhất
//    Cửa sổ tại position p: hist[p..p+W-1] (p=0 là cửa sổ hiện tại)
//    Outcome tại p = hist[p-1].type (phiên ngay sau cửa sổ, mới hơn)
//    Nên p phải >= 1 khi thu thập mẫu lịch sử
// ═══════════════════════════════════════════════
const CHART_W   = 10;    // cửa sổ 10 phiên
const MIN_CORR  = 0.80;  // ngưỡng tương đồng Pearson
const MAX_DB    = 300;   // tối đa 300 mẫu
const chartDB   = [];    // [{normShape, outcome, totalSeen, wins, label}]

function shapeLabel(normArr) {
  // Mô tả hình dạng bằng slope + curvature
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
  let v = vol > 1.3 ? " Dao Động Mạnh" : vol < 0.5 ? " Ổn Định" : "";
  return s + c + v;
}

function updateChartDB(hist) {
  if (hist.length < CHART_W + 2) return;

  // Thu thập mẫu từ lịch sử
  // p = position cửa sổ trong hist (p=1 vì cần outcome tại p-1)
  for (let p = 1; p + CHART_W <= hist.length; p++) {
    const window = hist.slice(p, p + CHART_W).map(h => h.tong);
    // Đảo chiều: window[0] là phiên cũ nhất trong cửa sổ → hình dạng đọc cũ→mới
    const windowChronological = [...window].reverse();
    const norm = normalize(windowChronological);
    const outcome = hist[p - 1].type; // phiên ngay sau cửa sổ

    // Tìm mẫu tương tự trong DB
    let bestIdx = -1, bestCorr = -1;
    for (let i = 0; i < chartDB.length; i++) {
      const corr = pearson(chartDB[i].normShape, norm);
      if (corr > bestCorr) { bestCorr = corr; bestIdx = i; }
    }

    if (bestCorr >= MIN_CORR && bestIdx >= 0) {
      // Cập nhật mẫu có sẵn
      chartDB[bestIdx].totalSeen++;
      if (outcome === "T") chartDB[bestIdx].winsT++;
      else chartDB[bestIdx].winsX++;
    } else {
      // Thêm mẫu mới
      const entry = {
        normShape: norm,
        label: shapeLabel(norm),
        totalSeen: 1,
        winsT: outcome === "T" ? 1 : 0,
        winsX: outcome === "X" ? 1 : 0,
      };
      chartDB.push(entry);

      // Giới hạn kích thước: xóa mẫu ít xuất hiện nhất
      if (chartDB.length > MAX_DB) {
        chartDB.sort((a,b) => b.totalSeen - a.totalSeen);
        chartDB.splice(MAX_DB);
      }
    }
  }
}

function predictChart(hist) {
  if (hist.length < CHART_W + 2) return null;

  // Cập nhật DB với lịch sử mới nhất
  updateChartDB(hist);

  // Cửa sổ hiện tại: hist[0..CHART_W-1], đọc cũ→mới
  const curWindow = hist.slice(0, CHART_W).map(h => h.tong).reverse();
  const curNorm   = normalize(curWindow);
  const curLabel  = shapeLabel(curNorm);

  // Tìm các mẫu tương tự (corr >= MIN_CORR) có đủ mẫu
  const matches = [];
  for (const entry of chartDB) {
    if (entry.totalSeen < 3) continue;
    const corr = pearson(entry.normShape, curNorm);
    if (corr >= MIN_CORR) matches.push({ entry, corr });
  }

  if (!matches.length) return null;

  // Vote theo trọng số = corr * log(1 + totalSeen)
  let wT = 0, wX = 0;
  for (const { entry, corr } of matches) {
    const total = entry.totalSeen;
    const pT = entry.winsT / total;
    const pX = entry.winsX / total;
    const w  = corr * Math.log(1 + total);
    wT += w * pT;
    wX += w * pX;
  }

  if (wT + wX < 0.001) return null;
  const prob = wT / (wT + wX);
  const signal = prob >= 0.5 ? "T" : "X";
  const wr = Math.max(prob, 1-prob);
  if (wr < MIN_WIN_RATE) return null;

  // Tính backtest: với mỗi mẫu khớp, winrate thực tế
  const totalSeen = matches.reduce((s, m) => s + m.entry.totalSeen, 0);

  return {
    signal,
    winRate: wr,
    sampleCount: totalSeen,
    source: "Chart Pattern",
    detail: `[${curLabel}] khớp ${matches.length} mẫu → ${signal==="T"?"Tài":"Xỉu"} WR=${(wr*100).toFixed(0)}%`,
    shapeName: curLabel,
    matchCount: matches.length
  };
}

// ═══════════════════════════════════════════════
//  ENSEMBLE: Tổng hợp signals
//
//  Dùng simple weighted voting:
//    - weight = winRate * log(1 + sampleCount)
//    - Không dùng log-odds Bayesian vì winRate chỉ ~52-70%,
//      log-odds sẽ khuếch đại sai lệch nhỏ
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
  // Confidence: tỷ lệ phiếu của bên thắng, scale về [0.5, 1.0]
  const rawConf = Math.max(wT, wX) / total;
  // Calibrate: không thổi phồng, cap ở 0.80
  const confidence = 0.50 + Math.min(rawConf - 0.50, 0.30);
  return { signal, confidence };
}

// ═══════════════════════════════════════════════
//  BACKTEST TỔNG THỂ
//  Chạy toàn bộ pipeline trên các slice lịch sử để ước tính accuracy
// ═══════════════════════════════════════════════
function backtestSystem(hist, trials = 30) {
  if (hist.length < trials + 20) return null;
  let wins = 0, total = 0;

  for (let i = 1; i <= trials; i++) {
    // Sử dụng hist[i..] để dự đoán hist[i-1]
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

  return results;
}

// ═══════════════════════════════════════════════
//  MAIN PREDICT
// ═══════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 15) {
    return {
      next: null, nextDisplay: "Chưa đủ dữ liệu",
      confidence: 0.5, confDisplay: "50%",
      signals: [], backtest: null, typeSeq: [],
      sumChart: [], streak: 0, curType: "?",
      chartDBSize: chartDB.length
    };
  }

  const seq     = hist.map(h => h.type);
  const signals = collectSignals(seq, hist);
  const { signal, confidence } = ensemble(signals);
  const backtest = backtestSystem(hist, 30);

  // Streak hiện tại
  const curType = seq[0];
  let streak = 0;
  for (const t of seq) { if (t === curType) streak++; else break; }

  const chartSig = signals.find(s => s.source === "Chart Pattern");

  const vT = signals.filter(s => s.signal === "T").reduce((s,r) => s + r.winRate, 0);
  const vX = signals.filter(s => s.signal === "X").reduce((s,r) => s + r.winRate, 0);

  return {
    next: signal,
    nextDisplay: signal === "T" ? "Tài" : signal === "X" ? "Xỉu" : "?",
    confidence,
    confDisplay: Math.round(confidence * 100) + "%",
    signals,
    signalCount: signals.length,
    backtest,
    typeSeq: seq.slice(0, 25),
    sumChart: hist.slice(0, 25).map(h => h.tong),
    diceCharts: {
      d1: hist.slice(0, 25).map(h => h.dice[0]),
      d2: hist.slice(0, 25).map(h => h.dice[1]),
      d3: hist.slice(0, 25).map(h => h.dice[2]),
    },
    streak, curType,
    votesT: vT.toFixed(2),
    votesX: vX.toFixed(2),
    chartDBSize: chartDB.length,
    chartSignal: chartSig || null,
    currentShape: chartSig ? chartSig.shapeName : null,
  };
}

// ═══════════════════════════════════════════════
//  HTML BUILDER
// ═══════════════════════════════════════════════
function buildHTML(pred, h) {
  const n = Math.min(pred.sumChart.length, 25);
  const labels   = JSON.stringify(Array.from({length:n}, (_,i) => String(Number(h.phien) - (n-1-i))));
  const sumData  = JSON.stringify([...pred.sumChart.slice(0,n)].reverse());
  const typeData = JSON.stringify([...pred.typeSeq.slice(0,n)].reverse());

  const isTai    = pred.next === "T";
  const predColor = isTai ? "#f5c842" : "#a070ff";
  const predBg    = isTai ? "rgba(245,200,66,0.10)" : "rgba(160,112,255,0.10)";

  const btWR    = pred.backtest ? (pred.backtest.wr * 100).toFixed(1) : "N/A";
  const btTotal = pred.backtest ? pred.backtest.total : 0;
  const confPct = Math.round(pred.confidence * 100);

  const sumArr = pred.sumChart;
  const bolMid = parseFloat(mean(sumArr).toFixed(2));
  const bolSd  = parseFloat(stdDev(sumArr).toFixed(2));
  const bolUp  = parseFloat((bolMid + 2*bolSd).toFixed(2));
  const bolLow = parseFloat((bolMid - 2*bolSd).toFixed(2));

  const vT  = Number(pred.votesT), vX = Number(pred.votesX);
  const pctT = (vT+vX) > 0 ? Math.round(vT/(vT+vX)*100) : 50;
  const pctX = 100 - pctT;

  const sigRows = pred.signals.map(s => {
    const isT = s.signal === "T";
    return `<tr>
      <td class="td-src">${s.source}</td>
      <td class="${isT?"sig-t":"sig-x"}">${isT?"▲ Tài":"▼ Xỉu"}</td>
      <td class="td-wr">${(s.winRate*100).toFixed(0)}%</td>
      <td class="td-n">${s.sampleCount}</td>
      <td class="td-detail">${s.detail}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;padding:8px;font-size:.78rem">Chưa đủ mẫu</td></tr>`;

  // Chart DB top patterns
  const topDB = [...chartDB]
    .filter(e => e.totalSeen >= 3)
    .sort((a,b) => b.totalSeen - a.totalSeen)
    .slice(0, 8);
  const dbRows = topDB.map((e,i) => {
    const total = e.totalSeen;
    const pT = e.winsT / total, pX = e.winsX / total;
    const pred2 = pT >= pX ? "T" : "X";
    const wr = Math.max(pT, pX);
    return `<tr>
      <td class="td-src">#${i+1}</td>
      <td style="color:#7a8a70;font-size:.62rem;max-width:120px">${e.label}</td>
      <td class="${pred2==="T"?"sig-t":"sig-x"}">${pred2==="T"?"▲ T":"▼ X"}</td>
      <td class="td-wr">${(wr*100).toFixed(0)}%</td>
      <td class="td-n">${total}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:#555;font-size:.75rem;padding:6px">Đang xây dựng kho mẫu...</td></tr>`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v10 — SUNWIN</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#c8960a;--gl:#f5c842;--tai:#f5c842;--xiu:#a070ff;
  --bg:#0d0900;--bg2:#160e03;--bg3:#1e1404;--bdr:rgba(180,130,10,.28);
  --txt:#e8d8a0;--dim:#9a7a40;
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
.shape-match{font-family:var(--mono);font-size:.65rem;color:#50aa70;margin-left:auto}
.pdb{background:var(--bg2);border:1px solid rgba(100,200,150,.25);border-radius:10px;padding:12px;margin-bottom:10px}
.pdb-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1.5px;color:#60bb90;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.db-stat-row{display:flex;gap:10px;font-family:var(--mono);font-size:.72rem}
.db-stat{background:rgba(100,200,150,.08);border:1px solid rgba(100,200,150,.18);border-radius:5px;padding:3px 10px}
.db-stat .v{color:#66ddaa;font-weight:bold}
@media(max-width:620px){.metrics{grid-template-columns:repeat(3,1fr)}.pred-row,.two-col{grid-template-columns:1fr}}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v10 — SUNWIN ⬦</div>
  <div class="hdr-right">
    <span>Phiên <span class="v">#${h.phien}</span></span>
    <span class="${h.type==="T"?"ct":"cx"} v">${h.type==="T"?"Tài":"Xỉu"}</span>
    <span>${h.dice.join("·")}</span>
    <span>Σ <span class="v">${h.tong}</span></span>
    <span style="color:#555">${new Date().toLocaleTimeString("vi-VN")}</span>
  </div>
</div>

<div class="algo-note">
  ⚡ <strong>v10 — Logic Chuẩn:</strong>
  Markov(1/2/3) · Cầu Bệt · Xen Kẽ · N-gram(4/5) · Cân Bằng · Chart Pattern |
  <strong>${pred.signalCount}</strong> signal hợp lệ ·
  Kho đồ thị: <strong style="color:#88ddaa">${pred.chartDBSize}</strong> mẫu ·
  Backtest 30p: <strong style="color:#aaffaa">${btWR}%</strong>
</div>

${pred.chartSignal
  ? `<div class="shape-info">📊 Hình dạng hiện tại: <strong style="color:#88eebb">${pred.chartSignal.shapeName}</strong>
     <span class="shape-match">Khớp ${pred.chartSignal.matchCount} mẫu lịch sử</span></div>`
  : `<div class="shape-info" style="opacity:.5">📊 Đang phân tích hình dạng đồ thị...</div>`}

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
  <div class="mc" style="--ac:#44cc88">
    <div class="mc-lbl">Khuôn Mẫu</div>
    <div class="mc-val">${pred.chartDBSize}</div>
    <div class="mc-sub">mẫu đồ thị</div>
  </div>
</div>

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

<div class="two-col">
  <div class="card" style="margin-bottom:0">
    <div class="card-title">📈 Biểu Đồ Tổng + Bollinger Band</div>
    <canvas id="sumChart" height="220"></canvas>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title">📊 Hình Dạng Đồ Thị (Z-score)</div>
    <canvas id="shapeChart" height="220"></canvas>
  </div>
</div>

<div class="pdb" style="margin-top:10px">
  <div class="pdb-title">
    <span>🗂 Kho Khuôn Mẫu Đồ Thị</span>
    <div class="db-stat-row">
      <div class="db-stat">Tổng: <span class="v">${chartDB.length}</span></div>
      <div class="db-stat">Ngưỡng: <span class="v">Pearson≥${MIN_CORR}</span></div>
    </div>
  </div>
  <div style="overflow-x:auto">
    <table class="sig-table">
      <thead><tr><th>#</th><th>Tên Mẫu</th><th>Dự Đoán</th><th>WR%</th><th>Lần Gặp</th></tr></thead>
      <tbody>${dbRows}</tbody>
    </table>
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
    <div class="card-title" style="display:flex;justify-content:space-between">
      <span>${pred.signalCount} tín hiệu đã qua backtest (WR &gt; 52%)</span>
    </div>
    <div style="max-height:300px;overflow-y:auto">
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
[...TYPE_DATA].forEach((t,i) => {
  const b = document.createElement('div');
  b.className = 'bead '+(t==='T'?'bt':'bx')+(i===TYPE_DATA.length-1?' bead-new':'');
  b.textContent = t;
  beadEl.appendChild(b);
});

// Numbered-circle plugin cho sum chart
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
    {label:'BB Lower',data:Array(N).fill(BOLL_LOW),borderColor:'rgba(100,180,255,.22)',borderWidth:1,borderDash:[3,4],pointRadius:0,fill:{target:'-1',above:'rgba(100,180,255,.05)',below:'rgba(100,180,255,.05)'},tension:0,order:10},
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

  // Dashboard HTML
  if (url.pathname === "/bando") {
    if (!history.length) { noData(); return; }
    const h = history[0];
    const pred = predict(history);
    res.writeHead(200, {"Content-Type":"text/html;charset=utf-8"});
    res.end(buildHTML(pred, h)); return;
  }

  // JSON endpoints
  res.setHeader("Content-Type","application/json;charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");

  if (url.pathname === "/" || url.pathname === "/predict") {
    if (!history.length) { noData(); return; }
    const h = history[0], p = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: h.phien,
      xuc_xac: h.dice,
      tong_hien_tai: h.tong,
      ket_qua_hien: h.type==="T"?"Tài":"Xỉu",
      phien_du_doan: String(Number(h.phien)+1),
      du_doan: p.nextDisplay,
      do_tin_cay: p.confDisplay,
      backtest_winrate: p.backtest?.wr ?? null,
      signal_count: p.signalCount,
      current_shape: p.currentShape,
      chart_db_size: p.chartDBSize,
      ver: "v10"
    })); return;
  }

  if (url.pathname === "/predict/detail") {
    if (!history.length) { noData(); return; }
    const p = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan: p.nextDisplay,
      do_tin_cay: p.confDisplay,
      backtest: p.backtest,
      signals: p.signals,
      streak: p.streak,
      chart_signal: p.chartSignal,
      chart_db_size: p.chartDBSize,
      ver: "v10"
    })); return;
  }

  if (url.pathname === "/sunlon") {
    if (!history.length) { noData(); return; }
    const h = history[0], p = predict(history);
    const pattern = history.slice(0, 30).map(x => x.type).reverse().join("");
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: Number(h.phien),
      ket_qua: h.type === "T" ? "Tai" : "Xiu",
      xuc_xac: h.dice,
      phien_du_doan: Number(h.phien) + 1,
      du_doan: p.next === "T" ? "Tai" : "Xiu",
      do_tin_cay: p.confDisplay,
      pattern,
      id: "@sewdangcap"
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
    const top = [...chartDB]
      .filter(e => e.totalSeen >= 2)
      .sort((a,b) => b.totalSeen - a.totalSeen)
      .slice(0, 20)
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
    ver: "v10"
  }));

}).listen(PORT, () => {
  console.log(`✅  SicBo v10.0 — Logic Chuẩn — port ${PORT}`);
  console.log(`    Dashboard : http://localhost:${PORT}/bando`);
  console.log(`    API       : http://localhost:${PORT}/predict`);
  console.log(`    Patterns  : http://localhost:${PORT}/patterns`);
  console.log(`    Algorithms:`);
  console.log(`      Markov(1/2/3)  — state [p..p+order-1], outcome=seq[p-1]`);
  console.log(`      Cầu Bệt       — backtest streak đúng độ dài, outcome=seq[p-1]`);
  console.log(`      Xen Kẽ 1-1    — backtest altLen đúng, outcome=seq[p-1]`);
  console.log(`      N-gram(4/5)   — pattern match, outcome=seq[p-1]`);
  console.log(`      Cân Bằng      — mean reversion 30 phiên`);
  console.log(`      Chart Pattern — z-norm + Pearson corr, outcome=hist[p-1].type`);
  syncHistory();
  setInterval(syncHistory, 12000);
});
