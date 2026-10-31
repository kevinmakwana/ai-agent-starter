export type CustomerScreen = 'loading' | 'demo' | 'sign-in' | 'chat';

/** Which customer-page screen to show, from /health and the result of /customer-auth/me. */
export function customerScreen(health: { customerLogin?: boolean } | null, me: unknown | null): CustomerScreen {
  if (health === null) return 'loading';
  if (!health.customerLogin) return 'demo';
  return me === null ? 'sign-in' : 'chat';
}
