# 다른 컴퓨터에서 개발 이어가기 (셋업 가이드)

작성: 2026-07-20. 새 컴퓨터에서 스탁가드 개발·Claude 작업을 이어가는 절차.

## 0. 먼저 알아둘 것 — 옮기지 않아도 되는 것

**서비스 운영은 컴퓨터와 무관하다.** 판정·문자·채점·크론은 전부 클라우드에서 돈다:
- 앱: Vercel (test-project-0613.vercel.app) — git push하면 자동 배포
- DB: Supabase · 크론: cron-job.org (평일 08~15시 2분 간격) · 문자: Solapi
개발 컴퓨터를 꺼도 실투자 시스템은 계속 동작한다.

## 1. 필수 3종 옮기기

### ① 코드 — GitHub에서 클론
```
git clone https://github.com/symph40-lgtm/test-project-0613.git "D:\vivecoding\test project_0613"
```
- **경로를 기존과 똑같이** (`D:\vivecoding\test project_0613`) 하는 것을 권장 — Claude 메모리 폴더 키가 경로 기반이라 그대로 이어진다 (③ 참조).
- Node.js 20+ 설치 후 프로젝트 폴더에서 `npm install`.

### ② 비밀키 — .env.local 수동 복사 (git에 없음!)
`.env.local` 파일을 USB 등으로 직접 복사한다. **이 파일이 유일한 원본**이다
(Supabase service key·KIS·Solapi·CRON_SECRET 등 — 유출 주의, 메일·메신저 전송 금지).
분실 시 각 서비스 대시보드에서 재발급해야 한다.

### ③ Claude 기억·예약 — 사용자 폴더 복사
새 컴퓨터에 Claude(데스크톱/Code) 설치·로그인 후, 기존 컴퓨터에서 아래 두 폴더를 복사:
```
C:\Users\<USER>\.claude\projects\D--vivecoding-test-project-0613\memory\   ← 프로젝트 기억 (설계 경위·실측 교훈)
C:\Users\<USER>\.claude\scheduled-tasks\                                   ← 예약 작업 (10/19 수급·V반등 검증 2건)
```
- memory를 안 옮기면 Claude가 코드·docs만으로 파악하므로 동작은 하지만, 실측 교훈(문자 폭주 사고, KIS 함정 등)을 다시 배워야 한다.
- 예약 작업은 "앱이 켜져 있는 컴퓨터"에서 실행되므로, 주로 쓰는 컴퓨터 한 곳에만 두면 된다.

## 2. 확인 절차 (새 컴퓨터에서)
1. `npm run dev` → http://localhost:3000 로그인 → /predict 열려서 판정 기록 보이면 DB 연결 OK
2. `npx tsx scripts/signal-backtest.ts` → 54건 PASS면 엔진 OK
3. Claude 세션 시작 → 프로젝트 기억이 인식되는지 확인 (예: "예측 시스템 현황 요약해줘")

## 3. 두 컴퓨터를 오가며 쓸 때
- 작업 시작 전 `git pull`, 끝나면 push — 이것만 지키면 충돌 없음
- `.env.local`은 키가 바뀔 때만 다시 복사 (평소엔 변화 없음)
- `.predict-cache/`(분봉 캐시)는 옮길 필요 없음 — 백테스트 첫 실행 때 KIS에서 자동 재수집 (220일 기준 ~5분). 시간을 아끼려면 폴더째 복사해도 된다
- Claude memory는 양쪽에서 수정될 수 있으므로, 주 작업 컴퓨터를 하나 정해두는 편이 관리가 쉽다
