-- 사이드바 위젯(주간 목표 / 체크할 일)을 위한 새 테이블.
-- tasks/projects와 동일한 방식: 로그인 없이 프로젝트 링크를 가진 사람 누구나 실시간으로 함께 편집.
-- Supabase 대시보드 > SQL Editor에서 이 파일 전체를 실행해주세요. (supabase-schema.sql과 같은 방식)

create table if not exists weekly_goals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null default '',
  pct int not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists check_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null default '',
  done boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table weekly_goals enable row level security;
alter table check_items enable row level security;

drop policy if exists "weekly_goals anon all" on weekly_goals;
create policy "weekly_goals anon all" on weekly_goals
  for all using (true) with check (true);

drop policy if exists "check_items anon all" on check_items;
create policy "check_items anon all" on check_items
  for all using (true) with check (true);

-- 실시간 동기화를 위해 Realtime publication에 추가
alter publication supabase_realtime add table weekly_goals;
alter publication supabase_realtime add table check_items;
