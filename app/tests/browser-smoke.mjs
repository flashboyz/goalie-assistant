import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const errors = [];
await mkdir('test-results', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/src/cloud.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/const url = .*?;/, 'const url = "";') });
  });
  await page.goto('http://127.0.0.1:5173');
  await page.locator('#account-panel summary').click();
  await page.locator('#account-status').filter({ hasText: 'ещё не настроено' }).waitFor();
  await page.locator('nav [data-t="diary"]').click();
  await page.locator('#dgood').fill('Сохранял внимание на шайбе');
  await page.locator('#dsave').click();
  await page.locator('#derr').filter({ hasText: 'Сохранено на устройстве' }).waitFor();
  assert.match(await page.locator('#dlist').textContent(), /Сохранял внимание/);
  await page.reload();
  await page.locator('nav [data-t="diary"]').click();
  await page.locator('#dlist').filter({ hasText: 'Сохранял внимание' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/mobile-diary.png', fullPage: true });
  page.on('dialog', d => d.accept());
  await page.locator('#dlist .x').click();
  await page.locator('#dsum').filter({ hasText: 'Пока нет записей' }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test-results/desktop-diary.png', fullPage: true });
  await page.close();

  // Exercise the real SDK against simulated HTTP responses; this is not a live cloud test.
  const cloud = await browser.newPage({ viewport: { width: 390, height: 844 } });
  cloud.on('pageerror', e => errors.push(e.message));
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'goalie@example.test',
    aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  let rows = [], failSave = false, confirmRequired = true, badPassword = false;
  await cloud.route('**/src/cloud.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/const url = .*?;/, 'const url = "https://test.supabase.co";')
      .replace(/const key = .*?;/, 'const key = "sb_publishable_test";');
    await route.fulfill({ response, body });
  });
  await cloud.route('https://test.supabase.co/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/auth/v1/signup' || url.pathname === '/auth/v1/token') {
      assert.equal(req.postDataJSON().email, user.email);
      assert.ok(req.postDataJSON().password);
      if (url.pathname.endsWith('signup') && confirmRequired) return send(user);
      if (badPassword) return send({ code: 'invalid_credentials', error_code: 'invalid_credentials', message: 'Invalid login credentials' }, 400);
      const encode = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      return send({ access_token: encode({ alg: 'HS256' }) + '.' + encode({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600 }) + '.signature',
        refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, user });
    }
    if (url.pathname === '/auth/v1/logout') return send({});
    if (url.pathname === '/rest/v1/profiles') return send(null, 201);
    if (url.pathname === '/rest/v1/diary_entries') {
      if (req.method() === 'GET') return send(rows);
      if (req.method() === 'POST') {
        if (failSave) return send({ message: 'simulated outage' }, 503);
        const data = req.postDataJSON();
        for (const row of (Array.isArray(data) ? data : [data])) {
          rows = rows.filter(r => r.id !== row.id); rows.push(row);
        }
        return send(null, 201);
      }
      if (req.method() === 'DELETE') { rows = []; return send(null); }
    }
    throw new Error('Unexpected request: ' + req.method() + ' ' + url.pathname);
  });
  await cloud.goto('http://127.0.0.1:5173');
  await cloud.locator('#account-panel summary').click();
  await cloud.locator('#auth-email').fill(user.email);
  await cloud.locator('#auth-signup-mode').click();
  await cloud.locator('#auth-password').fill('test-password-123');
  await cloud.locator('#auth-password-confirm').fill('different-password');
  await cloud.locator('#auth-submit').click();
  await cloud.locator('#account-message').filter({ hasText: 'Пароли не совпадают' }).waitFor();
  await cloud.locator('#auth-password-confirm').fill('test-password-123');
  await cloud.locator('#auth-submit').click();
  await cloud.locator('#account-message').filter({ hasText: 'требуется подтверждение почты' }).waitFor();
  assert.equal(await cloud.locator('#signout').isVisible(), false);
  confirmRequired = false;
  await cloud.locator('#auth-password').fill('test-password-123');
  await cloud.locator('#auth-password-confirm').fill('test-password-123');
  await cloud.locator('#auth-submit').click();
  await cloud.locator('#account-status').filter({ hasText: 'сохраняется в аккаунте' }).waitFor();
  await cloud.screenshot({ path: 'test-results/mobile-account.png', fullPage: true });
  await cloud.locator('nav [data-t="diary"]').click();
  await cloud.locator('#dgood').fill('Запись аккаунта');
  failSave = true;
  await cloud.locator('#dsave').click();
  await cloud.locator('#derr').filter({ hasText: 'Не удалось сохранить в аккаунте' }).waitFor();
  assert.equal(await cloud.locator('#dgood').inputValue(), 'Запись аккаунта');
  failSave = false;
  await cloud.locator('#dsave').click();
  await cloud.locator('#derr').filter({ hasText: 'Сохранено в аккаунте' }).waitFor();
  assert.equal(rows.length, 1);
  await cloud.locator('#dlist').filter({ hasText: 'Запись аккаунта' }).waitFor();
  await cloud.locator('nav [data-t="home"]').click();
  await cloud.locator('#signout').click();
  await cloud.locator('#account-message').filter({ hasText: 'Вы вышли' }).waitFor();
  await cloud.locator('nav [data-t="diary"]').click();
  await cloud.locator('#dsum').filter({ hasText: 'Пока нет записей' }).waitFor();
  assert.ok(!(await cloud.locator('#dlist').textContent()).includes('Запись аккаунта'));
  await cloud.locator('nav [data-t="home"]').click();
  badPassword = true;
  await cloud.locator('#auth-password').fill('wrong-password');
  await cloud.locator('#auth-submit').click();
  await cloud.locator('#account-message').filter({ hasText: 'Неверная почта или пароль' }).waitFor();
  badPassword = false;
  await cloud.locator('#auth-password').fill('test-password-123');
  await cloud.locator('#auth-submit').click();
  await cloud.locator('#account-status').filter({ hasText: 'сохраняется в аккаунте' }).waitFor();
  assert.equal(await cloud.locator('#auth-password').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: guest diary; simulated password signup/login, mismatch, unconfirmed email, invalid credentials, cloud failure and logout.');
} finally { await browser.close(); }
