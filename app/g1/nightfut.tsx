// 야간선물 전용 섹션 (발주 A 8/20 — /g1 상단) + 동시각 3판 비교표 (발주 B)
// 데이터: 당일 곡선 = t2.nf.bars(저녁 10분봉) + night.watch.cp(23:40·03:00) + night_fut(06:00 마감)
//        과거 일봉 = KRX 정본(fetchKrxNightDaily, 15분 캐시). 1시간×15일은 야간 크론 축적 개시 후 제공(정직 명기).
// 크론 등록 전까지 부분 곡선 — 결측 구간은 점 없이 표시.

import { fetchKrxNightDaily, type KrxNightDay } from "@/lib/market/krxNight";

type Bar = { t: string; pct: number };
type Cp = { t: string; nf_pct: number | null } | null;
export type NightCurve = {
  sessionNight: string; live: boolean;
  bars: Bar[]; cp2340: Cp; cp0300: Cp; closePct: number | null; closeT: string | null;
  coverage: string | null;
};

// 범례 색 견본 (발주자 지적 8/20 밤: "검정=·주황=" 텍스트만으로는 어떤 선인지 불명 — 실제 선 모양·색을 그대로 표시)
function LegendChip({ color, label, dash, dot, bold, textColor }: { color: string; label: string; dash?: string; dot?: boolean; bold?: boolean; textColor?: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <svg width={dot ? 12 : 26} height={10} aria-hidden="true">
        {dot ? <circle cx={6} cy={5} r={3.4} fill={color} /> : <line x1={1} y1={5} x2={25} y2={5} stroke={color} strokeWidth={bold ? 2.6 : 1.8} strokeDasharray={dash || undefined} />}
      </svg>
      <span style={{ color: textColor ?? color }} className="font-medium">{label}</span>
    </span>
  );
}

const X0 = 18 * 60, X1 = 33 * 60; // 18:00 → 익일 09:00 (분)
const minOf = (t: string) => { const [h, m] = t.split(":").map(Number); return (h < 12 ? h + 24 : h) * 60 + m; };

// [발주자 검수 8/20 밤 §1] T2 판정값 마커 — 저녁 번역(잔여갭식 시가 예상, 종목 %)을 ÷β로 지수축 환산해 19:35에 병기
export type T2Mark = { name: string; idxPct: number | null };

