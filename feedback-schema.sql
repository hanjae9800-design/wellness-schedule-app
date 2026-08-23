-- 프로젝트 추진일정 앱 — 피드백(불편사항 제보) 테이블
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.
-- (supabase-schema.sql을 이미 실행한 뒤에 추가로 실행하는 용도입니다.)

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  message text not null,
  page_url text not null default '',
  status text not null default 'open',
  created_at timestamptz not null default now()
);

-- 누구나(anon) 제보를 남길 수 있고(insert) 읽을 수 있지만(select, 점검용),
-- 수정/삭제는 막아서 제보 내용이 임의로 바뀌거나 지워지지 않게 합니다.
-- 완료 처리(status 변경)나 삭제는 Supabase 대시보드의 Table Editor에서 직접 하세요.
alter table feedback enable row level security;

drop policy if exists "feedback anon insert" on feedback;
create policy "feedback anon insert" on feedback
  for insert with check (true);

drop policy if exists "feedback anon select" on feedback;
create policy "feedback anon select" on feedback
  for select using (true);
