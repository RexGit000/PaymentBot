const { message } = require('telegraf/filters');
const { Markup } = require('telegraf');
const { botCache } = require('../cache');
const { consumePendingInvoice } = require('./start');

function md(s) {
  if (s == null) return '';
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function notifyPaymentSuccessToBot(botUsername, payload) {
  try {
    const botDoc = botCache.getByUsername(botUsername);
    if (!botDoc) {
      console.error('[notify-success] Bot not found in cache:', botUsername);
      return null;
    }
    const url = botDoc.apiUrl.replace(/\/$/, '') + '/api/payment-success';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('[notify-success] Bot responded with', res.status);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[notify-success] fetch error:', err.message);
    return null;
  }
}

module.exports = (bot) => {
  bot.on('pre_checkout_query', async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error('[pre_checkout]', err.message);
      try {
        await ctx.answerPreCheckoutQuery(false, 'Something went wrong. Please try again.');
      } catch { /* ignore */ }
    }
  });

  bot.on(message('successful_payment'), async (ctx) => {
    try {
      const payment = ctx.message.successful_payment;
      const rawPayload = payment.invoice_payload;

      let payload;
      if (typeof rawPayload === 'string' && /^[a-f0-9]{16}$/.test(rawPayload)) {
        payload = consumePendingInvoice(rawPayload);
      }
      if (!payload) {
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = null;
        }
      }

      if (!payload || !payload.botUsername || !payload.userId || !payload.orderId || !payload.amount) {
        console.error('[successful_payment] Missing fields or unknown payload');
        await ctx.reply('❌ Invalid request').catch(() => {});
        return;
      }

      const notifyResult = await notifyPaymentSuccessToBot(payload.botUsername, {
        userId: payload.userId,
        orderId: payload.orderId,
        amount: payload.amount,
        mediaCount: payload.mediaCount || 0,
        packageName: payload.packageName || 'Media Pack',
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
        providerPaymentChargeId: payment.provider_payment_charge_id,
      });

      if (ctx.chat && ctx.message && ctx.message.message_id) {
        try {
          await ctx.deleteMessage().catch(() => {});
        } catch {}
      }

      if (notifyResult && notifyResult.ok) {
        const botDisplay = payload.botUsername.replace(/^@/, '');
        const backLink = `https://t.me/${botDisplay}`;
        await ctx.reply(
          `✅ *Payment Successful!* 🎉\n\n` +
          `💰 Amount: *${md(payload.amount)} Stars* ⭐\n` +
          `📦 Package: *${md(payload.packageName)}*\n` +
          `🎬 Media items: *${md(payload.mediaCount)}*\n\n` +
          `📨 Your media is being delivered to you now!`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.url(`🔙 Return to @${md(botDisplay)}`, backLink)],
            ]),
          }
        );
      } else {
        await ctx.reply(
          `✅ *Payment Successful!* ⭐\n\n` +
          `However, we couldn't confirm delivery with the bot.\n` +
          `Please contact support if you don't receive your media.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[successful_payment]', err.message);
      await ctx.reply(
        '⚠️ Payment received but something went wrong. Please contact support.'
      ).catch(() => {});
    }
  });
};
