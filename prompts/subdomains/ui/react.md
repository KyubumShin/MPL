# Subdomain: UI/React (React 컴포넌트 개발)

## 핵심 원칙
- Hooks는 컴포넌트 최상위 레벨에서만 호출 (조건문/반복문 내부 금지)
- 서버에서 실행되는 Server Components와 클라이언트 상태가 필요한 Client Components를 명확히 구분
- 파생 상태는 별도 state 대신 렌더링 중 계산하거나 useMemo 사용
- key prop은 목록 항목의 안정적 식별자 사용 (인덱스 사용 지양)

## 주의 사항
- useEffect 의존성 배열 누락 금지 — exhaustive-deps lint 규칙 준수
- useCallback/memo 과도한 적용 금지 — 실측 성능 이슈 발생 시에만 사용
- 이벤트 핸들러 내부에서 stale closure 주의 (함수형 업데이트 또는 ref 활용)
- Context 값 변경 시 하위 트리 전체 리렌더 발생 — 분리 또는 메모이제이션 검토

## 검증 포인트
- 의존성 배열이 실제 사용하는 값을 모두 포함하는가?
- Server/Client Component 경계가 의도대로 설정되어 있는가?
- 목록 렌더링 시 key가 안정적이고 고유한가?
- 불필요한 리렌더링이 React DevTools Profiler로 확인되지 않는가?
