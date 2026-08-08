// 국장 애프터장(NXT 15:30~20:00) 분봉 캐시 수집 (2026-08-08 — 수집이 7/16·7/24에 멈춰 있던 것 발견):
//   npx tsx scripts/kr-after-cache.ts [--days 40]
// 기존 파일명 규약을 그대로 쓴다 — 하닉 000660NXA-YYYY-MM-DD.json · 삼전 005930-ah-YYYY-MM-DD.json
// (after-gap-sweep·after-ladder-sweep·kr-overnight-* 가 이 이름으로 읽는다).
// 그동안 삼전은 track-seed.ts(수동 시딩·SYMBOL 하드코딩)로만 채워졌고 하닉 전용 수집기는 없었다.
// KIS 토큰은 분당 1회 제한이라 순차 호출한다 — 다른 백테스트와 병렬 실행 금지.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { fetchNxtAfterMarket } from "../lib/predict/kisMinute";

const CACHE = resolve(process.cwd(), ".predict-cache");
const args = process.argv.slice(2);
const argOf = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DAYS = parseInt(argOf("--days") ?? "40", 10);

const TARGETS: { code: string; name: string; file: (d: string) => string }[] = [
  { code: "000660", name: "하이닉스", file: (d) => `000660NXA-${d}.json` },
  { code: "005930", name: "삼성전자", file: (d) => `005930-ah-${d}.json` },
];

async function main() {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const today = new Date(Date.now() + 9 * 3600e3);
  const dates: string[] = [];
  for (let k = 1; k <= DAYS; k++) {
    const d = new Date(today.getTime() - k * 86400e3);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }
  dates.sort();
  for (const t of TARGETS) {
    let have = 0, got = 0, empty = 0;
    for (const date of dates) {
      const f = resolve(CACHE, t.file(date));
      if (existsSync(f)) { have++; continue; }
      const bars = await fetchNxtAfterMarket(t.code, date.replace(/-/g, ""), "200000");
      if (bars && bars.length >= 30) { writeFileSync(f, JSON.stringify(bars)); got++; }
      else { empty++; }   // 휴장·데이터 없음 — 파일을 만들지 않는다(다음 실행에서 재시도)
    }
    console.log(`${t.name}: 기존 ${have}일 · 신규 수집 ${got}일 · 데이터 없음 ${empty}일 (대상 ${dates.length}일)`);
  }
  // 최신 커버리지 리포트
  for (const t of TARGETS) {
    const all = dates.filter(d => existsSync(resolve(CACHE, t.file(d))));
    console.log(`  ${t.name} 최근 ${DAYS}일 창 커버: ${all.length}일 · 마지막 ${all[all.length - 1] ?? "—"}`);
  }
}
main();
