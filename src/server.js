"use strict";
const https  = require("https");
const http   = require("http");

const SOURCE_URL  = "https://apilichsusunwinsew.onrender.com/api/taixiu/history?limit=50";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 600;

let history = [];

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
//  CORE MATH UTILITIES
// ════════════════════════════════════════════════════════════════════
function calcSlope(arr) {
  const n = arr.length; if (n < 2) return 0;
  const y = [...arr].reverse();
  const xMean = (n - 1) / 2, yMean = y.reduce((s,v)=>s+v,0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (y[i] - yMean); den += (i - xMean) ** 2; }
  return den < 1e-9 ? 0 : num / den;
}
function mean(arr) { if (!arr.length) return 0; return arr.reduce((s,v)=>s+v,0)/arr.length; }
function stdDev(arr) { if (arr.length < 2) return 0; const m=mean(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); }
function ema(arr, period) { const y=[...arr].reverse(); const k=2/(period+1); let e=y[0]; for(let i=1;i<y.length;i++) e=y[i]*k+e*(1-k); return e; }
function findPeaksValleys(arr) {
  const n=arr.length; const peaks=[],valleys=[];
  for(let i=1;i<n-1;i++){
    if(arr[i]>=arr[i-1]&&arr[i]>=arr[i+1]&&arr[i]>arr[i+1]+0.5) peaks.push({i,v:arr[i]});
    if(arr[i]<=arr[i-1]&&arr[i]<=arr[i+1]&&arr[i]<arr[i-1]-0.5) valleys.push({i,v:arr[i]});
  }
  return {peaks,valleys};
}
function findSupportResistance(arr, threshold=1.5) {
  const {peaks,valleys}=findPeaksValleys(arr); const levels=[];
  const cluster=(points)=>{
    if(!points.length) return;
    const sorted=[...points].sort((a,b)=>a.v-b.v); let group=[sorted[0]];
    for(let i=1;i<sorted.length;i++){
      if(sorted[i].v-group[group.length-1].v<=threshold) group.push(sorted[i]);
      else { if(group.length>=2){ const avg=group.reduce((s,p)=>s+p.v,0)/group.length; levels.push({value:avg,strength:group.length}); } group=[sorted[i]]; }
    }
    if(group.length>=2){ const avg=group.reduce((s,p)=>s+p.v,0)/group.length; levels.push({value:avg,strength:group.length}); }
  };
  cluster(peaks); cluster(valleys);
  return levels.sort((a,b)=>b.strength-a.strength);
}

// ════════════════════════════════════════════════════════════════════
//  ADVANCED PATTERN RECOGNITION v7
// ════════════════════════════════════════════════════════════════════

// Markov Chain 2nd-order: P(next | last2)
function buildMarkov2(typeSeq) {
  const counts = {};
  for (let i = 0; i < typeSeq.length - 2; i++) {
    const key = typeSeq[i+2] + typeSeq[i+1]; // state = [older, newer] → predict [newest]
    const next = typeSeq[i];
    if (!counts[key]) counts[key] = {T:0, X:0};
    counts[key][next]++;
  }
  return counts;
}

function analyzeMarkov2(typeSeq) {
  if (typeSeq.length < 10) return null;
  const mc = buildMarkov2(typeSeq);
  const key = typeSeq[1] + typeSeq[0]; // last 2 states
  const c = mc[key];
  if (!c) return null;
  const tot = c.T + c.X;
  if (tot < 3) return null;
  const domT = c.T >= c.X;
  const wr = Math.max(c.T, c.X) / tot;
  if (wr < 0.60) return null;
  return {
    signal: domT ? "T" : "X",
    conf: Math.min(0.55 + wr * 0.28, 0.80),
    detail: `Markov2 [${key}]→${domT?'Tài':'Xỉu'} ${Math.round(wr*100)}% (${tot} mẫu)`
  };
}

// Cầu bệt: chuỗi đơn sắc dài và xác suất tiếp
function analyzeBetCau(typeSeq) {
  if (typeSeq.length < 5) return null;
  const cur = typeSeq[0]; let streak = 1;
  for (let i = 1; i < typeSeq.length; i++) { if (typeSeq[i] === cur) streak++; else break; }
  // Scan lịch sử tìm sau streak này thường gì
  let contT = 0, contX = 0, breakT = 0, breakX = 0;
  for (let i = streak; i < typeSeq.length - 1; i++) {
    let s = 0;
    for (let j = 0; j < streak && i+j < typeSeq.length; j++) { if (typeSeq[i+j] !== cur) { s = -1; break; } s = j+1; }
    if (s === streak && i > streak) {
      const next = typeSeq[i - 1];
      if (next === cur) { if(cur==="T") contT++; else contX++; }
      else { if(cur==="T") breakX++; else breakT++; }
    }
  }
  const tot = contT + contX + breakT + breakX;
  if (tot < 2) return null;
  const breakCount = cur === "T" ? breakX : breakT;
  const contCount  = cur === "T" ? contT  : contX;
  const opp = cur === "T" ? "X" : "T";
  if (breakCount > contCount && (breakCount/tot) > 0.58) {
    return { signal: opp, conf: Math.min(0.56 + (breakCount/tot)*0.25, 0.78), detail: `Cầu bệt ${streak}×${cur==='T'?'Tài':'Xỉu'} → lịch sử ${Math.round(breakCount/tot*100)}% đảo` };
  }
  if (contCount > breakCount && (contCount/tot) > 0.62 && streak <= 3) {
    return { signal: cur, conf: Math.min(0.55 + (contCount/tot)*0.22, 0.74), detail: `Cầu bệt ${streak}×${cur==='T'?'Tài':'Xỉu'} → lịch sử ${Math.round(contCount/tot*100)}% tiếp` };
  }
  return null;
}

// Phát hiện cầu 1-1 (alternating): T X T X ...
function analyzeAlternatingCau(typeSeq) {
  if (typeSeq.length < 6) return null;
  let altLen = 1;
  for (let i = 1; i < Math.min(typeSeq.length, 12); i++) {
    if (typeSeq[i] !== typeSeq[i-1]) altLen++;
    else break;
  }
  if (altLen >= 4) {
    const nextSig = typeSeq[0] === "T" ? "X" : "T";
    return { signal: nextSig, conf: Math.min(0.60 + altLen * 0.025, 0.80), detail: `Cầu 1-1 dài ${altLen} phiên → tiếp tục xen kẽ` };
  }
  return null;
}

// Phát hiện cầu 2-2 hoặc N-N: TT XX TT XX ...
function analyzeSymmetricCau(typeSeq) {
  if (typeSeq.length < 8) return null;
  // Check block size 2, 3
  for (const bk of [2, 3]) {
    let blocks = 0, valid = true, lastBlock = null;
    for (let i = 0; i < Math.min(typeSeq.length, bk * 6); i += bk) {
      const slice = typeSeq.slice(i, i + bk);
      if (slice.length < bk) break;
      if (new Set(slice).size !== 1) { valid = false; break; }
      if (lastBlock !== null && slice[0] === lastBlock) { valid = false; break; }
      lastBlock = slice[0];
      blocks++;
    }
    if (valid && blocks >= 3) {
      // Pattern complete, count position in current block
      const cur = typeSeq[0];
      let posInBlock = 0;
      for (let i = 0; i < typeSeq.length; i++) { if (typeSeq[i] === cur) posInBlock++; else break; }
      const opp = cur === "T" ? "X" : "T";
      const sig = posInBlock >= bk ? opp : cur;
      return {
        signal: sig,
        conf: 0.70 + blocks * 0.02,
        detail: `Cầu ${bk}-${bk} ổn định (${blocks} chu kỳ) → ${sig==='T'?'Tài':'Xỉu'}`
      };
    }
  }
  return null;
}

// Phân tích cầu đảo chiều dựa trên tần suất chu kỳ
function analyzeCyclicReversal(typeSeq) {
  if (typeSeq.length < 20) return null;
  // Find most common reversal period
  const cur = typeSeq[0];
  const runs = []; let run = 0;
  for (let i = 0; i < typeSeq.length; i++) {
    const same = typeSeq[i] === (i > 0 ? typeSeq[i-1] : typeSeq[i]);
    if (same || i === 0) run++;
    else { runs.push(run); run = 1; }
  }
  if (runs.length < 4) return null;
  const avgRun = mean(runs), stdRun = stdDev(runs);
  const curRun = runs[0];
  if (curRun >= Math.round(avgRun + stdRun * 0.8)) {
    const opp = cur === "T" ? "X" : "T";
    return { signal: opp, conf: Math.min(0.60 + (curRun - avgRun) / (stdRun + 0.1) * 0.04, 0.76), detail: `Chuỗi ${curRun} > TB ${avgRun.toFixed(1)}±${stdRun.toFixed(1)} → đảo` };
  }
  return null;
}

