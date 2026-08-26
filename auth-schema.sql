-- 프로젝트 추진일정 앱 — 업무 체크리스트 구글 로그인 (본인만 접근)
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.
--
-- 이걸 실행하기 전에 먼저 Authentication > Providers 에서 Google을 켜고
-- Client ID / Client Secret을 등록해두어야 합니다.

alter table projects add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

-- 계정당 체크리스트 1개 제한 (프로젝트 추진일정은 영향 없음)
drop index if exists one_checklist_per_owner;
create unique index one_checklist_per_owner on projects (owner_user_id) where type = 'checklist' and owner_user_id is not null;

-- 프로젝트 추진일정(timeline)은 지금처럼 전체 공개, 업무 체크리스트(checklist)는 본인 소유만 열람/수정
drop policy if exists "projects anon all" on projects;

drop policy if exists "projects timeline open" on projects;
create policy "projects timeline open" on projects
  for all using (type = 'timeline') with check (type = 'timeline');

drop policy if exists "projects checklist owner only" on projects;
create policy "projects checklist owner only" on projects
  for all using (type = 'checklist' and owner_user_id = auth.uid())
  with check (type = 'checklist' and owner_user_id = auth.uid());

-- tasks 테이블도 소속 프로젝트 기준으로 동일하게 분리
drop policy if exists "tasks anon all" on tasks;

drop policy if exists "tasks timeline open" on tasks;
create policy "tasks timeline open" on tasks
  for all using (exists (select 1 from projects p where p.id = tasks.project_id and p.type = 'timeline'))
  with check (exists (select 1 from projects p where p.id = tasks.project_id and p.type = 'timeline'));

drop policy if exists "tasks checklist owner only" on tasks;
create policy "tasks checklist owner only" on tasks
  for all using (exists (select 1 from projects p where p.id = tasks.project_id and p.type = 'checklist' and p.owner_user_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = tasks.project_id and p.type = 'checklist' and p.owner_user_id = auth.uid()));
