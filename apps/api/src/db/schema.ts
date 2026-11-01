/**
 * Statements that reset the data of a database whose schema already exists (the seed script and the E2E suites use it).
 * The schema itself lives in ./migrations. Every table must be listed here except `schema_migrations`, which must survive:
 * a test checks that no table is missing.
 */
export const RESET_SQL =
  'TRUNCATE customers, orders, tickets, refunds, shipments, conversations, runs, steps, actions, approval_events, reviewers, reviewer_sessions, action_approvals, login_links, customer_sessions RESTART IDENTITY CASCADE';
