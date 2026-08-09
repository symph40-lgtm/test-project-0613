// NM3 Layer V·C 실행 — P0 시도대장 · P1 비용 차감 · P2 초과분 성적표 · P3 DSR · P4-lite 폴드 안정성
// (docs/nm3-spec-v0.1.md PART 3·5·8 — 판정 불변 회계·검증 레이어, 게이트 없음):
//   npx tsx scripts/nm3-v.ts
// 주의: NM3 D5의 "국장 0.01% 반영 완료"는 코드와 다름 — simLadder/simV2도 수수료 미차감 (SOXX 결산 문자에
// "수수료 미차감" 명시와 동일). 본 스크립트는 3모델 전부 비용 차감 재계산한다.
// P4(워크포워드 상수 재적합)는 IMPL_SPEC 필요 — 여기서는 재적합 없는 폴드 분해(안정성 리포트)만.
// 레그 미러는 pg1-a1.ts와 동일 (simLadder/simV2 parity assert — 회전 수 집계 목적).
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { candleJudgeStream, unitArr, simLadder, fisherFirstKr } from "../lib/predict/candleWindow";
import { isHighVolDay } from "../lib/predict/indicators";
import { simV2, cumStream, ssv2FisherCfg } from "../lib/predict/ssV2";
import { runFisher } from "../lib/predict/models/fisher";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2)) * (a.length / Math.max(1, a.length - 1))); };

