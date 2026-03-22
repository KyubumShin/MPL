# Subdomain: Test/Unit (Unit Testing)

## Core Principles
- Use the AAA pattern (Arrange-Act-Assert) to clarify test readability and intent
- Distinguish Test Doubles (Mock/Stub/Spy/Fake) by purpose — do not blindly mock all dependencies
- Apply snapshot testing only to stable output structures — prefer assertions for frequently changing UI
- Focus coverage on boundary cases of core business logic rather than a numeric target (e.g., 80%)

## Cautions
- Overusing `vi.mock`/`jest.mock` ties tests to implementation details — real logic errors can be missed
- Do not leave `console.log` calls in test files — block them with `--silent` or a lint rule
- Missing `await`/`done()` in async tests produces false positives where tests always pass
- Shared `beforeAll` state creates ordering dependencies between tests — prefer resetting state with `beforeEach`

## Verification Points
- Does each test verify only a single behavior?
- Does the mock accurately reflect the contract (API signature, return type) of the real dependency?
- Are boundary values (empty array, null, max value, error cases) covered?
- Can tests run independently without changes to production code?
