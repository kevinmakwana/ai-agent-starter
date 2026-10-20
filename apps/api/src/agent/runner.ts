import { ConflictError, GuardrailViolation, NotFoundError, UpstreamLlmError } from './errors';
import { buildMessages } from './context';
import { promptVersion } from './prompt';
import { toolByName, toolSpecs, validateToolInput, type ToolContext } from './tools';
import type {
  Action,
  AgentStore,
  ChatProvider,
  Conversation,
  Run,
  ShopRepo,
  NewStep,
  ToolCall,
} from './types';

export interface RunnerDeps {
  provider: ChatProvider;
  shop: ShopRepo;
  store: AgentStore;
  /** Max model calls per run (default 8). */
  maxSteps?: number;
  /** Max tokens (input + output) a conversation may use before the agent stops calling the model. Unset = unlimited. */
  tokenBudget?: number;
  /** Rough cap on the history sent to the model; older turns are left out (the stored trace is untouched). Unset = all. */
  maxContextTokens?: number;
}

type Outcome = { kind: 'result'; result: unknown } | { kind: 'pending'; reasoning: string };

const guardrailResult = (e: GuardrailViolation) => ({ error: e.message, code: e.code });

/**
 * The whole agent: call the model, validate + guard each tool call, execute safe tools,
 * park risky ones for human approval, repeat until the model answers or the step budget ends.
 */
export class AgentRunner {
  private readonly maxSteps: number;
  private readonly tokenBudget: number;
  private readonly maxContextTokens: number;

  constructor(private readonly deps: RunnerDeps) {
    this.maxSteps = deps.maxSteps ?? 8;
    this.tokenBudget = deps.tokenBudget ?? Infinity;
    this.maxContextTokens = deps.maxContextTokens ?? Infinity;
  }

  /** Starts a run for a new user message. Resolves when the run completes or pauses for approval. */
  async handleUserMessage(conv: Conversation, content: string): Promise<Run> {
    const { store } = this.deps;
    const run = await store.createRun(conv.id, {
      provider: this.deps.provider.name,
      model: this.deps.provider.model ?? null,
      promptVersion: promptVersion(),
    });
    try {
      await store.addStep({ runId: run.id, conversationId: conv.id, role: 'user', content });
    } catch (e) {
      await this.fail(run, e); // otherwise the run would block this conversation until it went stale
      throw e;
    }
    return this.loop(run, conv);
  }

  /** Applies a reviewer's decision to a parked action and resumes the paused run. */
  async decide(actionId: string, decision: 'approve' | 'reject', note?: string): Promise<{ action: Action; run: Run }> {
    const { store } = this.deps;
    if (!(await store.getAction(actionId))) throw new NotFoundError(`Approval ${actionId} not found`);
    const action = await store.decideAction(actionId, decision === 'approve' ? 'approved' : 'rejected', note);
    if (!action) throw new ConflictError('This approval has already been decided');

    return this.complete(action, decision, note);
  }

  /**
   * Finishes a decision whose claim succeeded but whose execution never completed because the process died.
   * Safe to repeat: refunds are idempotent per approval, and an action with a result is refused.
   */
  async recover(actionId: string): Promise<{ action: Action; run: Run }> {
    const action = await this.deps.store.getAction(actionId);
    if (!action) throw new NotFoundError(`Approval ${actionId} not found`);
    if (action.status === 'pending_approval' || action.result !== null) throw new ConflictError('This approval is not stranded');
    if ((await this.deps.store.getRun(action.runId))?.status !== 'awaiting_approval') throw new ConflictError('This run is no longer waiting');
    return this.complete(action, action.status === 'approved' ? 'approve' : 'reject', action.decisionNote ?? undefined);
  }

  /** Everything after the claim: execute (if approved), record the result, resume the parked run. */
  private async complete(action: Action, decision: 'approve' | 'reject', note?: string): Promise<{ action: Action; run: Run }> {
    const { store } = this.deps;
    const [run, conv] = await Promise.all([store.getRun(action.runId), store.getConversation(action.conversationId)]);
    if (!run || !conv) throw new NotFoundError('Run or conversation no longer exists');

    const started = Date.now();
    let result: unknown;
    if (decision === 'approve') {
      const tool = toolByName(action.toolName);
      if (!tool) {
        result = { error: `Unknown tool "${action.toolName}"`, code: 'UNKNOWN_TOOL' }; // e.g. removed since it was parked
      } else {
        try {
          result = await tool.execute(this.ctx(conv), { ...action.toolArgs, actionId: action.id });
        } catch (e) {
          if (!(e instanceof GuardrailViolation)) {
            await store.reopenAction(action.id); // infrastructure failure: let the reviewer try again
            throw e;
          }
          result = guardrailResult(e); // e.g. another refund landed while this one waited
        }
      }
    } else {
      result = {
        status: 'rejected',
        message: `A human reviewer rejected this action${note ? `: ${note}` : ''}. Do not retry it; tell the customer.`,
      };
    }
    try {
      await store.setActionResult(action.id, result);
    } catch (e) {
      await store.reopenAction(action.id); // nothing recorded yet; a retry replays the (idempotent) tool call
      throw e;
    }
    let resumed: Run;
    try {
      await store.addStep({
        runId: run.id, conversationId: conv.id, role: 'tool', toolName: action.toolName,
        toolCallId: action.toolCallId, result, latencyMs: Date.now() - started,
      });
      resumed = await store.updateRun(run.id, { status: 'running' });
    } catch (e) {
      await this.fail(run, e); // the decision stands and is not re-executed; do not leave the run parked forever
      throw e;
    }
    return { action: (await store.getAction(action.id))!, run: await this.loop(resumed, conv) };
  }

