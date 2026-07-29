// 장초반 변동성 대응 실측 (사용자 지시 2026-07-30 — 오늘 아침 레버↔인버 4회 왕복 실손):
//   npx tsx scripts/early-vol-sweep.ts
// ① 초반 추세 반전 빈도 — 10:00/10:30 이전 첫 확인이 장 끝(15:25)까지 뒤집힌 비율
// ② 판정 시작 지연 — 10:00/10:30부터만 진입할 때 손익·컷·전환 vs 현행(즉시)
// ③ 사용자 제안: 10:30 이전 '크기 기준'(오프셋·강돌파)만 ×배수 강화, 시간 기준은 유지.
//    배수 {1.5, 2, 3} 스윕 + 오늘 왕복 회피 재현
// ④ 추세 구간(전환·스탑컷마다 새 구간) 중 유리 방향 ≥5% 구간 통계 — 시작 시각 버킷별
// 프레임: 08연속창 피셔F 스트림(현행 상수 F 0.05·4봉+강돌파·반전3), 레그 스탑 -1.5%.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { fetchDayMinutes, fetchNxtPremarket } from "../lib/predict/kisMinute";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const f1 = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);
const T1030 = tMin("10:30");

type St = "up" | "down";
type Trans = { t: number; to: St; px: number };
// 피셔F 스트리밍 — earlyMult: 10:30 이전 오프셋·강돌파 ×배수 (사용자 제안 ③)
function fStream(bars: MinuteBar[], r10: number, sb: number, earlyMult: number): Trans[] {
  if (bars.length < 16) return [];
  const or = bars.slice(0, 15);
  const orH = Math.max(...or.map((b) => b.high)), orL = Math.min(...or.map((b) => b.low));
  const out: Trans[] = [];
  let st: "none" | St = "none", up = 0, dn = 0;
  for (const b of bars.slice(15)) {
    const mult = tMin(b.time) < T1030 ? earlyMult : 1;
    const off = 0.05 * r10 * mult, sbW = sb * r10 * mult;
    const aUp = orH + off, aDn = orL - off;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, 4, 3);
      if (b.close < aDn - sbW) dn = Math.max(dn, 4, 3);
    }
    if (st === "none") {
      if (up >= 4) { st = "up"; out.push({ t: tMin(b.time), to: "up", px: b.close }); }
      else if (dn >= 4) { st = "down"; out.push({ t: tMin(b.time), to: "down", px: b.close }); }
    } else if (st === "up" && dn >= 3) { st = "down"; out.push({ t: tMin(b.time), to: "down", px: b.close }); }
    else if (st === "down" && up >= 3) { st = "up"; out.push({ t: tMin(b.time), to: "up", px: b.close }); }
  }
  return out;
}

// 레그 손익 (스탑 -1.5%) + 시작 정책(startMin 이전 전환 무시 — 시작 시점 상태로 진입)
function pnlOf(cont: MinuteBar[], trs: Trans[], close: number, startMin: number): { pnl: number; legs: number; win: number; cuts: number; flips: number } {
  const acts: Trans[] = [];
  for (let i = 0; i < trs.length; i++) {
    const t = trs[i];
    if (t.t >= startMin) acts.push(t);
    else if (i + 1 === trs.length || trs[i + 1].t >= startMin) {
      // 시작 시점에 유지 중인 상태 — 시작 시각 봉 종가로 진입
      const bar = cont.find((b) => tMin(b.time) >= startMin);
      if (bar) acts.push({ t: tMin(bar.time), to: t.to, px: bar.close });
    }
  }
  const r = { pnl: 0, legs: 0, win: 0, cuts: 0, flips: Math.max(0, acts.length - 1) };
  for (let i = 0; i < acts.length; i++) {
    const e = acts[i], endT = i + 1 < acts.length ? acts[i + 1].t : Infinity;
    let p: number | null = null;
    for (const b of cont) {
      const tm = tMin(b.time);
      if (tm <= e.t) continue;
      if (tm >= endT) break;
      if (e.to === "up" && b.low <= e.px * 0.985) { p = -1.5; r.cuts++; break; }
      if (e.to === "down" && b.high >= e.px * 1.015) { p = -1.5; r.cuts++; break; }
    }
    if (p === null) {
      const x = i + 1 < acts.length ? acts[i + 1].px : close;
      p = ((x - e.px) / e.px) * 100 * (e.to === "up" ? 1 : -1);
    }
    r.pnl += p; r.legs++; if (p > 0) r.win++;
  }
  return r;
}

