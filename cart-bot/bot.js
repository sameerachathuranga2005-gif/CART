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

// Modular firebase-admin imports (avoids admin.credential.cert undefined errors)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/* ==========================================================================
   CONFIG & INITIALIZATION
   ========================================================================== */
const AUTH_DIR = path.resolve(__dirname, 'auth_info_baileys');
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, 'serviceAccountKey.json');

// Pairing phone and admin phone number (Sri Lanka format: 947XXXXXXXX)
const PAIRING_PHONE = (process.env.PAIRING_PHONE || '94701206001').replace(/\D/g, '');
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '94701206001').replace(/\D/g, '');

let db = null;
let sock = null;
let isReconnecting = false;
let cronJobsStarted = false;

// 1. Initialize Firebase Admin SDK
function initFirebase() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn('\n=================================================================');
    console.warn('⚠️ WARNING: serviceAccountKey.json was not found in:');
    console.warn(`   ${SERVICE_ACCOUNT_PATH}`);
    console.warn('👉 Please download it from Firebase Console > Project Settings > Service Accounts');
    console.warn('   and place it in this folder. The bot will wait for it.');
    console.warn('=================================================================\n');
    return null;
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    const firebaseApp = initializeApp({
      credential: cert(serviceAccount)
    }, 'cart-bot-app-' + Date.now());

    const firestoreDb = getFirestore(firebaseApp);
    console.log('✅ Firebase Admin Firestore connected successfully.');
    return firestoreDb;
  } catch (err) {
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
 * Calculates days remaining until target date (0 = today, 1 = tomorrow, 2 = day after)
 */
function getDaysUntil(targetDate) {
  if (!targetDate) return 999;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
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
 * Normalizes any phone number format (0771234567, +94771234567, 94771234567, or with spaces)
 * into WhatsApp JID format (947XXXXXXXX@s.whatsapp.net)
 */
function getRecipientJid(phone) {
  if (!phone) return null;
  let cleanPhone = String(phone).replace(/\D/g, '').replace(/^0/, '94');
  if (cleanPhone.length === 9) {
    cleanPhone = '94' + cleanPhone;
  }
  if (!cleanPhone.startsWith('94') || cleanPhone.length !== 11) {
    return null;
  }
  return `${cleanPhone}@s.whatsapp.net`;
}

/**
 * Generates phone variants to match numbers with or without leading 0 or country code 94
 */
function normalizePhoneVariants(phone) {
  const digits = String(phone).replace(/\D/g, '').replace(/^0/, '94');
  const variants = new Set([digits]);
  if (digits.startsWith('94') && digits.length === 11) {
    variants.add('0' + digits.slice(2));
    variants.add(digits.slice(2));
  } else if (digits.startsWith('0') && digits.length === 10) {
    variants.add('94' + digits.slice(1));
    variants.add(digits.slice(1));
  } else if (digits.length === 9) {
    variants.add('94' + digits);
    variants.add('0' + digits);
  }
  return Array.from(variants);
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
   WHATSAPP BOT CORE & PAIRING
   ========================================================================== */
async function startBot() {
  if (!db) {
    db = initFirebase();
  }

  console.log('\n======================================================');
  console.log('🤖 BATAGAMA ROSTER WHATSAPP BOT STARTING...');
  console.log(`📱 Target Pairing Phone: +${PAIRING_PHONE}`);
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
    syncFullHistory: false
  });

  // Pairing code request if not already authenticated
  if (!sock.authState.creds.registered) {
    console.log(`⏳ Requesting WhatsApp Pairing Code for +${PAIRING_PHONE}...`);
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_PHONE);
        console.log('\n======================================================');
        console.log('🔑 WHATSAPP PAIRING CODE GENERATED:');
        console.log(`👉 CODE: ${code}`);
        console.log('------------------------------------------------------');
        console.log('1. Open WhatsApp on your phone (+94701206001)');
        console.log('2. Tap Settings (or 3 dots) > Linked Devices');
        console.log('3. Tap "Link a device"');
        console.log('4. Tap "Link with phone number instead"');
        console.log(`5. Enter the pairing code above: ${code}`);
        console.log('======================================================\n');
      } catch (pairErr) {
        console.error('❌ Failed to request pairing code:', pairErr.message);
        console.log('💡 Note: Ensure phone number is in international format without + or spaces.');
      }
    }, 3500);
  }

  // Save auth credentials whenever updated
  sock.ev.on('creds.update', saveCreds);

  // Connection status & auto-reconnect handling
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ Connection closed. Status code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('🔒 Device logged out. Clearing auth directory to allow new pairing...');
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (rmErr) {
          console.error('Error clearing auth dir:', rmErr.message);
        }
        setTimeout(() => startBot(), 3000);
      } else if (shouldReconnect) {
        if (!isReconnecting) {
          isReconnecting = true;
          console.log('🔄 Reconnecting in 5 seconds...');
          setTimeout(() => {
            isReconnecting = false;
            startBot();
          }, 5000);
        }
      }
    } else if (connection === 'open') {
      console.log('\n======================================================');
      console.log('🚀 WHATSAPP BOT CONNECTED SUCCESSFULLY & LIVE 24/7!');
      console.log(`📱 Bot JID: ${sock.user?.id || 'Connected'}`);
      console.log('======================================================\n');

      // Start Real-time Firestore Listener on bookings collection
      setupFirestoreRealtimeListener();

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
        const senderPhone = extractPhoneNumber(remoteJid);
        
        // Extract message text content
        const messageText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''
        ).trim();

        if (!messageText) continue;

        console.log(`\n📩 Incoming message from +${senderPhone}: "${messageText}"`);

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
      await sock.sendMessage(remoteJid, { text: '⏳ වාර්තාව සකස් කරමින් පවතී...' });
      await sendAndSaveDailySummary(remoteJid);
      return;
    } else if (text === 'ping' || text === 'test') {
      await sock.sendMessage(remoteJid, { text: '🏓 Pong! Bot is running 24/7 on alwaysdata.\n🟢 Firestore Live: ' + (db ? 'Connected' : 'Offline') });
      return;
    }
  }

  // 2. Participant Booking Lookup
  if (!db) {
    await sock.sendMessage(remoteJid, { text: '⚠️ සේවාදායකයේ දත්ත ගබඩාව සම්බන්ධ කරමින් පවතී. කරුණාකර සුළු මොහොතකින් නැවත උත්සාහ කරන්න.' });
    return;
  }

  const booking = await findActiveBookingForPhone(senderPhone);

  if (!booking) {
    console.log(`ℹ️ No active booking found for phone: +${senderPhone}`);
    const noBookingReply = `ආයුබෝවන්! 👋\n` +
      `ඔබගේ දුරකථන අංකය (+${senderPhone}) පොදු සේවා කාලසටහනෙහි ලියාපදිංචිව නොමැත.\n` +
      `කරුණාකර සභා භාරකරු අමතන්න.`;
    await sock.sendMessage(remoteJid, { text: noBookingReply });
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
    await sock.sendMessage(remoteJid, { text: reply });
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
    await sock.sendMessage(remoteJid, { text: reply });
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
      await sock.sendMessage(remoteJid, { text: reply });
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
      await sock.sendMessage(remoteJid, { text: reply });
      return;
    } else {
      const reply = `කරුණාකර 'swap [මාරු කරගත් කෙනාගේ නම]' ලෙස එවන්න. (උදා: *swap සුදාර සමඟ*)`;
      await sock.sendMessage(remoteJid, { text: reply });
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
  await sock.sendMessage(remoteJid, { text: helpReply });
}

