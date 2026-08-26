require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const authMiddleware        = require('./middleware/auth');

const startHandler   = require('./handlers/start');
const paymentHandlers = require('./handlers/payment');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(session());
bot.use(authMiddleware);

paymentHandlers(bot);
startHandler(bot);

bot.catch((err, ctx) => {
  console.error(`[bot error] update type: ${ctx.updateType}`, err);
  if (ctx.callbackQuery) {
    ctx.answerCbQuery('An error occurred. Please try again.').catch(() => {});
  } else {
    ctx.reply('An error occurred. Please try again.').catch(() => {});
  }
});

module.exports = bot;
