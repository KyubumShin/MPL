# Subdomain: UI/Next.js (Next.js App Router Development)

## Core Principles
- App Router defaults to Server Components — declare `'use client'` only when client-side features are needed
- Choose data fetching strategy (SSR/SSG/ISR) based on content update frequency and personalization requirements
- Use Server Actions to handle form submissions and data mutations directly on the server
- Manage layout complexity with Route Groups `(group)` and Parallel Routes `@slot`

## Cautions
- Declaring `'use client'` in `layout.tsx` limits serialization of child Server Components
- Use `generateMetadata` for dynamic metadata — do not mix with static exports
- Do not perform heavy computation in middleware — consider Edge Runtime constraints
- Overly broad `revalidatePath`/`revalidateTag` calls can cause cache invalidation explosions

## Verification Points
- Are Server/Client Component boundaries for each page/layout set as intended?
- Is `generateStaticParams` defined for dynamic routes (`[param]`, `[...slug]`)?
- Is `metadata` or `generateMetadata` set for all public pages?
- Do Server Action responses properly conclude with `revalidatePath` or `redirect`?
