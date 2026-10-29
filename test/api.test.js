const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'Test-Password-12345!';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tempDir;
let baseUrl;
let crmProcess;
let serverLogs = '';
let telegramMock;
let telegramMode = 'ok';
let telegramRequests = [];
let telegramWaiters = [];
let auth;
let mainLead;
let secondLead;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startTelegramMock(port) {
  return new Promise((resolve, reject) => {
    telegramMock = http.createServer(async (req, res) => {
      let raw = '';

      for await (const chunk of req) {
        raw += chunk;
      }

      let body = null;

      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }

      telegramRequests.push({
        method: req.method,
        url: req.url,
        body,
      });

      while (
        telegramWaiters.length > 0 &&
        telegramRequests.length >= telegramWaiters[0].count
      ) {
        const waiter = telegramWaiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve();
      }

      if (telegramMode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            description: 'Mock Telegram failure',
          })
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: { message_id: telegramRequests.length },
        })
      );
    });

    telegramMock.once('error', reject);
    telegramMock.listen(port, '127.0.0.1', () => resolve());
  });
}

function waitForTelegramRequests(count) {
  if (telegramRequests.length >= count) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      count,
      resolve,
      timer: setTimeout(() => {
        const index = telegramWaiters.indexOf(waiter);

        if (index !== -1) {
          telegramWaiters.splice(index, 1);
        }

        reject(
          new Error(
            `Telegram mock не получил ${count} запрос(ов).\n${serverLogs}`
          )
        );
      }, 8000),
    };

    telegramWaiters.push(waiter);
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (crmProcess.exitCode !== null) {
      throw new Error(`Сервер завершился раньше времени.\n${serverLogs}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Сервер ещё не начал слушать порт.
    }

    await delay(100);
  }

  throw new Error(`Сервер не запустился.\n${serverLogs}`);
}

async function request(
  pathname,
  { method = 'GET', body, headers = {}, cookie, csrf } = {}
) {
  const requestHeaders = { ...headers };

  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  if (cookie) {
    requestHeaders.Cookie = cookie;
  }

  if (csrf) {
    requestHeaders['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
}

async function loginAsAdmin() {
  const response = await request('/api/login', {
    method: 'POST',
    body: { login: 'admin', password: ADMIN_PASSWORD },
  });

  assert.equal(response.status, 200, JSON.stringify(response.json));

  const setCookie =
    response.headers.getSetCookie?.()[0] ||
    response.headers.get('set-cookie');

  assert.ok(setCookie, 'Сервер должен установить cookie сессии');

  return {
    cookie: setCookie.split(';')[0],
    csrf: response.json.csrfToken,
    response,
  };
}

async function waitForLead(id, predicate, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(`/api/leads/${id}`, {
      cookie: auth.cookie,
    });

    if (response.status === 200 && predicate(response.json.lead)) {
      return response.json.lead;
    }

    await delay(50);
  }

  throw new Error(`Заявка #${id} не перешла в ожидаемое состояние.\n${serverLogs}`);
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leads-crm-test-'));
  const telegramPort = await getFreePort();
  await startTelegramMock(telegramPort);

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  crmProcess = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'test',
      ADMIN_LOGIN: 'admin',
      ADMIN_PASSWORD,
      DB_PATH: path.join(tempDir, 'crm.sqlite'),
      BOT_TOKEN: 'test-token',
      CHAT_ID: '12345',
      TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
      PUBLIC_BASE_URL: 'https://crm.example.test',
      CORS_ORIGIN: 'https://example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  crmProcess.stdout.on('data', (chunk) => {
    serverLogs += chunk;
  });

  crmProcess.stderr.on('data', (chunk) => {
    serverLogs += chunk;
  });

  await waitForServer();
  auth = await loginAsAdmin();
});

after(async () => {
  if (
    crmProcess &&
    crmProcess.exitCode === null &&
    crmProcess.signalCode === null
  ) {
    crmProcess.kill('SIGTERM');

    await Promise.race([
      new Promise((resolve) => crmProcess.once('exit', resolve)),
      delay(3000),
    ]);

    if (crmProcess.exitCode === null && crmProcess.signalCode === null) {
      crmProcess.kill('SIGKILL');
    }
  }

  if (telegramMock) {
    await new Promise((resolve) => telegramMock.close(resolve));
  }

  if (tempDir) {
    await fs
      .rm(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
      .catch(() => {});
  }
});

test('healthcheck показывает базу и Telegram', async () => {
  const response = await request('/api/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    ok: true,
    db: 'ok',
    telegramConfigured: true,
  });
});

