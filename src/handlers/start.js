const { Markup } = require('telegraf');
const AuthorizedBot = require('../models/AuthorizedBot');
const Admin = require('../models/Admin');
const { botCache, adminCache } = require('../cache');
const {
  mainAdminKeyboard,
  botsInlineKeyboard,
  botActionsKeyboard,
  botDeleteConfirmKeyboard,
  adminsInlineKeyboard,
  adminActionsKeyboard,
  adminDeleteConfirmKeyboard,
  cancelInlineKeyboard,
} = require('../keyboards/admin');

const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1';
const crypto = require('crypto');
const pendingInvoices = new Map();

function md(s) {
  if (s == null) return '';
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
function mdCode(s) {
  if (s == null) return '';
  return String(s).replace(/([`\\])/g, '\\$1');
}

function registerPendingInvoice(payload) {
  const txnId = crypto.randomBytes(8).toString('hex');
  pendingInvoices.set(txnId, { ...payload, createdAt: Date.now() });
  const MAX = 5000;
  if (pendingInvoices.size > MAX) {
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const [k, v] of pendingInvoices) {
      if (v.createdAt < cutoff) pendingInvoices.delete(k);
    }
  }
  return txnId;
}

function consumePendingInvoice(txnId) {
  const v = pendingInvoices.get(txnId);
  if (v) pendingInvoices.delete(txnId);
  return v || null;
}

function tryParseLegacyPayload(encoded) {
  if (!encoded) return null;
  const candidates = [encoded];
  const fixed = encoded.replace(/-/g, '+').replace(/_/g, '/');
  if (fixed !== encoded) candidates.push(fixed);
  for (const cand of [...candidates]) {
    const pad = cand.length % 4;
    if (pad) candidates.push(cand + '='.repeat(4 - pad));
  }
  for (const cand of candidates) {
    try {
      const json = Buffer.from(cand, 'base64').toString('utf8');
      return JSON.parse(json);
    } catch {}
  }
  return null;
}

function parseStartPayload(raw) {
  if (!raw) return null;
  // Preferred short format: <botUsername>_<10-char-hex-token>
  const us = raw.lastIndexOf('_');
  if (us > 0 && us < raw.length - 1) {
    const botUsername = raw.slice(0, us).replace(/^@/, '');
    const token = raw.slice(us + 1);
    if (botUsername && token && /^[A-Za-z0-9]{8,}$/.test(token)) {
      return { format: 'short', botUsername, token };
    }
  }
  // Legacy: base64-encoded JSON { bot, userId, orderId, amount }
  const legacy = tryParseLegacyPayload(raw);
  if (legacy && legacy.bot && legacy.userId && legacy.orderId && legacy.amount != null) {
    return { format: 'legacy', ...legacy };
  }
  return null;
}

async function verifyOrderWithBot(botDoc, payload) {
  try {
    if (payload.format === 'short') {
      const url = botDoc.apiUrl.replace(/\/$/, '') + '/api/verify-token';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: payload.token }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    }
    // legacy format
    const url = botDoc.apiUrl.replace(/\/$/, '') + '/api/verify-order';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: payload.userId,
        orderId: payload.orderId,
        amount: payload.amount,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok ? data : null;
  } catch (err) {
    console.error('[verify] fetch error:', err.message);
    return null;
  }
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
  const pending = {};

  bot.start(async (ctx) => {
    try {
      const { id, username, first_name } = ctx.from;
      const args = ctx.startPayload;
      const isAdmin = ctx.state.isAdmin;

      console.log(`[start] from=${id} @${username || '-'} args=${args ? `"${args}" (len=${args.length})` : 'NONE'}`);

      if (args) {
        const parsed = parseStartPayload(args);
        console.log(`[start] parsed = ${parsed ? JSON.stringify(parsed) : 'null (UNRECOGNIZED FORMAT)'}`);
        if (parsed) {
          const botUsername = parsed.botUsername || parsed.bot;
          let botDoc = botCache.getByUsername(botUsername);
          if (!botDoc) {
            try {
              const db = require('../models');
              const norm = String(botUsername).toLowerCase().replace(/^@/, '');
              const dbBot = await db.AuthorizedBot.findOne({
                $or: [
                  { botUsername: norm },
                  { botUsername: '@' + norm },
                ],
                isActive: true,
              }).lean();
              if (dbBot) {
                botDoc = dbBot;
                botCache.update(botDoc);
                console.log(`[start] bot="${botUsername}" recovered via DB fallback`);
              }
            } catch (err) {
              console.error('[start] DB fallback error:', err.message);
            }
          }
          console.log(`[start] bot="${botUsername}" cached=${!!botDoc}`);
          if (botDoc) {
            console.log(`[start] calling verify (format=${parsed.format}) @ ${botDoc.apiUrl}`);
            let verified = null;
            try {
              verified = await verifyOrderWithBot(botDoc, parsed);
            } catch (err) {
              console.error('[start] verify exception:', err.message);
            }
            console.log(`[start] verify result = ${verified ? JSON.stringify(verified) : 'FAILED/NULL'}`);
            if (verified) {
              const amount = Number(verified.amount);
              const invoicePayload = {
                botUsername: botUsername,
                userId: verified.userId,
                orderId: verified.orderId,
                amount: amount,
                mediaCount: verified.mediaCount || 0,
                packageName: verified.packageName || 'Media Pack',
              };
              console.log(`[start] rendering ${TEST_MODE ? 'TEST-MODE auto-flow' : 'Stars invoice'}, amount=${amount}`);

              if (TEST_MODE) {
                await ctx.reply(
                  `🧪 *TEST MODE ACTIVE* 🧪\n\n` +
                  `📦 *${md(invoicePayload.packageName)}*\n` +
                  `💰 Amount: *${md(invoicePayload.amount)} Stars* ⭐\n` +
                  `🎬 Media items: *${md(invoicePayload.mediaCount)}*\n\n` +
                  `⏭️ Skipping Stars payment and auto-confirming...`,
                  { parse_mode: 'Markdown' }
                );

                const notifyResult = await notifyPaymentSuccessToBot(invoicePayload.botUsername, {
                  userId: invoicePayload.userId,
                  orderId: invoicePayload.orderId,
                  amount: invoicePayload.amount,
                  mediaCount: invoicePayload.mediaCount,
                  packageName: invoicePayload.packageName,
                  telegramPaymentChargeId: 'TEST_' + Date.now(),
                  providerPaymentChargeId: 'TEST_' + Date.now(),
                });

                const botDisplay = invoicePayload.botUsername.replace(/^@/, '');
                const backLink = `https://t.me/${botDisplay}`;

                if (notifyResult && notifyResult.ok) {
                  await ctx.reply(
                    `✅ *Test Payment Successful!* 🎉\n\n` +
                    `💰 Amount: *${md(invoicePayload.amount)} Stars* ⭐\n` +
                    `📦 Package: *${md(invoicePayload.packageName)}*\n` +
                    `🎬 Media items: *${md(invoicePayload.mediaCount)}*\n\n` +
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
                    `✅ *Test Payment Fired!* ⭐\n\n` +
                    `However, the bot didn't confirm delivery. Check its logs.`,
                    { parse_mode: 'Markdown' }
                  );
                }
                return;
              }

              const n = verified.mediaCount || 0;
              const pname = verified.packageName || 'Media Pack';

              await ctx.replyWithInvoice({
                title: n ? `📦 ${n} Media Pack` : `📦 ${pname}`,
                description: n
                  ? `Get ${n} exclusive media items instantly!  —  Pay with the button below👇👇`
                  : `Premium ${pname} — delivered instantly!  —  Pay with the button below👇👇`,
                payload: registerPendingInvoice(invoicePayload),
                currency: 'XTR',
                prices: [{ label: pname, amount: amount }],
                provider_token: '',
              });
              console.log(`[start] invoice sent`);
              return;
            }
          } else {
            console.log(`[start] VERIFY FAILED -> bot="${botUsername}" lookup=${botDoc ? 'OK (bot found)' : 'MISS (bot NOT in AuthorizedBot DB/cache — CRUD username mismatch vs botInfo.username)'} verify=${botDoc ? (verified ? 'OK' : 'FAILED/NULL — belonging bot /api/verify-token or /api/verify-order returned non-ok/non-json/!ok') : 'SKIPPED'}`);
          }
          console.log(`[start] VERIFY FAILED -> sending "Invalid request"`);
          if (!isAdmin) {
            await ctx.reply('❌ Invalid request');
            return;
          }
        } else if (!isAdmin) {
          console.log(`[start] BAD PAYLOAD -> sending "Invalid request"`);
          await ctx.reply('❌ Invalid request');
          return;
        }
      }

      if (isAdmin) {
        const botCount = await AuthorizedBot.countDocuments();
        const adminCount = await Admin.countDocuments();
        const testBadge = TEST_MODE ? ' 🧪 TEST' : '';
        await ctx.reply(
          `👋 Welcome back, ${md(first_name)}!${testBadge}\n\n` +
          `🔧 *Admin Panel*\n\n` +
          `🤖 Authorized Bots: *${md(botCount)}*\n` +
          `👥 Total Admins: *${md(adminCount)}*\n\n` +
          `Use the keyboard below to manage bots and admins.`,
          { parse_mode: 'Markdown', ...mainAdminKeyboard() }
        );
        return;
      }

      const testBadge = TEST_MODE ? '\n\n🧪 *Test Mode is currently ON.* ⚙️' : '';
      await ctx.reply(
        `💳 *Welcome to Rex Payment Bot!* ✨\n\n` +
        `🔒 This is the official payment center.\n\n` +
        `💰 Here you can complete your payment using Telegram Stars ⭐\n\n` +
        `📌 To make a payment, use the payment link provided by the bot you're purchasing from.\n\n` +
        `🚀 It will take you directly to your secure payment page!${testBadge}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[start handler]', err.message);
      await ctx.reply('Something went wrong. Please try again.').catch(() => {});
    }
  });

  bot.hears('🤖 Manage Bots', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      const bots = await AuthorizedBot.find().lean();
      await ctx.reply('🤖 *Authorized Bots:*', {
        parse_mode: 'Markdown',
        ...botsInlineKeyboard(bots),
      });
    } catch (err) {
      console.error('[manage bots]', err.message);
    }
  });

  bot.action('bots_list', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      const bots = await AuthorizedBot.find().lean();
      await ctx.editMessageText('🤖 *Authorized Bots:*', {
        parse_mode: 'Markdown',
        ...botsInlineKeyboard(bots),
      });
    } catch (err) {
      console.error('[bots list]', err.message);
    }
  });

  bot.action('bot_add', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      pending[ctx.from.id] = { type: 'bot_add', step: 1 };
      await ctx.editMessageText(
        '➕ *Add New Bot*\n\nStep 1/2: Send the bot username (e.g. @rexmediatgbot)',
        { parse_mode: 'Markdown', ...cancelInlineKeyboard('bot_cancel') }
      );
    } catch (err) {
      console.error('[bot add]', err.message);
    }
  });

  bot.action(/^bot_view:(.+)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      const b = await AuthorizedBot.findById(ctx.match[1]).lean();
      if (!b) { await ctx.editMessageText('Bot not found.'); return; }
      await ctx.editMessageText(
        `🤖 *Bot Details*\n\n` +
        `Username: @${md(b.botUsername.replace(/^@/, ''))}\n` +
        `API URL: \`${mdCode(b.apiUrl)}\`\n` +
        `Status: ${b.isActive ? '✅ Active' : '❌ Inactive'}\n` +
        `Added: ${md(b.createdAt.toDateString())}`,
        { parse_mode: 'Markdown', ...botActionsKeyboard(b._id) }
      );
    } catch (err) {
      console.error('[bot view]', err.message);
    }
  });

  bot.action(/^bot_edit_field:(.+):(botUsername|apiUrl)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      const botId = ctx.match[1];
      const field = ctx.match[2];
      const b = await AuthorizedBot.findById(botId).lean();
      if (!b) { await ctx.editMessageText('Bot not found.'); return; }
      pending[ctx.from.id] = { type: 'bot_edit_field', botId, field };
      const label = field === 'botUsername' ? 'Username' : 'API URL';
      const current = field === 'botUsername'
        ? `@${md(b.botUsername.replace(/^@/, ''))}`
        : `\`${mdCode(b.apiUrl)}\``;
      await ctx.editMessageText(
        `✏ *Edit ${label}*\n\nCurrent: ${current}\n\nSend the new ${label.toLowerCase()} now.`,
        { parse_mode: 'Markdown', ...cancelInlineKeyboard('bot_cancel') }
      );
    } catch (err) {
      console.error('[bot edit field]', err.message);
    }
  });

  bot.action(/^bot_delete_confirm:(.+)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        '⚠️ *Delete Bot?*\n\nThis action cannot be undone. Continue?',
        { parse_mode: 'Markdown', ...botDeleteConfirmKeyboard(ctx.match[1]) }
      );
    } catch (err) {
      console.error('[bot delete confirm]', err.message);
    }
  });

  bot.action(/^bot_delete:(.+)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      await AuthorizedBot.findByIdAndDelete(id);
      botCache.remove(id);
      await ctx.editMessageText('✅ Bot deleted successfully.');
    } catch (err) {
      console.error('[bot delete]', err.message);
      await ctx.editMessageText('❌ Failed to delete bot.');
    }
  });

  bot.action('bot_cancel', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      delete pending[ctx.from.id];
      const bots = await AuthorizedBot.find().lean();
      await ctx.editMessageText('🤖 *Authorized Bots:*', {
        parse_mode: 'Markdown',
        ...botsInlineKeyboard(bots),
      });
    } catch (err) {
      console.error('[bot cancel]', err.message);
    }
  });

  bot.hears('👥 Manage Admins', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      const admins = await Admin.find().lean();
      await ctx.reply('👥 *Admins List:*', {
        parse_mode: 'Markdown',
        ...adminsInlineKeyboard(admins),
      });
    } catch (err) {
      console.error('[manage admins]', err.message);
    }
  });

  bot.action('admins_list', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      const admins = await Admin.find().lean();
      await ctx.editMessageText('👥 *Admins List:*', {
        parse_mode: 'Markdown',
        ...adminsInlineKeyboard(admins),
      });
    } catch (err) {
      console.error('[admins list]', err.message);
    }
  });

  bot.action('admin_add', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      pending[ctx.from.id] = { type: 'admin_add', step: 1 };
      await ctx.editMessageText(
        '➕ *Add New Admin*\n\nStep 1/2: Send the admin username (@username) or Telegram ID (number)',
        { parse_mode: 'Markdown', ...cancelInlineKeyboard('admin_cancel') }
      );
    } catch (err) {
      console.error('[admin add]', err.message);
    }
  });

  bot.action(/^admin_view:(.+)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      const a = await Admin.findById(ctx.match[1]).lean();
      if (!a) { await ctx.editMessageText('Admin not found.'); return; }
      const isSelf = String(a.telegramId) === String(ctx.from.id) ||
        (a.username && ctx.from.username && a.username.toLowerCase() === `@${ctx.from.username}`.toLowerCase());
      await ctx.editMessageText(
        `🛡 *Admin Details*\n\n` +
        `ID: ${md(a.telegramId || 'Not set')}\n` +
        `Username: ${a.username ? md(a.username) : 'Not set'}\n` +
        `Super Admin: ${a.isSuperAdmin ? '✅ Yes' : '❌ No'}\n` +
        `Added: ${md(a.createdAt.toDateString())}`,
        { parse_mode: 'Markdown', ...adminActionsKeyboard(a._id, isSelf) }
      );
    } catch (err) {
      console.error('[admin view]', err.message);
    }
  });

  bot.action(/^admin_delete_confirm:(.+)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        '⚠️ *Remove Admin?*\n\nThis action cannot be undone. Continue?',
        { parse_mode: 'Markdown', ...adminDeleteConfirmKeyboard(ctx.match[1]) }
      );
    } catch (err) {
      console.error('[admin delete confirm]', err.message);
    }
  });

  bot.action(/^admin_delete:(.+)$/, async (ctx) => {
    if (!ctx.state.isAdmin) return;
    if (!ctx.state.isSuperAdmin) {
      await ctx.answerCbQuery('⛔ Only super admins can remove admins.', true);
      return;
    }
    try {
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const doc = await Admin.findById(id);
      if (!doc) { await ctx.editMessageText('Admin not found.'); return; }
      if (doc.telegramId) adminCache.removeById(doc.telegramId);
      if (doc.username) adminCache.removeByUsername(doc.username);
      await Admin.findByIdAndDelete(id);
      await ctx.editMessageText('✅ Admin removed successfully.');
    } catch (err) {
      console.error('[admin delete]', err.message);
      await ctx.editMessageText('❌ Failed to remove admin.');
    }
  });

  bot.action('admin_cancel', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      delete pending[ctx.from.id];
      const admins = await Admin.find().lean();
      await ctx.editMessageText('👥 *Admins List:*', {
        parse_mode: 'Markdown',
        ...adminsInlineKeyboard(admins),
      });
    } catch (err) {
      console.error('[admin cancel]', err.message);
    }
  });

  bot.action('admin_back', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      const botCount = await AuthorizedBot.countDocuments();
      const adminCount = await Admin.countDocuments();
      const testBadge = TEST_MODE ? ' 🧪 TEST' : '';
      await ctx.reply(
        `🔧 *Admin Panel*${testBadge}\n\n` +
        `🤖 Authorized Bots: *${md(botCount)}*\n` +
        `👥 Total Admins: *${md(adminCount)}*`,
        { parse_mode: 'Markdown', ...mainAdminKeyboard() }
      );
    } catch (err) {
      console.error('[admin back]', err.message);
    }
  });

  bot.hears('📊 Bot Stats', async (ctx) => {
    if (!ctx.state.isAdmin) return;
    try {
      const botCount = await AuthorizedBot.countDocuments();
      const adminCount = await Admin.countDocuments();
      const superAdminCount = await Admin.countDocuments({ isSuperAdmin: true });
      const testBadge = TEST_MODE ? '🧪 *TEST MODE*: ON\n\n' : '';
      await ctx.reply(
        `📊 *Bot Stats*\n\n` +
        testBadge +
        `🤖 Total Bots: *${md(botCount)}*\n\n` +
        `👥 Total Admins: *${md(adminCount)}*\n` +
        `👑 Super Admins: *${md(superAdminCount)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[stats]', err.message);
    }
  });

  bot.on('text', async (ctx, next) => {
    if (!ctx.state.isAdmin) return next();
    const uid = ctx.from.id;
    const p = pending[uid];
    if (!p) return next();

    const text = ctx.message.text.trim();

    if (p.type === 'bot_add') {
      if (p.step === 1) {
        p.botUsername = text.replace(/^@/, '');
        p.step = 2;
        await ctx.reply(
          'Step 2/2: Send the API URL (e.g. http://localhost:3002)',
          cancelInlineKeyboard('bot_cancel')
        );
        return;
      }
      if (p.step === 2) {
        try {
          const newBot = await AuthorizedBot.create({
            botUsername: p.botUsername,
            apiUrl: text,
            addedBy: uid,
            isActive: true,
          });
          botCache.add(newBot.toObject());
          await ctx.reply(
            `✅ Bot added successfully!\n\n@${md(newBot.botUsername.replace(/^@/, ''))}\nAPI: \`${mdCode(newBot.apiUrl)}\``,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          await ctx.reply(`❌ Error: ${md(err.message)}`);
        } finally {
          delete pending[uid];
        }
        return;
      }
    }

    if (p.type === 'bot_edit_field') {
      try {
        const field = p.field;
        const value = field === 'botUsername' ? text.replace(/^@/, '') : text;
        const updated = await AuthorizedBot.findByIdAndUpdate(
          p.botId,
          { [field]: value },
          { new: true }
        ).lean();
        botCache.update(updated);
        const label = field === 'botUsername' ? 'Username' : 'API URL';
        const display = field === 'botUsername'
          ? `@${md(updated.botUsername.replace(/^@/, ''))}`
          : `\`${mdCode(updated.apiUrl)}\``;
        await ctx.reply(
          `✅ ${md(label)} updated successfully!\n\nNew: ${display}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await ctx.reply(`❌ Error: ${md(err.message)}`);
      } finally {
        delete pending[uid];
      }
      return;
    }

    if (p.type === 'admin_add') {
      if (p.step === 1) {
        const isNumeric = /^\d+$/.test(text);
        p.telegramId = isNumeric ? Number(text) : null;
        p.username = isNumeric ? null : (text.startsWith('@') ? text : `@${text}`);
        p.step = 2;
        await ctx.reply(
          'Step 2/2: Should this be a Super Admin? Send "yes" or "no"',
          cancelInlineKeyboard('admin_cancel')
        );
        return;
      }
      if (p.step === 2) {
        const isSuper = text.toLowerCase() === 'yes' || text.toLowerCase() === 'y';
        try {
          const newAdmin = await Admin.create({
            telegramId: p.telegramId,
            username: p.username,
            isSuperAdmin: isSuper,
            addedBy: uid,
          });
          adminCache.add(newAdmin.toObject());
          await ctx.reply(
            `✅ Admin added successfully!\n\n` +
            `${newAdmin.username || 'ID:' + newAdmin.telegramId}\n` +
            `${isSuper ? '👑 Super Admin' : '🛡 Admin'}`
          );
        } catch (err) {
          await ctx.reply(`❌ Error: ${err.message}`);
        } finally {
          delete pending[uid];
        }
        return;
      }
    }

    return next();
  });
};

module.exports.consumePendingInvoice = consumePendingInvoice;
