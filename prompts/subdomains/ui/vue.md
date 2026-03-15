# Subdomain: UI/Vue (Vue 3 Composition API 개발)

## 핵심 원칙
- Composition API(`setup()` 또는 `<script setup>`)를 기본으로 사용 — Options API 혼용 지양
- 원시값 반응성에는 `ref()`, 객체/배열에는 `reactive()` 사용 원칙 일관 적용
- `computed()`는 사이드 이펙트 없이 순수하게 유지 — 변이는 `watch`/이벤트 핸들러에서
- Pinia store는 도메인 단위로 분리하고 store 간 직접 의존 최소화

## 주의 사항
- `reactive()` 객체를 구조 분해하면 반응성 소실 — `toRefs()` 또는 `storeToRefs()` 사용
- `watch`의 deep 옵션 남용 금지 — 필요한 중첩 속성만 명시적으로 감시
- Vue Router `beforeEach` 가드에서 비동기 작업 시 항상 `next()` 호출 보장
- `defineExpose()`를 통해 노출하는 ref는 최소한으로 — 컴포넌트 캡슐화 유지

## 검증 포인트
- `ref` 값 접근 시 `.value`를 올바르게 사용하는가? (템플릿에서는 자동 언래핑)
- Pinia action이 에러를 적절히 처리하고 store 상태가 일관성을 유지하는가?
- 컴포넌트 언마운트 시 `watch`/이벤트 리스너가 정리(cleanup)되는가?
- `<Suspense>`와 비동기 컴포넌트 경계가 로딩/에러 상태를 처리하는가?
