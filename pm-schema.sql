-- 프로젝트 추진일정 앱 — PM(담당자) 필드 추가
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.

alter table projects add column if not exists pm text not null default '';
