# 다른 컴퓨터에서 개발 이어가기 — 상세 절차

작성: 2026-07-20. 새 컴퓨터에서 스탁가드 개발·Claude 작업을 이어가는 전체 절차.
(요약판이 아니라 따라하기용 상세판. GitHub에서 이 파일을 열어 보면서 진행하면 된다.)

## 0. 먼저 알아둘 것 — 옮기지 않아도 되는 것

**서비스 운영은 컴퓨터와 무관하다.** 판정·문자·채점·크론은 전부 클라우드에서 돈다:
- 앱: Vercel (test-project-0613.vercel.app) — git push하면 자동 배포
- DB: Supabase · 크론: cron-job.org (평일 08~15시 2분 간격) · 문자: Solapi
개발 컴퓨터를 꺼도 실투자 시스템은 계속 동작한다. 옮기는 것은 "개발 환경"뿐이다.

---

## 1단계. 기존 컴퓨터에서 USB에 담을 것 (3+1가지)

| # | 원본 위치 | 용도 |
|---|---|---|
| 1 | `D:\vivecoding\test project_0613\.env.local` | **비밀키 원본 (필수)** — git에 없음 |
| 2 | `C:\Users\USER\.claude\projects\D--vivecoding-test-project-0613\memory\` 폴더 | Claude 프로젝트 기억 (설계 경위·실측 교훈) |
| 3 | `C:\Users\USER\.claude\scheduled-tasks\` 폴더 | 예약 작업 2건 (10/19 수급·V반등 검증) |
| 4 | (선택) `D:\vivecoding\test project_0613\.predict-cache\` 폴더 | 분봉 캐시 — 안 옮기면 첫 백테스트 때 ~5분 재수집 |

⚠ `.env.local`은 Supabase·KIS·문자 발송 키 전부가 든 파일이다 — **메일·메신저·클라우드 업로드 금지**, USB로만.
⚠ 탐색기에서 점(.)으로 시작하는 파일이 안 보이면: 보기 → "숨긴 항목" 체크.

## 2단계. 새 컴퓨터에 프로그램 3개 설치

1. **Git**: https://git-scm.com/download/win → 설치 파일 실행 → 전부 기본값으로 Next
2. **Node.js**: https://nodejs.org → **LTS** 버전(20 이상) 다운로드 → 기본값 설치
   - 확인: PowerShell 열고 `node -v` 입력 → `v20.x` 이상 나오면 성공
3. **Claude** (지금 쓰는 것과 같은 앱): https://claude.ai/download → 설치 → **같은 계정으로 로그인**

## 3단계. 코드 받기 (GitHub 클론)

PowerShell을 열고 한 줄씩 실행:

```powershell
mkdir D:\vivecoding
git clone https://github.com/symph40-lgtm/test-project-0613.git "D:\vivecoding\test project_0613"
```

- 처음 클론하면 **브라우저가 열리며 GitHub 로그인**을 요구한다 → symph40 계정으로 로그인/승인하면 끝 (한 번만).
- **D 드라이브가 없는 컴퓨터라면**: `C:\vivecoding\test project_0613`으로 클론해도 된다. 단 4단계 ③에서 기억 폴더 이름을 `C--vivecoding-test-project-0613`으로 바꿔서 붙여넣어야 한다 (폴더명이 프로젝트 경로를 따라간다).

이어서 의존성 설치:
```powershell
cd "D:\vivecoding\test project_0613"
npm install
```
(2~3분 소요. warning은 무시해도 된다 — error만 문제)

## 4단계. USB에서 3가지 붙여넣기

① **`.env.local`** → 프로젝트 루트(`D:\vivecoding\test project_0613\`)에 붙여넣기
   - 파일명이 정확히 `.env.local`인지 확인 (메모장으로 저장하다 `.env.local.txt`가 되는 사고 주의)

② **memory 폴더** → 새 컴퓨터의 `C:\Users\<새 사용자명>\.claude\projects\D--vivecoding-test-project-0613\memory\`
   - 중간 폴더(projects\D--vivecoding-test-project-0613)가 없으면 직접 만들고 그 안에 memory를 넣는다
   - C 드라이브에 클론했다면 폴더명을 `C--vivecoding-test-project-0613`으로

③ **scheduled-tasks 폴더** → `C:\Users\<새 사용자명>\.claude\scheduled-tasks\`
   - 예약 작업은 "Claude 앱이 켜져 있는 컴퓨터"에서 실행된다 — **주로 쓰는 컴퓨터 한 곳에만** 두는 것을 권장 (양쪽에 있으면 두 번 실행될 수 있다)

④ (선택) `.predict-cache` 폴더 → 프로젝트 루트에 붙여넣기

## 5단계. 동작 확인 (3가지 체크)

PowerShell, 프로젝트 폴더에서:

1. **엔진**: `npx tsx scripts/signal-backtest.ts` → `[PASS]` 54건이면 정상
2. **앱+DB**: `npm run dev` → 브라우저에서 http://localhost:3000 → 로그인 → **/predict**에 판정 기록이 보이면 DB 연결 정상 (확인 후 Ctrl+C로 종료)
3. **Claude 기억**: Claude 앱에서 프로젝트 폴더(`D:\vivecoding\test project_0613`)를 열고 새 세션 시작 → "예측 시스템 현황 요약해줘"라고 물었을 때 피셔 단독 판정·체크포인트·실투자 상황을 알고 있으면 기억이 이어진 것

## 6단계. 두 컴퓨터를 오가며 쓰는 습관

- **작업 시작 전**: `git pull` (상대 컴퓨터에서 푸시한 변경 받기)
- **작업 끝나면**: 커밋 + `git push` (Vercel 자동 배포 포함)
- 이 둘만 지키면 충돌 없음. push를 잊고 다른 컴퓨터에서 작업하면 수동 병합이 필요해지니 주의
- `.env.local`은 키가 바뀔 때만 다시 복사 (평소엔 그대로)
- Claude memory는 양쪽에서 따로 쌓일 수 있다 — **Claude 작업은 주 컴퓨터 한 곳에서** 하는 것을 권장. 부득이 양쪽을 쓰면 가끔 memory 폴더를 최신 쪽 기준으로 덮어쓰기

## 문제 해결

| 증상 | 원인·해결 |
|---|---|
| `git clone` 시 Repository not found | GitHub 로그인 계정이 다름 — 자격 증명 관리자에서 github 항목 삭제 후 재시도 |
| `npm run dev`에서 환경변수 오류 | `.env.local`이 루트에 없거나 파일명이 다름 (.txt 확장자 확인) |
| /predict가 "마이그레이션 026" 안내 표시 | `.env.local`의 Supabase 키가 안 읽힌 것 — 파일 위치·이름 확인 후 dev 서버 재시작 |
| 백테스트가 분봉 수집부터 시작 | 정상 — `.predict-cache`를 안 옮긴 경우 KIS에서 자동 재수집 (~5분) |
| Claude가 프로젝트를 처음 보는 것처럼 행동 | memory 폴더 경로 불일치 — 4단계 ②의 폴더명(드라이브 문자)을 확인 |
