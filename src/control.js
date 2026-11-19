// Small local API inside Laudi (only reachable from this computer, port 8788).
// The dashboard uses it to show Laudi's (invisible) browser screen, click/type for logins, and read his status.
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PORT = Number(process.env.CONTROL_PORT || 8788);

function start({ ctx, status, autologin, mainPage }) {
  const pages = () => ctx.pages().filter((p) => !p.isClosed());
  const pick = (i) => pages()[Math.max(0, Math.min(pages().length - 1, Number(i) || 0))];
  const body = (req) =>
    new Promise((res) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        try { res(JSON.parse(d || '{}')); } catch { res({}); }
      });
    });
  const json = (res, o, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };

  http
    .createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      try {
        if (u.pathname === '/status') return json(res, await status());
        if (u.pathname === '/tabs') {
          const out = [];
          for (const [i, p] of pages().entries()) out.push({ i, url: p.url(), title: await p.title().catch(() => '') });
          return json(res, out);
        }
        if (u.pathname === '/shot') {
          const p = pick(u.searchParams.get('tab'));
          const buf = await p.screenshot({ type: 'jpeg', quality: Number(u.searchParams.get('q')) || 55, timeout: 8000 });
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          return res.end(buf);
        }
        if (u.pathname === '/input' && req.method === 'POST') {
          const b = await body(req);
          const p = pick(b.tab);
          const [w, h] = await p.evaluate(() => [innerWidth, innerHeight]).catch(() => [1366, 900]);
          if (b.type === 'click') await p.mouse.click(b.x * w, b.y * h);
          else if (b.type === 'type') await p.keyboard.type(String(b.text || ''), { delay: 35 });
          else if (b.type === 'key') await p.keyboard.press(String(b.key || 'Enter'));
          else if (b.type === 'scroll') {
            await p.mouse.move((b.x || 0.5) * w, (b.y || 0.5) * h);
            await p.mouse.wheel(0, Number(b.dy) || 400);
          } else if (b.type === 'goto') await p.goto(String(b.url), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
          else if (b.type === 'back') await p.goBack().catch(() => {});
          else if (b.type === 'reload') await p.reload().catch(() => {});
          return json(res, { ok: true });
        }
        if (u.pathname === '/login' && req.method === 'POST') {
          const b = await body(req);
          if (b.site === 'tiktok') return json(res, { msg: await autologin.tiktok(mainPage()) });
          if (b.site === 'element') {
            const el = require('./element');
            const tab = el.tab ? el.tab() : null;
            if (!tab) return json(res, { msg: 'Element tab is not open yet' });
            return json(res, { msg: await autologin.element(tab) });
          }
          return json(res, { msg: 'unknown site' });
        }
        if (u.pathname === '/remote' && req.method === 'POST') {
          const b = await body(req);
          fs.appendFileSync(path.join(config.dataDir, 'remote.txt'), String(b.line || '').replace(/[\r\n]+/g, ' ') + '\n');
          return json(res, { ok: true });
        }
        json(res, { error: 'not found' }, 404);
      } catch (e) {
        json(res, { error: e.message.split('\n')[0] }, 500);
      }
    })
    .listen(PORT, '127.0.0.1', () => console.log(`[control] local control on 127.0.0.1:${PORT}`))
    .on('error', (e) => console.warn('[control]', e.message));
}

module.exports = { start };
