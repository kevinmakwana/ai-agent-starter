import type { Approval, ConversationDetail, Run, Step } from '@/lib/types';

const ms = (n: number | null) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function Timing({ step, run }: { step: Step; run: Run }) {
  const offset = new Date(step.createdAt).getTime() - new Date(run.createdAt).getTime();
  return (
    <span className="timing">
      {ms(step.latencyMs) && <b>{ms(step.latencyMs)}</b>}
      {step.inputTokens != null && <span>{step.inputTokens}↑ {step.outputTokens}↓ tok</span>}
      <span>+{ms(Math.max(0, offset))}</span>
    </span>
  );
}

function StepCard({ step, run, approval }: { step: Step; run: Run; approval?: Approval }) {
  if (step.role === 'user') {
    return <div className="step user"><div className="step-head"><span className="tag">user</span><Timing step={step} run={run} /></div><p>{step.content}</p></div>;
  }
  if (step.role === 'assistant' && !step.toolName) {
    return <div className="step answer"><div className="step-head"><span className="tag">answer</span><Timing step={step} run={run} /></div><p>{step.content}</p></div>;
  }
  if (step.role === 'assistant') {
    return (
      <div className="step call">
        <div className="step-head"><span className="tag">tool call</span><Timing step={step} run={run} /></div>
        {step.content && <p className="thought">💭 {step.content}</p>}
        <pre><span className="fn">{step.toolName}</span>({pretty(step.toolArgs)})</pre>
        {approval?.status === 'pending_approval' && (
          <div className="pending-flag">⏸ pending approval — run paused until a reviewer decides</div>
        )}
      </div>
    );
  }
  const failed = Boolean(step.result?.error) || step.result?.status === 'rejected';
  return (
    <div className={`step result ${failed ? 'bad' : ''}`}>
      <div className="step-head"><span className="tag">{failed ? 'blocked' : 'result'}</span><span className="fn">{step.toolName}</span><Timing step={step} run={run} /></div>
      <pre>{pretty(step.result)}</pre>
    </div>
  );
}

export function TracePanel({ detail }: { detail: ConversationDetail | null }) {
  if (!detail) return <div className="empty pad">Select a conversation to see the agent trace.</div>;
  if (detail.runs.length === 0) return <div className="empty pad">No runs yet. Send a message.</div>;
  return (
    <div className="trace">
      <div className="muted pad">
        Conversation usage: {detail.usage.totalTokens.toLocaleString()} of {detail.usage.budget.toLocaleString()} tokens
        {' '}({detail.usage.inputTokens.toLocaleString()} in · {detail.usage.outputTokens.toLocaleString()} out)
      </div>
      {detail.runs.map((run, i) => {
        const total = run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime() : null;
        return (
          <section key={run.id} className="run">
            <header>
              <b>Run {i + 1}</b>
              <span className={`chip ${run.status}`}>{run.status.replace('_', ' ')}</span>
              <span className="muted">{run.modelCalls} model call{run.modelCalls === 1 ? '' : 's'} · {run.usage.totalTokens.toLocaleString()} tokens{total != null && ` · ${ms(total)}`}</span>
            </header>
            {run.steps.map((s) => (
              <StepCard key={s.id} step={s} run={run} approval={detail.approvals.find((a) => a.toolCallId === s.toolCallId && a.runId === run.id && s.role === 'assistant')} />
            ))}
            {run.error && <div className="notice err">{run.error}</div>}
          </section>
        );
      })}
    </div>
  );
}
