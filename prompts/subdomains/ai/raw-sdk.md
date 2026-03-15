# Subdomain: AI/Raw-SDK (Anthropic/OpenAI SDK 직접 사용)

## 핵심 원칙
- Messages API 구조(`role`, `content`, `tool_use`, `tool_result`)를 정확히 이해하고 구성
- Streaming 응답은 이벤트 타입(`content_block_delta`, `message_stop` 등)을 파싱해 처리
- Tool use 흐름: assistant의 `tool_use` 블록 → `tool_result`를 포함한 user 메시지 → 재호출
- 토큰 수 추정은 tiktoken 또는 SDK의 `countTokens`를 활용해 context window 초과 방지

## 주의 사항
- API 키는 환경 변수로 관리 — 코드에 하드코딩 금지, 클라이언트 번들에 포함 금지
- Rate limit(429) 및 서버 에러(5xx)에 대한 지수 백오프 재시도 로직 필수
- `stop_reason: "max_tokens"`로 응답이 잘린 경우 불완전한 JSON/코드 처리 방지
- Batch API 사용 시 요청 ID와 결과 매핑 및 부분 실패 처리 필요

## 검증 포인트
- Tool use가 포함된 multi-turn 대화에서 메시지 배열 구조가 올바르게 유지되는가?
- 스트리밍 중단(connection error, timeout) 시 부분 응답을 안전하게 처리하는가?
- 토큰 카운팅이 context window 한도의 80% 초과 시 컨텍스트 압축 또는 요약이 실행되는가?
- API 응답의 `usage` 필드를 기록해 비용 모니터링이 가능한가?
