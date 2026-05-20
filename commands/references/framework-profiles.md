---
description: Framework/tool profile registry for boundary scans, platform constraints, launch smoke, resource risk, and E2E runner behavior.
---

# Framework And Tool Profiles

**Loaded by**: Phase 0 raw scan, decomposer, execute gates, finalize, and doctor when they need framework/tool-specific behavior.

**Purpose**: keep core MPL prompts framework-neutral. Core prompts should ask for profile categories and consume profile outputs; they should not duplicate framework-specific policy tables.

## Profile Contract

Profiles are advisory prompt data. They do not replace hooks or machine checks.

### `boundary_profiles`

- `id`: stable profile id
- `applies_when`: files, dependencies, or tech-stack markers
- `caller_paths`: source paths/globs to search
- `callee_paths`: target paths/globs to search
- `caller_patterns`: mechanical patterns for caller-side extraction
- `callee_patterns`: mechanical patterns for callee-side extraction
- `protocol`: boundary protocol name to record in `raw-scan.md`
- `framework_rules`: naming/serialization rules to attach to `contract_files`

### `platform_constraint_profiles`

- `id`
- `applies_when`
- `blocked_or_risky_patterns`: source grep patterns
- `hint`: probing hint for decomposer/test-agent

### `framework_convention_profiles`

- `id`
- `applies_when`
- `type_policy_rules`
- `error_policy_rules`

### `launch_smoke_profiles`

- `id`
- `applies_when`
- `smoke_shape`: generic launch command shape, not a hard requirement
- `liveness_evidence`: expected observable signal

### `build_tool_profiles`

- `id`
- `applies_when`
- `commands`: build/typecheck/lint command templates
- `cwd_rule`: how to choose command working directory

### `resource_risk_profiles`

- `id`
- `applies_when`
- `paths`
- `measurements`
- `warning_policy`

### `e2e_runner_profiles`

- `id`
- `applies_when`
- `run_command`
- `trace_policy`
- `spec_path_patterns`
- `launcher_evidence`

## Profiles

### Tauri / Rust Desktop

`boundary_profiles`
- `id`: `tauri-rust-invoke`
- `applies_when`: `src-tauri/`, `tauri.conf.json`, `src-tauri/Cargo.toml`, or tech stack contains Tauri.
- `caller_paths`: frontend source directories.
- `callee_paths`: Rust source under the Tauri project root.
- `caller_patterns`: `invoke(...)` call sites in frontend source.
- `callee_patterns`: Rust functions annotated with `#[tauri::command]`.
- `protocol`: `tauri-invoke`.
- `framework_rules`: top-level invoke params use Tauri v2 camelCase conversion; Rust struct fields usually follow Serde defaults.

`platform_constraint_profiles`
- `id`: `tauri-webview-api`
- `blocked_or_risky_patterns`: browser-native modal/file APIs that are unavailable or constrained inside the WebView runtime.
- `hint`: verify runtime-safe dialog/file APIs instead of assuming browser APIs work.

`framework_convention_profiles`
- `id`: `tauri-rust-serde`
- `type_policy_rules`: keep frontend/Rust boundary keys explicit; account for Serde naming conversion.
- `error_policy_rules`: avoid unchecked Rust panic paths on command boundaries; surface command failures as typed frontend errors.

`launch_smoke_profiles`
- `id`: `tauri-desktop-launch`
- `smoke_shape`: run the configured Tauri development or app launch command with no UI automation assumption.
- `liveness_evidence`: process starts, runtime bridge initializes, and no immediate command/runtime rejection occurs.

`build_tool_profiles`
- `id`: `tauri-rust-build`
- `applies_when`: `src-tauri/Cargo.toml`.
- `commands`: Rust compile/typecheck command from the Rust manifest directory.
- `cwd_rule`: use `src-tauri` when the manifest is under `src-tauri/`, otherwise use the project root.

`resource_risk_profiles`
- `id`: `tauri-rust-target`
- `paths`: `src-tauri/target/**`.
- `measurements`: target tree size, dependency artifact size, largest static library, partial scan errors.
- `warning_policy`: advisory WARN only until thresholds are calibrated; do not treat partial scans as clean.

`e2e_runner_profiles`
- `id`: `tauri-driver`
- `launcher_evidence`: desktop runtime launcher or driver evidence.

### Electron Desktop

`platform_constraint_profiles`
- `id`: `electron-renderer-native-api`
- `applies_when`: Electron config, dependency, directory, or tech-stack marker.
- `blocked_or_risky_patterns`: direct native Node API access from renderer contexts.
- `hint`: verify renderer/preload/main-process boundary design rather than assuming renderer native access.

`launch_smoke_profiles`
- `id`: `electron-launch`
- `smoke_shape`: run the configured Electron app launch command.
- `liveness_evidence`: main process starts and renderer loads without immediate runtime rejection.

