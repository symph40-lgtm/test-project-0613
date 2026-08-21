// 야간선물 전용 섹션 (발주 A 8/20 — /g1 상단) + 동시각 3판 비교표 (발주 B)
// 데이터: 당일 곡선 = t2.nf.bars(저녁 10분봉) + night.watch.cp(23:40·03:00) + night_fut(06:00 마감)
//        과거 일봉 = KRX 정본(fetchKrxNightDaily, 15분 캐시). 1시간×15일은 야간 크론 축적 개시 후 제공(정직 명기).
// 크론 등록 전까지 부분 곡선 — 결측 구간은 점 없이 표시.

import { fetchKrxNightDaily, type KrxNightDay } from "@/lib/market/krxNight";
import YahooFinance from "yahoo-finance2";

const yfd = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// [발주자 8/21 새벽] 20일 비교 그래프 재료 — 일간 등락률 (close/prevClose)
async function fetchDailyPct(sym: string, n = 40): Promise<{ date: string; pct: number }[]> {
  try {
    const r = await yfd.chart(sym, { period1: new Date(Date.now() - 75 * 86400e3), interval: "1d" });
    const qs = (r.quotes ?? []).filter((q) => q.close != null);
    const out: { date: string; pct: number }[] = [];
    for (let i = 1; i < qs.length; i++) {
      out.push({ date: (qs[i].date as Date).toISOString().slice(0, 10), pct: Math.round(((qs[i].close as number) / (qs[i - 1].close as number) - 1) * 10000) / 100 });
    }
    return out.slice(-n);
  } catch { return []; }
}

export type CompareRow = { date: string; nf: number | null; ss: number | null; hx: number | null; soxx: number | null; ndx: number | null };

type Bar = { t: string; pct: number; soxx?: number | null; nq?: number | null };   // soxx·nq: 8/20 밤 23시 발주 — 병기 계열
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
// [발주자 지적 8/20 밤 23시 + 8/21 새벽] T2+ v2 매시 재판정을 야간선물 곡선과 같은 화면에 —
// 시간당 1회 **예상갭 값**(÷β 지수축) ◆삼전(채움)·◇하닉(빈), 색 = 드리프트 방향 (관측 전용 — 채점 정본 19:35 불변)
export type V2HourMark = { t: string; dirSs: string | null; dirHx: string | null; nf_pct: number | null; expSsIdx?: number | null; expHxIdx?: number | null };
// [발주자 8/20 밤 23시 2차] T2+ v2 예상갭 마커 — base+drift 최종 예상갭(종목 %)을 ÷β로 지수축 환산, 판정 시각 위치에 ◇
export type V2Mark = { name: string; t: string; idxPct: number | null };

