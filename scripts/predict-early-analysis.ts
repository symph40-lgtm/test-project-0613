// 조기 판정 분석 — 8시(NXT 프리마켓) 시작 vs 9시(정규장) 시작의 판정값 차이·정확도 비교.
//   npx tsx scripts/predict-early-analysis.ts --days 220 [--symbol 000660]
//
// 사용자 질문(2026-07-16): "9시부터 모아서 판정하면 너무 늦다. 8시부터 모아 조기 판정하면
// 판정값이 얼마나 달라지는가?" — 4개 변형을 같은 라벨로 비교:
//   A: 09:00 시작 · 10:30 판정 (현행)
//   B: 08:00 시작 · 10:30 판정 (프리마켓 추가, 판정 시각 동일)
//   C: 08:00 시작 · 09:30 판정 (조기 판정)
//   D: 08:00 시작 · 09:00 판정 (개장 즉시 — 프리마켓 50봉만)
// 프리마켓 소스: 넥스트레이드(NXT) 08:00~08:49 1분봉 (KIS FHKST03010230, 시장구분 NX —
// 2026-07-16 실측: 과거 9개월 제공 확인).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { PREDICT_CONFIG } from "../lib/predict/config";
import { labelDay } from "../lib/predict/label";
import { runAllModels } from "../lib/predict/runner";
import { fetchDayMinutes } from "../lib/predict/kisMinute";
import { fetchDailyPredict } from "../lib/predict/data";
import { MODEL_IDS, MODEL_LABELS } from "../lib/predict/types";
import type { MinuteBar, ModelId, Verdict } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const args = process.argv.slice(2);
const DAYS = (() => { const i = args.indexOf("--days"); return i >= 0 ? parseInt(args[i + 1], 10) : 220; })();
const SYMBOL = (() => { const i = args.indexOf("--symbol"); return i >= 0 ? args[i + 1] : PREDICT_CONFIG.symbol; })();
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");

// 토큰 1회 발급 (분당 1회 제한 — 병렬 금지)
let TOKEN: string | null = null;
async function token(): Promise<string | null> {
  if (TOKEN) return TOKEN;
  const BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
  });
  TOKEN = ((await r.json()) as { access_token?: string }).access_token ?? null;
  return TOKEN;
}

async function nxtPre(code: string, date: string): Promise<MinuteBar[] | null> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = resolve(CACHE_DIR, `${code}NX-${date}.json`);
  if (existsSync(file)) {
    try { const c = JSON.parse(readFileSync(file, "utf8")) as MinuteBar[]; if (c.length) return c; } catch { /* 재수집 */ }
  }
  const tok = await token();
  if (!tok) return null;
  const BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
  const ymd = date.replace(/-/g, "");
  const url = new URL(`${BASE}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "NX");
  url.searchParams.set("FID_INPUT_ISCD", code);
  url.searchParams.set("FID_INPUT_DATE_1", ymd);
  url.searchParams.set("FID_INPUT_HOUR_1", "085000");
  url.searchParams.set("FID_PW_DATA_INCU_YN", "N");
  url.searchParams.set("FID_FAKE_TICK_INCU_YN", "");
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${tok}`, appkey: process.env.KIS_APP_KEY!, appsecret: process.env.KIS_APP_SECRET!, tr_id: "FHKST03010230", custtype: "P" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { rt_cd?: string; output2?: Record<string, string>[] };
    if (j.rt_cd !== "0" || !Array.isArray(j.output2)) return null;
    const bars: MinuteBar[] = [];
    for (const row of j.output2) {
      if (row.stck_bsop_date !== ymd) continue;
      const h = row.stck_cntg_hour ?? "";
      const n = (v: string | undefined) => { const x = parseFloat(String(v ?? "")); return isFinite(x) ? x : NaN; };
      const open = n(row.stck_oprc), high = n(row.stck_hgpr), low = n(row.stck_lwpr), close = n(row.stck_prpr);
      if (!/^\d{6}$/.test(h) || ![open, high, low, close].every((v) => v > 0)) continue;
      bars.push({ time: `${h.slice(0, 2)}:${h.slice(2, 4)}`, open, high, low, close, volume: n(row.cntg_vol) || 0 });
    }
    bars.sort((a, b) => (a.time < b.time ? -1 : 1));
    if (bars.length) writeFileSync(file, JSON.stringify(bars));
    return bars.length ? bars : null;
  } catch { return null; }
}

type Variant = "A" | "B" | "C" | "D" | "E" | "F";
const VARIANTS: { key: Variant; label: string; preStart: boolean; judge: string }[] = [
  { key: "A", label: "09:00시작·10:30판정 (현행)", preStart: false, judge: "10:30" },
  { key: "B", label: "08:00시작·10:30판정", preStart: true, judge: "10:30" },
  { key: "C", label: "08:00시작·09:30판정 (조기)", preStart: true, judge: "09:30" },
  { key: "D", label: "08:00시작·09:00판정 (개장즉시)", preStart: true, judge: "09:00" },
  { key: "E", label: "08:00시작·08:30판정 (프리마켓 30분)", preStart: true, judge: "08:30" },
  { key: "F", label: "08:00시작·08:50판정 (프리마켓 전체)", preStart: true, judge: "08:50" },
];

