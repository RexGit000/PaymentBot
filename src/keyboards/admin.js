const { Markup } = require('telegraf');

function mainAdminKeyboard() {
  const rows = [
    ['🤖 Manage Bots', '👥 Manage Admins'],
    ['📊 Bot Stats'],
  ];
  return Markup.keyboard(rows).resize();
}

function botsInlineKeyboard(bots) {
  const rows = bots.map((b) => [
    Markup.button.callback(
      `${b.isActive ? '✅' : '❌'} @${b.botUsername.replace(/^@/, '')}`,
      `bot_view:${b._id}`
    ),
  ]);
  rows.push([Markup.button.callback('➕ Add New Bot', 'bot_add')]);
  rows.push([Markup.button.callback('« Back to Admin', 'admin_back')]);
  return Markup.inlineKeyboard(rows);
}

function botActionsKeyboard(botId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏ Edit Username', `bot_edit_field:${botId}:botUsername`)],
    [Markup.button.callback('🔗 Edit API URL', `bot_edit_field:${botId}:apiUrl`)],
    [Markup.button.callback('🗑 Delete Bot', `bot_delete_confirm:${botId}`)],
    [Markup.button.callback('« Back to Bots List', 'bots_list')],
  ]);
}

function botDeleteConfirmKeyboard(botId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yes, Delete', `bot_delete:${botId}`)],
    [Markup.button.callback('✖ Cancel', `bot_view:${botId}`)],
  ]);
}

function adminsInlineKeyboard(admins) {
  const rows = admins.map((a) => {
    const label = a.username
      ? `${a.isSuperAdmin ? '👑' : '🛡'} ${a.username}`
      : `${a.isSuperAdmin ? '👑' : '🛡'} ID:${a.telegramId}`;
    return [Markup.button.callback(label, `admin_view:${a._id}`)];
  });
  rows.push([Markup.button.callback('➕ Add New Admin', 'admin_add')]);
  rows.push([Markup.button.callback('« Back to Admin', 'admin_back')]);
  return Markup.inlineKeyboard(rows);
}

function adminActionsKeyboard(adminId, isSelf) {
  const rows = [];
  if (!isSelf) {
    rows.push([Markup.button.callback('🗑 Remove Admin', `admin_delete_confirm:${adminId}`)]);
  }
  rows.push([Markup.button.callback('« Back to Admins List', 'admins_list')]);
  return Markup.inlineKeyboard(rows);
}

function adminDeleteConfirmKeyboard(adminId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yes, Remove', `admin_delete:${adminId}`)],
    [Markup.button.callback('✖ Cancel', `admin_view:${adminId}`)],
  ]);
}

function cancelInlineKeyboard(actionLabel = 'cancel') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✖ Cancel', actionLabel)],
  ]);
}

module.exports = {
  mainAdminKeyboard,
  botsInlineKeyboard,
  botActionsKeyboard,
  botDeleteConfirmKeyboard,
  adminsInlineKeyboard,
  adminActionsKeyboard,
  adminDeleteConfirmKeyboard,
  cancelInlineKeyboard,
};
