import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const stripe = new Hono<Env>();

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
    };
  };
}

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

/** Stripe署名検証 */
async function verifyStripeSignature(secret: string, rawBody: string, sigHeader: string): Promise<boolean> {
  // Stripe署名形式: t=timestamp,v1=signature
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k, v.join('=')];
    }),
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computedSig === expectedSig;
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
    let body: StripeWebhookBody;

    if (stripeSecret) {
      // 署名検証モード（本番環境）
      const sigHeader = c.req.header('Stripe-Signature') ?? '';
      const rawBody = await c.req.text();

      const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as StripeWebhookBody;
    } else {
      // シークレット未設定（開発環境向け）
      body = await c.req.json<StripeWebhookBody>();
    }

    // 冪等性チェック
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const obj = body.data.object;
    const db = c.env.DB;

    // メタデータからfriendIdを取得（Stripeのメタデータにline_friend_idを設定している想定）
    const friendId = obj.metadata?.line_friend_id ?? null;

    // イベントを記録
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
    });

    // 決済成功時の自動処理
    if (body.type === 'payment_intent.succeeded' && friendId) {
      const { applyScoring } = await import('@line-crm/db');
      await applyScoring(db, friendId, 'purchase');

      // 自動タグ付け（product_idベース）
      const productId = obj.metadata?.product_id;
      if (productId) {
        const tag = await db
          .prepare(`SELECT id FROM tags WHERE name = ?`)
          .bind(`purchased_${productId}`)
          .first<{ id: string }>();
        if (tag) {
          await db
            .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
            .bind(friendId, tag.id, jstNow())
            .run();
        }
      }

      // イベントバスに発火（自動化ルール用）
      const { fireEvent } = await import('../services/event-bus.js');
      await fireEvent(db, 'cv_fire', { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } });

      // 購入レシート自動送信（視聴URL＋パスワード配信）
      if (productId) {
        const { sendPurchaseReceipt } = await import('../services/purchase-receipt.js');
        const rcpt = await sendPurchaseReceipt(
          {
            DB: db,
            LINE_CHANNEL_ACCESS_TOKEN: (c.env as unknown as Record<string, string>).LINE_CHANNEL_ACCESS_TOKEN,
            VIMEO_SHOWCASE_PASSWORD: (c.env as unknown as Record<string, string | undefined>).VIMEO_SHOWCASE_PASSWORD,
          },
          friendId,
          productId,
        );
        if (!rcpt.sent) {
          console.warn(`[stripe-webhook] receipt not sent (friendId=${friendId}, product=${productId}): ${rcpt.reason}`);
        }
      }
    }

    // サブスクリプションイベント処理
    if (body.type === 'customer.subscription.deleted' && friendId) {
      const cancelledTag = await db
        .prepare(`SELECT id FROM tags WHERE name = 'subscription_cancelled'`)
        .first<{ id: string }>();
      if (cancelledTag) {
        await db
          .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
          .bind(friendId, cancelledTag.id, jstNow())
          .run();
      }
    }

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Checkout Session 作成 ==========

const PRICE_MAP: Record<string, string> = {
  '49800': 'price_1TMixuDWdMf56fzBAzBiOmxs',
  '54800': 'price_1TMixvDWdMf56fzB4T3jbF5N',
  '59800': 'price_1TMixvDWdMf56fzBH0XPe4YO',
};

stripe.post('/api/checkout/create', async (c) => {
  try {
    const stripeKey = (c.env as unknown as Record<string, string | undefined>).STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return c.json({ success: false, error: 'Stripe not configured' }, 500);
    }

    const body = await c.req.json<{
      tier?: string;
      friendId?: string;
      lineUserId?: string;
      successUrl?: string;
      cancelUrl?: string;
    }>();

    const tier = body.tier || '49800';
    const priceId = PRICE_MAP[tier];
    if (!priceId) {
      return c.json({ success: false, error: 'Invalid tier' }, 400);
    }

    const baseUrl = body.successUrl?.split('?')[0] || 'https://bizsp.net/speech-pack';
    const successUrl = `${baseUrl}/thanks?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = body.cancelUrl || 'https://bizsp.net/speech-pack/';

    const metadata: Record<string, string> = {};
    if (body.friendId) metadata.line_friend_id = body.friendId;
    if (body.lineUserId) metadata.line_user_id = body.lineUserId;
    metadata.product_id = 'speech_perfect_pack';
    metadata.tier = tier;

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', successUrl);
    params.set('cancel_url', cancelUrl);
    params.set('payment_method_types[0]', 'card');
    for (const [k, v] of Object.entries(metadata)) {
      params.set(`payment_intent_data[metadata][${k}]`, v);
      params.set(`metadata[${k}]`, v);
    }

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Stripe checkout session error:', errText);
      return c.json({ success: false, error: 'Failed to create checkout session' }, 500);
    }

    const session = await res.json<{ id: string; url: string }>();
    return c.json({ success: true, data: { sessionId: session.id, url: session.url } });
  } catch (err) {
    console.error('POST /api/checkout/create error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /checkout — LP CTA から直接リダイレクト（ブラウザ遷移用）
stripe.get('/checkout', async (c) => {
  try {
    const stripeKey = (c.env as unknown as Record<string, string | undefined>).STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return c.text('Stripe not configured', 500);
    }

    const tier = c.req.query('tier') || '49800';
    const friendId = c.req.query('friend_id') || '';
    const priceId = PRICE_MAP[tier];
    if (!priceId) {
      return c.text('Invalid tier', 400);
    }

    const successUrl = 'https://bizsp.net/speech-pack/thanks?session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = 'https://bizsp.net/speech-pack/';

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', successUrl);
    params.set('cancel_url', cancelUrl);
    params.set('payment_method_types[0]', 'card');
    params.set('payment_intent_data[metadata][product_id]', 'speech_perfect_pack');
    params.set('payment_intent_data[metadata][tier]', tier);
    if (friendId) {
      params.set('payment_intent_data[metadata][line_friend_id]', friendId);
      params.set('metadata[line_friend_id]', friendId);
    }

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      console.error('Stripe checkout redirect error:', await res.text());
      return c.text('Checkout creation failed', 500);
    }

    const session = await res.json<{ url: string }>();
    return c.redirect(session.url);
  } catch (err) {
    console.error('GET /checkout error:', err);
    return c.text('Internal server error', 500);
  }
});

export { stripe };
