# Chain Assignment Schema (`chain-assignment.yaml`)

**생성 시점**: Phase 0 후처리 (decomposer 출력 → chain 파생)
**경로**: `.mpl/mpl/chain-assignment.yaml`
**소비자**: `commands/mpl-run-execute.md` (Seed Generator 호출, Runner model 결정)
**관련**: #34 Chain Size Model Selection, AD-08 (#22 closed)

## 개요

Decomposer가 출력한 phase nodes + edges 그래프에서 **실행 단위인 chain**을 파생. 각 chain은 단일 Runner가 처리하며 model/baton-pass 정책이 적용됨.

## 스키마

```yaml
chains:
  - id: string                    # unique chain identifier (e.g., "chain-1", "solo-phase-7")
    phases: [string]              # ordered list of phase IDs in this chain
    model: "opus" | "sonnet"      # Runner model (chain size rule)
    baton_pass: boolean           # true if chain uses baton-pass mechanism
    pp_proximity: "pp_core" | "pp_adjacent" | "non_pp"  # dominant proximity in chain
    rationale: string             # why this chain grouping (1 line)
    blocks_on: [chain_id]         # prior chains whose handoffs this chain consumes (derived from cross-chain edges in decomposition)
```

### `blocks_on` 도출 규칙

Decomposition의 phase edges 중 **chain 경계를 넘는** 것들을 chain 수준으로 집계:
- phase A in chain-X → phase B in chain-Y (contract/data edge) ⇒ chain-Y.blocks_on에 chain-X 추가
- Intra-chain edges는 무시 (이미 chain 내부 순서로 보장됨)
- 결과는 chain-level DAG (cycle 없어야 함; decomposition phase-level DAG에서 파생됐으므로 자연히 acyclic)

`blocks_on`은 execute 단계에서 Seed Generator 호출 시 prev chain handoff 로딩 경로를 결정:
```
prev_handoffs = [
  Read(".mpl/mpl/chains/{c}/handoffs/*.yaml") for c in chain.blocks_on
]
```

## Chain Size Model Selection Rule

```
chain size ≥ 2                → opus (chain-scoped, baton_pass: true)
chain size = 1 + pp_core      → opus (복잡도 예외, baton_pass: false)
chain size = 1 + non-pp_core  → sonnet (isolated, baton_pass: false)
```

`pp_adjacent` isolated: Gate 강도 따라 결정 (default sonnet, override 가능).

## 파생 규칙 (Phase 0 post-processor)

1. **Edge 기반 연결성 분석**:
   - `contract` / `data` edges → strong connection (same chain 후보)
   - `sequence` / `resource` edges → weak connection (chain 경계 가능)

2. **Chain 경계 결정**:
   - pp_core phases는 가능한 한 연속 체인으로 묶음 (mental model 공유 이점)
   - non_pp isolated phase는 각각 solo chain
   - pp_adjacent: 앞뒤 chain이 pp_core면 흡수, 아니면 solo 또는 작은 chain

3. **Chain 크기 제한**:
   - max 5 phases per chain (context 부담 방지)
   - 초과 시 분할 (baton-pass로 연결)

## 예시

```yaml
chains:
  - id: "chain-1"
    phases: ["phase-2", "phase-3", "phase-4"]
    model: "opus"
    baton_pass: true
    pp_proximity: "pp_core"
    rationale: "login feature vertical slice — UI/API/DB 동시 설계 필요"
    blocks_on: []

  - id: "chain-2"
    phases: ["phase-5"]
    model: "opus"
    baton_pass: false
    pp_proximity: "pp_core"
    rationale: "isolated pp_core — 복잡도 예외 적용"
    blocks_on: ["chain-1"]         # phase-5 consumes a contract from phase-4

  - id: "solo-6"
    phases: ["phase-6"]
    model: "sonnet"
    baton_pass: false
    pp_proximity: "non_pp"
    rationale: "CI config update — isolated, low complexity"
    blocks_on: []
```

## 검증

Phase 0 post-processor가 파생 후:
- 모든 phase가 정확히 1개 chain에 속하는지 (exhaustive + disjoint)
- chain 내 phase 순서가 DAG topological 순서 준수
- Chain Size Model Rule 충족
- max chain size ≤ 5

위반 시 `[MPL] chain-assignment validation failed: ...` 에러로 pipeline 중단.
