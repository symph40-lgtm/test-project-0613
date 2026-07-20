// 미국 반도체 레버리지/인버스 신호 — ProShares USD(2x)·SSG(-2x), 기준 지수 SMH.
// 한국 M7과 같은 2축(매크로 Bias + 가격 확인 T-스코어) 구조 (사용자 지정 2026-07-13).
// 서버 렌더 스냅샷 — 새로고침 시 그 시점 실시간. 무인 수집·문자는 야간 크론(/api/signal/us/state).

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { collectUsTick, loadUsTicks, fetchSmhDaily, etNow, toVirtualMin } from "@/lib/signal/us/data";
import { decideUs } from "@/lib/signal/us/engine";
import { loadUsPremarketDays } from "@/lib/signal/us/premarket";
import RefreshButton from "./RefreshButton";

export const dynamic = "force-dynamic";

const DIR_COLOR: Record<string, string> = { 상방: "text-red-600", 하방: "text-blue-600", 중립: "text-ink-48", 미상: "text-ink-48" };

export default async function UsSignalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { date, minuteOfDay, iso } = etNow();
  const [rows, smhDaily, live, preDays] = await Promise.all([
    loadUsTicks(date).catch((): Awaited<ReturnType<typeof loadUsTicks>> => []),
    fetchSmhDaily(15),
    collectUsTick().catch(() => null),
    loadUsPremarketDays(15).catch(() => null),
  ]);
  if (live && (rows.length === 0 || rows[rows.length - 1].ts !== live.ts)) rows.push(live);
  const j = decideUs(rows, smhDaily, toVirtualMin(minuteOfDay), iso, date);
  const t = j.trend;

  const fmtPct = (v: number | null | undefined) => (v == null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

  return (
    <PageShell title="레버리지·인버스 신호 (미국)" badge="US" width="wide" subNavRight={<RefreshButton />}>
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

      {/* 프리장 판정 (사용자 지정 2026-07-21) — 피셔 프리마켓 선판정 + 라이브 채점 누적 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-1 text-[14px] font-semibold">프리장 판정 (07:00~09:25 ET · 피셔)</p>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-48">
          SMH 프리마켓 가격행동으로 정규장 방향 선판정 — 체크포인트 08:00/08:30/09:00 ET, 확정 09:25(개장 직전 · 한국 22:25).
          오프셋: 조기 0.15% / 09:00부터 0.4% (세션 시가 대비, 38일 백테스트). 갭 방향 단독은 43~46%로 무효 —
          피셔 가격행동만 유효. <b>소표본 검증 — 소액만.</b>
        </p>
        {preDays === null ? (
          <p className="text-[13px] text-ink-48">마이그레이션 029(us_premarket_days) 적용 대기 — 적용 후 판정·채점이 여기 쌓입니다.</p>
        ) : (() => {
          const todayRow = preDays.find((d) => d.date === date);
          const scored = preDays.filter((d) => d.hit !== null);
          const hits = scored.filter((d) => d.hit).length;
          const cum = scored.reduce((s, d) => s + (d.pnl_stop ?? 0), 0);
          return (
            <>
              {todayRow ? (
                <p className="text-[13px] text-ink">
                  오늘({date}): <b className={todayRow.final_verdict === "leverage" ? "text-red-600" : todayRow.final_verdict === "inverse" ? "text-blue-600" : "text-ink-48"}>
                    {todayRow.final_verdict === "leverage" ? "상방 — USD(2x) 검토" : todayRow.final_verdict === "inverse" ? "하방 — SSG(-2x) 검토" : "추세없음"}
                  </b>{" "}
                  (강도 {todayRow.strength}% · {todayRow.stage === "final" ? "확정" : "진행 중"})
                  {todayRow.revisions && todayRow.revisions.length > 0 && (
                    <span className="ml-1 text-[12px] text-ink-48">
                      [{todayRow.revisions.map((r) => `${r.checkpoint ?? "모니터"} ${r.verdict === "leverage" ? "상방" : r.verdict === "inverse" ? "하방" : "무"}`).join(" → ")}]
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-[13px] text-ink-48">오늘 판정 없음 — 프리마켓 07:45~09:28 ET(한국 저녁)에 크론이 판정합니다.</p>
              )}
              {scored.length > 0 && (
                <p className="mt-1 text-[13px] text-ink-80">
                  라이브 채점 누적: 방향 신호 {scored.length}회 · 적중 {hits}회({Math.round((hits / scored.length) * 100)}%) ·
                  스탑 적용 {cum >= 0 ? "+" : ""}{cum.toFixed(1)}%p (SMH 기준 · 백테스트 기대 컷 08:30 59%)
                </p>
              )}
              {preDays.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-ink-48"><th className="pr-3 font-normal">날짜</th><th className="pr-3 font-normal">판정</th><th className="pr-3 font-normal">정규장</th><th className="pr-3 font-normal">적중</th><th className="font-normal">스탑손익</th></tr></thead>
                    <tbody>
                      {preDays.slice(0, 10).map((d) => (
                        <tr key={d.date} className="border-t border-hairline">
                          <td className="py-1 pr-3 text-ink-48">{d.date.slice(5)}</td>
                          <td className={`pr-3 font-semibold ${d.final_verdict === "leverage" ? "text-red-600" : d.final_verdict === "inverse" ? "text-blue-600" : "text-ink-48"}`}>
                            {d.final_verdict === "leverage" ? "상방" : d.final_verdict === "inverse" ? "하방" : "무"}
                          </td>
                          <td className="pr-3">{d.r_oc !== null ? `${d.r_oc > 0 ? "+" : ""}${d.r_oc.toFixed(2)}%` : "—"}</td>
                          <td className="pr-3">{d.hit === null ? "—" : d.hit ? "○" : "✕"}</td>
                          <td>{d.pnl_stop !== null && d.hit !== null ? `${d.pnl_stop > 0 ? "+" : ""}${d.pnl_stop.toFixed(2)}%p` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}
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
                <span className="w-8 shrink-0 rounded bg-pearl px-1 text-center font-mono text-[11px] text-ink-48">{s.weight}점</span>
                <span className={`w-10 shrink-0 font-semibold ${!s.available ? "text-ink-48" : s.pass ? (s.dir === "DOWN" ? "text-blue-600" : "text-red-600") : "text-ink-48"}`}>
                  {!s.available ? "미산출" : s.pass ? (s.dir ?? "충족") : "미충족"}
                </span>
                <span className="text-ink-48">{s.label} — {s.detail}{!s.available ? " (만점 제외)" : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 운영 안내 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-pearl/60 p-5 text-[13px] leading-relaxed text-ink-80">
        <p className="font-semibold">무인 수집·문자 발송 설정 (1회)</p>
        <p className="mt-1">cron-job.org에 작업 추가: <code className="rounded bg-canvas px-1">/api/signal/us/state?secret=&lt;CRON_SECRET&gt;</code>을
        <b> 매일 20:55~05:05 KST 1분 간격</b>(월~금 ET 기준, 서머타임 종료 후엔 21:55~06:05)으로 호출.
        페이지를 열어두어도 같은 효과(새로고침 시점 수집)가 있지만 문자·시계열 축적은 크론이 확실합니다.</p>
        <p className="mt-1"><b>프리장 판정 커버</b>: 시작을 20:55로 당기면 프리장 체크포인트(21:00/21:30/22:00/22:25 KST)가 실시간 문자로 나갑니다.
        기존 22:25 시작을 유지해도 22:25 호출이 지난 컷을 소급 판정해 <b>개장(22:30) 전 확정 문자</b>는 나갑니다.</p>
        <p className="mt-1"><b>조용 시간</b>: 01:00~07:00 KST에는 문자(SMS)를 억제하고 이메일만 발송합니다 — 수집·판정은 계속되므로 밤사이 신호는 아침에 이메일로 확인하세요.</p>
        <p className="mt-2 text-[12px] text-ink-48">기준값 도출: SMH 최근 37거래일 5분봉 + 2년 일간 실측 (추세일 12일 추출 — DC1 0.55/DC2 0.14, 급변 스텝 1.1%, 큰갭 4%). 상세: docs/signal-system-master-spec.md 부록.</p>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