function CurveSvg({ c, betaSs, betaHx, t2Marks, v2Marks, v2Hourly }: { c: NightCurve; betaSs: number; betaHx: number; t2Marks?: T2Mark[]; v2Marks?: V2Mark[]; v2Hourly?: V2HourMark[] }) {
  const W = 720, H = 150, PL = 44, PR = 84, PT = 12, PB = 22;
  const pts: { m: number; v: number; kind: string }[] = [
    ...c.bars.map((b) => ({ m: minOf(b.t), v: b.pct, kind: "bar" })),
    ...(c.cp2340?.nf_pct != null ? [{ m: minOf(c.cp2340.t), v: c.cp2340.nf_pct, kind: "cp" }] : []),
    ...(c.cp0300?.nf_pct != null ? [{ m: minOf(c.cp0300.t), v: c.cp0300.nf_pct, kind: "cp" }] : []),
    ...(c.closePct != null ? [{ m: minOf(c.closeT ?? "06:00"), v: c.closePct, kind: "close" }] : []),
  ].sort((a, b) => a.m - b.m);
  const vs = [...pts.map((p) => p.v), ...c.bars.flatMap((b) => [b.soxx, b.nq]).filter((v): v is number => v != null)];
  const vmax = Math.max(0.5, ...vs.map(Math.abs)) * 1.15;
  const x = (m: number) => PL + ((m - X0) / (X1 - X0)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v + vmax) / (2 * vmax)) * (H - PT - PB);
  const cuts: [string, string][] = [["19:35", "T2"], ["06:00", "마감"], ["07:15", "R1"], ["08:52", "R2"]];
  const d = pts.length >= 2 ? "M" + pts.map((p) => `${x(p.m).toFixed(1)},${y(p.v).toFixed(1)}`).join(" L") : null;
  // [발주자 8/20 밤 23시] SOXX(미 정규장)·나스닥100 선물(NQ=F, 16:00 KST 이후 변화) 병기 계열
  const linePath = (get: (b: Bar) => number | null | undefined) => {
    const ps = c.bars.filter((b) => get(b) != null).map((b) => ({ m: minOf(b.t), v: get(b) as number }));
    return ps.length >= 2 ? "M" + ps.map((p) => `${x(p.m).toFixed(1)},${y(p.v).toFixed(1)}`).join(" L") : null;
  };
  const dSoxx = linePath((b) => b.soxx), dNq = linePath((b) => b.nq);
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
      {dNq ? <path d={dNq} fill="none" stroke="#14b8a6" strokeWidth={1.2} strokeLinejoin="round" /> : null}
      {dSoxx ? <path d={dSoxx} fill="none" stroke="#ea580c" strokeWidth={1.2} strokeLinejoin="round" /> : null}
      {d ? <path d={d} fill="none" stroke="#1d4ed8" strokeWidth={1.6} strokeLinejoin="round" /> : null}
      {(t2Marks ?? []).filter((mk) => mk.idxPct != null && Math.abs(mk.idxPct) <= vmax).map((mk) => (
        <g key={mk.name}>
          <path d={`M${x(minOf("19:35")).toFixed(1)},${(y(mk.idxPct!) - 4).toFixed(1)} l4,4 l-4,4 l-4,-4 z`} fill="#7c3aed" />
          <text x={x(minOf("19:35")) + 6} y={y(mk.idxPct!) + 3} fontSize={8} fill="#7c3aed">{mk.name}</text>
        </g>
      ))}
      {(v2Marks ?? []).filter((mk) => mk.idxPct != null && Math.abs(mk.idxPct) <= vmax).map((mk) => (
        <g key={"v2m" + mk.name}>
          <path d={`M${x(minOf(mk.t)).toFixed(1)},${(y(mk.idxPct!) - 4.5).toFixed(1)} l4.5,4.5 l-4.5,4.5 l-4.5,-4.5 z`} fill="none" stroke="#db2777" strokeWidth={1.6} />
          <text x={x(minOf(mk.t)) - 6} y={y(mk.idxPct!) + 3} textAnchor="end" fontSize={8} fill="#db2777">{mk.name}</text>
        </g>
      ))}
      {(v2Hourly ?? []).map((e) => {
        const cx = x(minOf(e.t));
        const col = (dir: string | null) => (dir === "상방" ? "#dc2626" : dir === "하방" ? "#2563eb" : "#9ca3af");
        const dia = (cy: number, r: number) => `M${cx.toFixed(1)},${(cy - r).toFixed(1)} l${r},${r} l-${r},${r} l-${r},-${r} z`;
        return (
          <g key={"v2h" + e.t}>
            {e.expSsIdx != null && Math.abs(e.expSsIdx) <= vmax ? <path d={dia(y(e.expSsIdx), 3.2)} fill={col(e.dirSs)} /> : null}
            {e.expHxIdx != null && Math.abs(e.expHxIdx) <= vmax ? <path d={dia(y(e.expHxIdx), 3.2)} fill="none" stroke={col(e.dirHx)} strokeWidth={1.4} /> : null}
          </g>
        );
      })}
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
  const refs = days.map((d) => d.day_close_ref).filter((v): v is number => v != null);
  const lo = Math.min(...days.map((d) => d.low), ...refs), hi = Math.max(...days.map((d) => d.high), ...refs);
  const y = (v: number) => PT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PT - PB);
  const bw = (W - PL - PR) / days.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="야간선물 일봉 1개월 (KRX 정본)">
      {days.map((d, i) => {
        const cx = PL + bw * i + bw / 2;
        const up = (d.u1_pct ?? 0) >= 0;
        const half = Math.max(3, bw * 0.44) / 2;
        return (
          <g key={d.label_date}>
            <line x1={cx} y1={y(d.high)} x2={cx} y2={y(d.low)} stroke={up ? "#dc2626" : "#2563eb"} strokeWidth={1} />
            <rect x={cx - Math.max(1.5, bw * 0.22)} y={Math.min(y(d.open), y(d.close))} width={Math.max(3, bw * 0.44)}
              height={Math.max(1, Math.abs(y(d.open) - y(d.close)))} fill={up ? "#dc2626" : "#2563eb"} opacity={0.85} />
            {/* [발주자 질문 8/21] u1 기준선 = 주간 종가 — 색(u1 부호)과 몸통(야간 시가→종가)이 어긋나 보이는 밤의 해석 눈금 */}
            {d.day_close_ref != null ? <line x1={cx - half - 3} y1={y(d.day_close_ref)} x2={cx + half + 3} y2={y(d.day_close_ref)} stroke="#111" strokeWidth={1.2} strokeDasharray="2 1.5" /> : null}
            {/* [발주자 8/20 밤] 날짜 전 봉 표기 — 4일 간격 → 매 봉 (라벨 = T+1 규약 그대로) */}
            <text x={cx} y={H - 6} textAnchor="middle" fontSize={6.5} fill="#888">{`${Number(d.label_date.slice(5, 7))}/${Number(d.label_date.slice(8, 10))}`}</text>
          </g>
        );
      })}
      <text x={PL - 4} y={y(hi) + 4} textAnchor="end" fontSize={9} fill="#888">{hi.toFixed(0)}</text>
      <text x={PL - 4} y={y(lo) + 4} textAnchor="end" fontSize={9} fill="#888">{lo.toFixed(0)}</text>
    </svg>
  );
}

