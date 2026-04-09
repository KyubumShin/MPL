# Subdomain: UI/Vue (Vue 3 Composition API Development)

## Core Principles
- Use Composition API (`setup()` or `<script setup>`) by default — avoid mixing with Options API
- Consistently apply the principle: use `ref()` for primitive reactivity and `reactive()` for objects/arrays
- Keep `computed()` pure without side effects — mutations belong in `watch` / event handlers
- Split Pinia stores by domain and minimize direct dependencies between stores

## Cautions
- Destructuring a `reactive()` object loses reactivity — use `toRefs()` or `storeToRefs()`
- Avoid overusing the `deep` option in `watch` — explicitly watch only the needed nested properties
- Always guarantee `next()` is called in asynchronous Vue Router `beforeEach` guards
- Minimize what is exposed via `defineExpose()` — maintain component encapsulation

## Verification Points
- Is `.value` used correctly when accessing `ref` values? (auto-unwrapped in templates)
- Do Pinia actions handle errors appropriately and keep store state consistent?
- Are `watch` / event listeners cleaned up when a component unmounts?
- Do `<Suspense>` and async component boundaries handle loading/error states?
