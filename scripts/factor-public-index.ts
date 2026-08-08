// Phase 1 — 공개 지수(EPU·GPR·반도체 PPI)의 리프트 검정 (docs/factor-quant-plan.md):
//   npx tsx scripts/factor-public-index.ts
// 이 팩터들은 10년+ 공개 시계열이라 60일을 기다리지 않고 지금 검정할 수 있다는 점이 핵심이다.
//   EPU  = 경제정책 불확실성 지수 (FRED USEPUINDXD, 일간)
//   GPR  = 지정학 리스크 지수 (FRED GPRD, 일간)
//   PPI  = 미 반도체 PPI (FRED PCU334413334413, 월간 — 월 변화율로 사용)
//   VIX  = 대조군 (FRED VIXCLS, 일간)
// 검정 대상은 기획 1장의 T0~T3. 각 팩터는 '레벨'과 '변화'를 모두 본다 — 불확실성 지표는 절대 레벨보다
// 급등 여부가 신호일 가능성이 높기 때문. 채택 기준은 기존과 동일: 2종목 × 3구간 무해+개선.
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const CACHE = resolve(process.cwd(), ".predict-cache");
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const load = (f: string): MinuteBar[] | null => existsSync(resolve(CACHE, f)) ? JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) : null;

const FRED = process.env.FRED_API_KEY;

async function fred(id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!FRED) return out;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED}&file_type=json&observation_start=2015-01-01`;
  try {
    const r = await fetch(url);
    if (!r.ok) { console.log(`  ⚠${id}: HTTP ${r.status}`); return out; }
    const j = await r.json() as { observations?: { date: string; value: string }[] };
    for (const o of j.observations ?? []) {
      const v = parseFloat(o.value);
      if (isFinite(v)) out.set(o.date, v);
    }
  } catch (e) { console.log(`  ⚠${id}: ${(e as Error).message}`); }
  return out;
}

// 그 날짜 이전(포함) 가장 최근 값 — 발표 지연·휴일 대응
function asOf(m: Map<string, number>, date: string): number | null {
  if (!m.size) return null;
  let best: number | null = null, bestD = "";
  for (const [d, v] of m) if (d <= date && d > bestD) { bestD = d; best = v; }
  return best;
}

type Day = { date: string; open: number; close: number };
function collect(code: string): Day[] {
  const files = readdirSync(CACHE).filter((f) => f.startsWith(code + "-2") && f.endsWith(".json") && f.length === code.length + 16).sort();
  const out: Day[] = [];
  for (const f of files) {
    const date = f.slice(code.length + 1, code.length + 11);
    const reg = load(f) ?? []; if (reg.length < 100) continue;
    out.push({ date, open: reg[0].open, close: reg[reg.length - 1].close });
  }
  return out;
}

async function main() {
  if (!FRED) { console.error("FRED_API_KEY 없음 — .env.local 확인"); return; }
  console.log("FRED 시계열 수신 중...");
  const series: [string, string, Map<string, number>][] = [];
  for (const [id, label] of [["USEPUINDXD", "EPU 정책불확실성(일)"], ["GPRD", "GPR 지정학리스크(일)"], ["PCU334413334413", "미 반도체 PPI(월)"], ["VIXCLS", "VIX(대조군)"]] as [string, string][]) {
    const m = await fred(id);
    console.log(`  ${label.padEnd(24)} ${m.size}개 관측${m.size ? ` (${[...m.keys()].sort()[0]} ~ ${[...m.keys()].sort().pop()})` : ""}`);
    if (m.size) series.push([id, label, m]);
  }
  if (!series.length) { console.log("사용 가능한 시계열 없음"); return; }

  for (const [code, name] of [["000660", "하이닉스"], ["005930", "삼성전자"]] as [string, string][]) {
    const days = collect(code);
    type R = { date: string; t0: number; t1: number; t2: number };
    const rows: R[] = [];
    for (let i = 0; i < days.length - 1; i++) {
      const c = days[i], n = days[i + 1];
      rows.push({
        date: c.date,
        t0: ((n.open - c.close) / c.close) * 100,
        t1: ((n.close - n.open) / n.open) * 100,
        t2: ((n.close - c.close) / c.close) * 100,
      });
    }
    const upT = { t0: rows.filter(r => r.t0 > 0).length, t1: rows.filter(r => r.t1 > 0).length, t2: rows.filter(r => r.t2 > 0).length };
    console.log(`\n════ ${name} — ${rows.length}일 · 기저 상승 T0 ${pctOf(upT.t0, rows.length)}% · T1 ${pctOf(upT.t1, rows.length)}% · T2 ${pctOf(upT.t2, rows.length)}% ════`);

    for (const [, label, m] of series) {
      // 레벨과 5일 변화 두 축
      const lv: (number | null)[] = rows.map(r => asOf(m, r.date));
      const ch: (number | null)[] = rows.map((r, i) => {
        const a = lv[i]; if (a == null || i < 5) return null;
        const b = lv[i - 5]; return b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
      });
      const cover = lv.filter(x => x != null).length;
      if (cover < 100) { console.log(`  ${label.padEnd(24)} 커버 ${cover}일 — 부족`); continue; }
      const line: string[] = [];
      for (const [axis, vals, hi, lo] of [["레벨 상위30%", lv, 0, 0], ["5일 급등 ≥+10%", ch, 10, 0], ["5일 급락 ≤-10%", ch, 0, -10]] as [string, (number | null)[], number, number][]) {
        // 상위 30% 임계 (레벨) 또는 변화 임계
        const valid = vals.map((v, i) => ({ v, i })).filter(x => x.v != null) as { v: number; i: number }[];
        const srt = valid.map(x => x.v).sort((a, b) => a - b);
        const p70 = srt[Math.floor(srt.length * 0.7)];
        const sel = axis.startsWith("레벨") ? valid.filter(x => x.v >= p70) : hi > 0 ? valid.filter(x => x.v >= hi) : valid.filter(x => x.v <= lo);
        if (sel.length < 25) { line.push(`${axis} n=${sel.length}(부족)`); continue; }
        // 불확실성 상승 = 하방 가설이므로 숏(-1) 방향으로 채점
        const dir = -1;
        const res: string[] = [];
        for (const t of ["t0", "t1", "t2"] as const) {
          const hit = sel.filter(x => rows[x.i][t] * dir > 0).length;
          const base = rows.length - upT[t]; // 숏 방향 기저 = 하락일 수
          const lift = pctOf(hit, sel.length) - pctOf(base, rows.length);
          res.push(`${t.toUpperCase()} ${s2(sel.reduce((a, x) => a + rows[x.i][t] * dir, 0) / sel.length)}%/리프트${lift >= 0 ? "+" : ""}${lift}`);
        }
        line.push(`${axis}(n=${sel.length}) ${res.join(" · ")}`);
      }
      console.log(`  ${label}`);
      for (const l of line) console.log(`     ${l}`);
    }
  }
  console.log(`\n  ※ 부호 규약: 불확실성 지표 상승 = 하방 가설 → 숏(-1) 방향으로 채점. 리프트가 양수여야 신호.`);
  console.log(`  ※ 채택 기준: 2종목 × 3구간 무해+개선 (여기서는 전체 구간만 — 통과 후보가 나오면 구간 분해).`);
}
main();