// [발주자 8/21 새벽] 20일 비교 — 야간선물 마감(실선 기준) vs 당일 삼전·하닉 vs 간밤 SOXX·나스닥.
// 목적: 삼전·하닉이 밤 재료 대비 어느 정도로 움직이는지 (민감도) 육안 비교. 계열별 색 구별.
// [발주자 8/21 수정] SOXX·나스닥 = 삼전·하닉과 같은 날짜(라벨일 당일 밤 미 세션)로 정렬 + 장/단 점선 구별
const CMP_SERIES: { key: keyof CompareRow; label: string; color: string; w: number; dash?: string }[] = [
  { key: "nf", label: "야간선물 06:00 마감", color: "#1d4ed8", w: 2.4 },
  { key: "ss", label: "삼전 당일", color: "#dc2626", w: 1.6 },
  { key: "hx", label: "하닉 당일", color: "#7c3aed", w: 1.6 },
  { key: "soxx", label: "SOXX 당일 밤 (긴 점선)", color: "#ea580c", w: 1.3, dash: "7 3" },
  { key: "ndx", label: "나스닥 당일 밤 (짧은 점선)", color: "#14b8a6", w: 1.3, dash: "2 3" },
];
function DailyCompareSvg({ rows }: { rows: CompareRow[] }) {
  const W = 720, H = 180, PL = 40, PR = 10, PT = 12, PB = 22;
  if (rows.length < 2) return <p className="text-[13px] text-ink-48">비교 표본 부족 — 소스 조회 실패 또는 축적 대기</p>;
  const vals = rows.flatMap((r) => [r.nf, r.ss, r.hx, r.soxx, r.ndx]).filter((v): v is number => v != null);
  // [발주자 8/21] 축은 상위 92% 분위 기준 — 극단 대변동일(예: 7/31 삼전 +26.8%)은 가장자리에서 잘리더라도
  // 나머지 날들의 차이가 보이게 (전체 최댓값 축은 평상일을 뭉갬)
  const absSorted = vals.map(Math.abs).sort((a, b) => a - b);
  const q92 = absSorted.length ? absSorted[Math.min(absSorted.length - 1, Math.floor(absSorted.length * 0.92))] : 2;
  const vmax = Math.max(2, Math.round(q92 * 1.25 * 10) / 10);
  const x = (i: number) => PL + (i / (rows.length - 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v + vmax) / (2 * vmax)) * (H - PT - PB);
  const path = (get: (r: CompareRow) => number | null) => {
    const seg: string[] = [];
    let started = false;
    rows.forEach((r, i) => {
      const v = get(r);
      if (v == null) { started = false; return; }
      const vc = Math.max(-vmax, Math.min(vmax, v));   // 범위 밖은 가장자리에 클램프 (잘림 표시)
      seg.push(`${started ? "L" : "M"}${x(i).toFixed(1)},${y(vc).toFixed(1)}`);
      started = true;
    });
    return seg.join(" ");
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[480px]" role="img" aria-label="야간선물 대비 20일 민감도 비교">
      <line x1={PL} y1={y(0)} x2={W - PR} y2={y(0)} stroke="#ddd" strokeWidth={1} />
      {[vmax, -vmax].map((v) => <text key={v} x={PL - 4} y={y(v) + 4} textAnchor="end" fontSize={9} fill="#888">{v > 0 ? "+" : ""}{v.toFixed(1)}%</text>)}
      {CMP_SERIES.map((s) => <path key={s.key} d={path((r) => r[s.key] as number | null)} fill="none" stroke={s.color} strokeWidth={s.w} strokeDasharray={s.dash || undefined} strokeLinejoin="round" />)}
      {rows.map((r, i) => (
        <text key={r.date} x={x(i)} y={H - 6} textAnchor="middle" fontSize={6.5} fill="#888">{`${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}`}</text>
      ))}
    </svg>
  );
}

