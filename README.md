# ai-agent-starter

[![CI](https://github.com/kevinmakwana/ai-agent-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinmakwana/ai-agent-starter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small, framework-free **tool-calling agent** for a fictional store, "Acme Shop", built with NestJS, Next.js and Postgres. It answers support questions by calling schema-validated tools against a real database, enforces guardrails in code (not in the prompt), parks risky actions like refunds until a human approves them, and persists every run as an inspectable trace. It runs end to end with **zero API keys** thanks to a deterministic offline mock provider; OpenAI and Anthropic are one env var away.

![Chat, live agent trace and a refund waiting for approval](docs/screenshot.png)

<details>
<summary>Reviewer view: approving a pending refund</summary>

![Approvals tab with the agent's reasoning and order context](docs/approvals.png)

</details>

## Why this exists

- **The agent loop is ~150 lines you can read** ([runner.ts](apps/api/src/agent/runner.ts)): no LangChain, no hidden prompts, no magic. Good starting point for understanding what agent frameworks actually do.
- **Guardrails live in code.** The conversation is bound to one customer, tool arguments are JSON-schema validated before execution, unknown tools are rejected, refunds can't exceed the order total minus earlier refunds (re-checked in a row-locking transaction at approval time), and runs have a step limit.
- **Human-in-the-loop done properly.** Risky tool calls become `pending_approval` actions, the run pauses (and survives restarts, since history is rebuilt from Postgres), and `POST /approvals/:id` resumes it.
- **Everything is a trace.** Every run stores each step: role, content, tool, args, result, latency and tokens.
- **Offline by default.** A rule-based mock planner makes the demo, tests and CI deterministic and free; real providers are plain `fetch` adapters behind a one-method interface.

## Architecture

```mermaid
flowchart LR
  subgraph Web["Next.js (apps/web)"]
    UI["Conversations · Chat · Trace · Approvals"]
  end
  subgraph API["NestJS (apps/api)"]
    HTTP["HTTP controllers<br/>(class-validator)"]
    Runner["AgentRunner<br/>loop · max 8 steps"]
    Guard["Guardrails + JSON-schema<br/>tool validation"]
    Tools["Tools: get_customer · list_orders · get_order<br/>create_ticket · issue_refund (risky)"]
    HTTP --> Runner
    Runner --> Guard --> Tools
  end
  Provider{{"ChatProvider"}}
  Mock["Mock (offline)"]
  OpenAI["OpenAI"]
  Anthropic["Anthropic"]
  DB[("Postgres<br/>shop data · runs · steps · actions")]

  UI -- "/api/* proxy" --> HTTP
  Runner --> Provider
  Provider --- Mock
  Provider --- OpenAI
  Provider --- Anthropic
  Tools --> DB
  Runner -- "persist every step" --> DB
  Runner -. "risky call → pending_approval, run pauses" .-> UI
  UI -. "POST /approvals/:id → resume" .-> HTTP
```

## Quick start

Requires Node 22+ and Docker.

```bash
cp .env.example .env        # optional: defaults work; set DB_PORT if 5432 is busy
npm install
npm run db:up && npm run seed && npm run dev
```

Open <http://localhost:3000>, start a chat as *Ava Brooks* and try:

1. `Show my recent orders`: a plain tool call.
2. `Order #1 arrived damaged, please refund it`: `get_order` → `issue_refund` pauses for approval; approve it in the **Approvals** tab and the run resumes.
3. `Show me order #2`: blocked, that order belongs to another customer.
4. `refund order #1 for $500`: blocked by the over-refund guardrail before it ever reaches a human.

Seed data: 10 customers, 30 orders (order *N* belongs to customer `((N-1) % 10) + 1`), one prior partial refund on order 12.

### Using a real model

```bash
# .env
LLM_PROVIDER=anthropic          # or openai
ANTHROPIC_API_KEY=sk-ant-...
```

The adapters use the models in `ANTHROPIC_MODEL` / `OPENAI_MODEL`; I only exercised them against recorded request/response shapes in unit tests, not live endpoints, so treat them as a starting point.

## API

| Method & path | Purpose |
| --- | --- |
| `POST /conversations` | Create a conversation bound to `{ customerId }` |
| `GET /conversations` | List conversations (with pending-approval counts) |
| `GET /conversations/:id` | Full trace: runs → steps, plus approvals |
| `POST /conversations/:id/messages` | Send `{ content }`; runs the agent until it answers or pauses (`409` while an approval is pending) |
| `GET /approvals?status=pending` | List approvals (`pending` \| `approved` \| `rejected` \| `all`) with customer, order and reasoning context |
| `POST /approvals/:id` | `{ decision: "approve" \| "reject", note? }`; executes the parked call and resumes the run (`409` if already decided) |
| `GET /customers` | Customers for the UI picker (extra) |
| `GET /health` | API + database + active provider |

Validation uses `class-validator` with `whitelist` + `forbidNonWhitelisted` (unknown fields → `400`). Upstream LLM failures return `502` with a clear message and mark the run `failed`.

## Configuration

One root `.env` (see [.env.example](.env.example)); everything is optional.

| Variable | Default | Description |
| --- | --- | --- |
| `DB_PORT` | `5432` | Host port for the Postgres container |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `postgres` / `postgres` / `aiagent` | Database credentials |
| `DATABASE_URL` | built from the above | Full connection string override |
| `API_PORT` | `3001` | NestJS port |
| `API_URL` | `http://localhost:3001` | Where Next.js proxies `/api/*` |
| `AGENT_MAX_STEPS` | `8` | Max model calls per run |
| `LLM_PROVIDER` | `mock` | `mock` \| `openai` \| `anthropic` |
| `MOCK_DELAY_MS` | `150` | Artificial mock latency so the live trace is visible |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | – / `gpt-4o-mini` / OpenAI URL | OpenAI (or compatible) settings |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | – / `claude-sonnet-5-5` | Anthropic settings |

## Testing

```bash
npm run typecheck
npm test                                  # unit tests; e2e is skipped without a DB URL
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent npm test   # + e2e
```

- **Unit (Jest):** tool schema validation, guardrail rules (cross-customer access and over-refund blocked), provider adapters, and the agent loop with the mock provider: *lookup → refund request → pending approval → approve → refund recorded*, plus rejection, step limit, unknown tools and provider failure.
- **E2E:** the same approval flow over HTTP against real Postgres, plus input validation, the approval-time balance re-check and the `502` mapping. **It re-seeds the target database**, so point it at a disposable one.
- CI runs typecheck, tests (with a Postgres service container) and build on every push.

Regenerate the README screenshots with the stack running: `npm run screenshot` (needs `npx playwright install chromium` once).

## Next steps

- Stream runs to the UI over SSE instead of polling.
- Authentication and reviewer identity on approvals; an audit log of who decided what.
- Run steps as a background job (queue) so long agent runs don't hold an HTTP request open.
- Prompt-injection and eval suites; replay recorded traces against new prompts or models.
- Per-tool rate limits, cost budgets and token accounting per conversation.
- Real migrations (the schema is idempotent DDL applied on boot) and multi-tenant data.

## License

[MIT](LICENSE) © Kevin Makwana. "Acme Shop" and all data are fictional.
