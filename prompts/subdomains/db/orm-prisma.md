# Subdomain: DB/ORM-Prisma (Prisma ORM 사용)

## 핵심 원칙
- 관계 로딩은 `include`(전체 관계)와 `select`(필요한 필드만)를 명확히 구분
- 마이그레이션은 `prisma migrate dev`로 개발, `prisma migrate deploy`로 프로덕션 적용
- Prisma middleware로 소프트 삭제, 감사 로그, 타임스탬프 자동화 등 공통 로직 처리
- Connection pool 크기는 서버리스/컨테이너 환경에 맞게 `connection_limit` 명시 설정

## 주의 사항
- N+1 쿼리: 루프 내 `findUnique` 호출 대신 `findMany` + `where: { id: { in: ids } }` 활용
- `raw` 쿼리 사용 시 파라미터 바인딩 필수 — 문자열 보간(interpolation) SQL injection 위험
- `prisma generate` 누락 시 타입이 스키마와 불일치 — CI에서 자동 실행 설정
- 대량 데이터 처리는 `createMany`/`updateMany` 활용 — 개별 레코드 루프 처리 금지

## 검증 포인트
- `schema.prisma`의 관계 정의가 실제 DB 외래 키 제약과 일치하는가?
- 필요한 필드만 `select`로 가져와 과도한 데이터 전송을 방지하는가?
- 마이그레이션 파일이 커밋되어 있고 프로덕션 적용 이력과 동기화되는가?
- 서버리스 환경에서 connection pool 고갈 없이 동시 요청을 처리하는가?
