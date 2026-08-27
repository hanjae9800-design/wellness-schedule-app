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

## 확인이 필요한 부분
- **모델 선택**: 한국어 품질 우선(`llama-3.3-70b-instruct-fp8-fast`, 크고 느림) vs 속도/비용 우선(`glm-4.7-flash`, 빠르고 저렴) — 구현 전에 실제 호출로 한국어 메모 몇 개 테스트해보고 한재님과 같이 고를지, 제가 먼저 골라서 구현할지?
- **정확한 API 파라미터 형식**: Workers AI 모델마다 `messages` 배열 형식, JSON 모드 지원 여부가 조금씩 다릅니다 — 이건 실제 호출 테스트로 확인 후 구현하겠습니다 (추측으로 짜지 않음).
- **무료 한도**: Workers AI 무료 티어는 일일 뉴런(Neurons) 단위 한도가 있습니다 (Gemini보다 넉넉하지만 무제한은 아님) — 참고만 해주세요.
- (한재님 코멘트 남겨주세요)