  /** Best effort: the original error is what the caller needs to see. */
  private async fail(run: Run, e: unknown): Promise<void> {
    await this.deps.store
      .updateRun(run.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
      .catch(() => undefined);
  }

  private ctx(conv: Conversation): ToolContext {
    return { customerId: conv.customerId, shop: this.deps.shop };
  }

  private async loop(startRun: Run, conv: Conversation): Promise<Run> {
    const { provider, store } = this.deps;
    let run = startRun;
    const base = { runId: run.id, conversationId: conv.id };
    try {
      // History is read once; every step this loop adds is appended here, so model calls never re-query it.
      const steps = await store.listSteps(conv.id);
      const addStep = async (step: NewStep) => {
        const saved = await store.addStep(step);
        steps.push(saved);
        return saved;
      };
      while (run.modelCalls < this.maxSteps) {
        if (await this.overBudget(conv)) {
          await addStep({
            ...base, role: 'assistant',
            content: "This conversation has reached its usage limit, so I can't continue here. A human agent will follow up.",
            result: { error: `Token budget of ${this.tokenBudget} reached`, code: 'TOKEN_BUDGET' },
          });
          return store.updateRun(run.id, { status: 'budget_exceeded', error: `Token budget of ${this.tokenBudget} reached` });
        }
        const messages = buildMessages(conv, steps, this.maxContextTokens);
        const started = Date.now();
        const completion = await provider.complete(messages, toolSpecs());
        const latencyMs = Date.now() - started;
        run = await store.updateRun(run.id, { modelCalls: run.modelCalls + 1 });
        const usage = {
          inputTokens: completion.usage?.inputTokens,
          outputTokens: completion.usage?.outputTokens,
          cachedInputTokens: completion.usage?.cachedInputTokens,
        };

        if (completion.toolCalls.length === 0 && !completion.text?.trim()) {
          // Keep the billed tokens in the trace, but never store a blank reply: providers reject it on the next call.
          await addStep({ ...base, role: 'assistant', content: '', result: { error: 'Empty model response', code: 'EMPTY_RESPONSE' }, latencyMs, ...usage });
          throw new UpstreamLlmError(provider.name, 'the model returned an empty response');
        }

        if (completion.toolCalls.length === 0) {
          await addStep({ ...base, role: 'assistant', content: completion.text ?? '', latencyMs, ...usage });
          return store.updateRun(run.id, { status: 'completed' });
        }

        // Persist every call of this turn before executing, so history keeps provider ordering.
        for (const [i, call] of completion.toolCalls.entries()) {
          await addStep({
            ...base, role: 'assistant', content: i === 0 ? (completion.text ?? null) : null,
            toolName: call.name, toolArgs: call.args, toolCallId: call.id,
            latencyMs: i === 0 ? latencyMs : null, ...(i === 0 ? usage : {}),
          });
        }

        for (const [i, call] of completion.toolCalls.entries()) {
          const t0 = Date.now();
          const outcome = await this.execute(conv, call, completion.text ?? '');
          if (outcome.kind === 'pending') {
            await store.createAction({
              runId: run.id, conversationId: conv.id, toolName: call.name,
              toolArgs: call.args as Record<string, unknown>, toolCallId: call.id, reasoning: outcome.reasoning,
            });
            for (const skipped of completion.toolCalls.slice(i + 1)) {
              await addStep({
                ...base, role: 'tool', toolName: skipped.name, toolCallId: skipped.id,
                result: { error: 'Skipped: an earlier action in this turn is awaiting human approval.', code: 'SKIPPED' },
              });
            }
            return store.updateRun(run.id, { status: 'awaiting_approval' });
          }
          await addStep({
            ...base, role: 'tool', toolName: call.name, toolCallId: call.id,
            result: outcome.result, latencyMs: Date.now() - t0,
          });
        }
      }

      await addStep({
        ...base, role: 'assistant',
        content: `I couldn't finish this within ${this.maxSteps} steps. A human agent will follow up.`,
        result: { error: `Step limit of ${this.maxSteps} reached`, code: 'STEP_LIMIT' },
      });
      return store.updateRun(run.id, { status: 'step_limit', error: `Step limit of ${this.maxSteps} reached` });
    } catch (e) {
      await this.fail(run, e);
      throw e;
    }
  }

  /** A soft cap: checked before each model call, so the call that crosses it still completes. */
  private async overBudget(conv: Conversation): Promise<boolean> {
    if (this.tokenBudget === Infinity) return false;
    const { inputTokens, outputTokens } = await this.deps.store.conversationUsage(conv.id);
    return inputTokens + outputTokens >= this.tokenBudget;
  }

  /** Unknown tool -> invalid args -> guardrails -> (park | execute). Failures become tool results, not exceptions. */
  private async execute(conv: Conversation, call: ToolCall, thought: string): Promise<Outcome> {
    const tool = toolByName(call.name);
    if (!tool) return { kind: 'result', result: { error: `Unknown tool "${call.name}"`, code: 'UNKNOWN_TOOL' } };

    const check = validateToolInput(call.name, call.args);
    if (!check.ok) {
      return { kind: 'result', result: { error: `Invalid arguments: ${check.errors.join('; ')}`, code: 'INVALID_ARGUMENTS' } };
    }
    const ctx = this.ctx(conv);
    try {
      if (tool.risky) {
        await tool.preflight?.(ctx, call.args);
        const reason = (call.args as { reason?: string }).reason;
        return { kind: 'pending', reasoning: thought || `The agent requested ${call.name}${reason ? `: ${reason}` : ''}` };
      }
      return { kind: 'result', result: await tool.execute(ctx, call.args) };
    } catch (e) {
      if (e instanceof GuardrailViolation) return { kind: 'result', result: guardrailResult(e) };
      throw e;
    }
  }
}
