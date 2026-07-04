"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { PageShell, Disclaimer } from "../../_components/Shell";
import { Button } from "../../_components/Button";
import { Card, SectionLabel, MetaRow } from "../../_components/primitives";
import { bookmarkNextBriefing, getEventInsight, getEarningsInsight, type EventInsight } from "./actions";
import type { BriefingSnapshot, AiPrecloseOutput } from "@/lib/market/types";
import type { EconEvent } from "@/lib/calendar/fred";
import type { EarningsEvent, EarningsFundamentals } from "@/lib/market/earnings";
import type { EarningsKeyPoint, IndicatorConsensus } from "@/lib/ai/earningsFocus";
import type { StockFlow } from "@/lib/market/naver-flow";

function flowText(v: number | null): { text: string; cls: string } {
  if (v === null) return { text: "—", cls: "text-ink-48" };
  const cls = v > 0 ? "text-red-600" : v < 0 ? "text-blue-600" : "text-ink-48";
  return { text: `${v > 0 ? "+" : ""}${v.toLocaleString("ko-KR")}주`, cls };
}

// 발표일로부터 오늘까지 경과일 (KST 날짜 기준)
function daysSince(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`).getTime();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((today - d) / 86400000);
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function fmtEventDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  const label = dateStr === today ? "오늘" : `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
  return label;
}

function Stars({ n }: { n: number }) {
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-amber-500" title={`중요도 ${n}/5`}>
      {"★".repeat(n)}
      <span className="text-ink-48/30">{"☆".repeat(Math.max(0, 5 - n))}</span>
    </span>
  );
}

function EventRow({ e }: { e: EconEvent }) {
  const [insight, setInsight] = useState<EventInsight | null>(null);
  const [pending, start] = useTransition();

  function load() {
    if (insight) { setInsight(null); return; } // 토글로 접기
    start(async () => {
      setInsight(await getEventInsight({
        name: e.name, date: e.date, timeKst: e.timeKst,
        released: e.released, fredSeries: e.fredSeries, unit: e.unit,
      }));
    });
  }

  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-medium">{e.name}</span>
          <Stars n={e.stars} />
        </span>
        <span className="shrink-0 text-[13px] tabular-nums text-ink-48">
          {fmtEventDate(e.date)} · {e.timeKst}
        </span>
      </div>
      {e.interp && <p className="mt-0.5 text-[12px] leading-snug text-ink-48">{e.interp}</p>}
      <button
        onClick={load}
        disabled={pending}
        className="mt-1 text-[12px] font-medium text-guard disabled:opacity-50"
      >
        {pending ? "분석 중…" : insight ? "접기 ▲" : e.released ? "발표 결과 분석 보기 ▾" : "발표 전 전망 보기 ▾"}
      </button>
      {insight && (
        <div className="mt-1.5 rounded-[10px] border border-hairline bg-pearl p-3">
          {insight.actual && (
            <p className="mb-1 text-[13px] font-semibold">실제 발표값: <span className="tabular-nums">{insight.actual}</span> <span className="font-normal text-ink-48">(FRED)</span></p>
          )}
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-80">{insight.text}</p>
          <p className="mt-1.5 text-[11px] text-ink-48">AI 추정 분석이며 투자 권유가 아닙니다. 예상치(컨센서스)는 직접 확인이 필요합니다.</p>
        </div>
      )}
    </li>
  );
}

function EventGroup({ title, events, muted }: { title: string; events: EconEvent[]; muted?: boolean }) {
  if (events.length === 0) return null;
  return (
    <div className="mt-2">
      {title && <p className="text-[13px] font-semibold text-ink-48">{title}</p>}
      <ul className={`mt-1 divide-y divide-divider ${muted ? "opacity-70" : ""}`}>
        {events.map((e, i) => (
          <EventRow key={i} e={e} />
        ))}
      </ul>
    </div>
  );
}

function fmtUsd(v: number | null): string {
  if (v === null) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}
