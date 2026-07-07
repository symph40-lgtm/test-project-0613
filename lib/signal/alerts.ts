// M7 신호 알림 — 판정 구간(session.observeEndMin~entryEndMin, 현재 09:30~13:30)에
// 행동 가능한 판정이 확정되면 발송.
// 채널: SMS(알리고) + 이메일(Resend) 병행 — 알리고는 발송 IP 사전등록제라 유동 IP인 Vercel에서
// 인증오류(-101)로 실패할 수 있음(2026-07-05 확인). 이메일은 IP 제한이 없어 확실한 채널.
// 수신자: alert_channels에서 각 채널 인증(verified) + 동의(consent_given)한 사용자 전체.
// 중복 방지: alerts 테이블(trigger_key='signal')에 오늘 같은 alertKey가 있으면 재발송 안 함.
// 알림은 판단 보조일 뿐 매매 지시가 아니다 — 문구에 항상 "검토" 수준으로 표현.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels, type ChannelAlert } from "@/lib/alerts/dispatch";
import { SIGNAL_CONFIG } from "./config";
import type { IntradayTick, Judgment } from "./types";

type SignalAlert = ChannelAlert;

// 판정 → 알림 여부·문구 결정 (없으면 null)
export function buildSignalAlert(j: Judgment): SignalAlert | null {
  if (j.phase !== "판정") return null; // 진입 시간대(L4)에만 문자 — 그 외는 화면으로 충분

  const t = j.trend;
  const stat = t
    ? `T ${t.score.toFixed(1)}/${t.maxAvailable}·DC1 ${t.dc1 !== null ? (t.dc1 * 100).toFixed(0) + "%" : "-"}`
    : "";
  const stop = `스탑 -${j.risk.stopFixedPct}%${j.risk.stopAtrPct !== null ? `(ATR -${j.risk.stopAtrPct.toFixed(1)}%)` : ""}`;

  // 약한 추세(장중 재형성 포함)는 확정과 구분 — 비중 1/3·타이트 트레일링 안내
  const weak = t?.grade === "약한추세";
  const late = t?.midday?.active && (t?.flips ?? 0) > 2 ? " · 장중 재형성" : "";
  // 진입신호 문자는 셋업 필수 조건까지 전부 충족했을 때만 — dayType(축2 추세)만으로 보내면
  // 셋업 카드가 '대기'인데 "진입 검토" 문자가 가는 모순 발생 (2026-07-07 실제 사례:
  // Bias 상방·매크로 악화 0/3으로 인버스 필수 미충족인데 추세일_하방 문자 발송됨)
  if (j.dayType === "추세일_상방" && j.setups.long.blocked.length === 0 && j.setups.long.requiredOk) {
    return {
      key: "trend_up",
      severity: "high",
      smsSubject: "진입신호 레버리지",
      text: weak
        ? `[스탁가드 신호] 상방 약한 추세${late} (${stat})\n레버리지 1/3 비중만 검토 · 트레일링 -${j.risk.trailPct}%\n${stop} · 15:00 당일 청산`
        : `[스탁가드 신호] 추세일 상방 확정${late} (${stat})\n레버리지 진입 검토 — ${j.risk.sizeGuide}\n${stop} · 15:00 당일 청산`,
    };
  }
  if (j.dayType === "추세일_하방" && j.setups.short.blocked.length === 0 && j.setups.short.requiredOk) {
    return {
      key: "trend_down",
      severity: "high",
      smsSubject: "진입신호 인버스",
      text: weak
        ? `[스탁가드 신호] 하방 약한 추세${late} (${stat})\n인버스 1/3 비중만 검토 · 트레일링 -${j.risk.trailPct}%\n${stop} · 15:00 당일 청산`
        : `[스탁가드 신호] 추세일 하방 확정${late} (${stat})\n인버스 진입 검토 — 총자산 ${j.risk.inverseCapPct}% 상한\n${stop} · 15:00 당일 청산`,
    };
  }
  if (j.dayType === "V반등후보" && (j.setups.long.verdict === "진입후보" || j.setups.long.verdict === "강한신호")) {
    return {
      key: "vrebound_long",
      severity: "high",
      smsSubject: "진입신호 V반등",
      text: `[스탁가드 신호] V반등 ${j.setups.long.verdict} (가점 ${j.setups.long.bonus}점, ${stat})\n반전 후 진행 확인됨 — 레버리지 검토, ${j.risk.sizeGuide}\n${stop} · 인버스 금지(XS1)`,
    };
  }
  // V반등 조기 반전 — 지속 확인 전 1/3 비중 선진입 (2단계 진입의 1차. 늦으면 수익이 줄어드는 문제 대응)
  if (j.dayType === "V반등후보" && j.crashContext.earlyRebound) {
    return {
      key: "vrebound_early",
      severity: "high",
      smsSubject: "진입신호 V반등(조기)",
      text: `[스탁가드 신호] V반등 조기 반전 감지\n${j.headline}\n레버리지 1/3 비중만 선진입 검토 · ${stop} 타이트\n지속 확인 시 본진입 신호 추가 발송 · 인버스 금지(XS1)`,
    };
  }
  if (j.dayType === "횡보일") {
    return {
      key: "range_day",
      severity: "low",
      smsSubject: "매매금지 횡보일",
      text: `[스탁가드 신호] 횡보일 선언 (방향 전환 ${j.trend?.flips ?? "?"}회)\n당일 추세 매매 금지 — '안 하는 것'이 절반입니다.`,
    };
  }
  return null;
}

