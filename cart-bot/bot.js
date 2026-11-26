/**
 * 24/7 WhatsApp Attendance & Reminder Bot for Batagama Public Service Roster
 * Powered by @whiskeysockets/baileys and Firebase Firestore (Admin SDK)
 * Designed for 24/7 deployment on alwaysdata (Node.js)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');

// Modular firebase-admin imports (avoids admin.credential.cert undefined errors)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/* ==========================================================================
   CONFIG, RUNTIME STATE & HTTP KEEP-ALIVE SERVER (ALWAYSDATA)
   ========================================================================== */
const AUTH_DIR = path.resolve(__dirname, 'auth_info_baileys');
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, 'serviceAccountKey.json');
const PID_LOCK_PATH = path.resolve(__dirname, 'bot.pid');

// Admin phone number (Sri Lanka format: 947XXXXXXXX)
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '94701206001').replace(/\D/g, '');
const HTTP_PORT = parseInt(process.env.PORT || '8100', 10);
const HTTP_HOST = process.env.IP || '0.0.0.0';
const COLOMBO_TZ = 'Asia/Colombo';

let db = null;
let sock = null;
let isReconnecting = false;
let reconnectTimer = null;
let cronJobsStarted = false;
let sweeperInterval = null;
let membersCache = [];
let contactsCache = {};
let latestQr = null;
let latestQrDataUrl = null;
const sendingDocIds = new Set();
const sentMessagesStore = new Map();

const botState = {
  pid: process.pid,
  connectionStatus: 'DISCONNECTED', // 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'
  botJid: null,
  qrUpdatedAt: null,
  lastQrError: null,
  lastDisconnectCode: null,
  lastDisconnectReason: null,
  conflictBackoffUntil: null,
  firestoreConnected: false,
  bookingsMonitored: 0,
  membersCached: 0,
  contactsCached: 0,
  lastSentAt: null,
  lastSentTo: null,
  tomorrowDateStr: null,
  tomorrowBookingsCount: 0,
  lastDayBeforeBatchDate: null,
  lastDayBeforeBatchAt: null,
  lastDayBeforeSentCount: 0,
  lastSweeperAt: null,
  startedAt: new Date().toISOString(),
  recentLogs: []
};

function acquirePidLock() {
  try {
    if (fs.existsSync(PID_LOCK_PATH)) {
      const oldPid = parseInt(fs.readFileSync(PID_LOCK_PATH, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          console.warn(`⚠️ Found active PID ${oldPid} in bot.pid. Sending SIGTERM to avoid conflict...`);
          try { process.kill(oldPid, 'SIGTERM'); } catch (_) {}
        } catch (_) {
          // Stale PID file — safe to overwrite
        }
      }
    }
    fs.writeFileSync(PID_LOCK_PATH, String(process.pid), 'utf8');
  } catch (err) {
    console.warn('⚠️ PID lock warning:', err.message);
  }

  const cleanupPid = () => {
    try {
      if (fs.existsSync(PID_LOCK_PATH)) {
        const cur = parseInt(fs.readFileSync(PID_LOCK_PATH, 'utf8').trim(), 10);
        if (cur === process.pid) fs.unlinkSync(PID_LOCK_PATH);
      }
    } catch (_) {}
  };
  process.once('exit', cleanupPid);
  process.once('SIGINT', () => { cleanupPid(); process.exit(0); });
  process.once('SIGTERM', () => { cleanupPid(); process.exit(0); });
}

