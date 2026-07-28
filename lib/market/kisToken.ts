// KIS 접근토큰 공유 캐시 (2026-07-28 실측 사고 후속) — tokenP 발급은 분당 1회 제한인데
// getToken이 predict/kisMinute · market/kis · predict-daily/after 3곳에 중복돼 서버리스
// 콜드 인스턴스마다 각자 발급 요청 → 경합 시 전부 null (7/28 09:06 피셔 실시간 '데이터 없음',
// 11:01~11:20 스트림 공백 추정 원인). 판정 로직과 무관한 공용 인프라라 세 모듈이 공유한다
// (predict-daily의 predict 직접 import 금지 원칙과 무관 — supabase 클라이언트와 같은 층위).
//
// 조회 순서: 메모리 → ops_settings(kis_token) → 신규 발급(+DB 저장) → 발급 실패 시 1.2초 후
// DB 재확인 (경합에서 진 쪽은 이긴 쪽이 방금 저장한 토큰을 집어온다). 토큰은 24h 유효.

import { createAdminClient } from "../supabase/admin";

const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
const DB_KEY = "kis_token";

let mem: { token: string; exp: number } | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readDb(): Promise<{ token: string; exp: number } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("ops_settings").select("value").eq("key", DB_KEY).maybeSingle();
    const v = (data?.value ?? null) as { token?: string; exp?: number } | null;
    return typeof v?.token === "string" && typeof v?.exp === "number" ? { token: v.token, exp: v.exp } : null;
  } catch {
    return null; // Supabase 미설정(로컬 스크립트 등) — 직접 발급으로 폴백
  }
}

async function writeDb(v: { token: string; exp: number }): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("ops_settings").upsert(
      { key: DB_KEY, value: v, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch { /* 저장 실패해도 메모리 캐시로 동작 */ }
}

async function issue(appkey: string, appsecret: string): Promise<{ token: string; exp: number } | null> {
  try {
    const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey, appsecret }),
      cache: "no-store",
    });
    if (!r.ok) return null; // 분당 제한(EGW00133) 포함
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    return { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 86400) * 1000 };
  } catch {
    return null;
  }
}

export async function getKisToken(): Promise<string | null> {
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) return null;
  const fresh = (v: { token: string; exp: number } | null) => v !== null && v.exp > Date.now() + 60_000;

  if (fresh(mem)) return mem!.token;
  const db = await readDb();
  if (fresh(db)) { mem = db; return db!.token; }
  const issued = await issue(appkey, appsecret);
  if (issued) { mem = issued; await writeDb(issued); return issued.token; }
  await sleep(1200);
  const again = await readDb();
  if (fresh(again)) { mem = again; return again!.token; }
  return null;
}
