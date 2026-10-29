const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadEnv } = require('./load-env');

loadEnv();

const { db, dbPath } = require('./db');
const {
  SESSION_TTL_SECONDS,
  ensureAdmin,
  verifyLogin,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
} = require('./auth');
const {
  isTelegramConfigured,
  sendLeadNotification,
} = require('./telegram');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';

const parsedPort = Number(process.env.PORT || 3000);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

const NODE_ENV = process.env.NODE_ENV || 'development';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || NODE_ENV === 'production';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const STATUSES = new Set(['new', 'in_progress', 'done', 'rejected']);
const STATUS_LABELS = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Завершена',
  rejected: 'Отклонена',
};

const SERVICES = new Map([
  ['cosmetic', 'Косметический ремонт'],
  ['capital', 'Капитальный ремонт'],
  ['turnkey', 'Ремонт под ключ'],
  ['other', 'Другое'],
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const ALLOWED_STATIC_EXTENSIONS = new Set(Object.keys(MIME_TYPES));
const STATIC_ALIASES = new Map([
  ['/', 'index.html'],
  ['/admin', 'admin.html'],
  ['/login', 'login.html'],
]);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LEAD_WINDOW_MS = 10 * 60 * 1000;
const MAX_LEADS_PER_WINDOW = 10;

const loginFailures = new Map();
const leadRate = new Map();

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PATCH,DELETE,OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-CSRF-Token'
    );
  }
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });

  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });

  res.end(text);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');

    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }

  return cookies;
}

function getSessionFromRequest(req) {
  return getSession(parseCookies(req).crm_session);
}

function requireAuth(req, res) {
  const session = getSessionFromRequest(req);

  if (!session) {
    sendJson(res, 401, { ok: false, error: 'Нужно войти в админку.' });
    return null;
  }

  return session;
}

function requireCsrf(req, res, session) {
  const token = req.headers['x-csrf-token'];

  if (typeof token !== 'string' || token !== session.csrfToken) {
    sendJson(res, 403, {
      ok: false,
      error: 'Неверный CSRF-токен. Обновите страницу и попробуйте снова.',
    });
    return false;
  }

  return true;
}

function makeSessionCookie(token) {
  const parts = [
    `crm_session=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  if (COOKIE_SECURE) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function clearSessionCookie() {
  const parts = [
    'crm_session=',
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];

  if (COOKIE_SECURE) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function getClientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isLoginBlocked(ip) {
  const entry = loginFailures.get(ip);

  if (!entry) {
    return false;
  }

  if (entry.resetAt <= Date.now()) {
    loginFailures.delete(ip);
    return false;
  }

  return entry.count >= MAX_LOGIN_FAILURES;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);

  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }

  entry.count += 1;
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function checkLeadRate(ip) {
  const now = Date.now();
  const entry = leadRate.get(ip);

  if (!entry || entry.resetAt <= now) {
    leadRate.set(ip, { count: 1, resetAt: now + LEAD_WINDOW_MS });
    return true;
  }

  if (entry.count >= MAX_LEADS_PER_WINDOW) {
    return false;
  }

  entry.count += 1;
  return true;
}

async function readJson(req) {
  let body = '';
  req.setEncoding('utf8');

  for await (const chunk of req) {
    body += chunk;

    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      const error = new Error('Слишком большой запрос.');
      error.code = 'TOO_LARGE';
      throw error;
    }
  }

  if (!body.trim()) {
    const error = new Error('Пустой запрос.');
    error.code = 'BAD_JSON';
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Некорректный JSON.');
    error.code = 'BAD_JSON';
    throw error;
  }
}

function validateLead(input) {
  const data =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = {};

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
  const service = typeof data.service === 'string' ? data.service.trim() : '';
  const message =
    typeof data.message === 'string' ? data.message.trim() : '';
  const consent = data.consent === true;
  const phoneDigits = phone.replace(/\D/g, '');

  if (name.length < 2) {
    errors.name = 'Имя должно быть не короче 2 символов.';
  } else if (name.length > 80) {
    errors.name = 'Имя не должно быть длиннее 80 символов.';
  }

  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    errors.phone = 'Телефон в формате +7 (999) 000-00-00.';
  }

  if (!SERVICES.has(service)) {
    errors.service = 'Выберите услугу.';
  }

  if (message.length > 500) {
    errors.message = 'Комментарий не должен быть длиннее 500 символов.';
  }

  if (!consent) {
    errors.consent = 'Нужно согласие на обработку данных.';
  }

  return {
    errors,
    lead: { name, phone, service, message, consent },
  };
}

function toApiLead(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    id: Number(row.id),
    consent: Boolean(row.consent),
    telegram_sent: Boolean(row.telegram_sent),
  };
}

function getLeadById(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

function getStats() {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM leads GROUP BY status')
    .all();

  const stats = {
    total: 0,
    new: 0,
    in_progress: 0,
    done: 0,
    rejected: 0,
  };

  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status] = Number(row.count);
    }

    stats.total += Number(row.count);
  }

  return stats;
}

async function notifyLead(lead) {
  try {
    const result = await sendLeadNotification(lead);

    if (!result.skipped) {
      db.prepare(
        'UPDATE leads SET telegram_sent = 1, telegram_error = ? WHERE id = ?'
      ).run('', Number(lead.id));
    }
  } catch (error) {
    const message = String(error.message || 'Ошибка Telegram').slice(0, 500);

    db.prepare('UPDATE leads SET telegram_error = ? WHERE id = ?').run(
      message,
      Number(lead.id)
    );

    console.error(`Telegram для заявки #${lead.id}:`, message);
  }
}