// ── 장중 급변 감지 (순수 함수) — 오늘 틱 시계열을 받아 두 종류 알림 생성:
//  ① 절대 단계: 당일 등락률(전일 종가 대비)이 단계(stockLevels·futLevels)를 돌파
//  ② 반락·반등 스윙: 당일 극값 대비 스텝(swingStep) 등간격 돌파 —
//     +1.5%→-1.1% 같은 반전은 등락률(-1.1%)만으론 안 보임 (사용자 요청 2026-07-06).
//     극값이 스텝 이상 갱신되면 에피소드가 바뀌어 단계가 재무장된다 (2026-07-08 사용자 피드백:
//     저점 -8.7까지 깊어진 뒤의 새 반등이 낮은 단계 소진으로 -5.8에서야 알림된 문제 수정).
// 판정 구간과 무관하게 장중(09:00~15:45) 전체 감시 — 보유 중 트레일링 점검·급등 확인용.
// 문자 요금 절약을 위해 90바이트 이내 단문으로 압축 (상세는 이메일·대시보드).
export function buildMoveAlerts(ticks: IntradayTick[]): SignalAlert[] {
  const tick = ticks.length > 0 ? ticks[ticks.length - 1] : undefined;
  if (!tick) return [];
  const S = SIGNAL_CONFIG.session;
  const M = SIGNAL_CONFIG.moveAlert;
  if (tick.minuteOfDay < S.openMin || tick.minuteOfDay > S.endMin + 15) return [];
  const hhmm = `${String(Math.floor(tick.minuteOfDay / 60)).padStart(2, "0")}:${String(tick.minuteOfDay % 60).padStart(2, "0")}`;

  const targets: {
    name: string; sym: string; chg: number | null;
    levels: readonly number[]; swingStep: number;
    series: (t: IntradayTick) => number | null;
  }[] = [
    { name: "SK하이닉스", sym: "hynix", chg: tick.hynixChg, levels: M.stockLevels, swingStep: M.stockSwingStep, series: (t) => t.hynixChg },
    { name: "삼성전자", sym: "samsung", chg: tick.samsungChg, levels: M.stockLevels, swingStep: M.stockSwingStep, series: (t) => t.samsungChg },
    { name: "코스피200선물", sym: "fut", chg: tick.futChg, levels: M.futLevels, swingStep: M.futSwingStep, series: (t) => t.futChg },
  ];

  const alerts: SignalAlert[] = [];
  for (const t of targets) {
    if (t.chg === null || !isFinite(t.chg)) continue;
    const cur = t.chg;

    // ① 절대 단계 — 돌파한 최고 단계 1개만 (예: -7.2%면 -7 단계)
    const crossed = t.levels.filter((lv) => Math.abs(cur) >= lv);
    if (crossed.length > 0) {
      const level = Math.max(...crossed);
      const dir = cur > 0 ? "급등" : "급락";
      const sign = cur > 0 ? "+" : "";
      const isTop = Math.abs(cur) >= t.levels[t.levels.length - 1];
      // 급등은 청산 신호가 아니다 — 시스템 철학상 상방 추세 후보(레버리지 검토·인버스 금지, 마스터 4장).
      // '과열'은 며칠 연속 상승 뒤 반전 셋업(S1) 조건이지 장중 급등이 아님 (사용자 지적 2026-07-06).
      const guide =
        dir === "급락"
          ? "위험선·트레일링 점검"
          : isTop
            ? "추세 확인·추격 진입 자제"
            : "상방추세 점검·보유시 트레일링 상향";
      alerts.push({
        key: `move_${t.sym}_${cur > 0 ? "u" : "d"}${level}`,
        severity: isTop ? "high" : "medium",
        // 단문 (≤90바이트): "[스탁가드] 코스피200선물 급등 +2.0% (09:09) 상방추세 점검·보유시 트레일링 상향"
        text: `[스탁가드] ${t.name} ${dir} ${sign}${cur.toFixed(1)}% (${hhmm}) ${guide}`,
      });
    }

    // ② 반락·반등 스윙 — 당일 극값 대비 스텝 등간격. 키에 극값 에피소드(스텝 격자 버킷)를 넣어
    // 극값이 스텝 이상 갱신되면 같은 단계도 다시 발송된다 (새 저점 기준의 새 반등이므로).
    const chgs = ticks.map(t.series).filter((v): v is number => v !== null && isFinite(v));
    if (chgs.length < 2) continue;
    const hi = Math.max(...chgs);
    const lo = Math.min(...chgs);
    const step = t.swingStep;

    // 고점 대비 반락 — 고점이 최소치 이상 반대편(위)에 있었을 때만 '반전'으로 인정
    const downSwing = hi - cur;
    if (hi >= M.swingMinExtreme && downSwing >= step) {
      // +1e-9: 부동소수 격자 경계(예: 6.3/0.7=9.0000…02)에서 floor가 한 칸 어긋나는 것 방지
      const level = Number((Math.floor(downSwing / step + 1e-9) * step).toFixed(1));
      const epi = Math.floor(hi / step + 1e-9); // 고점 에피소드 — 고점이 스텝 이상 높아지면 재무장
      alerts.push({
        key: `swing_${t.sym}_d${level}e${epi}`,
        severity: downSwing >= 3 * step ? "high" : "medium",
        // "[스탁가드] 코스피200선물 반락 고점+1.5%→-1.1% (-2.6%p) 위험선·트레일링 점검"
        text: `[스탁가드] ${t.name} 반락 고점${hi > 0 ? "+" : ""}${hi.toFixed(1)}%→${cur > 0 ? "+" : ""}${cur.toFixed(1)}% (-${downSwing.toFixed(1)}%p) 위험선·트레일링 점검`,
      });
    }

    // 저점 대비 반등 — 저점이 최소치 이상 아래에 있었을 때만
    const upSwing = cur - lo;
    if (lo <= -M.swingMinExtreme && upSwing >= step) {
      const level = Number((Math.floor(upSwing / step + 1e-9) * step).toFixed(1));
      const epi = Math.floor(lo / step + 1e-9); // 저점 에피소드 — 저점이 스텝 이상 깊어지면 재무장
      alerts.push({
        key: `swing_${t.sym}_u${level}e${epi}`,
        severity: upSwing >= 3 * step ? "high" : "medium",
        // "[스탁가드] 코스피200선물 반등 저점-2.0%→-1.0% (+1.0%p) 추세 전환 확인"
        text: `[스탁가드] ${t.name} 반등 저점${lo.toFixed(1)}%→${cur > 0 ? "+" : ""}${cur.toFixed(1)}% (+${upSwing.toFixed(1)}%p) 추세 전환 확인`,
      });
    }
  }
  return alerts;
}

