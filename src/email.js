// Gmail (or any IMAP/SMTP) reading and sending.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const config = require('./config');

const { email } = config;

async function withInbox(fn) {
  const client = new ImapFlow({
    host: email.imapHost,
    port: 993,
    secure: true,
    auth: { user: email.address, pass: email.password },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

function fromText(addr) {
  const a = addr && addr[0];
  if (!a) return 'unknown';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Latest emails (newest first): [{ uid, from, subject, date, unread }] */
async function list(limit = 10, unreadOnly = false) {
  return withInbox(async (client) => {
    const uids = (await client.search(unreadOnly ? { seen: false } : { all: true }, { uid: true })) || [];
    const pick = uids.slice(-Math.min(limit, 25));
    if (!pick.length) return [];
    const out = [];
    for await (const m of client.fetch(pick, { envelope: true, flags: true, uid: true }, { uid: true })) {
      out.push({
        uid: m.uid,
        from: fromText(m.envelope.from),
        subject: m.envelope.subject || '(no subject)',
        date: m.envelope.date ? new Date(m.envelope.date).toLocaleString() : '',
        unread: !(m.flags && m.flags.has('\\Seen')),
      });
    }
    return out.reverse();
  });
}

/** Full text of one email. */
async function read(uid) {
  return withInbox(async (client) => {
    const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!m) return null;
    const parsed = await simpleParser(m.source);
    return {
      uid,
      from: parsed.from ? parsed.from.text : 'unknown',
      to: parsed.to ? parsed.to.text : '',
      subject: parsed.subject || '(no subject)',
      date: parsed.date ? parsed.date.toLocaleString() : '',
      text: (parsed.text || '').replace(/\n{3,}/g, '\n\n').slice(0, 4000),
    };
  });
}

/** Emails newer than lastUid, for notifications. */
async function newSince(lastUid) {
  return withInbox(async (client) => {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    const fresh = uids.filter((u) => u > lastUid).slice(-10);
    const out = [];
    if (fresh.length) {
      for await (const m of client.fetch(fresh, { envelope: true, uid: true }, { uid: true })) {
        out.push({ uid: m.uid, from: fromText(m.envelope.from), subject: m.envelope.subject || '(no subject)' });
      }
    }
    const maxUid = uids.length ? Math.max(lastUid, ...uids) : lastUid;
    return { emails: out, maxUid };
  });
}

let transport;
async function send(to, subject, text) {
  transport =
    transport ||
    nodemailer.createTransport({
      host: email.smtpHost,
      port: 465,
      secure: true,
      auth: { user: email.address, pass: email.password },
    });
  await transport.sendMail({ from: email.address, to, subject, text });
}

module.exports = { list, read, newSince, send };
