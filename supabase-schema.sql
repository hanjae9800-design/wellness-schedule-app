-- 프로젝트 추진일정 앱 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.

create extension if not exists "pgcrypto";

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org text not null default '',
  dept text not null default '',
  name text not null default '',
  start_date date,
  end_date date,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  phase_name text not null default '',
  phase_color text not null default '#2563eb',
  name text not null default '',
  owner text not null default '',
  start_date date,
  end_date date,
  dependency text not null default '',
  note text not null default '',
  status text not null default 'todo',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 팀 공용 비밀번호로만 접근을 제한하고(클라이언트 화면단 게이트),
-- 실제 DB 권한은 anon 키로 전체 열람/수정 가능하게 열어둡니다.
-- (개인정보나 민감정보를 담지 않는 내부 일정 공유용 앱이라는 전제)
alter table projects enable row level security;
alter table tasks enable row level security;

drop policy if exists "projects anon all" on projects;
create policy "projects anon all" on projects
  for all using (true) with check (true);

drop policy if exists "tasks anon all" on tasks;
create policy "tasks anon all" on tasks
  for all using (true) with check (true);

-- 실시간 동기화(다른 사람이 수정하면 내 화면에도 바로 반영)를 위해 Realtime publication에 추가
alter publication supabase_realtime add table projects;
alter publication supabase_realtime add table tasks;