async function main() {
  const code = SYMBOL;
  console.log(`=== 조기 판정 분석 — ${code} 최근 ${DAYS}거래일 (A~D 변형 비교) ===\n`);
  const daily = await fetchDailyPredict(code, DAYS + 140);
  const todayKst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const complete = daily.filter((b) => b.date < todayKst);
  const testDays = complete.slice(-DAYS);

  // 결과 집계 구조
  const acc: Record<Variant, Record<ModelId, { c: number; t: number; dirC: number; dirT: number }>> = {} as never;
  const fisherVerdicts = {} as Record<Variant, Map<string, Verdict>>;
  const exploit = {} as Record<Variant, { sum: number; n: number }>;
  for (const v of VARIANTS) {
    acc[v.key] = Object.fromEntries(MODEL_IDS.map((m) => [m, { c: 0, t: 0, dirC: 0, dirT: 0 }])) as never;
    fisherVerdicts[v.key] = new Map();
    exploit[v.key] = { sum: 0, n: 0 };
  }
  let used = 0, noPre = 0;

  for (const bar of testDays) {
    const idx = complete.findIndex((b) => b.date === bar.date);
    if (idx < 30) continue;
    const history = complete.slice(Math.max(0, idx - 120), idx);
    const ymd = bar.date.replace(/-/g, "");
    const krxFile = resolve(CACHE_DIR, `${code}-${bar.date}.json`);
    let krx: MinuteBar[] | null = null;
    if (existsSync(krxFile)) { try { krx = JSON.parse(readFileSync(krxFile, "utf8")); } catch { krx = null; } }
    if (!krx) krx = await fetchDayMinutes(code, ymd, "153000");
    const pre = await nxtPre(code, bar.date);
    if (!krx || krx.length < 60) continue;
    if (!pre || pre.length < 20) { noPre++; continue; }
    used++;
    const { label } = labelDay(bar);
    const prevDate = complete[idx - 1]?.date;
    let prevMin: MinuteBar[] | null = null;
    const pf = prevDate ? resolve(CACHE_DIR, `${code}-${prevDate}.json`) : null;
    if (pf && existsSync(pf)) { try { prevMin = JSON.parse(readFileSync(pf, "utf8")); } catch { prevMin = null; } }

    for (const v of VARIANTS) {
      const base = v.preStart ? [...pre, ...krx] : krx;
      const morning = base.filter((b2) => b2.time < v.judge);
      if (morning.length < 15) continue;
      const openPx = v.preStart ? pre[0].open : bar.open;
      const outputs = runAllModels({ date: bar.date, dailyHistory: history, openPx, morning, prevDayMinutes: prevMin });
      for (const o of outputs) {
        const a = acc[v.key][o.model];
        a.t++; if (o.verdict === label) a.c++;
        if (o.verdict !== "none") { a.dirT++; if (o.verdict === label) a.dirC++; }
        if (o.model === "fisher") {
          fisherVerdicts[v.key].set(bar.date, o.verdict);
          // 경제성: 진입가 → 종가 (방향 판정일만, 방향 부호 반영).
          // 판정이 09:00 이전이면 실제 진입은 정규장 시가로 가정 (프리마켓 ETF 체결 가정 회피)
          if (o.verdict !== "none") {
            const at = v.judge <= "09:00" ? bar.open : morning[morning.length - 1].close;
            const ret = ((bar.close - at) / at) * 100 * (o.verdict === "leverage" ? 1 : -1);
            exploit[v.key].sum += ret; exploit[v.key].n++;
          }
        }
      }
    }
  }

  console.log(`대상 ${used}일 (프리마켓 데이터 없음 ${noPre}일 제외)\n`);

  // 변형별 모델 성적
  for (const v of VARIANTS) {
    console.log(`── ${v.key}: ${v.label} ──`);
    for (const m of MODEL_IDS) {
      const a = acc[v.key][m];
      if (a.t === 0) continue;
      console.log(
        `  ${MODEL_LABELS[m].padEnd(24)} 정확도 ${((a.c / a.t) * 100).toFixed(1).padStart(5)}% · 방향적중 ${a.dirT ? ((a.dirC / a.dirT) * 100).toFixed(1).padStart(5) + "%" : "  —  "} (${a.dirT}회)`,
      );
    }
    const ex = exploit[v.key];
    console.log(`  피셔 방향판정 경제성(판정시각→종가, 방향 반영): 평균 ${ex.n ? (ex.sum / ex.n).toFixed(2) : "—"}% × ${ex.n}회 = 누적 ${ex.sum.toFixed(1)}%p\n`);
  }

  // 피셔 판정값 일치도 — A(현행) 대비
  console.log("── 피셔 판정값 일치도 (A 현행 대비) ──");
  for (const v of VARIANTS.slice(1)) {
    const dates = [...fisherVerdicts.A.keys()].filter((d) => fisherVerdicts[v.key].has(d));
    let same = 0, dirFlip = 0, noneToDir = 0, dirToNone = 0;
    for (const d of dates) {
      const a = fisherVerdicts.A.get(d)!, b = fisherVerdicts[v.key].get(d)!;
      if (a === b) same++;
      else if (a !== "none" && b !== "none") dirFlip++;
      else if (a === "none") noneToDir++;
      else dirToNone++;
    }
    console.log(
      `A vs ${v.key}: 일치 ${((same / dates.length) * 100).toFixed(1)}% (${same}/${dates.length}) · 방향 뒤집힘 ${dirFlip} · 없음→방향 ${noneToDir} · 방향→없음 ${dirToNone}`,
    );
  }
}

main().catch((e) => { console.error("분석 실패:", e); process.exit(1); });
