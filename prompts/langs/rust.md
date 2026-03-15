# Language: Rust

## 핵심 원칙
- Ownership/borrow 규칙을 준수하고 불필요한 `.clone()` 회피
- `Result`/`Option` 패턴 사용: `unwrap()` 금지, `?` 연산자 활용
- `unsafe` 블록은 최소화하고 사용 시 `// SAFETY:` 주석 필수
- Lifetime 명시는 컴파일러가 elision을 적용할 수 없을 때만 작성
- Trait 기반 추상화 우선: `dyn Trait`(동적)과 `impl Trait`(정적) 목적에 맞게 구분

## 주의 사항
- 에러 타입은 `thiserror`/`anyhow`로 정의하고 `Box<dyn Error>` 남용 금지
- `Arc<Mutex<T>>` 도입 전 단순 소유권 이전으로 해결 가능한지 검토
- 매크로 과용 금지: 디버깅과 가독성을 해치는 복잡한 매크로 회피
- 패닉이 아닌 명시적 에러 전파로 라이브러리 안정성 확보

## 검증 포인트
- `clippy` 경고가 0개인가?
- `cargo test` 전체 통과하는가?
- `unsafe` 블록 각각에 Safety 주석이 있는가?
- 불필요한 `.clone()` 또는 `Arc` 사용이 없는가?
