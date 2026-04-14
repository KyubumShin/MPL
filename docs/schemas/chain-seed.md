# Chain Seed Schema (`chain-seed.yaml`)

**생성 시점**: Chain 시작 시 Seed Generator (opus) 1회 호출
**경로**: `.mpl/mpl/chains/{chain_id}/chain-seed.yaml`
**소비자**: Phase Runner (chain 내 모든 phase가 이 seed + handoff_history로 실행)
**재생성**: Discovery Agent `architectural_discovery` 판정 시 영향 phase만 부분 재생성
**관련**: #34 Chain-Scoped Seed (Option B)

## 개요

Chain 전체 phase를 한 번에 설계. Runner는 phase 진행 중 Seed 재호출 없이 chain-seed + handoff_history로 작업.

기존 per-phase JIT seed 대체. 호출 수 N → 1, cache warm 유지, chain 내 일관성 확보.

## 스키마

```yaml
chain_id: string
chain_context:                     # 전체 chain 수준 정보
  goal: string                     # chain 전체가 달성할 목표
  architecture_anchor: object      # (Decomposer에서 복사)
  chain_rationale: string          # 이 phase들이 왜 한 chain으로 묶였는지

phases:
  phase-{id}:
    goal: string                   # 이 phase의 구체 목표
    acceptance_criteria: [string]  # 검증 기준
    todo_structure:                # Phase Runner가 따를 TODO
      - { id, description, depends_on: [ids] }
    exit_conditions: [object]      # 완료 판정 (command/test/file_exists/grep 등)
    contract_snippet:              # 해당 phase의 contract 상세
      edges:
        - edge_id: string          # decomposition edge 참조
          caller: { file, symbol }
          callee: { file, symbol }
          params: { key: type }
          returns: { key: type }
    probing_hints: [string]        # adversarial test hints (Phase 0 design-intent에서 파생)
    phase0_context: object         # 관련 api-contracts/examples/type-policy 요약
    depends_on_prev:               # 이전 phase handoff에서 필요한 정보
      - { from_phase, artifact, usage }
```

## Seed Generator Input

```
- chain-assignment.yaml의 해당 chain 노드
- Decomposer 출력의 nodes + edges (해당 chain + 인접)
- Phase 0 design-intent.yaml (rationale / probing_hints / risk_notes)
- .mpl/pivot-points.md (해당 chain 관련 PP만)
- prev chain의 handoff-*.yaml (chain-scoped 의존성)
- phase0 artifacts (api-contracts, examples, type-policy, error-spec) — 해당 chain 관련만
```

## 생성 원칙

1. **Chain 일관성**: 모든 phase의 contract_snippet이 상호 일치 (caller가 다른 phase의 callee 참조 시 정확히 매칭)
2. **Phase 순서 인식**: 후행 phase가 선행 phase의 결과물(`depends_on_prev`)을 명시적 참조
3. **Discovery 예비**: probing_hints는 adversarial edge case용 (Test Agent가 소비)
4. **Runner 자가완결성**: Runner는 chain-seed + handoff만 있으면 Seed 재호출 없이 모든 phase 실행 가능

## 부분 재생성 (Discovery-Triggered)

Discovery Agent `architectural_discovery` 판정 시:
1. `discovery-patch.yaml`의 `affected_phases` 목록 확인
2. Seed Generator 재호출 시 input에 `discovery-patch.yaml` 포함
3. 영향받은 phase만 재생성, 나머지는 보존
4. 재생성된 `chain-seed.yaml`에는 `regenerated_at`, `regenerated_phases` 필드 추가

```yaml
chain_id: "chain-1"
regenerated_at: "2026-04-14T15:30:00Z"
regenerated_phases: ["phase-3", "phase-4"]
regeneration_trigger: "discovery-patch-001"
# ... 나머지 스키마 동일
```

## 검증

`hooks/mpl-validate-seed.mjs` (기존 hook 확장):
- 모든 phase가 chain-assignment의 해당 chain 멤버와 일치
- contract_snippet의 edges가 decomposition.yaml에 존재
- depends_on_prev가 실제 prev phase의 produces와 매칭
- 필수 필드 존재 (goal, acceptance_criteria, todo_structure, exit_conditions)
