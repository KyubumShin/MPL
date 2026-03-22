# DeepAgent vs MPL: TODO/Task Management Comparative Analysis

## Executive Summary

As of March 2026, three major agent frameworks have adopted different approaches to TODO/Task management:

1. **LangChain Deep Agents**: Agents autonomously write TODOs via `write_todos` tool then execute
2. **RUC DeepAgent**: Autonomously proceeds in an integrated reasoning stream without TODO decomposition
3. **MPL v3.2 (Sprint 3)**: Task tool-based TODO management (F-23), parallel execution support (F-13)

---

## 1. LangChain Deep Agents' `write_todos`

### Concept

A tool for agents to autonomously decompose work into TODOs and track progress.

### Usage Pattern

```python
# Agent calls write_todos
write_todos([
  {"content": "Implement user model", "status": "pending"},
  {"content": "Add auth routes", "status": "pending"},
  {"content": "Write tests", "status": "pending"}
])

# Agent executes and updates
write_todos([
  {"content": "Implement user model", "status": "completed"},
  {"content": "Add auth routes", "status": "in_progress"},
  {"content": "Write tests", "status": "pending"}
])
```

### Characteristics

**Advantages:**
- Agents autonomously create plans
- Progress tracking automated
- Progress visibility provided to users

**Disadvantages:**
- "Trapped" in TODO list (limitation acknowledged in LangChain docs)
- State synchronization between agents impossible (single agent only)
- No parallel execution support
- No dependency tracking between TODOs

### Difference from MPL

| Feature | Deep Agents | MPL (F-23) |
|---------|------------|-----------|
| **TODO creation** | Agent itself | Phase Runner (planning) → Task tool |
| **Parallel execution** | Impossible | Possible (F-13: Background Execution) |
| **Inter-agent sync** | Impossible (single agent) | Possible (Task tool state sharing) |
| **Dependency tracking** | None | Possible (Task depends_on) |
| **File conflict detection** | None | Auto-detect + sequential enforcement |

---

## 2. RUC DeepAgent's Integrated Reasoning Stream

### Concept

Without decomposing into TODOs, autonomously thinks-discovers tools-executes in a **single integrated reasoning stream**.

### Philosophy

> "Abandoning ReAct's fixed Reason-Act-Observe cycle, the model sees the full problem and progresses dynamically"

### Memory Folding and TODOs

RUC DeepAgent does not explicitly create TODOs, but the **Memory Folding** mechanism plays a similar role:

```
Episodic Memory: "Phase 1 complete (User model implemented)"
Working Memory: "Currently in Phase 2 (auth routes)"
Tool Memory: "Passport.js used successfully, JWT configuration complete"
```

### Difference from MPL

| Feature | RUC DeepAgent | MPL |
|---------|--------------|-----|
| **Decomposition method** | Implicit (inside model) | Explicit (Decomposer → Phase Plan) |
| **Progress tracking** | Memory Folding (3-tier) | RUNBOOK + Task tool |
| **Verification method** | RL-based (ToolPO) | 3-Gate (Tests, Review, PP) |
| **Transparency** | Low (black box) | High (all Phase/TODO recorded) |
| **Reproducibility** | Uncertain (depends on RL training) | High (Phase Plan reusable) |

---

## 3. MPL Sprint 3 (F-23): Task-based TODO Management

### Background

Until MPL v3.1, TODOs were managed with Markdown checkboxes in `mini-plan.md`:

```markdown
## Mini Plan

- [ ] TODO-1: Implement User model
- [ ] TODO-2: Add auth routes
- [ ] TODO-3: Write tests
```

**Problems (same as LangChain Deep Agents):**
- Phase Runner gets trapped in checkbox list
- State synchronization between workers impossible
- No parallel execution support
- Difficult to dynamically add/modify TODOs

### F-23: Task Tool Transition

In Sprint 3, `mini-plan.md` → **Task tool** transition:

```javascript
// Phase Runner creates tasks
TaskCreate({
  title: "Implement User model",
  description: "Create User schema with email/password",
  status: "pending",
  assignee: "mpl-worker-1",
  files: ["models/User.ts"]
})

TaskCreate({
  title: "Add auth routes",
  description: "POST /auth/signup, /login, /logout",
  status: "pending",
  assignee: "mpl-worker-2",
  files: ["routes/auth.ts"],
  depends_on: ["task-1"] // Dependency!
})

// Worker updates status
TaskUpdate({
  task_id: "task-1",
  status: "completed"
})
```

### Key Improvements

**1. Inter-worker state synchronization**
```
Worker 1: TaskUpdate(task-1, "completed")
Worker 2: TaskList() → confirm task-1 complete → task-2 can start
```

**2. Parallel execution (F-13: Background Execution)**
```javascript
// Independent TODOs executed in parallel
if (task.files don't overlap with other task.files) {
  Task({
    run_in_background: true,
    subagent_type: "general-purpose",
    prompt: "Implement " + task.title
  })
}
```

