@echo off
REM 주간 캐시 수집 (2026-08-08 — 사용자 지시로 정기화)
REM   soxx-merge-1m : SOXX 1분봉 병합. 야후가 30일 롤링이라 놓치면 그 구간은 영구 소실된다. ★필수
REM   kr-after-cache: 국장 애프터장(NXT) 분봉. KIS에 이력이 남아 있어 놓쳐도 소급 복구는 가능.
REM 실행: 이 파일을 Windows 작업 스케줄러에 주 1회(예: 토요일 09:00) 등록.
REM 수동 실행도 가능 — 프로젝트 폴더에서 scripts\weekly-cache.bat
cd /d "%~dp0.."
echo [%date% %time%] soxx-merge-1m 시작
call npx tsx scripts/soxx-merge-1m.ts >> .predict-cache\weekly-cache.log 2>&1
echo [%date% %time%] kr-after-cache 시작
call npx tsx scripts/kr-after-cache.ts --days 40 >> .predict-cache\weekly-cache.log 2>&1
echo [%date% %time%] 완료 — 로그: .predict-cache\weekly-cache.log