function CurveSvg({ c, betaSs, betaHx, t2Marks }: { c: NightCurve; betaSs: number; betaHx: number; t2Marks?: T2Mark[] }) {
  const W = 720, H = 150, PL = 44, PR = 84, PT = 12, PB = 22;
  const pts: { m: number; v: number; kind: string }[] = [
    ...c.bars.map((b) => ({ m: minOf(b.t), v: b.pct, kind: "bar" })),
    ...(c.cp2340?.nf_pct != null ? [{ m: minOf(c.cp2340.t), v: c.cp2340.nf_pct, kind: "cp" }] : []),
    ...(c.cp0300?.nf_pct != null ? [{ m: minOf(c.cp0300.t), v: c.cp0300.nf_pct, kind: "cp" }] : []),
    ...(c.closePct != null ? [{ m: minOf(c.closeT ?? "06:00"), v: c.closePct, kind: "close" }] : []),
  ].sort((a, b) => a.m - b.m);
  const vs = pts.map((p) => p.v);
  const vmax = Math.max(0.5, ...vs.map(Math.abs)) * 1.15;
  const x = (m: number) => PL + ((m - X0) / (X1 - X0)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v + vmax) / (2 * vmax)) * (H - PT - PB);
  const cuts: [string, string][] = [["19:35", "T2"], ["06:00", "마감"], ["07:15", "R1"], ["08:52", "R2"]];
  const d = pts.length >= 2 ? "M" + pts.map((p) => `${x(p.m).toFixed(1)},${y(p.v).toFixed(1)}`).join(" L") : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="야간선물 당일 곡선">
      <line x1={PL} y1={y(0)} x2={W - PR} y2={y(0)} stroke="#ddd" strokeWidth={1} />
      {cuts.map(([t, lb]) => (
        <g key={t}>
          <line x1={x(minOf(t))} y1={PT} x2={x(minOf(t))} y2={H - PB} stroke="#bbb" strokeDasharray="3 3" strokeWidth={1} />
          <text x={x(minOf(t))} y={H - 8} textAnchor="middle" fontSize={9} fill="#888">{lb} {t}</text>
        </g>
      ))}
      {[vmax, 0, -vmax].map((v) => (
        <g key={v}>
          <text x={PL - 4} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#888">{v > 0 ? "+" : ""}{v.toFixed(1)}%</text>
          <text x={W - PR + 4} y={y(v) + 3} textAnchor="start" fontSize={8} fill="#aaa">삼{(v * betaSs) > 0 ? "+" : ""}{(v * betaSs).toFixed(1)} 하{(v * betaHx) > 0 ? "+" : ""}{(v * betaHx).toFixed(1)}</text>
        </g>
      ))}
      {d ? <path d={d} fill="none" stroke="#1d4ed8" strokeWidth={1.6} strokeLinejoin="round" /> : null}
      {(t2Marks ?? []).filter((mk) => mk.idxPct != null && Math.abs(mk.idxPct) <= vmax).map((mk) => (
        <g key={mk.name}>
          <path d={`M${x(minOf("19:35")).toFixed(1)},${(y(mk.idxPct!) - 4).toFixed(1)} l4,4 l-4,4 l-4,-4 z`} fill="#7c3aed" />
          <text x={x(minOf("19:35")) + 6} y={y(mk.idxPct!) + 3} fontSize={8} fill="#7c3aed">{mk.name}</text>
        </g>
      ))}
      {pts.map((p, i) => (
        <circle key={i} cx={x(p.m)} cy={y(p.v)} r={p.kind === "bar" ? 1.8 : 3}
          fill={p.kind === "close" ? "#dc2626" : p.kind === "cp" ? "#059669" : "#1d4ed8"} />
      ))}
      {!pts.length ? <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={11} fill="#888">오늘 밤 데이터 대기 (18:05 첫 봉부터)</text> : null}
    </svg>
  );
}

function DailySvg({ days }: { days: KrxNightDay[] }) {
  const W = 720, H = 120, PL = 44, PR = 10, PT = 8, PB = 20;
  if (!days.length) return <p className="text-[13px] text-ink-48">KRX 정본 조회 불가 (KRX_ID 미설정 또는 응답 없음)</p>;
  const lo = Math.min(...days.map((d) => d.low)), hi = Math.max(...days.map((d) => d.high));
  const y = (v: number) => PT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PT - PB);
  const bw = (W - PL - PR) / days.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="야간선물 일봉 1개월 (KRX 정본)">
      {days.map((d, i) => {
        const cx = PL + bw * i + bw / 2;
        const up = (d.u1_pct ?? 0) >= 0;
        return (
          <g key={d.label_date}>
            <line x1={cx} y1={y(d.high)} x2={cx} y2={y(d.low)} stroke={up ? "#dc2626" : "#2563eb"} strokeWidth={1} />
            <rect x={cx - Math.max(1.5, bw * 0.22)} y={Math.min(y(d.open), y(d.close))} width={Math.max(3, bw * 0.44)}
              height={Math.max(1, Math.abs(y(d.open) - y(d.close)))} fill={up ? "#dc2626" : "#2563eb"} opacity={0.85} />
            {i % 4 === 0 ? <text x={cx} y={H - 6} textAnchor="middle" fontSize={8} fill="#888">{d.label_date.slice(5)}</text> : null}
          </g>
        );
      })}
      <text x={PL - 4} y={y(hi) + 4} textAnchor="end" fontSize={9} fill="#888">{hi.toFixed(0)}</text>
      <text x={PL - 4} y={y(lo) + 4} textAnchor="end" fontSize={9} fill="#888">{lo.toFixed(0)}</text>
    </svg>
  );
}

