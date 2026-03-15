# Language: Go

## 핵심 원칙
- 에러 처리: 라이브러리에서 `panic` 금지, `fmt.Errorf("...: %w", err)`로 래핑
- Goroutine leak 방지: `context.Context`로 취소 전파, 고루틴 종료 보장
- 인터페이스는 사용 측(consumer)에서 정의 (최소 메서드 수 유지)
- 에러 체크는 명시적으로: `_, err :=` 패턴 후 즉시 `if err != nil` 처리
- 구조체 초기화 시 항상 필드명을 명시 (`S{field: val}`, 순서 의존 금지)

## 주의 사항
- 전역 변수 최소화: 패키지 레벨 상태는 테스트 격리를 어렵게 만듦
- `interface{}` / `any` 남용 금지: 타입 안정성을 희생하지 않음
- 채널 방향성을 함수 시그니처에 명시 (`chan<-`, `<-chan`)
- `init()` 함수 의존 최소화 (부작용 추적 어려움)

## 검증 포인트
- `go vet` 통과하는가?
- `staticcheck` 또는 `golangci-lint` 통과하는가?
- 모든 에러 반환값이 처리되는가?
- 고루틴이 모두 정상 종료되는가 (leak 없는가)?
