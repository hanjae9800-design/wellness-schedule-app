// POST /api/parse-note
// body: { note: "..." } (JSON)
// Cloudflare Workers AI(env.AI 바인딩)로 실행 — 별도 API 키 불필요, Cloudflare 계정 자체 무료 한도 사용.
// glm-4.7-flash(추론형)로 먼저 시도했으나 응답에 "생각하는 과정"이 포함되어 30~50초씩 걸려서
// 실사용에 부적합 — 추론 없이 바로 답하는 경량 모델로 교체 (실측 약 1.6초).
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const MAX_NOTE_CHARS = 8000;

function buildPrompt(todayStr) {
  return `아래는 사용자가 개인적으로 쓴 할 일 메모입니다. 이 메모에 나온 할 일을 하나도 빠짐없이 전부 뽑아주세요. "우유 사기", "세탁소 맡기기"처럼 아무리 사소하고 간단해 보이는 항목이라도 전부 포함해야 합니다 — 중요하거나 거창한 것만 고르지 마세요.

각 할 일마다 다음 정보를 채워주세요:
- phase_name: 이 할 일이 속한 구분/카테고리 이름 (메모에 명시된 대분류가 있으면 그걸 쓰고, 없으면 "할 일"로 두세요)
- name: 할 일 내용 (메모 표현을 다듬어 간결한 한 줄로)
- start_date, end_date: "YYYY-MM-DD" 형식. 오늘 날짜는 ${todayStr}입니다. 메모에 "내일", "이번주 금요일"처럼 상대적인 날짜 표현이 있으면 오늘 날짜를 기준으로 계산해서 채우고, 날짜 정보가 전혀 없으면 빈 문자열("")로 두세요.

메모에 나온 순서를 최대한 존중해서 나열해주세요.

다음과 같은 정확한 JSON 형식으로만 답하세요 (다른 텍스트 없이 이 형식 그대로):
{"tasks":[{"phase_name":"할 일","name":"우유 사기","start_date":"","end_date":""}]}

찾은 할 일이 하나도 없더라도 반드시 위 형식을 따르되 tasks 배열만 비워주세요: {"tasks":[]}

중요: 각 JSON 필드 값에는 오직 그 값 자체만 넣으세요. 추론 과정, 확인 문구, 대안 검토, 주석 같은 것을 필드 값 안에 절대 섞지 마세요. 예를 들어 start_date 필드에는 "2026-01-05" 처럼 날짜만 들어가야 하고, "2026-01-05 (확인 필요)" 같은 식으로 다른 텍스트를 덧붙이면 안 됩니다.`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.AI) {
    return json({ error: "서버에 Workers AI 바인딩(AI)이 설정되어 있지 않습니다." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const note = ((body && body.note) || "").trim();
  if (!note) {
    return json({ error: "메모 내용이 없습니다." }, 400);
  }
  if (note.length > MAX_NOTE_CHARS) {
    return json({ error: `메모가 너무 깁니다 (${MAX_NOTE_CHARS}자 이하만 가능).` }, 400);
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const messages = [
    { role: "system", content: buildPrompt(todayStr) },
    { role: "user", content: "--- 메모 내용 ---\n" + note }
  ];

  let aiRes;
  try {
    aiRes = await env.AI.run(AI_MODEL, { messages });
  } catch (e) {
    return json({ error: "AI 분석 요청이 실패했습니다.", detail: String(e && e.message || e).slice(0, 500) }, 502);
  }

  // 모델/버전에 따라 응답 형태가 다를 수 있어(OpenAI 호환 chat completion 형식이 기본이지만
  // 예전 Workers AI 형식과도 호환되게) 여러 경로를 시도해서 텍스트를 뽑는다.
  const rawText =
    (aiRes && aiRes.choices && aiRes.choices[0] && aiRes.choices[0].message && aiRes.choices[0].message.content) ||
    (aiRes && aiRes.response) ||
    (typeof aiRes === "string" ? aiRes : "");
  if (!rawText) {
    return json({ error: "AI 응답을 읽을 수 없습니다." }, 502);
  }

  // 모델이 JSON 앞뒤로 ```json 코드펜스나 설명을 덧붙이는 경우를 방어적으로 처리.
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (e) {
    return json({ error: "AI 응답이 올바른 형식이 아닙니다.", detail: rawText.slice(0, 500) }, 502);
  }

  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  // 문제 발생 시 원인 파악용 — 요청 헤더에 X-Debug: 1을 줄 때만 원문 응답을 함께 내려줌 (평소엔 응답에 안 실림).
  const debug = request.headers.get("X-Debug") === "1" ? { rawText: rawText.slice(0, 2000) } : undefined;
  return json({ tasks, debug });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}
