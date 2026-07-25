// 미장 3단계 전이 모니터 완전판 사전 실측 (이월 지시 2026-07-25 ①번 — 국장 ②b의 SOXX판).
//   npx tsx scripts/us-transition-monitor-sweep.ts
//
// 질문 (적용 전 확인 사항):
//   ① 문자량 — F/M/본 각각을 08:25~15:55 ET 전 시간대 5분 폴링으로 감시하면 전이(등장·전환·소멸)가
//      하루 몇 건인가? 국장 ②b처럼 "같은 전이 1일 1회 키"로 눌렀을 때 실효 문자량은?
//   ② 확정(14:30) 이후 신규 커버 구간(14:30~15:55)의 전이가 실익이 있는가 —
//      본피셔 반전·소멸에 따라 청산/전환했을 때 잔여 손익 (7/24 삼전 13:05 유형의 미국판 검증).
//   ③ 현행 체계(체크포인트 스트림+조기경보)가 못 보내는 전이가 얼마나 되나 (M 소멸·전환,
//      F 소멸, 14:30 이후 전부).
// 데이터: 야후 SOXX 5분봉 includePrePost (60일 캘린더 캡 ≈ 39거래일) + 일봉 (avgRange10).

import YahooFinance from "yahoo-finance2";
import { runUsFisher, labelUsDay, ET_OPEN, ET_CLOSE, ET_PRE_START } from "../lib/signal/us/models";
import type { UsBar } from "../lib/signal/us/models";
import type { PredictDailyBar, Verdict } from "../lib/predict/types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

async function fetchYahoo5m(days: number): Promise<Map<string, UsBar[]>> {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - days * 86400e3), interval: "5m", includePrePost: true });
  const byDay = new Map<string, UsBar[]>();
  for (const q of r.quotes ?? []) {
    if (q.close == null || q.open == null) continue;
    const d = q.date instanceof Date ? q.date : new Date(q.date);
    const p = Object.fromEntries(etFmt.formatToParts(d).map((x) => [x.type, x.value]));
    const h = p.hour === "24" ? 0 : parseInt(p.hour, 10);
    const etMin = h * 60 + parseInt(p.minute, 10);
    const day = `${p.year}-${p.month}-${p.day}`;
    const arr = byDay.get(day) ?? [];
    arr.push({ etMin, time: `${String(h).padStart(2, "0")}:${p.minute}`, open: q.open, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close, volume: typeof q.volume === "number" ? q.volume : 0 });
    byDay.set(day, arr);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.etMin - b.etMin);
  return byDay;
}

