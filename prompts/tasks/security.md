# Task Type: Security (Hardening)

## Core Principles
- Use the OWASP Top 10 checklist to determine the scope of application
- All external inputs must be sanitized + validated (both are required)
- Separate Authentication and Authorization into distinct layers
- Principle of least privilege: allow access only to the required scope
- Secret information (keys, passwords, tokens) must be completely removed from source code and logs

## Cautions
- Always review the impact of security fixes on functional behavior
- Do not implement cryptographic algorithms directly — use validated libraries
- Do not expose internal implementation details in error messages
- Security patches should be isolated in separate commits (easier to track change history)

## Verification Points
- Are known attack vectors (XSS, SQLi, CSRF, etc.) blocked?
- Is it impossible to access protected resources without authentication?
- Is sensitive information not exposed in responses, logs, or error messages?
- Is input validation also performed server-side (not only client-side)?
