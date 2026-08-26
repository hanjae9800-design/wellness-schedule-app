// POST /api/import-schedule
// multipart/form-data: file (txt/md/pdf)
// Gemini API 키는 여기(서버)에서만 쓰고 브라우저에는 절대 내려주지 않습니다.
const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const PROMPT = `첨부된 문서는 프로젝트 추진 계획/일정 관련 자료입니다. 이 문서를 분석해서, 프로젝트를 구성하는 업무(task) 목록을 뽑아주세요.

각 업무마다 다음 정보를 채워주세요:
- phase_name: 이 업무가 속한 구분/카테고리/단계 이름 (문서에 명시된 대분류가 있으면 그걸 쓰고, 없으면 문맥상 자연스러운 단계 이름을 만들어주세요. 예: "기획", "섭외", "홍보")
- name: 업무명 (구체적인 작업 단위로, 너무 크지도 작지도 않게)
- start_date, end_date: "YYYY-MM-DD" 형식. 문서에 정확한 날짜가 없고 "O월"처럼 월만 있으면 그 달의 1일/말일로, 아예 일정 정보가 없으면 빈 문자열("")로 두세요.
- owner: 담당자 이름. 문서에 없으면 빈 문자열("")

문서에 나온 순서를 최대한 존중해서 나열해주세요.

다음과 같은 정확한 JSON 형식으로만 답하세요 (다른 텍스트 없이 이 형식 그대로):
{"tasks":[{"phase_name":"기획","name":"사업 계획서 작성","start_date":"2026-01-05","end_date":"2026-01-20","owner":"김담당"}]}

찾은 업무가 하나도 없더라도 반드시 위 형식을 따르되 tasks 배열만 비워주세요: {"tasks":[]}

중요: 각 JSON 필드 값에는 오직 그 값 자체만 넣으세요. 추론 과정, 확인 문구, 대안 검토, 주석 같은 것을 필드 값 안에 절대 섞지 마세요. 예를 들어 start_date 필드에는 "2026-01-05" 처럼 날짜만 들어가야 하고, "2026-01-05 (확인 필요)" 같은 식으로 다른 텍스트를 덧붙이면 안 됩니다.`;

export async function onRequestPost(context) {
  const { request, env } = context;
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다." }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "파일이 없습니다." }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ error: "파일이 너무 큽니다 (15MB 이하만 가능)." }, 400);
  }

  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  const isText = /\.(txt|md|markdown)$/i.test(file.name) || file.type.startsWith("text/");
  if (!isPdf && !isText) {
    return json({ error: "지원하지 않는 파일 형식입니다 (txt, md, pdf만 가능)." }, 400);
  }

  const buf = await file.arrayBuffer();
  const parts = [{ text: PROMPT }];
  if (isPdf) {
    parts.push({ inline_data: { mime_type: "application/pdf", data: arrayBufferToBase64(buf) } });
  } else {
    const text = new TextDecoder("utf-8").decode(buf);
    parts.push({ text: "\n\n--- 문서 내용 ---\n" + text.slice(0, 100000) });
  }

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

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}
