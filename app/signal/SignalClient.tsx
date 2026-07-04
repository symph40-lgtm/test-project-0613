"use client";

// 신호 시스템 대시보드 클라이언트 — /api/signal/state 60초 폴링.
// 페이지를 열어두면 장중 틱이 서버에 축적되어 T-신호·DC 판정이 점점 정교해진다.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldAlert, Activity, Gauge, GitBranch, Layers, FlaskConical, NotebookPen, MessageSquareText } from "lucide-react";
import { PageShell, Disclaimer } from "../_components/Shell";
import type { BacktestResult } from "@/lib/signal/backtest";
import type { CheckItem, DailyFeatureRow, Judgment } from "@/lib/signal/types";

type StateResponse = {
  judgment: Judgment;
  sms: { sent: number; skipped: string | null } | null;
  tickCount: number;
  annotation: {
    cause_tag: string | null;
    cause_note: string | null;
    consensus_intact: boolean | null;
    cause_non_earnings: boolean | null;
  } | null;
  recentFeatures: DailyFeatureRow[];
};

const POLL_MS = 60_000;

const DAY_TYPE_STYLE: Record<string, string> = {
  추세일_상방: "bg-red-50 text-red-600 border-red-200",
  추세일_하방: "bg-blue-50 text-blue-600 border-blue-200",
  V반등후보: "bg-amber-50 text-amber-700 border-amber-200",
  횡보일: "bg-pearl text-ink-48 border-hairline",
  역발상검토: "bg-purple-50 text-purple-700 border-purple-200",
  이벤트보수: "bg-orange-50 text-orange-700 border-orange-200",
  대기: "bg-pearl text-ink-80 border-hairline",
  관찰: "bg-pearl text-ink-80 border-hairline",
  마감: "bg-pearl text-ink-48 border-hairline",
};

const CAUSE_TAGS = ["전쟁·지정학", "관세·규제", "실적", "수급", "소송", "AI뉴스", "매크로", "기타"];

