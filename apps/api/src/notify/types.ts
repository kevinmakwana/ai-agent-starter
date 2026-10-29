/** The fields of a claimed pending action that a notification is built from. */
export interface ClaimedAction {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  createdAt: string;
  /** The `rule` of the action's `requested` audit event, if any. */
  rule: string | null;
}

/** What every channel is handed. Only these keys, never customer data or free text. */
export interface ApprovalNote {
  id: string;
  tool: string;
  orderId?: number;
  amount?: number;
  rule?: string;
  createdAt: string;
  consoleUrl: string;
}

export interface Channel {
  name: string;
  /** Per-attempt allowance in ms; the notifier's own default applies when absent. */
  timeoutMs?: number;
  /** Throws on failure; the message must be safe to log (no URLs, secrets). Honour `signal`. */
  send(note: ApprovalNote, signal: AbortSignal): Promise<void>;
  close?(): void | Promise<void>;
}