async function fetchDaily(days: number): Promise<PredictDailyBar[]> {
  const r = await yf.chart("SOXX", { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  return (r.quotes ?? [])
    .filter((x): x is typeof x & { close: number; open: number; high: number; low: number } =>
      x.close != null && x.open != null && x.high != null && x.low != null)
    .map((x) => {
      const p = Object.fromEntries(etFmt.formatToParts(x.date instanceof Date ? x.date : new Date(x.date)).map((y) => [y.type, y.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, open: x.open, high: x.high, low: x.low, close: x.close, volume: typeof x.volume === "number" ? x.volume : 0 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

type Tier = "F" | "M" | "B";
type Trans = { day: string; tier: Tier; atMin: number; prev: Verdict; cur: Verdict; px: number };

async function main() {
  const [byDay, daily] = await Promise.all([fetchYahoo5m(59), fetchDaily(200)]);
  const days = [...byDay.keys()].sort();
  const MON_FROM = 8 * 60 + 25, MON_TO = 15 * 60 + 55, FINAL = 14 * 60 + 30;

  const allTrans: Trans[] = [];
  const perDayRaw: number[] = [], perDayKeyed: number[] = [];
  let sessions = 0;
  const labels = new Map<string, { label: Verdict; rOC: number }>();

  for (const d of days) {
    const bars = byDay.get(d)!;
    const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
    const hist = daily.filter((b) => b.date < d).slice(-120);
    if (reg.length < 60 || hist.length < 30) continue; // 반일장·결손 제외
    sessions++;
    const { label, rOC } = labelUsDay(reg, 0.9, 0.65, 0.35);
    labels.set(d, { label, rOC });
    const cont = bars.filter((b) => b.etMin >= ET_PRE_START && b.etMin < ET_CLOSE);
    const st: Record<Tier, Verdict> = { F: "none", M: "none", B: "none" };
    const dayTrans: Trans[] = [];
    for (let t = MON_FROM; t <= MON_TO; t += 5) {
      const contW = cont.filter((b) => b.etMin + 5 <= t);
      const regW = reg.filter((b) => b.etMin + 5 <= t);
      const cur: Record<Tier, Verdict> = {
        F: contW.length >= 5 ? runUsFisher(contW, hist, 0.05, { confirmBars: 1, strongBreakRatio: 0.1 }).verdict : "none",
        M: contW.length >= 5 ? runUsFisher(contW, hist, 0.10, { confirmBars: 2 }).verdict : "none",
        B: regW.length >= 6 ? runUsFisher(regW, hist, 0.15, { strongBreakRatio: 0.1 }).verdict : "none",
      };
      for (const tier of ["F", "M", "B"] as Tier[]) {
        if (cur[tier] !== st[tier]) {
          const px = (tier === "B" ? regW : contW).at(-1)?.close ?? NaN;
          dayTrans.push({ day: d, tier, atMin: t, prev: st[tier], cur: cur[tier], px });
          st[tier] = cur[tier];
        }
      }
    }
    allTrans.push(...dayTrans);
    perDayRaw.push(dayTrans.length);
    perDayKeyed.push(new Set(dayTrans.map((x) => `${x.tier}_${x.prev}_${x.cur}`)).size);
  }

  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
  console.log(`세션 ${sessions}일 (${days[0]} ~ ${days[days.length - 1]})`);
  console.log(`\n① 문자량 — 전이/일: 원시 평균 ${avg(perDayRaw).toFixed(1)} · 중앙 ${pct(perDayRaw, 0.5)} · 90분위 ${pct(perDayRaw, 0.9)} · 최대 ${Math.max(...perDayRaw)}`);
  console.log(`   전이 키(같은 전이 1일 1회) 적용 시: 평균 ${avg(perDayKeyed).toFixed(1)} · 중앙 ${pct(perDayKeyed, 0.5)} · 90분위 ${pct(perDayKeyed, 0.9)} · 최대 ${Math.max(...perDayKeyed)}`);
  for (const tier of ["F", "M", "B"] as Tier[]) {
    const tt = allTrans.filter((x) => x.tier === tier);
    const appear = tt.filter((x) => x.prev === "none").length;
    const die = tt.filter((x) => x.cur === "none").length;
    const flip = tt.length - appear - die;
    console.log(`   ${tier}: 총 ${tt.length} (등장 ${appear}·전환 ${flip}·소멸 ${die}) = ${(tt.length / sessions).toFixed(1)}/일`);
  }

  // ③ 현행 미커버 전이 분류
  const post = allTrans.filter((x) => x.atMin > FINAL);
  const mAll = allTrans.filter((x) => x.tier === "M" && x.atMin <= FINAL);
  const mNew = mAll.filter((x) => x.cur === "none" || x.prev !== "none" || x.atMin < 10 * 60);
  const fDie = allTrans.filter((x) => x.tier === "F" && x.cur === "none" && x.atMin <= FINAL);
  console.log(`\n③ 신규 커버 전이: 14:30 이후 전체 ${post.length}건(${(post.length / sessions).toFixed(2)}/일) · M 소멸/전환/10시전 ${mNew.length}건 · F 소멸 ${fDie.length}건`);

  // ② 14:30 이후 본피셔 전이의 실익 — 잔여 구간(전이봉 종가 → 16:00 종가)
  console.log(`\n② 14:30~15:55 본피셔 전이 실익 (잔여: 전이 시점 종가 → 16:00 종가, SOXX %):`);
  const postB = post.filter((x) => x.tier === "B");
  let saveSum = 0, switchSum = 0;
  for (const x of postB) {
    const reg = byDay.get(x.day)!.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
    const closePx = reg[reg.length - 1].close;
    const rem = ((closePx - x.px) / x.px) * 100;
    // 구판정 유지 시 잔여 손익(oldPnl) — 음수면 전이 통지로 청산해 그만큼 방어
    const oldPnl = x.prev === "leverage" ? rem : x.prev === "inverse" ? -rem : 0;
    const newPnl = x.cur === "leverage" ? rem : x.cur === "inverse" ? -rem : 0;
    saveSum += -oldPnl;
    switchSum += newPnl;
    console.log(`   ${x.day} ${minToHHMM(x.atMin)} ${x.prev}→${x.cur} · 잔여 ${rem >= 0 ? "+" : ""}${rem.toFixed(2)}% → 청산효과 ${(-oldPnl) >= 0 ? "+" : ""}${(-oldPnl).toFixed(2)}%p${x.cur !== "none" ? ` · 전환진입 ${newPnl >= 0 ? "+" : ""}${newPnl.toFixed(2)}%p` : ""} (당일 라벨 ${labels.get(x.day)?.label} rOC ${labels.get(x.day)?.rOC}%)`);
  }
  console.log(`   합계: 청산효과 ${saveSum >= 0 ? "+" : ""}${saveSum.toFixed(2)}%p · 전환진입 ${switchSum >= 0 ? "+" : ""}${switchSum.toFixed(2)}%p (${postB.length}건)`);

  // ④ 09:30창 F 반전경보 (국장 rev9의 미국판 후보) — 본피셔 방향 유지 중 정규장창
  // 피셔F(0.05·1봉·강돌파)가 반대를 확인하면 경보. 07창 F는 프리장 급등락이 OR에 들어간 날
  // 반전을 못 잡는다는 국장 근거의 SOXX 검증: 발생 빈도·본피셔 전환 선행 리드·청산 실익.
  console.log(`\n④ 09:30창 F 반전경보 후보 실측 (본피셔 방향 중 정규장창 F 반대 확인):`);
  let revN = 0, revLeadSum = 0, revLeadN = 0, revSave = 0;
  for (const d of days) {
    const bars = byDay.get(d)!;
    const reg = bars.filter((b) => b.etMin >= ET_OPEN && b.etMin < ET_CLOSE);
    const hist = daily.filter((b) => b.date < d).slice(-120);
    if (reg.length < 60 || hist.length < 30) continue;
    let bSt: Verdict = "none";
    let fired = false;
    for (let t = MON_FROM; t <= MON_TO; t += 5) {
      const regW = reg.filter((b) => b.etMin + 5 <= t);
      if (regW.length < 6) continue;
      const bV = runUsFisher(regW, hist, 0.15, { strongBreakRatio: 0.1 }).verdict;
      if (!fired && bSt !== "none" && bV === bSt) {
        const f9 = runUsFisher(regW, hist, 0.05, { confirmBars: 1, strongBreakRatio: 0.1 }).verdict;
        if (f9 !== "none" && f9 !== bSt) {
          fired = true;
          revN++;
          const px9 = regW[regW.length - 1].close;
          // 본피셔가 이후 실제로 전환하는가 — 리드(분)와, 경보 시점 청산 시 본피셔 전환 시점 대비 절약
          let flipT: number | null = null, flipPx: number | null = null;
          for (let u = t + 5; u <= MON_TO; u += 5) {
            const rw = reg.filter((b) => b.etMin + 5 <= u);
            if (rw.length < 6) continue;
            const v = runUsFisher(rw, hist, 0.15, { strongBreakRatio: 0.1 }).verdict;
            if (v !== bSt) { flipT = u; flipPx = rw[rw.length - 1].close; break; }
          }
          const closePx = reg[reg.length - 1].close;
          const exitPx = flipPx ?? closePx; // 전환 없으면 16:00 종가 청산 가정
          const saved = bSt === "leverage" ? ((exitPx - px9) / px9) * -100 * -1 : 0; // 부호 아래서 일괄
          const rem = ((exitPx - px9) / px9) * 100;
          const savePp = bSt === "leverage" ? -rem : rem; // 경보 청산으로 회피한 본피셔-유지 손익(+면 이득)
          void saved;
          revSave += savePp;
          if (flipT !== null) { revLeadSum += flipT - t; revLeadN++; }
          console.log(`   ${d} ${minToHHMM(t)} 본${bSt}→F ${f9} · 본피셔 전환 ${flipT !== null ? `${minToHHMM(flipT)} (리드 ${flipT - t}분)` : "없음(16:00까지 유지)"} · 선청산 이득 ${savePp >= 0 ? "+" : ""}${savePp.toFixed(2)}%p`);
        }
      }
      bSt = bV;
    }
  }
  console.log(`   발생 ${revN}건/${sessions}일 · 본피셔 전환 선행 ${revLeadN}건(리드 평균 ${revLeadN ? (revLeadSum / revLeadN).toFixed(0) : "-"}분) · 선청산 이득 합 ${revSave >= 0 ? "+" : ""}${revSave.toFixed(2)}%p`);

  // 참고: F/M(07창) 전이가 본피셔(09:30창) 확인보다 얼마나 선행하는가 — 라벨 방향 최초 도달 리드
  const leads: number[] = [];
  for (const d of labels.keys()) {
    const lb = labels.get(d)!.label;
    if (lb === "none") continue;
    const dayT = allTrans.filter((x) => x.day === d && x.cur === lb);
    const f = dayT.find((x) => x.tier === "F" || x.tier === "M");
    const b = dayT.find((x) => x.tier === "B");
    if (f && b && b.atMin >= f.atMin) leads.push(b.atMin - f.atMin);
  }
  if (leads.length) console.log(`\n참고 — 추세일 F/M 선행 리드: 중앙 ${pct(leads, 0.5)}분 · 평균 ${avg(leads).toFixed(0)}분 (표본 ${leads.length}일)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
