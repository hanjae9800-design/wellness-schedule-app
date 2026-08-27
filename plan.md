# 메모→할일 AI 변환 기능을 Gemini → Cloudflare Workers AI로 전환

## 요청 내용
- 현재 "업무 체크리스트"의 메모→할일 자동 변환 기능([functions/api/parse-note.js](functions/api/parse-note.js))이 Google Gemini API를 쓰고 있는데, 무료 한도가 너무 적음.
- Cloudflare Workers AI(Pages Functions에 내장된 `env.AI` 바인딩, Cloudflare 자체 인프라에서 오픈소스 모델 실행)로 교체.

## 현재 상태
- `parse-note.js`가 `fetch("https://generativelanguage.googleapis.com/...")`로 Gemini를 호출, `env.GEMINI_API_KEY`(Cloudflare Pages 환경변수)를 서버에서만 사용.
- `responseMimeType: "application/json"` 옵션으로 Gemini가 JSON만 반환하도록 강제하고 있음.
- 이 프로젝트는 `wrangler.toml` 없이 `wrangler pages deploy .`로 배포하는 Direct Upload 방식 (Git 연동 아님).

## 변경 계획

### 1. Cloudflare AI 바인딩 추가
- 프로젝트 루트에 `wrangler.toml` 신규 생성:
  ```toml
  pages_build_output_dir = "."
  [ai]
  binding = "AI"
  ```
- (참고: wrangler.toml이 생기면 이후 배포 명령이 `wrangler pages deploy .`로 그대로 동작하되, 이 설정 파일의 바인딩을 인식함. 별도로 Cloudflare 대시보드에서 켤 필요는 없어짐.)

### 2. `parse-note.js` 로직 교체
- Gemini `fetch` 호출부를 `await env.AI.run(model, {...})` 호출로 교체.
- 모델 후보 (한재님 선택 필요, 아래 "확인 필요" 참고):
  - `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — 크고 성능 좋음, function calling 지원
  - `@cf/zhipu-ai/glm-4.7-flash` (가칭, 정확한 id는 구현 시 재확인) — 100개 이상 언어 멀티링구얼 특화, 더 빠르고 저렴
- 프롬프트(`buildPrompt`)는 그대로 재사용 — 지시문 자체는 모델에 안 묶여 있음.
- JSON 모드/응답 파싱: Gemini의 `responseMimeType: json`처럼 강제 JSON 응답이 안 될 수 있어서, 응답에서 코드펜스(````json ... ````) 제거 등 방어적 파싱 로직 추가.
- 에러 메시지 문구("AI 분석 요청이 실패했습니다" 등)는 그대로 유지.
- `GEMINI_API_KEY` 관련 코드/문구는 제거 (Cloudflare Pages 환경변수에 등록된 `GEMINI_API_KEY` 자체는 한재님이 나중에 대시보드에서 지우셔도 되고 안 지우셔도 무방 — 코드에서 더는 안 씀).

### 3. 배포/검증
- `wrangler pages deploy .` (AI 바인딩 포함해서 재배포 — Direct Upload에 wrangler.toml이 있으면 자동 인식됨)
- Playwright로 실제 메모 입력 → 할일 자동 추가까지 end-to-end 테스트 (안전한 테스트 프로젝트로).

## 완료 — 실제 구현 결과 (한재님 지시로 제가 모델 선택 후 진행)
- 처음엔 `@cf/zai-org/glm-4.7-flash`(다국어 특화)로 구현했으나, 실제 호출해보니 응답에 모델의 "생각하는 과정"(reasoning)이 통째로 포함되어 **응답 시간이 30~50초**나 걸림 — 실사용에 부적합해서 폐기.
- 최종적으로 **`@cf/meta/llama-3.1-8b-instruct-fast`**(추론 없이 바로 답하는 경량 모델)로 교체 — 실측 응답 시간 **약 1.6초**, 한국어 할일 추출도 정상 동작 확인.
- curl로 직접 `/api/parse-note` 호출해서 실제 한국어 메모("내일까지 세탁소 맡기기", "다음주 금요일 보고서 초안 작성", "우유 사기")로 검증 완료 — 3개 항목 모두 정상 추출.
- 참고로 알게 된 사소한 이슈: 상대 날짜("다음주 금요일" 등) 계산이 모델마다 요일 계산을 가끔 틀림 (LLM의 흔한 약점) — Gemini 버전에서도 비슷한 문제가 있었을 가능성이 있고, 이번 작업 범위는 아니라 손대지 않음. 나중에 필요하면 프롬프트에 요일까지 명시하는 방식으로 개선 가능.
- 배포 완료 (`wrangler pages deploy .`), 실제 프로덕션 도메인에서 검증함.

---

# 후속 작업 — Gemini + Workers AI 같이 쓰기 (Gemini 기본 + Workers AI 폴백)

## 요청 내용
- 한재님 결정: **Gemini를 기본으로 쓰고, Gemini가 실패(한도 초과 등)할 때만 Workers AI로 자동 전환**.
- 이유: Gemini 품질을 우선하되, 한도 초과로 완전히 막히는 상황은 Workers AI로 보완해서 막지 않음.

## 변경 계획
1. `parse-note.js`에 Gemini 호출 로직을 다시 추가 (지난 작업에서 지웠던 것을 복원 — `GEMINI_MODEL`, `env.GEMINI_API_KEY` fetch 호출부).
2. 순서: **① Gemini 먼저 시도** → 성공(200 + 정상 JSON 파싱)하면 그 결과 바로 반환.
3. Gemini 쪽에서 다음 중 하나라도 발생하면 **② Workers AI(`llama-3.1-8b-instruct-fast`)로 자동 폴백**:
   - `GEMINI_API_KEY`가 애초에 설정 안 돼있음
   - Gemini fetch 자체가 실패(네트워크 오류)
   - Gemini가 non-2xx 응답(한도 초과 429 포함)
   - Gemini 응답을 JSON으로 파싱 실패
4. 최종적으로 둘 다 실패하면 그때 에러 반환.
5. 응답에 어느 쪽이 답했는지 표시(`X-Debug: 1` 헤더 줄 때만 `debug.provider: "gemini" | "workers-ai"`로 노출 — 평소엔 안 보임, 기존 방식과 동일).
6. `wrangler.toml`의 `[ai]` 바인딩은 이미 있으니 그대로 유지.

## 확인이 필요한 부분
- Gemini `GEMINI_API_KEY` 환경변수가 Cloudflare Pages에 여전히 설정되어 있어야 이 기능이 동작합니다 — 혹시 이미 지우셨다면 알려주세요 (안 지우셨다면 별도 조치 불필요).
- (한재님 코멘트 남겨주세요)

## 완료 — 실제 구현 결과
- `GEMINI_API_KEY`가 여전히 설정되어 있어서 Gemini 경로가 정상 동작함을 확인.
- 정상 케이스: `provider: "gemini"`로 응답, 한국어 메모 3개 항목 모두 정상 추출.
- 폴백 케이스: Gemini 모델명을 일부러 깨뜨려서 강제로 실패시킨 뒤 재배포 → `provider: "workers-ai"`로 자동 전환되고 `debug.geminiError`에 Gemini 쪽 에러(400 INVALID_ARGUMENT)가 정확히 기록됨을 확인. 이후 원래 모델명으로 되돌려 재배포하고 Gemini 경로가 다시 정상 동작하는 것까지 재확인.
- 배포 완료, 두 경로 모두 실제 프로덕션 도메인에서 검증함.
