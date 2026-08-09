// SOXX 횡보(chop) 필터 스윕 (사용자 제안 2026-08-08 — 8/6 F 진입 -3.64% 실사례 후속):
//   npx tsx scripts/soxx-chop-filter-sweep.ts
// 사용자 규칙: "10분봉 5MA 굴곡이 심하고 20MA가 수평이면 횡보 — 들어가면 안 되는 장.
//   20MA 접촉선 기울기의 음↔양 반전이 잦으면 안 됨. 5시간 내 반전이 없거나,
//   반전해도 |기울기| 10도 이하라면 추세로 본다."
// 구현: 판정 직전 5시간(10분봉 30개)의 20MA 기울기 시퀀스로 두 지표를 계산 —
//   ①유의 반전 횟수(|기울기|>10°에서 부호 반전) ②굴곡도(5MA 기울기 부호 반전 빈도)
//   각도 눈금: 10분봉 1개당 平常 흔들림(직전 30봉 평균 고저폭×0.5) = 45° (창판정과 동일 규약).
// 게이트: 판정 시점에 '유의 반전 ≥N이면 진입 보류'. 주기준 채점(rebox+인버보호+프리진입)에 적용.
// ⚠판정 시점까지의 봉만 사용 — 미래 정보 없음. 채택 기준: 필터 적용이 전체·최근 모두 무해+개선.
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { judgeSoxxDay, scoreSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const D = 180 / Math.PI;

// 10분봉 집계 (etMin 오름차순 1분봉 → 10분 경계)
type B10 = { etMin: number; close: number; high: number; low: number };
function to10m(raw: SoxxBar[]): B10[] {
  const out: B10[] = [];
  for (const b of raw) {
    const slot = Math.floor(b.etMin / 10) * 10;
    const last = out[out.length - 1];
    if (last && last.etMin === slot) { last.close = b.close; last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); }
    else out.push({ etMin: slot, close: b.close, high: b.high, low: b.low });
  }
  return out;
}

