# Language: Rust

## Core Principles
- Comply with ownership/borrow rules and avoid unnecessary `.clone()` calls
- Use `Result`/`Option` patterns: prohibit `unwrap()`, leverage the `?` operator
- Minimize `unsafe` blocks; when used, a `// SAFETY:` comment is mandatory
- Write lifetime annotations only when the compiler cannot apply elision
- Prefer trait-based abstraction: distinguish `dyn Trait` (dynamic) and `impl Trait` (static) by purpose

## Cautions
- Define error types with `thiserror`/`anyhow`; prohibit overusing `Box<dyn Error>`
- Before introducing `Arc<Mutex<T>>`, consider whether simple ownership transfer suffices
- Prohibit macro overuse: avoid complex macros that harm debugging and readability
- Ensure library stability via explicit error propagation rather than panics

## Verification Points
- Are there zero `clippy` warnings?
- Does `cargo test` pass entirely?
- Does each `unsafe` block have a Safety comment?
- Are there no unnecessary `.clone()` or `Arc` usages?