async function handleCreateLead(req, res) {
  const ip = getClientIp(req);

  if (!checkLeadRate(ip)) {
    sendJson(res, 429, {
      ok: false,
      error: 'Слишком много заявок. Попробуйте позже.',
    });
    return;
  }

  const contentType = req.headers['content-type'] || '';

  if (!contentType.includes('application/json')) {
    sendJson(res, 415, {
      ok: false,
      error: 'Нужен Content-Type: application/json.',
    });
    return;
  }

  let input;

  try {
    input = await readJson(req);
  } catch (error) {
    const status = error.code === 'TOO_LARGE' ? 413 : 400;
    sendJson(res, status, { ok: false, error: error.message });
    return;
  }

  const { errors, lead } = validateLead(input);

  if (Object.keys(errors).length > 0) {
    sendJson(res, 400, { ok: false, errors });
    return;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO leads
         (name, phone, service, message, consent, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'new', 'landing', ?, ?)`
    )
    .run(lead.name, lead.phone, lead.service, lead.message, now, now);

  const created = getLeadById(Number(result.lastInsertRowid));

  sendJson(res, 201, { ok: true, lead: toApiLead(created) });

  // Сначала сохраняем заявку и отвечаем пользователю.
  // Если Telegram недоступен, заявка всё равно остаётся в CRM.
  void notifyLead(created);
}

async function handleLogin(req, res) {
  const ip = getClientIp(req);

  if (isLoginBlocked(ip)) {
    sendJson(res, 429, {
      ok: false,
      error: 'Слишком много попыток входа. Попробуйте через 15 минут.',
    });
    return;
  }

  const contentType = req.headers['content-type'] || '';

  if (!contentType.includes('application/json')) {
    sendJson(res, 415, {
      ok: false,
      error: 'Нужен Content-Type: application/json.',
    });
    return;
  }

  let input;

  try {
    input = await readJson(req);
  } catch (error) {
    const status = error.code === 'TOO_LARGE' ? 413 : 400;
    sendJson(res, status, { ok: false, error: error.message });
    return;
  }

  const login = String(input.login || '').trim();
  const password = String(input.password || '');

  if (!login || !password) {
    sendJson(res, 400, {
      ok: false,
      error: 'Введите логин и пароль.',
    });
    return;
  }

  const user = verifyLogin(login, password);

  if (!user) {
    recordLoginFailure(ip);
    sendJson(res, 401, {
      ok: false,
      error: 'Неверный логин или пароль.',
    });
    return;
  }

  clearLoginFailures(ip);

  const session = createSession(user.id);

  sendJson(
    res,
    200,
    {
      ok: true,
      user: { id: Number(user.id), login: user.login },
      csrfToken: session.csrfToken,
    },
    { 'Set-Cookie': makeSessionCookie(session.token) }
  );
}

function handleMe(req, res) {
  const session = requireAuth(req, res);

  if (!session) {
    return;
  }

  sendJson(res, 200, {
    ok: true,
    user: session.user,
    csrfToken: session.csrfToken,
  });
}

function handleLogout(req, res) {
  const session = requireAuth(req, res);

  if (!session) {
    return;
  }

  if (!requireCsrf(req, res, session)) {
    return;
  }

  deleteSession(session.token);

  sendJson(
    res,
    200,
    { ok: true },
    { 'Set-Cookie': clearSessionCookie() }
  );
}

function handleListLeads(req, res, url) {
  const session = requireAuth(req, res);

  if (!session) {
    return;
  }

  const status = url.searchParams.get('status') || 'all';
  const q = String(url.searchParams.get('q') || '').trim();
  const parsedLimit = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 200)
    : 100;

  const where = [];
  const params = [];

  if (status !== 'all' && STATUSES.has(status)) {
    where.push('status = ?');
    params.push(status);
  }

  if (q) {
    const like = `%${q}%`;
    where.push('(name LIKE ? OR phone LIKE ? OR message LIKE ?)');
    params.push(like, like, like);
  }

  const sql = `
    SELECT *
    FROM leads
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `;

  const leads = db.prepare(sql).all(...params, limit);

  sendJson(res, 200, {
    ok: true,
    leads: leads.map(toApiLead),
    stats: getStats(),
  });
}

function handleGetLead(req, res, id) {
  const session = requireAuth(req, res);

  if (!session) {
    return;
  }

  const lead = getLeadById(id);

  if (!lead) {
    sendJson(res, 404, { ok: false, error: 'Заявка не найдена.' });
    return;
  }

  sendJson(res, 200, { ok: true, lead: toApiLead(lead) });
}

async function handleUpdateLead(req, res, id) {
  const session = requireAuth(req, res);

  if (!session || !requireCsrf(req, res, session)) {
    return;
  }

  let input;

  try {
    input = await readJson(req);
  } catch (error) {
    const status = error.code === 'TOO_LARGE' ? 413 : 400;
    sendJson(res, status, { ok: false, error: error.message });
    return;
  }

  const updates = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(input, 'status')) {
    const status = String(input.status || '');

    if (!STATUSES.has(status)) {
      sendJson(res, 400, { ok: false, error: 'Неизвестный статус.' });
      return;
    }

    updates.push('status = ?');
    params.push(status);
  }

  if (Object.prototype.hasOwnProperty.call(input, 'admin_note')) {
    if (typeof input.admin_note !== 'string') {
      sendJson(res, 400, {
        ok: false,
        error: 'Заметка должна быть строкой.',
      });
      return;
    }

    const adminNote = input.admin_note.trim();

    if (adminNote.length > 2000) {
      sendJson(res, 400, {
        ok: false,
        error: 'Заметка не должна быть длиннее 2000 символов.',
      });
      return;
    }

    updates.push('admin_note = ?');
    params.push(adminNote);
  }

  if (updates.length === 0) {
    sendJson(res, 400, {
      ok: false,
      error: 'Нет полей для обновления.',
    });
    return;
  }

  const existing = getLeadById(id);

  if (!existing) {
    sendJson(res, 404, { ok: false, error: 'Заявка не найдена.' });
    return;
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString(), id);

  db.prepare(
    `UPDATE leads SET ${updates.join(', ')} WHERE id = ?`
  ).run(...params);

  sendJson(res, 200, { ok: true, lead: toApiLead(getLeadById(id)) });
}

function handleDeleteLead(req, res, id) {
  const session = requireAuth(req, res);

  if (!session || !requireCsrf(req, res, session)) {
    return;
  }

  const result = db.prepare('DELETE FROM leads WHERE id = ?').run(id);

  if (result.changes === 0) {
    sendJson(res, 404, { ok: false, error: 'Заявка не найдена.' });
    return;
  }

  sendJson(res, 200, { ok: true });
}

async function handleSendTelegram(req, res, id) {
  const session = requireAuth(req, res);

  if (!session || !requireCsrf(req, res, session)) {
    return;
  }

  const lead = getLeadById(id);

  if (!lead) {
    sendJson(res, 404, { ok: false, error: 'Заявка не найдена.' });
    return;
  }

  try {
    const result = await sendLeadNotification(lead);

    if (result.skipped) {
      sendJson(res, 503, {
        ok: false,
        error: 'Telegram не настроен: добавьте BOT_TOKEN и CHAT_ID в .env.',
      });
      return;
    }

    db.prepare(
      'UPDATE leads SET telegram_sent = 1, telegram_error = ? WHERE id = ?'
    ).run('', id);

    sendJson(res, 200, { ok: true, lead: toApiLead(getLeadById(id)) });
  } catch (error) {
    const message = String(error.message || 'Ошибка Telegram').slice(0, 500);

    db.prepare('UPDATE leads SET telegram_error = ? WHERE id = ?').run(
      message,
      id
    );

    sendJson(res, 502, {
      ok: false,
      error: message,
      lead: toApiLead(getLeadById(id)),
    });
  }
}

function handleExportCsv(req, res) {
  const session = requireAuth(req, res);

  if (!session) {
    return;
  }

  const leads = db
    .prepare('SELECT * FROM leads ORDER BY created_at DESC')
    .all();

  const header = [
    'ID',
    'Имя',
    'Телефон',
    'Услуга',
    'Комментарий',
    'Статус',
    'Заметка',
    'Создана',
  ];

  const escapeCell = (value) => {
    const raw = String(value ?? '');
    // Защита от формул Excel: значения, начинающиеся с =, +, - или @,
    // превращаем в текст с помощью апострофа.
    const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines = [
    header.map(escapeCell).join(';'),
    ...leads.map((lead) =>
      [
        lead.id,
        lead.name,
        lead.phone,
        SERVICES.get(lead.service) || lead.service,
        lead.message,
        STATUS_LABELS[lead.status] || lead.status,
        lead.admin_note,
        lead.created_at,
      ]
        .map(escapeCell)
        .join(';')
    ),
  ];

  const csv = `\uFEFF${lines.join('\r\n')}`;

  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="leads.csv"',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(csv),
  });

  res.end(csv);
}

function handleHealth(req, res) {
  let dbOk = false;

  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  sendJson(res, 200, {
    ok: dbOk,
    db: dbOk ? 'ok' : 'error',
    telegramConfigured: isTelegramConfigured(),
  });
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  let decodedPath;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  const relative = STATIC_ALIASES.get(decodedPath) ||
    decodedPath.replace(/^\/+/, '');

  const filePath = path.resolve(PUBLIC_DIR, relative);

  if (
    !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) ||
    !ALLOWED_STATIC_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  ) {
    sendText(res, 404, 'Not found');
    return;
  }

  try {
    const stat = await fs.stat(filePath);

    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const data = await fs.readFile(filePath);

    res.writeHead(200, {
      'Content-Type':
        MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });

    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(data);
    }
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  applyCors(req, res);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      if (
        req.headers.origin &&
        CORS_ORIGINS.includes(req.headers.origin)
      ) {
        res.writeHead(204);
        res.end();
      } else {
        sendJson(res, 403, { ok: false, error: 'CORS origin not allowed.' });
      }
      return;
    }

    if (pathname === '/api/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
        return;
      }

      handleHealth(req, res);
      return;
    }

    if (pathname === '/api/leads') {
      if (req.method === 'POST') {
        await handleCreateLead(req, res);
        return;
      }

      if (req.method === 'GET') {
        handleListLeads(req, res, url);
        return;
      }

      sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
      return;
    }

    if (pathname === '/api/login') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
        return;
      }

      await handleLogin(req, res);
      return;
    }

    if (pathname === '/api/me') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
        return;
      }

      handleMe(req, res);
      return;
    }

    if (pathname === '/api/logout') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
        return;
      }

      handleLogout(req, res);
      return;
    }

    if (pathname === '/api/export.csv') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
        return;
      }

      handleExportCsv(req, res);
      return;
    }

    const telegramMatch = pathname.match(
      /^\/api\/leads\/(\d+)\/telegram$/
    );

    if (telegramMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
        return;
      }

      await handleSendTelegram(req, res, Number(telegramMatch[1]));
      return;
    }

    const leadMatch = pathname.match(/^\/api\/leads\/(\d+)$/);

    if (leadMatch) {
      const id = Number(leadMatch[1]);

      if (req.method === 'GET') {
        handleGetLead(req, res, id);
        return;
      }

      if (req.method === 'PATCH') {
        await handleUpdateLead(req, res, id);
        return;
      }

      if (req.method === 'DELETE') {
        handleDeleteLead(req, res, id);
        return;
      }

      sendJson(res, 405, { ok: false, error: 'Метод не разрешён.' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'API не найден.' });
      return;
    }

    await handleStatic(req, res, pathname);
  } catch (error) {
    console.error('Ошибка запроса:', error);

    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: 'Внутренняя ошибка сервера.',
      });
    } else {
      res.end();
    }
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Порт ${PORT} занят. Укажите другой PORT в .env или остановите старый сервер.`
    );
  } else {
    console.error('Ошибка сервера:', error);
  }

  process.exitCode = 1;
});

ensureAdmin();
cleanupSessions();

const sessionCleanupTimer = setInterval(cleanupSessions, 60 * 60 * 1000);
sessionCleanupTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`CRM:      http://${HOST}:${PORT}/`);
  console.log(`Админка:  http://${HOST}:${PORT}/admin`);
  console.log(`Health:   http://${HOST}:${PORT}/api/health`);
  console.log(`База:     ${dbPath}`);
  console.log(
    `Telegram: ${isTelegramConfigured() ? 'настроен' : 'не настроен (заявки всё равно сохраняются)'}`
  );
});

function shutdown() {
  console.log('\nОстанавливаю сервер...');

  server.close(() => {
    db.close();
    process.exit(0);
  });

  // Закрываем простаивающие keep-alive соединения, чтобы сервер
  // завершался сразу, а не ждал клиентов.
  server.closeIdleConnections?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
