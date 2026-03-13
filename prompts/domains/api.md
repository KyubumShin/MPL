# Domain: API (엔드포인트/라우팅)

## 핵심 원칙
- RESTful 규칙 준수 (적절한 HTTP 메서드, 상태 코드)
- 에러 응답은 일관된 형식 (status, message, details)
- 인증/인가 미들웨어는 라우트 정의에서 명시적으로
- 요청 검증은 핸들러 진입 시 즉시 수행

## 주의 사항
- Breaking change 여부 확인 (기존 클라이언트 호환성)
- Rate limiting, CORS 설정 누락 주의
- 대용량 응답은 pagination 필수
- 민감 데이터는 응답에서 제외 (password, token 등)

## 검증 포인트
- 모든 엔드포인트가 적절한 HTTP 상태 코드를 반환하는가?
- 에러 케이스(400, 401, 403, 404, 409, 500)가 처리되는가?
- 요청 body/query 검증이 있는가?
- OpenAPI/Swagger 문서와 일치하는가?
