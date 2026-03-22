# Domain: Test

## Core Principles
- Tests must be independent and reproducible (order-independent)
- Use Given-When-Then structure to clearly express intent
- One test verifies one behavior only
- Minimize mocking — prefer real behavior

## Cautions
- No shared state between tests (watch fixture scope)
- No time-dependent tests (sleep, Date.now mocking)
- Tests depending on filesystem/network must be isolated
- When a flaky test is found, fix immediately or skip + record the issue

## Verification Points
- Do tests produce the same result on repeated runs?
- Do failure messages clearly indicate the cause?
- Does coverage include the critical paths?
- Is test execution time reasonable?
