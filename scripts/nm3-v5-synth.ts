// NM3 W1 — V5 합성 검정 (IMPL_SPEC_TrackA §B3): SPRT 오판율 ≈ α·β, 대역 이탈률 ≈ 명목치 확인.
//   npx tsx scripts/nm3-v5-synth.ts
// SPRT는 판정까지 진행(최대 500일)한 오판율로 Wald 보증을 검사하고, 60일 절단 시 판정 분포를 병기.
// 대역은 60일 시점 하단 이탈률(90% 대역 하단 = 편측 5%, 99% = 0.5%)을 검사.
import { v5State, V5_CONST } from "../lib/predict/nm3V5";

const N_PATH = 2000;
// mulberry32 — LCG는 연속쌍 상관으로 Box-Muller를 오염시켜 부적합 (1차 시도에서 대역 이탈률 왜곡 실측)
let seed = 20260810 >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => { const u = Math.max(1e-12, rand()), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function simulate(mu: number, c: typeof V5_CONST.hx) {
  let h1AtEnd = 0, h0AtEnd = 0, undec60 = 0, h1At60 = 0, h0At60 = 0, band90 = 0, band99 = 0;
  for (let p = 0; p < N_PATH; p++) {
    const xs: number[] = [];
    let decided: "h0" | "h1" | null = null;
    for (let t = 1; t <= 500; t++) {
      xs.push(mu + c.sigma * gauss() + c.cbar); // 그로스 생성 (v5State가 c̄ 차감)
      const st = v5State(xs, c);
      if (t === 60) {
        if (st) {
          if (st.band === "주의(90%)" || st.band === "재검(99%)") band90++;
          if (st.band === "재검(99%)") band99++;
          if (!decided && st.sprt === "중단재검") h1At60++;
          else if (!decided && st.sprt === "궤도유지") h0At60++;
          else if (!decided) undec60++;
        }
      }
      if (!decided && st && st.sprt !== "계속") decided = st.sprt === "중단재검" ? "h1" : "h0";
      if (decided && t >= 60) break;
    }
    if (decided === "h1") h1AtEnd++; else if (decided === "h0") h0AtEnd++;
  }
  return { h1: h1AtEnd / N_PATH, h0: h0AtEnd / N_PATH, band90: band90 / N_PATH, band99: band99 / N_PATH, u60: undec60 / N_PATH };
}

for (const [key, c] of Object.entries(V5_CONST)) {
  const underH0 = simulate(c.mu, c); // 궤도 유지가 진실 → H1 수용률 ≈ α=0.1
  const underH1 = simulate(0, c);    // 에지 소멸이 진실 → H0 수용률 ≈ β=0.1
  console.log(`[${key}] H0 진실: H1 오수용 ${(underH0.h1 * 100).toFixed(1)}% (목표 ~10%) · 60일 하단 이탈 90% ${(underH0.band90 * 100).toFixed(1)}%(명목 5%) · 99% ${(underH0.band99 * 100).toFixed(1)}%(명목 0.5%)`);
  console.log(`[${key}] H1 진실: H0 오수용 ${(underH1.h0 * 100).toFixed(1)}% (목표 ~10%) · 60일 미판정 ${(underH1.u60 * 100).toFixed(0)}%`);
  // Wald 경계는 보수적 — 실제 오판율 ≤ 명목 α·β 가 정상. 상한 +2%p 여유로 단측 검사.
  const okA = underH0.h1 <= 0.12, okB = underH1.h0 <= 0.12;
  const okBand = underH0.band90 >= 0.03 && underH0.band90 <= 0.07 && underH0.band99 <= 0.012;
  if (!okA || !okB || !okBand) throw new Error(`합성 검정 실패: ${key} α측 ${underH0.h1.toFixed(3)} / β측 ${underH1.h0.toFixed(3)} / 대역 ${underH0.band90.toFixed(3)}·${underH0.band99.toFixed(3)}`);
}
console.log("합성 검정 통과 (SPRT 오판율 ≤ 명목+2%p · 대역 이탈률 명목 범위)");