// ── DSR (Bailey–López de Prado). Φ·Φ⁻¹ 근사(Acklam). vSR은 시도 SR 분산의 표준 근사 사용(주석 명기). ──
function phi(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x: number): number {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function invPhi(p: number): number {
  // Acklam 근사
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function dsr(returns: number[], N: number): { sr: number; dsr: number; srMax: number } {
  const T = returns.length, m = mean(returns), sd = std(returns);
  const sr = m / sd;
  const g3 = mean(returns.map(x => ((x - m) / sd) ** 3));
  const g4 = mean(returns.map(x => ((x - m) / sd) ** 4));
  const denom = Math.max(1e-9, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr);
  const vSR = denom / (T - 1); // 시도 간 SR 분산의 표준 근사 (개별 시도 SR 미보존 — 대장 한계, 문서 명기)
  const EULER = 0.5772156649;
  const srMax = Math.sqrt(vSR) * ((1 - EULER) * invPhi(1 - 1 / N) + EULER * invPhi(1 - 1 / (N * Math.E)));
  return { sr, srMax, dsr: phi(((sr - srMax) * Math.sqrt(T - 1)) / Math.sqrt(denom)) };
}
function foldReport(label: string, series: { date: string; v: number }[], k = 6) {
  const per = Math.ceil(series.length / k);
  const cells: string[] = [];
  for (let i = 0; i < k; i++) {
    const seg = series.slice(i * per, (i + 1) * per).map(s => s.v);
    if (seg.length) cells.push(`F${i + 1} ${s1(seg.reduce((a, b) => a + b, 0))}`);
  }
  console.log(`  [P4-lite] ${label} 폴드 합계: ${cells.join(" · ")}`);
}
function dsrReport(label: string, rets: number[], Ns: number[]) {
  const parts = Ns.map(N => { const r = dsr(rets, N); return `N=${N}: DSR ${r.dsr.toFixed(3)}`; });
  const r1 = dsr(rets, Ns[0]);
  console.log(`  [P3] ${label}: 일간 SR ${r1.sr.toFixed(3)} (연환산 ~${(r1.sr * Math.sqrt(252)).toFixed(2)}) · ${parts.join(" · ")}  [게이트 0.95]`);
}

// ── 국장 (하닉 사다리 · 삼전 v2) ─────────────────────────────
type Day = { date: string; reg: MinuteBar[]; bars: MinuteBar[]; hist: PredictDailyBar[]; r10: number; d: PredictDailyBar };
function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const daily: PredictDailyBar[] = []; const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    const pre = load(code + "NX-" + date + ".json") ?? [];
    const hist = daily.slice(-120);
    const d: PredictDailyBar = { date, open: reg[0].open, close: reg[reg.length - 1].close, high: Math.max(...reg.map(b => b.high)), low: Math.min(...reg.map(b => b.low)), volume: 0 };
    if (hist.length >= 15) out.push({ date, reg, bars: [...pre, ...reg], hist, r10: hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10, d });
    daily.push(d);
  }
  return out;
}
// 회전(매매 변) 집계용 레그 카운트 — pg1-a1.ts 미러와 동일 구조 (사이즈 가중 변 수: 진입+청산 = 2×size)
function krSides(bars: MinuteBar[], r10: number, isHx: boolean, trs: { i: number; to: string; px: number }[], fJv2: { i: number; t: number; dir: 1 | -1; px: number } | null, defense: boolean, highVol: boolean): number {
  const legs: { size: number }[] = [];
  const cw = trs.length ? { t: hm(bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
  const fJ = isHx ? fisherFirstKr(bars, r10) : fJv2;
  const fFirst = fJ && (!cw || fJ.t < cw.t);
  if (isHx) {
    if (fFirst && fJ) {
      const opp = cw && cw.dir !== fJ.dir;
      legs.push({ size: 0.3 * (defense ? 0.5 : 1) });
      let held = 0.3;
      const evs: { i: number; target: number }[] = [];
      if (fJ.i + 5 < bars.length && (bars[fJ.i + 5].close - fJ.px) * fJ.dir >= 0.1 * r10) evs.push({ i: fJ.i + 5, target: 0.7 });
      for (let k = fJ.i + 1; k < bars.length; k++) if ((bars[k].close - fJ.px) * fJ.dir >= 0.3 * r10) { evs.push({ i: k, target: 1.0 }); break; }
      if (cw && cw.dir === fJ.dir) evs.push({ i: cw.i, target: 1.0 });
      evs.sort((a, b) => a.i - b.i);
      for (const ev of evs) {
        if (opp && cw && ev.i >= cw.i) break;
        const add = ev.target - held; if (add <= 0) continue;
        legs.push({ size: add }); held = ev.target;
      }
      if (opp) legs.push({ size: 1.0 });
    } else if (cw) legs.push({ size: 1.0 });
  } else {
    if (fFirst && fJ) {
      const opp = cw && cw.dir !== fJ.dir;
      legs.push({ size: 0.3 });
      if (cw && cw.dir === fJ.dir) legs.push({ size: 0.7 });
      if (opp) legs.push({ size: 1.0 });
    } else if (cw) {
      legs.push({ size: 1.0 });
      if (fJ && fJ.dir !== cw.dir) legs.push({ size: 1.0 });
    }
  }
  return legs.reduce((a, l) => a + 2 * l.size, 0); // 변(매매 횟수, 사이즈 가중)
}

function runKr(name: string, code: string, isHx: boolean, Ns: number[]) {
  const days = collect(code);
  const stopPct = isHx ? 2.5 : 1.5;
  const cuts: boolean[] = [];
  const rows: { date: string; gross: number; sides: number; bench: number }[] = [];
  for (const D of days) {
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const fT = !isHx && D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
    const fJv2 = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const prevCut2 = cuts.slice(-3).filter(Boolean).length >= 2;
    const highVol = isHighVolDay(D.hist);
    const gross = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs as never, prevCut2 || gapBig, highVol).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJv2, C.newModel.ssV2.win).pnl;
    cuts.push(gross <= -2.4);
    const sides = krSides(D.bars, D.r10, isHx, trs, fJv2, prevCut2 || gapBig, highVol);
    // 대조군 (V4): 무신호 09시 롱 + 동일 스탑 + 종가 청산
    const e = D.reg[0].open; let bench: number | null = null;
    for (const b of D.reg.slice(1)) if (b.low <= e * (1 - stopPct / 100)) { bench = -stopPct; break; }
    if (bench === null) bench = ((D.d.close - e) / e) * 100;
    rows.push({ date: D.date, gross, sides, bench });
  }
  const G = rows.reduce((a, r) => a + r.gross, 0);
  const B = rows.reduce((a, r) => a + r.bench, 0);
  const sidesTot = rows.reduce((a, r) => a + r.sides, 0);
  console.log(`\n════ ${name} — ${rows.length}일 ════`);
  console.log(`  [P1] 총 매매 변 ${sidesTot.toFixed(0)}회(사이즈 가중) — 계좌 기준 비용(2x ETF, 본주%p 환산 = 계좌/2):`);
  for (const slip of [0, 0.02, 0.05]) {
    const costAcct = sidesTot * (0.01 + slip);
    console.log(`    수수료 0.01%+슬리피지 ${slip.toFixed(2)}%/변 → 계좌 -${costAcct.toFixed(1)}%p = 본주 -${(costAcct / 2).toFixed(1)}%p → 순 ${s1(G - costAcct / 2)}%p (총 ${s1(G)})`);
  }
  console.log(`  [P2] 대조군(09시 무신호 롱+스탑${stopPct}%) ${s1(B)}%p → 초과 ${s1(G - B)}%p (월평균 초과 ${s2((G - B) / (rows.length / 21))}%p)`);
  const netRets = rows.map(r => r.gross - (r.sides * 0.03) / 2); // 기본 가정 0.01+0.02 슬리피지
  console.log(`  [V5상수] μ_bt(순) ${mean(netRets).toFixed(4)} · σ_bt ${std(netRets).toFixed(4)} · 평균비용/일 ${(mean(rows.map(r => (r.sides * 0.03) / 2))).toFixed(4)} (본주 %p/일)`);
  dsrReport(`${name} 순수익(기본 비용)`, netRets, Ns);
  dsrReport(`${name} 초과수익(순-대조군)`, rows.map((r, i) => netRets[i] - r.bench), Ns);
  foldReport(name, rows.map(r => ({ date: r.date, v: r.gross })));
}

