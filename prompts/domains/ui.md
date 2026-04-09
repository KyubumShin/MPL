# Domain: UI (Frontend)

## Core Principles
- Components follow the single responsibility principle
- State management at the minimal scope (local → context → global)
- Basic accessibility (a11y) compliance (aria, semantic HTML, keyboard nav)
- Responsive design consideration (mobile-first or project convention)

## Cautions
- No abuse of inline styles — use the project style system
- Prevent unnecessary re-renders (use memo, useMemo, useCallback appropriately)
- No hardcoded strings — use i18n or constants files
- Images/media should use optimized formats and lazy loading

## Verification Points
- Does the component render correctly across various viewports?
- Is every feature accessible via keyboard alone?
- Are error and loading states handled?
- Does it match the existing design system/tokens?
