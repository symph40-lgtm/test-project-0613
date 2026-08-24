// 상단 판정 요약표 2종 (발주자 발주 2026-08-24) — 저녁판(3행)·아침판(5행) + 실측 행 자동 부착.
// 규격: 셀 = 방향 글리프(▲▼●) + 애프터比 % + 환산 예상 주가(원), 종가比는 소자 병기 (■3-1).
// 절단 시각 각 행 명기 (■3-2) · 셀 탭 → 해당 카드 앵커 스크롤 (■3-3) · 모바일 3열 그리드 —
// 가로 스크롤 금지 (■3-4, 8/19 오버플로 교훈) · 날짜 이동 ◀ ▶ (■3-5).
// 상세(성분·근거·행동 지시)는 기존 카드 유지 — 이 표는 항행용.

export type SumCell = {
  afterPct: number | null;   // 애프터比 % (표기 우선)
  closePct: number | null;   // 종가比 % (소자 병기·오차 계산의 자)
  px: number | null;         // 환산 예상 주가(원)
} | null;

// anchors: 종목별 상세 카드 앵커 (탭한 종목의 카드로 이동, ■3-3) — 빈 문자열이면 링크 없음(과거 조회 뷰)
export type SumRow = { label: string; cut: string; anchors: [string, string]; cells: [SumCell, SumCell] };

export type SumActual = {
  // 실측 행 (■2-3·■2-5): 시가·갭 (애프터比/종가比)
  cells: [{ open: number | null; gapAfter: number | null; gapClose: number | null } | null,
          { open: number | null; gapAfter: number | null; gapClose: number | null } | null];
};

export type SumTable = {
  title: string;             // "저녁판 종합 (8/24 19:45)"
  nfLine: string;            // 동시각 야간선물 + β환산 (■1-4·■2-2)
  baseLine: string;          // 현재가(19:40 NXT) / 전일 종가·기준가 줄 (■1-5·■2-2)
  rows: SumRow[];
  actual: SumActual | null;
  emptyNote?: string | null; // 행 전부 결측일 때 사유 (아침판 발행 전 등)
};

const f2 = (v: number | null | undefined, sign = true) =>
  v == null ? "—" : `${sign && v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

// 방향 글리프 — 기존 색 규약(갭상승 적·갭하락 청·무방향 회), 보합 밴드 ±0.3%p (라벨 분류와 동일)
function Glyph({ v }: { v: number | null }) {
  if (v == null) return <span className="text-ink-48">—</span>;
  if (v >= 0.3) return <span className="text-red-600">▲</span>;
  if (v <= -0.3) return <span className="text-blue-600">▼</span>;
  return <span className="text-ink-48">●</span>;
}

function CellBox({ c, bold, err, anchor }: { c: SumCell; bold: boolean; err: number | null; anchor: string }) {
  if (!c || (c.afterPct == null && c.closePct == null)) return <div className="px-1.5 py-1 text-[14px] md:text-[12px] text-ink-48">—</div>;
  const inner = (
    <div className={`px-1.5 py-1 leading-tight ${bold ? "rounded-[8px] bg-emerald-50" : ""}`}>
      <p className={`text-[15px] md:text-[13px] ${bold ? "font-bold" : "font-medium"} text-ink-80`}>
        <Glyph v={c.afterPct ?? c.closePct} /> {f2(c.afterPct)}{c.px != null ? <span className="whitespace-nowrap"> ({c.px.toLocaleString()}원)</span> : null}
      </p>
      <p className="text-[12px] md:text-[10px] text-ink-48">종가比 {f2(c.closePct)}{err != null ? <span className={bold ? "font-semibold text-emerald-700" : ""}> · 오차 {err.toFixed(2)}p</span> : null}</p>
    </div>
  );
  if (!anchor) return inner;
  return <a href={`#${anchor}`} className="block no-underline">{inner}</a>;
}

