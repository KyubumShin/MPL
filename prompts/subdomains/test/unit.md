# Subdomain: Test/Unit (단위 테스트)

## 핵심 원칙
- AAA 패턴(Arrange-Act-Assert) 구조로 테스트 가독성과 의도 명확화
- Mock/Stub/Spy/Fake 등 Test Double을 목적에 맞게 구분 — 모든 의존성을 무조건 mock하지 않음
- Snapshot testing은 안정된 출력 구조에만 적용 — 자주 변경되는 UI에는 단언(assertion) 선호
- 커버리지는 수치 목표(예: 80%)보다 핵심 비즈니스 로직의 경계 케이스 커버에 집중

## 주의 사항
- `vi.mock`/`jest.mock` 남용 시 테스트가 구현 세부사항에 종속 — 실제 로직 오류를 놓칠 수 있음
- 테스트 파일 내 `console.log` 호출 남기지 않기 — `--silent` 옵션 또는 lint 규칙으로 차단
- 비동기 테스트에서 `await`/`done()` 누락 시 테스트가 항상 성공하는 false positive 발생
- `beforeAll` 공유 상태로 인한 테스트 실행 순서 의존 — `beforeEach`로 상태 초기화 권장

## 검증 포인트
- 각 테스트가 하나의 동작(behavior)만 검증하는가?
- Mock이 실제 의존성의 계약(API 시그니처, 반환 타입)을 정확히 반영하는가?
- 경계값(빈 배열, null, 최댓값, 에러 케이스)이 커버되는가?
- 테스트가 프로덕션 코드 변경 없이 독립적으로 실행 가능한가?
