// Prints the coverage totals of both apps as a markdown table (CI appends it to the job summary).
// Reads the json-summary files that `npm run coverage` writes; a missing file is reported, not hidden.
import { existsSync, readFileSync } from 'node:fs';

const apps = [
  ['API (Jest, with the Postgres E2E suites)', 'apps/api/coverage/coverage-summary.json'],
  ['Web (Vitest, unit and component tests)', 'apps/web/coverage/coverage-summary.json'],
];
const kinds = ['statements', 'branches', 'functions', 'lines'];

const rows = apps.map(([name, file]) => {
  if (!existsSync(file)) return `| ${name} | no report (${file} is missing) | | | |`;
  const { total } = JSON.parse(readFileSync(file, 'utf8'));
  return `| ${name} | ${kinds.map((k) => `${total[k].pct}% (${total[k].covered}/${total[k].total})`).join(' | ')} |`;
});

console.log(
  ['## Test coverage', '', `| | ${kinds.join(' | ')} |`, `| --- | ${kinds.map(() => '---').join(' | ')} |`, ...rows, ''].join('\n'),
);
console.log(
  'The web number counts every file under `src/`, imported by a test or not. The Playwright browser flow is not instrumented, so pages are mostly uncovered here.',
);
