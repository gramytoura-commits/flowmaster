const fs = require('node:fs');
const path = require('node:path');

async function runSignupStart(config) {
  const root = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const value = (process.env[config.variable] || '').trim();
  if (!value || !config.pattern.test(value)) throw new Error(`${config.variable} is required and must be a valid ${config.inputLabel}.`);
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN is required.');
  let playwright;
  try { playwright = require('playwright'); }
  catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
  const endpoint = new URL('wss://production-sfo.browserless.io/stealth');
  endpoint.searchParams.set('token', token);
  endpoint.searchParams.set('emulationOs', 'windows');
  let browser;
  try {
    console.log(`Opening ${config.name} signup.`);
    browser = await playwright.chromium.connectOverCDP(endpoint.href, { timeout: 60000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    const input = page.locator(config.input).filter({ visible: true }).first();
    await input.waitFor({ state: 'visible' });
    if (process.argv.includes('--inspect')) {
      console.log('Signup form is available. Inspect only: nothing submitted; no account created.');
      return;
    }
    const cookieButton = page.locator('#onetrust-accept-btn-handler');
    if (await cookieButton.isVisible()) await cookieButton.click();
    await input.fill(value);
    await page.locator(config.next).filter({ visible: true }).first().click();
    await page.locator('input[type="password"]').filter({ visible: true }).first().waitFor({ state: 'visible' });
    const outputDir = process.env.FLOW_OUTPUT_DIR || path.join(root, 'data', config.id);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({
      flow: config.id, status: 'password_step_reached', accountCreated: false,
      message: 'The supplied recording ends at the password step. No account was created. The browser session is now closed.',
    }, null, 2));
    console.log('Password step reached. This flow ends here; no account was created.');
  } catch (error) {
    throw new Error(String(error.message).split(token).join('[REDACTED]'));
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { runSignupStart };