function getColomboNowParts(offsetDays = 0) {
  const now = new Date();
  const slOffsetMs = 5.5 * 60 * 60 * 1000;
  const slNow = new Date(now.getTime() + slOffsetMs + (offsetDays * 24 * 60 * 60 * 1000));
  const year = slNow.getUTCFullYear();
  const month = String(slNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(slNow.getUTCDate()).padStart(2, '0');
  const hour = slNow.getUTCHours();
  const minute = slNow.getUTCMinutes();
  const second = slNow.getUTCSeconds();
  return {
    year,
    month: slNow.getUTCMonth() + 1,
    day: slNow.getUTCDate(),
    hour,
    minute,
    second,
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  };
}

function formatDateToISO(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function sendWhatsAppMessage(jid, content) {
  if (!sock) throw new Error('WhatsApp socket not initialized');
  const sent = await sock.sendMessage(jid, content);
  if (sent && sent.key && sent.key.id && sent.message) {
    sentMessagesStore.set(sent.key.id, sent.message);
    if (sentMessagesStore.size > 500) {
      const oldestKey = sentMessagesStore.keys().next().value;
      sentMessagesStore.delete(oldestKey);
    }
  }
  return sent;
}

function pushLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  botState.recentLogs.unshift(line);
  if (botState.recentLogs.length > 30) {
    botState.recentLogs.length = 30;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function startHttpKeepAliveServer() {
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const reqPath = rawUrl.split('?')[0].replace(/\/+$/, '') || '/';
    const wantsJson = rawUrl.includes('format=json') ||
      (req.headers.accept && req.headers.accept.includes('application/json'));

    if (reqPath === '/qr.png' || reqPath === '/bot/qr.png') {
      if (!latestQr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('No active QR code (bot is already connected or initializing).');
        return;
      }
      try {
        const pngBuffer = await QRCode.toBuffer(latestQr, {
          type: 'png',
          width: 340,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': pngBuffer.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.end(pngBuffer);
      } catch (qrErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Failed to render QR PNG: ' + qrErr.message);
      }
      return;
    }

    if (reqPath === '/reset-auth' || reqPath === '/bot/reset-auth') {
      pushLog('🔄 Auth reset requested via HTTP (/reset-auth). Clearing session and generating fresh QR...');
      latestQr = null;
      latestQrDataUrl = null;
      botState.qrUpdatedAt = null;
      botState.connectionStatus = 'DISCONNECTED';
      botState.botJid = null;
      botState.lastDisconnectReason = 'Manual auth reset requested';

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      isReconnecting = false;

      if (sock) {
        try { sock.ev.removeAllListeners(); } catch (_) {}
        try { sock.end(undefined); } catch (_) {}
        sock = null;
      }

      try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } catch (rmErr) {
        console.error('Error clearing auth dir on reset-auth:', rmErr.message);
      }

      if (wantsJson) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, message: 'Auth session cleared. Generating new QR code...' }));
      } else {
        const redirectHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3;url=status">
  <title>Resetting WhatsApp Auth...</title>
  <style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.box{background:#fff;border:1.5px solid #0f172a;border-radius:10px;padding:24px 28px;text-align:center;max-width:420px;}</style>
</head>
<body>
  <div class="box">
    <h2 style="margin-top:0;">🔄 Generating New QR Code...</h2>
    <p>Auth session cleared. Redirecting back to Status Dashboard in 3 seconds...</p>
    <p><a href="status" style="color:#0369a1;font-weight:700;">Go to /status now</a></p>
  </div>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(redirectHtml);
      }

      setTimeout(() => {
        startBot().catch(err => pushLog(`❌ Restart after reset-auth failed: ${err.message}`));
      }, 600);
      return;
    }

    if (reqPath === '/status' || reqPath === '/bot/status') {
      const slNow = getColomboNowParts(0);
      const slTomorrow = getColomboNowParts(1);
      const batchRanToday = botState.lastDayBeforeBatchDate === slNow.dateStr;
      const dayBeforeStatusText = batchRanToday
        ? `✅ Ran today (${slNow.dateStr}) at ${botState.lastDayBeforeBatchAt} — Sent: ${botState.lastDayBeforeSentCount}`
        : `⏳ Waiting for 08:00–08:15 Asia/Colombo`;

      const payload = {
        service: 'Batagama CART WhatsApp Bot',
        pid: botState.pid,
        connectionStatus: botState.connectionStatus,
        botJid: botState.botJid,
        hasQr: !!latestQr,
        qrUpdatedAt: botState.qrUpdatedAt,
        lastQrError: botState.lastQrError,
        lastDisconnectCode: botState.lastDisconnectCode,
        lastDisconnectReason: botState.lastDisconnectReason,
        conflictBackoffUntil: botState.conflictBackoffUntil,
        firestoreConnected: !!db,
        bookingsMonitored: botState.bookingsMonitored,
        membersCached: botState.membersCached,
        contactsCached: botState.contactsCached,
        sentMessagesStoreSize: sentMessagesStore.size,
        sriLankaTime: `${slNow.dateStr} ${slNow.timeStr} (Asia/Colombo)`,
        tomorrowDate: botState.tomorrowDateStr || slTomorrow.dateStr,
        tomorrowBookingsCount: botState.tomorrowBookingsCount,
        dayBefore8AmReminderStatus: dayBeforeStatusText,
        lastDayBeforeBatchDate: botState.lastDayBeforeBatchDate,
        lastDayBeforeBatchAt: botState.lastDayBeforeBatchAt,
        lastDayBeforeSentCount: botState.lastDayBeforeSentCount,
        lastSweeperAt: botState.lastSweeperAt,
        lastSentAt: botState.lastSentAt,
        lastSentTo: botState.lastSentTo,
        startedAt: botState.startedAt,
        recentLogs: botState.recentLogs
      };

      if (wantsJson) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }

      const isConn = botState.connectionStatus === 'CONNECTED';
      const badgeColor = isConn ? '#16a34a' : (botState.connectionStatus === 'CONNECTING' ? '#d97706' : '#dc2626');
      const qrImageSrc = latestQrDataUrl || 'qr.png';
      const qrBlock = (!isConn && latestQr)
        ? `<div style="background:#ffffff;border:2px solid #0f172a;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
             <div style="font-weight:800;font-size:1.05rem;color:#0f172a;margin-bottom:10px;">📷 SCAN WHATSAPP QR CODE</div>
             <img src="${qrImageSrc}" alt="WhatsApp Login QR Code" style="width:300px;height:300px;max-width:100%;border:6px solid #ffffff;box-shadow:0 2px 10px rgba(0,0,0,0.12);background:#ffffff;"/>
             <div style="font-size:0.86rem;color:#334155;margin-top:10px;">Open WhatsApp on your phone &gt; <b>Settings / Menu</b> &gt; <b>Linked Devices</b> &gt; <b>Link a Device</b> &gt; Scan this QR code.</div>
             <div style="font-size:0.75rem;color:#64748b;margin-top:4px;">QR Generated: ${escapeHtml(botState.qrUpdatedAt || '')} (auto-refreshes every 10s)</div>
           </div>`
        : (!isConn
          ? `<div style="background:#fef3c7;border:1.5px solid #f59e0b;border-radius:10px;padding:14px;margin:16px 0;text-align:center;color:#92400e;font-weight:700;">⏳ Waiting for WhatsApp QR code... Page will refresh automatically.</div>`
          : '');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${isConn ? '' : '<meta http-equiv="refresh" content="10">'}
  <title>CART WhatsApp Bot Status</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px;}
    .card{max-width:780px;margin:0 auto;background:#fff;border:1.5px solid #0f172a;border-radius:10px;padding:22px;box-shadow:0 4px 12px rgba(0,0,0,0.06);}
    .badge{display:inline-block;padding:6px 14px;border-radius:20px;color:#fff;font-weight:800;font-size:0.9rem;background:${badgeColor};}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:10px;margin:16px 0;}
    .stat{background:#f1f5f9;border-radius:8px;padding:10px 12px;font-size:0.86rem;}
    .stat b{display:block;font-size:0.74rem;color:#64748b;text-transform:uppercase;margin-bottom:4px;}
    .btn-reset{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:7px;border:1.5px solid #dc2626;background:#fee2e2;color:#b91c1c;font-weight:700;font-size:0.84rem;cursor:pointer;text-decoration:none;}
    .btn-reset:hover{background:#fecaca;}
    pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;font-size:0.78rem;max-height:280px;}
  </style>
</head>
<body>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <h2 style="margin:0;">🤖 Batagama CART WhatsApp Bot</h2>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <a href="reset-auth" class="btn-reset" onclick="return confirm('Clear current WhatsApp session and generate a fresh QR code?');">🔄 Generate New QR</a>
        <span class="badge">${escapeHtml(botState.connectionStatus)}</span>
      </div>
    </div>
    ${qrBlock}
    <div class="grid">
      <div class="stat"><b>Bot JID / PID</b>${escapeHtml(botState.botJid || 'Not connected')} (PID: ${botState.pid})</div>
      <div class="stat"><b>Firestore</b>${db ? '🟢 Connected' : '🔴 Offline'}</div>
      <div class="stat"><b>Sri Lanka Time</b>${escapeHtml(slNow.dateStr + ' ' + slNow.timeStr)}</div>
      <div class="stat"><b>Tomorrow (${escapeHtml(botState.tomorrowDateStr || slTomorrow.dateStr)})</b>${botState.tomorrowBookingsCount} scheduled</div>
      <div class="stat"><b>8:00 AM Batch Status</b>${escapeHtml(dayBeforeStatusText)}</div>
      <div class="stat"><b>Bookings / Members</b>${botState.bookingsMonitored} / ${botState.membersCached} (Store: ${sentMessagesStore.size})</div>
      <div class="stat"><b>45s Sweeper</b>${escapeHtml(botState.lastSweeperAt || 'Initializing...')}</div>
      <div class="stat"><b>Last Reminder Sent</b>${escapeHtml(botState.lastSentTo ? `${botState.lastSentTo} (${botState.lastSentAt})` : 'None yet')}</div>
    </div>
    ${botState.lastQrError ? `<p style="color:#dc2626;font-size:0.85rem;"><b>Last QR Error:</b> ${escapeHtml(botState.lastQrError)}</p>` : ''}
    ${botState.lastDisconnectReason ? `<p style="color:#b45309;font-size:0.85rem;"><b>Last Disconnect (${escapeHtml(botState.lastDisconnectCode)}):</b> ${escapeHtml(botState.lastDisconnectReason)}</p>` : ''}
    <h4 style="margin:14px 0 6px;">Recent Logs</h4>
    <pre>${escapeHtml(botState.recentLogs.join('\n') || 'No logs yet.')}</pre>
  </div>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`CART WhatsApp Bot is Running 24/7! (Status: ${botState.connectionStatus})`);
  });

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    pushLog(`🌐 Alwaysdata HTTP Keep-Alive Server listening on http://${HTTP_HOST}:${HTTP_PORT} (/ and /status)`);
  });

  server.on('error', (err) => {
    console.error('❌ HTTP Server Error:', err.message);
  });
}

// 1. Initialize Firebase Admin SDK
function initFirebase() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn('\n=================================================================');
    console.warn('⚠️ WARNING: serviceAccountKey.json was not found in:');
    console.warn(`   ${SERVICE_ACCOUNT_PATH}`);
    console.warn('👉 Please download it from Firebase Console > Project Settings > Service Accounts');
    console.warn('   and place it in this folder. The bot will wait for it.');
    console.warn('=================================================================\n');
    botState.firestoreConnected = false;
    return null;
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    const firebaseApp = initializeApp({
      credential: cert(serviceAccount)
    }, 'cart-bot-app-' + Date.now());

    const firestoreDb = getFirestore(firebaseApp);
    botState.firestoreConnected = true;
    pushLog('✅ Firebase Admin Firestore connected successfully.');
    return firestoreDb;
  } catch (err) {
    botState.firestoreConnected = false;
    console.error('❌ Failed to initialize Firebase Admin:', err.message);
    return null;
  }
}

