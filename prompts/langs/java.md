# Language: Java

## Core Principles
- Use checked exceptions only when the caller can genuinely recover from them
- Prohibit returning `null`: return `Optional<T>` to express absence explicitly
- Actively use `record` classes as immutable data containers
- Simplify collection processing with the Stream API; extract chains longer than 3 steps into variables
- Prefer `final` fields and design immutable objects to prevent concurrency issues upfront

## Cautions
- Use Lombok minimally (`@Builder`, `@Value`, etc.); prefer `record`/`sealed` when they can replace it
- Utilize `instanceof` pattern matching (`instanceof Foo f`) and switch expressions (Java 17+)
- Prefer `java.util.concurrent` package over direct `synchronized` usage
- Always use try-with-resources for objects that require resource cleanup

## Verification Points
- Are there zero compilation warnings?
- Does SpotBugs or Checkstyle pass?
- Are there no methods that return `null`?
- Are checked exceptions not misused in unrecoverable situations?
