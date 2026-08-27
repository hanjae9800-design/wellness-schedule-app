// POST /api/parse-note
// body: { note: "..." } (JSON)
// Gemini를 기본으로 쓰고, 실패(한도 초과 등)하면 Cloudflare Workers AI로 자동 폴백한다.
// - Gemini: env.GEMINI_API_KEY 필요, 품질 우선.
// - Workers AI: env.AI 바인딩(wrangler.toml), 별도 키 불필요, Gemini가 막혔을 때의 보완용.
//   (glm-4.7-flash(추론형)는 응답에 "생각하는 과정"이 섞여 30~50초씩 걸려서 폐기하고,
//    추론 없이 바로 답하는 경량 모델로 교체했음 — 실측 약 1.6초)
const GEMINI_MODEL = "gemini-3.6-flash";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
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

// Gemini 호출 — 실패하면 예외를 던짐 (호출부에서 잡아서 Workers AI로 폴백).
async function callGemini(env, todayStr, note) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const parts = [{ text: buildPrompt(todayStr) }, { text: "\n\n--- 메모 내용 ---\n" + note }];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json" }
      })
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidateParts = (data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts) || [];
  // 최신 Gemini 모델은 "생각하는 과정"(thought: true)과 최종 답변을 parts 배열에 나눠서 보내므로,
  // thought가 아닌 실제 답변 조각을 찾아서 써야 함.
  const answerPart = candidateParts.find(p => !p.thought && typeof p.text === "string");
  const rawText = answerPart && answerPart.text;
  if (!rawText) throw new Error("Gemini response has no text");
  return rawText;
}

// Workers AI 호출 — 실패하면 예외를 던짐.
async function callWorkersAI(env, todayStr, note) {
  if (!env.AI) throw new Error("AI binding not set");

  const messages = [
    { role: "system", content: buildPrompt(todayStr) },
    { role: "user", content: "--- 메모 내용 ---\n" + note }
  ];
  const aiRes = await env.AI.run(WORKERS_AI_MODEL, { messages });

  // 모델/버전에 따라 응답 형태가 다를 수 있어(OpenAI 호환 chat completion 형식이 기본이지만
  // 예전 Workers AI 형식과도 호환되게) 여러 경로를 시도해서 텍스트를 뽑는다.
  const rawText =
    (aiRes && aiRes.choices && aiRes.choices[0] && aiRes.choices[0].message && aiRes.choices[0].message.content) ||
    (aiRes && aiRes.response) ||
    (typeof aiRes === "string" ? aiRes : "");
  if (!rawText) throw new Error("Workers AI response has no text");
  return rawText;
}

// 모델이 JSON 앞뒤로 ```json 코드펜스나 설명을 덧붙이는 경우를 방어적으로 처리해서 파싱.
function parseTasksFromText(rawText) {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
  const parsed = JSON.parse(jsonSlice); // 실패 시 예외 — 호출부에서 처리
  return Array.isArray(parsed.tasks) ? parsed.tasks : [];
}

export async function onRequestPost(context) {
  const { request, env } = context;

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
  const isDebug = request.headers.get("X-Debug") === "1";

  // ① Gemini 먼저 시도
  let tasks, provider, rawText, geminiError;
  try {
    rawText = await callGemini(env, todayStr, note);
    tasks = parseTasksFromText(rawText);
    provider = "gemini";
  } catch (e) {
    geminiError = String(e && e.message || e);
  }

  // ② Gemini가 실패했으면 Workers AI로 폴백
  if (provider !== "gemini") {
    try {
      rawText = await callWorkersAI(env, todayStr, note);
      tasks = parseTasksFromText(rawText);
      provider = "workers-ai";
    } catch (e) {
      return json({
        error: "AI 분석 요청이 실패했습니다.",
        detail: `gemini: ${geminiError} / workers-ai: ${String(e && e.message || e)}`.slice(0, 500)
      }, 502);
    }
  }

  const debug = isDebug ? { provider, geminiError, rawText: (rawText || "").slice(0, 2000) } : undefined;
  return json({ tasks, debug });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}