type Day = { date: string; cont: MinuteBar[]; r10: number; close: number };
async function loadDays(code: string): Promise<Day[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  const out: Day[] = [];
  for (let i = 130; i < daily.length; i++) {
    const d = daily[i].date;
    const reg = rc(`${code}-${d}.json`);
    const pre = rc(`${code}NX-${d}.json`);
    if (!reg || reg.length < 240) continue;
    const r10 = avgRange(daily.slice(Math.max(0, i - 120), i), 10);
    if (r10 === null) continue;
    out.push({ date: d, cont: [...(pre ?? []), ...reg], r10, close: daily[i].close });
  }
  return out;
}

async function analyze(code: string, name: string, sb: number): Promise<void> {
  const days = await loadDays(code);
  console.log(`\n════════ ${name} — ${days.length}일 (08연속창 피셔F·스탑 -1.5%) ════════`);

  // ① 초반 확인의 최종 생존율
  let n10 = 0, rev10 = 0, n1030 = 0, rev1030 = 0, fBefore = 0, fAfter = 0;
  for (const d of days) {
    const trs = fStream(d.cont, d.r10, sb, 1);
    if (!trs.length) continue;
    for (let i = 1; i < trs.length; i++) (trs[i].t < T1030 ? fBefore++ : fAfter++);
    const first = trs[0], last = trs[trs.length - 1];
    if (first.t < tMin("10:00")) { n10++; if (last.to !== first.to) rev10++; }
    if (first.t < T1030) { n1030++; if (last.to !== first.to) rev1030++; }
  }
  console.log(`① 첫 확인이 10:00 이전인 ${n10}일 중 장끝까지 방향이 뒤집힌 날 ${rev10}일 (${Math.round((100 * rev10) / Math.max(1, n10))}%)`);
  console.log(`   첫 확인이 10:30 이전인 ${n1030}일 중 뒤집힌 날 ${rev1030}일 (${Math.round((100 * rev1030) / Math.max(1, n1030))}%)`);
  console.log(`   전환(재전환) 발생 시각: 10:30 이전 ${fBefore}회 vs 이후 ${fAfter}회`);

  // ②·③ 정책 비교
  console.log(`② / ③ 정책 비교 (손익 합 | 컷 | 전환 | 레그 승률)`);
  const policies: { tag: string; mult: number; start: number }[] = [
    { tag: "현행 (즉시 판정)", mult: 1, start: 0 },
    { tag: "② 10:00부터 진입", mult: 1, start: tMin("10:00") },
    { tag: "② 10:30부터 진입", mult: 1, start: T1030 },
    { tag: "③ 10:30전 크기×1.5", mult: 1.5, start: 0 },
    { tag: "③ 10:30전 크기×2", mult: 2, start: 0 },
    { tag: "③ 10:30전 크기×3", mult: 3, start: 0 },
  ];
  for (const p of policies) {
    let pnl = 0, cuts = 0, flips = 0, legs = 0, win = 0;
    for (const d of days) {
      const trs = fStream(d.cont, d.r10, sb, p.mult);
      const r = pnlOf(d.cont, trs, d.close, p.start);
      pnl += r.pnl; cuts += r.cuts; flips += r.flips; legs += r.legs; win += r.win;
    }
    console.log(`   ${p.tag.padEnd(18)} ${f1(pnl).padStart(7)}%p | 컷 ${String(cuts).padStart(3)} | 전환 ${String(flips).padStart(3)} | 승률 ${legs ? Math.round((100 * win) / legs) : 0}% (${legs}레그)`);
  }

  // ④ 추세 구간 ≥5% 통계 (전환·스탑컷마다 새 구간, 유리 방향 기준)
  const edges = ["08:30", "09:00", "09:30", "10:00", "10:30", "11:00"].map(tMin);
  const bucketLab = ["~08:30", "08:30~09:00", "09:00~09:30", "09:30~10:00", "10:00~10:30", "10:30~11:00", "11:00~"];
  const bCnt = new Array(7).fill(0), bBig = new Array(7).fill(0);
  for (const d of days) {
    const trs = fStream(d.cont, d.r10, sb, 1);
    // 구간 경계: 전환 + 스탑컷
    type Seg = { start: number; px: number; dir: St };
    const segs: Seg[] = [];
    for (let i = 0; i < trs.length; i++) {
      let seg: Seg = { start: trs[i].t, px: trs[i].px, dir: trs[i].to };
      const endT = i + 1 < trs.length ? trs[i + 1].t : Infinity;
      for (const b of d.cont) {
        const tm = tMin(b.time);
        if (tm <= seg.start) continue;
        if (tm >= endT) break;
        const cut = seg.dir === "up" ? b.low <= seg.px * 0.985 : b.high >= seg.px * 1.015;
        if (cut) { segs.push(seg); seg = { start: tm, px: b.close, dir: seg.dir }; } // 컷 → 같은 방향 새 구간
      }
      segs.push(seg);
      // 구간 끝값 계산은 아래에서 일괄
    }
    for (let i = 0; i < segs.length; i++) {
      const endT = i + 1 < segs.length ? segs[i + 1].start : Infinity;
      let endPx = d.close;
      for (const b of d.cont) { const tm = tMin(b.time); if (tm > segs[i].start && tm < endT) endPx = b.close; }
      const move = ((endPx - segs[i].px) / segs[i].px) * 100 * (segs[i].dir === "up" ? 1 : -1);
      let bi = edges.findIndex((e) => segs[i].start < e);
      if (bi < 0) bi = 6;
      bCnt[bi]++;
      if (move >= 5) bBig[bi]++;
    }
  }
  console.log(`④ 추세 구간(전환·컷마다 새 구간) 중 유리 방향 ≥5% 비율 — 시작 시각별`);
  for (let i = 0; i < 7; i++) {
    console.log(`   ${bucketLab[i].padEnd(12)} 구간 ${String(bCnt[i]).padStart(4)}개 · ≥5% ${String(bBig[i]).padStart(3)}개 (${bCnt[i] ? Math.round((100 * bBig[i]) / bCnt[i]) : 0}%)`);
  }
}

