// Supabase anon key는 공개되어도 안전하도록 설계된 키입니다 (실제 접근 제어는 RLS 정책이 담당).
// 비밀번호 게이트 없이, 링크를 아는 사람은 누구나 바로 편집할 수 있습니다.
window.APP_CONFIG = {
  SUPABASE_URL: "https://efitdkbtzdbscweehdma.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmaXRka2J0emRic2N3ZWVoZG1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDQxMjAsImV4cCI6MjEwMjk4MDEyMH0.S_1_WoQFsmV6UGeAnTGwoAUZVkyB6gXjz3xtuhdaO6Y"
};
// 관리자 비밀번호는 더 이상 여기(클라이언트 코드)에 두지 않습니다.
// Cloudflare Pages 환경변수(시크릿) ADMIN_PASSWORD로 서버 쪽(functions/admin/_middleware.js)에서만 검증합니다.
