// 위기구간(환율∨DXY 52주신고+5일) 발동일의 익일 수익 편차 (점수 보정용)
import { readFileSync } from "fs";
for (const line of readFileSync(require("path").resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { fetchDailyPredict } from "../lib/predict/data";
const yf = new YahooFinance();
type S = { date: string; close: number }[];
async function ds(sym: string): Promise<S> {
  const r = await yf.chart(sym, { period1: new Date(Date.now() - 4300 * 86400e3), interval: "1d" });
  return (r.quotes ?? []).filter((q: any) => q.close != null).map((q: any) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close }));
}
function zoneDays(s: S, n = 5): Set<string> {
  const out = new Set<string>(); let left = 0;
  for (let i = 260; i < s.length; i++) {
    const hi = Math.max(...s.slice(i - 260, i).map((x) => x.close));
    if (s[i].close > hi && left === 0) left = n;
    if (left > 0) { out.add(s[i].date); left--; }
  }
  return out;
}
(async () => {
  const [fx, dxy] = await Promise.all([ds("KRW=X"), ds("DX-Y.NYB")]);
  const zf = zoneDays(fx), zd = zoneDays(dxy);
  const inZone = (s: S, days: Set<string>, kst: string): boolean => {
    for (let i = s.length - 1; i >= 0; i--) if (s[i].date < kst) return days.has(s[i].date);
    return false;
  };
  for (const [code, name] of [["005930", "삼전"], ["000660", "하닉"]] as const) {
    const bars = await fetchDailyPredict(code, 2600);
    let zc = 0, zs = 0, zu = 0, ac = 0, as_ = 0;
    for (let i = 260; i < bars.length - 1; i++) {
      const r = (bars[i + 1].close / bars[i].close - 1) * 100;
      ac++; as_ += r;
      if (inZone(fx, zf, bars[i].date) || inZone(dxy, zd, bars[i].date)) { zc++; zs += r; if (r > 0) zu++; }
    }
    console.log(`${name}: 위기구간 ${zc}일 익일 ${(zs / zc).toFixed(2)}%·상승${Math.round((100 * zu) / zc)}% (전체 평균 ${(as_ / ac).toFixed(2)}%) → 편차 ${((zs / zc) - (as_ / ac)).toFixed(2)}%p`);
  }
})();
