// KIS 연동 진단 — 프로덕션 허용 (CRON_SECRET 필요). 토큰 발급 → 투자자동향 → 프로그램매매를
// 단계별로 호출해 어느 단계에서 실패하는지 보고한다. 키·토큰 값 자체는 절대 반환하지 않는다.
// 배경: 2026-07-09 KIS 수급 연동 후 프로덕션 틱의 kospi_frgn·kospi_prgm·fut_frgn이 전부 null
// (T4·T5·T8 "KIS 수급 데이터 대기") — 로컬 키는 정상이라 서버측 실패 지점 특정용.

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.nextUrl.searchParams.get("secret");
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const report: Record<string, unknown> = {
    hasKeys: Boolean(appkey && appsecret),
    keyLen: appkey?.length ?? 0,
    secretLen: appsecret?.length ?? 0,
    base: KIS_BASE,
    region: process.env.VERCEL_REGION ?? null,
  };
  if (!appkey || !appsecret) return NextResponse.json(report);

  // ① 토큰 발급
  let token: string | null = null;
  try {
    const t0 = Date.now();
    const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey, appsecret }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    report.tokenStatus = r.status;
    report.tokenMs = Date.now() - t0;
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    token = typeof j.access_token === "string" ? j.access_token : null;
    report.tokenOk = Boolean(token);
    if (!token) report.tokenError = { error_code: j.error_code ?? null, error_description: j.error_description ?? null };
  } catch (e) {
    report.tokenOk = false;
    report.tokenException = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return NextResponse.json(report);
  }
  if (!token) return NextResponse.json(report);

  // ② 투자자매매동향 (코스피 현물 — T5·T8과 동일 tr_id)
  const call = async (label: string, path: string, trId: string, params: Record<string, string>) => {
    try {
      const t0 = Date.now();
      const url = new URL(`${KIS_BASE}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: trId, custtype: "P" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json().catch(() => ({}))) as { rt_cd?: string; msg_cd?: string; msg1?: string; output?: unknown[] };
      report[label] = {
        status: r.status,
        ms: Date.now() - t0,
        rt_cd: j.rt_cd ?? null,
        msg_cd: j.msg_cd ?? null,
        msg1: j.msg1 ?? null,
        rows: Array.isArray(j.output) ? j.output.length : null,
      };
    } catch (e) {
      report[label] = { exception: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  };

  await call("investorKospi", "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market", "FHPTJ04030000", {
    FID_INPUT_ISCD: "KSP",
    FID_INPUT_ISCD_2: "0001",
  });
  await call("investorK200Fut", "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market", "FHPTJ04030000", {
    FID_INPUT_ISCD: "K2I",
    FID_INPUT_ISCD_2: "F001",
  });
  await call("programKospi", "/uapi/domestic-stock/v1/quotations/comp-program-trade-today", "FHPPG04600101", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_MRKT_CLS_CODE: "K",
    FID_SCTN_CLS_CODE: "",
    FID_INPUT_ISCD: "",
    FID_COND_MRKT_DIV_CODE1: "",
    FID_INPUT_HOUR_1: "",
  });

  return NextResponse.json(report);
}
