import { AsyncLocalStorage } from 'node:async_hooks';

// The id of the HTTP request being served, visible to everything it awaits (including Nest Logger calls) without passing it around.
const storage = new AsyncLocalStorage<{ requestId: string }>();

export const runWithRequestId = <T>(requestId: string, fn: () => T): T => storage.run({ requestId }, fn);
export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;
