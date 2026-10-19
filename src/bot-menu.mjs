// These keys are configured as "push event" actions in the Feishu bot menu.
export const BOT_MENU_EVENT = 'application.bot.menu_v6';
export const BOT_MENU_ITEMS = [
  { key: 'fmux.dashboard', name: '会话面板' },
  { key: 'fmux.concierge', name: '回到管家' },
  { key: 'fmux.new', name: '新建会话' },
];

// Payload for PATCH /application/v7/applications/:app_id/ability.
// Publishing the application is a separate deployment step.
export function botMenuConfig() {
  return { bot: {
    enable: true,
    bot_menu_enable: true,
    // Keep shortcuts above the composer so typing never hides navigation.
    bot_menu_display_strategy: 3,
    bot_menus: BOT_MENU_ITEMS.map(({ key, name }, i) => ({
      menu_id: key, parent_menu_id: '', sort: i + 1,
      // Feishu rejects default_name alone; include the app's primary language.
      default_name: name, i18n_name: { zh_cn: name }, event_key: key, menu_content_type: 2,
    })),
  } };
}

// onRawEvent bypasses the channel's message allowlist, deduplication and queue.
// Apply those checks here before dispatching any menu action. The SDK currently
// flattens v2 envelopes; accept the original envelope as well.
export function createBotMenuHandler({ ownerOpenId, onMenu, onError, now = Date.now }) {
  const keys = new Set(BOT_MENU_ITEMS.map(({ key }) => key));
  const seen = new Map();
  const ttl = 5 * 60 * 1000;
  let pending = Promise.resolve();
  return (raw) => {
    const event = raw?.event || raw;
    const header = raw?.header || raw;
    const openId = event?.operator?.operator_id?.open_id;
    const key = event?.event_key;
    if (!ownerOpenId || openId !== ownerOpenId || !keys.has(key)) return Promise.resolve();
    const timestamp = Number(header?.create_time || event.timestamp);
    const at = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const current = now();
    if (!Number.isFinite(at) || at <= 0 || current - at > ttl || at - current > 60000) return Promise.resolve();
    for (const [id, expires] of seen) if (expires <= current) seen.delete(id);
    const id = header?.event_id || `${openId}:${key}:${timestamp}`;
    if (seen.has(id)) return Promise.resolve();
    if (seen.size >= 1000) seen.delete(seen.keys().next().value);
    seen.set(id, current + ttl);
    pending = pending
      .then(() => onMenu({ eventId: id, key, operator: { openId } }))
      .catch((error) => onError(error, key));
    return pending;
  };
}
