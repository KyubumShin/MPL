# Move #6 — Bash-surface source-edit enforcement (v0.18.1)

## Summary

Closes the Law 2 / direct_source_edit Bash bypass: until this move, the
`direct_source_edit` policy only ran on `Edit / Write / MultiEdit`. An
orchestrator could still write a source file via Bash redirects, `tee`,
`sed -i`, `dd of=`, `cp`/`mv`, interpreter one-liners, `touch`, `sponge`,
formatters (`prettier --write`, `eslint --fix`, etc.), `patch`, and
`git apply` — all of which were silently allowed.

Move #6 ships:

1. **New module** `hooks/lib/policy/source-edit.mjs` — owns the entire
   source-edit decision graph end-to-end across the Edit/Write/MultiEdit/
   NotebookEdit AND Bash tool surfaces. Exports a single `handle()` L2
   entrypoint plus the legacy `isAllowedPath` / `isSourceFile` /
   `isDangerousBashCommand` / `isDogfoodMode` symbols for downstream
   tests.
2. **Bash write-target extractor** `extractBashWriteTargets()` — finds
   every write-target shape (redirect, tee, sed -i, dd of=, cp/mv/install/
   rsync, interpreter-write, touch, sponge, formatter, patch, git-apply,
   archive-extract). `opaque: true` marks unresolved `$VAR` / `$(…)` /
   glob tokens; those downgrade to warn-only (we can't prove block).
3. **NotebookEdit** added to the matcher universe (hooks.json) and to the
   tool-name allowlist; `.ipynb` added to `SOURCE_EXTENSIONS`.
4. **Default flip**: `direct_source_edit` defaults from `warn` to `block`
   (mpl.config.yaml + `lib/mpl-config.mjs` `ENFORCEMENT_DEFAULTS`).
   New sibling rule `bash_write_targets` (default `block`) is the gate
   for the Bash extension — setting it to `off` skips Bash extraction
   entirely without weakening the Edit/Write surface.
5. **Wrapper** `hooks/mpl-write-guard.mjs` becomes a thin shim (~150 LOC,
   down from 1377): reads stdin, parses JSON, applies the
   `recordFirstTranscript` side effect first (so the dispatcher-identity
   gate sees the post-record value), calls `sourceEdit.handle(event)`,
   then applies the returned `sideEffects` (recordBlockedHook /
   clearBlockedHook / lockDecomposerChild / recordDecomposerDispatch)
   before serializing the decision envelope as JSON. Same hook surface,
   same `hooks.json` invocation, same fail-open posture.

## Migration impact

- Workspaces that want the transitional warn behavior must set
  `enforcement.direct_source_edit: warn` in `.mpl/config.json` or in
  state.json's enforcement override. The default-of-warn ENFORCEMENT
  test in `mpl-enforcement.test.mjs` already exercises unknown-rule
  fallback, so adding the `bash_write_targets` key is forward-compatible.
- Workspaces that opt the Bash surface to warn without weakening
  Edit/Write can set `enforcement.bash_write_targets: warn`.

## Regression coverage

`hooks/__tests__/policy-source-edit.test.mjs` (50 tests):
- pure unit tests for `extractBashWriteTargets` across every extractor
  source tag,
- end-to-end e2e tests via the hook for every Bash shape listed above,
- false-positive guards (allowlisted paths, non-source extensions,
  `/dev/null`, read-only verbs, `prettier --check`, `2>&1` fd-dup),
- opaque-token downgrade to warn,
- policy gate combinations (`bash_write_targets=off`, `direct_source_edit=warn|off`),
- NotebookEdit parity.

Plus the existing `mpl-write-guard.test.mjs` (39 tests),
`mpl-issue-235-block-envelope.test.mjs`, and
`mpl-issue-236-write-guard-tighten.test.mjs` continue to pass with the
default flip honored.
