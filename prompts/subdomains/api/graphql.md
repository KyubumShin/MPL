# Subdomain: API/GraphQL (GraphQL API 개발)

## 핵심 원칙
- Schema-first 설계: SDL로 타입과 계약을 먼저 정의한 후 resolver 구현
- N+1 문제는 DataLoader로 반드시 해결 — 리스트 resolver에서 직접 DB 쿼리 금지
- Input 타입으로 뮤테이션 인수를 묶어 재사용성과 validation 일관성 확보
- Subscription은 실제 실시간 요구사항에서만 사용 — polling 또는 ISR로 충분한 경우 지양

## 주의 사항
- Nullable 필드 설계 신중히 — `!` 남용 시 스키마 진화(evolution) 유연성 저하
- fragment 없이 중복 필드 선택 반복 금지 — 클라이언트 쿼리 유지보수성 저하
- resolver에서 비즈니스 로직 직접 구현 금지 — service/domain 레이어로 위임
- 인증/인가는 resolver 개별 처리 대신 directive 또는 shield 미들웨어로 중앙화

## 검증 포인트
- DataLoader가 동일 요청 내 배치로 묶어 단일 DB 쿼리를 발생시키는가?
- 에러 응답이 `errors` 배열 표준 형식을 따르고 민감 정보를 노출하지 않는가?
- 중첩 resolver의 최대 깊이와 complexity 제한이 설정되어 있는가?
- 스키마 변경이 기존 쿼리와 하위 호환성을 유지하는가?