// 판정 시점(etMin) 직전 창의 chop 지표. lookbackBars = 10분봉 수 (30 = 5시간)
function chopAt(b10: B10[], atEt: number, lookback = 30): { sigFlips: number; flips5: number; ma20SlopeDeg: number } | null {
  const upto = b10.filter(b => b.etMin < atEt);
  if (upto.length < 25) return null;
  const w = upto.slice(-(lookback + 21)); // MA 계산 여유
  const closes = w.map(b => b.close);
  const ma = (n: number, i: number) => { const s = closes.slice(Math.max(0, i - n + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; };
  // 각도 눈금: 직전 30봉 평균 고저폭 × 0.5 (창판정 규약 — 봉당 45°)
  const rng = w.map(b => b.high - b.low);
  const unit = Math.max(1e-9, rng.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, rng.length) * 0.5);
  const n = closes.length;
  const from = Math.max(21, n - lookback);
  let sigFlips = 0, flips5 = 0, prevSign20 = 0, prevSign5 = 0, lastDeg = 0;
  for (let i = from; i < n; i++) {
    const s20 = ma(20, i) - ma(20, i - 1);
    const deg20 = Math.atan(s20 / unit) * D;
    const sg = Math.sign(deg20);
    // 유의 반전: 부호가 바뀌고 반전 후 |기울기| > 10° (사용자 정의 — 10° 이하 반전은 추세 취급)
    if (prevSign20 !== 0 && sg !== 0 && sg !== prevSign20 && Math.abs(deg20) > 10) sigFlips++;
    if (sg !== 0) prevSign20 = sg;
    const s5 = ma(5, i) - ma(5, i - 1);
    const sg5 = Math.sign(s5);
    if (prevSign5 !== 0 && sg5 !== 0 && sg5 !== prevSign5) flips5++;
    if (sg5 !== 0) prevSign5 = sg5;
    if (i === n - 1) lastDeg = deg20;
  }
  return { sigFlips, flips5, ma20SlopeDeg: lastDeg };
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date); const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  type R = { date: string; p: number; cut: boolean; kind: string; sigFlips: number | null; flips5: number | null };
  const rows: R[] = [];
  let prevRaw: SoxxBar[] | null = null;
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) { prevRaw = raw; continue; }
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const j = judgeSoxxDay(date, raw, hist, r10, C.newModel.rebox);
    if (!j.c1 && !j.fJ) { prevRaw = raw; continue; }
    const next = dIdx.find((x) => x > date);
    const sc = scoreSoxxDay(raw, j.c1, j.fJ, reg[reg.length - 1].close, next ? dBy.get(next)!.open : null, true, true);
    // 첫 신호(진입) 시점의 chop — F 선행이면 F 시각, 창1 선행이면 창1 시각.
    // 5시간 창은 당일 프리장만으로 부족(07:00 시작) → 전일 세션과 이어붙임(차트를 보는 방식과 동일).
    const entryEt = (j.fJ && (!j.c1 || j.fJ.t < j.c1.t)) ? j.fJ.t : j.c1!.t;
    const glued: SoxxBar[] = [...(prevRaw ?? []).map(b => ({ ...b, etMin: b.etMin - 1440 })), ...raw];
    const b10 = to10m(glued);
    const ch = chopAt(b10, entryEt);
    rows.push({ date, p: sc.p, cut: sc.cut, kind: sc.kind, sigFlips: ch?.sigFlips ?? null, flips5: ch?.flips5 ?? null });
    prevRaw = raw;
  }
  console.log(`SOXX ${rows.length}일 (판정일 기준) · chop 계산 가능 ${rows.filter(r => r.sigFlips !== null).length}일`);
  const d86 = rows.find(r => r.date === "2026-08-06");
  if (d86) console.log(`8/6 실사례: p ${d86.p.toFixed(2)}%${d86.cut ? "(컷)" : ""} · 유의반전(20MA·5h) ${d86.sigFlips}회 · 5MA 반전 ${d86.flips5}회\n`);

  // 유의 반전 분포와 성과의 관계
  console.log(`── 진입 시점 '유의 반전(20MA·|기울기|>10°)' 횟수별 성과 ──`);
  for (const k of [0, 1, 2, 3]) {
    const g = rows.filter(r => r.sigFlips !== null && (k < 3 ? r.sigFlips === k : r.sigFlips! >= 3));
    if (!g.length) continue;
    const tot = g.reduce((a, r) => a + r.p, 0);
    console.log(`  반전 ${k < 3 ? k + "회" : "3회+"}: ${String(g.length).padStart(3)}일 · 합 ${s1(tot).padStart(7)}%p · 일당 ${(tot / g.length).toFixed(2)} · 컷률 ${Math.round(g.filter(r => r.cut).length / g.length * 100)}%`);
  }

  // 게이트 적용: 반전 ≥N이면 그날 진입 보류(0으로)
  console.log(`\n── 게이트: 유의 반전 ≥N이면 진입 보류 ──`);
  const base = rows.reduce((a, r) => a + r.p, 0);
  const m1base = rows.slice(-21).reduce((a, r) => a + r.p, 0);
  console.log(`  기준(필터 없음)         : 전체 ${s1(base)}%p · 최근 1개월 ${s1(m1base)}%p`);
  for (const N of [1, 2, 3]) {
    const f = (r: R) => (r.sigFlips !== null && r.sigFlips >= N ? 0 : r.p);
    const tot = rows.reduce((a, r) => a + f(r), 0);
    const m1 = rows.slice(-21).reduce((a, r) => a + f(r), 0);
    const skipped = rows.filter(r => r.sigFlips !== null && r.sigFlips >= N);
    const skippedP = skipped.reduce((a, r) => a + r.p, 0);
    console.log(`  반전 ≥${N} 보류 (${String(skipped.length).padStart(3)}일 회피, 회피분 합 ${s1(skippedP).padStart(7)}%p): 전체 ${s1(tot).padStart(7)}%p · 최근 1개월 ${s1(m1).padStart(6)}%p`);
  }
  // 5MA 굴곡(참고)
  console.log(`\n── 참고: 5MA 반전 빈도(굴곡도) 분위별 ──`);
  const withF = rows.filter(r => r.flips5 !== null).sort((a, b) => a.flips5! - b.flips5!);
  const q = Math.floor(withF.length / 3);
  for (let i = 0; i < 3; i++) {
    const g = withF.slice(i * q, i === 2 ? withF.length : (i + 1) * q);
    console.log(`  ${["적음", "중간", "많음"][i]}(${g[0].flips5}~${g[g.length - 1].flips5}회): ${g.length}일 · 합 ${s1(g.reduce((a, r) => a + r.p, 0))}%p · 컷률 ${Math.round(g.filter(r => r.cut).length / g.length * 100)}%`);
  }
}
main();
