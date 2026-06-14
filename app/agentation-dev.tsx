"use client";

import { Agentation } from "agentation";

// 개발 환경에서만 렌더되는 클라이언트 전용 래퍼.
// agentation은 DOM 접근이 필요한 클라이언트 전용 컴포넌트입니다.
export default function AgentationDev() {
  if (process.env.NODE_ENV !== "development") {
    return null;
  }

  return <Agentation />;
}
