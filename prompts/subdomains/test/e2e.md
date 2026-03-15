# Subdomain: Test/E2E (엔드 투 엔드 테스트)

## 핵심 원칙
- Page Object Model(POM)로 셀렉터와 액션을 캡슐화 — 테스트 코드에서 직접 DOM 셀렉터 사용 지양
- 각 테스트는 독립적으로 실행 가능해야 함 — 테스트 간 상태 공유 금지, `beforeEach`로 초기화
- Fixture와 테스트 데이터는 결정론적(deterministic) — 실행 순서나 시간에 따라 결과가 달라지면 안 됨
- 시각적 회귀(Visual regression) 테스트는 기준 스냅샷을 CI 환경에서 생성해 일관성 확보

## 주의 사항
- `page.waitForTimeout()` 고정 지연 사용 금지 — `waitForSelector`, `waitForResponse` 등 이벤트 기반 대기 사용
- 테스트가 CI에서 간헐적으로 실패(flaky)하면 retry 전에 근본 원인 분석 우선
- 테스트 DB/환경은 프로덕션과 격리 — 실제 외부 서비스 호출은 mock 또는 test double 사용
- Playwright `trace`와 Cypress `video` 옵션으로 실패 시 재현 가능한 아티팩트 수집

## 검증 포인트
- 테스트가 CI 환경에서 headless 모드로 안정적으로 통과하는가?
- 핵심 사용자 여정(로그인, 체크아웃, 핵심 플로)이 커버되는가?
- 실패 시 스크린샷/트레이스 아티팩트가 CI에서 자동 저장되는가?
- Retry 설정이 flaky 테스트를 숨기지 않고 실제 신뢰성을 반영하는가?