// ── SOXX ─────────────────────────────────────────────────────
async function runSoxx(Ns: number[]) {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const rows: { date: string; gross: number; sides: number; bench: number }[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 }); // 라이브 주기준
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const sc = scoreSoxxDay(raw, c1, fJ, reg[reg.length - 1].close, nextOpen, true, true); // 보호+프리장 확인가 (주기준)
    // 회전 변: F선행+반대창 = 2왕복, 그 외 판정일 = 1왕복
    const fFirst = fJ && (!c1 || fJ.t < c1.t);
    const rt = fFirst && fJ ? (c1 && c1.dir !== fJ.dir ? 2 : 1) : c1 ? 1 : 0;
    // 대조군 (V4): 매일 정규장 시가 매수 → 다음 세션 시가 청산 (모델과 동일한 1박 노출 구조의 베타)
    const bench = nextOpen !== null ? ((nextOpen - reg[0].open) / reg[0].open) * 100 : ((reg[reg.length - 1].close - reg[0].open) / reg[0].open) * 100;
    rows.push({ date, gross: sc.p, sides: rt * 2, bench });
  }
  const G = rows.reduce((a, r) => a + r.gross, 0);
  const B = rows.reduce((a, r) => a + r.bench, 0);
  const sidesTot = rows.reduce((a, r) => a + r.sides, 0);
  console.log(`\n════ SOXX v2 (주기준 rebox+보호+프리장확인가) — ${rows.length}일 ════`);
  console.log(`  [P1] 총 매매 변 ${sidesTot}회 — 3x ETF 계좌 기준 비용(SOXX%p 환산 = 계좌/3):`);
  for (const slip of [0, 0.03, 0.05, 0.10]) {
    const costAcct = sidesTot * (0.07 + slip);
    console.log(`    수수료 0.07%+슬리피지 ${slip.toFixed(2)}%/변 → 계좌 -${costAcct.toFixed(1)}%p = SOXX -${(costAcct / 3).toFixed(1)}%p → 순 ${s1(G - costAcct / 3)}%p (총 ${s1(G)})`);
  }
  console.log(`  [P2] 대조군(매일 시가 매수→다음 세션 시가) ${s1(B)}%p → 초과 ${s1(G - B)}%p`);
  const netRets = rows.map(r => r.gross - (r.sides * 0.10) / 3); // 기본 가정 0.07+0.03
  console.log(`  [V5상수] μ_bt(순) ${mean(netRets).toFixed(4)} · σ_bt ${std(netRets).toFixed(4)} · 평균비용/일 ${(mean(rows.map(r => (r.sides * 0.10) / 3))).toFixed(4)} (SOXX %p/일)`);
  dsrReport(`SOXX 순수익(기본 비용)`, netRets, Ns);
  dsrReport(`SOXX 초과수익(순-대조군)`, rows.map((r, i) => netRets[i] - r.bench), Ns);
  foldReport("SOXX", rows.map(r => ({ date: r.date, v: r.gross })));
}

