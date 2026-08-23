-- 프로젝트 추진일정 앱 — 프로젝트 상태(예정/진행중/완료) 필드 추가
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 Run 하세요.

alter table projects add column if not exists status text not null default 'todo';

alter table projects drop constraint if exists projects_status_check;
alter table projects add constraint projects_status_check check (status in ('todo', 'doing', 'done'));

-- 참고: "지연" 상태는 별도로 저장하지 않습니다.
-- 상태가 '예정'인데 업무 중 가장 빠른 시작일이 오늘보다 지난 경우, 화면에서 자동으로 "지연"으로 표시됩니다.
-- '진행중'/'완료'는 프로젝트 상세 페이지에서 직접 선택해서 지정합니다.
