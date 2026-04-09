# Subdomain: Infra/Docker (Docker Container Build and Execution)

## Core Principles
- Use multi-stage builds to separate build dependencies from the final image, minimizing image size
- Place frequently changing layers (source code) later in the Dockerfile to maximize cache reuse
- Use `.dockerignore` to exclude `node_modules`, `.git`, local environment files, etc. from the build context
- Run containers as a dedicated non-privileged user (USER), not as root

## Cautions
- Prohibit the `latest` tag — pin base images with an exact version and digest
- Do not include sensitive data (API keys, secrets) in `ENV` or image layers — use runtime secret mounts
- Without `HEALTHCHECK`, orchestrators cannot accurately determine container health
- In Compose networking, refer to inter-service communication using service names (DNS) — prohibit IP hardcoding

## Verification Points
- Has the final image size been sufficiently reduced by multi-stage builds? (check with `docker image ls`)
- Are there no known CVEs detected by `docker scan` or Trivy?
- Does `HEALTHCHECK` reflect the actual readiness state of the application?
- Do volume mounts preserve data across container restarts?
