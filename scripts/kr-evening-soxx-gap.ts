// 한국 저녁(19:50 KST) SOXX 신호 → 하닉·삼전 익일 갭 대처 검토 (사용자 지시 2026-08-06):
//   npx tsx scripts/kr-evening-soxx-gap.ts
// 가설: ①SOXX와 하닉·삼전은 대충 유사한 추세 ②저녁 8시 이전 판단한 추세가 다음날 아침까지 간다
//   (야간에 뒤바뀔 수 있음 — 그 빈도를 실측). 실행 아이디어: 한국 애프터장(NXT ~20:00) 마감 전에
//   SOXX 누적 신호(전일 종가→ET 06:50 = 애프터+블루오션+프리 초입 전부 반영)로 하닉·삼전 매매.
// 신호 X = SOXX(ET 06:50) / SOXX(전일 정규장 종가) - 1. 결과 Y = 하닉/삼전 익일 시가 갭(오늘 종가 대비).
// ⚠표본 한계: SOXX 06:50 프리장 분봉은 야후 30일 한도 — 약 20거래일. 애프터 실행가(NXT 19:55) 미확보라
//   '종가 진입' 근사는 낙관 상한 (애프터가 신호를 선반영하면 실득 갭 축소 — 8/6 하닉 애프터 -3.7% 실사례).

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { existsSync, writeFileSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
// 신호 영구 축적 (야후 30일 한도 밖으로 표본 확장 — 재실행 시 병합, 60일+ 모이면 재판정)
const SIGCACHE = resolve(process.cwd(), ".predict-cache", "soxx-evening-signal.json");
const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

async function main() {
  // SOXX: 일봉(전일 종가) + 최근 30일 1분(프리장 06:45~59 가격)
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 90 * 86400e3), interval: "1d" });
  const soxxDaily = (rD.quotes ?? [])
    .filter((q): q is typeof q & { close: number } => q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), close: q.close }));
  const prevCloseOf = (etDay: string): number | null => {
    const idx = soxxDaily.findIndex((d) => d.date >= etDay);
    const prev = idx > 0 ? soxxDaily[idx - 1] : idx === -1 ? soxxDaily[soxxDaily.length - 1] : null;
    return prev?.close ?? null;
  };
  const px0650 = new Map<string, number>();
  for (let c = 0; c < 5; c++) {
    const p2 = new Date(Date.now() - c * 6 * 86400e3);
    const p1 = new Date(p2.getTime() - 6 * 86400e3);
    try {
      const r = await yf.chart("SOXX", { period1: p1, period2: p2, interval: "1m", includePrePost: true });
      for (const q of r.quotes ?? []) {
        if (q.close == null) continue;
        const p = Object.fromEntries(etFmt.formatToParts(q.date instanceof Date ? q.date : new Date(q.date)).map((x) => [x.type, x.value]));
        const em = parseInt(p.hour === "24" ? "0" : p.hour, 10) * 60 + parseInt(p.minute, 10);
        if (em >= 405 && em <= 419) px0650.set(`${p.year}-${p.month}-${p.day}`, q.close); // 06:45~06:59 마지막
      }
    } catch { /* 청크 실패 무시 */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 신호 병합 저장 (px0650 + 전일 종가) — 과거 실행분과 합쳐 표본 축적
  const sigPrev: Record<string, { px: number; pc: number }> = existsSync(SIGCACHE) ? JSON.parse(readFileSync(SIGCACHE, "utf8")) : {};
  for (const [d, px] of px0650) { const pc = prevCloseOf(d); if (pc) sigPrev[d] = { px, pc }; }
  writeFileSync(SIGCACHE, JSON.stringify(sigPrev));
  for (const [d, v] of Object.entries(sigPrev)) if (!px0650.has(d)) px0650.set(d, v.px); // 과거 축적분 복원
  const prevCloseOf2 = (d: string): number | null => sigPrev[d]?.pc ?? prevCloseOf(d);
  console.log(`신호 축적: ${Object.keys(sigPrev).length}일 (${SIGCACHE.split("\\\\").pop()})`);

  for (const [code, name] of [["000660", "하이닉스"], ["005930", "삼성전자"]] as const) {
    const kd = await fetchDailyPredict(code, 60);
    const rows: { d: string; x: number; gap: number; oc: number }[] = [];
    for (const [etDay, px] of px0650) {
      const pc = prevCloseOf2(etDay);
      if (!pc) continue;
      const x = ((px - pc) / pc) * 100; // 저녁 신호 (전일 종가 → 06:50)
      const i = kd.findIndex((b) => b.date === etDay); // KST 같은 날짜
      if (i < 0 || i + 1 >= kd.length) continue;
      const gap = ((kd[i + 1].open - kd[i].close) / kd[i].close) * 100;
      const oc = ((kd[i + 1].close - kd[i + 1].open) / kd[i + 1].open) * 100;
      rows.push({ d: etDay, x, gap, oc });
    }
    rows.sort((a, b) => a.d.localeCompare(b.d));
    const agree = rows.filter((r) => Math.sign(r.x) === Math.sign(r.gap) && r.x !== 0).length;
    const strong = rows.filter((r) => Math.abs(r.x) >= 1);
    const agreeS = strong.filter((r) => Math.sign(r.x) === Math.sign(r.gap)).length;
    const pnl = rows.reduce((a, r) => a + Math.sign(r.x) * r.gap, 0);
    const pnlS = strong.reduce((a, r) => a + Math.sign(r.x) * r.gap, 0);
    const pnlSoc = strong.reduce((a, r) => a + Math.sign(r.x) * r.oc, 0); // 갭 이후 지속 여부
    console.log(`\n════ ${name} (${rows.length}일) ════`);
    for (const r of rows) console.log(`${r.d}: SOXX 저녁신호 ${s2(r.x)}% → 익일 갭 ${s2(r.gap)}% · 시가→종가 ${s2(r.oc)}% ${Math.sign(r.x) === Math.sign(r.gap) ? "✓" : "✗"}`);
    console.log(`방향 일치(갭): ${agree}/${rows.length} (${Math.round((100 * agree) / Math.max(1, rows.length))}%) · 신호 ≥1%만: ${agreeS}/${strong.length}`);
    console.log(`전략 프록시(종가 진입→익일 시가): 전체 ${s2(pnl)}%p · 신호 ≥1%만 ${s2(pnlS)}%p (${strong.length}회) · 익일 시가→종가 지속 ${s2(pnlSoc)}%p`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