// Entropy cục bộ: phân tích 5/10/20 phiên
function analyzeMultiEntropy(typeSeq) {
  const calcH = (sub) => {
    const pT = sub.filter(t=>t==="T").length / sub.length;
    const pX = 1 - pT;
    const h = p => p < 1e-9 ? 0 : -p * Math.log2(p);
    return { entropy: h(pT) + h(pX), pT, pX };
  };
  if (typeSeq.length < 20) return null;
  const h5  = calcH(typeSeq.slice(0,5));
  const h10 = calcH(typeSeq.slice(0,10));
  const h20 = calcH(typeSeq.slice(0,20));
  // Low entropy recently = biased
  if (h5.entropy < 0.65 && h10.entropy < 0.75) {
    const dom5 = h5.pT > 0.5 ? "T" : "X";
    const opp = dom5 === "T" ? "X" : "T";
    return { signal: opp, conf: Math.min(0.62 + (0.75 - h10.entropy) * 0.25, 0.78), detail: `Entropy H5=${h5.entropy.toFixed(2)} H10=${h10.entropy.toFixed(2)} lệch mạnh → kỳ vọng hồi` };
  }
  // High entropy overall but low short-term = noise
  if (h5.entropy > 0.95 && h20.entropy < 0.80) {
    const dom20 = h20.pT > 0.5 ? "T" : "X";
    return { signal: dom20, conf: 0.58, detail: `Entropy ngắn cao + dài lệch ${dom20} → drift` };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
//  VIRTUAL CHART ENGINE
// ════════════════════════════════════════════════════════════════════
function buildVirtualCharts(hist, n=40) {
  const slice=hist.slice(0,n);
  return {
    sumChart: slice.map(h=>h.tong),
    diceCharts: { d1:slice.map(h=>h.dice[0]), d2:slice.map(h=>h.dice[1]), d3:slice.map(h=>h.dice[2]) },
    typeSeq: slice.map(h=>h.type),
    len: slice.length
  };
}

// ════════════════════════════════════════════════════════════════════
//  ALGORITHMS (v7 full suite)
// ════════════════════════════════════════════════════════════════════
function calcRSI(sumChart, period=10) {
  if (sumChart.length < period+2) return null;
  const y=[...sumChart].reverse(); const n=Math.min(y.length,period+10);
  let gains=0,losses=0;
  for(let i=y.length-n;i<y.length-1;i++){ const d=y[i+1]-y[i]; if(d>0) gains+=d; else losses-=d; }
  if(gains+losses<0.001) return 50;
  const ag=gains/(n-1),al=losses/(n-1);
  if(al<0.001) return 100;
  return 100-(100/(1+ag/al));
}
function analyzeRSI(sumChart) {
  const rsi=calcRSI(sumChart); if(rsi===null) return null;
  if(rsi>=72) return {signal:"X",conf:0.70+(rsi-72)*0.004,detail:`RSI=${rsi.toFixed(1)} quá mua → đảo chiều Xỉu`};
  if(rsi<=28) return {signal:"T",conf:0.70+(28-rsi)*0.004,detail:`RSI=${rsi.toFixed(1)} quá bán → đảo chiều Tài`};
  if(rsi>=60) return {signal:"X",conf:0.57,detail:`RSI=${rsi.toFixed(1)} vùng cao → thiên Xỉu`};
  if(rsi<=40) return {signal:"T",conf:0.57,detail:`RSI=${rsi.toFixed(1)} vùng thấp → thiên Tài`};
  return null;
}
function analyzeMACD(sumChart) {
  if(sumChart.length<12) return null;
  const fast3=ema(sumChart,3),fast4=ema(sumChart.slice(1),3),slow8=ema(sumChart,8),slow8p=ema(sumChart.slice(1),8);
  const macd=fast3-slow8,macdP=fast4-slow8p;
  if(macdP<0&&macd>0) return {signal:"T",conf:0.68,detail:`MACD golden cross (${macd.toFixed(2)}) → Tài`};
  if(macdP>0&&macd<0) return {signal:"X",conf:0.68,detail:`MACD death cross (${macd.toFixed(2)}) → Xỉu`};
  if(macd>0.5&&macd>macdP) return {signal:"T",conf:0.58,detail:`MACD histogram tăng ${macd.toFixed(2)}`};
  if(macd<-0.5&&macd<macdP) return {signal:"X",conf:0.58,detail:`MACD histogram giảm ${macd.toFixed(2)}`};
  return null;
}
function analyzeBollinger(sumChart) {
  if(sumChart.length<12) return null;
  const sub=sumChart.slice(0,12),m=mean(sub),sd=stdDev(sub);
  const upper=m+2*sd,lower=m-2*sd,cur=sumChart[0],bw=(upper-lower)/m;
  if(bw<0.18){ const s=calcSlope(sumChart.slice(0,5)); return {signal:s>=0?"T":"X",conf:0.62,detail:`Bollinger Squeeze BW=${(bw*100).toFixed(1)}% → breakout ${s>=0?'Tài':'Xỉu'}`}; }
  if(cur>=upper-0.3) return {signal:"X",conf:0.67,detail:`Chạm Bollinger Upper ${upper.toFixed(1)} → hồi quy`};
  if(cur<=lower+0.3) return {signal:"T",conf:0.67,detail:`Chạm Bollinger Lower ${lower.toFixed(1)} → bật lên`};
  if(cur>upper) return {signal:"X",conf:0.72,detail:`Phá vỡ Bollinger Upper ${cur.toFixed(0)}>${upper.toFixed(1)} → đảo ngược`};
  if(cur<lower) return {signal:"T",conf:0.72,detail:`Phá vỡ Bollinger Lower ${cur.toFixed(0)}<${lower.toFixed(1)} → đảo ngược`};
  return null;
}
function analyzeFibonacci(sumChart) {
  if(sumChart.length<10) return null;
  const sub=sumChart.slice(0,20),hi=Math.max(...sub),lo=Math.min(...sub),rng=hi-lo;
  if(rng<3) return null;
  const cur=sumChart[0],slope10=calcSlope(sub);
  const FIB=[0.236,0.382,0.500,0.618,0.786];
  for(const f of FIB){
    const rv=lo+rng*(1-f),ru=lo+rng*f;
    if(Math.abs(cur-rv)<=0.5&&slope10<0) return {signal:"T",conf:0.60+f*0.08,detail:`Fib ${(f*100).toFixed(1)}% hồi từ ${hi} → hỗ trợ ${rv.toFixed(1)}`};
    if(Math.abs(cur-ru)<=0.5&&slope10>0) return {signal:"X",conf:0.60+f*0.08,detail:`Fib ${(f*100).toFixed(1)}% hồi từ ${lo} → kháng cự ${ru.toFixed(1)}`};
  }
  return null;
}
function analyzeStreak(typeSeq) {
  if(typeSeq.length<4) return null;
  let streak=1; const cur=typeSeq[0];
  for(let i=1;i<typeSeq.length;i++){ if(typeSeq[i]===cur) streak++; else break; }
  if(streak>=6){ const opp=cur==="T"?"X":"T"; return {signal:opp,conf:Math.min(0.70+streak*0.02,0.82),detail:`Streak ${streak} ${cur==="T"?"Tài":"Xỉu"} liên tiếp → đảo chiều mạnh`}; }
  if(streak>=4){ const opp=cur==="T"?"X":"T"; return {signal:opp,conf:0.63+streak*0.02,detail:`Chuỗi ${streak} ${cur==="T"?"Tài":"Xỉu"} → kỳ vọng đảo`}; }
  return null;
}
function analyzeVolumeProfile(sumChart) {
  if(sumChart.length<20) return null;
  const sub=sumChart.slice(0,Math.min(50,sumChart.length)),freq={};
  for(let v=3;v<=18;v++) freq[v]=0;
  sub.forEach(v=>{if(freq[Math.round(v)]!==undefined) freq[Math.round(v)]++;});
  const cur=Math.round(sumChart[0]);
  const sorted=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
  const hvn=sorted.slice(0,3).map(([v])=>Number(v)),lvn=sorted.slice(-3).map(([v])=>Number(v));
  if(hvn.some(v=>Math.abs(v-cur)<=0.5)){ const s=calcSlope(sumChart.slice(0,5)); return {signal:s>=0?"X":"T",conf:0.63,detail:`Giá tại HVN ${cur} (tần suất ${freq[cur]}x) → ${s>=0?'kháng cự':'hỗ trợ'}`}; }
  if(lvn.some(v=>Math.abs(v-cur)<=0.5)&&sumChart.length>=3){ const s=calcSlope(sumChart.slice(0,4)); if(Math.abs(s)>0.5) return {signal:s>=0?"T":"X",conf:0.59,detail:`Giá tại LVN ${cur} (thưa ${freq[cur]}x) → momentum tiếp`}; }
  return null;
}
function analyzePatternFingerprint(typeSeq) {
  const W=5; if(typeSeq.length<W+5) return null;
  const rp=typeSeq.slice(0,W).join(""); let mT=0,mX=0;
  for(let i=W;i<typeSeq.length-1;i++){
    const cRev=typeSeq.slice(i,i+W).join("").split("").reverse().join("");
    const rRev=rp.split("").reverse().join("");
    if(cRev===rRev){ const next=typeSeq[i-1]; if(next==="T") mT++; else mX++; }
  }
  const tot=mT+mX; if(tot<3) return null;
  const wr=Math.max(mT,mX)/tot;
  if(wr>=0.65){ const pred=mT>=mX?"T":"X"; return {signal:pred,conf:Math.min(0.55+wr*0.25,0.78),detail:`Pattern ${rp.split("").reverse().join("")} → ${pred==="T"?"Tài":"Xỉu"} ${Math.round(wr*100)}% (${tot} mẫu)`}; }
  return null;
}
function analyzeWaveCycle(sumChart) {
  if(sumChart.length<16) return null;
  const y=[...sumChart.slice(0,32)].reverse(),n=y.length,m=mean(y),centered=y.map(v=>v-m);
  let bestLag=0,bestCorr=0;
  for(let lag=2;lag<=8;lag++){ let corr=0; for(let i=0;i<n-lag;i++) corr+=centered[i]*centered[i+lag]; corr/=(n-lag); if(Math.abs(corr)>Math.abs(bestCorr)){bestCorr=corr;bestLag=lag;} }
  if(Math.abs(bestCorr)<0.8) return null;
  if(bestCorr>0){ const s=calcSlope(sumChart.slice(0,3)); return {signal:s>=0?"T":"X",conf:0.61,detail:`Chu kỳ ${bestLag} phiên, tương quan ${bestCorr.toFixed(2)} → tiếp pha`}; }
  return null;
}
function calcATR(sumChart,period=8) {
  if(sumChart.length<period+1) return null;
  const trs=[]; for(let i=0;i<period;i++){ const c=sumChart[i],p=sumChart[i+1]??c; trs.push(Math.abs(c-p)); } return mean(trs);
}
function analyzeATRTrend(sumChart) {
  const atr=calcATR(sumChart,8); if(atr===null) return null;
  const s=calcSlope(sumChart.slice(0,6)),cur=sumChart[0];
  if(atr>2.5&&Math.abs(s)>1.0) return {signal:s>0?"T":"X",conf:0.64,detail:`ATR=${atr.toFixed(2)} cao + slope=${s.toFixed(2)} → trend mạnh`};
  if(atr<1.0) return {signal:cur>=10.5?"X":"T",conf:0.57,detail:`ATR=${atr.toFixed(2)} sideways → hồi về mean`};
  return null;
}
function detectChartPattern(sumChart) {
  if(sumChart.length<8) return {pattern:"Không đủ dữ liệu",signal:null,conf:0};
  const y=[...sumChart].reverse(),n=y.length,{peaks,valleys}=findPeaksValleys(y);
  if(valleys.length>=2){ const [v1,v2]=valleys.slice(-2); if(v1&&v2&&Math.abs(v1.v-v2.v)<=1.5){ const mp=peaks.find(p=>p.i>v1.i&&p.i<v2.i); if(mp&&mp.v>v1.v+2&&v2.i>=n*0.6) return {pattern:`Mẫu W đáy ${Math.round(v1.v)}-${Math.round(v2.v)}`,signal:"T",conf:0.68}; } }
  if(peaks.length>=2){ const [p1,p2]=peaks.slice(-2); if(p1&&p2&&Math.abs(p1.v-p2.v)<=1.5){ const mv=valleys.find(v=>v.i>p1.i&&v.i<p2.i); if(mv&&mv.v<p1.v-2&&p2.i>=n*0.6) return {pattern:`Mẫu M đỉnh ${Math.round(p1.v)}-${Math.round(p2.v)}`,signal:"X",conf:0.68}; } }
  if(peaks.length>=3){ const [lS,head,rS]=peaks.slice(-3); if(lS&&head&&rS&&head.v>lS.v+1.5&&head.v>rS.v+1.5&&Math.abs(lS.v-rS.v)<=2&&rS.i>=n*0.55) return {pattern:`Vai-Đầu-Vai đỉnh ${Math.round(head.v)}`,signal:"X",conf:0.71}; }
  if(valleys.length>=3){ const [lS,head,rS]=valleys.slice(-3); if(lS&&head&&rS&&head.v<lS.v-1.5&&head.v<rS.v-1.5&&Math.abs(lS.v-rS.v)<=2&&rS.i>=n*0.55) return {pattern:`Vai-Đầu-Vai đảo đáy ${Math.round(head.v)}`,signal:"T",conf:0.71}; }
  if(peaks.length>=3&&valleys.length>=3){ const rP=peaks.slice(-3),rV=valleys.slice(-3); if(rP.every((p,i)=>i===0||p.v>rP[i-1].v-0.5)&&rV.every((v,i)=>i===0||v.v>rV[i-1].v-0.5)) return {pattern:"Cầu thang tăng dần",signal:"T",conf:0.64}; if(rP.every((p,i)=>i===0||p.v<rP[i-1].v+0.5)&&rV.every((v,i)=>i===0||v.v<rV[i-1].v+0.5)) return {pattern:"Cầu thang giảm dần",signal:"X",conf:0.64}; }
  return {pattern:"Không rõ mẫu hình",signal:null,conf:0};
}
function analyzeSlopeAndReversion(sumChart) {
  if(sumChart.length<5) return null;
  const s3=calcSlope(sumChart.slice(0,4)),s6=calcSlope(sumChart.slice(0,8)),cur=sumChart[0];
  if(cur>=16&&s3>0.5) return {signal:"X",conf:0.70,detail:`Đụng kháng cự ${cur}, slope=${s3.toFixed(2)}`};
  if(cur<=5&&s3<-0.5) return {signal:"T",conf:0.70,detail:`Chạm hỗ trợ ${cur}, slope=${s3.toFixed(2)}`};
  if(cur>=13&&s3<-0.3&&s6>0.2) return {signal:"X",conf:0.62,detail:`Đảo chiều từ vùng cao ${cur}`};
  if(cur<=8&&s3>0.3&&s6<-0.2) return {signal:"T",conf:0.62,detail:`Đảo chiều từ vùng thấp ${cur}`};
  if(s3>1.5) return {signal:"T",conf:0.58,detail:`Slope tăng mạnh ${s3.toFixed(2)}`};
  if(s3<-1.5) return {signal:"X",conf:0.58,detail:`Slope giảm mạnh ${s3.toFixed(2)}`};
  return null;
}
function analyzeSupportResistance(sumChart) {
  if(sumChart.length<10) return null;
  const levels=findSupportResistance(sumChart.slice(0,30),1.5),cur=sumChart[0];
  for(const lvl of levels.slice(0,4)){ if(Math.abs(cur-lvl.value)<=0.8){ const s=calcSlope(sumChart.slice(0,5)); return {signal:s>0?"X":"T",conf:Math.min(0.55+lvl.strength*0.03,0.72),detail:`${s>0?'Kháng cự':'Hỗ trợ'} ${lvl.value.toFixed(1)} (mạnh ${lvl.strength}x)`}; } }
  return null;
}
function analyzeDicePhase(diceCharts) {
  const s={d1:calcSlope(diceCharts.d1.slice(0,5)),d2:calcSlope(diceCharts.d2.slice(0,5)),d3:calcSlope(diceCharts.d3.slice(0,5))};
  const up=Object.values(s).filter(x=>x>0.3).length,dn=Object.values(s).filter(x=>x<-0.3).length,tot=s.d1+s.d2+s.d3;
  if(up===3) return {signal:"T",conf:0.65,detail:`Đồng pha 3 xúc xắc đâm lên (${tot.toFixed(2)})`};
  if(dn===3) return {signal:"X",conf:0.65,detail:`Đồng pha 3 xúc xắc đâm xuống (${tot.toFixed(2)})`};
  if(up===2&&tot>0.8) return {signal:"T",conf:0.57,detail:`2/3 xúc xắc đâm lên`};
  if(dn===2&&tot<-0.8) return {signal:"X",conf:0.57,detail:`2/3 xúc xắc đâm xuống`};
  return null;
}
function predictNextDiceValues(diceCharts) {
  const p1=(arr)=>{ if(arr.length<3) return Math.round((arr[0]??3.5)*2)/2; const s=calcSlope(arr.slice(0,8)); let e=arr[0]+s*0.6; e-=(arr[0]-3.5)*0.15; return Math.min(6,Math.max(1,Math.round(e*2)/2)); };
  return {d1:p1(diceCharts.d1),d2:p1(diceCharts.d2),d3:p1(diceCharts.d3)};
}
function analyzeDiceConvergence(diceCharts) {
  if(diceCharts.d1.length<3) return null;
  const cur=[diceCharts.d1[0],diceCharts.d2[0],diceCharts.d3[0]],spread=Math.max(...cur)-Math.min(...cur),sum=cur.reduce((a,b)=>a+b,0);
  const prev=[diceCharts.d1[1]??cur[0],diceCharts.d2[1]??cur[1],diceCharts.d3[1]??cur[2]],psum=prev.reduce((a,b)=>a+b,0);
  if(spread<=1) return {signal:sum>=10?"T":"X",conf:0.62,detail:`Hội tụ 3 viên spread=${spread} sum=${sum}`};
  if(spread>=4) return {signal:sum>=psum?"X":"T",conf:0.57,detail:`Phân kỳ spread=${spread} → đảo`};
  return null;
}
function analyzeSumMomentum(sumChart) {
  if(sumChart.length<10) return null;
  const s3=calcSlope(sumChart.slice(0,3)),s6=calcSlope(sumChart.slice(0,6)),s10=calcSlope(sumChart.slice(0,10));
  if(s3>0.2&&s6>0.1&&s10>0) return {signal:"T",conf:0.63,detail:`Momentum 3 khung ↑ (${s3.toFixed(1)}/${s6.toFixed(1)}/${s10.toFixed(1)})`};
  if(s3<-0.2&&s6<-0.1&&s10<0) return {signal:"X",conf:0.63,detail:`Momentum 3 khung ↓ (${s3.toFixed(1)}/${s6.toFixed(1)}/${s10.toFixed(1)})`};
  if(s3>0.3&&s10<-0.1) return {signal:"X",conf:0.58,detail:`Phân kỳ âm: tăng ngắn vs giảm dài`};
  if(s3<-0.3&&s10>0.1) return {signal:"T",conf:0.58,detail:`Phân kỳ dương: giảm ngắn vs tăng dài`};
  return null;
}
function analyzeZigzag(sumChart) {
  if(sumChart.length<8) return null;
  const n=Math.min(sumChart.length,16),sub=[...sumChart.slice(0,n)].reverse(); let flips=0;
  for(let i=1;i<n-1;i++){ if((sub[i]>sub[i-1]&&sub[i]>sub[i+1])||(sub[i]<sub[i-1]&&sub[i]<sub[i+1])) flips++; }
  const r=flips/(n-2);
  if(r>0.65){ const s=calcSlope(sumChart.slice(0,3)); return {signal:s>0?"X":"T",conf:Math.min(0.60+r*0.10,0.72),detail:`Zigzag ${Math.round(r*100)}% → đảo`}; }
  if(r<0.25){ const s=calcSlope(sumChart.slice(0,5)); return {signal:s>=0?"T":"X",conf:0.58,detail:`Zigzag thưa → tiếp xu hướng`}; }
  return null;
}
function analyzeCongestion(sumChart) {
  if(sumChart.length<6) return null;
  const sub=sumChart.slice(0,Math.min(sumChart.length,8)),rng=Math.max(...sub)-Math.min(...sub);
  if(rng<=3){ const s=calcSlope(sub); return {signal:s>=0?"T":"X",conf:0.58,detail:`Tắc nghẽn range=${rng} → breakout`}; }
  return null;
}

// ════════════════════════════════════════════════════════════════════
//  CORE PREDICTOR v7
// ════════════════════════════════════════════════════════════════════
function predictByVirtualChart(hist) {
  if(hist.length<6) return {next:"?",nextDisplay:"Chưa đủ dữ liệu",conf:50,confDisplay:"50%",patternName:"N/A",signals:[],charts:null,rsi:null};
  const N=Math.min(hist.length,50);
  const {sumChart,diceCharts,typeSeq}=buildVirtualCharts(hist,N);

  const sigPattern   =detectChartPattern(sumChart);
  const sigSlope     =analyzeSlopeAndReversion(sumChart);
  const sigSR        =analyzeSupportResistance(sumChart);
  const sigDice      =analyzeDicePhase(diceCharts);
  const sigConverge  =analyzeDiceConvergence(diceCharts);
  const sigZigzag    =analyzeZigzag(sumChart);
  const sigMomentum  =analyzeSumMomentum(sumChart);
  const sigCong      =analyzeCongestion(sumChart);
  const sigRSI       =analyzeRSI(sumChart);
  const sigMACD      =analyzeMACD(sumChart);
  const sigBoll      =analyzeBollinger(sumChart);
  const sigFib       =analyzeFibonacci(sumChart);
  const sigStreak    =analyzeStreak(typeSeq);
  const sigVProfile  =analyzeVolumeProfile(sumChart);
  const sigFinger    =analyzePatternFingerprint(typeSeq);
  const sigWave      =analyzeWaveCycle(sumChart);
  const sigATR       =analyzeATRTrend(sumChart);
  // v7 new signals
  const sigMarkov2   =analyzeMarkov2(typeSeq);
  const sigBetCau    =analyzeBetCau(typeSeq);
  const sigAltCau    =analyzeAlternatingCau(typeSeq);
  const sigSymCau    =analyzeSymmetricCau(typeSeq);
  const sigCyclicRev =analyzeCyclicReversal(typeSeq);
  const sigMultiH    =analyzeMultiEntropy(typeSeq);

  const vote={T:0.0,X:0.0},signals=[];
  const register=(sig,weight,source)=>{ if(!sig||!sig.signal) return; vote[sig.signal]+=sig.conf*weight; signals.push({source,signal:sig.signal,conf:Math.round(sig.conf*100)+"%",detail:sig.detail??sig.pattern??""}); };

  // Core technical (unchanged weights)
  register({signal:sigPattern.signal,conf:sigPattern.conf,detail:sigPattern.pattern},4.0,"Chart Pattern");
  register(sigStreak,     4.0,"Streak Bias");
  register(sigFinger,     4.0,"Pattern Fingerprint");
  register(sigRSI,        3.8,"RSI Oscillator");
  register(sigMACD,       3.5,"MACD Crossover");
  register(sigBoll,       3.5,"Bollinger Band");
  register(sigMomentum,   3.5,"3-Frame Momentum");
  register(sigZigzag,     3.0,"Zigzag Pattern");
  register(sigFib,        3.0,"Fibonacci Level");
  register(sigSlope,      3.0,"Slope+Reversion");
  register(sigVProfile,   2.8,"Volume Profile");
  register(sigSR,         2.5,"Support/Resistance");
  register(sigATR,        2.2,"ATR Trend Filter");
  register(sigDice,       2.0,"Dice Phase Sync");
  register(sigConverge,   2.0,"Dice Convergence");
  register(sigWave,       1.8,"Wave Cycle");
  register(sigCong,       1.5,"Congestion Zone");
  // v7 cầu analysis (high weights - this is the key upgrade)
  register(sigMarkov2,    5.0,"Markov Chain 2nd");
  register(sigSymCau,     5.5,"Cầu Đối Xứng");
  register(sigAltCau,     5.0,"Cầu 1-1 Xen Kẽ");
  register(sigBetCau,     4.5,"Cầu Bệt Lịch Sử");
  register(sigCyclicRev,  3.5,"Chu Kỳ Đảo Chiều");
  register(sigMultiH,     3.0,"Entropy Đa Tầng");

  const curSum=sumChart[0];
  if(curSum>=15){ vote["X"]+=0.65*1.5; signals.push({source:"Extreme Bias",signal:"X",conf:"65%",detail:`Tổng ${curSum}≥15 → hồi quy mạnh`}); }
  if(curSum<=6){  vote["T"]+=0.65*1.5; signals.push({source:"Extreme Bias",signal:"T",conf:"65%",detail:`Tổng ${curSum}≤6 → bật lên mạnh`}); }

  const tot=vote.T+vote.X;
  let next="T",rawConf=0.50;
  if(tot>1e-9){ next=vote.X>=vote.T?"X":"T"; rawConf=Math.max(vote.T,vote.X)/tot; }
  const conf=Math.min(Math.max(0.50+(rawConf-0.50)*0.75,0.50),0.84);

  // Determine main pattern label
  const cauSigs = [sigSymCau, sigAltCau, sigBetCau, sigMarkov2, sigCyclicRev].filter(Boolean);
  const mainPattern = cauSigs.length > 0
    ? (cauSigs[0].detail ?? "Cầu phân tích v7")
    : (sigPattern.signal ? sigPattern.pattern : (sigStreak?.detail ?? sigRSI?.detail ?? "Phân tích tổng hợp v7"));

  const nextDice=predictNextDiceValues(diceCharts);
  const nextSum=nextDice.d1+nextDice.d2+nextDice.d3;
  const rsiVal=calcRSI(sumChart);
  const sub50=sumChart.slice(0,Math.min(50,sumChart.length));
  const fibHi=Math.max(...sub50),fibLo=Math.min(...sub50),fibRng=fibHi-fibLo;
  const fibLevels=fibRng>=3?[0.236,0.382,0.5,0.618,0.786].map(f=>({pct:f,value:+(fibLo+fibRng*(1-f)).toFixed(2)})):[];

  // Cầu analysis summary
  const cauAnalysis = {
    markov2: sigMarkov2 ? `${sigMarkov2.signal} (${sigMarkov2.detail})` : null,
    symmetric: sigSymCau ? `${sigSymCau.signal} (${sigSymCau.detail})` : null,
    alternating: sigAltCau ? `${sigAltCau.signal} (${sigAltCau.detail})` : null,
    bet: sigBetCau ? `${sigBetCau.signal} (${sigBetCau.detail})` : null,
    cyclic: sigCyclicRev ? `${sigCyclicRev.signal} (${sigCyclicRev.detail})` : null,
    entropy: sigMultiH ? `${sigMultiH.signal} (${sigMultiH.detail})` : null,
    pattern20: typeSeq.slice(0,20).join(""),
  };

  const chartData={
    sumChart:sumChart.slice(0,25),
    diceCharts:{d1:diceCharts.d1.slice(0,25),d2:diceCharts.d2.slice(0,25),d3:diceCharts.d3.slice(0,25)},
    srLevels:findSupportResistance(sumChart.slice(0,30),1.5).slice(0,5),
    slope5:calcSlope(sumChart.slice(0,5)),
    nextDice,nextSum,
    rsi:rsiVal!==null?Math.round(rsiVal):null,
    fibLevels,
    typeSeq:typeSeq.slice(0,25),
    bollingerMid:+mean(sumChart.slice(0,12)).toFixed(2),
    bollingerUpper:+(mean(sumChart.slice(0,12))+2*stdDev(sumChart.slice(0,12))).toFixed(2),
    bollingerLower:+(mean(sumChart.slice(0,12))-2*stdDev(sumChart.slice(0,12))).toFixed(2),
    voteT:Math.round(vote.T*100)/100,
    voteX:Math.round(vote.X*100)/100,
    cauAnalysis,
  };

  return {next,nextDisplay:next==="T"?"Tài":"Xỉu",conf:Math.round(conf*100),confDisplay:Math.round(conf*100)+"%",
    patternName:mainPattern,votesT:Math.round(vote.T*100)/100,votesX:Math.round(vote.X*100)/100,
    nextDice,nextSum,rsi:rsiVal!==null?Math.round(rsiVal):null,signals,charts:chartData};
}

// ════════════════════════════════════════════════════════════════════
//  HTML BUILDER v7 — Casino Chart style matching the screenshot
// ════════════════════════════════════════════════════════════════════
function buildBandoHTML(pred, h) {
  const c=pred.charts;
  if(!c) return "<h2>Không đủ dữ liệu</h2>";
  const n=c.sumChart.length;
  const labels=JSON.stringify(Array.from({length:n},(_,i)=>{
    // labels: session numbers from history (newest = right)
    return String(h.phien - (n - 1 - i));
  }));
  const sumData=JSON.stringify([...c.sumChart].reverse());
  const d1Data=JSON.stringify([...c.diceCharts.d1].reverse());
  const d2Data=JSON.stringify([...c.diceCharts.d2].reverse());
  const d3Data=JSON.stringify([...c.diceCharts.d3].reverse());
  const typeData=JSON.stringify([...c.typeSeq].reverse());

  const predColor=pred.next==="T"?"#f5c842":"#a070ff";
  const predBg=pred.next==="T"?"rgba(245,200,66,0.13)":"rgba(160,112,255,0.13)";
  const rsiColor=pred.rsi===null?"#888":pred.rsi>=70?"#ff4444":pred.rsi<=30?"#44ff88":"#aaa";
  const rsiLabel=pred.rsi===null?"N/A":pred.rsi>=70?"Quá Mua":pred.rsi<=30?"Quá Bán":"Trung Tính";
  const totalVote=pred.votesT+pred.votesX;
  const pctT=totalVote>0?Math.round(pred.votesT/totalVote*100):50;
  const pctX=100-pctT;

  const signalRows=pred.signals.map(s=>`<tr>
    <td class="src-td">${s.source}</td>
    <td class="${s.signal==='T'?'sig-t':'sig-x'}">${s.signal==='T'?'▲ Tài':'▼ Xỉu'} <span class="conf-badge">${s.conf}</span></td>
    <td class="detail-td">${s.detail}</td>
  </tr>`).join("");

  const cau = c.cauAnalysis || {};
  const cauRows = Object.entries({
    "Markov 2 bậc": cau.markov2,
    "Cầu đối xứng": cau.symmetric,
    "Cầu 1-1 xen kẽ": cau.alternating,
    "Cầu bệt lịch sử": cau.bet,
    "Chu kỳ đảo": cau.cyclic,
    "Entropy đa tầng": cau.entropy
  }).filter(([,v])=>v).map(([k,v])=>{
    const isTai = v.startsWith("T");
    return `<tr><td class="src-td">${k}</td><td class="${isTai?'sig-t':'sig-x'}">${isTai?'▲ Tài':'▼ Xỉu'}</td><td class="detail-td">${v.replace(/^[TX] \(/,"(").replace(/\)$/,"")}</td></tr>`;
  }).join("") || `<tr><td colspan="3" style="color:#555;padding:8px">Chưa đủ mẫu cầu</td></tr>`;

  const srAnnoJS = c.srLevels.map((s,i)=>`srAnno['sr${i}']={type:'line',scaleID:'y',value:${s.value.toFixed(2)},borderColor:'rgba(255,100,50,0.28)',borderWidth:1.5,borderDash:[5,3]};`).join('\n');
  const fibAnnoJS = c.fibLevels.map((f,i)=>`fibAnno['fib${i}']={type:'line',scaleID:'y',value:${f.value},borderColor:'rgba(255,200,0,0.20)',borderWidth:1,borderDash:[2,4],label:{content:'F${Math.round(f.pct*100)}%',display:true,color:'rgba(255,200,0,0.40)',font:{size:8},position:'start'}};`).join('\n');

return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOI CẦU v7 — SUNWIN</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-annotation/3.0.1/chartjs-plugin-annotation.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#c8960a;--gold-lite:#f5c842;--tai:#f5c842;--xiu:#a070ff;
  --bg:#0d0900;--bg2:#160e03;--bg3:#1e1404;--border:rgba(180,130,10,0.30);
  --text:#e8d8a0;--text-dim:#9a7a40;
  --mono:'Share Tech Mono',monospace;--head:'Rajdhani',sans-serif;
  --grid-line:rgba(180,130,20,0.13);
  --d1:#ff3333;--d2:#22cc44;--d3:#dd88ff;
}
body{background:var(--bg);min-height:100vh;color:var(--text);font-family:var(--head);padding:10px;
  background-image:radial-gradient(ellipse at 15% 0%,rgba(120,60,0,0.22) 0%,transparent 55%),
                   radial-gradient(ellipse at 85% 100%,rgba(60,0,120,0.14) 0%,transparent 55%);}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;
  background:linear-gradient(90deg,#1e0a00,#0f0600,#1e0a00);
  border:1px solid var(--border);border-radius:10px;padding:10px 16px;margin-bottom:10px;
  position:relative;overflow:hidden;}
.hdr::before{content:'';position:absolute;inset:0;
  background:repeating-linear-gradient(90deg,transparent,transparent 38px,rgba(200,150,10,0.035) 38px,rgba(200,150,10,0.035) 39px);}
.hdr-title{font-size:1.25rem;font-weight:700;letter-spacing:4px;
  background:linear-gradient(90deg,#ffa500,#ffd700,#fff4a0,#ffd700,#ffa500);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.hdr-badge{display:flex;gap:14px;font-family:var(--mono);font-size:.78rem;color:var(--text-dim);align-items:center;}
.hdr-badge .val{color:var(--gold-lite);font-weight:bold;}
.hdr-badge .type-t{color:var(--tai);}
.hdr-badge .type-x{color:var(--xiu);}

/* METRICS */
.metrics-row{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:10px;}
.metric-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;position:relative;overflow:hidden;}
.metric-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent,var(--gold));}
.metric-label{font-size:.62rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;}
.metric-val{font-size:1.5rem;font-weight:700;font-family:var(--mono);color:var(--accent,var(--gold-lite));line-height:1;}
.metric-sub{font-size:.62rem;color:var(--text-dim);margin-top:3px;}

/* CHARTS */
.chart-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;position:relative;}
.chart-title{font-size:.66rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-dim);margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.chart-title .icon{width:20px;height:20px;background:rgba(200,150,10,0.15);border:1px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:.8rem;}

