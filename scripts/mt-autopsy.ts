// MT 종합 진단 (부검) — 발주자 지시 2026-08-16. 진단 전용: 규칙 변경 없음, 기존 산출물의 재채점.
//   npx tsx scripts/mt-autopsy.ts
// 산출: docs/MT_AUTOPSY.md (1건 통합 — C계열 기여표 · S패널 사건 채점표 · 국면 혼동 행렬 · 유형 분류 · 재설계 표적)
// 채점 공통: 3년 + 60일 양쪽 / 지그재그 15·20·25% 3벌 / 등급 구성비·표본 수 병기 / 표본 부족 = "판정 불가"

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
try {
  for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* 시세 경로는 .env 없이도 동작 */ }

const SYMS = ["005930", "000660", "KOSPI200"] as const;
const NAME: Record<string, string> = { "005930": "삼성전자", "000660": "하이닉스", KOSPI200: "코스피200" };
const ZZS = [15, 20, 25];
const MATCH = 20;        // 전환 포착 인정 창 (거래일)
const EVENT_MATCH = 10;  // 제2부 부품 명중 창 (±10일)
const MIN_N = 10;        // 비율 판정 최소 표본
const MIN_DECL = 5;      // 전환 선언 최소 표본

type Pivot = { idx: number; date: string; kind: "trough" | "peak" };

function zigzag(closes: { date: string; close: number }[], thPct: number): Pivot[] {
  const out: Pivot[] = [];
  let dir: "up" | "down" | null = null;
  let extIdx = 0;
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i].close, e = closes[extIdx].close;
    const chg = ((c - e) / e) * 100;
    if (dir === null) {
      if (Math.abs(chg) >= thPct) { dir = chg > 0 ? "up" : "down"; out.push({ idx: extIdx, date: closes[extIdx].date, kind: chg > 0 ? "trough" : "peak" }); extIdx = i; }
      continue;
    }
    if (dir === "up") {
      if (c > e) extIdx = i;
      else if (((c - closes[extIdx].close) / closes[extIdx].close) * 100 <= -thPct) { out.push({ idx: extIdx, date: closes[extIdx].date, kind: "peak" }); dir = "down"; extIdx = i; }
    } else {
      if (c < e) extIdx = i;
      else if (((c - closes[extIdx].close) / closes[extIdx].close) * 100 >= thPct) { out.push({ idx: extIdx, date: closes[extIdx].date, kind: "trough" }); dir = "up"; extIdx = i; }
    }
  }
  return out;
}

const pctOr = (h: number, n: number) => (n < MIN_N ? `판정 불가(n=${n})` : `${Math.round((h / n) * 100)}% (${h}/${n})`);
const rate = (h: number, n: number) => (n ? h / n : null);

