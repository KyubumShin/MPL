# Context Rotation Backend Setup (Auto-Resume)

Context rotation enables MPL to automatically continue when context window fills up, by sending `/clear` via terminal control and auto-resuming.

## Detection

```
backend = null

if env.TMUX:
  backend = "tmux"
elif env.TERM_PROGRAM contains "kitty":
  backend = "kitty"
elif platform == "darwin":
  backend = "osascript"
```

## Validation

```
if backend detected:
  test_result = Bash("node -e \"
    import('${CLAUDE_PLUGIN_ROOT}/hooks/lib/rotation-backends.mjs')
      .then(m => console.log(JSON.stringify(m.testBackend('${backend}'))))
  \"")

  if test_result.available:
    Report: "Context rotation backend detected: {backend}"
  else:
    Report: "Backend {backend} detected but not functional: {test_result.error}"
    backend = null
```

## Configuration

```
AskUserQuestion: "Would you like to enable automatic context rotation?"
  - "Enable (recommended)" → save backend config
  - "Do not use" → set enabled = false

if enabled:
  Write to .mpl/config.json:
    "context_rotation": {
      "enabled": true,
      "backend": "{detected_backend}",
      "trigger_pct": 65,
      "max_rotations": 10,
      "backend_opts": {}
    }
```

## Backend-specific Setup

| Backend | Requirement | Setup Action |
|---------|-------------|-------------|
| kitty | `allow_remote_control yes` in kitty.conf | Check and warn if not set |
| tmux | Active tmux session | Auto-detected via $TMUX |
| osascript | macOS + Accessibility permission | Warn about System Preferences |

```
if backend == "kitty":
  kitty_conf = Bash("cat ~/.config/kitty/kitty.conf 2>/dev/null | grep allow_remote_control")
  if "yes" not in kitty_conf:
    Report: "Kitty remote control is disabled."
    Report: "  Add to ~/.config/kitty/kitty.conf: allow_remote_control yes"
    Report: "  Then restart Kitty."
```
