# Language: Python

## 핵심 원칙
- 모든 함수 시그니처에 타입 힌트 필수 (`def fn(x: int) -> str:`)
- `async`/`await` 일관성 유지: sync/async 혼용 시 블로킹 위험 주의
- f-string 사용 (`f"{val}"`) — `format()`, `%` 포매팅 지양
- Pythonic 관용구 우선: list comprehension, context manager(`with`), `dataclass`
- 가상환경 사용 필수, 의존성은 `requirements.txt` 또는 `pyproject.toml`에 고정

## 주의 사항
- 가변 기본 인수 금지: `def fn(items=[])` → `def fn(items=None)` 패턴 사용
- 예외는 구체적인 타입으로 잡기 (`except Exception:` 남용 금지)
- `__all__` 정의로 퍼블릭 API 명시 (큰 모듈)
- 전역 변수와 모듈 레벨 부작용 최소화

## 검증 포인트
- `mypy` 또는 `pyright` 타입 체크 통과하는가?
- `ruff` 린트 통과하는가?
- `async` 함수가 적절한 이벤트 루프 내에서 호출되는가?
- 의존성이 버전 고정되어 재현 가능한가?
