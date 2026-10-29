const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PASSWORD_KEY_LENGTH = 64;
const WEAK_PASSWORDS = new Set(['admin12345', 'change-me-now']);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');

  if (!salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, 'hex');

  if (expected.length !== PASSWORD_KEY_LENGTH) {
    return false;
  }

  const actual = crypto.scryptSync(password, salt, expected.length);

  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Создаёт администратора или обновляет его пароль из .env.
 * .env — источник истины для логина и пароля администратора.
 */
function ensureAdmin() {
  const login = String(process.env.ADMIN_LOGIN || 'admin').trim();
  const password = String(process.env.ADMIN_PASSWORD || 'admin12345');

  if (!login) {
    throw new Error('ADMIN_LOGIN не может быть пустым.');
  }

  if (process.env.NODE_ENV === 'production' && WEAK_PASSWORDS.has(password)) {
    throw new Error(
      'Смените ADMIN_PASSWORD в .env перед запуском в production.'
    );
  }

  const passwordHash = hashPassword(password);
  const existing = db.prepare('SELECT id FROM users WHERE login = ?').get(login);

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      passwordHash,
      existing.id
    );
  } else {
    db.prepare(
      'INSERT INTO users (login, password_hash, created_at) VALUES (?, ?, ?)'
    ).run(login, passwordHash, new Date().toISOString());
  }

  console.log(`Администратор: ${login}`);

  if (WEAK_PASSWORDS.has(password)) {
    console.warn(
      '⚠ Используется демо-пароль. Смените ADMIN_PASSWORD в .env перед публикацией.'
    );
  }
}

function verifyLogin(login, password) {
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);

  if (!user) {
    return null;
  }

  return verifyPassword(password, user.password_hash) ? user : null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tokenHash, userId, csrfToken, expiresAt, now.toISOString());

  return { token, csrfToken, expiresAt };
}

function getSession(token) {
  if (!token) {
    return null;
  }

  const tokenHash = sha256(token);

  const row = db
    .prepare(
      `SELECT
         s.token_hash,
         s.csrf_token,
         s.expires_at,
         u.id AS user_id,
         u.login
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash);

  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  return {
    token,
    tokenHash,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    user: {
      id: Number(row.user_id),
      login: row.login,
    },
  };
}

function deleteSession(token) {
  if (!token) {
    return;
  }

  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(
    new Date().toISOString()
  );
}

module.exports = {
  SESSION_TTL_SECONDS,
  ensureAdmin,
  verifyLogin,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
};