function Table({ t }: { t: SumTable }) {
  const hasAny = t.rows.some((r) => r.cells.some((c) => c && (c.afterPct != null || c.closePct != null)));
  // 오차(종가比 자) — 실측 있으면 셀별 병기, 종목별 최소 오차 셀 굵게 (■2-4: 요약표 = 채점표)
  const errOf = (c: SumCell, i: 0 | 1): number | null => {
    const act = t.actual?.cells[i]?.gapClose ?? null;
    return c?.closePct != null && act != null ? Math.round(Math.abs(c.closePct - act) * 100) / 100 : null;
  };
  const minErr: [number | null, number | null] = [0, 1].map((i) => {
    const es = t.rows.map((r) => errOf(r.cells[i as 0 | 1], i as 0 | 1)).filter((e): e is number => e != null);
    return es.length ? Math.min(...es) : null;
  }) as [number | null, number | null];
  return (
    <div className="mb-2 rounded-[14px] border border-hairline bg-canvas p-3">
      <p className="text-[15px] md:text-[13px] font-semibold text-ink-80">{t.title}</p>
      <p className="text-[13px] md:text-[11px] text-ink-48">{t.nfLine}</p>
      <p className="mb-1.5 text-[13px] md:text-[11px] text-ink-48">{t.baseLine}</p>
      {hasAny ? (
        <div className="grid grid-cols-[minmax(64px,auto)_1fr_1fr] items-stretch border-t border-hairline/60">
          <div className="px-1.5 py-1 text-[13px] md:text-[11px] font-semibold text-ink-48">판정</div>
          <div className="px-1.5 py-1 text-[13px] md:text-[11px] font-semibold text-ink-48">삼전 (시가 예상)</div>
          <div className="px-1.5 py-1 text-[13px] md:text-[11px] font-semibold text-ink-48">하닉 (시가 예상)</div>
          {t.rows.map((r) => (
            <div key={r.label} className="contents">
              <div className="border-t border-hairline/40 px-1.5 py-1 text-[13px] md:text-[11px] text-ink-80">
                {r.label}<br /><span className="text-[11px] md:text-[9px] text-ink-48">{r.cut}</span>
              </div>
              {([0, 1] as const).map((i) => {
                const e = errOf(r.cells[i], i);
                return (
                  <div key={i} className="border-t border-hairline/40">
                    <CellBox c={r.cells[i]} bold={e != null && minErr[i] != null && e === minErr[i]} err={e} anchor={r.anchors[i]} />
                  </div>
                );
              })}
            </div>
          ))}
          {t.actual ? (
            <div className="contents">
              <div className="border-t-2 border-hairline px-1.5 py-1 text-[13px] md:text-[11px] font-semibold text-ink-80">실측<br /><span className="text-[11px] md:text-[9px] font-normal text-ink-48">09:00 시가</span></div>
              {([0, 1] as const).map((i) => {
                const a = t.actual!.cells[i];
                return (
                  <div key={i} className="border-t-2 border-hairline px-1.5 py-1 leading-tight">
                    {a ? (<>
                      <p className="text-[15px] md:text-[13px] font-semibold text-ink-80"><Glyph v={a.gapAfter ?? a.gapClose} /> {f2(a.gapAfter)}{a.open != null ? <span className="whitespace-nowrap"> ({a.open.toLocaleString()}원)</span> : null}</p>
                      <p className="text-[12px] md:text-[10px] text-ink-48">종가比 {f2(a.gapClose)}</p>
                    </>) : <p className="text-[14px] md:text-[12px] text-ink-48">—</p>}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-[8px] bg-pearl/60 px-2 py-1.5 text-[13px] md:text-[11px] text-ink-48">{t.emptyNote ?? "발행 전"}</p>
      )}
    </div>
  );
}

export function SummaryTables({ evening, morning, nav }: {
  evening: SumTable | null; morning: SumTable | null;
  nav: { night: string; prevHref: string; nextHref: string | null };
}) {
  const mdOf = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return (
    <div className="mb-4">
      {/* ■3-5 날짜 이동 — 지난 밤들의 판정 대결 이력을 같은 형식으로 */}
      <div className="mb-1.5 flex items-center justify-between text-[14px] md:text-[12px]">
        <a href={nav.prevHref} className="rounded-[8px] bg-pearl px-2 py-0.5 font-semibold text-ink-80 no-underline">◀ 전 밤</a>
        <span className="font-semibold text-ink-48">판정 요약 — {mdOf(nav.night)}밤 (셀 탭 = 상세 카드 이동)</span>
        {nav.nextHref ? <a href={nav.nextHref} className="rounded-[8px] bg-pearl px-2 py-0.5 font-semibold text-ink-80 no-underline">다음 밤 ▶</a> : <span className="px-2 text-ink-48">최신</span>}
      </div>
      {evening ? <Table t={evening} /> : null}
      {morning ? <Table t={morning} /> : null}
      <p className="text-[12px] md:text-[10px] text-ink-48">표기: 애프터比(T2 19:40 기준가) 우선 · 종가比 소자 병기 — 오차·굵게(최근접)는 종가比 자. 아침판 = T2 계열 재실행(07:00) · R1/v1.1c = 번역 엔진 공식 발행(07:15) — 별개 엔진.</p>
    </div>
  );
}
