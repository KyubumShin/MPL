# Domain: Infra (Infrastructure/Configuration)

## Core Principles
- Per-environment configuration is managed via environment variables (no hardcoding)
- Secret information must never be included in code
- Configuration changes must be rollback-capable
- CI/CD pipeline changes require a dry-run test

## Cautions
- Do not commit .env files to git
- Docker images should be minimal size (multi-stage build)
- Verify port conflicts and volume mount paths
- Pin dependency versions (confirm lock file exists)

## Verification Points
- Are all environment variables documented?
- Does Docker build/run succeed without errors?
- Does the CI pipeline operate normally?
- Is secret information not exposed in logs?
