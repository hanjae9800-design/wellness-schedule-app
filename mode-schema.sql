-- 프로젝트 추진일정 앱 — 프로젝트별 보기 전용 / 편집 모드 기능
-- Supabase 대시보드 > SQL Editor > New query 에 이 파일 전체를 붙여넣고 Run 하세요.

alter table projects add column if not exists mode text not null default 'view';

alter table projects drop constraint if exists projects_mode_check;
alter table projects add constraint projects_mode_check check (mode in ('view', 'edit'));

-- 기존에 있던 프로젝트(웰니스관광 등)도 기본값인 '보기 전용'으로 설정됩니다.
-- 앱의 프로젝트 상세 페이지에서 "편집 모드로 전환" 버튼으로 언제든 바꿀 수 있습니다.