// 오늘 재현 — 현행 vs ③배수별 전환 시퀀스
async function today(code: string, name: string, sb: number): Promise<void> {
  const t = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const ymd = t.replace(/-/g, "");
  const daily = await fetchDailyPredict(code, 140);
  const hist = daily.filter((b) => b.date < t).slice(-120);
  const r10 = avgRange(hist, 10);
  const pre = await fetchNxtPremarket(code, ymd);
  const reg = await fetchDayMinutes(code, ymd, "153000");
  if (r10 === null || !reg) { console.log(`${name}: 오늘 데이터 부족`); return; }
  const cont = [...(pre ?? []), ...reg];
  const fmt = (trs: Trans[]) => trs.map((x) => `${String(Math.floor(x.t / 60)).padStart(2, "0")}:${String(x.t % 60).padStart(2, "0")}${x.to === "up" ? "레버" : "인버"}`).join("→") || "무판정";
  console.log(`\n■ 오늘(${t}) ${name} 재현`);
  for (const mult of [1, 1.5, 2, 3]) {
    console.log(`   ${mult === 1 ? "현행    " : `크기×${mult}  `.padEnd(8)} ${fmt(fStream(cont, r10, sb, mult))}`);
  }
}

(async () => {
  await analyze("005930", "삼전", 0.075);
  await analyze("000660", "하닉", 0.1);
  await today("005930", "삼전", 0.075);
  await today("000660", "하닉", 0.1);
  console.log(`\n주: ③은 10:30 이전에만 오프셋·강돌파를 ×배수 (시간 기준·확인봉은 불변 — 사용자 제안).`);
})().catch((e) => { console.error(e); process.exit(1); });
