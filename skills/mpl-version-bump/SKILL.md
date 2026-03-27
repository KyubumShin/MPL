---
description: Version bump checklist for MPL plugin releases — ensures all version references are updated consistently
---

# MPL Version Bump

Automated version bump checklist that finds and updates ALL version references across the MPL plugin.
Prevents the recurring issue of version mismatches between files after a release.

## Usage

```
/mpl:mpl-version-bump <new_version>
```

Example: `/mpl:mpl-version-bump 0.9.0`

## Protocol

### Step 1: Parse Target Version

Extract the target version from the user's input. Validate format: `MAJOR.MINOR.PATCH` (e.g., `0.8.3`).

If no version is provided, read current version from `plugin.json` and ask the user which bump type:
- **patch**: 0.8.2 → 0.8.3
- **minor**: 0.8.2 → 0.9.0
- **major**: 0.8.2 → 1.0.0

### Step 2: Scan Current Version References

Search for ALL version references in the MPL directory. These are the **mandatory update targets**:

```
Version Reference Checklist:
  ☐ .claude-plugin/plugin.json         → "version" field
  ☐ .claude-plugin/marketplace.json    → "version" field (top-level)
  ☐ .claude-plugin/marketplace.json    → plugins[0].version field
  ☐ mcp-server/package.json            → "version" field
  ☐ docs/design.md                     → title line "# MPL (Micro-Phase Loop) vX.Y.Z"
  ☐ README.md                          → title line "# MPL (Micro-Phase Loop) vX.Y.Z"
  ☐ README_ko.md                       → title line "# MPL (Micro-Phase Loop) vX.Y.Z"
```

Run a grep to find any other files referencing the OLD version number:
```
Grep for: "{old_version}" across MPL/**/*.{md,json,yaml,yml,ts,js,mjs}
```

Exclude from update (version references in historical context):
- `docs/design.md` version history section (v0.8.0, v0.8.1 entries — these are historical)
- `docs/roadmap/` files referencing past versions
- `package-lock.json` (auto-generated)
- `.omc/` directory

### Step 3: Execute Updates

For each mandatory target, update the version. Report each change:

```
[MPL-BUMP] ✓ .claude-plugin/plugin.json: 0.8.2 → 0.8.3
[MPL-BUMP] ✓ .claude-plugin/marketplace.json (top): 0.8.2 → 0.8.3
[MPL-BUMP] ✓ .claude-plugin/marketplace.json (plugin): 0.8.2 → 0.8.3
[MPL-BUMP] ✓ mcp-server/package.json: 0.8.2 → 0.8.3
[MPL-BUMP] ✓ docs/design.md title: 0.8.2 → 0.8.3
[MPL-BUMP] ✓ README.md title: 0.8.2 → 0.8.3
[MPL-BUMP] ✓ README_ko.md title: 0.8.2 → 0.8.3
```

### Step 4: Version History Reminder

Remind the user to add a version history entry:

```
[MPL-BUMP] Version bumped to {new_version}.

Reminder — add version history entry to docs/design.md:
  ### v{new_version} — {Title} ({date})
  | Change | Before | After | Type | Rationale |
  ...

  **Affected files:**
  ...
  **Breaking changes:** NONE / {describe}
```

### Step 5: Verification

Run a final grep to confirm no old version references remain (excluding historical entries):

```
Grep for "{old_version}" in:
  - .claude-plugin/*.json
  - mcp-server/package.json
  - README*.md
  - docs/design.md (title line only)

If any found: WARNING with file:line details
If clean: "[MPL-BUMP] ✓ All version references updated. No stale references found."
```

### Step 6: Summary

```
[MPL-BUMP] === Version Bump Complete ===
  {old_version} → {new_version}
  Files updated: {count}
  Stale references: {count} (0 = clean)
```
