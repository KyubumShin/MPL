# Language: Python

## Core Principles
- Type hints are mandatory on all function signatures (`def fn(x: int) -> str:`)
- Maintain `async`/`await` consistency: be careful of blocking risks when mixing sync/async
- Use f-strings (`f"{val}"`) — avoid `format()` and `%` formatting
- Prefer Pythonic idioms: list comprehensions, context managers (`with`), `dataclass`
- Virtual environments are required; pin dependencies in `requirements.txt` or `pyproject.toml`

## Cautions
- Prohibit mutable default arguments: `def fn(items=[])` → use `def fn(items=None)` pattern
- Catch exceptions with specific types (avoid overusing `except Exception:`)
- Define `__all__` to declare public API explicitly (for large modules)
- Minimize global variables and module-level side effects

## Verification Points
- Does `mypy` or `pyright` type check pass?
- Does `ruff` lint pass?
- Are `async` functions called within an appropriate event loop?
- Are dependencies version-pinned for reproducibility?
