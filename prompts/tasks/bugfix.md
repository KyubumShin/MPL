# Task Type: Bugfix

## Core Principles
- Identify the root cause, not just the symptom, before fixing
- Write a reproduction test first (red), then make it pass after the fix (green)
- Minimal change principle: never modify code unrelated to the bug
- Review the codebase for other occurrences of the same pattern
- Document the reason for the fix in the commit message or code comments

## Cautions
- Do not expand scope on the grounds of "this code also looks suspicious"
- Distinguish and record workarounds separately from root-cause fixes
- For third-party library bugs, separate upstream reporting from local workaround strategy
- Separate issues discovered during the fix into new tasks

## Verification Points
- Does the bug reproduction test pass after the fix?
- Do all existing regression tests pass?
- Is the root cause resolved (not just the symptom suppressed)?
- Has the same fix been applied to other code with the same pattern?
