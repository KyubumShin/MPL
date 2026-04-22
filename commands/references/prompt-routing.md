---
description: F-28 domain routing + F-39 4-Layer prompt composition protocol (progressive disclosure reference)
---

# Phase Runner Prompt Routing Protocol (F-28 + F-39)

**Loaded by**: `commands/mpl-run-execute.md` Step 4.2.1 when dispatching a Phase Runner.
**Purpose**: map `phase_domain` (F-28) + subdomain/task-type/language (F-39) to the domain prompt path and 4-Layer context injection into the Phase Runner dispatch prompt. Model routing heuristics (F-26) also live here.

The protocol below was inlined in `mpl-run-execute.md` before v0.17 WS-3B (#68) and now lives here to keep execute.md's core loop readable (~810L) while preserving the full routing spec for dispatch time.

---


The Decomposer (Step 3) assigns `phase_domain` tags to each Phase.
When dispatching a Phase Runner, the prompt and model are dynamically selected based on the domain.

#### phase_domain Tag List

| Domain | Description | Specialized Prompt | Model |
|--------|-------------|-------------------|-------|
| `db` | DB schema, migration, queries | SQL safety, migration rollback, indexes | sonnet |
| `api` | API endpoints, routing, middleware | RESTful rules, error codes, auth | sonnet |
| `ui` | Frontend, components, styling | Accessibility, responsive, state management | sonnet |
| `algorithm` | Complex logic, optimization, data structures | Time/space complexity, edge cases | **opus** |
| `test` | Writing tests, test infrastructure | Coverage, isolation, mocking strategy | sonnet |
| `infra` | Config, CI/CD, build, deployment | Env vars, Docker, security | sonnet |
| `general` | Unclassifiable or mixed | General (existing behavior) | sonnet |

#### Routing Protocol

```pseudocode
function dispatch_phase_runner(phase):
  domain = phase.phase_domain || "general"
  subdomain = phase.phase_subdomain || null
  task_type = phase.phase_task_type || null
  lang = phase.phase_lang || null

  # 1. Model selection
  if domain == "algorithm" and phase.complexity in ["L", "XL"]:
    model = "opus"
  else:
    model = "sonnet"  # default

  # 2. 4-Layer prompt composition (F-39)
  domain_prompt = load_domain_prompt(domain)
  subdomain_prompt = subdomain ? load_subdomain_prompt(domain, subdomain) : ""
  task_prompt = task_type ? load_task_prompt(task_type) : ""
  lang_prompt = lang ? load_lang_prompt(lang) : ""

  composed_prompt = compose_layers(domain_prompt, subdomain_prompt, task_prompt, lang_prompt)

  # 3. Dispatch Phase Runner
  phase_runner = dispatch(
    agent = "mpl-phase-runner",
    model = model,
    context = assemble_context(phase) + composed_prompt,
    phase_definition = phase
  )

  return phase_runner
```

#### Domain-Specific Prompt Format

`.mpl/prompts/domains/{domain}.md` (orchestrator injects into Phase Runner context):

```markdown
# Domain: {domain}
## Core Principles
- {domain-specific principle 1}
- {domain-specific principle 2}

## Cautions
- {common pitfall 1}
- {common pitfall 2}

## Verification Points
- {what to verify for this domain}
```

Example — `db.md`:
```markdown
# Domain: DB
## Core Principles
- Migrations must always be rollback-able
- Consider data size when adding indexes
- Schema changes must maintain backward compatibility with existing data

## Cautions
- DROP TABLE/COLUMN is irreversible — isolate in a separate Phase
- Do not mix ORM migrations with raw SQL
- Minimize transaction scope

## Verification Points
- Do both migration up and down succeed?
- Is it compatible with existing seed/fixture data?
- Are indexes appropriate for the query patterns?
```

#### 4-Layer Prompt Path Resolution (F-39)

Each layer is searched in two locations (in priority order):

| Layer | Project-specific custom | Plugin default |
|-------|------------------------|---------------|
| Domain | `.mpl/prompts/domains/{domain}.md` | `MPL/prompts/domains/{domain}.md` |
| Subdomain | `.mpl/prompts/subdomains/{domain}/{subdomain}.md` | `MPL/prompts/subdomains/{domain}/{subdomain}.md` |
| Task Type | `.mpl/prompts/tasks/{task_type}.md` | `MPL/prompts/tasks/{task_type}.md` |
| Language | `.mpl/prompts/langs/{lang}.md` | `MPL/prompts/langs/{lang}.md` |

Each layer is **optional** — skip if file doesn't exist.
At minimum, the Domain layer always exists (guarantees existing F-28 behavior).

#### When Domain Prompt Is Absent

If `.mpl/prompts/domains/` directory or the corresponding domain file doesn't exist:
- Use generic prompt (same as existing behavior)
- Domain prompts are **optional extensions** — no impact on pipeline operation if absent

#### 4-Layer Context Injection into Phase Runner Prompt (F-39)

Add 4-Layer section to Step 4.2 Phase Runner dispatch prompt:

```
## Domain Context (F-28 + F-39)
Domain: {phase.phase_domain or "general"}
{domain_prompt_content or "General — no domain-specific prompt"}

## Subdomain Context (F-39)
Subdomain: {phase.phase_subdomain or "N/A"}
{subdomain_prompt_content or ""}

## Task Type Context (F-39)
Task Type: {phase.phase_task_type or "N/A"}
{task_prompt_content or ""}

## Language Context (F-39)
Language: {phase.phase_lang or "N/A"}
{lang_prompt_content or ""}
```

Integration with existing `phase_model` logic:
```
// Merge existing complexity-based routing with domain-based routing
phase_model = determine_model(phase):
  // 1. Existing rule: L complexity or architecture tag → opus
  if phase.complexity == "L" || phase.tags.includes("architecture"):
    return "opus"
  // 2. F-28 rule: algorithm domain + L/XL → opus
  if phase.phase_domain == "algorithm" and phase.complexity in ["L", "XL"]:
    return "opus"
  // 3. Default
  return "sonnet"
```

