// 보유 매매 판단 "판정 vs 실제" 대조 리포트 — `npx tsx scripts/stance-error-report.ts [일수]`
// stance_snapshots(매일 15:40 EOD 저장)를 읽어 ①스탠스 구간별 익일 평균 수익률
// ②오판 사례(강한 매수 판정 후 급락 / 매도 판정 후 급등) ③요인별 기여 힌트를 출력한다.
// 표본이 쌓일수록 기준값(사다리·상한) 조정 근거가 된다 (사용자 지정 2026-07-13).

import { readFileSync } from "fs";
import { join } from "path";

const env: Record<string, string> = {};
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

type Row = {
  date: string; ticker: string; stance: number; score: number;
  day_change_pct: number | null; market_drop_pct: number | null; composite: number | null;
  next_day_pct: number | null; reason: string | null;
  factors: { label: string; pts: number; detail: string }[] | null;
};

async function main() {
  const days = parseInt(process.argv[2] ?? "60", 10);
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const res = await fetch(
    `${URL_}/rest/v1/stance_snapshots?date=gte.${since}&select=date,ticker,stance,score,day_change_pct,market_drop_pct,composite,next_day_pct,reason,factors&order=date.asc&limit=2000`,
    { headers: H },
  );
  if (!res.ok) {
    console.log(`조회 실패 HTTP ${res.status} — 마이그레이션 021(stance_snapshots) 적용 여부를 확인하세요.`);
    console.log((await res.text()).slice(0, 200));
    return;
  }
  const rows = (await res.json()) as Row[];
  if (rows.length === 0) {
    console.log("스냅샷 없음 — 매일 15:40 signal-eod 크론이 쌓기 시작합니다 (마이그레이션 021 적용 필요).");
    return;
  }

  console.log(`── 스냅샷 ${rows.length}건 (${rows[0].date} ~ ${rows[rows.length - 1].date})\n`);

  // ① 스탠스 구간별 익일 수익률
  const withNext = rows.filter((r) => r.next_day_pct !== null);
  const buckets = new Map<number, number[]>();
  for (const r of withNext) {
    const arr = buckets.get(r.stance) ?? [];
    arr.push(r.next_day_pct as number);
    buckets.set(r.stance, arr);
  }
  console.log("① 스탠스별 익일 수익률 (판정이 맞다면 스탠스가 높을수록 평균이 높아야 함)");
  console.log("  스탠스  표본  평균     최소     최대");
  for (const s of [...buckets.keys()].sort((a, b) => b - a)) {
    const v = buckets.get(s)!;
    const avg = v.reduce((a, x) => a + x, 0) / v.length;
    console.log(
      `  ${String(s).padStart(4)}   ${String(v.length).padStart(3)}  ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%  ${Math.min(...v).toFixed(1)}%  ${Math.max(...v).toFixed(1)}%`,
    );
  }

  // ② 오판 사례 — 매수 우위(≥7) 판정 후 익일 -3% 이하 / 매도 우위(≤4) 판정 후 익일 +3% 이상
  const misses = withNext.filter(
    (r) => (r.stance >= 7 && (r.next_day_pct as number) <= -3) || (r.stance <= 4 && (r.next_day_pct as number) >= 3),
  );
  console.log(`\n② 오판 사례 ${misses.length}건 (매수판정→익일 -3%↓ 또는 매도판정→익일 +3%↑)`);
  for (const r of misses) {
    console.log(`  ${r.date} ${r.ticker}: 스탠스 ${r.stance}(점수 ${r.score}) → 익일 ${(r.next_day_pct as number) >= 0 ? "+" : ""}${(r.next_day_pct as number).toFixed(1)}%`);
    const top = (r.factors ?? []).filter((f) => f.pts !== 0).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 4);
    if (top.length) console.log(`    주요 요인: ${top.map((f) => `${f.label} ${f.pts > 0 ? "+" : ""}${f.pts}(${f.detail})`).join(" · ")}`);
  }

  // ③ 오판에 가장 자주 기여한 요인 (가점 방향이 틀린 쪽으로 실린 요인 빈도)
  const contrib = new Map<string, number>();
  for (const r of misses) {
    const wrongUp = r.stance >= 7; // 매수 판정이 틀림 → 가점(+) 요인이 범인
    for (const f of r.factors ?? []) {
      if ((wrongUp && f.pts > 0) || (!wrongUp && f.pts < 0)) {
        contrib.set(f.label, (contrib.get(f.label) ?? 0) + Math.abs(f.pts));
      }
    }
  }
  if (contrib.size > 0) {
    console.log("\n③ 오판 기여 요인 랭킹 (|점수| 누적 — 상위 요인의 기준값부터 조정 검토)");
    for (const [label, pts] of [...contrib.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${label}: 누적 ${pts}점`);
    }
  }
  if (withNext.length === 0) console.log("\n(next_day_pct 백필 전 — 이틀째 EOD부터 대조 가능)");
}

main();