`e2e_runner_profiles`
- `id`: `electron-launcher`
- `launcher_evidence`: Electron launcher evidence.

### Next.js / SSR Web Framework

`platform_constraint_profiles`
- `id`: `nextjs-ssr-browser-global`
- `applies_when`: `next.config.*`, Next.js dependency, or equivalent SSR framework config/dependency marker.
- `blocked_or_risky_patterns`: direct browser globals in server-rendered code paths.
- `hint`: verify browser-only APIs are gated to client/runtime boundaries.

`framework_convention_profiles`
- `id`: `nextjs-ssr-web-conventions`
- `type_policy_rules`: keep server/client DTO names explicit across boundaries.

### React Native / Native Mobile Web Runtime

`platform_constraint_profiles`
- `id`: `react-native-browser-api`
- `applies_when`: React Native dependency, native mobile config, or equivalent native mobile runtime marker.
- `blocked_or_risky_patterns`: DOM/browser APIs that are unavailable in native mobile runtimes.
- `hint`: verify native runtime APIs instead of browser DOM assumptions.

### FastAPI / Python API With Schema Models

`framework_convention_profiles`
- `id`: `fastapi-pydantic-schema-models`
- `applies_when`: FastAPI dependency plus Pydantic/schema model dependency, or equivalent Python API framework with schema models.
- `type_policy_rules`: preserve schema model field names and serialization aliases across API boundaries.
- `error_policy_rules`: surface validation failures as structured API errors.

### JavaScript/TypeScript Package Scripts

`build_tool_profiles`
- `id`: `js-package-scripts`
- `applies_when`: package manifest with build/typecheck/lint/test scripts.
- `commands`: run declared package scripts rather than inventing commands.
- `cwd_rule`: package manifest directory.

### Rust Cargo

`build_tool_profiles`
- `id`: `rust-cargo`
- `applies_when`: Rust manifest.
- `commands`: cargo check/build/test according to gate context.
- `cwd_rule`: manifest directory.

### Python Project

`build_tool_profiles`
- `id`: `python-project`
- `applies_when`: Python project metadata or setup file.
- `commands`: byte-compile or configured test/lint command.
- `cwd_rule`: project root unless a package subroot is detected.

### Go Module

`build_tool_profiles`
- `id`: `go-module`
- `applies_when`: Go module file.
- `commands`: go build/test package tree.
- `cwd_rule`: module root.

### JVM Build Tools

`build_tool_profiles`
- `id`: `jvm-gradle-maven`
- `applies_when`: Gradle or Maven build files.
- `commands`: compile/test tasks matching the detected build tool.
- `cwd_rule`: build file directory.

### Playwright Browser E2E Runner

`e2e_runner_profiles`
- `id`: `playwright-browser-e2e`
- `applies_when`: `playwright.config.*` or Playwright dependency.
- `run_command`: configured Playwright command if present.
- `trace_policy`: when the command lacks trace flags, add Playwright trace-on arguments and write traces under `.mpl/e2e-traces/`.
- `spec_path_patterns`: Playwright spec globs from config or conventional e2e/test directories.
- `launcher_evidence`: real browser or runtime launcher evidence.

### Cypress Browser E2E Runner

`e2e_runner_profiles`
- `id`: `cypress-browser-e2e`
- `applies_when`: `cypress.config.*`, `cypress/`, or Cypress dependency.
- `run_command`: configured Cypress run command if present.
- `trace_policy`: no automatic trace injection by default; preserve screenshots/videos and stderr/stdout tails.
- `spec_path_patterns`: Cypress spec globs from config or `cypress/`.
- `launcher_evidence`: real browser launcher evidence.

### Puppeteer / Selenium Browser E2E Runner

`e2e_runner_profiles`
- `id`: `browser-driver-e2e`
- `applies_when`: Puppeteer or Selenium dependency/config.
- `run_command`: project-configured command if present; otherwise ask before synthesizing.
- `trace_policy`: no automatic trace injection by default; preserve stderr/stdout tails.
- `launcher_evidence`: browser driver launcher evidence.

### Pytest E2E Runner

`e2e_runner_profiles`
- `id`: `pytest-e2e`
- `applies_when`: Python project metadata or test directories indicate e2e pytest usage.
- `run_command`: configured pytest e2e command if present.
- `trace_policy`: no automatic trace injection by default; preserve stderr/stdout tails.
- `spec_path_patterns`: Python e2e test paths from project config or test directories.
- `launcher_evidence`: real API/runtime evidence when the scenario is not unit/mock.

### Custom E2E Runner

`e2e_runner_profiles`
- `id`: `custom-e2e-runner`
- `applies_when`: e2e directories or project-specific test command exists without a known runner profile.
- `run_command`: null until user or project config supplies one.
- `trace_policy`: no automatic trace injection; preserve stderr/stdout tails for diagnosis.
