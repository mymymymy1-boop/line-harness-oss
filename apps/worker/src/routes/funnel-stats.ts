import { Hono } from 'hono';
import type { Env } from '../index.js';

const funnelStats = new Hono<Env>();

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// GET /api/funnel-stats — アカウント別ファネル集計（週次レポート等の観測用・read-only）
// query:
//   lineAccountId (必須)
//   since / until (任意, ISO文字列。created_at と辞書順比較。since <= t < until)
//   prefixes     (任意, カンマ区切り最大20個。incoming messages_log の content 前方一致)
// 返り値: { newFriends, events: { <prefix>: { count, friends } } }
funnelStats.get('/api/funnel-stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    const since = c.req.query('since') || '0000';
    const until = c.req.query('until') || '9999';
    const prefixes = (c.req.query('prefixes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);

    const nf = await c.env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM friends
         WHERE line_account_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .bind(lineAccountId, since, until)
      .first<{ n: number }>();

    const events: Record<string, { count: number; friends: number }> = {};
    for (const p of prefixes) {
      const row = await c.env.DB
        .prepare(
          `SELECT COUNT(*) AS n, COUNT(DISTINCT m.friend_id) AS uf
           FROM messages_log m JOIN friends f ON f.id = m.friend_id
           WHERE f.line_account_id = ? AND m.direction = 'incoming'
             AND m.created_at >= ? AND m.created_at < ?
             AND m.content LIKE ? ESCAPE '\\'`,
        )
        .bind(lineAccountId, since, until, escapeLike(p) + '%')
        .first<{ n: number; uf: number }>();
      events[p] = { count: row?.n ?? 0, friends: row?.uf ?? 0 };
    }

    return c.json({ success: true, data: { newFriends: nf?.n ?? 0, events } });
  } catch (err) {
    console.error('GET /api/funnel-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { funnelStats };
