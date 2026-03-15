# PM Skill Proposal for MPL Research Phase

## Motivation

현재 MPL의 리서치 단계는 기술적 분석에 집중되어 있지만, 실제 프로덕트 개발에서는 **요구사항 명확화**, **우선순위 설정**, **트레이드오프 분석**이 중요하다. PM(Product Manager) 스킬을 리서치 단계에 추가하면 더 명확한 스펙과 실행 가능한 계획을 얻을 수 있다.

---

## What PM Skill Does

PM 스킬은 사용자의 모호한 요청을 다음과 같이 변환한다:

### Input (Vague Request)
```
사용자 인증 기능 추가해줘
```

### Output (Structured Spec)

#### 1. User Stories
```
As a [user type]
I want [goal]
So that [benefit]

Example:
- As a new user, I want to sign up with email/password, so that I can access the app
- As a returning user, I want to log in, so that I can resume my session
- As a logged-in user, I want to log out, so that I can secure my account
```

#### 2. Acceptance Criteria (A/S/H Items)
```
Must-Have (MVP):
- [ ] User can sign up with email + password
- [ ] User can log in
- [ ] User can log out
- [ ] Session persists on refresh
- [ ] Password is hashed (bcrypt)

Should-Have (Phase 2):
- [ ] Email verification
- [ ] Password reset flow
- [ ] Remember me checkbox

Nice-to-Have (Future):
- [ ] Social login (Google, GitHub)
- [ ] 2FA
- [ ] OAuth provider
```

#### 3. Technical Constraints
```
- Database: PostgreSQL (existing)
- Auth library: Prefer Passport.js or NextAuth
- Token: JWT with httpOnly cookies
- Password: bcrypt with salt rounds >= 10
```

#### 4. Out of Scope (Explicit Boundaries)
```
- ❌ Admin user management (별도 태스크)
- ❌ Role-based permissions (별도 태스크)
- ❌ Multi-tenancy (필요 없음)
```

#### 5. Dependencies & Risks
```
Dependencies:
- User model must be created first
- Database migration needed

Risks:
- Session storage strategy (in-memory vs Redis)
- CORS configuration for auth endpoints
- CSRF protection needed
```

---

## Integration Options

### Option 1: Pre-Triage PM Interview (Recommended)

**Flow:**
```
User Request
  ↓
PM Interview (if request is vague) ← NEW
  ↓
Triage (pipeline score)
  ↓
PP Interview
  ↓
Phase 0 Enhanced
  ↓
Decompose & Execute
```

**When to trigger:**
- Vague keywords detected: "추가", "만들어줘", "구현", etc.
- No technical details in request
- User explicitly requests: `mpl pm <task>`

**Output:**
- PRD (Product Requirements Document)
- Saves to `.mpl/pm/requirements.md`

**Pros:**
- Early clarity reduces Phase 0 iterations
- Clear scope prevents scope creep
- User can review and approve before coding

**Cons:**
- Adds one more step (but fast ~1-2K tokens)

---

### Option 2: Extend PP Interview

**Current PP Interview:**
- PP-1 ~ PP-5: Technical pivot points (API design, error handling, types)

**Extended PP Interview:**
- PP-1 ~ PP-5: Technical pivot points (same)
- **PM-1**: User stories and acceptance criteria
- **PM-2**: MVP scope vs. future enhancements
- **PM-3**: Dependencies and risks

**Pros:**
- No new step, integrates seamlessly
- PP Interview already asks clarifying questions
- Single consolidated document

**Cons:**
- PP Interview becomes longer
- Mixes business and technical concerns

---

### Option 3: Standalone `/pm` Skill

**Usage:**
```
/mpl:pm <task>
```

**Output:**
- PRD document
- Can be used before or after `/mpl:mpl`

**Pros:**
- Completely optional
- User decides when to use
- Reusable for non-MPL tasks

**Cons:**
- User must remember to call it
- Not integrated into pipeline

---

## Proposed Implementation (Option 1)

### Step -2: PM Interview

**Trigger Conditions:**
- Request contains vague keywords: "추가", "만들어", "구현", "개선", etc.
- Request is < 50 characters (too short to be specific)
- No file names or technical terms mentioned
- User explicitly uses: `mpl pm <task>`

