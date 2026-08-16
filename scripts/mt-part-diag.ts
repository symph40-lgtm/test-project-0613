// 부품 진단 — 3년간 각 부품의 fill 분포·발화율(≥0.6), 패널 후보율, 가격확인율.
// §5.2 "성적 미달 규칙은 출처 불문 강등" 판정의 1차 재료.
import { readFileSync } from "fs"; import { resolve } from "path";
try { for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
async function main() {
  const { fetchMtBars, fetchSoxByDate, fetchCauseTextByDate } = await import("../lib/mt/data");
  const { computeMtDay } = await import("../lib/mt/engine");
  type Bar = import("../lib/mt/types").Bar;
  const bars: Record<string, Bar[]> = {};
  for (const s of ["005930","000660","KOSPI200"] as const) bars[s] = await fetchMtBars(s, 800);
  const dates = [...new Set(Object.values(bars).flat().map(b=>b.date))].sort();
  const soxByDate = await fetchSoxByDate(dates, dates[0]);
  const causeTextByDate = await fetchCauseTextByDate();
  const cm = (b: Bar[]) => new Map(b.map(x=>[x.date,x.close]));
  for (const s of ["005930","KOSPI200"] as const) {
    const b = bars[s];
    const stat: Record<string,{n:number;sum:number;fire:number;avail:number}> = {};
    const panelCand: Record<string,number> = {S1:0,S2:0,S3:0,S4:0};
    let priceUp=0, priceDn=0, n=0, conf=0, cand=0;
    for (let i=80;i<b.length;i++){
      const d = computeMtDay(s,b,i,{c1:{soxByDate,causeTextByDate},
        indexCloseByDate: s==="KOSPI200"?undefined:cm(bars.KOSPI200),
        leaderCloseByDate: s==="KOSPI200"?[cm(bars["005930"]),cm(bars["000660"])]:undefined,
        breadth:null,flow:null,mode:"retro"});
      n++;
      for (const k of ["S1","S2","S3","S4"] as const){
        if (d.panels[k].candidate) panelCand[k]++;
        for (const p of d.panels[k].parts){
          stat[p.key] ??= {n:0,sum:0,fire:0,avail:0};
          stat[p.key].n++;
          if (p.available){ stat[p.key].avail++; stat[p.key].sum += p.fill!; if ((p.fill??0)>=0.6) stat[p.key].fire++; }
        }
      }
      if (d.transition.candidate) cand++;
      if (d.transition.confirmed) conf++;
      if (d.transition.priceConfirm?.includes("돌파")&&!d.transition.priceConfirm.includes("미돌파")) { if (d.transition.priceConfirm.startsWith("상단")) priceUp++; else priceDn++; }
    }
    console.log(`\n[${s}] n=${n} · 전이규칙 후보일 ${cand} (${(cand/n*100).toFixed(0)}%) · 확정 ${conf} · 가격확인 성립 상단 ${priceUp}·하단 ${priceDn}`);
    console.log(` 패널 후보율: ${Object.entries(panelCand).map(([k,v])=>`${k} ${(v/n*100).toFixed(0)}%`).join(" · ")}`);
    console.log(" 부품별 평균fill / 발화율(≥0.6) / 가용률:");
    for (const [k,v] of Object.entries(stat)) console.log(`  ${k}: ${(v.sum/Math.max(1,v.avail)).toFixed(2)} / ${(v.fire/Math.max(1,v.avail)*100).toFixed(0)}% / ${(v.avail/v.n*100).toFixed(0)}%`);
  }
}
main();
