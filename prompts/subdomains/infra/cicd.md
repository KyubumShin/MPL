# Subdomain: Infra/CICD (CI/CD Pipeline Design)

## Core Principles
- Explicitly declare triggers (`on`), permissions (`permissions`), and jobs (`jobs`) in GitHub Actions workflows
- Use matrix strategy to run parallel tests for multiple OS/runtime version combinations in a single workflow
- Reduce install time on repeated runs with dependency caching (`actions/cache`) for npm/pip/cargo
- Enforce manual approval before production deployments via environment protection rules

## Cautions
- Secrets must be managed via GitHub Secrets/OIDC — never output them in workflow files or logs
- Set `persist-credentials: false` in `actions/checkout` — prevent unnecessary credential exposure
- Share artifacts between jobs using `upload-artifact`/`download-artifact` — prohibit direct file path references
- When using self-hosted runners, restrict permissions for fork PRs — risk of malicious code execution

## Verification Points
- Does the workflow trigger correctly on both main branch pushes and PRs?
- Is a `needs` dependency configured to block the deployment stage when a job fails?
- Does the cache key include a hash of the dependency file (package-lock.json, requirements.txt)?
- Is the execution permission for the deployment workflow limited to the minimum required scope?
