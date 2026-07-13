// 미국 반도체 레버리지/인버스 신호 — ProShares USD(2x)·SSG(-2x), 기준 지수 SMH.
// 한국 M7과 같은 2축(매크로 Bias + 가격 확인 T-스코어) 구조 (사용자 지정 2026-07-13).
// 서버 렌더 스냅샷 — 새로고침 시 그 시점 실시간. 무인 수집·문자는 야간 크론(/api/signal/us/state).

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { collectUsTick, loadUsTicks, fetchSmhDaily, etNow, toVirtualMin } from "@/lib/signal/us/data";
import { decideUs } from "@/lib/signal/us/engine";

export const dynamic = "force-dynamic";

const DIR_COLOR: Record<string, string> = { 상방: "text-red-600", 하방: "text-blue-600", 중립: "text-ink-48", 미상: "text-ink-48" };

export default async function UsSignalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { date, minuteOfDay, iso } = etNow();
  const [rows, smhDaily, live] = await Promise.all([
    loadUsTicks(date).catch((): Awaited<ReturnType<typeof loadUsTicks>> => []),
    fetchSmhDaily(15),
    collectUsTick().catch(() => null),
  ]);
  if (live && (rows.length === 0 || rows[rows.length - 1].ts !== live.ts)) rows.push(live);
  const j = decideUs(rows, smhDaily, toVirtualMin(minuteOfDay), iso, date);
  const t = j.trend;

  const fmtPct = (v: number | null | undefined) => (v == null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

  return (
    <PageShell title="레버리지·인버스 신호 (미국)" badge="US" width="wide">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        미국 정규장(09:30~16:00 ET · 한국 야간)의 반도체 신호 — 상방이면 <b>USD(2x)</b>, 하방이면 <b>SSG(-2x)</b>.
        판정 기준 지수는 <b>SMH</b> (USD와 상관 0.955·β 2.04 — 실측 최적, FKS200 역할).
        한국 M7과 같은 2축 구조이며 임계값은 SMH 실측 분포로 별도 도출. <a href="/signal" className="underline">한국 신호 →</a>
      </p>

      {/* 판정 헤드라인 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <div className="mb-1 flex items-center gap-2 text-[12px] text-ink-48">
          <span>ET {date} · 페이즈 {j.phase}</span>
          <span className="rounded-full bg-pearl px-2 py-0.5 font-semibold">{j.dayType}</span>
        </div>
        <p className="text-[16px] font-semibold text-ink">{j.headline}</p>
        <p className="mt-1 text-[13px] text-ink-80">{j.action}</p>
        {j.dataNotes.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-[12px] text-ink-48">
            {j.dataNotes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </div>

      {/* 시세 */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["SMH (기준)", j.quotes.smhChg], ["USD (2x)", j.quotes.usdChg],
          ["SSG (-2x)", j.quotes.ssgChg], ["^SOX (참고)", j.quotes.soxChg],
        ].map(([name, v]) => (
          <div key={name as string} className="rounded-[14px] border border-hairline bg-canvas p-3">
            <p className="text-[12px] text-ink-48">{name as string}</p>
            <p className={`text-[16px] font-semibold ${typeof v === "number" && v < 0 ? "text-blue-600" : "text-red-600"}`}>{fmtPct(v as number | null)}</p>
          </div>
        ))}
      </div>

      {/* 축1 — usBias */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">축 1 — 매크로 (라이브) <span className={`ml-2 ${DIR_COLOR[j.bias.dir]}`}>{j.bias.dir} 강도{j.bias.strength}</span></p>
        <div className="space-y-1.5">
          {j.bias.factors.map((f) => (
            <div key={f.code} className="flex items-start gap-2 text-[13px]">
              <span className="w-8 shrink-0 font-mono text-[11px] font-semibold text-guard">{f.code}</span>
              <span className="w-32 shrink-0 text-ink">{f.label}</span>
              <span className={`w-10 shrink-0 font-semibold ${DIR_COLOR[f.dir]}`}>{f.dir}</span>
              <span className="text-ink-48">{f.detail}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-ink-48">매크로 게이트: {j.macroGate.detail} — 레버리지(USD) {j.macroGate.leverageOk ? "허용" : "금지"}</p>
      </div>

      {/* 축2 — T-스코어 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">
          축 2 — 가격 확인 (SMH){t ? <span className="ml-2 text-[12px] font-normal text-ink-48">T {t.score.toFixed(1)}/{t.maxAvailable} · 정규화 {(t.normalized * 100).toFixed(0)}% · {t.grade} · DC1 {t.dc1 !== null ? (t.dc1 * 100).toFixed(0) + "%" : "-"} · DC2 {t.dc2?.toFixed(2) ?? "-"}</span> : <span className="ml-2 text-[12px] font-normal text-ink-48">장중 데이터 대기</span>}
        </p>
        {t && (
          <div className="space-y-1.5">
            {t.signals.map((s) => (
              <div key={s.code} className="flex items-start gap-2 text-[13px]">
                <span className="w-8 shrink-0 font-mono text-[11px] font-semibold text-guard">{s.code}</span>
                <span className={`w-10 shrink-0 font-semibold ${!s.available ? "text-ink-48" : s.pass ? (s.dir === "DOWN" ? "text-blue-600" : "text-red-600") : "text-ink-48"}`}>
                  {!s.available ? "미산출" : s.pass ? (s.dir ?? "충족") : "미충족"}
                </span>
                <span className="text-ink-48">{s.label} — {s.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 운영 안내 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-pearl/60 p-5 text-[13px] leading-relaxed text-ink-80">
        <p className="font-semibold">무인 수집·문자 발송 설정 (1회)</p>
        <p className="mt-1">cron-job.org에 작업 추가: <code className="rounded bg-canvas px-1">/api/signal/us/state?secret=&lt;CRON_SECRET&gt;</code>을
        <b> 매일 22:25~05:05 KST 1분 간격</b>(월~금 ET 기준, 서머타임 종료 후엔 23:25~06:05)으로 호출.
        페이지를 열어두어도 같은 효과(새로고침 시점 수집)가 있지만 문자·시계열 축적은 크론이 확실합니다.</p>
        <p className="mt-2 text-[12px] text-ink-48">기준값 도출: SMH 최근 37거래일 5분봉 + 2년 일간 실측 (추세일 12일 추출 — DC1 0.55/DC2 0.14, 급변 스텝 1.1%, 큰갭 4%). 상세: docs/signal-system-master-spec.md 부록.</p>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
