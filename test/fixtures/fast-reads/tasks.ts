// The fast-reads fixture board; changing it needs a new golden (see SOURCE).
import { task } from '../../helpers.ts';
import { type Task } from '../../../src/lib/schema.ts';

const long = (n: number) => `\n## Context\n${'A card body long enough to push the whole reply past the 1 KB gzip line. '.repeat(n)}\n`;

export const FAST_READS_TASKS: Task[] = [
  task({ id: 'shared.t-zeta', title: 'Zeta todo', status: 'todo', priority: 'p1', body: long(4) }),
  task({ id: 'beta.t-alpha', title: 'Alpha doing', status: 'doing', claimed_by: 'claude-code@desktop', lane: 'none', depends_on: 'shared.t-zeta', body: long(2) }),
  task({ id: 'alpha.t-mid', title: 'Mid review', title_ko: '중간 리뷰', title_en: 'Mid review', status: 'review', pr: 'https://github.com/o/r/pull/7', pr_summary: 'adds a thing', version: '3' }),
  task({ id: 'gamma.t-done', title: 'Done card', status: 'done', result: 'shipped', pr: 'https://github.com/o/r/pull/8' }),
  task({ id: 'delta.t-cncl', title: 'Cancelled card', status: 'cancelled' }),
  task({ id: 'beta.t-wait', title: 'Waiting on the user', status: 'blocked-on-user', needs_user: '키 필요', kind: 'decision' }),
  task({ id: 'shared.t-beta', title: 'Beta todo', status: 'todo', owner: 'shared-lead', lane: 'claude' }),
];
