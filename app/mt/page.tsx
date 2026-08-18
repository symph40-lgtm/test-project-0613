// MT 시장 톤 — 별도 메뉴 (발주자 지시 2026-08-18 §1). 스탁가드 > 시장·알림·분석 하위, 일봉 갭예측 위.
// 내용: 3종목 MT 상시 줄(톤·패널·박스) + 60일 톤 추이 차트 + 부품 계급표(강건/미검증/강등).
// T2·R1 카드의 MT 한 줄 요약은 /g1에 유지 — 상세는 이 페이지로.
// 1단계 표시 전용(판정 무개입). 전환 선언 트랙은 동결(8/16) — 노출하지 않는다. 톤 트랙 "검증 미달" 꼬리표 유지.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";
import { mtCardLines, MT_DISCLAIMER } from "@/lib/mt/report";
import { MT_CONFIG, MT_NAME, PART_NAMES } from "@/lib/mt/config";
import type { MtDay } from "@/lib/mt/types";

export const dynamic = "force-dynamic";

const SYMS = ["KOSPI200", "005930", "000660"] as const;

function Card({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[15px] font-semibold">{title}</p>
        {badge ? <span className="rounded-full bg-pearl px-2 py-0.5 text-[11px] font-semibold text-ink-48">{badge}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 60일 톤 추이 — 서버 렌더 인라인 SVG (외부 라이브러리 없음). MT ∈ [-1,1], 0선 기준 상하. */
function ToneChart({ series }: { series: { symbol: string; points: { date: string; mt: number }[] }[] }) {
  const W = 640, H = 180, PAD = { l: 34, r: 12, t: 10, b: 22 };
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  if (!dates.length) return <p className="text-[13px] text-ink-48">추이 데이터 없음 (백필 후 표시)</p>;
  const x = (d: string) => PAD.l + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((1 - v) / 2) * (H - PAD.t - PAD.b);
  const color: Record<string, string> = { KOSPI200: "#111827", "005930": "#dc2626", "000660": "#2563eb" };
  const tick = (i: number) => dates[Math.min(dates.length - 1, Math.round((dates.length - 1) * i / 4))];
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="MT 톤 60일 추이">
        {/* 격자·0선 */}
        {[-1, -0.5, 0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "#6b7280" : "#e5e7eb"} strokeWidth={v === 0 ? 1.2 : 0.8} />
            <text x={PAD.l - 6} y={y(v) + 3.5} fontSize="9" textAnchor="end" fill="#6b7280">{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        {/* 강도 밴드 (약 <0.2 · 중 · 강 ≥0.5) */}
        <rect x={PAD.l} y={y(0.5)} width={W - PAD.l - PAD.r} height={y(-0.5) - y(0.5)} fill="#f3f4f6" opacity="0.5" />
        {series.map((s) => {
          const pts = s.points.filter((p) => dates.includes(p.date));
          if (pts.length < 2) return null;
          const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.mt).toFixed(1)}`).join(" ");
          const last = pts[pts.length - 1];
          return (
            <g key={s.symbol}>
              <path d={d} fill="none" stroke={color[s.symbol] ?? "#111"} strokeWidth={s.symbol === "KOSPI200" ? 2 : 1.4} strokeLinejoin="round" />
              <circle cx={x(last.date)} cy={y(last.mt)} r={2.6} fill={color[s.symbol] ?? "#111"} />
            </g>
          );
        })}
        {[0, 1, 2, 3, 4].map((i) => (
          <text key={i} x={x(tick(i))} y={H - 6} fontSize="9" textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} fill="#6b7280">{tick(i).slice(5)}</text>
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-ink-48">
        <span style={{ color: "#111827" }}>■</span> 코스피200 · <span style={{ color: "#dc2626" }}>■</span> 삼성전자 · <span style={{ color: "#2563eb" }}>■</span> 하이닉스 — 회색 밴드 = 강도 「중」 구간(±0.2~0.5), 0선 위 상승 에너지 / 아래 하락 에너지
      </p>
    </div>
  );
}

export default async function MtPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const admin = createAdminClient();
  const { data, error } = await admin.from("mt_days").select("*").order("date", { ascending: false }).limit(200);
  const rows = (data ?? []) as MtDay[];
  const latest = new Map<string, MtDay>();
  for (const r of rows) if (!latest.has(r.symbol)) latest.set(r.symbol, r);
  const dates60 = [...new Set(rows.map((r) => r.date))].sort().slice(-60);
  const series = SYMS.map((s) => ({
    symbol: s,
    points: rows.filter((r) => r.symbol === s && dates60.includes(r.date)).sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, mt: r.tone.mt })),
  }));

  // 부품 계급표 — config 등록 상태 그대로 (v0.4.2 동결)
  const AP = MT_CONFIG.approved;
  const cls = (k: string) => {
    if ((AP.unstableParts as readonly string[]).includes(k)) return { rank: "미검증", note: "안정성 미검증 — 1표 유지·라이브 전진 검증 이송 (MT-CS: S1_2·S1_4·S3_4 0.5표 강등 상신 중)" };
    if ((AP.wolfParts as readonly string[]).includes(k)) return { rank: "강등", note: `늑대소년 — 단독 1표 박탈, ${AP.voteWeightOverride[k] ?? AP.wolfVote}표 (보조 증거)` };
    if (AP.voteWeightOverride[k] != null) return { rank: "부분 강등", note: `안정성 진단 한쪽만 lift>1 → ${AP.voteWeightOverride[k]}표` };
    return { rank: "강건", note: "1표" };
  };
  const partKeys = Object.keys(PART_NAMES);
  const rankColor: Record<string, string> = { 강건: "text-emerald-700", "부분 강등": "text-amber-700", 미검증: "text-ink-48", 강등: "text-red-600" };
  const latestDate = [...latest.values()].map((r) => r.date).sort().pop();

  return (
    <PageShell title="MT 시장 톤" badge="1단계 표시" width="default">
      <div className="mb-3 rounded-[14px] border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
        {MT_DISCLAIMER} 톤 트랙은 <b>검증 미달</b> 꼬리표 상태(방향 적중 54%, 코스피200 200종목 중앙값 50%) — 참고만, 판정 무개입. 전환 선언 트랙은 동결(8/16, 로그만).
      </div>
      {error ? <p className="text-[13px] text-red-600">mt_days 조회 실패 — 마이그레이션 037 확인: {error.message}</p> : null}

      {/* 1. 3종목 MT 상시 줄 */}
      <Card title={`시장·종목 톤 — ${latestDate ?? "산출 전"}`} badge="MT 줄">
        {SYMS.map((s) => {
          const d = latest.get(s);
          if (!d) return <p key={s} className="py-1.5 text-[13px] text-ink-48">{MT_NAME[s]}: 산출 전</p>;
          const l = mtCardLines(d);
          return (
            <div key={s} className="border-b border-hairline/40 py-2 text-[12px] last:border-b-0">
              <p className="font-semibold text-ink-80">{l.head}</p>
              <p className="text-ink-48">{l.panel}</p>
              <p className="text-ink-48">{l.tail}</p>
              {l.flags.length ? <p className="mt-0.5 text-[11px] font-semibold text-amber-700">{l.flags.join(" · ")}</p> : null}
            </div>
          );
        })}
      </Card>

      {/* 2. 60일 톤 추이 */}
      <Card title="톤 추이 — 최근 60거래일" badge="MT ∈ [−1, +1]">
        <ToneChart series={series} />
      </Card>

      {/* 3. 부품 계급표 */}
      <Card title="부품 계급표 (v0.4.2 동결)" badge="투표 가중">
        <p className="mb-2 text-[11px] text-ink-48">
          C1 등급 A·B 한정 활성화(등급 C 프록시는 기록만) · 강건 = 1표 · 부분 강등 = 0.75표 · 늑대소년 = 0.5/0.25표(보조 증거) · 미검증 = 1표 유지 + 라이브 전진 검증. 근거: MT_AUTOPSY.md · mt-stability.md · MT_CROSSSECTION.md
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead><tr className="border-b border-hairline text-left text-ink-48"><th className="py-1 pr-2">패널</th><th className="py-1 pr-2">부품</th><th className="py-1 pr-2">계급</th><th className="py-1">비고</th></tr></thead>
            <tbody>
              {partKeys.map((k) => {
                const c = cls(k);
                return (
                  <tr key={k} className="border-b border-hairline/40">
                    <td className="py-1 pr-2 text-ink-48">{k.slice(0, 2)}</td>
                    <td className="py-1 pr-2 text-ink-80">{PART_NAMES[k]}{(AP.c1Parts as readonly string[]).includes(k) ? <span className="text-ink-48"> (C1 파생)</span> : null}</td>
                    <td className={`py-1 pr-2 font-semibold ${rankColor[c.rank] ?? ""}`}>{c.rank}</td>
                    <td className="py-1 text-ink-48">{c.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
