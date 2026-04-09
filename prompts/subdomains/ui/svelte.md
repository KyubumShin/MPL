# Subdomain: UI/Svelte (SvelteKit + Svelte 5 Runes)

## Core Principles
- Use Svelte 5 Runes: `$state()` for reactive state, `$derived()` for derived values, `$effect()` for side effects
- Fetch data in SvelteKit `load` functions — avoid direct fetch inside components
- Handle mutations via Form Actions (`+page.server.ts`) — consider progressive enhancement
- Maintain `+layout.svelte` / `+page.svelte` file structure at the route segment level

## Cautions
- Directly mutating `$state` variables inside `$effect()` risks infinite loops — consider replacing with `$derived`
- Return values from `load` functions must be serializable (class instances and functions are not allowed)
- Direct DOM manipulation in `use:action` directives may conflict with Svelte's rendering cycle
- Server-only logic must reside in `.server.ts` files — prevent exposure in the client bundle

## Verification Points
- Are all `$state` values read inside `$effect()` the intended dependencies?
- Does the `load` function handle error cases with `error()` / `redirect()`?
- Are Form Action `fail()` and `invalid` responses displayed appropriately in the UI?
- Is the execution context of server-side `load` and client-side `load` clearly distinguished?
