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

// 문자용 요약: "외인(삼전) 07-21 +194만주·3일 +321만" (만주 단위, 최신 확정치 기준)
export function flowLine(flow: FlowDay[]): string {
  if (flow.length === 0) return "";
  const last = flow[flow.length - 1];
  const man = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v / 10000)}만`;
  const c3 = flow.slice(-3).reduce((s, f) => s + f.frgn, 0);
  return ` 외인(삼전) ${last.date.slice(5)} ${man(last.frgn)}주·3일 ${man(c3)}.`;
}

// 코스피 외인 수급 확정치 (네이버 투자자별 매매동향) — 현물 sosok=01(억원)·선물 03(계약).
// 실측(2026-07-22): 삼전과 당일 동시 상관 현물 0.40·선물 0.17 — "연동" 사실. 단 익일 예측력은
// 현물 없음·선물 3일 누적만 미약(53.3 vs 49.4%) → 게이트 아님, 표시·기록 전용.
export type KospiFlow = { date: string; cash: number; cash3: number; fut: number; fut3: number };

async function fetchTrendPage(sosok: string): Promise<{ date: string; frgn: number }[]> {
  const res = await fetch(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20991231&sosok=${sosok}&page=1`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://finance.naver.com/" },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  const out: { date: string; frgn: number }[] = [];
  const rowRe = /<td class="date2">(\d{2})\.(\d{2})\.(\d{2})<\/td>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const nums = [...m[4].matchAll(/<td class="rate_(?:up|down)3">([+\-]?[\d,]+)<\/td>/g)].map((x) => parseFloat(x[1].replace(/,/g, "")));
    if (nums.length < 2 || !isFinite(nums[1])) continue;
    out.push({ date: `20${m[1]}-${m[2]}-${m[3]}`, frgn: nums[1] }); // [0]=개인, [1]=외국인
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function fetchKospiFlow(): Promise<KospiFlow | null> {
  try {
    const [cash, fut] = await Promise.all([fetchTrendPage("01"), fetchTrendPage("03")]);
    if (cash.length === 0) return null;
    const last = cash[cash.length - 1];
    const sum3 = (a: { frgn: number }[]) => a.slice(-3).reduce((s, f) => s + f.frgn, 0);
    const lastFut = fut[fut.length - 1];
    return {
      date: last.date,
      cash: last.frgn,
      cash3: sum3(cash),
      fut: lastFut ? lastFut.frgn : 0,
      fut3: sum3(fut),
    };
  } catch {
    return null;
  }
}

// 문자용: " 코스피외인 07-21 +2,340억·3일 +5,120억/선물 -2,485·3일 +3,982계약."
export function kospiLine(k: KospiFlow | null | undefined): string {
  if (!k) return "";
  const s = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString()}`;
  return ` 코스피외인 ${k.date.slice(5)} ${s(k.cash)}억·3일 ${s(k.cash3)}억/선물 ${s(k.fut)}·3일 ${s(k.fut3)}계약.`;
}
