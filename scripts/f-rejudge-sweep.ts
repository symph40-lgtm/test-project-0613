// 확정 후 피셔F 재판정 재개(2단계 사슬 재가동) 정책 실측 (이월 지시 2026-07-25 ④번).
//   npx tsx scripts/f-rejudge-sweep.ts [--days 224]   (.predict-cache 전용 — 무통신)
//
// ① 7/24 삼전 13:05 반등 리플레이 — 본피셔 인버스 방치가 수익을 얼마나 훼손했고,
//    현행 배포분(전이 모니터 15:25 연장 + 09창 rev9 반전경보)이 이 날 무엇을 보냈을지 재현.
// ② 정책 실측: 확정(14:00) 이후 09창 피셔F가 본피셔와 반대 방향을 확인한 사례 전수 —
//    그 시점 청산(=반대 진입)의 잔여 손익, 본피셔 자체 전환 대비 리드, M(0.10) 2단계 재확인 조건부.
// 채택 기준 (프로젝트 공통): 하닉·삼전 모두 + 전·후반 모두 개선일 때만 정책 후보.
// 상수 = 라이브 모니터와 동일: 본 0.15·8봉·반전3·sb(하닉 0.1/삼전 0.075, 09창) ·
//   F9 0.05·4봉·반전3·sb 동일(09창) · M 0.10·8봉·반전3(08 연속창). 하닉 고변동일 트레일은 미반영(주석).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 224; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const FINAL = "14:00";
const MON_END = "15:20"; // 모니터 15:25 발송 = 15:19 완성봉까지

const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

type St = "none" | "up" | "down";
type Trans = { time: string; to: St; px: number };
// fisher.ts 상태기계의 스트리밍판 (reversal-sweep.ts와 동일 로직)
function stream(bars: MinuteBar[], orN: number, offsetWon: number, confirm: number, reversal: number, strongWon: number): Trans[] {
  if (bars.length < orN + 1) return [];
  const or = bars.slice(0, orN);
  const aUp = Math.max(...or.map((b) => b.high)) + offsetWon;
  const aDown = Math.min(...or.map((b) => b.low)) - offsetWon;
  const out: Trans[] = [];
  let state: St = "none", upRun = 0, downRun = 0;
  for (const b of bars.slice(orN)) {
    upRun = b.close > aUp ? upRun + 1 : 0;
    downRun = b.close < aDown ? downRun + 1 : 0;
    if (strongWon > 0) {
      if (b.close > aUp + strongWon) upRun = Math.max(upRun, confirm, reversal);
      if (b.close < aDown - strongWon) downRun = Math.max(downRun, confirm, reversal);
    }
    if (state === "none") {
      if (upRun >= confirm) { state = "up"; out.push({ time: b.time, to: state, px: b.close }); }
      else if (downRun >= confirm) { state = "down"; out.push({ time: b.time, to: state, px: b.close }); }
    } else if (state === "up" && downRun >= reversal) {
      state = "down"; out.push({ time: b.time, to: state, px: b.close });
    } else if (state === "down" && upRun >= reversal) {
      state = "up"; out.push({ time: b.time, to: state, px: b.close });
    }
  }
  return out;
}
const stAt = (ts: Trans[], hhmm: string): { st: St; since: Trans | null } => {
  let cur: Trans | null = null;
  for (const t of ts) { if (tMin(t.time) <= tMin(hhmm)) cur = t; else break; }
  return { st: cur?.to ?? "none", since: cur };
};
const dirSign = (s: St) => (s === "up" ? 1 : -1);

