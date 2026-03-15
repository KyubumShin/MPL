# Subdomain: DB/ORM-Drizzle (Drizzle ORM 사용)

## 핵심 원칙
- 스키마는 `pgTable`/`sqliteTable`/`mysqlTable` 함수로 정의하고 별도 파일로 관리
- `drizzle-kit`의 `push` 명령은 개발용, `generate` + `migrate`는 프로덕션 마이그레이션 워크플로
- Prepared statements로 반복 실행 쿼리의 파싱 오버헤드 제거 — `db.select().prepare()`
- Relation query(`with`)는 Drizzle의 타입 안전 JOIN 추상화 — `sql` 태그와 혼용 최소화

## 주의 사항
- `drizzle-orm/pg-core`와 `drizzle-orm/sqlite-core` 등 어댑터를 혼용하면 타입 불일치 발생
- `schema.ts` 변경 후 `drizzle-kit generate` 실행을 CI에서 강제 — 스키마 드리프트 방지
- `sql` 태그 raw 쿼리 사용 시 `sql.placeholder()`로 파라미터 바인딩 — XSS/SQL injection 방지
- `with` relation query는 N개의 테이블을 JOIN하므로 필요한 depth만 포함

## 검증 포인트
- 마이그레이션 파일이 스키마 정의와 동기화되어 있는가? (`drizzle-kit check`)
- Prepared statement가 hot path에 적용되어 쿼리 파싱 비용을 줄이는가?
- 관계 정의(`relations()`)가 실제 외래 키 컬럼과 일치하는가?
- 타입 추론이 쿼리 결과에 올바르게 적용되어 런타임 캐스팅 없이 사용 가능한가?
