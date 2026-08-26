const Admin = require('../models/Admin');
const AuthorizedBot = require('../models/AuthorizedBot');
const { adminCache, botCache } = require('../cache');

module.exports = async (ctx, next) => {
  if (!ctx.from) return next();

  const { id, username } = ctx.from;

  if (adminCache.getAll().length === 0) {
    try {
      const all = await Admin.find().lean();
      adminCache.set(all);
    } catch (err) {
      console.error('[auth middleware] admin cache reload error:', err);
    }
  }

  if (botCache.getAll().length === 0) {
    try {
      const all = await AuthorizedBot.find().lean();
      botCache.set(all);
    } catch (err) {
      console.error('[auth middleware] bot cache reload error:', err);
    }
  }

  ctx.state.isAdmin      = adminCache.isAdmin(id, username);
  ctx.state.isSuperAdmin = adminCache.isSuperAdmin(id, username);

  if (ctx.state.isAdmin && username) {
    try {
      const doc = await Admin.findOne({ username: `@${username}`, telegramId: null });
      if (doc) {
        doc.telegramId = id;
        await doc.save();
        const all = await Admin.find().lean();
        adminCache.set(all);
      }
    } catch (err) {
      console.error('[auth middleware] backfill error:', err);
    }
  }

  return next();
};