// ── 거래량 급증 알람 (사용자 지정 2026-07-08) — 하닉 완성 5분봉 거래량이 당일 평균(그날의
// 이전 완성 5분봉 평균)의 ratio배(기본 1.3 = 30% 초과) 이상이면 알림 생성.
// 봉별 거래량은 연속 틱의 누적 거래량 차로 계산 (마이그레이션 019 hynix_vol 필요 — 없으면 조용히 무시).
export function buildVolumeAlert(ticks: IntradayTick[]): SignalAlert | null {
  const V = SIGNAL_CONFIG.volumeAlert;
  const S = SIGNAL_CONFIG.session;
  const last = ticks.length > 0 ? ticks[ticks.length - 1] : undefined;
  if (!last || last.minuteOfDay < S.openMin || last.minuteOfDay > S.endMin + 15) return null;

  // 완성 5분봉별 누적 거래량 (버킷 내 마지막 값)
  const pts = ticks.filter((t) => t.hynixVol !== null && isFinite(t.hynixVol as number) && t.minuteOfDay >= S.openMin);
  if (pts.length < 4) return null;
  const nowMin = last.minuteOfDay;
  const byBucket = new Map<number, number>();
  for (const p of pts) byBucket.set(Math.floor(p.minuteOfDay / 5), p.hynixVol as number);
  const buckets = [...byBucket.entries()].filter(([b]) => (b + 1) * 5 <= nowMin).sort(([a], [b]) => a - b);

  // 봉별 거래량 = 인접 완성 버킷의 누적 차 (틱 공백으로 버킷이 건너뛰면 그 구간은 제외)
  const bars: { b: number; vol: number }[] = [];
  for (let i = 1; i < buckets.length; i++) {
    const [b, cum] = buckets[i];
    const [pb, pcum] = buckets[i - 1];
    if (b - pb !== 1) continue;
    const vol = cum - pcum;
    if (vol >= 0) bars.push({ b, vol });
  }
  if (bars.length < V.minBars + 1) return null; // 평균 표본 + 판정 대상 1개

  const lastBar = bars[bars.length - 1];
  const prevBars = bars.slice(0, -1);
  const avg = prevBars.reduce((s, x) => s + x.vol, 0) / prevBars.length;
  if (avg <= 0) return null;
  const ratio = lastBar.vol / avg;
  if (ratio < V.ratio) return null;

  const endMin = (lastBar.b + 1) * 5;
  const hm = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
  const man = Math.round(lastBar.vol / 10000);
  const chg = last.hynixChg !== null ? ` 현재 ${last.hynixChg > 0 ? "+" : ""}${last.hynixChg.toFixed(1)}%` : "";
  return {
    key: `vol_hynix_b${lastBar.b}`, // 봉 단위 키 — 같은 봉은 1회
    severity: ratio >= 2 ? "high" : "medium",
    // "[스탁가드] 하닉 거래량 급증 5분봉 152만주=당일평균 1.6배 (10:35) 현재 -3.2%"
    text: `[스탁가드] 하닉 거래량 급증 5분봉 ${man}만주=당일평균 ${ratio.toFixed(1)}배 (${hm})${chg}`,
  };
}

