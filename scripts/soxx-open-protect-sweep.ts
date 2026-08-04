// SOXX 개장 후 이익 보호 규칙 스윕 (사용자 지시 2026-08-04 — 8/3 실사례: 인버스 +6%(3x)까지 갔다가
// 반전으로 스탑 -2%, "번 수익 지키기" 규칙 요구):
//   npx tsx scripts/soxx-open-protect-sweep.ts
// ①기술 통계: 기브백 일(유리 진행 MFE ≥1% 후 최종 ≤0)의 빈도·반전 전 1분봉 신호(반대 6봉 점화·연속 역행봉·
//   거래량)를 상승/하락 진입 방향별로 분해 ②규칙 스윕: 통합 사양(수정안·rebox판) 위에
//   A) 무장 트레일: 미실현 ≥arm% 도달 후 극값에서 T% 되돌림 시 청산 (전일 vs 개장창 10:30 한정)
//   B) 반대 창 점화 청산: 미실현 ≥arm% 상태에서 반대 방향 6봉 누적 순전진 점화 시 청산
//   전제: 청산 후 그날 재진입 없음(E1 창1 반대 역진입은 유지)·1박 무효. 기준선 = rebox판 +117.8%p.
// 선행 실측 주의: SOXX 상시 트레일은 기각(8bf5f64 — 기준선 이하)·반대 점화 상시 심판도 궤멸(4d03194).
//   이번 셀은 '이익 무장 + 개장창 한정'이 다른 점 — 무익하면 기각 기록.

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { judgeSoxxDay, soxxUnitArr, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar, type SoxxJ } from "../lib/signal/us/soxxV2";
import type { PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE = resolve(process.cwd(), ".predict-cache");
const STOP = 2.0;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const bmid = (b: SoxxBar) => (b.open + b.close) / 2;

type Day = { date: string; raw: SoxxBar[]; unit: number[]; reg: SoxxBar[]; close: number; nextOpen: number | null; c1: SoxxJ | null; fJ: SoxxJ | null };

type Rule =
  | { kind: "none" }
  | { kind: "trail"; arm: number; t: number; until: number; dirOnly?: 1 | -1 } // arm%·되돌림 t%·창 종료 etMin·방향 한정
  | { kind: "oppcw"; arm: number; until: number; dirOnly?: 1 | -1 };           // 반대 6봉 점화·미실현 ≥arm%

// 통합 사양(수정안) 시뮬 + 보호 규칙. 반환: 일 손익·기브백 여부·보호발동 정보
function simDay(d: Day, rule: Rule): { p: number; cut: boolean; protT: number | null; mfe: number } {
  const { raw, unit } = d;
  const fFirst = d.fJ && (!d.c1 || d.fJ.t < d.c1.t);
  const first = fFirst ? d.fJ : d.c1;
  if (!first) return { p: 0, cut: false, protT: null, mfe: 0 };
  let mfeAll = 0;
  let protAt: number | null = null;

  // 레그 시뮬: 진입 j → forceI(심판 교체) 전까지. 보호 규칙은 '보유 중 이익 무장' 상태에서만.
  const runLeg = (j: SoxxJ, allowOvn: boolean, forceI?: number, forcePx?: number): { pnl: number; cut: boolean; exited: boolean } => {
    let i0 = j.i, px = j.px;
    if (raw[j.i].etMin < SOXX_ET_OPEN) { i0 = raw.findIndex((b) => b.etMin >= SOXX_ET_OPEN); px = d.reg[0].open; }
    if (i0 < 0 || (forceI !== undefined && forceI <= i0)) return { pnl: 0, cut: false, exited: false };
    const s = STOP / 100;
    const lim = forceI ?? raw.length;
    let ext = px; // 유리 극값
    let oppSt: "none" | "up" | "down" = "none";
    for (let k = i0 + 1; k < lim; k++) {
      const b = raw[k];
      if (b.etMin < SOXX_ET_OPEN) continue;
      if (j.dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return { pnl: -STOP, cut: true, exited: false };
      const fav = ((j.dir === 1 ? b.high : b.low) - px) / px * 100 * j.dir;
      mfeAll = Math.max(mfeAll, fav);
      ext = j.dir === 1 ? Math.max(ext, b.high) : Math.min(ext, b.low);
      const unreal = ((b.close - px) / px) * 100 * j.dir;
      if (rule.kind === "trail" && b.etMin <= rule.until && (rule.dirOnly === undefined || j.dir === rule.dirOnly)) {
        const armGain = ((ext - px) / px) * 100 * j.dir;
        if (armGain >= rule.arm) {
          const retr = ((ext - b.close) / px) * 100 * j.dir;
          if (retr >= rule.t) { protAt = b.etMin; return { pnl: ((b.close - px) / px) * 100 * j.dir, cut: false, exited: true }; }
        }
      }
      if (rule.kind === "oppcw" && b.etMin <= rule.until && k >= 5 && (rule.dirOnly === undefined || j.dir === rule.dirOnly)) {
        // 반대 방향 6봉 누적 순전진 점화 (창1과 동일 산식·상태 전이)
        let sig: "up" | "down" | null = null;
        for (const dir of [1, -1] as const) {
          if ((bmid(raw[k]) - bmid(raw[k - 5])) * dir >= unit[k - 5] * 5) { sig = dir === 1 ? "up" : "down"; break; }
        }
        if (sig && sig !== oppSt) {
          oppSt = sig;
          const oppDir = sig === "up" ? 1 : -1;
          if (oppDir !== j.dir && unreal >= rule.arm) { protAt = b.etMin; return { pnl: unreal, cut: false, exited: true }; }
        } else if (!sig) oppSt = "none";
      }
    }
    if (forceI !== undefined) return { pnl: (((forcePx ?? d.close) - px) / px) * 100 * j.dir, cut: false, exited: false };
    const exitPx = allowOvn && d.nextOpen !== null ? d.nextOpen : d.close;
    return { pnl: ((exitPx - px) / px) * 100 * j.dir, cut: false, exited: false };
  };

  let p = 0, cut = false;
  if (fFirst && d.fJ) {
    const oppC = d.c1 && d.c1.dir !== d.fJ.dir ? d.c1 : null;
    const ovnOk = !oppC;
    const r1 = runLeg(d.fJ, ovnOk, oppC?.i, oppC?.px);
    p += r1.pnl; cut = cut || r1.cut;
    // 보호 청산돼도 심판(창1 반대 역진입)은 유지 — 반대 확정 시 새 포지션
    if (oppC) { const r2 = runLeg(oppC, false); p += r2.pnl; cut = cut || r2.cut; }
  } else if (d.c1) {
    const fOpp = d.fJ && d.fJ.dir !== d.c1.dir ? d.fJ : null;
    const r1 = runLeg(d.c1, !fOpp);
    p += r1.pnl; cut = cut || r1.cut;
  }
  return { p, cut, protT: protAt, mfe: mfeAll };
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  const days: Day[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const unit = soxxUnitArr(raw, r10);
    const { c1, fJ } = judgeSoxxDay(date, raw, hist, r10, { reboxHHMM: "09:30", reboxMinutes: 15 });
    const next = dIdx.find((x) => x > date);
    days.push({ date, raw, unit, reg, close: reg[reg.length - 1].close, nextOpen: next ? dBy.get(next)!.open : null, c1, fJ });
  }

  // ① 기술 통계 — 기브백 해부 (기준선 시뮬 기준)
  const base = days.map((d) => ({ d, r: simDay(d, { kind: "none" }) }));
  const withPos = base.filter((x) => x.r.mfe > 0 || x.r.cut || x.r.p !== 0);
  const giveback = base.filter((x) => x.r.mfe >= 1.0 && x.r.p <= 0);
  const gbUp = giveback.filter((x) => (x.d.fJ && (!x.d.c1 || x.d.fJ.t < x.d.c1.t) ? x.d.fJ.dir : x.d.c1?.dir) === 1);
  console.log(`════ ① 기브백 해부 (${withPos.length}거래일 · 기준선 rebox판) ════`);
  console.log(`기브백 일(MFE ≥1% 후 최종 ≤0): ${giveback.length}일 — 상승 진입 ${gbUp.length}·하락 진입 ${giveback.length - gbUp.length}`);
  const gbLoss = giveback.reduce((a, x) => a + x.r.p, 0);
  const gbMfe = giveback.reduce((a, x) => a + x.r.mfe, 0);
  console.log(`기브백 일 합산: 최종 ${s1(gbLoss)}%p (놓친 MFE 합 ${s1(gbMfe)}%p) — 보호 규칙의 이론적 최대 회수 풀`);

  // ② 규칙 스윕
  const rules: { label: string; rule: Rule }[] = [
    { label: "기준선 (보호 없음)", rule: { kind: "none" } },
    { label: "A 트레일 arm1.0·T0.5·전일", rule: { kind: "trail", arm: 1.0, t: 0.5, until: 960 } },
    { label: "A 트레일 arm1.0·T0.75·전일", rule: { kind: "trail", arm: 1.0, t: 0.75, until: 960 } },
    { label: "A 트레일 arm1.0·T1.0·전일", rule: { kind: "trail", arm: 1.0, t: 1.0, until: 960 } },
    { label: "A 트레일 arm0.5·T0.5·~10:30", rule: { kind: "trail", arm: 0.5, t: 0.5, until: 630 } },
    { label: "A 트레일 arm1.0·T0.5·~10:30", rule: { kind: "trail", arm: 1.0, t: 0.5, until: 630 } },
    { label: "A 트레일 arm1.0·T0.75·~10:30", rule: { kind: "trail", arm: 1.0, t: 0.75, until: 630 } },
    { label: "B 반대창 arm0.5·전일", rule: { kind: "oppcw", arm: 0.5, until: 960 } },
    { label: "B 반대창 arm1.0·전일", rule: { kind: "oppcw", arm: 1.0, until: 960 } },
    { label: "B 반대창 arm0.5·~10:30", rule: { kind: "oppcw", arm: 0.5, until: 630 } },
    { label: "B 반대창 arm1.0·~10:30", rule: { kind: "oppcw", arm: 1.0, until: 630 } },
    // 하락(인버스) 진입일 한정 — 방향 비대칭 검증 (기브백 26/33이 하락 진입, SOXX 상승 편향 가설).
    // T 격자 조밀화로 평원/첨점 판별 (첨점이면 운 캐기로 기각 — 창2 스윕 관례)
    { label: "C 인버한정 트레일 arm1.0·T0.5·~10:30", rule: { kind: "trail", arm: 1.0, t: 0.5, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm1.0·T0.6·~10:30", rule: { kind: "trail", arm: 1.0, t: 0.6, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm1.0·T0.75·~10:30", rule: { kind: "trail", arm: 1.0, t: 0.75, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm1.0·T0.9·~10:30", rule: { kind: "trail", arm: 1.0, t: 0.9, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm1.0·T1.0·~10:30", rule: { kind: "trail", arm: 1.0, t: 1.0, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm0.5·T0.75·~10:30", rule: { kind: "trail", arm: 0.5, t: 0.75, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm1.5·T0.75·~10:30", rule: { kind: "trail", arm: 1.5, t: 0.75, until: 630, dirOnly: -1 } },
    { label: "C 인버한정 트레일 arm1.0·T0.75·전일", rule: { kind: "trail", arm: 1.0, t: 0.75, until: 960, dirOnly: -1 } },
    { label: "C 인버한정 반대창 arm1.0·전일", rule: { kind: "oppcw", arm: 1.0, until: 960, dirOnly: -1 } },
  ];
  console.log(`\n════ ② 보호 규칙 스윕 (통합 수정안·rebox판 — 보호 청산 후 재진입 없음·1박 무효) ════`);
  for (const { label, rule } of rules) {
    let tot = 0, cutN = 0, worst = 0, prot = 0, gbSaved = 0, upP = 0, dnP = 0;
    for (const x of days) {
      const r = simDay(x, rule);
      tot += r.p; if (r.cut) cutN++; worst = Math.min(worst, r.p); if (r.protT !== null) prot++;
      const dir = x.fJ && (!x.c1 || x.fJ.t < x.c1.t) ? x.fJ.dir : x.c1?.dir;
      if (dir === 1) upP += r.p; else if (dir === -1) dnP += r.p;
      if (rule.kind !== "none" && giveback.some((g) => g.d.date === x.date)) gbSaved += r.p - base.find((b) => b.d.date === x.date)!.r.p;
    }
    console.log(`${label}: ${s1(tot)}%p · 최악 ${worst.toFixed(2)} · 컷 ${cutN} · 발동 ${prot}일${rule.kind !== "none" ? ` · 기브백일 회수 ${s1(gbSaved)}` : ""} · 상승진입 ${s1(upP)}/하락진입 ${s1(dnP)}`);
  }

  // ③ 8/3 실사례 재현 — 각 규칙의 어제 행동
  console.log(`\n════ ③ 8/3(어젯밤) 재현 ════`);
  const d83 = days.find((x) => x.date === "2026-08-03");
  if (d83) {
    for (const { label, rule } of rules) {
      const r = simDay(d83, rule);
      console.log(`${label}: ${s2(r.p)}%${r.cut ? " (스탑)" : ""}${r.protT !== null ? ` — 보호 청산 ${fmtT(r.protT)} ET` : ""} · MFE ${s2(r.mfe)}%`);
    }
  } else console.log("8/3 캐시 없음");
}
main().catch((e) => { console.error(e); process.exit(1); });