/* SUM CHART CANVAS */
#sumChart{width:100%!important;}

/* DICE CHART — styled canvas */
#diceCanvas{display:block;}

/* BEAD ROAD */
.bead-section{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;}
.bead-road{display:flex;flex-wrap:wrap;gap:5px;padding:6px 0;}
.bead{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.68rem;font-weight:700;position:relative;}
.bead-t{background:radial-gradient(circle at 35% 30%,#ffe060,#c8900a,#7a4f00);color:#fff5cc;box-shadow:0 0 6px rgba(200,150,10,0.55),inset 0 1px 0 rgba(255,240,150,0.3);}
.bead-x{background:radial-gradient(circle at 35% 30%,#c490ff,#7820ef,#3a0090);color:#e8d8ff;box-shadow:0 0 6px rgba(130,60,255,0.55),inset 0 1px 0 rgba(200,160,255,0.3);}
.bead-new::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid #fff;opacity:0.6;animation:blink 1s ease-in-out infinite;}
@keyframes blink{0%,100%{opacity:0.2}50%{opacity:0.8}}

/* VOTE BAR */
.vote-wrap{margin:8px 0 4px;}
.vote-bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.05);}
.vote-t{background:linear-gradient(90deg,#c8800a,#f5c842);}
.vote-x{background:linear-gradient(90deg,#6010c0,#a070ff);}
.vote-labels{display:flex;justify-content:space-between;font-family:var(--mono);font-size:.72rem;margin-top:4px;}
.vote-labels .lbl-t{color:var(--tai);}
.vote-labels .lbl-x{color:var(--xiu);}

/* RSI */
.rsi-row{display:flex;align-items:center;gap:10px;margin:6px 0;}
.rsi-bar-wrap{flex:1;height:10px;background:rgba(255,255,255,0.07);border-radius:5px;position:relative;overflow:visible;}
.rsi-zones{position:absolute;top:0;left:30%;width:40%;height:100%;background:rgba(255,255,255,0.05);border-radius:2px;}
.rsi-needle{position:absolute;top:-5px;width:3px;height:20px;border-radius:2px;background:#fff;box-shadow:0 0 8px rgba(255,255,255,0.7);transform:translateX(-50%);}
.rsi-tag{font-size:.66rem;min-width:55px;color:var(--text-dim);}
.rsi-val{font-family:var(--mono);font-size:.9rem;min-width:32px;text-align:right;}

/* PRED BOX */
.pred-row{display:grid;grid-template-columns:180px 1fr;gap:10px;margin-bottom:10px;}
.pred-main{background:${predBg};border:2px solid ${predColor};border-radius:12px;padding:16px;text-align:center;box-shadow:0 0 30px ${predColor}40;position:relative;overflow:hidden;}
.pred-main::before{content:'';position:absolute;inset:-60%;background:radial-gradient(circle,${predColor}0a,transparent 60%);animation:glow 3s ease-in-out infinite;}
@keyframes glow{0%,100%{opacity:0.4;transform:scale(1)}50%{opacity:1;transform:scale(1.1)}}
.pred-label{font-size:.62rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;}
.pred-val{font-size:3rem;font-weight:700;color:${predColor};text-shadow:0 0 24px ${predColor};line-height:1.1;margin:4px 0;}
.pred-phien{font-size:.7rem;color:var(--text-dim);}
.pred-conf{font-family:var(--mono);font-size:1rem;color:#fff;margin-top:2px;}
.conf-track{height:5px;background:rgba(255,255,255,0.1);border-radius:3px;margin:6px 0;overflow:hidden;}
.conf-fill{height:100%;border-radius:3px;background:${predColor};width:${pred.conf}%;}
.pred-pattern{font-size:.65rem;color:var(--gold-lite);margin-top:6px;line-height:1.4;opacity:0.85;}
.next-dice{display:flex;gap:8px;justify-content:center;margin:8px 0 4px;}
.dice-chip{width:40px;height:40px;border-radius:8px;
  background:radial-gradient(circle at 38% 32%,rgba(255,255,255,0.18),rgba(0,0,0,0.55));
  border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:1.3rem;font-weight:700;color:var(--gold-lite);
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 2px 8px rgba(0,0,0,0.5);}

/* SIGNAL TABLE */
.signals-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;overflow:hidden;}
.signals-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);margin-bottom:6px;}
.sig-table{width:100%;border-collapse:collapse;font-size:.70rem;}
.sig-table th{color:var(--text-dim);padding:3px 5px;border-bottom:1px solid var(--border);text-align:left;font-weight:400;font-size:.62rem;text-transform:uppercase;}
.sig-table td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:top;}
.src-td{color:#8a6a30;font-family:var(--mono);font-size:.66rem;}
.sig-t{color:var(--tai);font-weight:700;white-space:nowrap;}
.sig-x{color:var(--xiu);font-weight:700;white-space:nowrap;}
.conf-badge{background:rgba(255,255,255,0.10);border-radius:3px;padding:0 3px;font-size:.62rem;font-family:var(--mono);}
.detail-td{color:#8a7050;font-size:.65rem;line-height:1.3;}

/* CAU ANALYSIS */
.cau-section{background:var(--bg2);border:1px solid rgba(120,80,255,0.30);border-radius:10px;padding:10px;margin-bottom:10px;}
.cau-title{font-size:.64rem;text-transform:uppercase;letter-spacing:1px;color:#a070ff;margin-bottom:6px;display:flex;align-items:center;gap:6px;}

/* LEGEND */
.legend{display:flex;gap:12px;flex-wrap:wrap;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:.70rem;}
.legend-item{display:flex;align-items:center;gap:5px;color:var(--text-dim);}
.dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;}

/* TABS for signals/cau */
.tab-wrap{display:flex;gap:0;margin-bottom:8px;}
.tab-btn{flex:1;padding:5px;font-family:var(--mono);font-size:.68rem;background:transparent;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;transition:all .2s;}
.tab-btn:first-child{border-radius:6px 0 0 6px;}
.tab-btn:last-child{border-radius:0 6px 6px 0;}
.tab-btn.active{background:rgba(200,150,10,0.15);color:var(--gold-lite);border-color:var(--gold);}
.tab-panel{display:none;}
.tab-panel.active{display:block;}

@media(max-width:620px){
  .metrics-row{grid-template-columns:repeat(3,1fr);}
  .pred-row{grid-template-columns:1fr;}
}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-title">⬦ SOI CẦU v7 — SUNWIN ⬦</div>
  <div class="hdr-badge">
    <span>Phiên <span class="val">#${h.phien}</span></span>
    <span class="${h.type==='T'?'type-t':'type-x'} val">${h.type==='T'?'Tài':'Xỉu'}</span>
    <span>${h.dice.join('·')}</span>
    <span>Σ <span class="val">${h.tong}</span></span>
    <span style="color:#555">${new Date().toLocaleTimeString('vi-VN')}</span>
  </div>
</div>

<div class="metrics-row">
  <div class="metric-card" style="--accent:${pred.next==='T'?'var(--tai)':'var(--xiu)'}">
    <div class="metric-label">Dự Đoán</div>
    <div class="metric-val">${pred.nextDisplay}</div>
    <div class="metric-sub">Phiên #${Number(h.phien)+1}</div>
  </div>
  <div class="metric-card" style="--accent:#44aaff">
    <div class="metric-label">Độ Tin Cậy</div>
    <div class="metric-val">${pred.confDisplay}</div>
    <div class="metric-sub">${pred.signals.length} signals</div>
  </div>
  <div class="metric-card" style="--accent:${rsiColor}">
    <div class="metric-label">RSI</div>
    <div class="metric-val" style="color:${rsiColor}">${pred.rsi??'--'}</div>
    <div class="metric-sub">${rsiLabel}</div>
  </div>
  <div class="metric-card" style="--accent:#ff8844">
    <div class="metric-label">Dự Đoán Tổng</div>
    <div class="metric-val">${pred.nextSum}</div>
    <div class="metric-sub">${pred.nextDice.d1}·${pred.nextDice.d2}·${pred.nextDice.d3}</div>
  </div>
  <div class="metric-card" style="--accent:#44ff88">
    <div class="metric-label">Tổng Hiện Tại</div>
    <div class="metric-val">${h.tong}</div>
    <div class="metric-sub">${h.dice.join('·')}</div>
  </div>
</div>

<!-- BEAD ROAD -->
<div class="bead-section">
  <div class="chart-title"><span class="icon">⬤</span> Cầu Hạt — 25 Phiên (Trái→Cũ | Phải→Mới)</div>
  <div class="bead-road" id="beadRoad"></div>
  <div style="margin-top:6px;font-family:var(--mono);font-size:.62rem;color:var(--text-dim)">
    Chuỗi: <span style="color:var(--gold-lite)" id="patternStr"></span>
  </div>
</div>

<!-- VOTE BAR -->
<div class="chart-wrap" style="padding:12px 14px">
  <div class="chart-title"><span class="icon">⚖</span> Phân Bổ Phiếu Bầu Ensemble</div>
  <div class="vote-wrap">
    <div class="vote-bar">
      <div class="vote-t" style="width:${pctT}%"></div>
      <div class="vote-x" style="width:${pctX}%"></div>
    </div>
    <div class="vote-labels">
      <span class="lbl-t">▲ Tài ${pctT}% (${pred.votesT})</span>
      <span class="lbl-x">▼ Xỉu ${pctX}% (${pred.votesX})</span>
    </div>
  </div>
</div>

<!-- RSI -->
<div class="chart-wrap" style="padding:12px 14px">
  <div class="chart-title"><span class="icon">〰</span> RSI Momentum</div>
  <div class="rsi-row">
    <span class="rsi-tag" style="color:#44ff88;font-size:.65rem">Bán 30</span>
    <div class="rsi-bar-wrap">
      <div class="rsi-zones"></div>
      <div style="height:100%;border-radius:5px;background:linear-gradient(90deg,#44ff88 0%,#ffaa22 45%,#ff4444 100%);width:100%;"></div>
      <div class="rsi-needle" style="left:${pred.rsi??50}%;background:${rsiColor}"></div>
    </div>
    <span class="rsi-tag" style="color:#ff4444;font-size:.65rem;text-align:right">Mua 70</span>
    <span class="rsi-val" style="color:${rsiColor}">${pred.rsi??'--'}</span>
  </div>
</div>

<!-- SUM CHART -->
<div class="chart-wrap">
  <div class="chart-title"><span class="icon">📈</span> Biểu Đồ Tổng — Bollinger + S/R + Fibonacci</div>
  <canvas id="sumChart" height="200"></canvas>
</div>

<!-- DICE CHART -->
<div class="chart-wrap">
  <div class="chart-title"><span class="icon">🎲</span> Biểu Đồ 3 Xúc Xắc — Xu Hướng & Đồng Pha</div>
  <div style="overflow-x:auto;"><canvas id="diceCanvas"></canvas></div>
</div>

<!-- PRED + SIGNALS -->
<div class="pred-row">
  <div class="pred-main">
    <div class="pred-label">Phiên Tiếp Theo</div>
    <div class="pred-phien">#${Number(h.phien)+1}</div>
    <div class="pred-val">${pred.nextDisplay}</div>
    <div class="conf-track"><div class="conf-fill"></div></div>
    <div class="pred-conf">${pred.confDisplay}</div>
    <div style="margin:10px 0 4px;font-size:.62rem;color:var(--text-dim)">Xúc Xắc Dự Đoán</div>
    <div class="next-dice">
      <div class="dice-chip">${pred.nextDice.d1}</div>
      <div class="dice-chip">${pred.nextDice.d2}</div>
      <div class="dice-chip">${pred.nextDice.d3}</div>
    </div>
    <div class="pred-pattern">📐 ${pred.patternName}</div>
  </div>

  <div>
    <div class="tab-wrap">
      <button class="tab-btn active" onclick="switchTab('all')">Tất Cả Signals</button>
      <button class="tab-btn" onclick="switchTab('cau')">Phân Tích Cầu</button>
    </div>
    <div id="tab-all" class="tab-panel active signals-wrap">
      <div class="signals-title">${pred.signals.length} tín hiệu phân tích</div>
      <div style="max-height:280px;overflow-y:auto;">
      <table class="sig-table">
        <thead><tr><th>Thuật Toán</th><th>Tín Hiệu</th><th>Chi Tiết</th></tr></thead>
        <tbody>${signalRows||'<tr><td colspan="3" style="color:#555;padding:8px">Không có tín hiệu</td></tr>'}</tbody>
      </table>
      </div>
    </div>
    <div id="tab-cau" class="tab-panel cau-section">
      <div class="cau-title">🔗 Phân Tích Bắt Cầu v7</div>
      <div style="max-height:280px;overflow-y:auto;">
      <table class="sig-table">
        <thead><tr><th>Loại Cầu</th><th>Tín Hiệu</th><th>Chi Tiết</th></tr></thead>
        <tbody>${cauRows}</tbody>
      </table>
      </div>
    </div>
  </div>
</div>

<div class="legend">
  <div class="legend-item"><span class="dot" style="background:var(--d1)"></span>Xúc Xắc 1</div>
  <div class="legend-item"><span class="dot" style="background:var(--d2)"></span>Xúc Xắc 2</div>
  <div class="legend-item"><span class="dot" style="background:var(--d3)"></span>Xúc Xắc 3</div>
  <div class="legend-item"><span class="dot" style="background:var(--tai)"></span>Tài ≥11</div>
  <div class="legend-item"><span class="dot" style="background:var(--xiu)"></span>Xỉu ≤10</div>
  <div class="legend-item"><span class="dot" style="background:rgba(255,200,0,0.5)"></span>Fibonacci</div>
  <div class="legend-item"><span class="dot" style="background:rgba(255,100,50,0.5)"></span>S/R Level</div>
  <div class="legend-item"><span class="dot" style="background:rgba(100,200,255,0.3)"></span>Bollinger</div>
</div>

<script>
Chart.register(window['chartjs-plugin-annotation']);

// ── DATA ─────────────────────────────────────────────────────────
const LABELS    = ${labels};
const SUM_DATA  = ${sumData};
const D1_DATA   = ${d1Data};
const D2_DATA   = ${d2Data};
const D3_DATA   = ${d3Data};
const TYPE_DATA = ${typeData};
const N         = SUM_DATA.length;
const BOLL_UP   = ${c.bollingerUpper};
const BOLL_MID  = ${c.bollingerMid};
const BOLL_LOW  = ${c.bollingerLower};

// ── BEAD ROAD ────────────────────────────────────────────────────
const beadContainer = document.getElementById('beadRoad');
const patternStr    = document.getElementById('patternStr');
patternStr.textContent = [...TYPE_DATA].join('');
[...TYPE_DATA].forEach((t,i) => {
  const b = document.createElement('div');
  b.className = 'bead bead-'+(t==='T'?'t':'x')+(i===TYPE_DATA.length-1?' bead-new':'');
  b.textContent = t;
  beadContainer.appendChild(b);
});

// ── TAB SWITCH ────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  event.target.classList.add('active');
}

// ── SUM CHART ────────────────────────────────────────────────────
const ptColors  = SUM_DATA.map(v => v >= 11 ? '#b07800' : '#5010a0');
const ptBorders = SUM_DATA.map(v => v >= 11 ? '#f5c842' : '#a070ff');

// Custom plugin: draw circles with numbers inside, like screenshot
const numberedPointPlugin = {
  id: 'numberedPoints',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(3); // dataset index 3 = Tổng
    if (!meta) return;
    meta.data.forEach((pt, i) => {
      const val = SUM_DATA[i];
      if (val === undefined || val === null) return;
      const isTai = val >= 11;
      const R = 14;
      // shadow
      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x+2, pt.y+2, R, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();
      ctx.restore();
      // gradient fill
      const g = ctx.createRadialGradient(pt.x-R*.3, pt.y-R*.38, R*.05, pt.x, pt.y, R);
      if (isTai) {
        g.addColorStop(0, '#ffe060');
        g.addColorStop(0.4, '#c8900a');
        g.addColorStop(1, '#7a4f00');
      } else {
        g.addColorStop(0, '#c490ff');
        g.addColorStop(0.4, '#7820ef');
        g.addColorStop(1, '#2a0060');
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, R, 0, Math.PI*2);
      ctx.fillStyle = g;
      ctx.fill();
      // rim
      ctx.strokeStyle = isTai ? '#f5c842' : '#a070ff';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      // highlight
      const hl = ctx.createRadialGradient(pt.x-R*.32, pt.y-R*.38, 0, pt.x-R*.32, pt.y-R*.38, R*.55);
      hl.addColorStop(0, 'rgba(255,255,255,0.65)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, R, 0, Math.PI*2);
      ctx.fillStyle = hl;
      ctx.fill();
      ctx.restore();
      // number
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px Share Tech Mono,monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(val, pt.x, pt.y);
      ctx.restore();
    });
  }
};

const srAnno = {};
${srAnnoJS}
const fibAnno = {};
${fibAnnoJS}

new Chart(document.getElementById('sumChart').getContext('2d'), {
  type: 'line',
  plugins: [numberedPointPlugin],
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
      borderColor:'rgba(100,180,255,0.15)', borderWidth:1, borderDash:[6,5],
      pointRadius:0, fill:false, tension:0, order:10 },
    { label:'Tổng', data: SUM_DATA,
      borderColor:'rgba(210,175,80,0.80)', borderWidth:2.5,
      pointRadius: 16, pointHoverRadius: 18,
      pointBackgroundColor: ptColors, pointBorderColor: ptBorders, pointBorderWidth: 2,
      tension:0, fill:false, order:0 }
  ]},
  options: {
    responsive: true,
    animation: { duration: 500 },
    layout: { padding: { top: 18, bottom: 6, left: 4, right: 4 }},
    scales: {
      y: { min:3, max:18,
           ticks:{ color:'#9a7040', stepSize:3, font:{ size:11, weight:'bold', family:'Share Tech Mono' }},
           grid:{ color:'rgba(160,110,30,0.14)' },
           border:{ color:'rgba(160,100,30,0.3)' }},
      x: { ticks:{ color:'#8a6030', maxTicksLimit:15, font:{ size:9, family:'Share Tech Mono' }},
           grid:{ color:'rgba(160,110,30,0.08)' },
           border:{ color:'rgba(160,100,30,0.3)' }}
    },
    plugins: {
      legend: { display: false },
      annotation: { annotations: {
        midLine: { type:'line', scaleID:'y', value:10.5, borderColor:'rgba(255,255,255,0.12)', borderWidth:1, borderDash:[6,5] },
        taiZone: { type:'box', scaleID:'y', yMin:11, yMax:18, backgroundColor:'rgba(245,200,66,0.035)', borderWidth:0 },
        xiuZone: { type:'box', scaleID:'y', yMin:3, yMax:10.5, backgroundColor:'rgba(160,112,255,0.035)', borderWidth:0 },
        ...srAnno, ...fibAnno
      }},
      tooltip: {
        backgroundColor:'rgba(10,8,4,0.95)', titleColor:'#ffd700', bodyColor:'#f0d0a0',
        callbacks: { label: ctx => {
          const v = ctx.parsed.y;
          if (!Number.isInteger(v) && ctx.dataset.label !== 'Tổng') return ctx.dataset.label+': '+v.toFixed(1);
          return 'Tổng: '+v+' → '+(v>=11?'🟡 Tài':'🟣 Xỉu');
        }}
      }
    }
  }
});

// ── DICE CHART (Canvas 2D, styled like screenshot) ───────────────
(function drawDice() {
  const canvas = document.getElementById('diceCanvas');
  const cw = Math.max(canvas.parentElement.clientWidth - 28, 300);
  const colW = Math.max(32, Math.floor((cw - 56) / N));
  const W = colW * N + 56, H = 220;
  canvas.width = W; canvas.height = H;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const ctx = canvas.getContext('2d');

  // Background
  const bgGrad = ctx.createLinearGradient(0,0,0,H);
  bgGrad.addColorStop(0,'#160c04'); bgGrad.addColorStop(1,'#0e0702');
  ctx.fillStyle = bgGrad; ctx.fillRect(0,0,W,H);

  // Grid lines y=1..6
  const PAD_L=42, PAD_R=14, PAD_T=20, PAD_B=24;
  const plotW = W-PAD_L-PAD_R, plotH = H-PAD_T-PAD_B;
  const yOf = v => PAD_T + plotH - ((v-1)/5)*plotH;
  const xOf = i => PAD_L + (i+0.5)*(plotW/N);

  for (let v=1; v<=6; v++) {
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W-PAD_R, y);
    ctx.strokeStyle = 'rgba(180,120,30,0.18)'; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle='#9a7040'; ctx.font='bold 11px Share Tech Mono,monospace';
    ctx.textAlign='right'; ctx.textBaseline='middle'; ctx.fillText(v, PAD_L-6, y);
  }

  // x-axis session labels
  ctx.fillStyle='#7a5828'; ctx.font='9px Share Tech Mono,monospace'; ctx.textAlign='center';
  for (let i=0; i<N; i++) ctx.fillText(LABELS[i], xOf(i), H-8);

  // Series defs
  const series = [D1_DATA, D2_DATA, D3_DATA];
  const lineColors = ['#ff3333','#22cc44','#cc66ff'];
  const ballDefs = [
    { base:'#ff4444', shine:'#ff9999', shadow:'#880000' },
    { base:'#22cc44', shine:'#88ffaa', shadow:'#006620' },
    { base:'#cc66ff', shine:'#eeccff', shadow:'#660099' },
  ];

  // Shaded area between d1 and d3
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(D1_DATA[0]));
  for (let i=1; i<N; i++) ctx.lineTo(xOf(i), yOf(D1_DATA[i]));
  for (let i=N-1; i>=0; i--) ctx.lineTo(xOf(i), yOf(D3_DATA[i]));
  ctx.closePath();
  ctx.fillStyle='rgba(200,150,50,0.04)'; ctx.fill(); ctx.restore();

  // Draw connecting lines
  series.forEach((data, di) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i=1; i<N; i++) ctx.lineTo(xOf(i), yOf(data[i]));
    ctx.strokeStyle = lineColors[di]; ctx.lineWidth = 2;
    ctx.shadowColor = lineColors[di]; ctx.shadowBlur = 5;
    ctx.stroke(); ctx.restore();
  });

  // Draw 3D balls
  const R = Math.min(11, Math.floor(colW*0.30));
  function drawBall(cx, cy, def) {
    // drop shadow
    ctx.save();
    ctx.beginPath(); ctx.arc(cx+2, cy+2, R, 0, Math.PI*2);
    ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fill(); ctx.restore();
    // main gradient
    const g = ctx.createRadialGradient(cx-R*.3, cy-R*.35, R*.06, cx, cy, R);
    g.addColorStop(0, def.shine); g.addColorStop(0.45, def.base); g.addColorStop(1, def.shadow);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.fillStyle=g; ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.20)'; ctx.lineWidth=1; ctx.stroke();
    // specular
    const hl = ctx.createRadialGradient(cx-R*.32, cy-R*.38, 0, cx-R*.32, cy-R*.38, R*.52);
    hl.addColorStop(0,'rgba(255,255,255,0.70)'); hl.addColorStop(1,'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.fillStyle=hl; ctx.fill(); ctx.restore();
    // value number
    ctx.save();
    ctx.fillStyle='#fff'; ctx.font='bold 9px Share Tech Mono,monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.8)'; ctx.shadowBlur=3;
    ctx.fillText(D1_DATA.indexOf(undefined),'',cy); // placeholder—skip value label inside dice
    ctx.restore();
  }

  series.forEach((data, di) => {
    for (let i=0; i<N; i++) drawBall(xOf(i), yOf(data[i]), ballDefs[di]);
  });

  // Trend arrows at right edge
  series.forEach((data, di) => {
    const last = data[N-1], prev = data[Math.max(0,N-4)];
    const dir = last > prev ? -1 : last < prev ? 1 : 0;
    if (dir === 0) return;
    const ax = xOf(N-1) + colW*.55, ay = yOf(last);
    ctx.save();
    ctx.strokeStyle=lineColors[di]; ctx.lineWidth=2.5;
    ctx.shadowColor=lineColors[di]; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax+9, ay+dir*13); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax+9, ay+dir*13); ctx.lineTo(ax+5, ay+dir*8); ctx.lineTo(ax+13, ay+dir*8); ctx.closePath();
    ctx.fillStyle=lineColors[di]; ctx.fill(); ctx.restore();
  });

  // "NEXT" label
  ctx.save(); ctx.fillStyle='rgba(255,200,100,0.55)';
  ctx.font='bold 9px Share Tech Mono,monospace'; ctx.textAlign='center';
  ctx.fillText('NEXT →', xOf(N-1)+colW*.6, PAD_T-7); ctx.restore();
})();

