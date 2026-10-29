const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

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

test('production не запускается с демо-паролем', async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leads-crm-production-test-')
  );
  const port = await getFreePort();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      ADMIN_LOGIN: 'admin',
      ADMIN_PASSWORD: 'admin12345',
      DB_PATH: path.join(tempDir, 'crm.sqlite'),
      BOT_TOKEN: '',
      CHAT_ID: '',
      PUBLIC_BASE_URL: 'https://crm.example.test',
      CORS_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Сервер не завершился за 10 секунд.\n${output}`));
    }, 10000);

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.notEqual(result.code, 0);
  assert.match(output, /Смените ADMIN_PASSWORD/);

  await fs
    .rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
    .catch(() => {});
});
