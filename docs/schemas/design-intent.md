# Design Intent Schema (`design-intent.yaml`)

**생성 시점**: Phase 0 (opus 강화)
**경로**: `.mpl/mpl/phase0/design-intent.yaml`
**소비자**: Seed Generator (chain-seed 생성 시 input으로 사용)
**관련**: #34 Phase 0 opus 강화, `[[specification-over-debugging]]` 원칙

## 개요

Phase 0 opus가 모든 phase의 **자연어 설계 의도**를 1회 선언. Seed Generator는 이 artifact를 참조하여 chain-seed를 생성. Per-phase opus 호출(Seed JIT) 대신 **Phase 0에 집중 투자**.

## 스키마

```yaml
design_intent:
  phase-{id}:
    rationale: string              # 이 phase가 존재하는 이유 (1-2 문장)
    blocks_on: [phase_id]          # 논리적/설계적 선행 조건 (Decomposer edge보다 높은 수준)
    probing_hints: [string]        # adversarial edge case 힌트 (Test Agent 소비)
    risk_notes: [string]            # 구현 시 주의점
    acceptance_criteria: [string]  # 사람이 읽는 완료 기준 (Seed가 machine-verifiable로 구체화)
    non_goals: [string]            # 이 phase가 하지 않는 것 (scope 경계)
    ambiguity_notes: [string]      # 해결 안 된 설계 질문 (있으면 Seed가 resolve 시도)
```

## 작성 원칙

1. **자연어 의도만**: 구체 파일/함수 지정 금지 (그건 Seed/Runner 영역)
2. **WHY 중심**: "왜 이 phase가 있는지", "왜 이 순서인지"
3. **Test-ready hints**: probing_hints는 Test Agent의 adversarial test 재료
4. **Non-goals 명시**: scope creep 방지

## 예시

```yaml
design_intent:
  phase-api-auth:
    rationale: |
      사용자 로그인 API 엔드포인트 — email/password 검증 후 JWT 발급.
      인증 상태는 session cookie + JWT dual-track.
    blocks_on: [phase-db-users]    # DB schema 먼저 필요
    probing_hints:
      - "동시 요청 시 race condition (user lookup + token issue)"
      - "timing attack 방어 (password compare constant-time)"
      - "rate limiting (brute force 방지)"
    risk_notes:
      - "password는 bcrypt cost ≥ 12"
      - "JWT secret은 env var, 코드 commit 금지"
    acceptance_criteria:
      - "올바른 credential로 로그인 성공 + token 발급"
      - "잘못된 credential 거부 (401)"
      - "lockout: 5회 실패 시 15분 차단"
    non_goals:
      - "OAuth2 socal login (후속 phase)"
      - "MFA (후속 phase)"
    ambiguity_notes:
      - "JWT expiration: 1h vs 24h 미결정 → Seed가 보안 정책 기반 결정"

  phase-ui-login:
    rationale: |
      로그인 UI — email/password 입력 + submit.
      submit 시 api-auth 호출, 성공 시 dashboard로 redirect.
    blocks_on: [phase-api-auth]
    probing_hints:
      - "submit 중복 전송 방지 (disabled state)"
      - "WebView 환경에서 window.prompt 차단 주의"
      - "password clipboard 잔류 방지"
    risk_notes:
      - "token은 httpOnly cookie로 저장 (XSS 방어)"
    acceptance_criteria:
      - "email format validation 통과"
      - "login 성공 → /dashboard redirect"
      - "실패 → error message 표시 (credential 구체 정보 노출 금지)"
    non_goals:
      - "Password reset UI (별도 phase)"
```

## Seed Generator와의 역할 분담

| 항목 | Phase 0 design-intent (opus 1회) | Seed Generator (opus per chain) |
|------|-----|-----|
| rationale | ✅ 자연어 의도 | — (참조만) |
| probing_hints | ✅ 추상 힌트 | — (그대로 전달) |
| acceptance_criteria | ✅ 사람용 | → machine-verifiable 변환 |
| contract_snippet | — | ✅ caller/callee/params 상세 |
| todo_structure | — | ✅ Runner가 따를 TODO |
| edge 세부 매핑 | — | ✅ Decomposer edge → contract 채움 |

## 재생성

Phase 0이 재실행되지 않는 한 불변. Discovery Agent가 architectural_discovery 판정 시 영향이 Phase 0까지 미치면 예외적으로 재생성 (rare).

## 검증

기존 `mpl-validate-output.mjs` 확장:
- 모든 phase가 design_intent에 등장
- 필수 필드 (rationale, acceptance_criteria)
- probing_hints / risk_notes 존재 (empty list 허용)
