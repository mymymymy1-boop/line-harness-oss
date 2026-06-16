/**
 * Purchase receipt delivery — Stripe決済成功後に購入者へLINE DMを自動送信。
 *
 * 設計:
 *  - webhook (payment_intent.succeeded) から呼び出す
 *  - friendId → line_user_id + line_account_id を解決
 *  - account-scoped LineClient でpushMessage
 *  - messages_log に記録（履歴追跡）
 *  - 冪等性は上流（stripe_events テーブルの event_id ユニーク制約）に依存
 *
 * 商品別メッセージを追加するときは PRODUCT_MESSAGES に関数追加。
 */
import { getFriendById, getLineAccountById, jstNow } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

export interface PurchaseReceiptEnv {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  VIMEO_SHOWCASE_PASSWORD?: string;
}

type MessageFactory = (ctx: { password: string }) => string;

/**
 * 商品ID → メッセージテンプレート関数
 */
const PRODUCT_MESSAGES: Record<string, MessageFactory> = {
  speech_perfect_pack: ({ password }) => `ご購入ありがとうございます！

「AI時代の話し方パーフェクトパック」のご購入、誠にありがとうございました。

▼ 視聴ページ
https://bizsp.net/speech-pack/videos/

▼ パスワード
${password}

視聴期限はありません。何度でもご覧いただけます。
どの順番で見ても構いませんが、はじめての方は「#11 プレイリスト導入編」から見ていただくと全体像が掴めます。

━━━━━━━━━━━━━━
■ ご注意
・本コンテンツの転載・再配布・SNSシェアは固く禁じます
・パスワードは第三者と共有しないでください
■ お問い合わせ
・ご不明な点は本LINEで三橋まで直接ご連絡ください
━━━━━━━━━━━━━━

三橋泰介`,
};

export interface SendResult {
  sent: boolean;
  reason?: string;
  friendId?: string;
}

/**
 * Stripe決済成功後に購入レシートLINEを送信する。
 * 失敗時も例外を投げず、SendResult で結果を返す（webhook 処理を停めないため）。
 */
export async function sendPurchaseReceipt(
  env: PurchaseReceiptEnv,
  friendId: string,
  productId: string,
): Promise<SendResult> {
  try {
    // 1. friend 取得
    const friend = await getFriendById(env.DB, friendId);
    if (!friend) {
      return { sent: false, reason: 'friend_not_found', friendId };
    }
    if (!friend.line_user_id) {
      return { sent: false, reason: 'no_line_user_id', friendId };
    }

    // 2. メッセージテンプレート
    const messageFactory = PRODUCT_MESSAGES[productId];
    if (!messageFactory) {
      return { sent: false, reason: `unknown_product:${productId}`, friendId };
    }

    // 3. 環境変数からパスワード取得
    const password = env.VIMEO_SHOWCASE_PASSWORD;
    if (!password) {
      console.error('[purchase-receipt] VIMEO_SHOWCASE_PASSWORD not configured');
      return { sent: false, reason: 'password_not_configured', friendId };
    }

    // 4. account-scoped LineClient を解決
    let channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccountId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccountId) {
      const account = await getLineAccountById(env.DB, friendAccountId);
      if (account?.channel_access_token) {
        channelAccessToken = account.channel_access_token;
      }
    }

    // 5. メッセージ組立 & 送信
    const messageText = messageFactory({ password });
    const client = new LineClient(channelAccessToken);
    await client.pushMessage(friend.line_user_id, [{ type: 'text', text: messageText }]);

    // 6. messages_log 記録
    const logId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friendId, `[PURCHASE_RECEIPT:${productId}] ${messageText}`, jstNow())
      .run();

    return { sent: true, friendId };
  } catch (err) {
    console.error('[purchase-receipt] send failed:', err);
    return { sent: false, reason: `exception: ${err instanceof Error ? err.message : String(err)}`, friendId };
  }
}
