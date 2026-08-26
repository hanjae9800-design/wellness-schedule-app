// POST /api/import-schedule
// multipart/form-data: file (txt/md/pdf)
// Gemini API 키는 여기(서버)에서만 쓰고 브라우저에는 절대 내려주지 않습니다.
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase_name: { type: "string" },
          name: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string" },
          owner: { type: "string" }
        },
        required: ["phase_name", "name"]
      }
    }
  },
  required: ["tasks"]
};

const PROMPT = `첨부된 문서는 프로젝트 추진 계획/일정 관련 자료입니다. 이 문서를 분석해서, 프로젝트를 구성하는 업무(task) 목록을 뽑아주세요.

각 업무마다 다음 정보를 채워주세요:
- phase_name: 이 업무가 속한 구분/카테고리/단계 이름 (문서에 명시된 대분류가 있으면 그걸 쓰고, 없으면 문맥상 자연스러운 단계 이름을 만들어주세요. 예: "기획", "섭외", "홍보")
- name: 업무명 (구체적인 작업 단위로, 너무 크지도 작지도 않게)
- start_date, end_date: "YYYY-MM-DD" 형식. 문서에 정확한 날짜가 없고 "O월"처럼 월만 있으면 그 달의 1일/말일로, 아예 일정 정보가 없으면 빈 문자열("")로 두세요.
- owner: 담당자 이름. 문서에 없으면 빈 문자열("")

문서에 나온 순서를 최대한 존중해서 나열해주세요.`;

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
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA
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
  const rawText = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
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
