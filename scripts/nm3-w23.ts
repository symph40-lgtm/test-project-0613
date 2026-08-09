// NM3 트랙 A — W2 규칙별 순기여 재심 + W3-1 상관·노출·헤어컷 (IMPL_SPEC_TrackA §C·§D1, D-2 착수 지시):
//   npx tsx scripts/nm3-w23.ts
// §0 증거 체제 준수: 본 산출은 회계(귀속)·리스크 측정 용도 — 규칙 제거·채택의 직접 근거 아님.
// W2 사전등록 선행 확인: 예상 등급은 IMPL_SPEC §C2에 커밋 fd37dd2(2026-08-10)로 등록됨 — 본 실행이 후행.
// 귀속 방법 = 반사실 차분: 순기여(규칙) = [현행 총이익 − 규칙 제거판 총이익] − [규칙이 유발한 추가 변 × 단가].
// 비용 단가(기본 슬리피지): 국장 (0.01+0.02)%/변 → 본주 환산 /2 · SOXX (0.07+0.03)%/변 → SOXX 환산 /3.
import { readdirSync, readFileSync, existsSync } from "fs";
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
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar, type SoxxJ } from "../lib/signal/us/soxxV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";

const CACHE = resolve(process.cwd(), ".predict-cache");
const KR_SIDE = 0.03 / 2, US_SIDE = 0.10 / 3; // 변당 비용 (본주·SOXX %p 환산)
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;
const hm = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a: number[]) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.map(x => (x - m) ** 2).reduce((p, q) => p + q, 0) / (a.length - 1)) : NaN; };
const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };

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