function pctOf(v: number | null, digits = 1): string {
  return v === null ? "—" : `${(v * 100).toFixed(digits)}%`;
}
const REC_KO: Record<string, string> = {
  strong_buy: "적극 매수", buy: "매수", hold: "중립", underperform: "비중축소", sell: "매도",
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[8px] border border-hairline bg-pearl px-2.5 py-1.5">
      <p className="text-[11px] text-ink-48">{label}</p>
      <p className="text-[14px] font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[10px] leading-tight text-ink-48">{hint}</p>}
    </div>
  );
}

function FundamentalsBlock({ f }: { f: EarningsFundamentals }) {
  const rec = f.recKey ? REC_KO[f.recKey] ?? f.recKey : null;
  const vs = f.vsTargetPct;
  return (
    <div className="mt-2 rounded-[10px] border border-hairline p-3">
      <p className="text-[12px] font-semibold text-ink-48">발표 전 컨센서스·펀더멘털</p>
      <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="예상 매출" value={fmtUsd(f.revenueEst)} hint="다음분기 컨센서스" />
        <Metric label="예상 EPS" value={f.epsEst != null ? f.epsEst.toFixed(2) : "—"} hint={f.epsLow != null && f.epsHigh != null ? `${f.epsLow.toFixed(1)}~${f.epsHigh.toFixed(1)}` : undefined} />
        <Metric label="추정 영업이익" value={fmtUsd(f.opIncomeEst)} hint={f.opMargin != null ? `영업이익률 ${pctOf(f.opMargin)}` : undefined} />
        <Metric label="ROE" value={pctOf(f.roe)} />
        <Metric label="PER 선행/후행" value={`${f.forwardPE != null ? f.forwardPE.toFixed(1) : "—"} / ${f.trailingPE != null ? f.trailingPE.toFixed(1) : "—"}`} />
        <Metric label="PBR / PEG" value={`${f.pbr != null ? f.pbr.toFixed(1) : "—"} / ${f.peg != null ? f.peg.toFixed(2) : "—"}`} />
        <Metric label="투자의견 컨센서스" value={rec ?? "—"} hint={f.recMean != null ? `${f.recMean.toFixed(2)}/5 · 애널 ${f.analysts ?? "—"}명` : undefined} />
        <Metric label="목표주가 대비" value={vs != null ? `${vs >= 0 ? "+" : ""}${vs.toFixed(0)}%` : "—"} hint={f.targetMean != null ? `목표 $${f.targetMean.toFixed(0)}` : undefined} />
      </div>
      {f.gov.overall != null && (
        <p className="mt-2 text-[12px] text-ink-48">
          거버넌스 리스크(1=양호 ~ 10=위험): 종합 <b className="text-ink">{f.gov.overall}</b>
          {f.gov.board != null ? ` · 이사회 ${f.gov.board}` : ""}
          {f.gov.audit != null ? ` · 감사 ${f.gov.audit}` : ""}
          {f.gov.comp != null ? ` · 보상 ${f.gov.comp}` : ""}
          {f.gov.shareholder != null ? ` · 주주권리 ${f.gov.shareholder}` : ""}
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-ink-48">
        출처: Yahoo Finance. ‘컨센서스 이상/이하’는 발표 후 실제값으로 확정됩니다 — 위는 발표 전 컨센서스·밸류에이션입니다.
        목표주가 상회(+)는 고평가, 하회(−)는 저평가 신호로 참고하세요. 투자 권유가 아닙니다.
      </p>
    </div>
  );
}

function KeyPointBlock({ kp }: { kp: EarningsKeyPoint }) {
  return (
    <div className="mt-2 rounded-[10px] border border-guard/40 bg-guard/5 p-3">
      <p className="text-[12px] font-semibold text-guard">★ 이번 실적 핵심 관전 포인트</p>
      <p className="mt-1 text-[15px] font-semibold text-ink">{kp.metric}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] text-ink-48">예상치:</span>
        <span className="text-[14px] font-medium text-ink">{kp.estimate ?? "—(공개 컨센서스 미확인)"}</span>
      </div>
      {kp.why && <p className="mt-1 text-[12px] leading-snug text-ink-48">{kp.why}</p>}
    </div>
  );
}

function EarningsRow({ e, f, kp }: { e: EarningsEvent; f?: EarningsFundamentals | null; kp?: EarningsKeyPoint }) {
  const [text, setText] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function load() {
    if (text) { setText(null); return; }
    start(async () => {
      const r = await getEarningsInsight({ name: e.name, symbol: e.symbol, dateKst: e.dateKst, epsForward: e.epsForward });
      setText(r.text);
    });
  }

  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-medium">{e.name}</span>
          <span className="shrink-0 text-[12px] text-ink-48">{e.symbol}</span>
        </span>
        <span className="shrink-0 text-[13px] tabular-nums text-ink-48">{e.dateKst} (한국시간)</span>
      </div>
      {kp && <KeyPointBlock kp={kp} />}
      {f && <FundamentalsBlock f={f} />}
      <button onClick={load} disabled={pending} className="mt-1.5 text-[12px] font-medium text-guard disabled:opacity-50">
        {pending ? "분석 중…" : text ? "접기 ▲" : "AI 실적 전망·매매 시사점 보기 ▾"}
      </button>
      {text && (
        <div className="mt-1.5 rounded-[10px] border border-hairline bg-pearl p-3">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-80">{text}</p>
          <p className="mt-1.5 text-[11px] text-ink-48">AI 추정 전망이며 투자 권유가 아닙니다. 실제 결과·가이던스는 발표 후 확인하세요.</p>
        </div>
      )}
    </li>
  );
}

