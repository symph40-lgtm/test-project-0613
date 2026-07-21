// 외인·기관 수급 (네이버 종목별 일별 매매동향, 확정치) — 표시·기록 전용.
// ⚠ 자동 게이트 아님: 10.5년 실측(scripts/daily-swing-flow.ts)에서 현물·선물 게이트 전부
//   2종목×2구간 일관 개선 실패 (수익 훼손 큼, MDD만 개선 — 스펙 6장). 재론 시 새 데이터 필요.

export type FlowDay = { date: string; frgn: number; inst: number }; // 순매매량(주)

export async function fetchRecentFlow(code: string): Promise<FlowDay[]> {
  try {
    const res = await fetch(`https://finance.naver.com/item/frgn.naver?code=${code}&page=1`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    const out: FlowDay[] = [];
    const rowRe = /<tr onMouseOver[\s\S]*?<\/tr>/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html)) !== null) {
      const row = m[0];
      const d = row.match(/(\d{4})\.(\d{2})\.(\d{2})/);
      const instM = row.match(/width="66"[^>]*>[\s\S]*?([+\-][\d,]+)/);
      const frgnM = row.match(/width="80"[^>]*>[\s\S]*?([+\-][\d,]+)/);
      if (!d || !instM || !frgnM) continue;
      out.push({
        date: `${d[1]}-${d[2]}-${d[3]}`,
        inst: parseFloat(instM[1].replace(/,/g, "")),
        frgn: parseFloat(frgnM[1].replace(/,/g, "")),
      });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1)); // 오래된 → 최신
  } catch {
    return [];
  }
}

// 문자용 요약: "외인 전일 +194만·3일 +321만" (만주 단위, 최신 확정치 기준)
export function flowLine(flow: FlowDay[]): string {
  if (flow.length === 0) return "";
  const last = flow[flow.length - 1];
  const man = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v / 10000)}만`;
  const c3 = flow.slice(-3).reduce((s, f) => s + f.frgn, 0);
  return ` 외인 ${last.date.slice(5)} ${man(last.frgn)}·3일 ${man(c3)}`;
}
