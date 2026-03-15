# Language: Java

## 핵심 원칙
- Checked exception은 호출자가 실제로 복구할 수 있는 경우에만 사용
- `null` 반환 금지: `Optional<T>` 반환으로 부재를 명시적으로 표현
- `record` class를 불변 데이터 컨테이너로 적극 활용
- Stream API로 컬렉션 처리 단순화, 단 3단계 초과 체이닝은 변수로 분리
- `final` 필드 우선, 불변 객체 설계로 동시성 문제 사전 방지

## 주의 사항
- Lombok은 `@Builder`, `@Value` 등 최소 범위로 사용, `record`/`sealed`로 대체 가능한 경우 우선 적용
- `instanceof` 패턴 매칭(`instanceof Foo f`)과 switch 표현식 활용 (Java 17+)
- `synchronized` 직접 사용보다 `java.util.concurrent` 패키지 활용
- 자원 해제가 필요한 객체는 반드시 try-with-resources 사용

## 검증 포인트
- 컴파일 경고가 0개인가?
- SpotBugs 또는 Checkstyle 통과하는가?
- `null`을 반환하는 메서드가 없는가?
- Checked exception이 복구 불가 상황에 잘못 사용되지 않았는가?
