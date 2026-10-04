import { expect, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../support/env.js';
import { sendMail } from '../support/helpers.js';

/**
 * Browser end-to-end test (spec section 41):
 * login -> create mailbox -> send mail over SMTP -> live inbox update -> open message -> check subject, code,
 * link, HTML sandbox, attachment -> delete message -> delete mailbox.
 * Runs against the built UI served with the production Content-Security-Policy.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
}

test('login rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill('definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid/i);
  await expect(page).toHaveURL(/\/login/);
});

test('protected pages redirect to the login screen', async ({ page }) => {
  await page.goto('/mailboxes');
  await expect(page).toHaveURL(/\/login/);
});

test('mailbox lifecycle: create, receive, read, extract, download, delete', async ({ page }) => {
  // Anything that would execute from email content shows up as a dialog or a global flag.
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  await login(page);

  // 1. create a mailbox
  await page.getByRole('link', { name: 'Mailboxes', exact: true }).click();
  await page.getByRole('button', { name: 'New mailbox' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Prefix').fill('e2e');
  await dialog.getByLabel('Expires after').selectOption({ label: '15 minutes' });
  await dialog.getByRole('button', { name: 'Create mailbox' }).click();

  await expect(page).toHaveURL(/\/mailboxes\/[0-9a-f-]{36}$/);
  const address = (await page.getByTestId('mailbox-address').innerText()).trim();
  expect(address).toMatch(/^e2e-[a-z0-9]{6}@mailtest\.local$/);
  await expect(page.getByTestId('message-row')).toHaveCount(0);

  // 2. an "application" sends mail over real SMTP; the inbox updates without a reload
  await sendMail({
    to: address,
    subject: 'Verify your account',
    text: 'Your verification code is 482913\nVerify: https://app.example.com/verify?token=abc123',
    html:
      '<h1 style="color:#c00">Welcome</h1><p>Your verification code is <b>482913</b></p>' +
      '<a href="https://app.example.com/verify?token=abc123">Verify my email</a>' +
      '<script>window.parent.document.title="pwned";alert("xss-script")</script>' +
      '<img src="x" onerror="alert(\'xss-onerror\')">' +
      '<img src="https://tracker.example/pixel.gif">',
    attachments: [{ filename: 'welcome.txt', content: 'attachment body 12345' }],
  });

  const row = page.getByTestId('message-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-unread', 'true');
  await expect(row).toContainText('Verify your account');
  await expect(page.getByRole('status').filter({ hasText: 'Verify your account' })).toBeVisible(); // toast

  // 3. open it
  await row.click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('message-subject')).toHaveText('Verify your account');
  await expect(page.getByTestId('detected-code')).toHaveText('482913');
  await expect(page.getByTestId('detected-link').first()).toHaveText('https://app.example.com/verify?token=abc123');

  // 4. HTML renders safely inside the sandboxed iframe under the production CSP
  const iframe = page.locator('iframe[title="Email HTML"]');
  await expect(iframe).toBeVisible();
  const sandbox = (await iframe.getAttribute('sandbox')) ?? '';
  expect(sandbox.split(/\s+/).sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
  expect(await iframe.getAttribute('srcdoc')).toBeNull();
  const frame = page.frameLocator('iframe[title="Email HTML"]');
  await expect(frame.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await expect(frame.getByText('Your verification code is')).toBeVisible();
  expect(await frame.locator('script').count()).toBe(0);
  expect(await frame.locator('[onerror]').count()).toBe(0);
  // the sandbox/CSP stopped the remote tracking pixel from loading
  await expect(frame.locator('img[src^="https://tracker.example"]')).toHaveCount(1);
  const pixelLoaded = await frame
    .locator('img[src^="https://tracker.example"]')
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(pixelLoaded).toBe(false);

  // 5. other tabs
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Your verification code is 482913');
  await page.getByRole('tab', { name: 'Headers' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Message-ID');
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Subject: Verify your account');

  // 6. attachment download
  await page.getByRole('tab', { name: /Attachments/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: /welcome\.txt/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('welcome.txt');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe('attachment body 12345');

  // nothing from the hostile email executed
  expect(dialogs).toEqual([]);
  expect(await page.title()).not.toBe('pwned');

  // 7. going back, the message is now read
  await page.goBack();
  await expect(page.getByTestId('message-row')).toHaveAttribute('data-unread', 'false');

  // 8. delete the message
  await page.getByTestId('message-row').click();
  await page.getByRole('button', { name: 'Delete message' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page).toHaveURL(/\/mailboxes\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('message-row')).toHaveCount(0);

  // 9. delete the mailbox
  await page.getByRole('button', { name: 'Delete mailbox' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page).toHaveURL(/\/mailboxes$/);
  await expect(page.getByText(address)).toHaveCount(0);
});

test('API keys: create, see once, revoke', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'API Keys', exact: true }).click();
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.getByLabel('Key name').fill('playwright');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const key = (await page.getByTestId('new-api-key').innerText()).trim();
  expect(key).toMatch(/^mf_[A-Za-z0-9_-]{43}$/);

  // the key really authenticates against the API
  const res = await page.request.get('/api/mailboxes', { headers: { Authorization: `Bearer ${key}` } });
  expect(res.status()).toBe(200);

  await page.getByRole('row', { name: /playwright/ }).getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Confirm|Revoke/ }).click();
  await expect.poll(async () => (await page.request.get('/api/mailboxes', { headers: { Authorization: `Bearer ${key}` } })).status()).toBe(401);
});

test('signing out ends the session', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/mailboxes');
  await expect(page).toHaveURL(/\/login/);
});
