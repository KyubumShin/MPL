# E2E Contract Annotation Schema (`@contract`, `@skip_reason`)

**적용 파일**: E2E 테스트 파일 (Playwright/Vitest/pytest 등)
**소비자**: Hook `mpl-require-e2e.mjs` (Tier C gate), MCP tool `mpl_diagnose_e2e_failure` (trace 분석)
**생성자**: 개발자가 테스트 파일 작성 시 직접 기재 (orchestrator/Test Agent가 초안 생성 가능)
**관련**: 0.16 S1-6, `user-contract.md` §scenarios

## 개요

모든 E2E 테스트는 어떤 UC(user case)를 검증하는지 `@contract` 애노테이션으로 선언해야 한다. 미선언 테스트는 기본(strict) 모드에서 Hard fail — missing coverage 로 처리된다.

**strict 디폴트 + opt-out** (Q10 확정):
- 기본값: `@contract` 없는 E2E 테스트는 Hard fail
- `.mpl/config.json` `e2e_contract_strict: false` 설정 시 warn 으로 degrade
- Legacy 프로젝트 upgrade 시 `mpl-doctor` 가 opt-out 가이드 출력

## Annotation 형식

### 표기 방법

언어/프레임워크별 형식. 모두 동등하게 인식된다.

| Language | Style | Example |
|---|---|---|
| TypeScript/JavaScript | JSDoc 블록 주석 바로 위 테스트 | `/** @contract UC-01 */\ntest('login', …)` |
| TypeScript/JavaScript | `// @contract UC-01` 한 줄 | `// @contract UC-01, UC-03\ntest('login', …)` |
| Python (pytest) | 데코레이터 위 주석 | `# @contract UC-01\ndef test_login():` |
| Python (pytest) | docstring 첫 줄 | `def test_login():\n    """@contract UC-01"""` |
| Go | 함수 위 주석 | `// @contract UC-01\nfunc TestLogin(t *testing.T) { … }` |
| Rust | 함수 위 주석 | `// @contract UC-01\n#[test]\nfn login_works() { … }` |

다중 UC 한 테스트에서 검증 가능: `@contract UC-01, UC-03` 또는 `@contract UC-01 UC-03` (쉼표/공백 모두 허용).

### 정규식

Hook 은 테스트 파일 내에서 다음 패턴을 scan:

```regex
@contract\s+([A-Z]+-\d{2,}(?:\s*,\s*[A-Z]+-\d{2,})*)
```

매치된 전체 그룹 1을 쉼표/공백 분리 후 UC-NN 토큰 리스트로 수집.

### Annotation 위치 규칙

1. **테스트 함수/블록 바로 앞** (즉시 선행) 에 위치해야 인식됨.
2. 파일 상단의 모듈 주석에서의 `@contract` 는 **파일 전체 fallback** 으로 처리 — 해당 파일 내 모든 테스트가 그 UC를 cover 한다고 가정. 여러 테스트를 일일이 애노테이션하기 귀찮은 smoke 테스트 파일에 유용.
3. 테스트-레벨 애노테이션이 있으면 그것이 우선. 파일-레벨 fallback 은 누락된 테스트에만 적용.

## @skip_reason Annotation

환경/네트워크/flaky 등 **정당 사유** 로 테스트를 skip 한 경우 기록한다. `skipIf`/`@pytest.mark.skip` 같은 언어별 메커니즘과 별도로 **항상 주석으로 표기**해야 한다.

### 표기 방법

```ts
// @contract UC-01
// @skip_reason ENV_API_DOWN
test.skip('integration with payment API', …);
```

```python
# @contract UC-05
# @skip_reason FLAKY_NETWORK
@pytest.mark.skip(reason="network flake, revisit")
def test_external_webhook(): …
```

### 허용 값

`user-contract.md` 의 `scenarios[*].skip_allowed` 목록과 교차 참조한다. 해당 시나리오에 정의된 값만 허용되며, 그 외는 **implementation-skip** 으로 취급되어 Hard fail.

표준 값(권장):