// 거래량 알람 발송 — 30분 창 안에서 최대 maxPerWindow건 (최초 + 1건 추가, 사용자 지정)
export async function maybeSendVolumeAlert(date: string, ticks: IntradayTick[]): Promise<number> {
  const alert = buildVolumeAlert(ticks);
  if (!alert) return 0;
  const V = SIGNAL_CONFIG.volumeAlert;
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - V.windowMin * 60000).toISOString();
  const { data } = await admin
    .from("alerts")
    .select("message")
    .eq("trigger_key", "signal")
    .gte("created_at", sinceIso);
  const recent = new Set(
    (data ?? [])
      .map((r) => (r.message as { alertKey?: string } | null)?.alertKey)
      .filter((k): k is string => typeof k === "string" && k.startsWith("vol_hynix_")),
  );
  if (recent.size >= V.maxPerWindow) return 0;
  return dispatchToChannels("signal", date, alert, `거래량 급증 — ${alert.text.slice(7, 40)}`);
}

// ── RV1 하닉 분봉 모멘텀 진입신호 (사용자 지정 2026-07-07) — 조건 성립 시 즉시 문자.
// 추세·반전 여부 무관 (사용자 확정 3차). 감지는 엔진(engine/reversal.ts, judgment.ext.reversal).
// 하락(인버스)은 하드 블록 XS1(폭락 후 인버스 금지)이 우선 — 어떤 신호도 무효화 불가(마스터 8.4).
export function buildReversalAlert(j: Judgment): SignalAlert | null {
  const hit = j.ext.reversal;
  if (!hit) return null;
  if (j.phase === "장전" || j.phase === "마감") return null; // 장중(09:00~15:45)만
  if (hit.dir === "DOWN" && j.crashContext.active) return null; // XS1 — 폭락 후 인버스 금지
  const pre = hit.preMovePct !== null ? ` (직전 ${hit.preMovePct > 0 ? "+" : ""}${hit.preMovePct.toFixed(1)}%p)` : "";
  return hit.dir === "UP"
    ? {
        key: "rev_up",
        severity: "high",
        smsSubject: "모멘텀 레버리지",
        text: `[스탁가드 신호] 하닉 상승 모멘텀 — ${hit.cond}${pre} 레버리지 검토`,
      }
    : {
        key: "rev_down",
        severity: "high",
        smsSubject: "모멘텀 인버스",
        text: `[스탁가드 신호] 하닉 하락 모멘텀 — ${hit.cond}${pre} 인버스 검토`,
      };
}