// ── P0 시도 대장 (소급 — 문서화된 시도만, 개별 결과 미보존은 한계로 명기) ──
function buildLedger() {
  const ledger = {
    createdAt: "2026-08-09",
    note: "소급 대장 — 가이드 기각표·커밋·스크립트 헤더에 문서화된 시도만 집계. 개별 시도의 일별 수익 시계열은 미보존(대장 한계). 이후 신규 백테스트는 실행 전 등록.",
    families: [
      { model: "하닉", family: "기각표 13항목(가이드 §7)", trials: 13, source: "docs/new-model-guide.md §7" },
      { model: "하닉", family: "창판정 눈금 k 스윕(0.5/0.75/1.0/1.5)·창 5/6/7봉", trials: 7, source: "scripts/candle-window-judge.ts 헤더" },
      { model: "하닉", family: "사다리·서킷·레짐·완충·0930 OR·박스시각 평원 스윕", trials: 40, source: "ladder3/circuit-breaker/vol-regime/or0930-live-sweep (추정 하한)" },
      { model: "하닉", family: "1박 자격·비중 9축·애프터 청산 7임계·F정의 2종", trials: 20, source: "kr-overnight-* 스크립트군" },
      { model: "하닉", family: "PG-1 v0.1·v0.2·A1 (이익보호 계열)", trials: 18, source: "pg1-replay/pg1-a1 (2026-08-09)" },
      { model: "삼전", family: "하닉 이식 320조합", trials: 320, source: "가이드 §7 '합격 0/320'" },
      { model: "삼전", family: "v2 창크기·문턱·rebox 스윕(30여)", trials: 35, source: "가이드 §11·ss-cw-* 스크립트군" },
      { model: "삼전", family: "1박·PG-1 계열", trials: 30, source: "kr-overnight-*·pg1-*" },
      { model: "SOXX", family: "창크기 격자·5분/1분·E0/E1·심판 방향", trials: 20, source: "가이드 §12·soxx-* 스크립트군" },
      { model: "SOXX", family: "rebox 시각 스윕·보호청산 T스윕·프리장 진입·컷오프·재난선", trials: 45, source: "soxx-f-rebox/open-protect/pre-entry/pregate-sweep (추정 하한)" },
      { model: "SOXX", family: "기각 언급(재점화·반대점화·횡보필터·저녁신호 등)", trials: 15, source: "가이드 §12·커밋 로그" },
    ] as { model: string; family: string; trials: number; source: string }[],
  };
  const byModel = new Map<string, number>();
  for (const f of ledger.families) byModel.set(f.model, (byModel.get(f.model) ?? 0) + f.trials);
  writeFileSync(resolve(process.cwd(), "trial_ledger.json"), JSON.stringify(ledger, null, 2));
  console.log(`\n[P0] trial_ledger.json 소급 구축 — 문서화 하한 N: ${[...byModel].map(([m, n]) => `${m} ${n}`).join(" · ")} (개별 결과 미보존 → DSR은 N 하한과 10× 스트레스 병기)`);
  return byModel;
}

async function main() {
  console.log("NM3 Layer V·C 실행 (P0→P1→P2→P3→P4-lite) — 판정 불변, 회계·검증만");
  const byModel = buildLedger();
  const NsOf = (m: string) => { const n = byModel.get(m) ?? 100; return [n, n * 10]; };
  runKr("하이닉스(4단 사다리)", "000660", true, NsOf("하닉"));
  runKr("삼성전자(v2)", "005930", false, NsOf("삼전"));
  await runSoxx(NsOf("SOXX"));
  console.log(`\n[비고] P4 정식(폴드별 상수 재적합 워크포워드)·R/M/G 챌린저는 IMPL_SPEC 후 착수 — NM3 v0.1은 그 수준의 정의가 없음(스펙 자체도 P5 사전등록을 P6 전 요구).`);
}
main();
