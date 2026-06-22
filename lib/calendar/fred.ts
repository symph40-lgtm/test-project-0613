// 미국 경제지표 발표 일정 (FRED Releases Calendar)
// FRED_API_KEY 필요 (https://fred.stlouisfed.org/docs/api/api_key.html — 무료)
// 당일 포함 향후 N일 내 주요 지표 발표 일정을 한국시간으로 반환

// 발표값 단위: mom%(전월대비%) · qoq%(전기대비 연율%) · abs_k(천 단위 증감) · level(수준값)
export type FredUnit = "mom%" | "qoq%" | "abs_k" | "level";

export type EconEvent = {
  name: string;        // 한국어 지표명
  date: string;        // YYYY-MM-DD (미국 발표일)
  timeKst: string;     // 한국시간 표시 (예: "21:30")
  importance: "high" | "medium";
  stars: number;       // 1~5 중요도
  interp: string;      // 주식시장 해석
  released: boolean;   // 이미 발표됨(과거) 여부
  fredSeries?: string; // 발표 후 실제값 조회용 FRED series_id
  unit?: FredUnit;     // 실제값 해석 단위
};

// 주요 릴리즈 매칭 규칙: FRED release_name(영문) 부분일치 → 한국어명/별점/해석/미 동부 발표시각
// not: 해당 문자열 포함 시 오매칭 제외(예: GDP는 "Debt to Gross Domestic Product Ratios" 제외)
// fredSeries/unit: 발표 후 실제값 분석에 사용
const MAJOR_RELEASES: {
  match: string;
  not?: string;
  nameKo: string;
  etHour: number;
  etMin: number;
  stars: number;
  interp: string;
  fredSeries?: string;
  unit?: FredUnit;
}[] = [
  { match: "employment situation", nameKo: "고용보고서(비농업 고용)", etHour: 8, etMin: 30, stars: 5, interp: "금리·달러·나스닥 방향에 가장 중요", fredSeries: "PAYEMS", unit: "abs_k" },
  { match: "consumer price index", nameKo: "소비자물가(CPI)", etHour: 8, etMin: 30, stars: 5, interp: "인플레 재가속 여부 판단", fredSeries: "CPIAUCSL", unit: "mom%" },
  { match: "producer price index", nameKo: "생산자물가(PPI)", etHour: 8, etMin: 30, stars: 4, interp: "기업 원가·향후 CPI/PCE 선행", fredSeries: "PPIFIS", unit: "mom%" },
  { match: "personal income and outlays", nameKo: "개인소득·지출·PCE 물가", etHour: 8, etMin: 30, stars: 5, interp: "연준이 보는 핵심 물가 — 가장 중요", fredSeries: "PCEPI", unit: "mom%" },
  { match: "advance monthly sales for retail", nameKo: "소매판매", etHour: 8, etMin: 30, stars: 5, interp: "소비 강도 확인", fredSeries: "RSAFS", unit: "mom%" },
  { match: "gross domestic product", not: "debt to", nameKo: "GDP", etHour: 8, etMin: 30, stars: 4, interp: "경기 강도 확인", fredSeries: "GDPC1", unit: "qoq%" },
  { match: "shipments, inventories", nameKo: "내구재 주문(제조업 수주)", etHour: 8, etMin: 30, stars: 4, interp: "제조업·설비투자·반도체 장비 심리", fredSeries: "DGORDER", unit: "mom%" },
  { match: "job openings", nameKo: "구인·이직(JOLTS)", etHour: 10, etMin: 0, stars: 4, interp: "노동시장 과열/냉각 판단", fredSeries: "JTSJOL", unit: "level" },
  { match: "unemployment insurance weekly claims report", not: "state", nameKo: "신규 실업수당청구", etHour: 8, etMin: 30, stars: 4, interp: "고용 냉각이면 금리 하락·성장주 우호", fredSeries: "ICSA", unit: "level" },
  { match: "import and export price", nameKo: "수입·수출물가", etHour: 8, etMin: 30, stars: 3, interp: "관세·유가·달러 영향 확인", fredSeries: "IR", unit: "mom%" },
  { match: "industrial production and capacity", nameKo: "산업생산", etHour: 9, etMin: 15, stars: 3, interp: "제조업 생산 동향", fredSeries: "INDPRO", unit: "mom%" },
  { match: "new residential construction", nameKo: "주택착공", etHour: 8, etMin: 30, stars: 3, interp: "금리 민감·건설", fredSeries: "HOUST", unit: "level" },
  { match: "new residential sales", nameKo: "신규주택판매", etHour: 10, etMin: 0, stars: 3, interp: "금리 민감 업종·건설·소비재", fredSeries: "HSN1F", unit: "level" },
  { match: "surveys of consumers", nameKo: "미시간대 소비자심리", etHour: 10, etMin: 0, stars: 3, interp: "기대인플레·소비심리 확인", fredSeries: "UMCSENT", unit: "level" },
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

// 오늘 이후 가장 가까운 FOMC 발표일 (YYYY-MM-DD)
export function nextFomcDate(): string | null {
  const today = ymdUtc(new Date());
  return FOMC_ANNOUNCEMENTS_2026.find((d) => d >= today) ?? null;
}
function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fomcEventsInRange(start: string, end: string, today: string): EconEvent[] {
  return FOMC_ANNOUNCEMENTS_2026.filter((d) => d >= start && d <= end).map((date) => ({
    name: "FOMC 통화정책 결정 / 점도표",
    date,
    timeKst: etToKst(date, 14, 0), // 14:00 ET → 익일 새벽 KST
    importance: "high" as const,
    stars: 5,
    interp: "금리 결정·점도표 — 시장 전체 방향",
    released: date < today,
  }));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// start~end 범위의 주요 미국 경제지표 일정 (실데이터 FRED + FOMC)
async function fetchEventsInRange(start: string, end: string, minStars: number): Promise<EconEvent[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];
  const today = ymd(new Date());

  const url =
    `https://api.stlouisfed.org/fred/releases/dates` +
    `?api_key=${apiKey}&file_type=json&include_release_dates_with_no_data=true` +
    `&realtime_start=${start}&realtime_end=${end}&sort_order=asc&limit=1000`;

  try {
    const res = await fetch(url, { next: { revalidate: 6 * 3600 } });
    if (!res.ok) return fomcEventsInRange(start, end, today);
    const data = (await res.json()) as {
      release_dates?: { release_name: string; date: string }[];
    };

    const events: EconEvent[] = [];
    const seen = new Set<string>();

    for (const rd of data.release_dates ?? []) {
      if (rd.date < start || rd.date > end) continue;
      const lower = rd.release_name.toLowerCase();
      const rule = MAJOR_RELEASES.find(
        (r) => lower.includes(r.match) && (!r.not || !lower.includes(r.not)),
      );
      if (!rule || rule.stars < minStars) continue;

      const key = `${rule.nameKo}|${rd.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      events.push({
        name: rule.nameKo,
        date: rd.date,
        timeKst: etToKst(rd.date, rule.etHour, rule.etMin),
        importance: rule.stars >= 4 ? "high" : "medium",
        stars: rule.stars,
        interp: rule.interp,
        released: rd.date < today,
        fredSeries: rule.fredSeries,
        unit: rule.unit,
      });
    }

    // FOMC 병합
    for (const f of fomcEventsInRange(start, end, today)) {
      const key = `${f.name}|${f.date}`;
      if (!seen.has(key)) { seen.add(key); events.push(f); }
    }

    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return b.stars - a.stars;
    });
    return events;
  } catch {
    return fomcEventsInRange(start, end, today);
  }
}

// 당일 포함 향후 days일 내 주요 지표 (★3 이상)
export async function fetchUpcomingUsEvents(days = 5): Promise<EconEvent[]> {
  const today = new Date();
  const start = ymd(today);
  const end = ymd(new Date(today.getTime() + days * 24 * 3600 * 1000));
  return (await fetchEventsInRange(start, end, 3)).slice(0, 8);
}

// 이번 달 전체 주요 지표 (★3 이상) — 발표됨/예정 구분 포함
export async function fetchMonthlyUsEvents(): Promise<EconEvent[]> {
  const now = new Date();
  const start = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const end = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  return fetchEventsInRange(start, end, 3);
}

// 발표 후 실제값 조회 — 해당 FRED 시리즈의 최근값 + 전월(전기) 대비를 사람이 읽을 문자열로
export type ReleaseActual = { latest: string; change: string; raw: number | null };

export async function fetchReleaseActual(series: string, unit: FredUnit): Promise<ReleaseActual | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  try {
    const url =
      `https://api.stlouisfed.org/fred/series/observations?series_id=${series}` +
      `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=6`;
    const res = await fetch(url, { next: { revalidate: 3 * 3600 } });
    if (!res.ok) return null;
    const data = (await res.json()) as { observations?: { date: string; value: string }[] };
    const vals = (data.observations ?? [])
      .map((o) => parseFloat(o.value))
      .filter((v) => !isNaN(v));
    if (vals.length < 2) return null;
    const v0 = vals[0], v1 = vals[1];

    if (unit === "mom%") {
      const mom = v1 !== 0 ? ((v0 - v1) / v1) * 100 : 0;
      return { latest: `지수 ${v0.toFixed(1)}`, change: `전월대비 ${mom >= 0 ? "+" : ""}${mom.toFixed(2)}%`, raw: mom };
    }
    if (unit === "qoq%") {
      const qoq = v1 !== 0 ? (Math.pow(v0 / v1, 4) - 1) * 100 : 0; // 연율 환산
      return { latest: `실질GDP ${v0.toFixed(0)}`, change: `전기대비 연율 ${qoq >= 0 ? "+" : ""}${qoq.toFixed(1)}%`, raw: qoq };
    }
    if (unit === "abs_k") {
      const diff = v0 - v1; // 천명 단위 (PAYEMS)
      return { latest: `${Math.round(v0).toLocaleString()}K`, change: `전월대비 ${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}K`, raw: diff };
    }
    // level
    const diff = v0 - v1;
    return { latest: `${v0.toLocaleString()}`, change: `전월대비 ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}`, raw: diff };
  } catch {
    return null;
  }
}