**3. Automatic file conflict detection**
```
task-1: files=["models/User.ts"]
task-2: files=["routes/auth.ts"]  ← independent, parallel possible

task-3: files=["models/User.ts"]  ← conflicts with task-1, sequential enforced
```

**4. Dynamic TODO addition**
```javascript
// Worker discovers new TODO during execution
TaskCreate({
  title: "Add email validation",
  description: "Discovered during auth route implementation",
  status: "pending"
})
```

---

## 4. Detailed Comparison Table

### TODO Management Method

| Item | Deep Agents | RUC DeepAgent | MPL (Sprint 3) |
|------|------------|--------------|---------------|
| **Decomposition source** | Agent autonomously | Implicit (internal) | Decomposer (explicit) |
| **Storage format** | In-memory | Memory Folding | Task tool (persistent) |
| **Dependency tracking** | ❌ None | ❌ None | ✅ `depends_on` |
| **Parallel execution** | ❌ Impossible | ❌ Single stream | ✅ F-13 supported |
| **Inter-worker sync** | ❌ Single agent | ❌ Single agent | ✅ Task state sharing |
| **File conflict detection** | ❌ None | ❌ None | ✅ Auto-detect |
| **Dynamic TODO addition** | ✅ Possible | ✅ Autonomous | ✅ TaskCreate |
| **Progress tracking** | `write_todos` | Memory Folding | TaskList + RUNBOOK |

### Context Management

| Item | Deep Agents | RUC DeepAgent | MPL |
|------|------------|--------------|-----|
| **Memory structure** | Auto-summary | Episodic/Working/Tool | State Summary + Phase Decisions |
| **Phase isolation** | ❌ None | ❌ Single stream | ✅ Independent session per Phase |
| **Context contamination** | Possible (long conversation) | Mitigated by Memory Folding | Impossible (phase isolation) |
| **Search method** | RAG (automatic) | Tool Memory | F-24: Self-Directed Search |

### Verification Method

| Item | Deep Agents | RUC DeepAgent | MPL |
|------|------------|--------------|-----|
| **Testing** | User-defined | RL evaluation | Gate 1 (auto tests) |
| **Code review** | None | None | Gate 2 (8-category) |
| **Spec compliance** | None | None | Gate 3 (PP Compliance) |
| **Learning** | None | ToolPO (RL training) | Run-to-Run Learnings (F-11) |

---

## 5. "Seeing like an Agent" Lessons

### TodoWrite → Task Transition (F-23)

Problem acknowledged in LangChain Deep Agents documentation:

> "Agents get trapped in TODO lists, and inter-agent communication is impossible"

MPL Sprint 3 solution:
- **TodoWrite deprecated** → Task tool adopted
- State synchronization between workers possible
- Parallel execution support (F-13)
- Dependency tracking (`depends_on`)

### RAG → Self-Directed Search (F-24)

Previous MPL (v3.1):
```
Orchestrator assembles context then injects into Phase Runner
→ "given context" paradigm
```

Sprint 3 (F-24):
```
Phase Runner directly explores via scope-bounded search
→ "self-directed search" paradigm
```

**Advantages:**
- Phase Runner reads/greps only the needed context
- Prevents unnecessary context loading (token savings)
- Maintains isolation principle (search only within impact files scope)

**Comparison with RUC DeepAgent:**
- DeepAgent: Autonomous exploration in integrated reasoning stream
- MPL: Scope-bounded (per-phase impact files scope)

---

## 6. Hybrid Approach Proposal

### MPL + DeepAgent Memory Folding

Expand current MPL's State Summary to 3 tiers:

```
.mpl/mpl/memory/
├── episodic.md      # Completed Phase summary (RUC's Episodic Memory)
├── working.md       # Current Phase TODOs + short-term plan (Working Memory)
└── tool.md          # Tool usage patterns (Tool Memory)
```

**Phase Runner protocol modification:**
```markdown
# Phase Runner Context Loading

1. Load episodic.md (previous Phase summary)
2. Load working.md (current TODO list)
3. Load tool.md (tool success/failure patterns)
4. Self-directed search (F-24) for current phase files
```

### MPL + Deep Agents `write_todos`

Maintain F-23 Task tool, but Phase Runner plans internally in `write_todos` style:

```javascript
// Phase Runner internal planning (not visible to user)
const internalPlan = [
  "Implement User model",
  "Add auth routes",
  "Write tests"
]

// But dispatches via Task tool for orchestration
for (const item of internalPlan) {
  TaskCreate({ title: item, ... })
}
```

**Advantages:**
- Phase Runner autonomy preserved
- Orchestrator parallel execution control preserved
- Inter-agent synchronization preserved

---

## 7. Experiment Ideas

### Experiment 1: Memory Folding Integration

**Goal:** Integrate RUC DeepAgent's Memory Folding into MPL

