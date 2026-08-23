// /admin/* 경로를 서버 쪽에서 HTTP Basic 인증으로 보호합니다.
// 비밀번호는 Cloudflare Pages 환경변수(시크릿)로 저장되어 클라이언트 코드에는 절대 노출되지 않습니다.
export async function onRequest(context) {
  const { request, env, next } = context;
  const expected = env.ADMIN_PASSWORD;

  if (!expected) {
    return new Response("관리자 비밀번호가 서버에 설정되어 있지 않습니다.", { status: 500 });
  }

  const auth = request.headers.get("Authorization") || "";
  const [scheme, encoded] = auth.split(" ");

  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try { decoded = atob(encoded); } catch (e) { decoded = ""; }
    const sepIndex = decoded.indexOf(":");
    const password = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : "";
    if (password === expected) {
      return next();
    }
  }

  return new Response("인증이 필요합니다.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="관리자 페이지"' }
  });
}
