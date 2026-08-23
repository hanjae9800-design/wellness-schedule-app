-- 프로젝트 추진일정 앱 — 관리자 페이지용 스키마 추가분
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.
-- (supabase-schema.sql, feedback-schema.sql을 이미 실행한 뒤에 추가로 실행하는 용도입니다.)

-- 1) 피드백을 관리자 페이지에서 "해결됨"으로 표시하거나 삭제할 수 있도록 정책 추가
drop policy if exists "feedback anon update" on feedback;
create policy "feedback anon update" on feedback
  for update using (true) with check (true);

drop policy if exists "feedback anon delete" on feedback;
create policy "feedback anon delete" on feedback
  for delete using (true);

-- 2) 페이지 방문 기록 (얼마나 쓰이고 있는지 보기 위한 아주 단순한 조회수 로그)
create table if not exists page_views (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  page text not null default '',
  created_at timestamptz not null default now()
);

alter table page_views enable row level security;

drop policy if exists "page_views anon insert" on page_views;
create policy "page_views anon insert" on page_views
  for insert with check (true);

drop policy if exists "page_views anon select" on page_views;
create policy "page_views anon select" on page_views
  for select using (true);
