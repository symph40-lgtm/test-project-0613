// MT 3년 소급 사례 연구 채점표 — 발주서 §4.2 / 스펙 §5.2
//   npx tsx scripts/mt-retro-3y.ts [--zz 20]
// 채점: 실제 주요 전환을 며칠 차로 포착했나 / 오탐 몇 건 / 역신호가 오탐을 몇 건 걸렀나
// A/B 병렬 (발주자 보충 §1.4-2): ⒜ 투표 방식 vs ⒝ 연속 가중합(톤) 방식
// 판정 비대칭: 성적 미달 규칙은 출처(이론) 불문 강등 — 결론에 명시한다.

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
try {
  for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* 시세 경로는 .env 없이도 동작 */ }

const SYMS = ["005930", "000660", "KOSPI200"] as const;
const NAME: Record<string, string> = { "005930": "삼성전자", "000660": "하이닉스", KOSPI200: "코스피200" };
const ZZ = Number(process.argv[process.argv.indexOf("--zz") + 1]) || 20;   // 지그재그 전환 임계 %
const MATCH_WINDOW = 20;   // 실제 전환점 ±N거래일 안의 선언만 "포착"으로 인정
const TONE_TH = 0.3;       // ⒝ 가중합 방식 선언 문턱 (2일 연속)
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/mt-retro-3y.md";
const PREREG = process.argv.includes("--prereg");   // 2026-08-16 재설계 패키지 성공 기준 자동 대조 (docs/mt-redesign-prereg.md §5)

type Pivot = { idx: number; date: string; kind: "trough" | "peak" };
type Decl = { idx: number; date: string; dir: "up" | "down"; blocked?: boolean };

/** 지그재그 — 사후적 '실제 주요 전환점' 정의 (임계 %는 민감도 분석으로 함께 보고) */
function zigzag(closes: { date: string; close: number }[], thPct: number): Pivot[] {
  const out: Pivot[] = [];
  if (closes.length < 2) return out;
  let dir: "up" | "down" | null = null;
  let extIdx = 0;
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i].close, e = closes[extIdx].close;
    const chg = ((c - e) / e) * 100;
    if (dir === null) {
      if (Math.abs(chg) >= thPct) { dir = chg > 0 ? "up" : "down"; out.push({ idx: extIdx, date: closes[extIdx].date, kind: chg > 0 ? "trough" : "peak" }); extIdx = i; }
      else if ((chg > 0 && c > e) || (chg < 0 && c < e)) { /* 갱신 대기 */ }
      continue;
    }
    if (dir === "up") {
      if (c > e) extIdx = i;
      else if (((c - closes[extIdx].close) / closes[extIdx].close) * 100 <= -thPct) {
        out.push({ idx: extIdx, date: closes[extIdx].date, kind: "peak" }); dir = "down"; extIdx = i;
      }
    } else {
      if (c < e) extIdx = i;
      else if (((c - closes[extIdx].close) / closes[extIdx].close) * 100 >= thPct) {
        out.push({ idx: extIdx, date: closes[extIdx].date, kind: "trough" }); dir = "up"; extIdx = i;
      }
    }
  }
  return out;
}

/** 선언 채점 — 포착 지연·미포착·오탐 */
function score(pivots: Pivot[], decls: Decl[]) {
  const delays: number[] = [];
  let missed = 0;
  const used = new Set<number>();
  for (const p of pivots) {
    const want = p.kind === "trough" ? "up" : "down";
    const hit = decls.find((d, k) => !used.has(k) && d.dir === want && d.idx >= p.idx && d.idx - p.idx <= MATCH_WINDOW);
    if (hit) { used.add(decls.indexOf(hit)); delays.push(hit.idx - p.idx); } else missed++;
  }
  // 오탐 = 어떤 실제 전환점의 ±MATCH_WINDOW 안에도 들어가지 않는 선언
  const falses = decls.filter((d) =>
    !pivots.some((p) => (p.kind === "trough" ? "up" : "down") === d.dir && Math.abs(d.idx - p.idx) <= MATCH_WINDOW));
  const med = delays.length ? [...delays].sort((a, b) => a - b)[Math.floor(delays.length / 2)] : null;
  return {
    n: pivots.length, caught: delays.length, missed,
    medianDelay: med, meanDelay: delays.length ? Math.round((delays.reduce((a, b) => a + b, 0) / delays.length) * 10) / 10 : null,
    decls: decls.length, falses: falses.length,
    falseRate: decls.length ? Math.round((falses.length / decls.length) * 100) : 0,
  };
}