function EarningsGroup({
  title, earnings, fundamentals, keyPoints,
}: { title: string; earnings: EarningsEvent[]; fundamentals: Record<string, EarningsFundamentals | null>; keyPoints: Record<string, EarningsKeyPoint> }) {
  if (earnings.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-[13px] font-semibold text-ink-48">{title}</p>
      <ul className="mt-1 divide-y divide-divider">
        {earnings.map((e) => (
          <EarningsRow key={e.symbol} e={e} f={fundamentals[e.symbol]} kp={keyPoints[e.symbol]} />
        ))}
      </ul>
    </div>
  );
}

type EventScenario = {
  eventName: string;
  date: string;
  timeKst: string;
  scenarios: { result: string; impact: string }[];
} | null;

export default function PrecloseClient({
  snapshot,
  preclose,
  econEvents,
  earnings,
  fundamentals,
  fredConfigured,
  marketSummary,
  eventScenario,
  eventConsensus = null,
  supplyFlows,
  keyPoints = {},
  liveRisk = null,
  krOpen = true,
}: {
  snapshot: BriefingSnapshot | null;
  preclose: AiPrecloseOutput | null;
  econEvents: EconEvent[];
  earnings: EarningsEvent[];
  fundamentals: Record<string, EarningsFundamentals | null>;
  fredConfigured: boolean;
  marketSummary: string;
  eventScenario: EventScenario;
  eventConsensus?: IndicatorConsensus | null;
  supplyFlows: StockFlow[];
  keyPoints?: Record<string, EarningsKeyPoint>;
  liveRisk?: number | null;
  krOpen?: boolean;
}) {
  const router = useRouter();
  const [booked, setBooked] = useState(false);
  const [isPending, startTransition] = useTransition();
  const ai = snapshot?.ai_output;
  // 현재 시점 라이브 리스크 우선(한국장 마감 시 오버나잇 신호 반영). 없으면 스냅샷 값.
  const riskScore = liveRisk ?? snapshot?.risk_score ?? 0;

  return (
    <PageShell title="마감 전 판단" width="default">
      {/* 결론 */}
      <div className="rounded-[18px] bg-tile-1 p-6 text-white sm:p-8">
        <p className="text-[13px] text-body-muted">
          기준 포지션 · 리스크 {riskScore}점 {krOpen ? "· 실시간" : "· 현재(오버나잇 선물 기준)"}
        </p>
        <h2 className="mt-2 text-[28px] font-semibold leading-tight">
          {riskScore >= 65
            ? "다음날 갭하락 위험: 높음"
            : riskScore >= 35
              ? "변동 가능성 있음: 주의 구간"
              : "상대적 안정 구간"}
        </h2>
        <p className="mt-2 text-[17px] text-body-muted">
          {riskScore >= 65 ? "권장 대응: 비중 축소 검토" : "권장 대응: 현황 유지 검토"}
        </p>
      </div>

      {/* 오늘 장 요약 — 시세 기반 (항상 표시) */}
      <Card className="mt-4">
        <SectionLabel>오늘 장 요약</SectionLabel>
        <p className="text-[15px] text-ink-80">{marketSummary}</p>
        {preclose?.todaySummary &&
          !preclose.todaySummary.includes("AI 분석을 사용할 수 없") &&
          !preclose.todaySummary.startsWith("나스닥") && (
            <p className="mt-2 text-[14px] text-ink-48">{preclose.todaySummary}</p>
          )}
      </Card>

      {/* 이번 달 주요 일정 — 지표(FRED)와 실적(Yahoo)을 분리해 표시 */}
      {econEvents.length > 0 || earnings.length > 0 ? (
        <Card className="mt-4">
          <SectionLabel>{new Date().getMonth() + 1}월 주요 일정 (실제 데이터)</SectionLabel>

          {/* ── 경제지표 ── */}
          <p className="mt-1 text-[14px] font-semibold">📊 경제지표 발표</p>
          <EventGroup title="앞으로 남은 일정 — 발표 전 전망" events={econEvents.filter((e) => !e.released)} />
          <EventGroup
            title="최근 발표 (5일 내) — 결과 분석"
            events={econEvents.filter((e) => e.released && daysSince(e.date) <= 5)}
            muted
          />

          {/* ── 실적 발표 ── */}
          <p className="mt-5 text-[14px] font-semibold">🏢 기업 실적 발표 (반도체·AI)</p>
          {earnings.length > 0 ? (
            <EarningsGroup title="예정" earnings={earnings} fundamentals={fundamentals} keyPoints={keyPoints} />
          ) : (
            <p className="mt-1 text-[13px] text-ink-48">향후 일정 내 예정된 주요 실적이 없습니다.</p>
          )}

          <p className="mt-3 text-[12px] leading-snug text-ink-48">
            지표 출처: FRED 공식 릴리즈 캘린더 + 연준 FOMC. 실적 출처: Yahoo Finance(반도체·AI 워치리스트, 마이크론 등).
            시각은 한국시간(서머타임 반영), ★는 주식시장 영향 중요도(★3 이상만 표시)입니다.
          </p>
        </Card>
      ) : preclose?.nightEvents && preclose.nightEvents.length > 0 ? (
        <Card className="mt-4">
          <SectionLabel>오늘 밤 주요 이벤트 · AI 예측</SectionLabel>
          <div className="space-y-3">
            {preclose.nightEvents.map((e, i) => (
              <div key={i}>
                <p className="text-[15px] font-semibold">{e.event}</p>
                <p className="text-[14px] text-ink-48">예상 시각: {e.expectedTime}</p>
              </div>
            ))}
          </div>
          {!fredConfigured && (
            <p className="mt-3 text-[12px] text-ink-48">
              FRED_API_KEY를 설정하면 실제 발표 일정·시각이 표시됩니다.
            </p>
          )}
        </Card>
      ) : null}

      {/* 결과별 시나리오 — 다가오는 실제 지표 기준 */}
      {eventScenario && (
        <Card className="mt-4">
          <SectionLabel>다가오는 지표 영향 시나리오</SectionLabel>
          <p className="text-[14px] text-ink-80">
            가장 임박한 주요 지표:{" "}
            <span className="font-semibold">{eventScenario.eventName}</span>{" "}
            <span className="text-ink-48">
              ({eventScenario.date} · {eventScenario.timeKst} 한국시간)
            </span>
          </p>
          {/* 시장 컨센서스·예측 종합 (뉴스 기반) */}
          {eventConsensus && (eventConsensus.core || eventConsensus.headline || eventConsensus.forecast) && (
            <div className="mt-2 rounded-[10px] border border-guard/40 bg-guard/5 p-3">
              <p className="text-[12px] font-semibold text-guard">시장 컨센서스·예측 종합</p>
              <div className="mt-1 space-y-0.5 text-[14px]">
                {eventConsensus.core && (
                  <p><span className="text-ink-48">근원(Core) 컨센서스: </span><b className="text-ink">{eventConsensus.core}</b></p>
                )}
                {eventConsensus.headline && (
                  <p><span className="text-ink-48">전체 컨센서스: </span><span className="text-ink-80">{eventConsensus.headline}</span></p>
                )}
                {eventConsensus.forecast && (
                  <p><span className="text-ink-48">예측 종합: </span><span className="text-ink-80">{eventConsensus.forecast}</span></p>
                )}
              </div>
              {eventConsensus.note && <p className="mt-1 text-[12px] leading-snug text-ink-48">{eventConsensus.note}</p>}
              <p className="mt-1 text-[11px] text-ink-48">뉴스 기반 추정치 — 발표 후 실제값으로 확정. 미확인 항목은 비워둡니다.</p>
            </div>
          )}
          <ul className="mt-2 divide-y divide-divider">
            {eventScenario.scenarios.map((s) => (
              <li key={s.result} className="flex gap-3 py-2.5">
                <span className="w-24 shrink-0 text-[15px] font-semibold">{s.result}</span>
                <span className="text-[15px] text-ink-80">{s.impact}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 수급 + 큰 장세 */}
      {ai && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Card>
            <SectionLabel>큰 장세 × 오늘 상황</SectionLabel>
            <p className="text-[15px] text-ink-80">{(ai.coreIssues ?? []).join(" · ")}</p>
            <p className="mt-2 text-[15px] font-semibold">{snapshot?.stage ?? ai.stage}</p>
          </Card>
          <Card>
            <SectionLabel>수급 (외국인·기관 순매매)</SectionLabel>
            {supplyFlows.length > 0 ? (
              <>
                <ul className="divide-y divide-divider">
                  {supplyFlows.map((f) => {
                    const fo = flowText(f.foreign);
                    const inst = flowText(f.institution);
                    return (
                      <li key={f.code} className="flex items-center justify-between gap-2 py-1.5 text-[14px]">
                        <span>{f.ticker}</span>
                        <span className="flex gap-2 tabular-nums">
                          <span className={fo.cls}>외 {fo.text}</span>
                          <span className={inst.cls}>기 {inst.text}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-[11px] text-ink-48">{supplyFlows[0]?.date} {supplyFlows[0]?.provisional ? "장중 잠정" : "확정"} · 출처: 네이버 금융</p>
              </>
            ) : (
              <p className="text-[15px] text-ink-80">{(ai.supplyNotes ?? []).join(" · ") || "보유 한국 종목 수급 데이터가 없습니다."}</p>
            )}
          </Card>
        </div>
      )}

      {/* 종목별 판단 */}
      {preclose?.perStockCalls && preclose.perStockCalls.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>종목별 판단</SectionLabel>
          {preclose.perStockCalls.map((p) => (
            <MetaRow key={p.ticker} label={p.ticker} value={p.call} />
          ))}
        </Card>
      )}

      {/* 원칙 위반 리스크 */}
      {ai?.donts && ai.donts.length > 0 && (
        <Card className="mt-4 !bg-parchment">
          <SectionLabel>원칙을 무시할 경우</SectionLabel>
          <p className="text-[15px] leading-snug">{ai.donts[0]}</p>
        </Card>
      )}

      <div className="mt-6">
        <Button
          variant="primary"
          size="lg"
          disabled={booked || isPending}
          onClick={() => {
            startTransition(async () => {
              await bookmarkNextBriefing();
              setBooked(true);
            });
          }}
        >
          <CalendarClock size={18} />
          {booked ? "내일 아침 다시 보기 예약됨" : isPending ? "예약 중…" : "내일 아침 다시 보기 예약"}
        </Button>
        {booked && (
          <p className="mt-3 text-[14px] text-ink-80">
            예약했습니다. 내일 아침 브리핑에서 오늘 판단과 함께 다시 보여드립니다.
          </p>
        )}
        <button
          onClick={() => router.push("/principles")}
          className="ml-1 mt-4 block text-[14px] text-guard"
        >
          원칙 다시 확인하기 →
        </button>
      </div>

      <Disclaimer />
    </PageShell>
  );
}