test('статические страницы и защита от path traversal', async () => {
  const landing = await request('/');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /LeadCRM/);
  assert.equal(landing.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(landing.headers.get('x-frame-options'), 'DENY');
  assert.match(
    landing.headers.get('content-security-policy'),
    /default-src 'self'/
  );

  const admin = await request('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /Заявки/);

  const login = await request('/login');
  assert.equal(login.status, 200);
  assert.match(login.text, /Вход в CRM/);

  const traversal = await request('/%2e%2e/server.js');
  assert.equal(traversal.status, 404);

  const env = await request('/.env');
  assert.equal(env.status, 404);
});

test('без входа админские API недоступны', async () => {
  const list = await request('/api/leads');
  assert.equal(list.status, 401);

  const me = await request('/api/me');
  assert.equal(me.status, 401);

  const csv = await request('/api/export.csv');
  assert.equal(csv.status, 401);
});

test('CORS разрешает только настроенный origin', async () => {
  const allowed = await request('/api/leads', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://example.test',
      'Access-Control-Request-Method': 'POST',
    },
  });

  assert.equal(allowed.status, 204);
  assert.equal(
    allowed.headers.get('access-control-allow-origin'),
    'https://example.test'
  );

  const denied = await request('/api/leads', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.test',
      'Access-Control-Request-Method': 'POST',
    },
  });

  assert.equal(denied.status, 403);
});

