# Subdomain: UI/Svelte (SvelteKit + Svelte 5 Runes)

## 핵심 원칙
- Svelte 5 Runes 사용: `$state()`로 반응 상태, `$derived()`로 파생값, `$effect()`로 사이드 이펙트
- SvelteKit의 `load` 함수에서 데이터 패칭 — 컴포넌트 내 직접 fetch 지양
- Form Actions(`+page.server.ts`)로 뮤테이션 처리 — progressive enhancement 고려
- `+layout.svelte` / `+page.svelte` 파일 구조를 라우트 세그먼트 단위로 유지

## 주의 사항
- `$effect()`에서 `$state` 변수를 직접 변경하면 무한 루프 위험 — `$derived`로 대체 검토
- `load` 함수의 반환값은 직렬화 가능한 형태여야 함 (클래스 인스턴스, 함수 불가)
- `use:action` 디렉티브에서 DOM 직접 조작 시 Svelte 렌더링 사이클과 충돌 주의
- 서버 전용 로직은 반드시 `.server.ts` 파일에 — 클라이언트 번들 노출 방지

## 검증 포인트
- `$effect()` 내부에서 읽는 모든 `$state`가 의도한 의존성인가?
- `load` 함수가 `error()`/`redirect()`로 에러 케이스를 처리하는가?
- Form Action의 `fail()`과 `invalid` 응답이 UI에서 적절히 표시되는가?
- 서버 사이드 `load`와 클라이언트 사이드 `load`의 실행 컨텍스트 구분이 명확한가?
