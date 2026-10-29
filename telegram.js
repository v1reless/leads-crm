const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const TELEGRAM_API_BASE = (
  process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
).replace(/\/+$/, '');
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
).replace(/\/+$/, '');

const SERVICES = new Map([
  ['cosmetic', 'Косметический ремонт'],
  ['capital', 'Капитальный ремонт'],
  ['turnkey', 'Ремонт под ключ'],
  ['other', 'Другое'],
]);

function isTelegramConfigured() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

function formatLead(lead) {
  const time = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(lead.created_at || Date.now()));

  return [
    `🛠 Новая заявка №${lead.id}`,
    '',
    `👤 Имя: ${lead.name}`,
    `📞 Телефон: ${lead.phone}`,
    `🧰 Услуга: ${SERVICES.get(lead.service) || lead.service}`,
    `💬 Комментарий: ${lead.message || '—'}`,
    `🕒 Создана: ${time} (МСК)`,
  ].join('\n');
}

async function sendLeadNotification(lead) {
  if (!isTelegramConfigured()) {
    return { skipped: true };
  }

  const payload = {
    chat_id: CHAT_ID,
    text: formatLead(lead),
    disable_web_page_preview: true,
  };

  // Кнопка на локальный адрес бессмысленна на телефоне и может быть
  // отклонена Telegram, поэтому добавляем её только для публичного URL.
  const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(
    PUBLIC_BASE_URL
  );

  if (PUBLIC_BASE_URL && !isLocalUrl) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: 'Открыть в CRM',
            url: `${PUBLIC_BASE_URL}/admin?lead=${lead.id}`,
          },
        ],
      ],
    };
  }

  let response;

  try {
    response = await fetch(
      `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (error) {
    const cause =
      error.name === 'TimeoutError'
        ? 'таймаут'
        : error.cause?.code || error.message;

    throw new Error(`Нет связи с Telegram (${cause})`);
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.ok === false) {
    throw new Error(result.description || `Telegram HTTP ${response.status}`);
  }

  return { skipped: false };
}

module.exports = {
  isTelegramConfigured,
  sendLeadNotification,
};
