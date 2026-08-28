-- 프로젝트 추진일정 앱 — 세부업무(체크리스트 하위 항목) 필드 추가
alter table tasks add column if not exists subtasks text not null default '';
