// In-memory admin cache
let admins = [];
let authorizedBots = [];

const adminCache = {
  set(list) {
    admins = list;
  },
  getAll() {
    return admins;
  },
  isAdmin(telegramId, username) {
    return admins.some((a) => {
      if (telegramId && a.telegramId === telegramId) return true;
      if (username && a.username) {
        return a.username.toLowerCase() === `@${username}`.toLowerCase();
      }
      return false;
    });
  },
  isSuperAdmin(telegramId, username) {
    return admins.some((a) => {
      if (!a.isSuperAdmin) return false;
      if (telegramId && a.telegramId === telegramId) return true;
      if (username && a.username) {
        return a.username.toLowerCase() === `@${username}`.toLowerCase();
      }
      return false;
    });
  },
  add(admin) {
    admins.push(admin);
  },
  removeById(telegramId) {
    admins = admins.filter((a) => a.telegramId !== telegramId);
  },
  removeByUsername(username) {
    const normalized = username.toLowerCase();
    admins = admins.filter(
      (a) => !a.username || a.username.toLowerCase() !== normalized
    );
  },
};

const botCache = {
  set(list) {
    authorizedBots = list;
  },
  getAll() {
    return authorizedBots;
  },
  getByUsername(username) {
    const normalized = username.toLowerCase().replace(/^@/, '');
    return authorizedBots.find((b) => {
      const botNormalized = b.botUsername.toLowerCase().replace(/^@/, '');
      return botNormalized === normalized && b.isActive;
    });
  },
  add(bot) {
    authorizedBots.push(bot);
  },
  remove(id) {
    authorizedBots = authorizedBots.filter((b) => String(b._id) !== String(id));
  },
  update(bot) {
    const idx = authorizedBots.findIndex((b) => String(b._id) === String(bot._id));
    if (idx !== -1) authorizedBots[idx] = bot;
  },
};

module.exports = { adminCache, botCache };
