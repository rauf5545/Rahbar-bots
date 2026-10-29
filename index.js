'use strict';

const fs = require('fs');
const path = require('path');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');

// ============================================================================
// 1. BUSINESS CONFIGURATION
// ============================================================================
const BUSINESS = {
  name: 'Rahbar Realms',
  type: 'Digital Solutions & Web Development Agency',
  location: 'Online / Remote',
  contactNumber: '03141619597',
  botNumber: '03141619597',
  ownerAlertNumber: process.env.OWNER_ALERT_NUMBER || '',
  automatedReplyHours: '24/7',
  humanSupportHours: 'To be confirmed',
  pricingPolicy: 'Custom quotation based on project requirements',
  delivery: 'No physical delivery — all services are digital.',
  paymentTerms: 'Discussed after the project quotation.',
};

// ============================================================================
// 2. SERVICES CONFIGURATION
// ============================================================================
const SERVICES = [
  { id: 1, name: 'Website Development', description: 'Designing and building responsive, modern websites tailored to a business\'s goals, including structure, layout, and core functionality.' },
  { id: 2, name: 'E-commerce Website Development', description: 'Building online stores with product catalogs, cart and checkout flows, and the integrations needed to sell online.' },
  { id: 3, name: 'Custom Web Applications', description: 'Developing tailored web applications with custom logic, dashboards, and workflows built around specific business requirements.' },
  { id: 4, name: 'Firebase & Database Integration', description: 'Connecting apps and websites to databases and Firebase services such as authentication, real-time data, and storage.' },
  { id: 5, name: 'UI/UX Design', description: 'Creating clean, user-friendly interface and experience designs focused on usability and brand consistency.' },
  { id: 6, name: 'Website Maintenance & Bug Fixing', description: 'Ongoing upkeep, troubleshooting, and fixing of issues on existing websites to keep them stable and up to date.' },
  { id: 7, name: 'AI-Powered Business Solutions', description: 'Integrating AI-driven features such as chatbots, automation, and smart assistants into business workflows.' },
];

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'auth_info');
const INQUIRY_LOG_PATH = process.env.INQUIRY_LOG_PATH || path.join(process.cwd(), 'inquiries.jsonl');
const logger = P({ level: process.env.LOG_LEVEL || 'warn' });

// ============================================================================
// 3. HELPERS & STATE
// ============================================================================
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60;
const MAX_PROCESSED_IDS = 100;

function digitsOnly(v) { return String(v || '').replace(/\D+/g, ''); }
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[\u2018\u2019\u201C\u201D]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function getSession(senderId) {
  const now = Date.now();
  let s = sessions.get(senderId);
  if (!s || now - s.lastActivity > SESSION_TTL_MS) {
    s = { stage: 'idle', step: 0, data: {}, history: [], lastActivity: now, processedMsgIds: new Set() };
    sessions.set(senderId, s);
  }
  s.lastActivity = now;
  return s;
}

// ============================================================================
// 4. MESSAGE LOGIC
// ============================================================================
function welcomeMessage() {
  return `Assalam o Alaikum! 👋\n\nWelcome to *${BUSINESS.name}* — ${BUSINESS.type}.\nWe work ${BUSINESS.location.toLowerCase()}.\n\nPlease choose an option:\n\n1 — View Services\n2 — Get Service Details\n3 — Start a Project Inquiry\n4 — Pricing Information\n5 — Contact Information\n\nReply with a number or keyword.`;
}

function servicesMessage() {
  const lines = SERVICES.map((s) => `${s.id}. *${s.name}*`).join('\n');
  return `*Our Services at ${BUSINESS.name}*\n\n${lines}\n\nReply with a service *number* or *name* for details, or send *PROJECT INQUIRY* to start.`;
}

function pricingMessage() {
  return `*Pricing Information*\n\nOur pricing depends on your project's requirements, features, and complexity. ${BUSINESS.name} provides custom quotations after understanding your project.\n\nPayment terms: ${BUSINESS.paymentTerms}\n\nReply *PROJECT INQUIRY* to begin.`;
}

function contactMessage() {
  return `*Contact Information*\n\nBusiness: ${BUSINESS.name}\nPhone / WhatsApp: ${BUSINESS.contactNumber}\nLocation: ${BUSINESS.location}\nAutomated replies: ${BUSINESS.automatedReplyHours}\nHuman support hours: ${BUSINESS.humanSupportHours}\n\nReply *PROJECT INQUIRY* or send *MENU* for options.`;
}

function unknownMessage() {
  return `Sorry, I didn't quite understand that.\n\nPlease reply with:\n1 — View Services\n2 — Get Service Details\n3 — Start a Project Inquiry\n4 — Pricing Information\n5 — Contact Information\n\nOr send *MENU* at any time.`;
}

