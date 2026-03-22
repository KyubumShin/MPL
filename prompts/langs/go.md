# Language: Go

## Core Principles
- Error handling: prohibit `panic` in libraries, wrap with `fmt.Errorf("...: %w", err)`
- Prevent goroutine leaks: propagate cancellation via `context.Context`, guarantee goroutine termination
- Define interfaces on the consumer side (keep the method set minimal)
- Check errors explicitly: use `_, err :=` pattern followed immediately by `if err != nil`
- Always specify field names when initializing structs (`S{field: val}`, do not rely on ordering)

## Cautions
- Minimize global variables: package-level state makes test isolation difficult
- Prohibit overusing `interface{}` / `any`: do not sacrifice type safety
- Specify channel direction in function signatures (`chan<-`, `<-chan`)
- Minimize reliance on `init()` functions (side effects are hard to trace)

## Verification Points
- Does `go vet` pass?
- Does `staticcheck` or `golangci-lint` pass?
- Are all error return values handled?
- Do all goroutines terminate normally (no leaks)?
