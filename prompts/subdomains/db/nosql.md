# Subdomain: DB/NoSQL (문서 지향 데이터베이스)

## 핵심 원칙
- 데이터 접근 패턴 중심으로 스키마 설계 — 관계형 정규화 원칙을 그대로 적용하지 않음
- 자주 함께 읽히는 데이터는 임베딩(embedding), 독립적으로 관리되는 엔티티는 참조(referencing)
- Eventual consistency를 전제로 설계 — 읽기 후 즉각 일관성이 필요하면 read preference 조정
- TTL index로 만료 데이터 자동 정리 — 애플리케이션 레벨 삭제 로직 의존 최소화

## 주의 사항
- 문서 크기 제한(MongoDB 16MB 등) 초과 주의 — 무한 성장 배열(unbounded array) 임베딩 금지
- Aggregation pipeline에서 `$lookup` 다단계 사용 시 성능 비용 측정 필수
- 인덱스 없는 쿼리는 컬렉션 풀스캔 발생 — `explain()` 분석 후 복합 인덱스 설계
- 분산 트랜잭션(multi-document)은 성능 비용이 크므로 단일 문서 원자성으로 해결 검토

## 검증 포인트
- 주요 쿼리 패턴에 대응하는 인덱스가 모두 정의되어 있는가?
- 임베딩된 배열이 무한히 증가하지 않는 구조인가?
- Aggregation pipeline이 `$match`/`$project`를 초기에 배치해 처리량을 줄이는가?
- TTL index 또는 명시적 정리 로직이 오래된 데이터를 관리하는가?