db = initFirebase();

/* ==========================================================================
   DATE & PHONE UTILITIES
   ========================================================================== */
const SINHALA_MONTHS = {
  'ජනවාරි': 0, 'පෙබරවාරි': 1, 'මාර්තු': 2, 'අප්‍රේල්': 3,
  'මැයි': 4, 'ජූනි': 5, 'ජූලි': 6, 'අගෝස්තු': 7,
  'සැප්තැම්බර්': 8, 'ඔක්තෝම්බර්': 9, 'නොවැම්බර්': 10, 'දෙසැම්බර්': 11
};

/**
 * Parses event dates like "සැප්තැම්බර් 05 වන සෙනසුරාදා 2026", "2026-09-05", "05/09/2026"
 */
function parseEventDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;

  // ISO format: YYYY-MM-DD
  const isoMatch = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
  }

  // DD/MM/YYYY
  const slashMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    return new Date(parseInt(slashMatch[3], 10), parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

  // Sinhala month string
  let month = -1;
  for (const [mName, mIdx] of Object.entries(SINHALA_MONTHS)) {
    if (dateStr.includes(mName)) {
      month = mIdx;
      break;
    }
  }

  const yearMatch = dateStr.match(/20\d\d/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : new Date().getFullYear();

  const dayMatch = dateStr.match(/(\d{1,2})/);
  const day = dayMatch ? parseInt(dayMatch[1], 10) : 1;

  if (month !== -1) {
    return new Date(year, month, day);
  }

  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Calculates days remaining until target date using Sri Lanka date (Asia/Colombo)
 * (0 = today, 1 = tomorrow, 2 = day after)
 */
function getDaysUntil(targetDate) {
  if (!targetDate) return 999;
  const slToday = getColomboNowParts(0);
  const startOfToday = Date.UTC(slToday.year, slToday.month - 1, slToday.day);
  const startOfTarget = Date.UTC(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  return Math.round((startOfTarget - startOfToday) / (1000 * 60 * 60 * 24));
}

/**
 * Extracts phone digits from WhatsApp JID
 */
function extractPhoneNumber(jid) {
  if (!jid) return '';
  return jid.replace(/@.*$/, '').replace(/\D/g, '');
}

/**
 * Normalizes any phone number format (0771234567, +94771234567, 94771234567, 393452166607, or with spaces)
 * into WhatsApp JID format (digits@s.whatsapp.net)
 */
function normalizePhoneDigits(phone) {
  if (!phone) return '';
  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('0')) {
    clean = '94' + clean.slice(1);
  } else if (clean.length === 9 && clean.startsWith('7')) {
    clean = '94' + clean;
  }
  return clean;
}

function getRecipientJid(phone) {
  const cleanPhone = normalizePhoneDigits(phone);
  if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) {
    return null;
  }
  return `${cleanPhone}@s.whatsapp.net`;
}

const MEMBER_NAME_ALIASES = {
  'ශ්‍රියානි බොතේජු': 'ශිරානි බොතේජු',
  'රොශිත්': 'රොසිත් පෙරේරා',
  'ශ්‍රේෂන්': 'ග්රේෂන් මුතුකුමාරණ',
  'ශ්‍රෙශාන්': 'ග්රේෂන් මුතුකුමාරණ'
};

function normalizeSinhalaForMatch(str) {
  return String(str || '')
    .replace(/[\u200C\u200D]/g, '')
    .trim()
    .toLowerCase()
    .replace(/ෂ/g, 'ශ')
    .replace(/ණ/g, 'න')
    .replace(/ළ/g, 'ල')
    .replace(/ඳ/g, 'ද')
    .replace(/ඟ/g, 'ග')
    .replace(/ඹ/g, 'බ')
    .replace(/ඬ/g, 'ඩ')
    .replace(/ං/g, 'න්')
    .replace(/ී/g, 'ි')
    .replace(/ූ/g, 'ු')
    .replace(/ේ/g, 'ෙ')
    .replace(/\s+/g, ' ');
}

let hasRunPhoneMigration = false;

async function migrateSameeraPhoneNumber() {
  if (!db || hasRunPhoneMigration) return;
  hasRunPhoneMigration = true;

  const OLD_PHONES = new Set(['0771438120', '771438120', '+94771438120', '94771438120']);
  const TARGET_PHONE = '94771438102';
  let updatedCount = 0;

  try {
    for (const colName of ['members', 'bookings', 'contacts']) {
      const snap = await db.collection(colName).get();
      for (const doc of snap.docs) {
        const d = doc.data() || {};
        const rawPhone = String(d.phone || '').replace(/[\s\-()]/g, '');
        const cleanDigits = normalizePhoneDigits(rawPhone);
        const nameNorm = normalizeSinhalaForMatch(d.name || d.memberName || '');
        const isOldSameeraTypo = OLD_PHONES.has(rawPhone) || OLD_PHONES.has(cleanDigits);
        const isSameeraBotPhone = (colName === 'members' && (doc.id === 'member_31' || d.id === 31) && cleanDigits === '94701206001') ||
          ((nameNorm === 'සමිර' || nameNorm.startsWith('සමිර ')) && cleanDigits === '94701206001');

        if (isOldSameeraTypo || isSameeraBotPhone) {
          await db.collection(colName).doc(doc.id).update({
            phone: TARGET_PHONE,
            updatedAt: FieldValue.serverTimestamp()
          });
          updatedCount++;
          pushLog(`🔧 [Phone Migration] Updated ${colName}/${doc.id} (${d.name || 'record'}) phone -> ${TARGET_PHONE}`);
        }
      }
    }
    if (updatedCount > 0) {
      pushLog(`✅ [Phone Migration] Completed Sameera phone update across ${updatedCount} Firestore document(s).`);
    }
  } catch (err) {
    console.warn('⚠️ Phone migration warning:', err.message);
  }
}

function resolvePhoneForBooking(personName, directPhone) {
  if (personName) {
    const raw = String(personName).trim();
    const aliased = MEMBER_NAME_ALIASES[raw] || raw;
    const norm = normalizeSinhalaForMatch(aliased);

    if (norm) {
      // 1. Always check live `members` collection cache FIRST so Member edits apply immediately
      let member = membersCache.find(m => normalizeSinhalaForMatch(m.name) === norm);
      if (!member) {
        member = membersCache.find(m => {
          const mn = normalizeSinhalaForMatch(m.name);
          return mn.startsWith(norm + ' ') || mn.startsWith(norm);
        });
      }
      if (!member) {
        member = membersCache.find(m => {
          const mn = normalizeSinhalaForMatch(m.name);
          return mn.includes(norm) || norm.includes(mn);
        });
      }
      if (member && member.phone) {
        const cleanMemberPhone = normalizePhoneDigits(member.phone);
        if (cleanMemberPhone && cleanMemberPhone.length >= 10 && cleanMemberPhone.length <= 15) {
          return cleanMemberPhone;
        }
      }

      // 2. Fall back to contacts cache
      if (contactsCache[raw]) return contactsCache[raw];
      if (contactsCache[norm]) return contactsCache[norm];
    }
  }

  // 3. Fall back to direct booking phone only if member/contact phone is unavailable
  const cleanDirect = normalizePhoneDigits(directPhone);
  if (cleanDirect && cleanDirect.length >= 10 && cleanDirect.length <= 15) {
    return cleanDirect;
  }
  return '';
}

/**
 * Generates phone variants to match numbers with or without leading 0 or country code 94
 */
function normalizePhoneVariants(phone) {
  const rawDigits = String(phone).replace(/\D/g, '');
  const digits = normalizePhoneDigits(rawDigits);
  const variants = new Set([digits, rawDigits, '+' + digits, '+' + rawDigits].filter(Boolean));
  if (digits.startsWith('94') && digits.length === 11) {
    variants.add('0' + digits.slice(2));
    variants.add(digits.slice(2));
  }
  return Array.from(variants).slice(0, 10);
}

/**
 * Queries Firestore bookings collection for active booking matching participant's phone
 */
async function findActiveBookingForPhone(senderPhone) {
  if (!db) return null;
  const phoneVariants = normalizePhoneVariants(senderPhone);

  try {
    const snapshot = await db.collection('bookings')
      .where('phone', 'in', phoneVariants)
      .get();

    if (snapshot.empty) return null;

    const docs = [];
    snapshot.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));

    // Sort to prioritize nearest upcoming booking
    docs.sort((a, b) => {
      const da = parseEventDate(a.eventDate);
      const dbDate = parseEventDate(b.eventDate);
      const daysA = da ? getDaysUntil(da) : 999;
      const daysB = dbDate ? getDaysUntil(dbDate) : 999;

      const validA = daysA >= -1 && daysA <= 30;
      const validB = daysB >= -1 && daysB <= 30;
      if (validA && !validB) return -1;
      if (!validA && validB) return 1;

      return daysA - daysB;
    });

    return docs[0];
  } catch (err) {
    console.error('Error finding active booking for phone:', senderPhone, err.message);
    return null;
  }
}