**Implementation:**
1. Create `.mpl/mpl/memory/` directory
2. Update episodic.md on Phase completion
3. Dynamically update working.md during Phase Runner execution
4. Record tool usage success/failure in tool.md

**Verification:**
- Reduced token usage (compared to State Summary)
- Shorter context loading time on Phase transition
- Improved retry success rate via tool.md reference in Fix Loop

### Experiment 2: Unified Reasoning Stream (optional)

**Goal:** Apply RUC DeepAgent-style unified reasoning to Frugal tier

**Implementation:**
1. Skip Phase decomposition in Frugal tier
2. Single agent proceeds with unified reasoning
3. Manage long conversations with Memory Folding

**Verification:**
- Frugal tier token usage reduction (current ~8-15K → ~5-10K)
- Maintain simple task success rate (95%+)
- Eliminate Phase decomposition overhead

### Experiment 3: Task Tool + RL Learning

**Goal:** Apply RUC's ToolPO to MPL Task tool

**Implementation:**
1. Collect Task success/failure data (.mpl/memory/task-results.jsonl)
2. Learn success patterns (which file combinations can run in parallel?)
3. Optimize TODO decomposition with learned patterns on next execution

**Verification:**
- Improved parallel execution efficiency (more TODOs can run in parallel)
- Reduced file conflict false positives
- Reduced execution time

---

## 8. Conclusion

### Lessons from Deep Agents

✅ **Adoptable:**
- `write_todos` concept (MPL already solved via F-23)
- Automatic context summarization (MPL has similar approach with State Summary)

❌ **Not adoptable:**
- Single agent constraint (MPL requires Worker parallel execution)
- No inter-TODO dependencies (MPL requires inter-Phase dependencies)

### Lessons from RUC DeepAgent

✅ **Adoptable:**
- Memory Folding (3-tier memory structure) ← **strongly recommended**
- Self-directed search (aligns with MPL F-24)
- Tool Memory (learning tool usage patterns) ← **synergy with F-11**

❌ **Not adoptable:**
- Unified reasoning stream (conflicts with MPL's phase isolation philosophy)
- RL-based training (MPL prefers 3-Gate verification)

### MPL's Strengths

**1. Structured TODO management (F-23):**
- Worker synchronization via Task tool
- Dependency tracking (`depends_on`)
- Parallel execution (F-13)

**2. Phase isolation:**
- Context contamination impossible
- Independent verification per phase
- Failure propagation blocked

**3. Transparency:**
- All Phase/TODO records
- Phase Decisions tracking
- Session continuity via RUNBOOK

### Final Recommendations and Execution Status

**✅ Added to roadmap (F-25, Sprint 5):**
1. **Memory Folding Integration** (Experiment 1)
   - Create `.mpl/mpl/memory/episodic.md`
   - Learn tool usage patterns via tool.jsonl
   - Use alongside State Summary
   - **Status**: Added to `docs/roadmap/overview.md` (F-25), `docs/roadmap/sprints.md` (Sprint 5) ✅
   - **Priority**: HIGH
   - **Expected effect**: 70%+ token savings for Phase 5+ executions

**📄 Preserved as documentation only (reference):**
2. **Unified Reasoning for Frugal** (Experiment 2)
   - Apply unified reasoning only to Frugal tier (skip Phase decomposition)
   - Standard/Frontier maintain current approach
   - Verify effectiveness with A/B testing
   - **Rationale**: Possible conflict with MPL philosophy (phase isolation), requires long-term research
   - **Status**: Analysis preserved in this document (Section 2, 6)
   - **Priority**: LOW (long-term experiment)

3. **Pattern Learning (prompt-based)** (Experiment 3 revised)
   - Collect Task success/failure patterns
   - Learn parallel execution optimization (prompt injection)
   - Integrate with F-11 Run-to-Run Learnings
   - **Rationale**: Direct RL tuning not possible, but prompt-based learning is feasible. F-25 (tool.jsonl) must precede
   - **Status**: Revised proposal preserved in this document (Section 3, 6). To be reviewed after F-25 completion
   - **Priority**: MEDIUM (after F-25)

---

## References

### DeepAgent (RUC-NLPIR)
- GitHub: https://github.com/RUC-NLPIR/DeepAgent
- ArXiv: https://arxiv.org/abs/2510.21618

### LangChain Deep Agents
- GitHub: https://github.com/langchain-ai/deepagents
- Docs: https://docs.langchain.com/oss/python/deepagents/overview
- Blog: https://blog.langchain.com/deep-agents/

### MPL Internal Docs
- Sprint 3: `docs/roadmap/sprints.md`
- F-23: Task-based TODO management
- F-24: Self-Directed Context
- F-13: Background Execution

### "Seeing like an Agent"
- TodoWrite → Task lessons
- RAG → Self-directed search lessons

---

**Date**: 2026-03-12
**Author**: KyubumShin
**Version**: v1.1
**Status**: Analysis complete, Experiment 1 reflected in roadmap (F-25), Experiment 2/3 preserved as reference documentation