| 값 | 의미 |
|---|---|
| `ENV_API_DOWN` | 외부 API/서비스 가용 불가 (3rd-party 장애 포함) |
| `FLAKY_NETWORK` | 네트워크 타임아웃/지연 이슈 (CI 환경 한정) |
| `DEPENDENCY_MISSING` | 로컬 환경에 도구/바이너리 부재 (Docker/GPU 등) |
| `RATE_LIMIT` | 호출 속도 제한으로 CI 반복 실행 불가 |
| `OS_INCOMPATIBLE` | 특정 OS에서만 실행 가능한 테스트 |

**프로젝트 확장**: 위 외 값을 쓰려면 `user-contract.md scenarios[*].skip_allowed` 에 먼저 등록해야 한다.

### implementation-skip 금지

다음 사유로는 skip 할 수 없다. 발견 시 Hard fail.

- "TODO: not implemented yet"
- "refactor later"
- "known bug" (이건 xfail/pending 으로 다른 마커 사용)
- 사유 미기재 skip (`skip()` 만 호출)

`@skip_reason` 없이 skip 이 실행된 경우 hook 이 테스트 출력에서 감지하고 **Hard fail**.

## Hook 검증 로직

`mpl-require-e2e.mjs` (S3-1 수정 예정) 가 finalize Step 5.0 전/후 호출될 때 수행:

1. `.mpl/requirements/user-contract.md` 에서 `user_cases[status=included]` 의 UC-NN 전체 수집 → **expected coverage set**
2. E2E 테스트 파일 전체(`*.spec.*`, `*_test.*`, `test_*.*` 등) scan → `@contract` 애노테이션 수집 → **actual coverage set**
3. 차집합 (expected − actual) 이 비어있지 않으면:
   - `e2e_contract_strict: true` (디폴트) → Hard fail + 미커버 UC 목록 출력
   - `e2e_contract_strict: false` → warn
4. `@skip_reason` 이 `scenarios[*].skip_allowed` 에 없거나, skip 이 실행됐는데 `@skip_reason` 이 없으면 → Hard fail (strict) / warn (opt-out)
5. 정당 skip 카운트는 `state.e2e_skip_reasons[UC-NN][reason]++` 로 누적 (exp12 관측용)

## Producer 힌트 (Test Agent)

Test Agent 가 E2E 시나리오를 확장할 때:

```
1. user-contract.md scenarios[*].steps 를 기반으로 테스트 본문 생성
2. 테스트 함수 바로 앞에 `@contract UC-01, UC-03` 삽입 (covers: 리스트)
3. scenarios[*].skip_allowed 가 비어있으면 @skip_reason 을 쓰지 않음
4. 다중 UC cover 테스트는 가급적 rationale 주석 1줄 추가
```

## 예시

### TypeScript (Playwright)

```ts
// e2e/auth.spec.ts

/** @contract UC-01 */
test('user can log in with valid credentials', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'user@example.com');
  await page.fill('#password', 'pass');
  await page.click('text=Sign in');
  await expect(page).toHaveURL('/dashboard');
});

// @contract UC-02, UC-03
// @skip_reason ENV_API_DOWN
test.skip('password reset via email link', async ({ page }) => {
  // requires MailHog which is down in this CI stage
});
```

### Python (pytest)

```python
# @contract UC-01
def test_login_ok(client):
    r = client.post("/login", json={"email": "u@e.com", "password": "p"})
    assert r.status_code == 200

# @contract UC-04
# @skip_reason DEPENDENCY_MISSING
@pytest.mark.skip(reason="Docker not available on local dev")
def test_container_startup(docker_client):
    ...
```

## 파일-레벨 Fallback 예시

```ts
// e2e/smoke/home.spec.ts
/**
 * @contract UC-10
 * 홈 스모크 — 모든 테스트가 UC-10 의 일부.
 */

test('home loads', ...);       // inherits @contract UC-10
test('nav renders', ...);      // inherits
test('auth CTA present', ...); // inherits
```

## 관련 문서

- `docs/schemas/user-contract.md` (Tier A' — UC id와 scenarios)
- `agents/mpl-decomposer.md` Rule 6a (Tier B — covers 필드)
- Resume Plan v2 §3 S1-6, S3-1
- Decision `~/project/decision/2026-04-19-mpl-0.16-implementation-plan.md` (Tier C)
