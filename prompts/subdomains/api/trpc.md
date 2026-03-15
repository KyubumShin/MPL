# Subdomain: API/tRPC (tRPC 타입 안전 API)

## 핵심 원칙
- Router를 도메인 단위로 분리하고 `mergeRouters`로 루트 라우터에 조합
- Context는 인증 정보, DB 클라이언트, 세션 등 요청 범위 의존성만 포함
- Middleware chain으로 인증/로깅/rate-limit 등 공통 관심사를 procedure에서 분리
- 클라이언트 타입 추론은 `RouterOutputs`/`RouterInputs` 유틸리티로 추출해 공유

## 주의 사항
- `publicProcedure`와 `protectedProcedure` 혼용 시 보호가 필요한 endpoint에 실수 없도록 lint 규칙 적용
- Input validation은 Zod 스키마로 필수화 — 런타임 검증 누락은 타입 안전성 보장 불가
- Subscription은 `observable`을 반환해야 하며 구독 해제(unsubscribe) 처리 필수
- `inferAsyncReturnType`은 컨텍스트 타입 추론에만 사용 — 과도한 타입 조작 지양

## 검증 포인트
- 클라이언트에서 procedure 호출 시 타입 오류 없이 자동 완성이 동작하는가?
- 미들웨어 에러가 `TRPCError`로 적절한 코드와 함께 반환되는가?
- Input Zod 스키마가 실제 비즈니스 제약(최대 길이, 허용 값 범위 등)을 반영하는가?
- 인증이 필요한 모든 procedure가 `protectedProcedure`를 기반으로 하는가?
