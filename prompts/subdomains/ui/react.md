# Subdomain: UI/React (React Component Development)

## Core Principles
- Hooks must only be called at the top level of a component (not inside conditionals or loops)
- Clearly distinguish Server Components that run on the server from Client Components that require client-side state
- Compute derived state during rendering or use useMemo instead of creating separate state
- Use stable identifiers as key props for list items (avoid using index)

## Cautions
- Do not omit useEffect dependency arrays — follow the exhaustive-deps lint rule
- Do not over-apply useCallback/memo — use only when a measured performance issue exists
- Watch for stale closures inside event handlers (use functional updates or refs)
- Changing a Context value triggers a full re-render of the subtree — consider splitting or memoization

## Verification Points
- Do dependency arrays include all values actually used?
- Are Server/Client Component boundaries set as intended?
- Are keys stable and unique when rendering lists?
- Are unnecessary re-renders not detected in the React DevTools Profiler?
