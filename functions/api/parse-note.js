// POST /api/parse-note
// body: { note: "..." } (JSON)
// Gemini API 키는 여기(서버)에서만 쓰고 브라우저에는 절대 내려주지 않습니다.
const GEMINI_MODEL = "gemini-3.6-flash";
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
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다." }, 500);
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
  const parts = [{ text: buildPrompt(todayStr) }, { text: "\n\n--- 메모 내용 ---\n" + note }];

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }
    );
  } catch (e) {
    return json({ error: "AI 서버에 연결할 수 없습니다." }, 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => "");
    return json({ error: "AI 분석 요청이 실패했습니다.", detail: errText.slice(0, 500) }, 502);
  }

  const data = await geminiRes.json();
  const candidateParts = (data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts) || [];
  // 최신 Gemini 모델은 "생각하는 과정"(thought: true)과 최종 답변을 parts 배열에 나눠서 보내므로,
  // thought가 아닌 실제 답변 조각을 찾아서 써야 함.
  const answerPart = candidateParts.find(p => !p.thought && typeof p.text === "string");
  const rawText = answerPart && answerPart.text;
  if (!rawText) {
    return json({ error: "AI 응답을 읽을 수 없습니다." }, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return json({ error: "AI 응답이 올바른 형식이 아닙니다." }, 502);
  }

  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  return json({ tasks });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}
