-- 프로젝트 추진일정 앱 — 프로젝트 타입(프로젝트 추진일정 / 업무 체크리스트) 구분
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.

alter table projects add column if not exists type text not null default 'timeline';

alter table projects drop constraint if exists projects_type_check;
alter table projects add constraint projects_type_check check (type in ('timeline', 'checklist'));

-- 기존에 있던 프로젝트는 전부 기본값인 'timeline'(프로젝트 추진일정)으로 유지됩니다.