// ── AUTO REFRESH ─────────────────────────────────────────────────
setTimeout(()=>location.reload(), 12000);
</script>
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
    const h=history[0], pred=predictByVirtualChart(history);
    res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
    res.end(buildBandoHTML(pred,h)); return;
  }

  if (url.pathname === "/sunlon") {
    if (!history.length) { res.writeHead(503,{"Content-Type":"application/json;charset=utf-8"}); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const h=history[0], pred=predictByVirtualChart(history);
    const pattern=history.slice(0,20).map(x=>x.type).reverse().join("");
    res.writeHead(200,{"Content-Type":"application/json;charset=utf-8","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({ phien:h.phien, xuc_xac:h.dice, ket_qua:h.type==="T"?"Tài":"Xỉu",
      phien_hien_tai:String(Number(h.phien)+1), du_doan:pred.nextDisplay,
      do_tin_cay:pred.confDisplay, pattern, dev:"@sewdangcap" })); return;
  }

  res.setHeader("Content-Type","application/json;charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");

  if (url.pathname === "/" || url.pathname === "/predict") {
    if (!history.length) { res.writeHead(503); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const h=history[0], pred=predictByVirtualChart(history);
    res.writeHead(200);
    res.end(JSON.stringify({ phien_hien_tai:h.phien, xuc_xac:h.dice, tong_hien_tai:h.tong,
      ket_qua_hien:h.type==="T"?"Tài":"Xỉu", phien_du_doan:String(Number(h.phien)+1),
      du_doan:pred.nextDisplay, do_tin_cay:pred.confDisplay, rsi:pred.rsi, id:"@sewdangcap" })); return;
  }

  if (url.pathname === "/predict/detail") {
    if (!history.length) { res.writeHead(503); res.end(JSON.stringify({loi:"Chưa có dữ liệu"})); return; }
    const pred=predictByVirtualChart(history);
    res.writeHead(200);
    res.end(JSON.stringify({ du_doan:pred.nextDisplay, do_tin_cay:pred.confDisplay,
      mau_hinh:pred.patternName, rsi:pred.rsi, phieu_tai:pred.votesT, phieu_xiu:pred.votesX,
      tin_hieu:pred.signals, bieu_do:pred.charts })); return;
  }

  if (url.pathname === "/history") {
    const lim=Math.min(parseInt(url.searchParams.get("limit")||"20"),200);
    res.writeHead(200);
    res.end(JSON.stringify({ tong_so:history.length, du_lieu:history.slice(0,lim).map(h=>({
      phien:h.phien, xuc_xac:h.dice, tong:h.tong, ket_qua:h.type==="T"?"Tài":"Xỉu" })) })); return;
  }

  if (url.pathname === "/debug") {
    const r=await fetchSource().catch(e=>({loi:e.message}));
    res.writeHead(200); res.end(JSON.stringify(r,null,2)); return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({loi:"Không tìm thấy",endpoints:["/predict","/predict/detail","/history","/bando","/sunlon","/debug"]}));

}).listen(PORT, () => {
  console.log("✅  SicBo v7.0 — Cầu Analysis Nâng Cấp — port " + PORT);
  console.log("    Dashboard : http://localhost:" + PORT + "/bando");
  console.log("    Algorithms v7: Markov2 · Cầu Đối Xứng · Cầu 1-1 · Cầu Bệt · Chu Kỳ · Entropy Đa Tầng");
  syncHistory();
  setInterval(syncHistory, 12000);
});
