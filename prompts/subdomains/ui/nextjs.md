# Subdomain: UI/Next.js (Next.js App Router 개발)

## 핵심 원칙
- App Router 기본값은 Server Component — 클라이언트 기능 필요 시에만 `'use client'` 선언
- 데이터 패칭 전략(SSR/SSG/ISR)은 콘텐츠 변경 빈도와 개인화 여부 기준으로 선택
- Server Actions를 활용해 form 처리와 데이터 변이를 서버에서 직접 처리
- Route Groups `(group)`과 Parallel Routes `@slot`으로 레이아웃 복잡도 관리

## 주의 사항
- `layout.tsx`에 `'use client'` 선언 시 하위 Server Component 직렬화 제한 발생
- `generateMetadata`는 동적 메타데이터 생성에 사용 — 정적 export와 혼용 금지
- middleware에서 무거운 연산 수행 금지 — Edge Runtime 제약 고려
- `revalidatePath`/`revalidateTag` 호출 범위 과도하게 넓히면 캐시 무효화 폭발

## 검증 포인트
- 각 페이지/레이아웃의 Server/Client Component 경계가 의도대로인가?
- 동적 라우트(`[param]`, `[...slug]`)의 `generateStaticParams`가 정의되어 있는가?
- `metadata` 또는 `generateMetadata`가 모든 공개 페이지에 설정되었는가?
- Server Action 응답이 `revalidatePath` 또는 `redirect`로 적절히 마무리되는가?
