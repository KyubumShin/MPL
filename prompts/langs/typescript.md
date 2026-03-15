# Language: TypeScript

## 핵심 원칙
- `strict` 모드 준수, `any` 사용 금지 (`unknown`으로 대체 후 narrowing)
- Type narrowing 활용: type guard 함수, discriminated union으로 타입 좁히기
- `enum` 대신 `const assertion`(`as const`) 또는 union type 권장
- `null`과 `undefined`를 구분하고 optional chaining(`?.`), nullish coalescing(`??`) 활용
- 제네릭은 실제로 재사용되는 경우에만 도입 (과잉 추상화 금지)

## 주의 사항
- `as` 타입 단언은 런타임 안전성이 보장될 때만 허용
- `@ts-ignore` / `@ts-expect-error` 사용 시 이유 주석 필수
- `unknown` 타입은 runtime guard 없이 접근 금지
- 인터페이스와 타입 별칭의 사용 기준을 프로젝트 내에서 일관되게 유지

## 검증 포인트
- `tsc --noEmit` 에러 없이 통과하는가?
- ESLint(`@typescript-eslint`) 통과하는가?
- `any` 또는 무분별한 타입 단언이 없는가?
- strict null check 위반이 없는가?
