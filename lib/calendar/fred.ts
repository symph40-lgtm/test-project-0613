// 미국 경제지표 발표 일정 (FRED Releases Calendar)
// FRED_API_KEY 필요 (https://fred.stlouisfed.org/docs/api/api_key.html — 무료)
// 당일 포함 향후 N일 내 주요 지표 발표 일정을 한국시간으로 반환

export type EconEvent = {
  name: string;        // 한국어 지표명
  date: string;        // YYYY-MM-DD (미국 발표일)
  timeKst: string;     // 한국시간 표시 (예: "21:30")
  importance: "high" | "medium";
};

// 주요 릴리즈 매칭 규칙: FRED release_name(영문) 부분일치 → 한국어명 + 미 동부 발표시각
const MAJOR_RELEASES: {
  match: string;
  nameKo: string;
  etHour: number;
  etMin: number;
  importance: "high" | "medium";
}[] = [
  { match: "consumer price index", nameKo: "미국 소비자물가지수(CPI)", etHour: 8, etMin: 30, importance: "high" },
  { match: "producer price index", nameKo: "미국 생산자물가지수(PPI)", etHour: 8, etMin: 30, importance: "high" },
  { match: "employment situation", nameKo: "미국 고용보고서(비농업 고용)", etHour: 8, etMin: 30, importance: "high" },
  { match: "gross domestic product", nameKo: "미국 GDP", etHour: 8, etMin: 30, importance: "high" },
  { match: "personal income", nameKo: "미국 개인소비지출(PCE)", etHour: 8, etMin: 30, importance: "high" },
  { match: "retail", nameKo: "미국 소매판매", etHour: 8, etMin: 30, importance: "medium" },
  { match: "durable goods", nameKo: "미국 내구재 주문", etHour: 8, etMin: 30, importance: "medium" },
  { match: "new residential construction", nameKo: "미국 주택착공", etHour: 8, etMin: 30, importance: "medium" },
  { match: "job openings", nameKo: "미국 구인·이직보고서(JOLTS)", etHour: 10, etMin: 0, importance: "medium" },
  { match: "industrial production", nameKo: "미국 산업생산", etHour: 9, etMin: 15, importance: "medium" },
];

// 미국 동부 서머타임 여부 (3월 둘째 일요일 ~ 11월 첫째 일요일)
function isUsEasternDst(d: Date): boolean {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  if (month < 2 || month > 10) return false;
  if (month > 2 && month < 10) return true;

  // 3월: 둘째 일요일 이후 DST
  if (month === 2) {
    const secondSunday = nthSundayUtc(year, 2, 2);
    return d.getUTCDate() >= secondSunday;
  }
  // 11월: 첫째 일요일 전까지 DST
  const firstSunday = nthSundayUtc(year, 10, 1);
  return d.getUTCDate() < firstSunday;
}

function nthSundayUtc(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay(); // 0=일
  const firstSundayDate = 1 + ((7 - firstDow) % 7);
  return firstSundayDate + (n - 1) * 7;
}

// 미 동부 시각 → 한국시간 문자열 (KST = UTC+9)
function etToKst(dateStr: string, etHour: number, etMin: number): string {
  const base = new Date(`${dateStr}T00:00:00Z`);
  const etOffset = isUsEasternDst(base) ? -4 : -5; // EDT/EST
  // UTC 시 = ET시 - etOffset(음수) → ET + (-offset). KST = UTC + 9
  const utcHour = etHour - etOffset;
  let kstHour = (utcHour + 9) % 24;
  if (kstHour < 0) kstHour += 24;
  const hh = String(kstHour).padStart(2, "0");
  const mm = String(etMin).padStart(2, "0");
  // 다음날로 넘어가는 경우 표시
  const nextDay = utcHour + 9 >= 24;
  return `${nextDay ? "익일 " : ""}${hh}:${mm}`;
}

export function hasFredKey(): boolean {
  return Boolean(process.env.FRED_API_KEY);
}

// FOMC 정례회의 결과 발표일 (둘째 날, 미 동부 14:00 발표)
// 미 연준이 사전 공표한 2026년 일정. FRED 릴리즈에는 없어 별도 관리.
const FOMC_ANNOUNCEMENTS_2026 = [
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
];

function fomcEventsInRange(start: string, end: string): EconEvent[] {
  return FOMC_ANNOUNCEMENTS_2026.filter((d) => d >= start && d <= end).map((date) => ({
    name: "미국 FOMC 통화정책 결정",
    date,
    timeKst: etToKst(date, 14, 0), // 14:00 ET → 익일 새벽 KST
    importance: "high" as const,
  }));
}

// 당일 포함 향후 days일 내 주요 미국 경제지표 일정
export async function fetchUpcomingUsEvents(days = 5): Promise<EconEvent[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];

  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const endDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  const end = endDate.toISOString().slice(0, 10);

  const url =
    `https://api.stlouisfed.org/fred/releases/dates` +
    `?api_key=${apiKey}&file_type=json&include_release_dates_with_no_data=true` +
    `&realtime_start=${start}&realtime_end=${end}&sort_order=asc&limit=1000`;

  try {
    const res = await fetch(url, { next: { revalidate: 6 * 3600 } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      release_dates?: { release_name: string; date: string }[];
    };

    const events: EconEvent[] = [];
    const seen = new Set<string>();

    for (const rd of data.release_dates ?? []) {
      if (rd.date < start || rd.date > end) continue;
      const lower = rd.release_name.toLowerCase();
      const rule = MAJOR_RELEASES.find((r) => lower.includes(r.match));
      if (!rule) continue;

      const key = `${rule.nameKo}|${rd.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      events.push({
        name: rule.nameKo,
        date: rd.date,
        timeKst: etToKst(rd.date, rule.etHour, rule.etMin),
        importance: rule.importance,
      });
    }

    // FOMC 일정 병합
    for (const f of fomcEventsInRange(start, end)) {
      const key = `${f.name}|${f.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        events.push(f);
      }
    }

    // 날짜 → 중요도 순 정렬
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.importance !== b.importance) return a.importance === "high" ? -1 : 1;
      return 0;
    });

    return events.slice(0, 8);
  } catch {
    // FRED 실패해도 FOMC는 표시
    return fomcEventsInRange(start, end);
  }
}