**Agent:** `mpl-pm-interviewer` (Haiku for speed)

**Prompt Template:**
```markdown
You are a Product Manager helping clarify requirements.

User Request: "{user_request}"

Extract:

1. **User Stories** (3-5 stories in "As a... I want... So that..." format)
2. **Acceptance Criteria** (Must/Should/Nice-to-Have, using A/S/H classification)
3. **Technical Constraints** (existing tech stack, libraries, patterns)
4. **Out of Scope** (what NOT to build)
5. **Dependencies** (what must exist first)
6. **Risks** (potential issues)

Ask clarifying questions if:
- Target user is unclear
- Success criteria is ambiguous
- Technical approach has multiple valid options

Output format: Markdown
Save to: .mpl/pm/requirements.md
```

**Output Schema:**
```yaml
pm_interview:
  user_stories:
    - role: "new user"
      goal: "sign up with email"
      benefit: "access the app"
  acceptance_criteria:
    must_have: [...]
    should_have: [...]
    nice_to_have: [...]
  technical_constraints:
    database: "PostgreSQL"
    auth_library: "Passport.js"
  out_of_scope: [...]
  dependencies: [...]
  risks: [...]
```

**Integration with Triage:**
- If PM Interview ran → pass requirements.md to Triage
- Triage considers PM scope when calculating pipeline_score
- Large scope (many user stories) → higher score → Standard/Frontier

---

## File Structure

```
.mpl/
├── pm/
│   ├── requirements.md       # PM Interview output (PRD)
│   ├── user-stories.yaml     # Structured user stories
│   └── scope.md              # In-scope vs out-of-scope
├── mpl/
│   ├── pivot-points.md       # Technical pivot points (Phase 0)
│   └── ...
```

---

## Example Flow

### User Request:
```
mpl 사용자 인증 추가
```

### Step -2: PM Interview (NEW)

**Output: `.mpl/pm/requirements.md`**
```markdown
# Product Requirements: User Authentication

## User Stories

1. **Sign Up**
   - As a new user
   - I want to sign up with email and password
   - So that I can create an account

2. **Log In**
   - As a returning user
   - I want to log in with my credentials
   - So that I can access my account

3. **Log Out**
   - As a logged-in user
   - I want to log out
   - So that I can secure my account

## Acceptance Criteria

### Must-Have (MVP)
- [A] User can sign up with email + password
- [A] Passwords are hashed with bcrypt
- [A] User can log in
- [A] User can log out
- [S] Session persists across page refreshes

### Should-Have (Phase 2)
- [S] Email verification on sign up
- [S] Password reset flow
- [S] "Remember me" option

### Nice-to-Have (Future)
- [H] Social login (Google, GitHub)
- [H] Two-factor authentication

## Technical Constraints

- **Database**: PostgreSQL (existing)
- **Auth Library**: Passport.js or NextAuth
- **Password Hashing**: bcrypt (salt rounds >= 10)
- **Session Storage**: JWT with httpOnly cookies

## Out of Scope

- ❌ Admin panel for user management
- ❌ Role-based access control (RBAC)
- ❌ Multi-organization support

## Dependencies

- User model must be created (models/User.ts)
- Database migration for users table
- Auth middleware for protected routes

## Risks

- **Session Strategy**: In-memory vs Redis (decide in Phase 0)
- **CORS**: Auth endpoints need proper CORS config
- **CSRF**: Need CSRF tokens for form submissions
```

### Step -1: Triage

Reads `requirements.md`:
- 3 user stories
- 5 must-have criteria
- Dependencies: 3 items

**Pipeline Score Calculation:**
```
file_scope = 3 files (User model, auth routes, middleware) → 0.3
acceptance_criteria = 5 must-haves → 0.35
dependencies = 3 → 0.2
risk_signal = "session storage", "CORS" → 0.15

pipeline_score = 0.3 + 0.35 + 0.2 + 0.15 = 1.0 → Frontier
```

### Step 0: PP Interview

Reads `requirements.md` and asks:

**Q1: Session Storage Strategy?**
- In-memory (simple, loses sessions on restart)
- Redis (scalable, persistent)
- Database (reliable, slower)

