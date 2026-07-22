// 미국 반도체 레버리지/인버스 신호 — ProShares USD(2x)·SSG(-2x), 기준 지수 SMH.
// 한국 M7과 같은 2축(매크로 Bias + 가격 확인 T-스코어) 구조 (사용자 지정 2026-07-13).
// 서버 렌더 스냅샷 — 새로고침 시 그 시점 실시간. 무인 수집·문자는 야간 크론(/api/signal/us/state).

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { collectUsTick, loadUsTicks, fetchSmhDaily, etNow, toVirtualMin } from "@/lib/signal/us/data";
import { decideUs } from "@/lib/signal/us/engine";
import { loadUsPredictDays } from "@/lib/signal/us/predictStream";
import RefreshButton from "./RefreshButton";

export const dynamic = "force-dynamic";

const DIR_COLOR: Record<string, string> = { 상방: "text-red-600", 하방: "text-blue-600", 중립: "text-ink-48", 미상: "text-ink-48" };

export default async function UsSignalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { date, minuteOfDay, iso } = etNow();
  const [rows, smhDaily, live, predDays] = await Promise.all([
    loadUsTicks(date).catch((): Awaited<ReturnType<typeof loadUsTicks>> => []),
    fetchSmhDaily(15),
    collectUsTick().catch(() => null),
    loadUsPredictDays(15).catch(() => null),
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

      {/* 미장 예측 스트림 (사용자 지정 2026-07-21) — 국장 동일 구조: 프리장 user 모델 · 정규장 피셔.
          판정 지수 SOXX — SOXL(3x)/SOXS(-3x) 체결 (4차 지시: SMH→SOXX 교체, USD/SSG는 저유동 폐기) */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-1 text-[14px] font-semibold">예측 스트림 (3단계 피셔 F→M→본 · 기준 SOXX)</p>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-48">
          한국 예측 체크포인트 스트림의 미국판 — 조기창(프리장 08:30 ET~11:00 ET)은 <b>피셔F</b>(0.05·1봉·강돌파, 07:00 창),
          이후는 <b>본피셔</b>(0.15, 09:30 창). 확정 14:30 ET. 본판정 구간엔 피셔F 반전 임시판정(1단계 50%) →
          피셔M 중간확인(2단계 +30%p) → 본피셔 확정(3단계 +20%p) 비중 프로토콜 문자.
          기준 지수 <b>SOXX</b>(SOXL과 상관 0.999·β 2.95) — 상방=<b>SOXL(3x)</b>·하방=<b>SOXS(-3x)</b>,
          스탑 ETF -6.0%(SOXX -2.0%)·16:00 ET 당일청산. <b>분봉 상수는 38일 소표본 검증(야후 분봉 한계) — 소액만.</b>
        </p>
        {predDays === null ? (
          <p className="text-[13px] text-ink-48">마이그레이션 029(us_predict_days) 적용 대기 — 적용 후 판정·채점이 여기 쌓입니다.</p>
        ) : (() => {
          const todayRow = predDays.find((d) => d.date === date);
          const scored = predDays.filter((d) => d.hit !== null);
          const hits = scored.filter((d) => d.hit).length;
          const cum = predDays.reduce((s, d) => s + (d.pnl_stop ?? 0), 0);
          return (
            <>
              {todayRow ? (
                <p className="text-[13px] text-ink">
                  오늘({date}): <b className={todayRow.final_verdict === "leverage" ? "text-red-600" : todayRow.final_verdict === "inverse" ? "text-blue-600" : "text-ink-48"}>
                    {todayRow.final_verdict === "leverage" ? "레버리지 — SOXL(3x) 검토" : todayRow.final_verdict === "inverse" ? "인버스 — SOXS(-3x) 검토" : "추세없음"}
                  </b>{" "}
                  (강도 {todayRow.strength}% · {todayRow.stage === "final" ? "확정" : "진행 중"})
                  {todayRow.revisions && todayRow.revisions.length > 0 && (
                    <span className="ml-1 text-[12px] text-ink-48">
                      [{todayRow.revisions.map((r) => `${r.checkpoint ?? "모니터"}${r.judge === "fisherF" ? "(F)" : r.judge === "user" ? "(u)" : ""} ${r.verdict === "leverage" ? "레버" : r.verdict === "inverse" ? "인버" : "무"}`).join(" → ")}]
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-[13px] text-ink-48">오늘 판정 없음 — 08:31~14:33 ET(한국 저녁~새벽)에 크론이 체크포인트를 판정합니다.</p>
              )}
              {scored.length > 0 && (
                <p className="mt-1 text-[13px] text-ink-80">
                  라이브 채점 누적: 확정 방향 {scored.length}회 · 적중 {hits}회({Math.round((hits / scored.length) * 100)}%) ·
                  첫 신호 진입 스탑 손익 {cum >= 0 ? "+" : ""}{cum.toFixed(1)}%p (기준 지수 % — 7/20까지는 SMH·이후 SOXX)
                </p>
              )}
              {predDays.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-ink-48"><th className="pr-3 font-normal">날짜</th><th className="pr-3 font-normal">확정</th><th className="pr-3 font-normal">라벨</th><th className="pr-3 font-normal">정규장</th><th className="pr-3 font-normal">적중</th><th className="font-normal">첫신호 손익</th></tr></thead>
                    <tbody>
                      {predDays.slice(0, 10).map((d) => (
                        <tr key={d.date} className="border-t border-hairline">
                          <td className="py-1 pr-3 text-ink-48">{d.date.slice(5)}</td>
                          <td className={`pr-3 font-semibold ${d.final_verdict === "leverage" ? "text-red-600" : d.final_verdict === "inverse" ? "text-blue-600" : "text-ink-48"}`}>
                            {d.final_verdict === "leverage" ? "레버" : d.final_verdict === "inverse" ? "인버" : "무"}
                          </td>
                          <td className="pr-3 text-ink-48">{d.label === "leverage" ? "상방" : d.label === "inverse" ? "하방" : d.label === "none" ? "무" : "—"}</td>
                          <td className="pr-3">{d.r_oc !== null ? `${d.r_oc > 0 ? "+" : ""}${d.r_oc.toFixed(2)}%` : "—"}</td>
                          <td className="pr-3">{d.hit === null ? "—" : d.hit ? "○" : "✕"}</td>
                          <td>{d.pnl_stop !== null ? `${d.pnl_stop > 0 ? "+" : ""}${d.pnl_stop.toFixed(2)}%p` : "—"}</td>
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
        <p className="mt-1"><b>예측 스트림 커버</b>: 시작을 20:55로 당기면 프리장 체크포인트(21:30/22:00/22:25 KST)가 실시간 문자로 나갑니다.
        기존 22:25 시작을 유지해도 22:25 호출이 지난 컷을 소급 판정합니다. 정규장 체크포인트(23:00~03:33 KST)는 기존 크론 창이 커버하며,
        01:00 이후(12:30 ET~)는 조용 시간이라 이메일로만 갑니다.</p>
        <p className="mt-1"><b>조용 시간</b>: 01:00~07:00 KST에는 문자(SMS)를 억제하고 이메일만 발송합니다 — 수집·판정은 계속되므로 밤사이 신호는 아침에 이메일로 확인하세요.</p>
        <p className="mt-2 text-[12px] text-ink-48">기준값 도출: SMH 최근 37거래일 5분봉 + 2년 일간 실측 (추세일 12일 추출 — DC1 0.55/DC2 0.14, 급변 스텝 1.1%, 큰갭 4%). 상세: docs/signal-system-master-spec.md 부록.</p>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