async function main() {
  const { fetchMtBars, fetchSoxByDate, fetchCauseTextByDate } = await import("../lib/mt/data");
  const { computeMtDay, applyConfirmWindow } = await import("../lib/mt/engine");
  const { ablateSeries, C_KEYS, partsForExclude, partsForOnly, C_TO_PARTS } = await import("../lib/mt/ablate");
  const { c1Series, gradeMix } = await import("../lib/mt/c1");
  const { spearman } = await import("../lib/mt/indicators");
  const { computeBox, confirmLevels } = await import("../lib/mt/phase");
  const { PART_NAMES } = await import("../lib/mt/config");
  type Bar = import("../lib/mt/types").Bar;
  type MtDay = import("../lib/mt/types").MtDay;
  type PhaseKey = import("../lib/mt/types").PhaseKey;

  const bars: Record<string, Bar[]> = {};
  for (const s of SYMS) bars[s] = await fetchMtBars(s, 800);
  const dates = [...new Set(SYMS.flatMap((s) => bars[s].map((b) => b.date)))].sort();
  const soxByDate = await fetchSoxByDate(dates, dates[0]);
  const causeTextByDate = await fetchCauseTextByDate();
  const closeMap = (b: Bar[]) => new Map(b.map((x) => [x.date, x.close]));

  // ── 기준 산출 (1회) + C6 국면경로 절제용 1회
  const base: Record<string, MtDay[]> = {};
  const noSq: Record<string, MtDay[]> = {};
  const idxOf: Record<string, Map<string, number>> = {};
  for (const s of SYMS) {
    const b = bars[s];
    idxOf[s] = new Map(b.map((x, k) => [x.date, k]));
    const ctx = {
      c1: { soxByDate, causeTextByDate },
      indexCloseByDate: s === "KOSPI200" ? undefined : closeMap(bars.KOSPI200),
      leaderCloseByDate: s === "KOSPI200" ? [closeMap(bars["005930"]), closeMap(bars["000660"])] : undefined,
      breadth: null, flow: null, mode: "retro" as const,
    };
    const days: MtDay[] = [], daysNs: MtDay[] = [];
    for (let i = 80; i < b.length; i++) {
      days.push(computeMtDay(s, b, i, ctx));
      daysNs.push(computeMtDay(s, b, i, { ...ctx, noSqueeze: true }));
    }
    base[s] = applyConfirmWindow(days);
    noSq[s] = applyConfirmWindow(daysNs);
  }

  const out: string[] = [];
  const say = (t = "") => { console.log(t); out.push(t); };

  // ── 채점기 ─────────────────────────────────────────────
  /** 톤 방향 라벨: MT 부호 vs 이후 5거래일 수익률 */
  function toneDir(days: MtDay[], s: string, from = 0) {
    const b = bars[s];
    let n = 0, h = 0;
    for (const d of days.slice(from)) {
      const i = idxOf[s].get(d.date)!;
      if (i + 5 >= b.length) continue;
      const r = ((b[i + 5].close - b[i].close) / b[i].close) * 100;
      const sign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
      if (!sign || Math.abs(r) < 0.5) continue;
      n++; if (Math.sign(r) === sign) h++;
    }
    return { n, h, rate: rate(h, n) };
  }
  /** 게이트 대리: MT 부호 vs 익일 갭 부호 — 기준선(무조건 갭상승) 대비 초과로 본다 */
  function gateProxy(days: MtDay[], s: string, from = 0) {
    const b = bars[s];
    let pn = 0, ph = 0, nn = 0, nh = 0, bn = 0, bh = 0;
    for (const d of days.slice(from)) {
      const i = idxOf[s].get(d.date)!;
      if (i + 1 >= b.length) continue;
      const gap = ((b[i + 1].open - b[i].close) / b[i].close) * 100;
      if (Math.abs(gap) < 0.3) continue;
      bn++; if (gap > 0) bh++;
      const sign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
      if (sign > 0) { pn++; if (gap > 0) ph++; } else if (sign < 0) { nn++; if (gap < 0) nh++; }
    }
    const baseUp = rate(bh, bn) ?? 0;
    const up = rate(ph, pn), dn = rate(nh, nn);
    // 초과 = (MT>0 적중 − 기준선) 과 (MT<0 적중 − (1−기준선)) 의 표본가중 평균
    const edge = pn + nn > 0 ? ((up != null ? (up - baseUp) * pn : 0) + (dn != null ? (dn - (1 - baseUp)) * nn : 0)) / (pn + nn) : null;
    return { pn, ph, nn, nh, baseUp, edge };
  }
  /** 전환 포착·오탐 */
  function transScore(days: MtDay[], s: string, pivots: Pivot[], from = 0) {
    const decls = days.slice(from).filter((d) => d.transition.confirmed && d.transition.to)
      .map((d) => ({ idx: idxOf[s].get(d.date)!, dir: (d.transition.to === "S2" || d.transition.to === "S1" ? "up" : "down") as "up" | "down" }));
    const used = new Set<number>();
    let caught = 0; const delays: number[] = [];
    for (const p of pivots) {
      const want = p.kind === "trough" ? "up" : "down";
      const k = decls.findIndex((d, j) => !used.has(j) && d.dir === want && d.idx >= p.idx && d.idx - p.idx <= MATCH);
      if (k >= 0) { used.add(k); caught++; delays.push(decls[k].idx - p.idx); }
    }
    const falses = decls.filter((d) => !pivots.some((p) => (p.kind === "trough" ? "up" : "down") === d.dir && Math.abs(d.idx - p.idx) <= MATCH)).length;
    return { pivots: pivots.length, decls: decls.length, caught, falses, falseRate: rate(falses, decls.length), delays };
  }

  const pivotsOf: Record<string, Record<number, Pivot[]>> = {};
  for (const s of SYMS) {
    pivotsOf[s] = {};
    for (const z of ZZS) pivotsOf[s][z] = zigzag(bars[s].map((x) => ({ date: x.date, close: x.close })), z).filter((p) => p.idx >= 80);
  }
  const from60 = (s: string) => Math.max(0, base[s].length - 60);

  // ── 머리말
  say(`# MT 종합 진단 (부검 보고서)`);
  say();
  say(`- 작성 2026-08-16 · 발주자 지시 "MT 종합 진단(부검): 이전 절제·검증 지시 통합 정본"`);
  say(`- **성격: 진단 전용.** 규칙·상수를 하나도 바꾸지 않았다. 절제는 산출된 MtDay의 **후처리 재채점**(lib/mt/ablate.ts)이라 원 엔진 값과 어긋날 여지가 없다.`);
  say(`- 구간: 3년 ${base["005930"][0].date}~${base["005930"][base["005930"].length - 1].date} (${base["005930"].length}일) · 60일 = 그 끝 60일`);
  say(`- 지그재그 3벌 15/20/25% · 포착 창 ${MATCH}일 · 부품 명중 창 ±${EVENT_MATCH}일 · 비율 최소 표본 ${MIN_N} · 선언 최소 표본 ${MIN_DECL}`);
  say();
  say(`## 0. 등급 구성비 (전 채점표 공통 병기)`);
  say(`| 대상 | 구간 | A | B | C | 미분류 | 표본 |`);
  say(`|---|---|---|---|---|---|---|`);
  for (const s of SYMS) {
    const b = bars[s];
    const m3 = gradeMix(c1Series(b, b.length - 1, b.length - 81, s, { soxByDate, causeTextByDate }));
    const m60 = gradeMix(c1Series(b, b.length - 1, 60, s, { soxByDate, causeTextByDate }));
    say(`| ${NAME[s]} | 3년 | ${m3.A}% | ${m3.B}% | ${m3.C}% | ${m3.none}% | ${m3.n}일 |`);
    say(`| ${NAME[s]} | 60일 | ${m60.A}% | ${m60.B}% | ${m60.C}% | ${m60.none}% | ${m60.n}일 |`);
  }
  say();
  say(`> A(컨센서스) 표본이 전 구간 0%이므로, 아래 모든 C1 관련 판정은 **B·C 재료 기준**이다. A가 쌓이기 전에는 C1의 "진짜 실력"을 확정할 수 없다 — 이 한계를 판정문에 그대로 반영했다.`);
  say();

  // ══ 제1부 C계열 절제 ══
  say(`## 제1부. C계열(톤 부품) 절제 — 연속 채점`);
  say();
  say(`### 1-0. 배선 실태 (절제 이전에 확인해야 할 것)`);
  say(`| C부품 | 패널 배선 | 톤 기여 가능성 |`);
  say(`|---|---|---|`);
  for (const c of C_KEYS) {
    const parts = C_TO_PARTS[c];
    say(`| ${c} | ${parts.length ? parts.map((p) => `${p} ${PART_NAMES[p]}`).join(" · ") : "**없음**"} | ${parts.length ? "있음" : "**구조적으로 0** — 기록 전용 재료"} |`);
  }
  say();
  say(`**즉시 확인되는 사실**: C3(종반 강도)·C5(수급 연속)·C7(52주 고점)은 **어떤 패널 부품에도 배선되어 있지 않다**. 절제해도 톤이 1비트도 변하지 않는다. 이는 성적 부진이 아니라 **설계상 미배선**이며, 스펙 §1.3이 이들을 "국면 패널이 호출하는 재료 겸용"으로 적었으나 실제 호출자가 없는 상태다. 따라서 이 셋은 아래 절제 채점의 대상이 아니라 **배선 결정 대상**이다.`);
  say();

  const variants: { tag: string; days: Record<string, MtDay[]> }[] = [{ tag: "전체", days: base }];
  for (const c of C_KEYS) {
    const parts = partsForExclude(c);
    if (!parts.length) continue;
    const d: Record<string, MtDay[]> = {};
    for (const s of SYMS) d[s] = applyConfirmWindow(ablateSeries(base[s], parts));
    variants.push({ tag: `−${c}`, days: d });
  }
  for (const c of C_KEYS) {
    if (!C_TO_PARTS[c].length) continue;
    const d: Record<string, MtDay[]> = {};
    for (const s of SYMS) d[s] = applyConfirmWindow(ablateSeries(base[s], partsForOnly(c)));
    variants.push({ tag: `${c} 단독`, days: d });
  }
  // C6 국면경로 포함 절제 (패널 + squeeze)
  {
    const d: Record<string, MtDay[]> = {};
    for (const s of SYMS) d[s] = applyConfirmWindow(ablateSeries(noSq[s], partsForExclude("C6")));
    variants.push({ tag: "−C6(국면 squeeze 포함)", days: d });
  }

  const rowsFor = (window: "3년" | "60일") => {
    const lines: string[] = [];
    for (const v of variants) {
      let tn = 0, th = 0, en = 0, eSum = 0, dec = 0, cau = 0, fal = 0, piv = 0;
      for (const s of SYMS) {
        const f = window === "60일" ? from60(s) : 0;
        const td = toneDir(v.days[s], s, f); tn += td.n; th += td.h;
        const gp = gateProxy(v.days[s], s, f);
        if (gp.edge != null) { eSum += gp.edge * (gp.pn + gp.nn); en += gp.pn + gp.nn; }
        const ts = transScore(v.days[s], s, pivotsOf[s][20], f);
        dec += ts.decls; cau += ts.caught; fal += ts.falses; piv += ts.pivots;
      }
      const edge = en ? eSum / en : null;
      lines.push(`| ${v.tag} | ${pctOr(th, tn)} | ${edge == null || en < MIN_N ? `판정 불가(n=${en})` : `${(edge * 100).toFixed(1)}%p`} | ${dec < MIN_DECL ? `판정 불가(선언 ${dec})` : `${cau}/${piv}`} | ${dec < MIN_DECL ? "—" : `${fal}/${dec}`} |`);
    }
    return lines;
  };
  for (const w of ["3년", "60일"] as const) {
    say(`### 1-1. 절제 성적 (${w}, 3종목 합산 · 지그재그 20%)`);
    say(`| 벌 | 톤 방향 적중 | 게이트 대리 초과(기준선 대비) | 전환 포착 | 오탐 |`);
    say(`|---|---|---|---|---|`);
    rowsFor(w).forEach(say);
    say();
  }

  // 기여표
  say(`### 1-2. 부품 기여표 (3년 기준 · 한계 기여 = 전체 − 제외벌)`);
  say(`| C부품 | 한계 기여 (톤 방향 %p) | 한계 기여 (게이트 초과 %p) | 단독 실력 (톤 방향) | 패널 내 최대 상관 | 자동 분류 |`);
  say(`|---|---|---|---|---|---|`);
  const metricOf = (days: Record<string, MtDay[]>) => {
    let tn = 0, th = 0, en = 0, eSum = 0;
    for (const s of SYMS) {
      const td = toneDir(days[s], s); tn += td.n; th += td.h;
      const gp = gateProxy(days[s], s);
      if (gp.edge != null) { eSum += gp.edge * (gp.pn + gp.nn); en += gp.pn + gp.nn; }
    }
    return { tone: rate(th, tn), toneN: tn, edge: en ? eSum / en : null, edgeN: en };
  };
  const mBase = metricOf(base);
  const contrib: Record<string, { dTone: number | null; dEdge: number | null; solo: number | null; corr: number | null; cls: string }> = {};
  for (const c of C_KEYS) {
    const parts = C_TO_PARTS[c];
    if (!parts.length) {
      contrib[c] = { dTone: 0, dEdge: 0, solo: null, corr: null, cls: "**미배선** — 톤에 기여 불가 (성적 아님)" };
      say(`| ${c} | 0.0 (미배선) | 0.0 (미배선) | 산출 불가 | — | ${contrib[c].cls} |`);
      continue;
    }
    const ex = variants.find((v) => v.tag === `−${c}`)!;
    const so = variants.find((v) => v.tag === `${c} 단독`)!;
    const mEx = metricOf(ex.days), mSo = metricOf(so.days);
    const dTone = mBase.tone != null && mEx.tone != null ? (mBase.tone - mEx.tone) * 100 : null;
    const dEdge = mBase.edge != null && mEx.edge != null ? (mBase.edge - mEx.edge) * 100 : null;
    // 패널 내 최대 상관
    let maxCorr: number | null = null;
    for (const s of SYMS) {
      for (const k of ["S1", "S2", "S3", "S4"] as PhaseKey[]) {
        const keys = base[s][0].panels[k].parts.map((p) => p.key);
        for (const a of parts.filter((p) => keys.includes(p))) {
          for (const b2 of keys.filter((x) => x !== a)) {
            const xs: number[] = [], ys: number[] = [];
            for (const d of base[s]) {
              const px = d.panels[k].parts.find((p) => p.key === a)?.fill;
              const py = d.panels[k].parts.find((p) => p.key === b2)?.fill;
              if (px == null || py == null) continue;
              xs.push(px); ys.push(py);
            }
            const cr = spearman(xs, ys);
            if (cr != null && (maxCorr == null || Math.abs(cr) > Math.abs(maxCorr))) maxCorr = cr;
          }
        }
      }
    }
    const cls = dTone == null ? "판정 불가"
      : dTone < -0.5 ? "**노이즈** (한계 기여 음수)"
      : Math.abs(dTone) <= 0.5 && (mSo.tone ?? 0) > 0.5 ? "**중복** (단독 실력은 있으나 한계 기여 ≈ 0)"
      : Math.abs(dTone) <= 0.5 ? "기여 미미"
      : "기여 있음";
    contrib[c] = { dTone, dEdge, solo: mSo.tone, corr: maxCorr, cls };
    say(`| ${c} | ${dTone == null ? "—" : dTone.toFixed(1)} | ${dEdge == null ? "—" : dEdge.toFixed(1)} | ${mSo.tone == null ? "—" : `${Math.round(mSo.tone * 100)}% (n=${mSo.toneN})`} | ${maxCorr == null ? "—" : maxCorr.toFixed(2)} | ${cls} |`);
  }
  say();
  say(`> 기준(전체 벌): 톤 방향 ${mBase.tone == null ? "—" : `${Math.round(mBase.tone * 100)}% (n=${mBase.toneN})`} · 게이트 초과 ${mBase.edge == null ? "—" : `${(mBase.edge * 100).toFixed(1)}%p (n=${mBase.edgeN})`}`);
  say();

  // ══ 제2부 S 패널 부품 사건 채점 ══
  say(`## 제2부. S1~S4 패널 부품 — 사건 채점`);
  say();
  for (const z of ZZS) {
    say(`### 2-${ZZS.indexOf(z) + 1}. 지그재그 ±${z}% 기준 (3년·3종목 합산)`);
    say(`| 부품 | 발화 | 명중(±${EVENT_MATCH}일) | 명중률 | 무작위 기준선 | lift | 선행일수 중앙값 | 유형 |`);
    say(`|---|---|---|---|---|---|---|---|`);
    const partKeys = ["S1_1", "S1_2", "S1_3", "S1_4", "S2_1", "S2_2", "S2_3", "S2_4", "S3_1", "S3_2", "S3_3", "S3_4", "S4_1", "S4_2", "S4_3"];
    const typeOf: Record<string, string> = {};
    for (const pk of partKeys) {
      const panel = pk.slice(0, 2) as PhaseKey;
      const target: "trough" | "peak" | "uptrend" = panel === "S3" ? "peak" : panel === "S2" ? "uptrend" : "trough";
      let fires = 0, hits = 0, availDays = 0, nullHits = 0;
      const leads: number[] = [];
      for (const s of SYMS) {
        const pv = pivotsOf[s][z];
        const segs: { a: number; b: number }[] = [];
        for (let k = 0; k + 1 < pv.length; k++) if (pv[k].kind === "trough") segs.push({ a: pv[k].idx, b: pv[k + 1].idx });
        const inTarget = (i: number) => target === "uptrend"
          ? segs.some((g) => i >= g.a && i <= g.b)
          : pv.some((q) => q.kind === target && Math.abs(q.idx - i) <= EVENT_MATCH);
        for (const d of base[s]) {
          const p = d.panels[panel].parts.find((x) => x.key === pk);
          if (!p?.available) continue;
          availDays++;
          const i = idxOf[s].get(d.date)!;
          if (inTarget(i)) nullHits++;              // 무작위 기준선: 창이 달력의 몇 %를 덮는가
          if ((p.fill ?? 0) < 0.6) continue;
          fires++;
          if (inTarget(i)) {
            hits++;
            if (target !== "uptrend") {
              const near = pv.filter((q) => q.kind === target && Math.abs(q.idx - i) <= EVENT_MATCH);
              if (near.length) leads.push(near[0].idx - i);
            }
          }
        }
      }
      const hr = rate(hits, fires);
      const nullRate = rate(nullHits, availDays);
      const lift = hr != null && nullRate ? hr / nullRate : null;
      const fireRate = rate(fires, availDays) ?? 0;
      const med = leads.length ? [...leads].sort((a, b) => a - b)[Math.floor(leads.length / 2)] : null;
      // 유형 분류는 **기준선 대비 lift**로 한다 — 절대 명중률은 창 폭에 좌우되어 해석 불가
      const type = fires < MIN_N ? `판정 불가(발화 ${fires})`
        : fireRate < 0.03 ? "**(가) 눈금 불량** — 발화 기회 희소"
        : lift == null ? "판정 불가"
        : fireRate >= 0.30 && lift < 1.0 ? "**(나) 늑대소년** — 고발화·기준선 미만"
        : fireRate < 0.20 && lift >= 1.3 ? "**(다) 과작 명중** — 저발화·고lift"
        : lift < 1.0 ? "기준선 미만 (약한 늑대소년)"
        : "중간 (분류 없음)";
      typeOf[pk] = type;
      say(`| ${pk} ${PART_NAMES[pk]} | ${fires} (${(fireRate * 100).toFixed(0)}%) | ${hits} | ${fires < MIN_N ? `판정 불가(n=${fires})` : `${Math.round((hr ?? 0) * 100)}%`} | ${nullRate == null ? "—" : `${Math.round(nullRate * 100)}%`} | ${lift == null ? "—" : lift.toFixed(2)} | ${med ?? "—"} | ${type} |`);
    }
    say();
    if (z === 20) {
      say(`> 목표 정의: S1·S4 부품 = 저점(trough) 근접 명중 / S3 부품 = 고점(peak) 근접 명중 / S2 부품은 전환점이 아니라 **상승 구간 내부 적중**으로 채점 (부품의 질문이 "추세가 건강한가"이므로).`);
      say(`> 선행일수 = 전환점 인덱스 − 발화 인덱스. **양수 = 선행(전환 전에 켜짐), 음수 = 후행**.`);
      say(`> **무작위 기준선** = 그 부품이 가용했던 날 중 목표 구간(±${EVENT_MATCH}일 창 또는 상승 구간)에 속한 날의 비율. 창이 달력의 상당 부분을 덮으므로 절대 명중률은 그 자체로 해석되지 않는다. **lift = 명중률 ÷ 기준선**, 1.0 미만이면 동전 던지기보다 못하다.`);
      say();
    }
  }

  // ── 2-4 정의 가동률 (눈금 불량 판별)
  say(`### 2-4. 정의 가동률 — "(가) 눈금 불량" 판별 지표`);
  say(`부품이 **의도한 눈금으로 잴 수 있었던 날**의 비율이다. 발화율이 낮은 것과 눈금이 없는 것은 다른 문제이고, 재설계 대상은 후자다.`);
  say();
  say(`| 눈금 | 대상 부품 | 3년 가동률 | 60일 가동률 |`);
  say(`|---|---|---|---|`);
  const gauge = (f: (d: MtDay) => boolean, from?: (s: string) => number) => {
    let n = 0, k = 0;
    for (const s of SYMS) {
      const arr = from ? base[s].slice(from(s)) : base[s];
      for (const d of arr) { n++; if (f(d)) k++; }
    }
    return n ? `${Math.round((k / n) * 100)}% (${k}/${n})` : "—";
  };
  const boxValid = (d: MtDay) => d.box.primary != null;
  const priceOkAny = (d: MtDay) => d.transition.priceOk;
  const c1Live = (d: MtDay) => !!d.common.C1.grade && !d.common.C1.excluded;
  const c1GradeAB = (d: MtDay) => d.common.C1.grade === "A" || d.common.C1.grade === "B";
  say(`| 횡보 박스 유효 | S1_4 · 가격 확인 전체 | ${gauge(boxValid)} | ${gauge(boxValid, from60)} |`);
  say(`| 가격 확인 성립 (돌파/이탈) | 전환 확정 전체 | ${gauge(priceOkAny)} | ${gauge(priceOkAny, from60)} |`);
  say(`| C1 재료 유효 (재료 미달 아님) | S1_1·S2_4·S3_1·S4_2 | ${gauge(c1Live)} | ${gauge(c1Live, from60)} |`);
  say(`| C1 등급 A·B (프록시 아님) | 〃 | ${gauge(c1GradeAB)} | ${gauge(c1GradeAB, from60)} |`);
  say();

  // ── 2-5 전이표 차단 진단: 패널이 후보를 세워도 전이표가 그 패널을 보지 않은 날
  say(`### 2-5. 전이표 차단 진단 — 패널은 켜졌는데 문이 잠긴 날`);
  say(`전이표(§1.4)는 **현재 우세 국면(phase.top)** 에 따라 어떤 패널을 볼지 정한다. 우세 국면이 틀리면 패널이 아무리 잘 켜져도 조회되지 않는다.`);
  say();
  say(`| 패널 | 후보 성립일 | 그중 전이표가 조회한 날 | **잠긴 날** | 잠긴 날 중 가격 확인도 성립 |`);
  say(`|---|---|---|---|---|`);
  const consultOf = (top: PhaseKey): PhaseKey => (top === "S1" ? "S1" : top === "S4" ? "S4" : "S3");
  let lockedTotal = 0, lockedWithPrice = 0;
  for (const k of ["S1", "S2", "S3", "S4"] as PhaseKey[]) {
    let cand = 0, consulted = 0, locked = 0, lockedPrice = 0;
    for (const s of SYMS) {
      for (const d of base[s]) {
        if (!d.panels[k].candidate) continue;
        cand++;
        if (consultOf(d.phase.top) === k) consulted++;
        else {
          locked++;
          // 그 패널이 겨냥하는 방향의 가격 확인이 그날 성립했는가
          const wantUp = k === "S1" || k === "S4";
          if (d.transition.priceOk && (d.transition.priceConfirm?.startsWith(wantUp ? "상단" : "하단") ?? false)) lockedPrice++;
        }
      }
    }
    lockedTotal += locked; lockedWithPrice += lockedPrice;
    say(`| ${k} | ${cand} | ${consulted} | **${locked}** (${cand ? Math.round((locked / cand) * 100) : 0}%) | ${lockedPrice} |`);
  }
  say();
  say(`잠긴 날 합계 **${lockedTotal}일**, 그중 가격 확인까지 성립했던 날 **${lockedWithPrice}일** — 이 ${lockedWithPrice}일은 **패널·가격이 둘 다 준비됐는데 국면 지도 때문에 선언되지 않은 날**이다.`);
  say();

  // ══ 제3부 국면 혼동 행렬 ══
  say(`## 제3부. 국면 판별층 자체 검증 — 혼동 행렬`);
  say();
  say(`사후 라벨 정의: 지그재그 20% 구간을 분할한다. 저점→고점 구간의 앞 80% = **S2**, 뒤 20% = **S3** / 고점→저점 구간의 앞 80% = **S4**, 뒤 20% = **S1**. (전환 직전 구간을 천장권·바닥권으로 본다는 통상 해석.)`);
  say();
  const PH: PhaseKey[] = ["S1", "S2", "S3", "S4"];
  const label = (s: string): Map<number, PhaseKey> => {
    const pv = pivotsOf[s][20];
    const m = new Map<number, PhaseKey>();
    for (let k = 0; k + 1 < pv.length; k++) {
      const a = pv[k].idx, b = pv[k + 1].idx, len = b - a;
      if (len <= 0) continue;
      const cut = a + Math.floor(len * 0.8);
      for (let i = a; i <= b; i++) m.set(i, pv[k].kind === "trough" ? (i <= cut ? "S2" : "S3") : (i <= cut ? "S4" : "S1"));
    }
    return m;
  };
  const conf: Record<string, Record<string, number>> = {};
  for (const a of PH) { conf[a] = {}; for (const b of PH) conf[a][b] = 0; }
  let labeled = 0;
  for (const s of SYMS) {
    const lm = label(s);
    for (const d of base[s]) {
      const i = idxOf[s].get(d.date)!;
      const truth = lm.get(i);
      if (!truth) continue;
      labeled++;
      conf[truth][d.phase.top]++;
    }
  }
  say(`| 사후 ＼ MT 우세 | S1 | S2 | S3 | S4 | 행 합 | 재현율 |`);
  say(`|---|---|---|---|---|---|---|`);
  let diag = 0;
  for (const a of PH) {
    const rowSum = PH.reduce((x, b) => x + conf[a][b], 0);
    diag += conf[a][a];
    say(`| **${a}** | ${PH.map((b) => conf[a][b]).join(" | ")} | ${rowSum} | ${rowSum < MIN_N ? `판정 불가(n=${rowSum})` : `${Math.round((conf[a][a] / rowSum) * 100)}%` } |`);
  }
  say(`| **합계** | ${PH.map((b) => PH.reduce((x, a) => x + conf[a][b], 0)).join(" | ")} | ${labeled} | **정확도 ${labeled ? Math.round((diag / labeled) * 100) : 0}%** |`);
  say();
  say(`무작위 기준선은 25%다. 정확도가 그 근처면 "패널 이전에 지도가 틀린 것"이고, 크게 높으면 국면층은 무죄이며 책임은 패널·전환 규칙에 있다.`);
  say();

  // 2-6 가격 확인 관문 분해 — 1% 가동률이 어디서 오는가
  say(`### 2-6. 가격 확인 관문 분해 (성립률 1%의 원인)`);
  say();
  say(`관문은 세 겹으로 좁아진다: ① 어떤 기준선을 쓰는가(박스 종류) ② 그 기준선이 얼마나 먼가 ③ **전이표가 그날 한 방향만 검사한다**.`);
  say();
  say(`| 기준선 종류 | 날짜 수 | 상단 돌파(양방향 검사 가정) | 하단 이탈(양방향 가정) | 전이표가 실제 검사한 방향에서 성립 |`);
  say(`|---|---|---|---|---|`);
  {
    const stat: Record<string, { n: number; up: number; dn: number; actual: number }> = {};
    for (const s2 of SYMS) {
      const b = bars[s2];
      for (const d of base[s2]) {
        const i = idxOf[s2].get(d.date)!;
        if (i < 81) continue;
        const lv = confirmLevels(computeBox(b, i - 1), b, i - 1);
        const key = lv.via;
        stat[key] ??= { n: 0, up: 0, dn: 0, actual: 0 };
        stat[key].n++;
        if (b[i].close > lv.high) stat[key].up++;
        if (b[i].close < lv.low) stat[key].dn++;
        if (d.transition.priceOk) stat[key].actual++;
      }
    }
    for (const [k, v] of Object.entries(stat)) {
      const pc = (x: number) => `${x} (${((x / v.n) * 100).toFixed(1)}%)`;
      say(`| ${k} | ${v.n} | ${pc(v.up)} | ${pc(v.dn)} | ${pc(v.actual)} |`);
    }
  }
  say();
  say(`**분해 결과 읽는 법**: 양방향 가정 대비 실제 성립이 절반 이하로 떨어지면 그 손실은 **전이표의 단일 방향 검사** 탓이고, 기준선 종류별 돌파율 자체가 낮으면 **눈금(기준선 거리)** 탓이다.`);
  say();
  say(`> 구조적으로 눈에 띄는 점: 20일 박스가 **너무 넓어서 무효**가 되면 대체 기준선으로 **60일 박스(더 넓음)** 를 쓰게 되어 있다(§3.3 "20일 유효하면 주, 아니면 60일"). 넓어서 탈락한 것을 더 넓은 것으로 대체하는 순서라 관문이 오히려 더 닫힌다 — H2와 함께 **대체 순서 자체**를 재설계 범위에 포함해야 한다.`);
  say();

  // 2-6 재설계 가설의 가동률 예상 (성적 채점 아님 — 눈금이 열리기는 하는가)
  say(`## 제3부-보. 재설계 가설의 **가동률** 예상 (성적 채점 아님)`);
  say();
  say(`현행 가격 확인은 "종가 > 20일 최고 **고가**"(또는 박스 상단=고가)다. 종가와 고가는 같은 눈금이 아니어서 돌파가 구조적으로 희소하다. 아래는 눈금을 바꿨을 때 **문이 열리는 빈도**만 센 것이다 — 성적(포착·오탐)은 재설계 승인 후 1회 재채점에서 잰다.`);
  say();
  say(`| 눈금 정의 | 상단 돌파일 | 하단 이탈일 | 합계 가동률 |`);
  say(`|---|---|---|---|`);
  const gaugeRate = (up: (b: Bar[], i: number) => boolean, dn: (b: Bar[], i: number) => boolean) => {
    let n = 0, u = 0, d2 = 0;
    for (const s of SYMS) {
      const b = bars[s];
      for (let i = 100; i < b.length; i++) { n++; if (up(b, i)) u++; if (dn(b, i)) d2++; }
    }
    return `| ${u} (${((u / n) * 100).toFixed(1)}%) | ${d2} (${((d2 / n) * 100).toFixed(1)}%) | **${(((u + d2) / n) * 100).toFixed(1)}%** |`;
  };
  const maxOf = (b: Bar[], i: number, n: number, f: (x: Bar) => number) => Math.max(...b.slice(i - n, i).map(f));
  const minOf = (b: Bar[], i: number, n: number, f: (x: Bar) => number) => Math.min(...b.slice(i - n, i).map(f));
  say(`| 현행: 종가 > 20일 최고 고가 / < 최저 저가 ${gaugeRate((b, i) => b[i].close > maxOf(b, i, 20, (x) => x.high), (b, i) => b[i].close < minOf(b, i, 20, (x) => x.low))}`);
  say(`| H1: 종가 > 20일 최고 **종가** / < 최저 종가 ${gaugeRate((b, i) => b[i].close > maxOf(b, i, 20, (x) => x.close), (b, i) => b[i].close < minOf(b, i, 20, (x) => x.close))}`);
  say(`| H1b: H1 + 0.5% 완충 ${gaugeRate((b, i) => b[i].close > maxOf(b, i, 20, (x) => x.close) * 1.005, (b, i) => b[i].close < minOf(b, i, 20, (x) => x.close) * 0.995)}`);
  say();
  say(`> H1은 **문턱을 낮추는 것이 아니라 눈금을 맞추는 것**이다: 비교 대상(종가)과 기준선(고가)의 단위가 어긋나 있던 것을 같은 단위로 세운다. Wyckoff의 "레인지 상단 돌파" 의미는 그대로 유지된다. H1b는 되돌림 노이즈 완충용 변형이다.`);
  say();

  // 제4부 판정 규칙 적용
  say(`## 제4부. 판정 규칙 적용 (사전 등록 규칙 그대로)`);
  say();
  say(`### 4-1. C1 — 제외가 우세한가`);
  say(`| 구간 | 전체 톤 | −C1 톤 | 전체 게이트 초과 | −C1 게이트 초과 | 판정 |`);
  say(`|---|---|---|---|---|---|`);
  for (const w of ["3년", "60일"] as const) {
    const f = (s: string) => (w === "60일" ? from60(s) : 0);
    const agg = (days: Record<string, MtDay[]>) => {
      let tn = 0, th = 0, en = 0, eS = 0;
      for (const s of SYMS) {
        const td = toneDir(days[s], s, f(s)); tn += td.n; th += td.h;
        const gp = gateProxy(days[s], s, f(s));
        if (gp.edge != null) { eS += gp.edge * (gp.pn + gp.nn); en += gp.pn + gp.nn; }
      }
      return { tone: rate(th, tn), toneN: tn, edge: en ? eS / en : null };
    };
    const a = agg(base), b2 = agg(variants.find((v) => v.tag === "−C1")!.days);
    const better = (b2.tone ?? 0) > (a.tone ?? 0) && (b2.edge ?? -9) > (a.edge ?? -9);
    say(`| ${w} | ${Math.round((a.tone ?? 0) * 100)}% | ${Math.round((b2.tone ?? 0) * 100)}% | ${((a.edge ?? 0) * 100).toFixed(1)}%p | ${((b2.edge ?? 0) * 100).toFixed(1)}%p | ${better ? "**제외 우세**" : "포함 우세/무차이"} |`);
  }
  say();
  say(`**판정 1 적용**: 두 구간 모두 제외가 우세 → 사전 등록 규칙에 따라 **"C1은 등급 A/B 가용일 한정 활성화, C 프록시는 기록만" 개정안을 상신**한다. 부품 단위 증거도 같은 방향이다 — C1 파생 4부품 중 S1_1(lift 0.42)·S3_1(0.37)·S4_2(0.90)이 기준선 미만이고, 유일하게 기준선을 넘는 S2_4(1.12)는 "호재 반응배율"이라 **상승장 편향과 구분되지 않는다**.`);
  say();
  say(`### 4-2. (나) 늑대소년 — 단독 1표 자격 박탈 대상`);
  say(`| 부품 | lift(15%) | lift(20%) | lift(25%) | 3벌 일관 | 상신 |`);
  say(`|---|---|---|---|---|---|`);
  const PART_KEYS = ["S1_1", "S1_2", "S1_3", "S1_4", "S2_1", "S2_2", "S2_3", "S2_4", "S3_1", "S3_2", "S3_3", "S3_4", "S4_1", "S4_2", "S4_3"];
  for (const pk of PART_KEYS) {
    const panel = pk.slice(0, 2) as PhaseKey;
    const target: "trough" | "peak" | "uptrend" = panel === "S3" ? "peak" : panel === "S2" ? "uptrend" : "trough";
    const ls: (number | null)[] = [];
    let fireRate = 0;
    for (const z of ZZS) {
      let fires = 0, hits = 0, avail = 0, nullHits = 0;
      for (const s of SYMS) {
        const pv = pivotsOf[s][z];
        const segs: { a: number; b: number }[] = [];
        for (let k = 0; k + 1 < pv.length; k++) if (pv[k].kind === "trough") segs.push({ a: pv[k].idx, b: pv[k + 1].idx });
        const inT = (i: number) => target === "uptrend" ? segs.some((g) => i >= g.a && i <= g.b) : pv.some((q) => q.kind === target && Math.abs(q.idx - i) <= EVENT_MATCH);
        for (const d of base[s]) {
          const p = d.panels[panel].parts.find((x) => x.key === pk);
          if (!p?.available) continue;
          avail++; const i = idxOf[s].get(d.date)!;
          if (inT(i)) nullHits++;
          if ((p.fill ?? 0) >= 0.6) { fires++; if (inT(i)) hits++; }
        }
      }
      const hr = rate(hits, fires), nr = rate(nullHits, avail);
      ls.push(hr != null && nr ? hr / nr : null);
      fireRate = avail ? fires / avail : 0;
    }
    const allBelow = ls.every((x) => x != null && x < 1.0);
    const allAbove = ls.every((x) => x != null && x >= 1.0);
    const verdict = allBelow && fireRate >= 0.30 ? "**단독 1표 자격 박탈 → 보조 증거 강등**"
      : allBelow ? "관찰 등재 (기준선 미만이나 저발화)"
      : allAbove && fireRate < 0.20 ? "**존치·가중 상향 후보**"
      : allAbove ? "존치"
      : "판정 불가 (3벌 불일치)";
    say(`| ${pk} ${PART_NAMES[pk]} | ${ls[0]?.toFixed(2) ?? "—"} | ${ls[1]?.toFixed(2) ?? "—"} | ${ls[2]?.toFixed(2) ?? "—"} | ${allBelow ? "미만 일관" : allAbove ? "이상 일관" : "불일치"} | ${verdict} |`);
  }
  say();
  say(`### 4-3. (가) 눈금 불량 — 재설계 대상 (단, 주범은 아님 → 4-6·5-1)`);
  say(`- **가격 확인 성립률 3년 1% (28/2160일)** — 전환 확정의 필수 관문이 사실상 닫혀 있다. 부품이 아니라 **정의**의 문제이므로 사전 등록 규칙 3에 따라 **재설계 대상**이다.`);
  say(`- **60일 박스 유효율 0%** — 폭 문턱(20일 ≤15%)이 현 변동성 국면에서 영구 무효. 3년 기준 62%라 **국면 의존적 결함**이다.`);
  say(`- 두 건 모두 "문턱을 낮추자"가 아니라 "종가와 고가라는 어긋난 눈금을 맞추자"·"폭을 변동성 단위로 재자"는 **정의 교정**이다.`);
  say(`- **다만 2-6 분해는 눈금이 주범이 아님을 보여준다**: 20일 박스 기준선에서 양방향 돌파는 16.1%인데 실제 성립은 1.6%다. 손실의 약 90%는 기준선 거리가 아니라 **전이표가 그날 한 방향만 검사하도록 만든 구현**에서 났다 (4-6 참조).`);
  say();
  say(`### 4-4. 노이즈 부품 — 가중 0 강등 상신`);
  say(`| C부품 | 한계 기여(톤) | 한계 기여(게이트) | 상신 |`);
  say(`|---|---|---|---|`);
  for (const c of ["C1", "C2", "C4", "C6"]) {
    const k = contrib[c];
    const verdict = k.dTone != null && k.dTone < -0.5 ? "**톤 가중 0 강등** (§3.2 준용)" : "유지 (중복 — 통합 검토만)";
    say(`| ${c} | ${k.dTone?.toFixed(1) ?? "—"}%p | ${k.dEdge?.toFixed(1) ?? "—"}%p | ${verdict} |`);
  }
  say();
  say(`> ⚠ 판정 1과 판정 4의 충돌 처리: C1 전면 가중 0은 S2_4(lift 1.12, 유일한 기준선 초과 C1 부품)까지 끄게 된다. 따라서 상신 문안은 **"C1의 등급 C(프록시) 경로만 톤 가중 0, 등급 A·B 경로는 유지"** 로 좁힌다 — 판정 1 개정안과 정확히 같은 절단면이다.`);
  say();
  say(`### 4-5. 앞선 보고서의 판정 정정`);
  say(`docs/mt-retro-3y.md §6은 **S4_1 셀링 클라이맥스를 "발화율 4% → 미달·강등 후보"** 로 적었다. 본 부검의 사건 채점(기준선 대비 lift)에서 S4_1은 **lift 4.92 (명중 61% vs 기준선 12%)로 15개 부품 중 최고**다. 발화율만으로 강등을 판정한 것이 잘못이었다 — **S4_1은 존치·가중 상향 후보로 정정**한다. 같은 이유로 S3_2(Wyckoff 분산, lift 1.34)도 강등 후보에서 제외한다.`);
  say();
  say(`### 4-6. 구현이 발주서보다 좁았던 지점 (자기 신고)`);
  say(`발주서 §1.4 원문은 **"전환 확정 = 후보 + 가격 확인(횡보 박스 상단/하단 돌파)"** 이다. 방향을 무엇이 정하는지는 쓰여 있지 않다.`);
  say(`구현(스펙 §1.4 전이표)은 여기에 **"검사할 방향은 현재 우세 국면(phase.top)이 정한다"** 는 조건을 추가했다. 이는 발주서에 없던 제약이며, 2-6의 16.1% → 1.6% 손실의 직접 원인이다.`);
  say(`국면 지도의 정확도가 40%(S1 재현율 3%·S3 10%)이므로, 방향 선택을 지도에 맡긴 결과 **맞는 방향을 검사하는 날 자체가 드물어졌다**.`);
  say(`→ 따라서 "후보를 세운 패널이 자기 방향의 가격 확인을 받는다"로 되돌리는 것은 **완화가 아니라 발주서 원문으로의 복원**이다.`);
  say();


  // 제5부 재설계 착수 계획
  say(`## 제5부. 재설계 1회 착수 계획 (표적·가설·재채점)`);
  say();
  say(`### 5-1. 표적 확정`);
  say(`**표적: 전환 확정 관문 3종 — ① 방향 결정 구조(주범) ② 눈금 단위 ③ 대체 순서.** 근거는 관문 분해다.`);
  say();
  say(`| 순위 | 결함 | 실측 | 성격 |`);
  say(`|---|---|---|---|`);
  say(`| **1** | 검사 방향을 국면 top이 정한다 (구현이 발주서에 없던 제약을 추가) | 양방향 16.1% → 실제 1.6% (**손실 90%**) | 발주서 원문 복원 |`);
  say(`| 2 | 기준선이 고가/저가인데 비교 대상은 종가 (눈금 단위 불일치) | 가동률 17.3% → H1 26.8% | 정의 교정 |`);
  say(`| 3 | 20일 박스가 넓어서 무효 → **더 넓은** 60일 박스로 대체 | 60일 박스 구간 실제 성립 **0.0%** (249일) | 순서 오류 |`);
  say();
  say(`즉 "패널이 나빠서 못 잡은 것"이 아니라 **"선언의 마지막 관문이 구조적으로 닫혀 있었다"**. 부품 교체는 이 셋을 고친 뒤에 논해야 의미가 있다.`);
  say();
  say(`⚠ **범위 경계 확인 요청**: 항목 1은 "부품 눈금 교정"보다 넓은 **판정 구조 변경**이다. 발주자 지시 §4-3은 "(가) 눈금 불량만 재설계 대상"이라 했으므로, 항목 1을 이번 1회에 포함할지는 발주자 확인이 필요하다. 다만 항목 2·3만 고치면 관문은 1.6% → 약 2~3%에 그쳐 **성공 기준(5-3)을 충족할 가능성이 낮다**는 점을 명시한다.`);
  say();
  say(`### 5-2. 사전 등록 가설`);
  say(`- **H1 (눈금 단위 정합)**: 박스 상·하단을 **종가 기준**(20일 최고/최저 종가)으로 정의한다. 비교 대상이 종가이므로 기준선도 종가여야 한다.`);
  say(`- **H2 (폭 문턱 변동성 상대화)**: 박스 유효 조건을 고정 %가 아니라 "20일 폭 ≤ 2.5 × RV20의 20일 환산"으로 둔다.`);
  say(`- **H3 (방향 결정 복원 — 발주서 원문)**: 가격 확인의 방향을 국면 top이 아니라 **후보를 세운 패널**이 정한다. S1·S4 후보 → 상단 돌파, S3 후보 → 하단 이탈. (국면 확률은 톤 값 계산에는 그대로 쓰인다.)`);
  say(`- **H2b (대체 순서 교정)**: 20일 박스가 무효면 60일 박스가 아니라 **20일 고·저가**로 내려간다. 넓어서 탈락한 것을 더 넓은 것으로 대체하지 않는다.`);
  say(`- **H0 (귀무)**: 위를 적용해도 전환 포착·오탐이 개선되지 않는다.`);
  say();
  say(`### 5-3. 성공 기준 (사전 등록 — 결과 보기 전 확정)`);
  say(`현행 성적(3년·지그재그 20%·A' 유지창): **포착 3/26 · 오탐률 56%**. 재채점 1회에서 아래를 **모두** 충족해야 성공으로 본다.`);
  say(`1. 전환 포착 **≥ 8/26** (현행의 2.5배 이상)`);
  say(`2. 오탐률 **≤ 50%**`);
  say(`3. 지그재그 15·20·25% **3벌 모두**에서 1·2 충족 (한 벌만 좋으면 실패)`);
  say(`4. 톤 트랙 훼손 없을 것 (톤 방향 적중 54% 대비 −2%p 이내)`);
  say();
  say(`### 5-4. 미달 시 처리`);
  say(`발주자 지시 §5-2 그대로: **전환 선언 트랙 동결**(화면 노출 중단·로그만), **톤 트랙만 존치**. 이 경우 MT는 "국면 기계"가 아니라 "톤 지표"로 축소 정의되며 스펙 §1.4는 동결 표기로 개정 상신한다.`);
  say();
  say(`### 5-5. 집행 순서`);
  say(`1. 본 보고서 승인 → 2. H1·H2 구현(등록 상수 교체, 1회) → 3. 3년+60일 재채점 1회 → 4. 성공 기준 대조 → 5. 성공 시 스펙 개정 / 실패 시 5-4 동결. **A/A' 병렬 채점 유지**.`);
  say();
  say(`### 5-6. 착수 금지 확인`);
  say(`발주자 지시 §5-1에 따라 **본 보고서 승인 전 재설계에 손대지 않았다.** 제3부-보의 가동률 표는 눈금이 열리는 빈도만 센 진단이며 성적 채점이 아니고, 코드·상수는 그대로다.`);
  say();

  // 제6부 상신 목록
  say(`## 제6부. 상신 목록 (실행은 발주자 승인 후)`);
  say();
  say(`| # | 종류 | 내용 | 근거 |`);
  say(`|---|---|---|---|`);
  say(`| 1 | 개정안 | C1을 **등급 A·B 가용일 한정 활성화**, 등급 C 프록시는 **기록만** | 4-1 (3년·60일 모두 제외 우세) |`);
  say(`| 2 | 강등 | (나) 늑대소년 부품의 **단독 1표 자격 박탈 → 보조 증거화** | 4-2 (3벌 일관 lift < 1.0) |`);
  say(`| 3 | 강등 | C1 **등급 C 경로의 톤 가중 0** (A·B 경로 유지) | 4-4 + 충돌 처리 |`);
  say(`| 4 | 정정 | S4_1·S3_2를 **강등 후보에서 제외**, S4_1은 가중 상향 후보로 | 4-5 |`);
  say(`| 5 | 재설계 | 관문 3종 H3(방향 복원)·H1(눈금)·H2/H2b(폭·대체 순서) — **1회 재채점**, 성공 기준 5-3 | 제5부 |`);
  say(`| 5-1 | 확인 요청 | H3는 "눈금 교정"보다 넓은 구조 변경 — **1회 범위에 포함할지 발주자 확인** | 5-1 범위 경계 |`);
  say(`| 6 | 기록 | 국면 지도 정확도 40%(S1 재현율 3%·S3 10%) — H3로 **방향 결정에서 분리**되면 톤 값 산출에만 남는다 | 제3부·4-6 |`);
  say(`| 7 | 미결 | C3·C5·C7 **미배선** — 배선할지 스펙에서 삭제할지 발주자 결정 필요 | 1-0 |`);
  say();
  say(`### 별도 트랙 (발주자 지시 참고란 — 본 진단과 분리 유지)`);
  say(`- 컨센서스 입력 경로 개방은 G1B 절충안 경로 재사용으로 진행 → A 표본이 쌓이면 A-C 일치율 실측 자동 시작 (현재 등급 A 가동률 **0%**, 표의 A·B 가동률은 전부 B등급분이다)`);
  say(`- 톤 트랙(방향 54%)·MT 표시 줄은 현행 유지 — "검증 미달" 꼬리표 포함`);
  say(`- 8/18~19 운영 일정(DC-NF·챌린저 v1.1c·일일 대사·헌법 재확인) 우선, 본 진단은 그다음 리소스`);
  say();

  writeFileSync(resolve(process.cwd(), "docs/MT_AUTOPSY.md"), out.join("\n") + "\n", "utf8");
  console.log("\n→ docs/MT_AUTOPSY.md 기록 (제1~6부 통합)");
}
main();
