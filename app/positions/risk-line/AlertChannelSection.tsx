"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "../../_components/Button";
import { Card, SectionLabel } from "../../_components/primitives";
import {
  startOtpVerification,
  verifyOtp,
  saveConsent,
  type AlertChannel,
} from "./alert-actions";

type Phase = "input" | "otp_sent" | "verified";

type ChannelState = {
  contact: string;
  phase: Phase;
  otp: string;
  error: string | null;
  consent: boolean;
};

function initState(saved: AlertChannel | undefined): ChannelState {
  return {
    contact: saved?.contact ?? "",
    phase: saved?.verified ? "verified" : "input",
    otp: "",
    error: null,
    consent: saved?.consent_given ?? false,
  };
}

function ChannelRow({
  channelType,
  saved,
}: {
  channelType: "email" | "sms";
  saved: AlertChannel | undefined;
}) {
  const [state, setState] = useState<ChannelState>(() => initState(saved));
  const [isPending, startTransition] = useTransition();

  const isEmail = channelType === "email";
  const label = isEmail ? "이메일" : "휴대폰";
  const placeholder = isEmail ? "이메일 주소" : "010-1234-5678";
  const consentLabel = isEmail
    ? "이메일 알림 수신에 동의합니다"
    : "문자(SMS) 알림 수신에 동의합니다";

  function handleRequestOtp() {
    setState((s) => ({ ...s, error: null }));
    startTransition(async () => {
      const result = await startOtpVerification(channelType, state.contact);
      if (result.error) {
        setState((s) => ({ ...s, error: result.error! }));
      } else {
        setState((s) => ({ ...s, phase: "otp_sent", error: null }));
      }
    });
  }

  function handleVerify() {
    setState((s) => ({ ...s, error: null }));
    startTransition(async () => {
      const result = await verifyOtp(channelType, state.otp);
      if (result.error) {
        setState((s) => ({ ...s, error: result.error! }));
      } else {
        setState((s) => ({ ...s, phase: "verified", error: null }));
      }
    });
  }

  function handleConsent() {
    startTransition(async () => {
      await saveConsent(channelType);
      setState((s) => ({ ...s, consent: true }));
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 py-2">
        <span className="w-14 shrink-0 text-[14px] text-ink-48">{label}</span>

        {state.phase === "verified" ? (
          <>
            <span className="flex-1 text-[15px]">{state.contact}</span>
            <span className="flex items-center gap-1 text-[13px] text-guard">
              <Check size={14} /> 인증완료
            </span>
          </>
        ) : (
          <>
            <input
              type={isEmail ? "email" : "tel"}
              value={state.contact}
              onChange={(e) =>
                setState((s) => ({ ...s, contact: e.target.value, phase: "input" }))
              }
              placeholder={placeholder}
              disabled={state.phase === "otp_sent"}
              className="h-9 flex-1 rounded-[8px] border border-hairline px-3 text-[15px] outline-none focus:border-guard disabled:bg-pearl disabled:text-ink-48"
            />
            <Button
              variant="secondary"
              onClick={handleRequestOtp}
              disabled={isPending || !state.contact}
              className="!px-4 !py-1.5 !text-[14px] shrink-0"
            >
              {isPending && state.phase === "input" ? "발송 중…" : "인증 요청"}
            </Button>
          </>
        )}
      </div>

      {state.phase === "otp_sent" ? (
        <div className="flex items-center gap-2 pl-[72px]">
          <input
            type="text"
            value={state.otp}
            onChange={(e) =>
              setState((s) => ({ ...s, otp: e.target.value.replace(/\D/g, "").slice(0, 6) }))
            }
            placeholder="인증 코드 6자리"
            inputMode="numeric"
            maxLength={6}
            className="h-9 w-36 rounded-[8px] border border-hairline px-3 text-[15px] tracking-widest outline-none focus:border-guard"
          />
          <Button
            variant="primary"
            onClick={handleVerify}
            disabled={isPending || state.otp.length !== 6}
            className="!px-4 !py-1.5 !text-[14px]"
          >
            {isPending ? "확인 중…" : "확인"}
          </Button>
          <button
            onClick={handleRequestOtp}
            disabled={isPending}
            className="text-[13px] text-ink-48 underline"
          >
            재발송
          </button>
        </div>
      ) : null}

      {state.error ? (
        <p className="pl-[72px] text-[13px] text-red-500">{state.error}</p>
      ) : null}

      {state.phase === "verified" && !state.consent ? (
        <div className="flex items-center gap-2 pl-[72px]">
          <button
            onClick={handleConsent}
            disabled={isPending}
            className="flex items-center gap-2 text-[14px] text-ink-80"
          >
            <span className="grid size-5 place-items-center rounded-[5px] border border-hairline">
            </span>
            {consentLabel}
          </button>
        </div>
      ) : null}

      {state.phase === "verified" && state.consent ? (
        <p className="pl-[72px] text-[13px] text-guard">
          <Check size={13} className="inline mr-1" />
          수신 동의 완료
        </p>
      ) : null}
    </div>
  );
}

export default function AlertChannelSection({
  initialChannels,
}: {
  initialChannels: AlertChannel[];
}) {
  const emailChannel = initialChannels.find((c) => c.channel_type === "email");
  const smsChannel = initialChannels.find((c) => c.channel_type === "sms");

  return (
    <Card className="mt-4">
      <SectionLabel>알림 채널</SectionLabel>
      <ChannelRow channelType="email" saved={emailChannel} />
      <div className="mt-2 border-t border-divider pt-2">
        <ChannelRow channelType="sms" saved={smsChannel} />
      </div>
      <p className="mt-2 text-[13px] text-ink-48">
        인증·수신 동의를 완료한 채널로 위험 알림과 장중 시황이 발송됩니다.
      </p>
    </Card>
  );
}