test('валидация заявки возвращает понятные ошибки', async () => {
  const response = await request('/api/leads', {
    method: 'POST',
    body: {
      name: 'A',
      phone: '123',
      service: 'unknown',
      message: 'x'.repeat(501),
      consent: false,
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(Object.keys(response.json.errors).sort(), [
    'consent',
    'message',
    'name',
    'phone',
    'service',
  ]);
});

test('заявка сохраняется и уходит в Telegram', async () => {
  const payload = {
    name: 'Иван Петров',
    phone: '+7 (999) 222-33-44',
    service: 'turnkey',
    message: 'Нужен ремонт кухни',
    consent: true,
  };
  const beforeRequests = telegramRequests.length;
  const response = await request('/api/leads', {
    method: 'POST',
    body: payload,
    headers: { Origin: 'https://example.test' },
  });

  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'https://example.test'
  );

  mainLead = response.json.lead;
  assert.equal(mainLead.name, payload.name);
  assert.equal(mainLead.status, 'new');
  assert.equal(mainLead.consent, true);

  await waitForTelegramRequests(beforeRequests + 1);

  const telegramRequest = telegramRequests.at(-1);
  assert.equal(telegramRequest.url, '/bottest-token/sendMessage');
  assert.equal(telegramRequest.body.chat_id, '12345');
  assert.match(
    telegramRequest.body.text,
    new RegExp(`Новая заявка №${mainLead.id}`)
  );
  assert.ok(telegramRequest.body.text.includes(payload.name));
  assert.ok(telegramRequest.body.text.includes(payload.phone));
  assert.ok(telegramRequest.body.text.includes('Ремонт под ключ'));
  assert.equal(
    telegramRequest.body.reply_markup.inline_keyboard[0][0].url,
    `https://crm.example.test/admin?lead=${mainLead.id}`
  );

  const sentLead = await waitForLead(
    mainLead.id,
    (lead) => lead.telegram_sent === true
  );

  assert.equal(sentLead.telegram_error, '');
});

test('вход проверяет пароль и выдаёт безопасную cookie', async () => {
  const wrong = await request('/api/login', {
    method: 'POST',
    body: { login: 'admin', password: 'wrong-password' },
  });

  assert.equal(wrong.status, 401);

  const correct = await loginAsAdmin();
  const setCookie =
    correct.response.headers.getSetCookie?.()[0] ||
    correct.response.headers.get('set-cookie');

  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.doesNotMatch(setCookie, /Secure/);

  const me = await request('/api/me', { cookie: correct.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.login, 'admin');
  assert.equal(me.json.csrfToken, correct.csrf);
});

test('статус и заметку нельзя изменить без CSRF', async () => {
  const noCsrf = await request(`/api/leads/${mainLead.id}`, {
    method: 'PATCH',
    cookie: auth.cookie,
    body: { status: 'in_progress' },
  });

  assert.equal(noCsrf.status, 403);

  const updated = await request(`/api/leads/${mainLead.id}`, {
    method: 'PATCH',
    cookie: auth.cookie,
    csrf: auth.csrf,
    body: {
      status: 'in_progress',
      admin_note: 'Позвонить клиенту и уточнить смету',
    },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.json.lead.status, 'in_progress');
  assert.equal(
    updated.json.lead.admin_note,
    'Позвонить клиенту и уточнить смету'
  );

  const invalid = await request(`/api/leads/${mainLead.id}`, {
    method: 'PATCH',
    cookie: auth.cookie,
    csrf: auth.csrf,
    body: { status: 'unknown' },
  });

  assert.equal(invalid.status, 400);
});

test('поиск и фильтр по статусу работают', async () => {
  const byName = await request(
    `/api/leads?q=${encodeURIComponent('Иван')}`,
    { cookie: auth.cookie }
  );

  assert.equal(byName.status, 200);
  assert.equal(byName.json.leads.length, 1);
  assert.equal(byName.json.leads[0].id, mainLead.id);

  const empty = await request(
    `/api/leads?q=${encodeURIComponent('нет-такого')}`,
    { cookie: auth.cookie }
  );

  assert.equal(empty.status, 200);
  assert.equal(empty.json.leads.length, 0);

  const inProgress = await request('/api/leads?status=in_progress', {
    cookie: auth.cookie,
  });

  assert.equal(inProgress.status, 200);
  assert.equal(inProgress.json.leads.length, 1);
  assert.equal(inProgress.json.stats.in_progress, 1);

  const done = await request('/api/leads?status=done', {
    cookie: auth.cookie,
  });

  assert.equal(done.status, 200);
  assert.equal(done.json.leads.length, 0);
});

test('ошибка Telegram сохраняется, а повторная отправка её очищает', async () => {
  telegramMode = 'fail';
  const beforeRequests = telegramRequests.length;
  const response = await request('/api/leads', {
    method: 'POST',
    body: {
      name: '=SUM(A1:A2)',
      phone: '+7 999 111-22-33',
      service: 'other',
      message: '=1+1',
      consent: true,
    },
  });

  assert.equal(response.status, 201, JSON.stringify(response.json));
  secondLead = response.json.lead;
  await waitForTelegramRequests(beforeRequests + 1);

  const failedLead = await waitForLead(
    secondLead.id,
    (lead) => lead.telegram_error.includes('Mock Telegram failure')
  );

  assert.equal(failedLead.telegram_sent, false);

  telegramMode = 'ok';
  const beforeRetry = telegramRequests.length;
  const retry = await request(`/api/leads/${secondLead.id}/telegram`, {
    method: 'POST',
    cookie: auth.cookie,
    csrf: auth.csrf,
  });

  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  await waitForTelegramRequests(beforeRetry + 1);

  const sentLead = await waitForLead(
    secondLead.id,
    (lead) => lead.telegram_sent === true
  );

  assert.equal(sentLead.telegram_error, '');
});

test('CSV экспортируется и защищён от формул Excel', async () => {
  const response = await request('/api/export.csv', {
    cookie: auth.cookie,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.ok(response.text.startsWith('\uFEFF"ID";"Имя"'));
  assert.ok(response.text.includes('"В работе"'));
  assert.ok(response.text.includes('"\'=SUM(A1:A2)"'));
  assert.ok(response.text.includes('"\'=1+1"'));
});

test('удаление требует CSRF и убирает заявку', async () => {
  const noCsrf = await request(`/api/leads/${secondLead.id}`, {
    method: 'DELETE',
    cookie: auth.cookie,
  });

  assert.equal(noCsrf.status, 403);

  const deleted = await request(`/api/leads/${secondLead.id}`, {
    method: 'DELETE',
    cookie: auth.cookie,
    csrf: auth.csrf,
  });

  assert.equal(deleted.status, 200);

  const missing = await request(`/api/leads/${secondLead.id}`, {
    cookie: auth.cookie,
  });

  assert.equal(missing.status, 404);
});

test('выход очищает сессию', async () => {
  const noCsrf = await request('/api/logout', {
    method: 'POST',
    cookie: auth.cookie,
  });

  assert.equal(noCsrf.status, 403);

  const loggedOut = await request('/api/logout', {
    method: 'POST',
    cookie: auth.cookie,
    csrf: auth.csrf,
  });

  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);

  const me = await request('/api/me', { cookie: auth.cookie });
  assert.equal(me.status, 401);
});