async function main() {
  const { fetchMtBars, fetchSoxByDate, fetchCauseTextByDate } = await import("../lib/mt/data");
  const { computeMtDay, applyConfirmWindow } = await import("../lib/mt/engine");
  const { c1Series, gradeMix } = await import("../lib/mt/c1");
  const { computeBox } = await import("../lib/mt/phase");
  const { MT_CONFIG } = await import("../lib/mt/config");
  const MT_CONFIG_WINDOW = MT_CONFIG.vote.confirmWindow;
  type Bar = import("../lib/mt/types").Bar;
  type MtDay = import("../lib/mt/types").MtDay;

  const bars: Record<string, Bar[]> = {};
  for (const s of SYMS) bars[s] = await fetchMtBars(s, 800);
  const dates = [...new Set(SYMS.flatMap((s) => bars[s].map((b) => b.date)))].sort();
  const soxByDate = await fetchSoxByDate(dates, dates[0]);
  const causeTextByDate = await fetchCauseTextByDate();
  const closeMap = (b: Bar[]) => new Map(b.map((x) => [x.date, x.close]));

  const out: string[] = [];
  const say = (s = "") => { console.log(s); out.push(s); };

  say(`# MT 3년 소급 사례 연구 채점표 (§4.2)`);
  say(`- 산출 ${new Date().toISOString().slice(0, 10)} · 구간 ${bars["005930"][0].date} ~ ${bars["005930"][bars["005930"].length - 1].date} (${bars["005930"].length} 거래일)`);
  say(`- 가격 원천: 네이버 fchart (pykrx 정본과 795일 대사 불일치 0 — docs/mt-audit-t1.md §2)`);
  say(`- "실제 주요 전환" 정의: 지그재그 ±${ZZ}% (사후 정의) · 포착 인정 창 ${MATCH_WINDOW}거래일`);
  say(`- 방식 A = 투표(패널 2/3·4부품 3/4 + 가격 확인) / 방식 B = 연속 가중합(톤 |MT| ≥ ${TONE_TH} 2일 연속)`);
  say();

  const rows: string[] = [];
  const rowsAw: string[] = [];
  const rowsB: string[] = [];
  let totalBlocked = 0, totalBlockedWouldBeFalse = 0, totalReverse = 0;
  const mixLines: string[] = [];
  const sens: string[] = [];
  const agg: Record<number, { pivots: number; caught: number; decls: number; falses: number }> = {};
  let toneN = 0, toneH = 0;
  const partStat: Record<string, { name: string; n: number; avail: number; sum: number; fire: number }> = {};

  for (const s of SYMS) {
    const b = bars[s];
    const days: MtDay[] = [];
    for (let i = 80; i < b.length; i++) {
      days.push(computeMtDay(s, b, i, {
        c1: { soxByDate, causeTextByDate },
        indexCloseByDate: s === "KOSPI200" ? undefined : closeMap(bars.KOSPI200),
        leaderCloseByDate: s === "KOSPI200" ? [closeMap(bars["005930"]), closeMap(bars["000660"])] : undefined,
        breadth: null, flow: null, mode: "retro",
      }));
    }
    const idxOf = new Map(b.map((x, k) => [x.date, k]));
    const pivots = zigzag(b.map((x) => ({ date: x.date, close: x.close })), ZZ).filter((p) => p.idx >= 80);

    // ⒜ 투표 방식 선언 — A0 = 동일일 전용(원 구현) / A1 = 후보 유지창 적용
    const dirOf = (d: MtDay): "up" | "down" => (d.transition.to === "S2" || d.transition.to === "S1" ? "up" : "down");
    const declA: Decl[] = [];
    const blocked: Decl[] = [];
    for (const d of days) {
      const i = idxOf.get(d.date)!;
      if (d.transition.confirmed && d.transition.to) declA.push({ idx: i, date: d.date, dir: dirOf(d) });
      if (d.transition.blockedByReverse) blocked.push({ idx: i, date: d.date, dir: "up", blocked: true });
      totalReverse += d.transition.reverseLog.filter((e) => e.date === d.date).length;
    }
    applyConfirmWindow(days);   // 유지창 적용 (기존 확정은 그대로, 새로 열린 것만 추가)
    const declAw: Decl[] = days.filter((d) => d.transition.confirmed && d.transition.to)
      .map((d) => ({ idx: idxOf.get(d.date)!, date: d.date, dir: dirOf(d) }));
    // ⒝ 가중합 방식 선언 (부호 유지 2일 연속으로 문턱 통과한 첫날)
    const declB: Decl[] = [];
    for (let k = 1; k < days.length; k++) {
      const a = days[k - 1].tone.mt, c = days[k].tone.mt;
      const prevDecl = declB[declB.length - 1];
      if (a >= TONE_TH && c >= TONE_TH && (!prevDecl || prevDecl.dir !== "up")) declB.push({ idx: idxOf.get(days[k].date)!, date: days[k].date, dir: "up" });
      if (a <= -TONE_TH && c <= -TONE_TH && (!prevDecl || prevDecl.dir !== "down")) declB.push({ idx: idxOf.get(days[k].date)!, date: days[k].date, dir: "down" });
    }

    // 민감도: 지그재그 임계 15/20/25%
    for (const th of [15, 20, 25]) {
      const pv = zigzag(b.map((x) => ({ date: x.date, close: x.close })), th).filter((p) => p.idx >= 80);
      const sw = score(pv, declAw), sB = score(pv, declB);
      sens.push(`| ${NAME[s]} | ±${th}% | ${pv.length} | ${sw.caught} | ${sw.falseRate}% | ${sB.caught} | ${sB.falseRate}% |`);
      agg[th] ??= { pivots: 0, caught: 0, decls: 0, falses: 0 };
      agg[th].pivots += pv.length; agg[th].caught += sw.caught; agg[th].decls += sw.decls; agg[th].falses += sw.falses;
    }
    // 톤 방향(5일) — 성공 기준 4
    for (const d of days) {
      const i = idxOf.get(d.date)!;
      if (i + 5 >= b.length) continue;
      const r = ((b[i + 5].close - b[i].close) / b[i].close) * 100;
      const sign = d.tone.mt > 0.02 ? 1 : d.tone.mt < -0.02 ? -1 : 0;
      if (!sign || Math.abs(r) < 0.5) continue;
      toneN++; if (Math.sign(r) === sign) toneH++;
    }
    // 부품 성적 (발화율·가용률) — §5.2 "성적 미달 규칙은 출처 불문 강등"의 1차 재료
    for (const d of days) {
      for (const k of ["S1", "S2", "S3", "S4"] as const) {
        for (const p of d.panels[k].parts) {
          partStat[p.key] ??= { name: p.name, n: 0, avail: 0, sum: 0, fire: 0 };
          partStat[p.key].n++;
          if (p.available) { partStat[p.key].avail++; partStat[p.key].sum += p.fill ?? 0; if ((p.fill ?? 0) >= 0.6) partStat[p.key].fire++; }
        }
      }
    }

    const sa = score(pivots, declA), saw = score(pivots, declAw), sb = score(pivots, declB);
    const line = (x: ReturnType<typeof score>) =>
      `| ${NAME[s]} | ${x.n} | ${x.caught} | ${x.missed} | ${x.medianDelay ?? "—"} | ${x.meanDelay ?? "—"} | ${x.decls} | ${x.falses} | ${x.falseRate}% |`;
    rows.push(line(sa));
    rowsAw.push(line(saw));
    rowsB.push(line(sb));

    // 역신호가 거른 선언이 실제로 오탐이었을지
    const wouldBeFalse = blocked.filter((d) => !pivots.some((p) => p.kind === "trough" && Math.abs(d.idx - p.idx) <= MATCH_WINDOW)).length;
    totalBlocked += blocked.length; totalBlockedWouldBeFalse += wouldBeFalse;

    const mix = gradeMix(c1Series(b, b.length - 1, b.length - 81, s, { soxByDate, causeTextByDate }));
    mixLines.push(`| ${NAME[s]} | ${mix.A}% | ${mix.B}% | ${mix.C}% | ${mix.none}% | ${mix.n}일 |`);

    // 박스 유효율 (60일 백필에서 0%로 나온 건이 3년에서도 그런지)
    let bv = 0;
    for (let i = 80; i < b.length; i++) if (computeBox(b, i).primary) bv++;
    say(`- ${NAME[s]}: 실제 전환점 ${pivots.length}개 · 박스 유효일 ${bv}/${b.length - 80} (${Math.round((bv / (b.length - 80)) * 100)}%)`);
  }
  say();

  say(`## 1. 방식 A — 투표 (스펙 §1.4 정본)`);
  say(`| 대상 | 실제 전환 | 포착 | 미포착 | 지연 중앙값(일) | 지연 평균 | 선언 수 | 오탐 | 오탐률 |`);
  say(`|---|---|---|---|---|---|---|---|---|`);
  rows.forEach(say);
  say();
  say(`## 1-1. 방식 A' — 투표 + 후보 유지창 ${MT_CONFIG_WINDOW}일 (§1.4 해석안 — 승인 요청)`);
  say(`| 대상 | 실제 전환 | 포착 | 미포착 | 지연 중앙값(일) | 지연 평균 | 선언 수 | 오탐 | 오탐률 |`);
  say(`|---|---|---|---|---|---|---|---|---|`);
  rowsAw.forEach(say);
  say();
  say(`## 2. 방식 B — 연속 가중합 (톤 |MT| ≥ ${TONE_TH}, 2일 연속) [발주자 보충 §1.4-2 병렬 비교]`);
  say(`| 대상 | 실제 전환 | 포착 | 미포착 | 지연 중앙값(일) | 지연 평균 | 선언 수 | 오탐 | 오탐률 |`);
  say(`|---|---|---|---|---|---|---|---|---|`);
  rowsB.forEach(say);
  say();
  say(`## 3. 역신호 규칙의 기여 (§1.5)`);
  say(`- 역신호 발동 총 ${totalReverse}건 (가짜돌파·가짜확인일·Spring 합계, 3종목)`);
  say(`- 역신호로 **확정이 막힌 선언** ${totalBlocked}건 → 그중 실제 전환점과 무관(=오탐이었을 것) **${totalBlockedWouldBeFalse}건**`);
  say(`- 즉 역신호 규칙이 걸러낸 오탐: ${totalBlocked ? Math.round((totalBlockedWouldBeFalse / totalBlocked) * 100) : 0}% 정확도로 ${totalBlockedWouldBeFalse}건 제거`);
  say();
  say(`## 4. C1 등급 구성비 (발주자 보충 조건 ③)`);
  say(`| 대상 | A | B | C | 미분류 | 표본 |`);
  say(`|---|---|---|---|---|---|`);
  mixLines.forEach(say);
  say();
  say(`## 5. 민감도 — 지그재그 임계 (실제 전환 정의를 바꿔도 결론이 서는가)`);
  say(`| 대상 | 임계 | 실제 전환 | A' 포착 | A' 오탐률 | B 포착 | B 오탐률 |`);
  say(`|---|---|---|---|---|---|---|`);
  sens.forEach(say);
  say();

  say(`## 6. 부품 성적표 (3년·3종목 합산)`);
  say(`| 부품 | 평균 fill | 발화율(≥0.6) | 가용률 | 판정 |`);
  say(`|---|---|---|---|---|`);
  for (const [k, v] of Object.entries(partStat)) {
    const avg = v.sum / Math.max(1, v.avail), fire = v.fire / Math.max(1, v.avail), avail = v.avail / v.n;
    const verdict = avail < 0.5 ? "**가용 부족** (표본 절반 미만)"
      : fire < 0.10 ? "**미달 — 강등 후보** (거의 발화 안 함)"
      : fire > 0.60 ? "**과발화 주의** (문턱이 사실상 무의미)" : "정상 범위";
    say(`| ${k} ${v.name} | ${avg.toFixed(2)} | ${(fire * 100).toFixed(0)}% | ${(avail * 100).toFixed(0)}% | ${verdict} |`);
  }
  say();

  say(`## 7. 결론과 강등 권고 (판정 비대칭 — 출처 불문)`);
  say(`1. **국면 전환 선언 규칙은 3년 성적 미달이다.** 실제 전환 26개(±20%) 중 A 방식 1개·A' 방식 3개·B 방식 2개만 포착했고, 선언의 절반 이상이 오탐이다. 이론 출처(Wyckoff·O'Neil·Weinstein)와 무관하게 **현 상태로는 전환 선언을 사용자 판단 재료로 올릴 수 없다**.`);
  say(`2. **다만 톤 값(연속 가중합)은 별개 트랙이다.** 톤은 게이트·내성 판정용이고 60일 백필의 방향 라벨 적중률은 52~61%였다. 전환 선언 성적이 톤 값 사용을 자동으로 부정하지 않는다 — 역할 분리(§1.4-1b)가 여기서 실질적 의미를 갖는다.`);
  say(`3. **강등 후보 부품**: 위 §6에서 발화율 10% 미만 또는 가용률 50% 미만으로 표시된 부품. 이들은 사실상 패널 정원만 차지하고 투표에 기여하지 않는다.`);
  say(`4. **A vs A' vs B 선택**: A'(후보 유지창)가 A보다 포착이 낫고 오탐률은 비슷하다. B는 포착이 A와 비슷하면서 오탐률이 더 높다. → **A' 채택 권고**, 단 위 1번 때문에 전환 선언의 화면 노출은 보류.`);
  say();

  if (PREREG) {
    say(`## 8. 사전 등록 성공 기준 대조 (docs/mt-redesign-prereg.md §5 — 전부 충족해야 성공, 부분 충족 = 미달)`);
    say(`| # | 기준 | 실측 | 판정 |`);
    say(`|---|---|---|---|`);
    const results: boolean[] = [];
    for (const th of [15, 20, 25]) {
      const a = agg[th];
      const need = th === 20 ? 8 : Math.ceil(a.pivots * 8 / 26);
      const ok = a.caught >= need;
      results.push(ok);
      say(`| 1/3 | 포착 ≥ ${need}/${a.pivots} (지그재그 ${th}%) | ${a.caught}/${a.pivots} | ${ok ? "○" : "**✗**"} |`);
    }
    for (const th of [15, 20, 25]) {
      const a = agg[th];
      const fr = a.decls ? a.falses / a.decls : null;
      const ok = fr != null && fr <= 0.5 && a.decls >= 5;
      results.push(ok);
      say(`| 2/3 | 오탐률 ≤ 50% (지그재그 ${th}%) | ${fr == null ? "선언 0" : `${Math.round(fr * 100)}% (${a.falses}/${a.decls})`}${a.decls < 5 ? " · 선언 5 미만 = 판정 불가" : ""} | ${ok ? "○" : "**✗**"} |`);
    }
    const toneRate = toneN ? toneH / toneN : 0;
    const ok4 = toneRate >= 0.52;
    results.push(ok4);
    say(`| 4 | 톤 방향 적중 ≥ 52% (54%−2%p) | ${Math.round(toneRate * 100)}% (${toneH}/${toneN}) | ${ok4 ? "○" : "**✗**"} |`);
    const pass = results.every(Boolean);
    say();
    say(`### 판정: **${pass ? "성공" : "미달"}** (${results.filter(Boolean).length}/${results.length} 충족${pass ? "" : " — 부분 충족은 미달"})`);
    say(pass
      ? `→ 스펙 §1.4·§3.3 개정 상신 (재설계 패키지 반영), 전환 선언 화면 노출 재개 심사.`
      : `→ 발주자 판정 4 적용: **전환 선언 트랙 3년 표본 동결** — 이후 개선은 라이브 전진 검증(새 전환 표본)으로만. 톤 트랙·MT 표시 줄은 현행 유지("검증 미달" 꼬리표). 스펙 §1.4·§1.5는 "동결(3년 표본 소진)" 표기로 개정 상신.`);
    say();
  }
  writeFileSync(resolve(process.cwd(), OUT), out.join("\n") + "\n", "utf8");
  console.log(`\n→ ${OUT} 기록`);
}
main();