/* ==========================================================================
   WHATSAPP BOT CORE & QR AUTHENTICATION
   ========================================================================== */
async function startBot() {
  if (!db) {
    db = initFirebase();
  }
  await migrateSameeraPhoneNumber();
  setupMembersAndContactsListeners();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }

  botState.connectionStatus = 'CONNECTING';
  pushLog('🤖 BATAGAMA ROSTER WHATSAPP BOT STARTING (QR MODE)...');
  console.log('\n======================================================');
  console.log('🤖 BATAGAMA ROSTER WHATSAPP BOT STARTING (QR MODE)...');
  console.log(`👑 Admin Phone: +${ADMIN_PHONE}`);
  console.log('======================================================\n');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    getMessage: async (key) => (key && key.id ? sentMessagesStore.get(key.id) : undefined)
  });

  // Save auth credentials whenever updated
  sock.ev.on('creds.update', saveCreds);

  // Connection status, QR Code & auto-reconnect + conflict protection handling
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      botState.qrUpdatedAt = new Date().toISOString();
      botState.lastQrError = null;
      try {
        latestQrDataUrl = await QRCode.toDataURL(qr, {
          width: 320,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
      } catch (qrErr) {
        botState.lastQrError = qrErr.message;
        latestQrDataUrl = null;
      }
      pushLog('📷 New WhatsApp QR Code generated! Open /bot/status to scan.');
    }

    if (connection === 'close') {
      botState.connectionStatus = 'DISCONNECTED';
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || `Status ${statusCode || 'closed'}`;
      const isConflict = statusCode === DisconnectReason.connectionReplaced ||
        statusCode === 440 ||
        /conflict|replaced/i.test(errMsg);

      botState.lastDisconnectCode = statusCode || 'unknown';
      botState.lastDisconnectReason = isConflict
        ? `Session conflict (${statusCode || 440}) - backing off 30s`
        : errMsg;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      pushLog(`⚠️ Connection closed. Status code: ${statusCode}. Conflict: ${isConflict}. Reconnecting: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        pushLog('🔒 Device logged out. Clearing auth directory to generate new QR...');
        latestQr = null;
        latestQrDataUrl = null;
        botState.qrUpdatedAt = null;
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (rmErr) {
          console.error('Error clearing auth dir:', rmErr.message);
        }
        reconnectTimer = setTimeout(() => startBot(), 3000);
      } else if (shouldReconnect && !isReconnecting) {
        const delayMs = isConflict ? 30000 : 5000;
        isReconnecting = true;
        if (isConflict) {
          botState.conflictBackoffUntil = new Date(Date.now() + delayMs).toISOString();
        }
        console.log(`🔄 Reconnecting in ${delayMs / 1000} seconds...`);
        reconnectTimer = setTimeout(() => {
          isReconnecting = false;
          botState.conflictBackoffUntil = null;
          startBot();
        }, delayMs);
      }
    } else if (connection === 'open') {
      latestQr = null;
      latestQrDataUrl = null;
      botState.qrUpdatedAt = null;
      botState.lastQrError = null;
      botState.connectionStatus = 'CONNECTED';
      botState.botJid = sock.user?.id || 'Connected';
      botState.lastDisconnectReason = null;
      botState.conflictBackoffUntil = null;

      pushLog(`🚀 WHATSAPP BOT CONNECTED SUCCESSFULLY (${botState.botJid})`);
      console.log('\n======================================================');
      console.log('🚀 WHATSAPP BOT CONNECTED SUCCESSFULLY & LIVE 24/7!');
      console.log(`📱 Bot JID: ${botState.botJid}`);
      console.log('======================================================\n');

      // Start Real-time Firestore Listener on bookings collection
      setupFirestoreRealtimeListener();

      // Start 45-second background sweeper for Waiting bookings
      startWaitingBookingsSweeper();

      // Start cron jobs once connected
      if (!cronJobsStarted) {
        setupCronJobs();
        cronJobsStarted = true;
      }
    }
  });

  // Incoming messages handler (messages.upsert)
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      if (chatUpdate.type !== 'notify') return;

      for (const msg of chatUpdate.messages) {
        if (!msg.message || msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const remoteJid = msg.key.remoteJid;
        const phoneSourceJid = (remoteJid && remoteJid.endsWith('@lid') && msg.key.remoteJidAlt)
          ? msg.key.remoteJidAlt
          : remoteJid;
        const senderPhone = extractPhoneNumber(phoneSourceJid);
        
        // Extract message text content
        const messageText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''
        ).trim();

        if (!messageText) continue;

        pushLog(`📩 Incoming message from +${senderPhone}: "${messageText}"`);

        await handleIncomingMessage(remoteJid, senderPhone, messageText);
      }
    } catch (msgErr) {
      console.error('❌ Error in messages.upsert handler:', msgErr);
    }
  });
}

/* ==========================================================================
   MESSAGE PROCESSING & COMMAND HANDLERS
   ========================================================================== */
async function handleIncomingMessage(remoteJid, senderPhone, rawText) {
  const text = rawText.trim().toLowerCase();

  // 1. Admin Commands
  if (senderPhone === ADMIN_PHONE) {
    if (text === 'summary' || text === 'වාර්තාව' || text === 'report') {
      console.log('👑 Admin requested attendance summary.');
      await sendWhatsAppMessage(remoteJid, { text: '⏳ වාර්තාව සකස් කරමින් පවතී...' });
      await sendAndSaveDailySummary(remoteJid);
      return;
    } else if (text === 'ping' || text === 'test') {
      await sendWhatsAppMessage(remoteJid, { text: '🏓 Pong! Bot is running 24/7 on alwaysdata.\n🟢 Firestore Live: ' + (db ? 'Connected' : 'Offline') });
      return;
    }
  }

  // 2. Participant Booking Lookup
  if (!db) {
    await sendWhatsAppMessage(remoteJid, { text: '⚠️ සේවාදායකයේ දත්ත ගබඩාව සම්බන්ධ කරමින් පවතී. කරුණාකර සුළු මොහොතකින් නැවත උත්සාහ කරන්න.' });
    return;
  }

  const booking = await findActiveBookingForPhone(senderPhone);

  if (!booking) {
    console.log(`ℹ️ No active booking found for phone: +${senderPhone}`);
    const noBookingReply = `ආයුබෝවන්! 👋\n` +
      `ඔබගේ දුරකථන අංකය (+${senderPhone}) පොදු සේවා කාලසටහනෙහි ලියාපදිංචිව නොමැත.\n` +
      `කරුණාකර සභා භාරකරු අමතන්න.`;
    await sendWhatsAppMessage(remoteJid, { text: noBookingReply });
    return;
  }

  const personName = booking.name || 'සහෝදරයා/සහෝදරිය';
  const eventDate = booking.eventDate || 'නියමිත දිනය';
  const eventTime = booking.eventTime || 'නියමිත වේලාව';
  const location = booking.location || 'නමස්කාර මධ්‍යස්ථානය';

  // 3. Confirm Command: yes, ok, confirm, confirmed, හරි, එනවා, ow, etc.
  const confirmKeywords = ['yes', 'ok', 'confirm', 'confirmed', 'හරි', 'එනවා', 'hari', 'ow', 'oww', 'ඔව්', 'එන්නම්'];
  const isConfirm = confirmKeywords.some(k => text === k || text.startsWith(k + ' ') || text.startsWith(k + '.'));

  if (isConfirm) {
    await db.collection('bookings').doc(booking.id).update({
      status: 'Confirmed',
      declineReason: '',
      swapDetails: '',
      confirmedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    console.log(`✅ [Confirmed] ${personName} (+${senderPhone}) confirmed for ${eventDate}`);

    const reply = `ස්තූතියි ${personName}! ඔබගේ පැමිණීම සාර්ථකව තහවුරු කළා. ✅\n\n` +
                  `📅 දිනය: *${eventDate}*\n` +
                  `⏰ වේලාව: *${eventTime}*\n` +
                  `📍 ස්ථානය: *${location}*\n\n` +
                  `ස්වාමීන්ගේ ආශීර්වාදය ඔබට ලැබේවා! 🙏`;
    await sendWhatsAppMessage(remoteJid, { text: reply });
    return;
  }

  // 4. Decline Command: no, cant come, can't come, බෑ, එන්න බෑ, etc.
  const declineKeywords = ['no', "cant come", "can't come", 'cant', 'nae', 'naha', 'ba', 'baa', 'බෑ', 'එන්න බෑ', 'එන්න බැහැ', 'එන්න බැ'];
  let isDecline = false;
  let inlineReason = '';

  for (const k of declineKeywords) {
    if (text === k || text.startsWith(k + ' ') || text.startsWith(k + '-') || text.startsWith(k + ':') || text.startsWith(k + ',')) {
      isDecline = true;
      inlineReason = rawText.slice(k.length).replace(/^[\s\-:,]+/, '').trim();
      break;
    }
  }

  if (isDecline) {
    const updatePayload = {
      status: 'Declined',
      declinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (inlineReason) {
      updatePayload.declineReason = inlineReason;
    }

    await db.collection('bookings').doc(booking.id).update(updatePayload);
    console.log(`❌ [Declined] ${personName} (+${senderPhone}) declined for ${eventDate}. Reason: "${inlineReason}"`);

    let reply;
    if (inlineReason) {
      reply = `ස්තූතියි ${personName}. ඔබගේ නොපැමිණීම සටහන් කරගත්තා. ❌\n` +
              `📝 හේතුව: *${inlineReason}*\n\n` +
              `ඔබට වෙනත් අයෙකු සමඟ මාරු කරගත හැකි නම් *swap [විස්තර]* ලෙස එවන්න.`;
    } else {
      reply = `ඔබගේ නොපැමිණීම සටහන් කරගත්තා. ❌\n\n` +
              `කරුණාකර නොපැමිණීමට හේතුව *හේතුව: [ඔබගේ හේතුව]* හෝ *reason: [reason]* ලෙස එවන්න.`;
    }
    await sendWhatsAppMessage(remoteJid, { text: reply });
    return;
  }

  // 5. Reason Command: "reason: ..." or "හේතුව: ..."
  const isReason = text.startsWith('reason:') || text.startsWith('reason ') || text.startsWith('හේතුව:') || text.startsWith('හේතුව ');
  if (isReason) {
    const explicitReason = rawText.replace(/^(reason[:\s]+|හේතුව[:\s]+)/i, '').trim();
    if (explicitReason) {
      await db.collection('bookings').doc(booking.id).update({
        declineReason: explicitReason,
        status: 'Declined',
        updatedAt: FieldValue.serverTimestamp()
      });
      console.log(`📝 [Reason Saved] ${personName} (+${senderPhone}): "${explicitReason}"`);

      const reply = `හේතුව සාර්ථකව සටහන් කරගත්තා: "${explicitReason}". ස්තූතියි ${personName}! 🙏`;
      await sendWhatsAppMessage(remoteJid, { text: reply });
      return;
    }
  }

  // 6. Swap Command: "swap ..." or "මාරු ..."
  const isSwap = text.startsWith('swap') || text.startsWith('මාරු') || text.startsWith('maru');
  if (isSwap) {
    const swapDetails = rawText.replace(/^(swap[\s:]*|මාරු[\s:]*|maru[\s:]*)/i, '').trim();
    if (swapDetails) {
      await db.collection('bookings').doc(booking.id).update({
        status: 'Swapped',
        swapDetails: swapDetails,
        swappedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      console.log(`🔄 [Swapped] ${personName} (+${senderPhone}): "${swapDetails}"`);

      const reply = `මාරු කිරීම සාර්ථකව සටහන් කරගත්තා: "${swapDetails}". ස්තූතියි ${personName}! 🔄`;
      await sendWhatsAppMessage(remoteJid, { text: reply });
      return;
    } else {
      const reply = `කරුණාකර 'swap [මාරු කරගත් කෙනාගේ නම]' ලෙස එවන්න. (උදා: *swap සුදාර සමඟ*)`;
      await sendWhatsAppMessage(remoteJid, { text: reply });
      return;
    }
  }

  // 7. General Guidance Reply
  const helpReply = `ආයුබෝවන් ${personName}! 👋\n` +
    `පොදු සේවය (*${eventDate}* | *${eventTime}*) සඳහා:\n\n` +
    `• පැමිණෙන්නේ නම්: *හරි* (හෝ *ok* / *yes*)\n` +
    `• පැමිණිය නොහැකි නම්: *බෑ* (හෝ *no*)\n` +
    `• මාරු කරන්නේ නම්: *swap [නම]*\n\n` +
    `ලෙස පිළිතුරු එවන්න.`;
  await sendWhatsAppMessage(remoteJid, { text: helpReply });
}

/* ==========================================================================
   MEMBERS & CONTACTS FALLBACK LISTENERS
   ========================================================================== */
let membersUnsub = null;
let contactsUnsub = null;

function setupMembersAndContactsListeners() {
  if (!db) return;

  if (!membersUnsub) {
    membersUnsub = db.collection('members').onSnapshot((snapshot) => {
      const list = [];
      snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
      membersCache = list;
      botState.membersCached = list.length;
    }, (err) => {
      console.warn('⚠️ Members listener warning:', err.message);
    });
  }

  if (!contactsUnsub) {
    contactsUnsub = db.collection('contacts').onSnapshot((snapshot) => {
      const map = {};
      snapshot.forEach(doc => {
        const d = doc.data();
        if (d && d.name && d.phone) {
          const clean = normalizePhoneDigits(d.phone);
          if (clean) {
            map[String(d.name).trim()] = clean;
            map[normalizeSinhalaForMatch(d.name)] = clean;
          }
        }
      });
      contactsCache = map;
      botState.contactsCached = snapshot.size;
    }, (err) => {
      console.warn('⚠️ Contacts listener warning:', err.message);
    });
  }
}

/* ==========================================================================
   REAL-TIME FIRESTORE LISTENER (INSTANT REMINDERS ON ROSTER UPDATE)
   ========================================================================== */
let realtimeListenerUnsub = null;

async function trySendBookingReminder(docId, booking, isInitialCheck = false) {
  if (!sock || !db || botState.connectionStatus !== 'CONNECTED') return false;
  if (!booking || booking.status !== 'Waiting' || booking.lastSentAt) return false;
  if (sendingDocIds.has(docId)) return false;

  const personName = booking.name || booking.memberName || '';
  if (!personName) return false;

  const rawDate = booking.eventDate || booking.date || '';
  const pDate = parseEventDate(rawDate);
  const daysUntil = pDate ? getDaysUntil(pDate) : 0;

  // Check if this is a fresh manual trigger (within last 5 minutes) via manualTriggerAt or resendNonce
  let isFreshManualTrigger = false;
  if (!isInitialCheck) {
    let trigMs = 0;
    if (typeof booking.resendNonce === 'number') {
      trigMs = booking.resendNonce;
    } else if (booking.manualTriggerAt) {
      if (typeof booking.manualTriggerAt.toDate === 'function') {
        trigMs = booking.manualTriggerAt.toDate().getTime();
      } else if (typeof booking.manualTriggerAt === 'number') {
        trigMs = booking.manualTriggerAt;
      }
    }
    if (trigMs && (Date.now() - trigMs) <= 5 * 60 * 1000) {
      isFreshManualTrigger = true;
    }
  }

  // Never blast historical past dates automatically (allow only fresh manual re-triggers)
  if (pDate && daysUntil < 0 && !isFreshManualTrigger) return false;

  // Ensure membersCache is loaded before resolving phone
  if (membersCache.length === 0 && db) {
    try {
      const mSnap = await db.collection('members').get();
      const mList = [];
      mSnap.forEach(d => mList.push({ id: d.id, ...d.data() }));
      membersCache = mList;
      botState.membersCached = mList.length;
    } catch (_) {}
  }

  const resolvedPhone = resolvePhoneForBooking(personName, booking.phone);
  if (!resolvedPhone) {
    if (!isInitialCheck) {
      pushLog(`⚠️ [Skip Reminder] No phone found for ${personName} (doc: ${docId})`);
    }
    return false;
  }

  const recipientJid = getRecipientJid(resolvedPhone);
  if (!recipientJid) {
    pushLog(`⚠️ [Skip Reminder] Invalid phone number format for ${personName}: "${resolvedPhone}"`);
    await db.collection('bookings').doc(docId).update({
      phone: resolvedPhone,
      status: 'Invalid_Number',
      updatedAt: FieldValue.serverTimestamp()
    }).catch(() => {});
    return false;
  }

  sendingDocIds.add(docId);
  try {
    // Verify phone number exists on WhatsApp before sending
    let targetJid = recipientJid;
    try {
      const waCheck = await sock.onWhatsApp(recipientJid);
      if (Array.isArray(waCheck)) {
        const entry = waCheck[0];
        if (waCheck.length === 0 || (entry && entry.exists === false)) {
          pushLog(`❌ [Invalid_Number] ${personName} (+${resolvedPhone}) is NOT registered on WhatsApp.`);
          await db.collection('bookings').doc(docId).update({
            phone: resolvedPhone,
            status: 'Invalid_Number',
            updatedAt: FieldValue.serverTimestamp()
          });
          return false;
        }
        if (entry && entry.jid) {
          targetJid = entry.jid;
        }
      }
    } catch (waCheckErr) {
      pushLog(`⚠️ [onWhatsApp Check] Could not verify ${recipientJid} (${waCheckErr.message}), attempting send anyway...`);
    }

    pushLog(`⚡ [Live Roster Trigger] Sending reminder to ${personName} (+${resolvedPhone})`);

    const displayDate = booking.displayDate || rawDate || 'නියමිත දිනය';
    const displayTime = booking.eventTime || booking.timeSlot || booking.slot || 'නියමිත වේලාව';
    const displayLoc = booking.location || 'වැලිගම්පිටිය හන්දිය';

    const reminderText = `ආයුබෝවන් ${personName}! 👋\n` +
      `පොදු සේවය (බටගම සභාව) සඳහා ඔබට වෙන් කර ඇති සේවා වාරය:\n\n` +
      `📅 දිනය: *${displayDate}*\n` +
      `⏰ වේලාව: *${displayTime}*\n` +
      `📍 ස්ථානය: *${displayLoc}*\n\n` +
      `ඔබ මේ සඳහා සහභාගි වන්නේද?\n` +
      `• පැමිණෙන්නේ නම්: *හරි* (හෝ *yes* / *ok*)\n` +
      `• පැමිණිය නොහැකි නම්: *බෑ* (හෝ *no*)\n` +
      `• මාරු කරන්නේ නම්: *swap [විස්තර]*\n\n` +
      `ලෙස කරුණාකර දන්වන්න.`;

    await sendWhatsAppMessage(targetJid, { text: reminderText });
    pushLog(`✅ [Sent_1] Personalized reminder delivered to ${personName} (${targetJid})`);

    botState.lastSentAt = new Date().toISOString();
    botState.lastSentTo = `${personName} (+${resolvedPhone})`;

    // Mark Sent_1 and ensure resolved phone is saved in Firestore
    await db.collection('bookings').doc(docId).update({
      phone: resolvedPhone,
      status: 'Sent_1',
      lastSentAt: FieldValue.serverTimestamp(),
      retryCount: 0,
      updatedAt: FieldValue.serverTimestamp()
    });
    return true;
  } catch (sendErr) {
    pushLog(`❌ Failed to send reminder to ${recipientJid}: ${sendErr.message}`);
    return false;
  } finally {
    sendingDocIds.delete(docId);
  }
}

function updateTomorrowCountFromDocs(docs) {
  const slTomorrow = getColomboNowParts(1);
  botState.tomorrowDateStr = slTomorrow.dateStr;
  let count = 0;
  docs.forEach(doc => {
    const b = typeof doc.data === 'function' ? doc.data() : doc;
    if (!b || b.status === 'Declined') return;
    const pDate = parseEventDate(b.eventDate || b.date || '');
    if (pDate && formatDateToISO(pDate) === slTomorrow.dateStr) {
      count++;
    }
  });
  botState.tomorrowBookingsCount = count;
}

function setupFirestoreRealtimeListener() {
  if (!db || !sock) return;
  if (realtimeListenerUnsub) {
    try { realtimeListenerUnsub(); } catch(e) {}
    realtimeListenerUnsub = null;
  }

  let isInitialSnap = true;
  pushLog('📡 Starting Firestore Real-time Listener on `bookings` collection...');

  realtimeListenerUnsub = db.collection('bookings').onSnapshot(async (snapshot) => {
    botState.bookingsMonitored = snapshot.size;
    updateTomorrowCountFromDocs(snapshot.docs);

    if (isInitialSnap) {
      isInitialSnap = false;
      pushLog(`📋 [Firestore Real-time Listener] Initial sync complete. Monitoring ${snapshot.size} bookings.`);

      // Process any pending today/future Waiting bookings created while bot was offline/restarting
      for (const doc of snapshot.docs) {
        const sent = await trySendBookingReminder(doc.id, doc.data(), true);
        if (sent) await delay(1200);
      }
      return;
    }

    for (const change of snapshot.docChanges()) {
      if (change.type === 'added' || change.type === 'modified') {
        await trySendBookingReminder(change.doc.id, change.doc.data(), false);
      }
    }
  }, (err) => {
    pushLog(`❌ Firestore real-time listener error: ${err.message}`);
  });
}

/**
 * Trigger 1 Backup: 45-second background sweeper so no Waiting booking is ever missed
 */
function startWaitingBookingsSweeper() {
  if (sweeperInterval) return;

  const runSweep = async () => {
    if (!sock || !db || botState.connectionStatus !== 'CONNECTED') return;
    try {
      botState.lastSweeperAt = new Date().toISOString();
      const allSnap = await db.collection('bookings').get();
      botState.bookingsMonitored = allSnap.size;
      updateTomorrowCountFromDocs(allSnap.docs);

      for (const doc of allSnap.docs) {
        const b = doc.data();
        if (b && b.status === 'Waiting' && !b.lastSentAt) {
          const sent = await trySendBookingReminder(doc.id, b, true);
          if (sent) await delay(1200);
        }
      }
    } catch (err) {
      console.warn('⚠️ 45s sweeper warning:', err.message);
    }
  };

  sweeperInterval = setInterval(runSweep, 45000);
  pushLog('🔄 45-second background sweeper started for Waiting bookings.');
}

/**
 * Trigger 2: Day-Before Reminder at 8:00 AM Sri Lanka Time (Asia/Colombo)
 * Runs between 08:00 and 08:15 Asia/Colombo and sends one reminder per tomorrow's booking
 */
async function runDayBefore8AmReminders(forceRun = false) {
  if (!sock || !db || botState.connectionStatus !== 'CONNECTED') return;

  const slToday = getColomboNowParts(0);
  const slTomorrow = getColomboNowParts(1);
  botState.tomorrowDateStr = slTomorrow.dateStr;

  const in8AmWindow = slToday.hour === 8 && slToday.minute >= 0 && slToday.minute <= 15;
  if (!forceRun && !in8AmWindow) return;

  try {
    const snapshot = await db.collection('bookings').get();
    if (snapshot.empty) {
      botState.tomorrowBookingsCount = 0;
      botState.lastDayBeforeBatchDate = slToday.dateStr;
      botState.lastDayBeforeBatchAt = new Date().toISOString();
      return;
    }

    const tomorrowDocs = [];
    snapshot.forEach(doc => {
      const b = doc.data();
      if (!b || b.status === 'Declined') return;
      const pDate = parseEventDate(b.eventDate || b.date || '');
      if (pDate && formatDateToISO(pDate) === slTomorrow.dateStr) {
        tomorrowDocs.push({ id: doc.id, data: b });
      }
    });

    botState.tomorrowBookingsCount = tomorrowDocs.length;

    let sentCount = (botState.lastDayBeforeBatchDate === slToday.dateStr)
      ? botState.lastDayBeforeSentCount
      : 0;

    for (const item of tomorrowDocs) {
      const b = item.data;
      const docId = item.id;
      if (b.dayBeforeReminderSent === true) continue;

      const personName = b.name || b.memberName || '';
      const resolvedPhone = resolvePhoneForBooking(personName, b.phone);
      const recipientJid = getRecipientJid(resolvedPhone);
      if (!recipientJid) {
        pushLog(`⚠️ [8AM Day-Before Skip] Missing/invalid phone for ${personName} (${docId})`);
        continue;
      }

      const displayDate = b.displayDate || b.eventDate || b.date || slTomorrow.dateStr;
      const displayTime = b.eventTime || b.timeSlot || b.slot || 'නියමිත වේලාව';
      const displayLoc = b.location || 'වැලිගම්පිටිය හන්දිය';

      const confirmLine = (b.status === 'Confirmed')
        ? `✅ ඔබගේ පැමිණීම දැනටමත් තහවුරු කර ඇත. හෙට නියමිත වේලාවට සහභාගි වන්න!`
        : `කරුණාකර තවමත් තහවුරු කර නොමැති නම් පැමිණීම තහවුරු කිරීමට *හරි* හෝ *YES* ලෙස පිළිතුරු එවන්න.\n• නොහැකි නම්: *බෑ* | මාරු කරන්නේ නම්: *swap [විස්තර]*`;

      const msg = `🌅 සුබ උදෑසනක් ${personName}! 🙏\n` +
        `⏰ *හෙට දිනයේ පොදු සේවා මතක් කිරීම (බටගම සභාව)*\n\n` +
        `📅 දිනය: *${displayDate}*\n` +
        `⏰ වේලාව: *${displayTime}*\n` +
        `📍 ස්ථානය: *${displayLoc}*\n\n` +
        `${confirmLine}`;

      await sendWhatsAppMessage(recipientJid, { text: msg });
      await db.collection('bookings').doc(docId).update({
        phone: resolvedPhone,
        dayBeforeReminderSent: true,
        dayBeforeReminderSentAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      sentCount++;
      botState.lastSentAt = new Date().toISOString();
      botState.lastSentTo = `${personName} (+${resolvedPhone}) [8AM Day-Before]`;
      pushLog(`🌅 [8AM Day-Before] Sent reminder to ${personName} (+${resolvedPhone}) for ${slTomorrow.dateStr}`);
      await delay(1500);
    }

    botState.lastDayBeforeBatchDate = slToday.dateStr;
    botState.lastDayBeforeBatchAt = new Date().toISOString();
    botState.lastDayBeforeSentCount = sentCount;
  } catch (err) {
    pushLog(`❌ [8AM Day-Before] Error: ${err.message}`);
  }
}

/* ==========================================================================
   AUTOMATED CRON JOBS (Asia/Colombo)
   ========================================================================== */
function setupCronJobs() {
  console.log('⏰ Scheduling automated Cron Jobs (Asia/Colombo)...');

  // Trigger 2: Check every 2 minutes during 08:00-08:15 Asia/Colombo for tomorrow's bookings
  cron.schedule('0-15/2 8 * * *', async () => {
    await runDayBefore8AmReminders(false);
  }, { timezone: COLOMBO_TZ });

  // Also check every 30 minutes: retry unconfirmed reminders (0-2 days ahead)
  cron.schedule('*/30 * * * *', async () => {
    console.log(`\n[${new Date().toISOString()}] 🔍 Running 30-min Attendance & Reminder check...`);
    if (!sock || !db || botState.connectionStatus !== 'CONNECTED') return;

    try {
      const snapshot = await db.collection('bookings').get();
      if (snapshot.empty) return;
      updateTomorrowCountFromDocs(snapshot.docs);

      const nowMs = Date.now();
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

      for (const doc of snapshot.docs) {
        const b = doc.data();
        const docId = doc.id;
        const personName = b.name || b.memberName || '';
        const resolvedPhone = resolvePhoneForBooking(personName, b.phone);
        if (!resolvedPhone) continue;

        const rawDate = b.eventDate || b.date || '';
        const pDate = parseEventDate(rawDate);
        if (!pDate) continue;

        const daysUntil = getDaysUntil(pDate);
        // Only active for 0 to 2 days before service
        if (daysUntil < 0 || daysUntil > 2) continue;

        const recipientJid = getRecipientJid(resolvedPhone);
        if (!recipientJid) continue;
        let lastSentMs = 0;
        if (b.lastSentAt) {
          if (typeof b.lastSentAt.toDate === 'function') {
            lastSentMs = b.lastSentAt.toDate().getTime();
          } else if (typeof b.lastSentAt === 'number') {
            lastSentMs = b.lastSentAt;
          } else if (typeof b.lastSentAt === 'string') {
            lastSentMs = new Date(b.lastSentAt).getTime();
          }
        }

        const displayDate = b.displayDate || rawDate || '';
        const displayTime = b.eventTime || b.timeSlot || b.slot || '';

        // A. Initial Reminder (Waiting -> Sent_1)
        if (b.status === 'Waiting') {
          await trySendBookingReminder(docId, b, false);
          await delay(2000);
        }
        // B. Retry 1 Reminder (Sent_1 -> Retry_1 after 6 hours)
        else if (b.status === 'Sent_1' && (nowMs - lastSentMs) >= SIX_HOURS_MS) {
          const msg = `මතක් කිරීමයි (1): ${personName},\n` +
                      `*${displayDate}* (${displayTime}) දින සේවා වාරය තහවුරු කර නොමැත.\n\n` +
                      `කරුණාකර ඔබ සහභාගි වන්නේද යන්න *හරි* හෝ *බෑ* ලෙස පිළිතුරක් එවන්න.`;

          await sendWhatsAppMessage(recipientJid, { text: msg });
          await db.collection('bookings').doc(docId).update({
            phone: resolvedPhone,
            status: 'Retry_1',
            lastSentAt: FieldValue.serverTimestamp(),
            retryCount: 1,
            updatedAt: FieldValue.serverTimestamp()
          });
          pushLog(`📤 [Retry_1] Sent retry 1 reminder to ${personName} (+${resolvedPhone})`);
          await delay(2000);
        }
        // C. Retry 2 Reminder (Retry_1 -> Retry_2 after 6 hours)
        else if (b.status === 'Retry_1' && (nowMs - lastSentMs) >= SIX_HOURS_MS) {
          const msg = `අවසාන මතක් කිරීමයි: ${personName},\n` +
                      `*${displayDate}* දින සේවා වාරය තහවුරු කිරීම සඳහා කරුණාකර අද දින තුළ පිළිතුරක් එවන්න.\n\n` +
                      `• සහභාගි වන්නේ නම්: *හරි*\n` +
                      `• නොහැකි නම්: *බෑ*`;

          await sendWhatsAppMessage(recipientJid, { text: msg });
          await db.collection('bookings').doc(docId).update({
            phone: resolvedPhone,
            status: 'Retry_2',
            lastSentAt: FieldValue.serverTimestamp(),
            retryCount: 2,
            updatedAt: FieldValue.serverTimestamp()
          });
          pushLog(`📤 [Retry_2] Sent retry 2 reminder to ${personName} (+${resolvedPhone})`);
          await delay(2000);
        }
        // D. Mark Not_Seen (Retry_2 -> Not_Seen after 6 hours)
        else if (b.status === 'Retry_2' && (nowMs - lastSentMs) >= SIX_HOURS_MS) {
          await db.collection('bookings').doc(docId).update({
            status: 'Not_Seen',
            notSeenAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          });
          pushLog(`⚠️ [Not_Seen] Marked ${personName} (+${resolvedPhone}) as Not_Seen`);
        }
      }
    } catch (cronErr) {
      console.error('❌ Reminder cron error:', cronErr);
    }
  }, { timezone: COLOMBO_TZ });

  // 2. Daily at 8:00 PM (20:00 Asia/Colombo): Send full attendance summary report
  cron.schedule('0 20 * * *', async () => {
    console.log(`\n[${new Date().toISOString()}] 📊 Running Daily 8:00 PM Summary Cron...`);
    await sendAndSaveDailySummary();
  }, { timezone: COLOMBO_TZ });

  console.log('✅ Cron jobs initialized (Asia/Colombo):');
  console.log('   - 45s Waiting Sweeper: every 45 seconds');
  console.log('   - Day-Before 8:00 AM Reminder: 0-15/2 8 * * *');
  console.log('   - 30-min Retry Runner: */30 * * * *');
  console.log('   - Daily 8:00 PM Summary: 0 20 * * *');
}

/**
 * Builds and sends daily summary report to Admin and saves to Firestore
 */
async function sendAndSaveDailySummary(targetJid = null) {
  if (!sock || !db) return;

  try {
    const snapshot = await db.collection('bookings').get();
    if (snapshot.empty) {
      console.log('ℹ️ No bookings found in Firestore for summary.');
      return;
    }

    const confirmed = [];
    const swapped = [];
    const declined = [];
    const notSeen = [];
    const activeDocIds = [];

    snapshot.forEach(doc => {
      const b = doc.data();
      const pDate = parseEventDate(b.eventDate);
      const daysUntil = pDate ? getDaysUntil(pDate) : 999;

      // Filter upcoming or today/recent cycle (-1 to 7 days)
      if (daysUntil >= -1 && daysUntil <= 7) {
        activeDocIds.push(doc.id);
        const st = b.status || 'Waiting';
        if (st === 'Confirmed') {
          confirmed.push(b);
        } else if (st === 'Swapped') {
          swapped.push(b);
        } else if (st === 'Declined') {
          declined.push(b);
        } else {
          notSeen.push(b);
        }
      }
    });

    const total = confirmed.length + swapped.length + declined.length + notSeen.length;
    const todayStr = new Date().toLocaleDateString('si-LK', { year: 'numeric', month: 'long', day: 'numeric' });

    let report = `📊 *පොදු සේවය - බටගම සභාව*\n` +
                 `*දෛනික සේවා සාරාංශ වාර්තාව*\n` +
                 `📅 දිනය: *${todayStr}*\n\n` +
                 `✅ *තහවුරු කළ අය (Confirmed) - ${confirmed.length}*\n`;

    if (confirmed.length === 0) report += `_(කිසිවෙකු නැත)_\n`;
    confirmed.forEach(b => {
      report += `• *${b.name}* - ${b.eventDate} (${b.eventTime})\n`;
    });

    report += `\n🔄 *මාරු කරගත් අය (Swapped) - ${swapped.length}*\n`;
    if (swapped.length === 0) report += `_(කිසිවෙකු නැත)_\n`;
    swapped.forEach(b => {
      const det = b.swapDetails ? ` -> ${b.swapDetails}` : '';
      report += `• *${b.name}* (${b.eventDate})${det}\n`;
    });

    report += `\n❌ *පැමිණිය නොහැකි අය (Declined) - ${declined.length}*\n`;
    if (declined.length === 0) report += `_(කිසිවෙකු නැත)_\n`;
    declined.forEach(b => {
      const r = b.declineReason ? ` -> ${b.declineReason}` : '';
      report += `• *${b.name}* (${b.eventDate})${r}\n`;
    });

    report += `\n⏳ *පිළිතුරු නොදුන් අය (Not Seen / Pending) - ${notSeen.length}*\n`;
    if (notSeen.length === 0) report += `_(කිසිවෙකු නැත)_\n`;
    notSeen.forEach(b => {
      report += `• *${b.name}* - +${b.phone || 'දුරකථන නැත'} (${b.status || 'Waiting'})\n`;
    });

    report += `\n📈 *මුළු සහභාගිවන්නන් ගණන: ${total}*\n`;
    report += `_(වාර්තාව ස්වයංක්‍රීයව සකස් කරන ලදී)_`;

    // 1. Send via WhatsApp to Admin
    const recipient = targetJid || `${ADMIN_PHONE}@s.whatsapp.net`;
    await sendWhatsAppMessage(recipient, { text: report });
    console.log(`📋 Summary report sent to ${recipient}`);

    // 2. Save report to Firestore `daily_reports` collection
    await db.collection('daily_reports').add({
      reportDate: todayStr,
      confirmedCount: confirmed.length,
      swappedCount: swapped.length,
      declinedCount: declined.length,
      pendingCount: notSeen.length,
      totalCount: total,
      textReport: report,
      sentToAdmin: true,
      adminPhone: ADMIN_PHONE,
      createdAt: FieldValue.serverTimestamp()
    });
    console.log(`💾 Daily report saved to Firestore 'daily_reports'.`);

    // 3. Mark bookings as summarySent: true
    if (activeDocIds.length > 0) {
      const batch = db.batch();
      for (const docId of activeDocIds) {
        batch.update(db.collection('bookings').doc(docId), { summarySent: true });
      }
      await batch.commit();
    }
  } catch (err) {
    console.error('❌ Failed to generate or send daily summary:', err);
  }
}

// Acquire PID lock to avoid duplicate running instances
acquirePidLock();

// Start Alwaysdata HTTP Keep-Alive Server immediately
startHttpKeepAliveServer();

// Start the WhatsApp bot
startBot().catch(err => {
  botState.connectionStatus = 'DISCONNECTED';
  botState.lastDisconnectReason = err.message;
  console.error('Fatal Bot Startup Error:', err);
});