/* ==========================================================================
   REAL-TIME FIRESTORE LISTENER (INSTANT REMINDERS ON ROSTER UPDATE)
   ========================================================================== */
let realtimeListenerUnsub = null;
let isInitialSnap = true;

function setupFirestoreRealtimeListener() {
  if (!db || !sock) return;
  if (realtimeListenerUnsub) {
    try { realtimeListenerUnsub(); } catch(e) {}
    realtimeListenerUnsub = null;
  }

  console.log('📡 Starting Firestore Real-time Listener on `bookings` collection...');

  realtimeListenerUnsub = db.collection('bookings').onSnapshot(async (snapshot) => {
    // Prevent blast-sending to existing database records on bot cold boot
    if (isInitialSnap) {
      isInitialSnap = false;
      console.log(`📋 [Firestore Real-time Listener] Initial sync complete. Monitoring ${snapshot.size} bookings for live updates.`);
      return;
    }

    for (const change of snapshot.docChanges()) {
      if (change.type === 'added' || change.type === 'modified') {
        const booking = change.doc.data();
        const docId = change.doc.id;

        // Condition for sending instant reminder:
        // 1. Participant name and phone exist
        // 2. Status is "Waiting"
        // 3. Reminder has not already been sent (!booking.lastSentAt)
        if (booking.name && booking.phone && booking.status === 'Waiting' && !booking.lastSentAt) {
          const recipientJid = getRecipientJid(booking.phone);
          if (!recipientJid) {
            console.warn(`⚠️ [Skip Reminder] Invalid phone number for ${booking.name}: "${booking.phone}"`);
            continue;
          }

          console.log(`\n⚡ [Live Roster Trigger] New or updated participant detected: ${booking.name} (+${booking.phone})`);
          console.log(`📤 Sending personalized WhatsApp reminder immediately to ${recipientJid}...`);

          const displayDate = booking.displayDate || booking.eventDate || 'නියමිත දිනය';
          const displayTime = booking.eventTime || 'නියමිත වේලාව';
          const displayLoc = booking.location || 'වැලිගම්පිටිය හන්දිය';

          const reminderText = `ආයුබෝවන් ${booking.name}! 👋\n` +
            `පොදු සේවය (බටගම සභාව) සඳහා ඔබට වෙන් කර ඇති සේවා වාරය:\n\n` +
            `📅 දිනය: *${displayDate}*\n` +
            `⏰ වේලාව: *${displayTime}*\n` +
            `📍 ස්ථානය: *${displayLoc}*\n\n` +
            `ඔබ මේ සඳහා සහභාගි වන්නේද?\n` +
            `• පැමිණෙන්නේ නම්: *හරි* (හෝ *yes* / *ok*)\n` +
            `• පැමිණිය නොහැකි නම්: *බෑ* (හෝ *no*)\n` +
            `• මාරු කරන්නේ නම්: *swap [විස්තර]*\n\n` +
            `ලෙස කරුණාකර දන්වන්න.`;

          try {
            await sock.sendMessage(recipientJid, { text: reminderText });
            console.log(`✅ [Sent] Personalized reminder delivered to ${booking.name} (${recipientJid})`);

            // Mark Sent_1 in Firestore
            await db.collection('bookings').doc(docId).update({
              status: 'Sent_1',
              lastSentAt: FieldValue.serverTimestamp(),
              retryCount: 0,
              updatedAt: FieldValue.serverTimestamp()
            });
          } catch (sendErr) {
            console.error(`❌ Failed to send reminder to ${recipientJid}:`, sendErr.message);
          }
        }
      }
    }
  }, (err) => {
    console.error('❌ Firestore real-time listener error:', err.message);
  });
}