type Day = { date: string; r10: number | null; pre: MinuteBar[]; reg: MinuteBar[]; half: 0 | 1 };
async function loadDays(code: string): Promise<Day[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, DAYS + 140)).filter((b) => b.date < today);
  const out: Day[] = [];
  for (const bar of daily.slice(-DAYS)) {
    const idx = daily.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const reg = readCache(`${code}-${bar.date}.json`);
    if (!reg || reg.length < 240) continue;
    out.push({ date: bar.date, r10: avgRange(daily.slice(Math.max(0, idx - 120), idx), 10), pre: readCache(`${code}NX-${bar.date}.json`) ?? [], reg, half: 0 });
  }
  out.forEach((d, i) => { d.half = i < out.length / 2 ? 0 : 1; });
  return out;
}

function replay724(days: Day[]): void {
  const d = days.find((x) => x.date === "2026-07-24");
  console.log("\n════ ① 7/24 삼전 리플레이 ════");
  if (!d || d.r10 === null) { console.log("7/24 분봉 캐시 없음"); return; }
  const sb = 0.075 * d.r10;
  const bon = stream(d.reg, 15, 0.15 * d.r10, 8, 3, sb);
  const f9 = stream(d.reg, 15, 0.05 * d.r10, 4, 3, sb);
  const cont = [...d.pre, ...d.reg];
  const f8 = stream(cont, 15, 0.05 * d.r10, 4, 3, sb);
  const m8 = stream(cont, 15, 0.10 * d.r10, 8, 3, 0);
  const fmt = (ts: Trans[]) => ts.map((t) => `${t.time} ${t.to === "up" ? "레버" : t.to === "down" ? "인버" : "없음"} ${t.px.toLocaleString()}`).join(" → ") || "(전이 없음)";
  console.log(`본피셔(09창): ${fmt(bon)}`);
  console.log(`피셔F9(09창): ${fmt(f9)}`);
  console.log(`피셔F(08창):  ${fmt(f8)}`);
  console.log(`피셔M(08창):  ${fmt(m8)}`);
  const lows = d.reg.reduce((a, b) => (b.low < a.low ? b : a));
  const close = d.reg[d.reg.length - 1].close;
  console.log(`당일 저점 ${lows.time} ${lows.low.toLocaleString()} · 종가 ${close.toLocaleString()}`);
  const bAt = stAt(bon, MON_END);
  if (bAt.since && bAt.st === "down") {
    const rem = ((close - lows.low) / lows.low) * 100;
    console.log(`저점→종가 반등 +${rem.toFixed(2)}% — 본피셔 인버스 유지 시 그만큼 역행 부담`);
  }
  const f9Opp = f9.find((t) => bAt.st !== "none" && t.to !== bAt.st && t.to !== "none" && tMin(t.time) > tMin(bon[0]?.time ?? "09:00"));
  if (f9Opp) {
    const saved = ((close - f9Opp.px) / f9Opp.px) * 100 * -dirSign(bAt.st);
    console.log(`rev9 경보(배포 7/25): ${f9Opp.time} F9 ${f9Opp.to === "up" ? "레버" : "인버"} ${f9Opp.px.toLocaleString()} — 이 시점 청산 시 잔여 회피 ${saved >= 0 ? "+" : ""}${saved.toFixed(2)}%p · 반대 진입 시 동일 %p 이득`);
  } else {
    console.log("rev9 경보 조건 미충족 (F9 반대 확인 없음)");
  }
}