export async function NightFutSection({ curve, betaSs, betaHx, t2Marks }: { curve: NightCurve; betaSs: number; betaHx: number; t2Marks?: T2Mark[] }) {
  let daily: KrxNightDay[] = [];
  try { daily = await fetchKrxNightDaily(24); } catch { /* 정본 조회 실패 — 빈 배열 */ }
  const last = curve.bars.length ? curve.bars[curve.bars.length - 1] : null;
  return (
    <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p className="text-[18px] md:text-[15px] font-semibold">야간선물 (K200 선물 야간 세션)</p>
        <span className="rounded-full bg-pearl px-2 py-0.5 text-[14px] md:text-[11px] font-semibold text-ink-48">
          {curve.sessionNight.slice(5)}밤{curve.live ? " 진행중" : " (종료)"}
        </span>
        {curve.coverage === "partial" || curve.coverage === "none" ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[13px] md:text-[10px] text-amber-800">커버리지 {curve.coverage === "none" ? "공백(미 휴장)" : "부분(연휴)"}</span> : null}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] md:text-[11px] text-ink-48">
        <span>{last ? `최신 ${last.t} ${last.pct >= 0 ? "+" : ""}${last.pct.toFixed(2)}%` : "18:05 첫 봉 대기"}</span>
        <LegendChip color="#1d4ed8" dot label="10분봉(저녁)" />
        <LegendChip color="#059669" dot label="체크포인트 23:40/03:00" />
        <LegendChip color="#dc2626" dot label="06:00 마감" />
        {t2Marks?.some((mk) => mk.idxPct != null) ? <LegendChip color="#7c3aed" dot label="T2 판정값 19:35 (잔여갭식÷β)" /> : null}
        <span>우측 축 = β환산(삼전·하닉)</span>
      </div>
      <div className="overflow-x-auto"><CurveSvg c={curve} betaSs={betaSs} betaHx={betaHx} t2Marks={t2Marks} /></div>
      <p className="mt-3 mb-1 text-[14px] md:text-[11px] font-semibold text-ink-48">
        과거 1개월 — 야간 세션 일봉 (KRX 정본, T+1 라벨 · <span style={{ color: "#dc2626" }}>■ u1 상승</span> / <span style={{ color: "#2563eb" }}>■ 하락</span>)
      </p>
      <div className="overflow-x-auto"><DailySvg days={daily} /></div>
      <p className="mt-1 text-[13px] md:text-[10px] text-ink-48">
        1시간 해상도 15일 조회는 야간 크론 축적 개시 후 제공 (10분봉 저장 = 저녁 8/18~ · 밤 구간은 크론 등록부터). 8/12~14 라이브 기록은 KRX 정본 소급 정정본.
      </p>
    </div>
  );
}

// ── 발주 B 8/20 (보완 8/20 밤): 3판 비교 그래프 — T2 값과 야간선물값을 같은 그래프에 (라벨별 누적) ──
// 좌축 %: 실측(검정 굵게)·T2 잔여갭식 시가 예상(주황)·야간선물 19:35×β(파랑 점선)·야간선물 마감×β(파랑 실선)
// 우축 점수: T2 스코어(회색 점선 — % 아님, 방향 판단용 별도 축)
export type PanelPoint = { date: string; actual: number | null; resid: number | null; nf1935b: number | null; nfCloseB: number | null; score: number | null };
export function ThreePanelChart({ name, pts }: { name: string; pts: PanelPoint[] }) {
  const W = 720, H = 170, PL = 40, PR = 40, PT = 14, PB = 26;
  const data = pts.filter((p) => p.actual != null || p.resid != null || p.nf1935b != null || p.nfCloseB != null);
  if (data.length < 2) return <p className="text-[13px] text-ink-48">{name}: 표본 2 미만 — 누적 후 표시</p>;
  const vals = data.flatMap((p) => [p.actual, p.resid, p.nf1935b, p.nfCloseB]).filter((v): v is number => v != null);
  const vmax = Math.max(2, ...vals.map(Math.abs)) * 1.1;
  const smax = Math.max(2, ...data.map((p) => Math.abs(p.score ?? 0))) * 1.1;
  const x = (i: number) => PL + (i / (data.length - 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v + vmax) / (2 * vmax)) * (H - PT - PB);
  const ys = (v: number) => PT + (1 - (v + smax) / (2 * smax)) * (H - PT - PB);
  const path = (get: (p: PanelPoint) => number | null, yf: (v: number) => number) => {
    const seg: string[] = [];
    let started = false;
    data.forEach((p, i) => {
      const v = get(p);
      if (v == null) { started = false; return; }
      seg.push(`${started ? "L" : "M"}${x(i).toFixed(1)},${yf(v).toFixed(1)}`);
      started = true;
    });
    return seg.join(" ");
  };
  const series: [string, (p: PanelPoint) => number | null, string, string, ((v: number) => number)][] = [
    ["실측", (p) => p.actual, "#111", "", y],
    ["T2 잔여갭식", (p) => p.resid, "#ea580c", "", y],
    ["nf 19:35×β", (p) => p.nf1935b, "#2563eb", "4 3", y],
    ["nf 마감×β", (p) => p.nfCloseB, "#2563eb", "", y],
    ["스코어(우축)", (p) => p.score, "#9ca3af", "2 3", ys],
  ];
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label={`${name} 3판 비교 그래프`}>
        <line x1={PL} y1={y(0)} x2={W - PR} y2={y(0)} stroke="#ddd" strokeWidth={1} />
        {[vmax, -vmax].map((v) => <text key={v} x={PL - 4} y={y(v) + 4} textAnchor="end" fontSize={9} fill="#888">{v > 0 ? "+" : ""}{v.toFixed(1)}%</text>)}
        {[smax, -smax].map((v) => <text key={"s" + v} x={W - PR + 4} y={ys(v) + 4} textAnchor="start" fontSize={9} fill="#9ca3af">{v > 0 ? "+" : ""}{v.toFixed(1)}점</text>)}
        {series.map(([nm, get, color, dash, yf]) => <path key={nm} d={path(get, yf)} fill="none" stroke={color} strokeWidth={nm === "실측" ? 2.2 : 1.4} strokeDasharray={dash || undefined} strokeLinejoin="round" />)}
        {data.map((p, i) => (<g key={p.date}>
          {p.actual != null ? <circle cx={x(i)} cy={y(p.actual)} r={2.4} fill="#111" /> : null}
          {/* [발주자 검수 8/20 밤 §1] 룰 방향 마커 — |스코어|≥0.5 밤의 방향을 ▲▼로 (스코어 선 위, 우축) */}
          {p.score != null && Math.abs(p.score) >= 0.5 ? (
            p.score > 0
              ? <path d={`M${x(i).toFixed(1)},${(ys(p.score) - 4.5).toFixed(1)} l3.8,6.5 l-7.6,0 z`} fill="#dc2626" />
              : <path d={`M${x(i).toFixed(1)},${(ys(p.score) + 4.5).toFixed(1)} l3.8,-6.5 l-7.6,0 z`} fill="#2563eb" />
          ) : null}
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={8} fill="#888">{p.date.slice(5)}</text>
        </g>))}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] md:text-[11px]">
        <span className="font-semibold text-ink-48">{name}</span>
        <LegendChip color="#111" bold label="실측 갭" />
        <LegendChip color="#ea580c" label="T2 본판정 — 잔여갭식 시가 예상(NXT 경로)" />
        <LegendChip color="#2563eb" dash="4 3" label="야간선물 19:35×β" />
        <LegendChip color="#2563eb" label="야간선물 06:00 마감×β" />
        <LegendChip color="#9ca3af" textColor="#6b7280" dash="2 3" label="T2 스코어 (우축 점수 — % 아님)" />
        <span className="inline-flex items-center gap-1 whitespace-nowrap"><svg width={12} height={10} aria-hidden="true"><path d="M6,1 l3.8,6.5 l-7.6,0 z" fill="#dc2626" /></svg><span style={{ color: "#dc2626" }} className="font-medium">▲룰 상방</span></span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap"><svg width={12} height={10} aria-hidden="true"><path d="M6,9 l3.8,-6.5 l-7.6,0 z" fill="#2563eb" /></svg><span style={{ color: "#2563eb" }} className="font-medium">▼룰 하방 (|스코어|≥0.5, 스코어 선 위)</span></span>
      </div>
      <p className="text-[12px] md:text-[10px] text-ink-48">19:35×β는 8/18부터 정본 절단 — 이전 구간은 18:05 정정 근사.</p>
    </div>
  );
}