/* ==========================================================================
   AUTOMATED CRON JOBS
   ========================================================================== */
function setupCronJobs() {
  console.log('⏰ Scheduling automated Cron Jobs...');

  // 1. Every 30 minutes: Check bookings and send reminders (0-2 days ahead)
  cron.schedule('*/30 * * * *', async () => {
    console.log(`\n[${new Date().toISOString()}] 🔍 Running 30-min Attendance & Reminder check...`);
    if (!sock || !db) return;

    try {
      const snapshot = await db.collection('bookings').get();
      if (snapshot.empty) return;

      const nowMs = Date.now();
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

      for (const doc of snapshot.docs) {
        const b = doc.data();
        const docId = doc.id;
        if (!b.phone) continue;

        const pDate = parseEventDate(b.eventDate);
        if (!pDate) continue;

        const daysUntil = getDaysUntil(pDate);
        // Only active for 0 to 2 days before service
        if (daysUntil < 0 || daysUntil > 2) continue;

        const recipientJid = getRecipientJid(b.phone);
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

        // A. Initial Reminder (Waiting -> Sent_1)
        if (b.status === 'Waiting') {
          const msg = `ආයුබෝවන් ${b.name || ''}! 👋\n` +
                      `පොදු සේවය (බටගම සභාව) සඳහා ඔබට වෙන් කර ඇති සේවා වාරය:\n\n` +
                      `📅 දිනය: *${b.eventDate || ''}*\n` +
                      `⏰ වේලාව: *${b.eventTime || ''}*\n` +
                      `📍 ස්ථානය: *${b.location || 'නමස්කාර මධ්‍යස්ථානය'}*\n\n` +
                      `ඔබ මේ සඳහා සහභාගි වන්නේද?\n` +
                      `• පැමිණෙන්නේ නම්: *හරි* හෝ *yes*\n` +
                      `• පැමිණිය නොහැකි නම්: *බෑ* හෝ *no*\n` +
                      `• මාරු කරන්නේ නම්: *swap [විස්තර]*\n\n` +
                      `ලෙස කරුණාකර දන්වන්න.`;

          await sock.sendMessage(recipientJid, { text: msg });
          await db.collection('bookings').doc(docId).update({
            status: 'Sent_1',
            lastSentAt: FieldValue.serverTimestamp(),
            retryCount: 0,
            updatedAt: FieldValue.serverTimestamp()
          });
          console.log(`📤 [Sent_1] Sent initial reminder to ${b.name} (+${b.phone})`);
          await delay(2000);
        }
        // B. Retry 1 Reminder (Sent_1 -> Retry_1 after 6 hours)
        else if (b.status === 'Sent_1' && (nowMs - lastSentMs) >= SIX_HOURS_MS) {
          const msg = `මතක් කිරීමයි (1): ${b.name || ''},\n` +
                      `*${b.eventDate || ''}* (${b.eventTime || ''}) දින සේවා වාරය තහවුරු කර නොමැත.\n\n` +
                      `කරුණාකර ඔබ සහභාගි වන්නේද යන්න *හරි* හෝ *බෑ* ලෙස පිළිතුරක් එවන්න.`;

          await sock.sendMessage(recipientJid, { text: msg });
          await db.collection('bookings').doc(docId).update({
            status: 'Retry_1',
            lastSentAt: FieldValue.serverTimestamp(),
            retryCount: 1,
            updatedAt: FieldValue.serverTimestamp()
          });
          console.log(`📤 [Retry_1] Sent retry 1 reminder to ${b.name} (+${b.phone})`);
          await delay(2000);
        }
        // C. Retry 2 Reminder (Retry_1 -> Retry_2 after 6 hours)
        else if (b.status === 'Retry_1' && (nowMs - lastSentMs) >= SIX_HOURS_MS) {
          const msg = `අවසාන මතක් කිරීමයි: ${b.name || ''},\n` +
                      `*${b.eventDate || ''}* දින සේවා වාරය තහවුරු කිරීම සඳහා කරුණාකර අද දින තුළ පිළිතුරක් එවන්න.\n\n` +
                      `• සහභාගි වන්නේ නම්: *හරි*\n` +
                      `• නොහැකි නම්: *බෑ*`;

          await sock.sendMessage(recipientJid, { text: msg });
          await db.collection('bookings').doc(docId).update({
            status: 'Retry_2',
            lastSentAt: FieldValue.serverTimestamp(),
            retryCount: 2,
            updatedAt: FieldValue.serverTimestamp()
          });
          console.log(`📤 [Retry_2] Sent retry 2 reminder to ${b.name} (+${b.phone})`);
          await delay(2000);
        }
        // D. Mark Not_Seen (Retry_2 -> Not_Seen after 6 hours)
        else if (b.status === 'Retry_2' && (nowMs - lastSentMs) >= SIX_HOURS_MS) {
          await db.collection('bookings').doc(docId).update({
            status: 'Not_Seen',
            notSeenAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          });
          console.log(`⚠️ [Not_Seen] Marked ${b.name} (+${b.phone}) as Not_Seen`);
        }
      }
    } catch (cronErr) {
      console.error('❌ Reminder cron error:', cronErr);
    }
  });

  // 2. Daily at 8:00 PM (20:00): Send full attendance summary report
  cron.schedule('0 20 * * *', async () => {
    console.log(`\n[${new Date().toISOString()}] 📊 Running Daily 8:00 PM Summary Cron...`);
    await sendAndSaveDailySummary();
  });

  console.log('✅ Cron jobs initialized:');
  console.log('   - 30-min Reminder Runner: */30 * * * *');
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
    await sock.sendMessage(recipient, { text: report });
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

// Start the bot
startBot().catch(err => {
  console.error('Fatal Bot Startup Error:', err);
});