function policy(code: string, name: string, days: Day[]): void {
  console.log(`\n════ ② 확정(14:00) 후 F9 반대 확인 정책 실측 — ${name} (${days.length}일) ════`);
  const sbR = code === "005930" ? 0.075 : 0.1;
  type Case = { date: string; half: 0 | 1; bSt: St; t: string; px: number; exitSave: number; mConfirm: boolean; mSave: number | null; bonFlip: string | null; lead: number | null };
  const cases: Case[] = [];
  let dirDays = 0;
  for (const d of days) {
    if (d.r10 === null) continue;
    const sb = sbR * d.r10;
    const bon = stream(d.reg, 15, 0.15 * d.r10, 8, 3, sb);
    const bAt = stAt(bon, FINAL);
    if (bAt.st === "none") continue;
    dirDays++;
    const f9 = stream(d.reg, 15, 0.05 * d.r10, 4, 3, sb);
    // 확정 시점에 이미 반대였던 날(사전 rev9 커버)은 제외 — 확정 이후 '새로' 반대 확인된 사례만
    if (stAt(f9, FINAL).st !== "none" && stAt(f9, FINAL).st !== bAt.st) continue;
    const alert = f9.find((t) => tMin(t.time) > tMin(FINAL) && tMin(t.time) <= tMin(MON_END) && t.to !== "none" && t.to !== bAt.st);
    if (!alert) continue;
    const close = d.reg[d.reg.length - 1].close;
    const exitSave = ((close - alert.px) / alert.px) * 100 * -dirSign(bAt.st); // 본방향 유지 시 잔여 손익의 부호 반전 = 청산으로 회피(+)/놓친(-) %p
    // 2단계: M(08 연속창)이 같은 반대 방향을 경보 이후~마감 사이 재확인하는가 — 조건부 성적
    const m8 = stream([...d.pre, ...d.reg], 15, 0.10 * d.r10, 8, 3, 0);
    const mConf = m8.find((t) => tMin(t.time) >= tMin(alert.time) && tMin(t.time) <= tMin(MON_END) && t.to === alert.to)
      ?? (stAt(m8, alert.time).st === alert.to ? stAt(m8, alert.time).since : null);
    const mSave = mConf ? ((close - Math.max(alert.px, 0)) / alert.px) * 100 * -dirSign(bAt.st) : null;
    // 본피셔 자체 전환 리드
    const bFlip = bon.find((t) => tMin(t.time) > tMin(alert.time) && t.to === alert.to);
    cases.push({
      date: d.date, half: d.half, bSt: bAt.st, t: alert.time, px: alert.px,
      exitSave: Number(exitSave.toFixed(2)), mConfirm: !!mConf, mSave,
      bonFlip: bFlip?.time ?? null, lead: bFlip ? tMin(bFlip.time) - tMin(alert.time) : null,
    });
  }
  console.log(`확정 방향일 ${dirDays}일 중 확정 후 F9 신규 반대 확인 ${cases.length}건`);
  for (const c of cases) {
    console.log(`  ${c.date} ${c.t} 본${c.bSt === "up" ? "레버" : "인버"}→F9 반대 ${c.px.toLocaleString()} · 청산효과 ${c.exitSave >= 0 ? "+" : ""}${c.exitSave}%p · M재확인 ${c.mConfirm ? "O" : "X"} · 본피셔 전환 ${c.bonFlip ?? "없음"}${c.lead !== null ? `(리드 ${c.lead}분)` : ""}`);
  }
  const sum = (a: Case[]) => a.reduce((s, x) => s + x.exitSave, 0);
  const pos = cases.filter((c) => c.exitSave > 0).length;
  console.log(`합계 청산효과 ${sum(cases) >= 0 ? "+" : ""}${sum(cases).toFixed(2)}%p · 이득 ${pos}/${cases.length} · 전반 ${sum(cases.filter((c) => c.half === 0)).toFixed(2)} / 후반 ${sum(cases.filter((c) => c.half === 1)).toFixed(2)}`);
  const mc = cases.filter((c) => c.mConfirm);
  console.log(`M 재확인 조건부: ${mc.length}건 · 청산효과 ${sum(mc) >= 0 ? "+" : ""}${sum(mc).toFixed(2)}%p (미확인 ${cases.length - mc.length}건 ${sum(cases.filter((c) => !c.mConfirm)).toFixed(2)}%p)`);
}

async function main() {
  const ss = await loadDays("005930");
  const hx = await loadDays("000660");
  replay724(ss);
  policy("005930", "삼전", ss);
  policy("000660", "하닉", hx);
}
main().catch((e) => { console.error(e); process.exit(1); });