export async function NightFutSection({ curve, betaSs, betaHx, t2Marks, v2Marks, v2Hourly }: { curve: NightCurve; betaSs: number; betaHx: number; t2Marks?: T2Mark[]; v2Marks?: V2Mark[]; v2Hourly?: V2HourMark[] }) {
  let daily: KrxNightDay[] = [];
  try { daily = await fetchKrxNightDaily(24); } catch { /* 정본 조회 실패 — 빈 배열 */ }
  // [발주자 8/21 새벽] 20일 비교 데이터 — 정렬: 라벨일 L 기준. 야간선물 u1(L) = L 새벽에 끝난 밤 /
  // SOXX·나스닥 = 같은 밤의 미 세션(L 이전 마지막 미 거래일) / 삼전·하닉 = L 당일 등락 (정규 종가 기준 —
  // 프리·애프터 확장 등락은 NXT 이력 축적 후 교체 예정, 명기).
  let cmp: CompareRow[] = [];
  try {
    const [ssD, hxD, sxD, ixD] = await Promise.all([
      fetchDailyPct("005930.KS"), fetchDailyPct("000660.KS"), fetchDailyPct("SOXX"), fetchDailyPct("^IXIC"),
    ]);
    const at = (arr: { date: string; pct: number }[], d: string) => arr.find((z) => z.date === d)?.pct ?? null;
    const lastBefore = (arr: { date: string; pct: number }[], d: string) => [...arr].reverse().find((z) => z.date < d)?.pct ?? null;
    // 날짜 축: KRX 정본 우선, 조회 실패 시 삼전 거래일로 폴백 (야간선물 선만 결측 — 나머지 4계열은 유지)
    const spine = daily.length ? daily.slice(-20).map((z) => z.label_date) : ssD.slice(-20).map((z) => z.date);
    // [발주자 8/21 수정] SOXX·나스닥 = 라벨일과 같은 캘린더 날짜의 미 세션 (그날 밤 22:30 개장분) — 삼전·하닉과 동일 날짜 정렬
    void lastBefore;
    cmp = spine.map((d) => ({
      date: d, nf: daily.find((z) => z.label_date === d)?.u1_pct ?? null,
      ss: at(ssD, d), hx: at(hxD, d),
      soxx: at(sxD, d), ndx: at(ixD, d),
    }));
  } catch { /* 비교 결측 허용 */ }
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
        {v2Marks?.some((mk) => mk.idxPct != null) ? <span className="inline-flex items-center gap-1 whitespace-nowrap"><svg width={12} height={12} aria-hidden="true"><path d="M6,1.5 l4.5,4.5 l-4.5,4.5 l-4.5,-4.5 z" fill="none" stroke="#db2777" strokeWidth={1.6} /></svg><span style={{ color: "#db2777" }} className="font-medium">T2+ v2 예상갭 (판정 시각·÷β)</span></span> : null}
        {curve.bars.some((b) => b.soxx != null) ? <LegendChip color="#ea580c" label="SOXX (미 정규장 22:30~05:00)" /> : null}
        {curve.bars.some((b) => b.nq != null) ? <LegendChip color="#14b8a6" label="나스닥100 선물 NQ=F (16시 KST~)" /> : null}
        {v2Hourly?.length ? <span className="inline-flex items-center gap-1 whitespace-nowrap"><svg width={22} height={12} aria-hidden="true"><path d="M6,2.8 l3.2,3.2 l-3.2,3.2 l-3.2,-3.2 z" fill="#9ca3af" /><path d="M16,2.8 l3.2,3.2 l-3.2,3.2 l-3.2,-3.2 z" fill="none" stroke="#9ca3af" strokeWidth={1.4} /></svg><span className="font-medium text-ink-80">v2 매시 예상갭 ◆삼전·◇하닉 (÷β, 색=드리프트: 적 상방·청 하방·회 중립)</span></span> : null}
        <span>우측 축 = β환산(삼전·하닉)</span>
      </div>
      <div className="overflow-x-auto"><CurveSvg c={curve} betaSs={betaSs} betaHx={betaHx} t2Marks={t2Marks} v2Marks={v2Marks} v2Hourly={v2Hourly} /></div>
      {curve.live && !v2Hourly?.length ? <p className="mt-1 text-[13px] md:text-[10px] text-ink-48">T2 매시 재판정 마커는 기준점 섀도(shadow_v2)가 있는 밤부터 — 8/20 밤은 미생성(배포 경위), 첫 표시 8/21 밤. SOXX·나스닥100은 8/20 밤 23시 배포 이후 봉부터.</p> : null}
      <p className="mt-3 mb-1 text-[14px] md:text-[11px] font-semibold text-ink-48">
        과거 1개월 — 야간 세션 일봉 (KRX 정본, T+1 라벨 · 색 = u1 = 야간 종가 vs 그날 <b>주간 종가</b>: <span style={{ color: "#dc2626" }}>■ 상승</span> / <span style={{ color: "#2563eb" }}>■ 하락</span> · 몸통 = 야간 시가→종가 · <span style={{ color: "#111" }}>┄ 주간 종가(u1 기준선)</span>)
      </p>
      <p className="mb-1 text-[13px] md:text-[10px] text-ink-48">봉의 높이(지수 레벨)는 그날 주간장 등락을 그대로 안고 시작하므로, 전날 봉보다 높아도 u1이 음수(청)일 수 있습니다 — 색과 기준선으로 읽어 주세요.</p>
      <div className="overflow-x-auto"><DailySvg days={daily} /></div>
      <p className="mt-1 text-[13px] md:text-[10px] text-ink-48">
        1시간 해상도 15일 조회는 야간 크론 축적 개시 후 제공 (10분봉 저장 = 저녁 8/18~ · 밤 구간은 크론 등록부터). 8/12~14 라이브 기록은 KRX 정본 소급 정정본.
      </p>
      {/* [발주자 8/21 새벽] 20일 민감도 비교 — 삼전·하닉이 밤 재료(야간선물·SOXX·나스닥) 대비 얼마나 움직이나 */}
      <p className="mt-3 mb-1 text-[14px] md:text-[11px] font-semibold text-ink-48">20일 비교 — 야간선물 마감 vs 당일 삼전·하닉 vs 간밤 SOXX·나스닥 (일간 %)</p>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] md:text-[11px]">
        {CMP_SERIES.map((s) => <LegendChip key={s.key} color={s.color} bold={s.key === "nf"} dash={s.dash} label={s.label} />)}
      </div>
      <div className="overflow-x-auto"><DailyCompareSvg rows={cmp} /></div>
      <p className="mt-1 text-[13px] md:text-[10px] text-ink-48">
        정렬: 같은 날짜 — 야간선물 = 그 라벨일 새벽 마감 밤 / 삼전·하닉 = 라벨일 당일 등락 / SOXX·나스닥 = 라벨일 당일 밤(22:30 개장) 미 세션.
        축은 상위 92% 분위 기준 — 극단 대변동일은 가장자리에서 잘림. 삼전·하닉은 정규 종가 기준 (프리~애프터 확장은 NXT 이력 축적 후 교체 — 명기).
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
