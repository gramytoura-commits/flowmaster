// PowerShell: $env:INBOX_USERNAME="yourname"; node flows/inbox.js
// Add --inspect to inspect signup without submitting.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const outputDir = process.env.FLOW_OUTPUT_DIR || root;
fs.mkdirSync(outputDir, { recursive: true });

async function main() {
  const username = (process.env.INBOX_USERNAME || '').trim().toLowerCase();
  if (!username) {
    throw new Error('INBOX_USERNAME is required. PowerShell: $env:INBOX_USERNAME="yourname"; node flows/inbox.js');
  }
  let playwright;
  try { playwright = require('playwright'); }
  catch {
    const bundled = path.resolve(path.dirname(process.execPath), '../node_modules/playwright');
    try { playwright = require(bundled); }
    catch { throw new Error('Install Playwright first: npm install playwright'); }
  }
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN is required.');
  const endpoint = new URL('wss://production-sfo.browserless.io/stealth');
  endpoint.searchParams.set('token', token);
  endpoint.searchParams.set('emulationOs', 'windows');
  const inspect = process.argv.includes('--inspect');
  let browser;
  try {
    console.log(`Starting signup for ${username}@inbox.eu`);
    browser = await playwright.chromium.connectOverCDP(endpoint.href, { timeout: 60000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const cdp = await context.newCDPSession(page);
    await page.goto('https://login.inbox.eu/signup', { waitUntil: 'domcontentloaded' });
    const captcha = await cdp.send('Browserless.solveCaptcha', { wait: true });
    if (captcha.found !== false && captcha.solved !== true) {
      throw new Error(captcha.error || 'CAPTCHA could not be solved.');
    }
    console.log('Checking username availability…');
    await page.locator('#signup_user').fill(username);
    await page.locator('#check-uname').click();
    if (inspect) {
      console.log(JSON.stringify(await page.locator('form').evaluateAll(forms => forms.map(form => ({
        text: form.innerText,
        fields: [...form.querySelectorAll('input, button, a')].map(el => ({
          id: el.id, type: el.type, text: el.innerText, visible: !!el.getClientRects().length,
        })),
      }))), null, 2));
      return;
    }
    const passwordField = page.locator('#signup_password');
    // Some signup variants expose a separate Next link after availability checking.
    const next = page.getByText('Next', { exact: true });
    await page.waitForFunction(() => {
      const password = document.querySelector('#signup_password');
      return !!password?.getClientRects().length || [...document.querySelectorAll('a, button')]
        .some(el => el.textContent.trim() === 'Next' && el.getClientRects().length);
    });
    const alternatives = page.locator('input[type="radio"][id^="alternative"]:visible');
    if (await alternatives.count()) {
      throw new Error(`Username ${username}@inbox.eu is unavailable. Set INBOX_USERNAME to another name and run again.`);
    }
    if (!(await passwordField.isVisible()) && await next.isVisible()) await next.click();
    await passwordField.waitFor({ state: 'visible' });
    const credentialsPath = path.join(outputDir, 'inbox-credentials.json');
    const saved = fs.existsSync(credentialsPath) ? JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) : null;
    if (saved && saved.email !== `${username}@inbox.eu`) {
      throw new Error('inbox-credentials.json belongs to another username. Move it before registering another account.');
    }
    const password = saved?.password || process.env.INBOX_PASSWORD || `Aa1!${crypto.randomBytes(18).toString('base64url')}`;
    // Save before submission so credentials survive a navigation or connection error.
    if (!saved) fs.writeFileSync(credentialsPath, JSON.stringify({ email: `${username}@inbox.eu`, password,
      status: 'pending; verify account creation in browser' }, null, 2), { flag: 'wx', mode: 0o600 });
    await passwordField.fill(password);
    for (const selector of ['#signup_privacy', '#signup_tos']) {
      const checkbox = page.locator(selector);
      try { await checkbox.setChecked(true); }
      catch (error) {
        if (await checkbox.isChecked()) continue;
        await checkbox.focus();
        await checkbox.press('Space');
        if (!(await checkbox.isChecked())) throw error;
      }
    }
    await page.locator('#signup_submit').click();
    await page.waitForFunction(() => !document.querySelector('#signup_submit')?.getClientRects().length ||
      [...document.querySelectorAll('.error, [role="alert"]')].some(el => el.getClientRects().length && el.textContent.trim()));
    const errors = await page.locator('.error:visible, [role="alert"]:visible').allTextContents();
    if (errors.some(text => /Registration completed successfully! Your mailbox is ready to use\./i.test(text))) {
      fs.writeFileSync(credentialsPath, JSON.stringify({ email: `${username}@inbox.eu`, password,
        status: 'registered' }, null, 2), { mode: 0o600 });
      console.log(`Account created: ${username}@inbox.eu. Credentials saved in ${credentialsPath}.`);
      return;
    }
    if (errors.some(text => text.trim())) throw new Error(`Signup response: ${errors.join(' ').trim()}`);
    console.log(`Signup advanced to ${page.url()}. Credentials saved in ${credentialsPath}.`);
    console.log('Check the site for any remaining verification or activation steps.');
  } catch (error) {
    throw new Error(String(error.message).split(token).join('[REDACTED]'));
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
