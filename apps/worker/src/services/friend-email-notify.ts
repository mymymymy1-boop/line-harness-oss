/**
 * 新規友だち登録の Gmail 通知 — cron(5分ごと)から呼ばれる。
 *
 * 設計:
 * - follow イベント時点では ref_code / metadata.book_code がまだ書かれていない
 *   (OAuth callback / LIFF link が数秒〜数十秒遅れて到着する)ため、イベント直結ではなく
 *   cron で「作成から GRACE_MINUTES 経過した未通知の友だち」を拾う。
 * - 二重送信防止は friend_email_notifications 台帳(PK=friend_id)。
 *   抽出は「台帳に居ない全員」— 既定=通知、例外だけ台帳で免除の向き。
 * - 同一 tick の複数登録は1通にまとめる。
 * - Kindle 本コード(metadata.book_code)は KINDLE_RESOLVE_URL があればタイトルに解決、
 *   失敗時はコードのまま載せる(通知自体は止めない)。
 */

interface GmailEnv {
  DB: D1Database;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  NOTIFY_EMAIL_TO?: string;
  KINDLE_RESOLVE_URL?: string;
}

interface PendingFriend {
  id: string;
  display_name: string | null;
  ref_code: string | null;
  metadata: string | null;
  created_at: string;
  account_name: string | null;
  route_name: string | null;
}

const GRACE_MINUTES = 3;      // 帰属(ref/book)書き込み待ち
const LOOKBACK_HOURS = 48;    // これより古い未通知は掃かない(導入時の一斉送信防止)
const MAX_PER_MAIL = 30;

/** JST の '%Y-%m-%dT%H:%M:%f' 形式 (DB の created_at と同形式) */
function jstStamp(offsetMs = 0): string {
  return new Date(Date.now() + 9 * 3600_000 + offsetMs).toISOString().replace('Z', '').slice(0, 23);
}

// ─── Gmail API ──────────────────────────────────────────────────

async function getAccessToken(env: GmailEnv): Promise<string> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    throw new Error(`gmail token refresh failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
  const body = await resp.json<{ access_token: string }>();
  return body.access_token;
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2047 (encoded-word) — 日本語件名用 */
function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${b64(new TextEncoder().encode(subject))}?=`;
}

export async function sendGmail(env: GmailEnv, to: string, subject: string, textBody: string): Promise<void> {
  const accessToken = await getAccessToken(env);
  const mime = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(new TextEncoder().encode(textBody)),
  ].join('\r\n');

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: b64url(new TextEncoder().encode(mime)) }),
  });
  if (!resp.ok) {
    throw new Error(`gmail send failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  }
}

// ─── Kindle 本タイトル解決 (best-effort) ─────────────────────────

async function resolveBookTitle(env: GmailEnv, code: string): Promise<string | null> {
  if (!env.KINDLE_RESOLVE_URL) return null;
  try {
    const resp = await fetch(`${env.KINDLE_RESOLVE_URL}?code=${encodeURIComponent(code)}`, {
      headers: { Origin: 'https://bizsp.net' },
    });
    if (!resp.ok) return null;
    const data = await resp.json<{ ok?: boolean; title?: string }>();
    return data?.title || null;
  } catch {
    return null;
  }
}

// ─── 本体 ───────────────────────────────────────────────────────

export async function processFriendEmailNotifications(env: GmailEnv): Promise<void> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN || !env.NOTIFY_EMAIL_TO) {
    return; // 未設定なら何もしない(セットアップ前のデプロイを壊さない)
  }
  const db = env.DB;

  const since = jstStamp(-LOOKBACK_HOURS * 3600_000);
  const cutoff = jstStamp(-GRACE_MINUTES * 60_000);

  const rows = await db
    .prepare(
      `SELECT f.id, f.display_name, f.ref_code, f.metadata, f.created_at,
              la.name AS account_name, er.name AS route_name
       FROM friends f
       LEFT JOIN line_accounts la ON la.id = f.line_account_id
       LEFT JOIN entry_routes er ON er.ref_code = f.ref_code
       WHERE f.created_at >= ? AND f.created_at <= ?
         AND NOT EXISTS (SELECT 1 FROM friend_email_notifications n WHERE n.friend_id = f.id)
       ORDER BY f.created_at ASC
       LIMIT ?`,
    )
    .bind(since, cutoff, MAX_PER_MAIL)
    .all<PendingFriend>();

  const pending = rows.results ?? [];
  if (pending.length === 0) return;

  // 本タイトル解決 (同一コードは1回だけ問い合わせ)
  const titleCache = new Map<string, string | null>();
  const sections: string[] = [];
  for (const f of pending) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(f.metadata || '{}'); } catch { /* noop */ }
    const bookCode = typeof meta.book_code === 'string' ? meta.book_code : '';

    const lines = [`■ ${f.display_name || '(名前未取得)'}`];
    lines.push(`  アカウント: ${f.account_name || '(未特定)'}`);
    if (f.ref_code) {
      lines.push(`  ルート: ${f.route_name || '(entry_routes未登録)'} (ref=${f.ref_code})`);
    } else {
      lines.push('  ルート: 直接追加/QR等 (refなし)');
    }
    if (bookCode) {
      if (!titleCache.has(bookCode)) {
        titleCache.set(bookCode, await resolveBookTitle(env, bookCode));
      }
      const title = titleCache.get(bookCode);
      lines.push(`  Kindle本: ${title ? `『${title}』` : ''}(${bookCode})`);
    }
    lines.push(`  登録日時: ${f.created_at.replace('T', ' ').slice(0, 16)} JST`);
    sections.push(lines.join('\n'));
  }

  const first = pending[0];
  const subject = pending.length === 1
    ? `【LINE登録】${first.display_name || '(名前未取得)'}${first.route_name ? ` / ${first.route_name}` : ''}`
    : `【LINE登録】${pending.length}件 (${first.display_name || '(名前未取得)'} ほか)`;

  const body = [
    `LINE公式アカウントに新規登録がありました (${pending.length}件)`,
    '',
    sections.join('\n\n'),
    '',
    '---',
    '管理画面: https://line.bizsp.net/friends',
    'Kindle計測: https://kindle.bizsp.net/analytics',
  ].join('\n');

  // 送信成功後に台帳へ記録。送信失敗時は台帳に書かず次のcronで再試行。
  await sendGmail(env, env.NOTIFY_EMAIL_TO, subject, body);

  const now = jstStamp();
  for (const f of pending) {
    try {
      await db
        .prepare('INSERT OR IGNORE INTO friend_email_notifications (friend_id, sent_at) VALUES (?, ?)')
        .bind(f.id, now)
        .run();
    } catch (err) {
      console.error(`friend_email_notifications insert failed friend=${f.id}:`, err);
    }
  }
  console.log(`[email-notify] sent 1 mail for ${pending.length} new friend(s)`);
}
