-- 전문가 Q&A 답변을 7단계 매매·위험도 스탠스로 구조화해 저장 (시황/매매 판단 반영용)
alter table public.ai_consults
  add column if not exists stance jsonb;
