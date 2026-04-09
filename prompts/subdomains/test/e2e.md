# Subdomain: Test/E2E (End-to-End Testing)

## Core Principles
- Encapsulate selectors and actions with Page Object Model (POM) — avoid using DOM selectors directly in test code
- Each test must be independently executable — prohibit shared state between tests, reset with `beforeEach`
- Fixtures and test data must be deterministic — results must not vary by execution order or time
- Generate visual regression test baseline snapshots in the CI environment for consistency

## Cautions
- Prohibit fixed delays with `page.waitForTimeout()` — use event-based waits like `waitForSelector`, `waitForResponse`
- When tests fail intermittently (flaky) in CI, analyze the root cause before adding retries
- Test DB/environment must be isolated from production — mock or use test doubles for real external service calls
- Collect reproducible artifacts on failure using Playwright `trace` and Cypress `video` options

## Verification Points
- Do tests pass reliably in headless mode in the CI environment?
- Are key user journeys (login, checkout, core flows) covered?
- Are screenshots/trace artifacts automatically saved in CI on failure?
- Does the retry configuration reflect actual reliability rather than hiding flaky tests?