// 국장 하루 컨텍스트 (판정·베이스 pnl·최대 노출·이견 여부)
type KrDay = { date: string; pnl: number; noReentry: number; scoutOnly: number; expo: number; opp: boolean; dSides: number };
function krDays(code: string, isHx: boolean): KrDay[] {
  const days = collect(code);
  const cuts: boolean[] = [];
  const out: KrDay[] = [];
  const STOP = isHx ? 2.5 : 1.5;
  const trFn = (bars: MinuteBar[], close: number, i0: number, dir: 1 | -1, px: number, size: number, forceI?: number, forcePx?: number): number => {
    if (size <= 0) return 0;
    const s = STOP / 100;
    const lim = forceI ?? bars.length;
    for (let k = i0 + 1; k < lim; k++) { const b = bars[k]; if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return -STOP * size; }
    const px2 = forceI !== undefined ? (forcePx ?? close) : close;
    return ((px2 - px) / px) * 100 * dir * size;
  };
  for (const D of days) {
    const unitS = unitArr(D.bars, D.r10).map(u => u * (isHx ? C.newModel.cwUnitScale : 1));
    const trs = isHx ? candleJudgeStream(D.bars, unitS) : cumStream(D.bars, unitArr(D.bars, D.r10), C.newModel.ssV2.tan, C.newModel.ssV2.win);
    const fT = !isHx && D.bars.length >= 20 ? (runFisher({ date: D.date, dailyHistory: D.hist, openPx: D.bars[0].open, morning: D.bars, prevDayMinutes: null }, ssv2FisherCfg()).transitions ?? []) : [];
    const fIdx = fT.length ? D.bars.findIndex(b => b.time === fT[0].time) : -1;
    const fJv2 = fT.length && fIdx >= 0 ? { i: fIdx, t: hm(fT[0].time), dir: (fT[0].to === "up" ? 1 : -1) as 1 | -1, px: fT[0].px } : null;
    const prevClose = D.hist[D.hist.length - 1].close;
    const gapBig = Math.abs(((D.reg[0].open - prevClose) / prevClose) * 100) >= 4;
    const defense = cuts.slice(-3).filter(Boolean).length >= 2 || gapBig;
    const hv = isHighVolDay(D.hist);
    const cw = trs.length ? { t: hm(D.bars[trs[0].i].time), i: trs[0].i, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px } : null;
    const fJ = isHx ? fisherFirstKr(D.bars, D.r10) : fJv2;
    const base = isHx
      ? simLadder(D.bars, D.r10, D.d.close, trs as never, defense, hv).pnl
      : simV2(D.bars, D.r10, D.d.close, C.newModel.ssV2.tan, fJv2, C.newModel.ssV2.win).pnl;
    cuts.push(base <= -2.4);
    const fFirst = fJ && (!cw || fJ.t < cw.t);
    const opp = !!(fFirst && fJ && cw && cw.dir !== fJ.dir) || !!(!fFirst && cw && fJ && fJ.dir !== cw.dir);
    // 반사실 1 — 재진입/역진입 제거판: fFirst&&opp면 정찰·증액은 그대로(창에서 강제청산), 재진입 없음 /
    //   창선행&&F반대(삼전 E1)면 창 레그를 종가까지 보유·역진입 없음
    let noReentry = base;
    if (fFirst && fJ && cw && cw.dir !== fJ.dir) {
      noReentry = base - trFn(D.bars, D.d.close, cw.i, cw.dir, cw.px, 1.0); // 재진입 레그 pnl 제거
    } else if (!fFirst && cw && fJ && fJ.dir !== cw.dir) {
      const withE1 = trFn(D.bars, D.d.close, cw.i, cw.dir, cw.px, 1.0, fJ.i, fJ.px) + trFn(D.bars, D.d.close, fJ.i, fJ.dir, fJ.px, 1.0);
      const withoutE1 = trFn(D.bars, D.d.close, cw.i, cw.dir, cw.px, 1.0);
      noReentry = base - withE1 + withoutE1;
    }
    // 반사실 2 — 증액 제거판 (하닉만 의미): 정찰 0.3 고정 (fFirst 케이스만 차이)
    let scoutOnly = base;
    if (isHx && fFirst && fJ) {
      const oppI = cw && cw.dir !== fJ.dir ? cw.i : undefined, oppPx = cw && cw.dir !== fJ.dir ? cw.px : undefined;
      const scout = trFn(D.bars, D.d.close, fJ.i, fJ.dir, fJ.px, 0.3, oppI, oppPx) * (defense ? 0.5 : 1);
      const reent = oppI !== undefined && cw ? trFn(D.bars, D.d.close, cw.i, cw.dir, cw.px, 1.0, hv ? trs.find(x => x.i > trs[0].i && x.to !== trs[0].to)?.i : undefined, hv ? trs.find(x => x.i > trs[0].i && x.to !== trs[0].to)?.px : undefined) : 0;
      scoutOnly = scout + reent;
    }
    // 최대 노출 (W3-1): fFirst = 사다리 최대 단계 도달치 근사(창동의·전진폭·진행성으로 1.0 아니면 0.3/0.7), 창선행 = 1.0
    let expo = 0;
    if (fFirst && fJ) {
      expo = 0.3;
      if (fJ.i + 5 < D.bars.length && (D.bars[fJ.i + 5].close - fJ.px) * fJ.dir >= 0.1 * D.r10) expo = 0.7;
      for (let k = fJ.i + 1; k < D.bars.length; k++) if ((D.bars[k].close - fJ.px) * fJ.dir >= 0.3 * D.r10) { expo = 1.0; break; }
      if (cw && cw.dir === fJ.dir) expo = 1.0;
      if (cw && cw.dir !== fJ.dir) expo = 1.0; // 이견 재진입 100%
    } else if (cw) expo = 1.0;
    if (!isHx && (fFirst && fJ)) expo = cw ? 1.0 : 0.3; // 삼전: F선행 관망(정찰 0.3 정의 없음 — simV2는 0.3 정찰) 근사 유지
    out.push({ date: D.date, pnl: base, noReentry, scoutOnly, expo, opp, dSides: opp ? 2 : 0 });
  }
  return out;
}

