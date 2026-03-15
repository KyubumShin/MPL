# Subdomain: AI/Vercel-AI (Vercel AI SDK 사용)

## 핵심 원칙
- `useChat`/`useCompletion` hooks를 클라이언트에서 사용하고, 서버 로직은 Route Handler 또는 Server Action으로 분리
- `streamText`/`generateText`의 provider 추상화 활용 — 모델 교체 시 코드 변경 최소화
- Tool calling은 Zod 스키마로 파라미터를 정의해 타입 안전성 보장
- RSC(React Server Components) 스트리밍은 `ai/rsc`의 `createStreamableUI`로 점진적 렌더링

## 주의 사항
- `useChat`의 `onFinish`/`onError` 핸들러 누락 시 에러 상태 사용자에게 미노출
- 스트리밍 응답의 중단(abort) 처리: `stop()` 함수 제공과 서버 측 `AbortSignal` 처리 모두 필요
- Tool 결과를 LLM에게 다시 전달하는 multi-turn tool calling 흐름에서 상태 관리 복잡도 주의
- 모델별 context window 제한 초과 시 자동 트런케이션이 없으므로 메시지 길이 관리 필요

## 검증 포인트
- 스트리밍 중 연결 끊김 시 클라이언트가 적절한 에러 메시지를 표시하는가?
- Tool calling 흐름에서 LLM이 tool 결과를 수신하고 최종 응답을 생성하는가?
- 다양한 provider(Anthropic, OpenAI, Gemini)로 전환해도 동일하게 동작하는가?
- RSC 스트리밍에서 서버 컴포넌트 에러가 `ErrorBoundary`로 포착되는가?
