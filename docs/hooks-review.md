# MPL Hooks 코드 리뷰 (2026-03-30)

전체 품질: **8.2/10** — 성숙하고 일관성 있는 코드베이스. 소수의 수정 사항 존재.

## 리뷰 범위

- Main hooks: 13개 (`hooks/*.mjs`)
- Shared libraries: 16개 (`hooks/lib/*.mjs`)
- 테스트: 10개 (`hooks/__tests__/*.test.mjs`) — 이번 리뷰에서 미포함

## 일관성 매트릭스

| Hook | JSDoc | ESM Import | Error Handling | isMplActive | readStdin | JSON Output | Guard Clause |
|------|-------|------------|----------------|-------------|-----------|-------------|--------------|
| mpl-write-guard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-validate-output | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-phase-controller | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-keyword-detector | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-auto-permit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-permit-learner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-compaction-tracker | ✓ | ✓ | ✓ | ✓ | ✓ | **⚠ stderr** | ✓ |
| mpl-validate-seed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-sentinel-s0 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-sentinel-s1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| mpl-sentinel-s3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **mpl-hud** | ✓ | **✗** | ✓ | **✗** | **✗ custom** | ✓ | **✗** |
| **mpl-session-init** | ✓ | **✗** | ✓ | **✗** | **✗ custom** | **✗ special** | **⚠** |

## 이슈 목록

### P0: Critical (3건)

#### 1. `mpl-compaction-tracker.mjs:133,142` — stderr 출력

`console.error()` 사용으로 stdout JSON 계약 위반. hook은 stdout으로만 JSON 응답을 보내야 한다.

```javascript
// 현재 (문제)
console.error(`[MPL] compaction tracked: ${count}`)

// 수정
// stderr 출력 제거하거나 JSON 응답의 message 필드로 이동
```

#### 2. `mpl-hud.mjs`, `mpl-session-init.mjs` — isMplActive 가드 누락

MPL 비활성 시에도 실행됨. 불필요한 state 읽기 및 컨텍스트 낭비 가능.

- `mpl-hud.mjs`: isMplActive 체크 없이 전체 렌더링 수행
- `mpl-session-init.mjs`: state 검증 없이 handoff signal 읽기 시도

#### 3. `mpl-write-guard.mjs:222` — phase-scope 에러 무시

`getPhaseScope()` 실패 시 catch 블록이 silent — fail-open은 안전하지만 디버깅 불가.

```javascript
// 현재
try { scope = getPhaseScope(...) } catch { /* 무시 */ }

// 수정: 최소한 디버그 로깅 추가
try { scope = getPhaseScope(...) } catch (e) {
  // scope check skipped: {e.message} — logged for debugging
}
```

### P1: Moderate (4건)

#### 4. `mpl-phase-controller.mjs:48` — PLAN.md regex 불완전

```javascript
// 현재
const todoPattern = /###\s*\[\s*(x|X|FAILED|failed| )\s*\]/g

// 문제: [Failed], [FAIL] 등 변형을 놓침
// 수정: case-insensitive 플래그 사용
const todoPattern = /###\s*\[\s*(x|failed| )\s*\]/gi
```

#### 5. `escapeRegex()` 중복 정의

동일한 함수가 두 곳에 독립적으로 정의됨:
- `mpl-validate-seed.mjs:163`
- `hooks/lib/permit-store.mjs`

공유 유틸리티(`hooks/lib/utils.mjs` 등)로 추출 필요.

#### 6. 에러 메시지 포맷 불일관

| Hook | 포맷 |
|------|------|
| mpl-keyword-detector | `[MAGIC KEYWORD: MPL]` |
| mpl-validate-output | `[MPL VALIDATION FAILED]` |
| mpl-validate-seed | `<system-reminder>` |
| mpl-write-guard | `⚠️ [MPL Write Guard]` |

통일 권장: `[MPL:{hook-name}]` 또는 `[MPL]` 단일 prefix.

#### 7. stdin 구현 중복

| 파일 | 방식 | 타임아웃 |
|------|------|---------|
| `hooks/lib/stdin.mjs` | 공유 유틸리티 (표준) | 5000ms |
| `mpl-hud.mjs:39-50` | 인라인 커스텀 구현 | 1000ms |
| `mpl-session-init.mjs:19-31` | raw async iterator | 없음 |

hud는 타임아웃 차이 때문에 의도적 분리일 수 있으나, stdin.mjs에 timeout 파라미터 추가로 통합 가능.

### P2: Minor (3건)

#### 8. main() 함수 JSDoc 누락

전 hook의 main() 함수에 `@param`/`@returns` 태그 없음. 톱레벨 설명은 있으나 함수 시그니처 문서화 부족.

#### 9. `mpl-sentinel-s0.mjs:259` — underscore export

```javascript
export { extractContractSnippet as _extractContractSnippet }
```

underscore prefix지만 export됨 — 내부용이면 export 제거, 외부용이면 underscore 제거.

#### 10. HUD OAuth API 호출 최적화

매 호출마다 OAuth API 접근 (5분 TTL 캐시). 빈번한 statusLine 갱신 시 latency 영향 가능.

## 강점

- **13/13** hooks에 명확한 JSDoc 헤더와 try/catch 에러 핸들링
- **11/13** hooks가 동일한 `isMplActive()` + `readStdin()` + JSON output 패턴 사용
- atomic file write (tmp + rename) 패턴 일관 적용 (`mpl-state.mjs`, `permit-store.mjs`)
- 각 hook이 단일 책임 원칙 준수
- 미사용 import, TODO/FIXME 주석 없음

## 표준 패턴 (참고용)

모든 hook이 따라야 할 표준 구조:

```javascript
#!/usr/bin/env node
/**
 * Hook 이름 (이벤트 타입)
 * 한 줄 설명
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

async function main() {
  const input = await readStdin();
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Guard: MPL 비활성 시 즉시 종료
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // ... hook 로직 ...

  console.log(JSON.stringify({ continue: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
```

## 수정 우선순위 요약

| 우선순위 | 건수 | 예상 작업량 |
|---------|------|-----------|
| P0 Critical | 3 | S (각 5-10줄 수정) |
| P1 Moderate | 4 | M (리팩터링 포함) |
| P2 Minor | 3 | S |
| **합계** | **10** | — |