async function main() {
  console.log("NM3 W2·W3-1 — 사전등록(fd37dd2) 후행 실행 확인\n");
  const hx = krDays("000660", true);
  const ss = krDays("005930", false);

  // ── SOXX: 하루 스코어 + E1·보호 반사실 + 1박 플래그 ──
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map(b => b.date); const dBy = new Map(daily.map(b => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  type UsDay = { date: string; p: number; dProt: number; dE1: number; e1Sides: number; ovn: boolean };
  const us: UsDay[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const close = reg[reg.length - 1].close;
    const sc = scoreSoxxDay(raw, c1, fJ, close, nextOpen, true, true);
    const scNP = scoreSoxxDay(raw, c1, fJ, close, nextOpen, false, true);
    // E1 반사실 (F선행+창 반대): 전환 제거 = fJ 레그 종가 보유(이견일 MOC)·역진입 없음
    let dE1 = 0, e1Sides = 0;
    const fFirst = fJ && (!c1 || fJ.t < c1.t);
    if (fFirst && fJ && c1 && c1.dir !== fJ.dir) {
      const noE1: SoxxJ = fJ;
      const scNo = scoreSoxxDay(raw, null, noE1, close, null, true, true); // c1 제거 = 강제청산·역진입 소멸, 이견일이라 1박 없음(close)
      dE1 = sc.p - scNo.p; e1Sides = 2;
    }
    us.push({ date, p: sc.p, dProt: sc.p - scNP.p, dE1, e1Sides, ovn: sc.ovn });
  }

  // ── W2 귀속표 ──
  console.log("── W2 규칙별 순기여 (반사실 차분 · 기본 슬리피지) ──");
  const w2 = (label: string, grossDelta: number, sides: number, unit: number, expected: string) => {
    const cost = sides * unit;
    const net = grossDelta - cost;
    const grade = net > cost * 0.3 ? "명백 양(유지)" : net < -cost * 0.3 ? "명백 음(제거 후보)" : "경계(관찰)";
    console.log(`  ${label}: 총 ${s1(grossDelta)}%p − 귀속비용 ${cost.toFixed(1)}(${sides.toFixed(0)}변) = 순 ${s1(net)} → ${grade} [사전등록 ${expected}]`);
    return grade;
  };
  const hxRe = hx.reduce((a, d) => a + (d.pnl - d.noReentry), 0);
  const hxReS = hx.reduce((a, d) => a + d.dSides, 0);
  w2("하닉 이견 재진입", hxRe, hxReS, KR_SIDE, "양수");
  const hxLad = hx.reduce((a, d) => a + (d.pnl - d.scoutOnly), 0);
  const hxLadS = hx.filter(d => d.expo > 0.3 && !d.opp).length * 2 * 0.7; // 증액분 변 근사 (0.3→1.0 왕복 0.7×2)
  w2("하닉 사다리 증액(30→100)", hxLad, hxLadS, KR_SIDE, "양수");
  const ssE1 = ss.reduce((a, d) => a + (d.pnl - d.noReentry), 0);
  const ssE1S = ss.reduce((a, d) => a + d.dSides, 0);
  w2("삼전 E1 역진입 (최대 관심)", ssE1, ssE1S, KR_SIDE, "양수 유지");
  const usE1 = us.reduce((a, d) => a + d.dE1, 0);
  const usE1S = us.reduce((a, d) => a + d.e1Sides, 0);
  w2("SOXX E1 전환(F선행일)", usE1, usE1S, US_SIDE, "양수");
  const usProt = us.reduce((a, d) => a + d.dProt, 0);
  w2("SOXX 인버스 보호청산", usProt, 0, US_SIDE, "경계"); // 변 수 불변(청산 시점만 이동)

  // ── W3-1 상관·노출·헤어컷 ──
  console.log("\n── W3-1 상관표·동시 노출·후보 평가 (D-2 사전등록 기준: 감산·차단일 ≤25%) ──");
  // 자산 일간수익 상관 (국장 정렬)
  const hxD = collect("000660"), ssD = collect("005930");
  const hxRet = new Map(hxD.map(d => [d.date, ((d.d.close - d.hist[d.hist.length - 1].close) / d.hist[d.hist.length - 1].close) * 100]));
  const ssRet = new Map(ssD.map(d => [d.date, ((d.d.close - d.hist[d.hist.length - 1].close) / d.hist[d.hist.length - 1].close) * 100]));
  // SOXX 오버나이트(전 세션 종가→당일 세션 시가 — KR 낮과 동시간대) · 당일 cc
  const ovnRet = new Map<string, number>(); const ccRet = new Map<string, number>();
  for (let i = 1; i < daily.length; i++) {
    ovnRet.set(daily[i].date, ((daily[i].open - daily[i - 1].close) / daily[i - 1].close) * 100);
    ccRet.set(daily[i].date, ((daily[i].close - daily[i - 1].close) / daily[i - 1].close) * 100);
  }
  const common = [...hxRet.keys()].filter(d => ssRet.has(d) && ovnRet.has(d));
  const A = common.map(d => hxRet.get(d)!), B = common.map(d => ssRet.get(d)!), O = common.map(d => ovnRet.get(d)!);
  console.log(`  상관 (${common.length}일): 하닉↔삼전 ${corr(A, B).toFixed(2)} · 하닉↔SOXX밤 ${corr(A, O).toFixed(2)} · 삼전↔SOXX밤 ${corr(B, O).toFixed(2)}`);
  const hVol = std([...ovnRet.values()]) / std([...ccRet.values()]);
  console.log(`  헤어컷 계수 h = σ(SOXX 밤구간)/σ(SOXX 일간) = ${hVol.toFixed(2)} → 이월 계상 3x×${hVol.toFixed(2)} = ${(3 * hVol).toFixed(1)}x`);
  // 동시 노출 (KR 날짜 기준): carry = 직전 미 세션 1박 여부
  const usByDate = new Map(us.map(u => [u.date, u]));
  const usDates = us.map(u => u.date);
  const hxBy = new Map(hx.map(d => [d.date, d])), ssBy = new Map(ss.map(d => [d.date, d]));
  const krDates = hx.map(d => d.date).filter(d => ssBy.has(d));
  type Ex = { date: string; kr: number; carry: boolean };
  const exs: Ex[] = [];
  for (const d of krDates) {
    const prevUs = usDates.filter(x => x < d).pop();
    const carry = prevUs ? usByDate.get(prevUs)!.ovn : false;
    exs.push({ date: d, kr: 2 * (hxBy.get(d)!.expo + ssBy.get(d)!.expo), carry });
  }
  const rho = { ab: corr(A, B), ao: corr(A, O), bo: corr(B, O) };
  const evalCand = (label: string, carryX: (c: boolean) => number, effFn?: (kr: number, cx: number, hxE: number, ssE: number) => number) => {
    for (const L of [3, 4, 5, 6, 7]) { // 6·7 = 확장 격자 (사전등록 {3,4,5} 전체 미달 실측 후 D-3 참고용 — 명시 구분)
      let reduced = 0;
      for (const e of exs) {
        const hxE = 2 * hxBy.get(e.date)!.expo, ssE = 2 * ssBy.get(e.date)!.expo;
        const cx = carryX(e.carry);
        const tot = effFn ? effFn(e.kr, cx, hxE, ssE) : e.kr + cx;
        if (tot > L) reduced++;
      }
      const pct = Math.round(reduced / exs.length * 100);
      process.stdout.write(`    L=${L}: 감산·차단 ${pct}%${pct <= 25 ? "✓" : "✗"}`);
    }
    console.log(`  ← ${label}`);
  };
  console.log(`  후보별 감산·차단일 비율 (기준 ≤25%):`);
  evalCand("(a) 명목 합산", c => (c ? 3 : 0));
  evalCand("(b) 상관 가중", c => (c ? 3 : 0), (kr, cx, hxE, ssE) => Math.sqrt(hxE ** 2 + ssE ** 2 + cx ** 2 + 2 * hxE * ssE * rho.ab + 2 * hxE * cx * rho.ao + 2 * ssE * cx * rho.bo));
  evalCand(`(c) 이월 헤어컷 h=${hVol.toFixed(2)}`, c => (c ? 3 * hVol : 0));
  // 꼬리: 결합 계좌 일손익 (국장 2x 모델 pnl + SOXX 밤 3x×carry)
  const comb = exs.filter(e => hxBy.has(e.date) && ovnRet.has(e.date)).map(e =>
    2 * hxBy.get(e.date)!.pnl + 2 * ssBy.get(e.date)!.pnl + (e.carry ? 3 * (ovnRet.get(e.date) ?? 0) : 0));
  const sorted = [...comb].sort((a, b) => a - b);
  const cvar5 = mean(sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05))));
  console.log(`  결합 계좌 일손익 (${comb.length}일): 최악 ${s2(Math.min(...comb))}% · CVaR5 ${s2(cvar5)}% · 1박 이월일 ${exs.filter(e => e.carry).length}/${exs.length}`);
}
main();