**User Answer:** Redis

**PP-1 Decision:**
```
Session Storage: Redis
Rationale: Need session persistence + horizontal scaling
Impact: Add redis dependency, configure connect-redis
```

### Step 1-4: Phase 0 → Decompose → Execute

Phase 0 generates:
- API contracts (POST /auth/signup, POST /auth/login, POST /auth/logout)
- Type policy (User interface, AuthRequest extends Request)
- Error specification (401 Unauthorized, 409 User Exists)

Decompose splits into:
- Phase 1: User model + migration
- Phase 2: Auth routes + middleware
- Phase 3: Session management (Redis)
- Phase 4: Tests + integration

---

## Token Estimate

**PM Interview (Haiku):**
- Input: ~500 tokens (user request + prompt)
- Output: ~1,500 tokens (PRD)
- **Total: ~2,000 tokens (~$0.001)**

**Savings:**
- Reduces Phase 0 iterations (fewer clarifying questions)
- Prevents scope creep (clear boundaries)
- Net savings: ~5-10K tokens on medium tasks

---

## When NOT to Use PM Skill

Skip PM Interview for:
- **Bug fixes**: "Fix null pointer in login handler"
- **Small refactors**: "Rename getUserById to findUserById"
- **Explicit specs**: User already provided detailed requirements
- **Frugal tier**: Detected by low pipeline score

---

## Implementation Checklist

- [ ] Create `agents/mpl-pm-interviewer.md`
- [ ] Add PM Interview step to `commands/mpl-run-phase0.md` (Step -2)
- [ ] Update `hooks/mpl-keyword-detector.mjs` to detect PM keywords
- [ ] Add `requirements.md` to Phase 0 context loading
- [ ] Update Triage to consider PM acceptance criteria count
- [ ] Add `.mpl/pm/` directory to state initialization
- [ ] Create `skills/pm/` for standalone usage
- [ ] Update documentation (README, design.md)

---

## Future Enhancements

### F-XX: User Feedback Loop
- After execution, ask user: "Does this meet your requirements?"
- Update `.mpl/pm/requirements.md` with feedback
- Re-run phases if requirements changed

### F-XX: PRD Templates
- Allow custom PRD templates per project type
- `.mpl/pm/templates/api.md`, `frontend.md`, etc.

### F-XX: PM Agent Specialization
- `mpl-pm-api`: API-focused requirements
- `mpl-pm-ui`: UI/UX-focused requirements
- `mpl-pm-data`: Data pipeline requirements

---

## Alternatives Considered

### A1: Always Run PM Interview
- **Pros**: Consistency, always have clear requirements
- **Cons**: Unnecessary for bug fixes, adds latency

### A2: User Chooses PM Mode
- **Pros**: User control
- **Cons**: Extra cognitive load, may forget to enable

### A3: Post-Execution PM Review
- **Pros**: Validates implementation matches requirements
- **Cons**: Too late, rework is expensive

**Decision: Option 1 (Pre-Triage PM Interview with smart triggers)**

---

## Open Questions

1. Should PM Interview output be machine-readable (YAML) or human-readable (Markdown)?
   - **Proposal**: Markdown for user review, YAML metadata for pipeline

2. How to handle requirements changes mid-execution?
   - **Proposal**: Lock requirements after Phase 0, log changes to `requirements-v2.md`

3. Should PM Interview be interactive (ask user) or autonomous (infer from context)?
   - **Proposal**: Hybrid - infer when possible, ask only if ambiguous

4. Should PM skill integrate with existing tools (Linear, Jira)?
   - **Proposal**: Future enhancement, export PRD to issue tracker

---

## References

- [Product Requirements Document (PRD) Template](https://www.atlassian.com/software/confluence/templates/product-requirements-document)
- [User Story Mapping](https://www.jpattonassociates.com/user-story-mapping/)
- [INVEST Criteria](https://en.wikipedia.org/wiki/INVEST_(mnemonic))
- MPL Design Doc: `docs/design.md`
- MPL Roadmap: `docs/roadmap/overview.md`

---

**Status**: Proposal (2026-03-12)
**Author**: KyubumShin
**Next Steps**: Review with team, prototype PM Interview agent