// 모멘텀 신호 발송 — state 라우트에서 판정마다 호출.
// 발송 정책 (사용자 확정 2026-07-07): 같은 방향(추세)은 하루 최대 maxPerDirPerDay회
// (최초 rev_up + 추가분 rev_up_2·rev_up_3), 반복 사이 최소 repeatCooldownMin분 간격 —
// 조건이 수 분간 연속 성립해도 1분 간격 연속 발송이 되지 않게.
export async function maybeSendReversalAlert(j: Judgment): Promise<number> {
  const alert = buildReversalAlert(j);
  if (!alert) return 0;
  const R = SIGNAL_CONFIG.reversal;

  // 오늘 이 방향으로 이미 나간 회차·마지막 발송 시각 (사용자 무관 — 키 집합 기준)
  const admin = createAdminClient();
  const kstDayStartUtc = new Date(`${j.date}T00:00:00+09:00`).toISOString();
  const { data } = await admin
    .from("alerts")
    .select("created_at, message")
    .eq("trigger_key", "signal")
    .gte("created_at", kstDayStartUtc);
  const sentKeys = new Map<string, number>(); // alertKey → 마지막 발송 epoch ms
  for (const r of data ?? []) {
    const k = (r.message as { alertKey?: string } | null)?.alertKey;
    if (k && (k === alert.key || k.startsWith(`${alert.key}_`))) {
      const t = Date.parse(r.created_at as string);
      sentKeys.set(k, Math.max(sentKeys.get(k) ?? 0, t));
    }
  }
  const n = sentKeys.size; // 오늘 이 방향 발송 회차
  if (n >= R.maxPerDirPerDay) return 0;
  // 반복 간격: 1차→2차 10분, 2차→3차 5분 (배열 초과분은 마지막 값)
  const cooldownMin = R.repeatCooldownMins[Math.min(n - 1, R.repeatCooldownMins.length - 1)] ?? 0;
  if (n > 0 && Date.now() - Math.max(...sentKeys.values()) < cooldownMin * 60000) return 0;

  const keyed: SignalAlert = {
    ...alert,
    key: n === 0 ? alert.key : `${alert.key}_${n + 1}`,
    text: n === 0 ? alert.text : `${alert.text} (${n + 1}차)`,
  };
  return dispatchToChannels("signal", j.date, keyed, `분봉 모멘텀 — ${keyed.text.slice(10, 45)}`, {
    reversal: j.ext.reversal,
    dayType: j.dayType,
    ts: j.ts,
  });
}

// 급변 알림 발송 — state 라우트에서 틱마다 호출 (단계별 1일 1회 중복 방지)
export async function maybeSendMoveAlerts(date: string, ticks: IntradayTick[]): Promise<number> {
  const alerts = buildMoveAlerts(ticks);
  if (alerts.length === 0) return 0;
  let sent = 0;
  for (const alert of alerts) {
    sent += await dispatchToChannels("signal", date, alert, `장중 급변 — ${alert.text.slice(7, 40)}`);
  }
  return sent;
}

// 발송 실행 — state 라우트에서 판정마다 호출 (내부에서 중복·수신자 판단)
// 공용 발송 경로(1일 1회 중복 방지·채널 조회)는 lib/alerts/dispatch.ts로 이동.
export async function maybeSendSignalSms(j: Judgment): Promise<{ sent: number; skipped: string | null }> {
  const alert = buildSignalAlert(j);
  if (!alert) return { sent: 0, skipped: "알림 대상 아님" };
  const sent = await dispatchToChannels("signal", j.date, alert, undefined, { headline: j.headline, dayType: j.dayType, ts: j.ts });
  return { sent, skipped: sent === 0 ? "기발송 또는 채널 없음" : null };
}
