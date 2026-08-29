import { describe, it, expect } from 'vitest';
import { buildSegmentQuery } from './segment-query.js';

describe('buildSegmentQuery', () => {
  it('wraps OR groups in parentheses so an account filter cannot leak across accounts', () => {
    const { sql } = buildSegmentQuery({
      operator: 'OR',
      rules: [
        { type: 'ref_code', value: 'a' },
        { type: 'ref_code', value: 'b' },
      ],
    });
    // The WHERE body must be parenthesized. Callers splice in
    // `WHERE f.line_account_id = ? AND ...`; without the parens SQL precedence
    // turns `acct AND a OR b` into `(acct AND a) OR b`, leaking other accounts.
    expect(sql).toContain('WHERE (');
    const spliced = sql.replace('WHERE', 'WHERE f.line_account_id = ? AND');
    expect(spliced).toContain('AND (f.ref_code = ? OR f.ref_code = ?)');
  });

  it('still parenthesizes a single-rule AND segment', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'is_following', value: true }],
    });
    expect(sql).toContain('WHERE (f.is_following = ?)');
  });
});