function matchServiceByInput(text) {
  const t = normalizeText(text);
  if (/^\d+$/.test(t)) return SERVICES.find(s => s.id === parseInt(t, 10));
  return SERVICES.find(s => normalizeText(s.name).includes(t) || t.includes(normalizeText(s.name)));
}

// Inquiry Prompt
function getInquiryPrompt(step) {
  switch (step) {
    case 1: return 'Great! Let\'s start your project inquiry.\n\nStep 1 of 7 — What is your *full name*?';
    case 2: return `Step 2 of 7 — Which *service* are you interested in?\n\n` + SERVICES.map(s => `${s.id}. ${s.name}`).join('\n');
    case 3: return 'Step 3 of 7 — Please give a *brief description* of your project.';
    case 4: return 'Step 4 of 7 — What are the *required features or main goals*? (type *skip* to skip)';
    case 5: return 'Step 5 of 7 — What is your *preferred timeline*? (type *skip* to skip)';
    case 6: return 'Step 6 of 7 — What is your *budget range*? (type *skip* if you prefer not to share)';
    case 7: return 'Step 7 of 7 — Any *additional requirements*? Type *skip* if none.';
    default: return null;
  }
}

function inquirySummary(data) {
  return `*Please review your inquiry:*\n\n👤 Name: ${data.name || '—'}\n🛠️ Service: ${data.service || '—'}\n📝 Description: ${data.description || '—'}\n⚙️ Features: ${data.features || '—'}\n📅 Timeline: ${data.timeline || '—'}\n💰 Budget: ${data.budget || '—'}\n➕ Additional: ${data.extra || '—'}\n\nReply *CONFIRM* to submit, or *CANCEL* to cancel.`;
}

// ============================================================================
// 5. SOCKET & CONNECTION
// ============================================================================
let sockRef = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version = [2, 3000, 0];
  try { const v = await fetchLatestBaileysVersion(); if (v?.version) version = v.version; } catch (_) {}

  const sock = makeWASocket({
    version, auth: state, logger: P({ level: 'silent' }),
    printQRInTerminal: false, browser: ['Rahbar Bot', 'Chrome', '1.0.0'],
  });

  sockRef = sock;
  sock.ev.on('creds.update', saveCreds);

  // Request Pairing Code if env is set and not registered
  if (process.env.PAIRING_NUMBER && !state.creds?.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(process.env.PAIRING_NUMBER);
        console.log(`\n🔑 YOUR PAIRING CODE: ${code}\n👉 Go to WhatsApp > Linked Devices > Link with phone number\n`);
      } catch (e) { console.log('Pairing code error:', e.message); }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection } = update;
    if (connection === 'open') console.log('✅ WhatsApp Connected Successfully!');
    if (connection === 'close') console.log('❌ Connection closed. Reconnecting...');
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || isJidGroup(msg.key.remoteJid) || isJidBroadcast(msg.key.remoteJid)) continue;
      
      const senderId = jidNormalizedUser(msg.key.remoteJid);
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!text) continue;

      const session = getSession(senderId);
      let reply = null;
      const t = normalizeText(text);

      if (['hi','hello','hey','salam','aoa','menu','start'].includes(t)) {
        reply = welcomeMessage();
      } else if (['1','services'].includes(t)) {
        reply = servicesMessage();
      } else if (['3','project inquiry','start project'].includes(t)) {
        session.stage = 'collecting';
        session.step = 1;
        session.data = {};
        reply = getInquiryPrompt(1);
      } else if (['4','pricing','price'].includes(t)) {
        reply = pricingMessage();
      } else if (['5','contact'].includes(t)) {
        reply = contactMessage();
      } else if (session.stage === 'collecting') {
        if (t === 'cancel') { session.stage = 'idle'; reply = 'Inquiry cancelled.'; }
        else {
          const keys = ['', 'name', 'service', 'description', 'features', 'timeline', 'budget', 'extra'];
          session.data[keys[session.step]] = t === 'skip' ? '—' : text;
          session.step++;
          if (session.step > 7) { session.stage = 'confirm'; reply = inquirySummary(session.data); }
          else { reply = getInquiryPrompt(session.step); }
        }
      } else if (session.stage === 'confirm') {
        if (t === 'confirm' || t === 'yes') {
          reply = `✅ Thank you! Your inquiry has been recorded.\nRef: RR-${Date.now().toString().slice(-6)}`;
          session.stage = 'idle';
        } else { reply = 'Please reply *CONFIRM* to submit or *CANCEL* to cancel.'; }
      } else {
        const svc = matchServiceByInput(text);
        reply = svc ? `*${svc.name}*\n\n${svc.description}\n\nReply *3* to start an inquiry.` : unknownMessage();
      }

      if (reply) await sock.sendMessage(msg.key.remoteJid, { text: reply });
    }
  });
}

startBot().catch(console.error);
