// Logs Laudi's own accounts in with the username + password you typed in the dashboard setup.
// If a site shows a puzzle, a code or a QR, you finish it yourself in the dashboard's "Screen" view.
const secrets = require('./secrets');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 5000 }).catch(() => {});
      await el.fill('').catch(() => {});
      await el.pressSequentially(String(value), { delay: 40 + Math.random() * 40 }).catch(() => el.fill(String(value)));
      return true;
    }
  }
  return false;
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** TikTok: email/username + password. Returns a short status string. */
async function tiktok(page) {
  const s = secrets.load();
  if (!s.tiktokUser || !s.tiktokPass) {
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    return 'TikTok login page is open - log in on the Screen page';
  }
  await page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await sleep(4000);
  const u = await fillFirst(page, ['input[name="username"]', 'input[placeholder*="mail" i]', 'input[type="text"]'], s.tiktokUser);
  await sleep(600);
  const p = await fillFirst(page, ['input[type="password"]'], s.tiktokPass);
  if (!u || !p) return "couldn't find TikTok's login boxes - finish it in the dashboard Screen view";
  await sleep(800);
  await clickFirst(page, ['button[data-e2e="login-button"]', 'button[type="submit"]', 'button:has-text("Log in")']);
  return 'TikTok login sent - if a puzzle or code shows up, solve it in the dashboard Screen view';
}

/** Element (matrix.org): username + password, old or new (account.matrix.org) login screens. */
async function element(page) {
  const s = secrets.load();
  if (!s.elementUser || !s.elementPass) return 'no Element login saved (dashboard > Setup)';
  const user = String(s.elementUser).replace(/^@/, '').replace(/:matrix\.org$/i, '');
  if (!/#\/login/.test(page.url()) && !/account\.matrix\.org/.test(page.url())) {
    await page.goto('https://app.element.io/#/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await sleep(5000);
  }
  // Classic Element form
  if (await fillFirst(page, ['#mx_LoginForm_username'], user)) {
    await fillFirst(page, ['#mx_LoginForm_password'], s.elementPass);
    await clickFirst(page, ['input[type="submit"]', 'button:has-text("Sign in")']);
    return 'Element login sent';
  }
  // New matrix.org account page
  await clickFirst(page, ['button:has-text("Continue")', 'a:has-text("Continue")', 'button:has-text("Sign in")']);
  await sleep(6000);
  if (await fillFirst(page, ['input[name="username"]', 'input[autocomplete="username"]'], user)) {
    await fillFirst(page, ['input[name="password"]', 'input[type="password"]'], s.elementPass);
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")']);
    await sleep(6000);
    await clickFirst(page, ['button:has-text("Continue")', 'button:has-text("Allow")']); // "let Element use your account"
    return 'Element login sent';
  }
  return "couldn't find Element's login boxes - finish it in the dashboard Screen view";
}

module.exports = { tiktok, element };