export default function SignalClient({ backtest }: { backtest: BacktestResult[] }) {
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/signal/state", { cache: "no-store" });
      if (!r.ok) throw new Error(`상태 조회 실패 (${r.status})`);
      const j = (await r.json()) as StateResponse;
      setState(j);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const j = state?.judgment ?? null;

  return (
    <PageShell
      title="레버리지·인버스 신호"
      badge="M7"
      width="wide"
      subNavRight={
        <button
          onClick={() => { setLoading(true); load(); }}
          className="flex items-center gap-1.5 rounded-[8px] border border-hairline bg-canvas px-3 py-1.5 text-[13px] hover:bg-pearl"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          {updatedAt ? `${updatedAt} 갱신` : "갱신"}
        </button>
      }
    >
      {error ? (
        <div className="rounded-[14px] border border-red-200 bg-red-50 p-4 text-[14px] text-red-700">
          {error} — 60초 후 자동 재시도합니다.
        </div>
      ) : null}

      {loading && !j ? (
        <div className="rounded-[18px] border border-hairline bg-canvas p-8 text-center text-[14px] text-ink-48">
          신호 판정 계산 중…
        </div>
      ) : null}

      {j ? (
        <div className="space-y-5">
          {/* ── 판정 헤더 */}
          <section className={`rounded-[18px] border p-5 ${DAY_TYPE_STYLE[j.dayType] ?? "bg-canvas border-hairline"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-semibold text-white">{j.phase}</span>
              <span className="text-[13px] font-semibold tracking-[0.02em]">{j.dayType.replace("_", " ")}</span>
              <span className="ml-auto text-[12px] opacity-70">{j.date} · 틱 {state?.tickCount ?? 0}개 축적</span>
            </div>
            <h2 className="mt-2 text-[19px] font-semibold leading-snug">{j.headline}</h2>
            <p className="mt-1.5 text-[14px] leading-relaxed opacity-90">{j.action}</p>
            {j.crashContext.active ? (
              <p className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold text-amber-700">
                <ShieldAlert size={14} /> 분기 1 활성: {j.crashContext.detail} — 인버스 금지(XS1)
              </p>
            ) : null}
            {j.dataNotes.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-[12px] opacity-60">
                {j.dataNotes.map((n, i) => <li key={i}>ⓘ {n}</li>)}
              </ul>
            ) : null}
            <p className="mt-2 flex items-center gap-1.5 text-[12px] opacity-60">
              <MessageSquareText size={13} />
              {state?.sms?.sent ? `문자 알림 ${state.sms.sent}건 발송됨`
                : state?.sms?.skipped === "SMS 채널 없음"
                  ? <>문자 알림을 받으려면 <a href="/positions/risk-line" className="underline">위험선/알림 설정</a>에서 SMS 채널을 인증하세요</>
                  : "문자 알림: 판정 구간(09:30~13:30)에 행동 가능한 판정 확정 시 1일 1회 발송"}
            </p>
          </section>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* ── 축1 Bias */}
            <section className="rounded-[18px] border border-hairline bg-canvas p-5">
              <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
                <Gauge size={15} className="text-guard" /> 축 1 — Bias (매크로·펀더멘털)
              </h3>
              <div className="mt-2 flex items-center gap-2">
                <DirBadge dir={j.bias.dir} />
                <span className="text-[13px] text-ink-80">강도 {j.bias.strength}/3</span>
                <span className="text-[12px] text-ink-48">— 비중 연동: {j.bias.strength >= 3 ? "최대" : j.bias.strength === 2 ? "2/3" : j.bias.strength === 1 ? "1/3" : "보류"}</span>
              </div>
              <ul className="mt-3 space-y-1.5">
                {j.bias.factors.map((f) => (
                  <li key={f.code + f.label} className="flex items-start gap-2 text-[13px]">
                    <span className="mt-0.5 w-8 shrink-0 font-mono text-[11px] text-ink-48">{f.code}</span>
                    <DirDot dir={f.dir} />
                    <span className="text-ink-80">{f.label} <span className="text-ink-48">· {f.detail}</span></span>
                  </li>
                ))}
              </ul>
            </section>

            {/* ── 축2 추세일 판별 */}
            <section className="rounded-[18px] border border-hairline bg-canvas p-5">
              <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
                <Activity size={15} className="text-guard" /> 축 2 — 추세일 판별 (T-스코어)
              </h3>
              {j.trend ? (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <span className="text-[22px] font-semibold tabular-nums">
                      {j.trend.score.toFixed(1)}<span className="text-[14px] text-ink-48">/{j.trend.maxAvailable}</span>
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${j.trend.grade === "추세일" ? "bg-red-50 text-red-600" : j.trend.grade === "횡보일선언" ? "bg-pearl text-ink-48" : "bg-pearl text-ink-80"}`}>
                      {j.trend.grade}{j.trend.dir ? ` · ${j.trend.dir === "UP" ? "상방" : "하방"}` : ""}
                    </span>
                    <span className="text-[12px] text-ink-48">
                      DC1 {j.trend.dc1 !== null ? `${(j.trend.dc1 * 100).toFixed(0)}%` : "-"} · DC2 {j.trend.dc2 !== null ? j.trend.dc2.toFixed(2) : "-"} · 전환 {j.trend.flips}회
                    </span>
                  </div>
                  {/* 정규화 게이지 */}
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-pearl">
                    <div
                      className={`h-full rounded-full ${j.trend.normalized >= 8 / 13 ? "bg-red-500" : j.trend.normalized >= 5 / 13 ? "bg-amber-400" : "bg-ink/20"}`}
                      style={{ width: `${Math.min(100, j.trend.normalized * 100)}%` }}
                    />
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {j.trend.signals.map((s) => (
                      <li key={s.code} className="flex items-start gap-2 text-[13px]">
                        <span className="mt-0.5 w-8 shrink-0 font-mono text-[11px] text-ink-48">{s.code}</span>
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${!s.available ? "bg-ink/10" : s.pass ? (s.dir === "DOWN" ? "bg-blue-500" : "bg-red-500") : "bg-ink/25"}`} />
                        <span className={s.available ? "text-ink-80" : "text-ink-48"}>
                          {s.label} <span className="text-ink-48">· {s.detail}{s.available ? ` (+${s.weight})` : ""}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12px] text-ink-48">
                    시가유형(O1): {j.trend.openType ?? "-"}
                    {j.trend.openCrossCount !== null ? ` · 교차 ${j.trend.openCrossCount}회` : ""}
                    {j.trend.extNotes.length > 0 ? ` · ${j.trend.extNotes.join(" · ")}` : ""}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-[13px] text-ink-48">장 시작(09:00) 후 틱이 축적되면 판정합니다.</p>
              )}
            </section>

            {/* ── 정합성 (D1~D3) */}
            <section className="rounded-[18px] border border-hairline bg-canvas p-5">
              <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
                <GitBranch size={15} className="text-guard" /> 크로스마켓 정합성 (D1~D4)
              </h3>
              {j.divergence ? (
                <>
                  <p className="mt-2 text-[13px]">
                    <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${j.divergence.status === "정합" ? "bg-red-50 text-red-600" : j.divergence.status === "이탈" ? "bg-purple-50 text-purple-700" : "bg-pearl text-ink-48"}`}>
                      {j.divergence.status}
                    </span>
                    {j.divergence.routing ? <span className="ml-2 text-ink-80">→ {j.divergence.routing}</span> : null}
                  </p>
                  <ul className="mt-3 space-y-1.5 text-[13px] text-ink-80">
                    <li>D1 {j.divergence.d1.detail} {okMark(j.divergence.d1.ok)}</li>
                    <li>D3 {j.divergence.d3.detail} {okMark(j.divergence.d3.ok)}</li>
                    <li className="text-ink-48">D2 {j.divergence.d2.detail}</li>
                  </ul>
                  <p className="mt-2 text-[12px] text-ink-48">
                    이탈 + 한국 고유 원인 없음 → 역발상 셋업 / 고유 원인 있음(전쟁·수급 등) → 그 방향 추세로 취급 (D4)
                  </p>
                </>
              ) : (
                <p className="mt-2 text-[13px] text-ink-48">장중에만 판정합니다.</p>
              )}
            </section>

            {/* ── 리스크 (R + A1) */}
            <section className="rounded-[18px] border border-hairline bg-canvas p-5">
              <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
                <ShieldAlert size={15} className="text-guard" /> 리스크 규칙 (진입 시 필수)
              </h3>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
                <div className="rounded-[12px] bg-pearl p-3">
                  <p className="text-[11px] text-ink-48">R1 손실제한 (진입 즉시)</p>
                  <p className="mt-0.5 text-[17px] font-semibold tabular-nums">-{j.risk.stopFixedPct.toFixed(1)}%</p>
                  {j.risk.stopAtrPct !== null ? (
                    <p className="text-[11px] text-ink-48">A1 ATR 권장 -{j.risk.stopAtrPct.toFixed(1)}% (ATR14 {j.risk.atr14Pct?.toFixed(1)}%)</p>
                  ) : null}
                </div>
                <div className="rounded-[12px] bg-pearl p-3">
                  <p className="text-[11px] text-ink-48">R2 트레일링 (이익 방향으로만)</p>
                  <p className="mt-0.5 text-[17px] font-semibold tabular-nums">-{j.risk.trailPct.toFixed(1)}%</p>
                </div>
                <div className="rounded-[12px] bg-pearl p-3">
                  <p className="text-[11px] text-ink-48">R5·R7 비중 (Bias 강도 {j.risk.biasStrength})</p>
                  <p className="mt-0.5 text-[13px] font-medium leading-snug">{j.risk.sizeGuide}</p>
                </div>
                <div className="rounded-[12px] bg-pearl p-3">
                  <p className="text-[11px] text-ink-48">인버스 상한 / 일일 한도</p>
                  <p className="mt-0.5 text-[13px] font-medium">총자산 {j.risk.inverseCapPct}% / 계좌 -{j.risk.dailyLossLimitPct}%</p>
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-[12px] text-ink-48">
                {j.risk.notes.map((n, i) => <li key={i}>· {n}</li>)}
              </ul>
            </section>
          </div>

          {/* ── L/S 셋업 체크리스트 */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <SetupCard
              title="레버리지(롱) 셋업 — L1~L11"
              verdict={j.setups.long.verdict}
              bonus={j.setups.long.bonus}
              bonusMax={11}
              items={j.setups.long.items}
              blocked={j.setups.long.blocked}
              tone="red"
            />
            <SetupCard
              title="인버스 셋업 — S1~S7"
              verdict={j.setups.short.verdict}
              bonus={j.setups.short.bonus}
              bonusMax={5}
              items={j.setups.short.items}
              blocked={j.setups.short.blocked}
              tone="blue"
            />
          </div>

          {/* ── 확장 모듈 상태 */}
          <section className="rounded-[18px] border border-hairline bg-canvas p-5">
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
              <Layers size={15} className="text-guard" /> 확장 신호 모듈 (기본 OFF — 값은 매일 기록, 60일 검증 후 활성화)
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
              <ExtCell label="N1 NR7 수축" value={j.ext.nr7 === null ? "-" : j.ext.nr7 ? "수축 (추세일 확률↑)" : "해당 없음"} on={j.ext.nr7 === true} />
              <ExtCell label="N1 NR4+IB" value={j.ext.nr4Ib === null ? "-" : j.ext.nr4Ib ? "성립" : "해당 없음"} on={j.ext.nr4Ib === true} />
              <ExtCell label="O1 시가유형" value={j.trend?.openType ?? "-"} on={j.trend?.openType === "drive"} />
              <ExtCell label="W1 시장폭" value={j.ext.breadth !== null ? `${(j.ext.breadth * 100).toFixed(0)}%${j.ext.distortionTag ? " · 왜곡" : ""}` : "-"} on={j.ext.distortionTag === true} />
              <ExtCell label="B1 베이시스 기울기" value={j.ext.basisBlackout ? "만기주간 제외" : j.ext.basisSlope !== null ? j.ext.basisSlope.toFixed(2) : "축적 중"} on={false} />
              <ExtCell label="V1 VKOSPI" value="소스 없음 (KIS 확장 대기)" on={false} />
              <ExtCell label="A1 ATR 스탑" value={j.risk.stopAtrPct !== null ? `-${j.risk.stopAtrPct.toFixed(1)}% (mode: ${j.risk.stopMode})` : "-"} on={j.risk.stopMode === "atr"} />
              <ExtCell label="C1 마감 증폭" value={j.risk.closeExtendSuggested ? "조건 성립 (기록만)" : "미성립"} on={j.risk.closeExtendSuggested} />
            </div>
          </section>

          {/* ── 수동 주석 (학습 피처) */}
          <AnnotationForm
            date={j.date}
            annotation={state?.annotation ?? null}
            onSaved={load}
          />

          {/* ── 6월 재현 검증 */}
          <section className="rounded-[18px] border border-hairline bg-canvas p-5">
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
              <FlaskConical size={15} className="text-guard" /> 6월 실사례 재현 검증 (마스터 4.4 · 2.5.7)
            </h3>
            <p className="mt-1 text-[12px] text-ink-48">
              합성 시계열로 재구성한 6월 사례를 실제 판정 엔진에 투입한 결과. Phase 1 성공 기준 — 특히 횡보일 특이도.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-hairline text-[11px] uppercase tracking-wide text-ink-48">
                    <th className="py-2 pr-3">사례</th>
                    <th className="py-2 pr-3">시나리오</th>
                    <th className="py-2 pr-3">기대 판정</th>
                    <th className="py-2 pr-3">엔진 판정</th>
                    <th className="py-2">결과</th>
                  </tr>
                </thead>
                <tbody>
                  {backtest.map((b) => (
                    <tr key={b.name} className="border-b border-hairline/60 align-top">
                      <td className="py-2 pr-3 font-medium whitespace-nowrap">{b.name}</td>
                      <td className="py-2 pr-3 text-ink-80">{b.scenario}</td>
                      <td className="py-2 pr-3 text-ink-80">{b.expected}</td>
                      <td className="py-2 pr-3 text-ink-80">{b.actual}</td>
                      <td className="py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${b.pass ? "bg-red-50 text-red-600" : "bg-pearl text-ink-48"}`}>
                          {b.pass ? "PASS" : "FAIL"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 최근 기록 (daily_features) */}
          <section className="rounded-[18px] border border-hairline bg-canvas p-5">
            <h3 className="text-[14px] font-semibold">최근 일일 기록 (학습 데이터 축적)</h3>
            {state && state.recentFeatures.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13px] tabular-nums">
                  <thead>
                    <tr className="border-b border-hairline text-[11px] uppercase tracking-wide text-ink-48">
                      <th className="py-2 pr-3">날짜</th>
                      <th className="py-2 pr-3">라벨</th>
                      <th className="py-2 pr-3">DC1</th>
                      <th className="py-2 pr-3">DC2</th>
                      <th className="py-2 pr-3">갭</th>
                      <th className="py-2 pr-3">09:30 판정</th>
                      <th className="py-2 pr-3">NR7</th>
                      <th className="py-2">원인 주석</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.recentFeatures.map((f) => (
                      <tr key={f.date} className="border-b border-hairline/60">
                        <td className="py-1.5 pr-3 whitespace-nowrap">{f.date}</td>
                        <td className="py-1.5 pr-3">{f.day_label ?? "-"}</td>
                        <td className="py-1.5 pr-3">{f.dc1 !== null ? `${(f.dc1 * 100).toFixed(0)}%` : "-"}</td>
                        <td className="py-1.5 pr-3">{f.dc2 !== null ? f.dc2.toFixed(2) : "-"}</td>
                        <td className="py-1.5 pr-3">{f.gap !== null ? `${f.gap > 0 ? "+" : ""}${f.gap.toFixed(1)}%` : "-"}</td>
                        <td className="py-1.5 pr-3">{f.judgment_0930 ?? "-"}</td>
                        <td className="py-1.5 pr-3">{f.nr7_flag === null ? "-" : f.nr7_flag ? "○" : "×"}</td>
                        <td className="py-1.5 text-ink-80">{f.cause_tag ? `[${f.cause_tag}] ` : ""}{f.cause_note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-[13px] text-ink-48">아직 기록이 없습니다. 장중에 페이지를 열어두면 자동으로 축적됩니다.</p>
            )}
          </section>
        </div>
      ) : null}

      <Disclaimer />
    </PageShell>
  );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────

function DirBadge({ dir }: { dir: string }) {
  const cls = dir === "상방" ? "bg-red-50 text-red-600" : dir === "하방" ? "bg-blue-50 text-blue-600" : "bg-pearl text-ink-48";
  return <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${cls}`}>{dir}</span>;
}

function DirDot({ dir }: { dir: string }) {
  const cls = dir === "상방" ? "bg-red-500" : dir === "하방" ? "bg-blue-500" : dir === "미상" ? "bg-ink/10" : "bg-ink/25";
  return <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

function okMark(ok: boolean | null): string {
  return ok === null ? "· 판정 유보" : ok ? "· 정합 ✓" : "· 이탈 ⚠";
}

function SetupCard({ title, verdict, bonus, bonusMax, items, blocked, tone }: {
  title: string;
  verdict: string;
  bonus: number;
  bonusMax: number;
  items: CheckItem[];
  blocked: string[];
  tone: "red" | "blue";
}) {
  const verdictCls =
    verdict === "차단" ? "bg-ink text-white"
    : verdict === "강한신호" ? "bg-red-600 text-white"
    : verdict === "진입후보" ? (tone === "red" ? "bg-red-50 text-red-600" : "bg-blue-50 text-blue-600")
    : "bg-pearl text-ink-48";
  return (
    <section className="rounded-[18px] border border-hairline bg-canvas p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${verdictCls}`}>{verdict}</span>
      </div>
      <p className="mt-1 text-[12px] text-ink-48">가점 {bonus}/{bonusMax}점</p>
      {blocked.length > 0 ? (
        <ul className="mt-2 space-y-1 rounded-[10px] bg-pearl p-2.5 text-[12px] font-medium text-ink">
          {blocked.map((b, i) => <li key={i}>⛔ {b}</li>)}
        </ul>
      ) : null}
      <ul className="mt-3 space-y-1.5">
        {items.map((it) => (
          <li key={it.code} className="flex items-start gap-2 text-[13px]">
            <span className="mt-0.5 w-8 shrink-0 font-mono text-[11px] text-ink-48">{it.code}</span>
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${it.pass === null ? "bg-ink/10" : it.pass ? (tone === "red" ? "bg-red-500" : "bg-blue-500") : "bg-ink/25"}`} />
            <span className="text-ink-80">
              {it.label}
              <span className="text-ink-48"> · {it.kind}{it.kind === "가점" ? ` +${it.points}` : ""} · {it.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExtCell({ label, value, on }: { label: string; value: string; on: boolean }) {
  return (
    <div className={`rounded-[12px] p-3 ${on ? "bg-red-50" : "bg-pearl"}`}>
      <p className="text-[11px] text-ink-48">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium leading-snug">{value}</p>
    </div>
  );
}

function AnnotationForm({ date, annotation, onSaved }: {
  date: string;
  annotation: StateResponse["annotation"];
  onSaved: () => void;
}) {
  const [tag, setTag] = useState<string>(annotation?.cause_tag ?? "");
  const [note, setNote] = useState<string>(annotation?.cause_note ?? "");
  const [consensus, setConsensus] = useState<boolean | null>(annotation?.consensus_intact ?? null);
  const [nonEarnings, setNonEarnings] = useState<boolean | null>(annotation?.cause_non_earnings ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 서버 값 갱신 시 폼 동기화 (저장 직후 재조회 반영)
  useEffect(() => {
    if (annotation) {
      setTag(annotation.cause_tag ?? "");
      setNote(annotation.cause_note ?? "");
      setConsensus(annotation.consensus_intact);
      setNonEarnings(annotation.cause_non_earnings);
    }
  }, [annotation]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const r = await fetch("/api/signal/annotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          cause_tag: tag || null,
          cause_note: note || null,
          consensus_intact: consensus,
          cause_non_earnings: nonEarnings,
        }),
      });
      if (r.ok) {
        setSaved(true);
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-[18px] border border-hairline bg-canvas p-5">
      <h3 className="flex items-center gap-1.5 text-[14px] font-semibold">
        <NotebookPen size={15} className="text-guard" /> 오늘의 정성 판단 입력 (L7·L8 + 원인 주석 — 학습 피처)
      </h3>
      <p className="mt-1 text-[12px] text-ink-48">
        자동화할 수 없는 판단입니다. 낙폭 원인과 컨센서스는 셋업 판정(가점·XS2)에 즉시 반영되고, 원인 주석은 학습 데이터로 축적됩니다.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="text-[12px] font-medium text-ink-80">오늘의 지배 재료 태그</label>
          <select
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="mt-1 w-full rounded-[8px] border border-hairline bg-canvas px-2.5 py-2 text-[13px]"
          >
            <option value="">선택 안 함</option>
            {CAUSE_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[12px] font-medium text-ink-80">원인 주석 1줄</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="예: 메타 AI 임대 뉴스로 하닉 급락, 펀더멘털 무관"
            className="mt-1 w-full rounded-[8px] border border-hairline bg-canvas px-2.5 py-2 text-[13px]"
          />
        </div>
        <TriToggle label="L8 — 증권사 이익 컨센서스 유지·상향 중인가?" value={consensus} onChange={setConsensus} />
        <TriToggle label="L7 — 낙폭 원인이 비실적 요인(수급·지정학·소송)인가?" value={nonEarnings} onChange={setNonEarnings} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-[8px] bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
        {saved ? <span className="text-[12px] text-guard">저장됨 — 판정에 반영됩니다</span> : null}
      </div>
    </section>
  );
}

function TriToggle({ label, value, onChange }: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: { v: boolean | null; t: string }[] = [
    { v: true, t: "예" },
    { v: false, t: "아니오" },
    { v: null, t: "미상" },
  ];
  return (
    <div>
      <label className="text-[12px] font-medium text-ink-80">{label}</label>
      <div className="mt-1 flex gap-1.5">
        {opts.map((o) => (
          <button
            key={o.t}
            onClick={() => onChange(o.v)}
            className={`rounded-[8px] border px-3 py-1.5 text-[13px] ${value === o.v ? "border-ink bg-ink text-white" : "border-hairline bg-canvas text-ink-80 hover:bg-pearl"}`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  );
}
