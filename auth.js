'use strict';
/**
 * Keycard setup for Miti. All Miti-specific sign-in settings live here;
 * server.js only needs: const auth = require('./auth');
 *
 * Settings come from .env (see .env.example).
 *
 * Plan limits (entitlements) Miti reads:
 *   maxPages               pages per crawl
 *   runsKept               saved runs kept per tool in History
 *   aiSummary              AI summaries and page-score forecasts on/off
 *   snapshotUrls           pages tracked in Daily Snapshots
 *   snapshotRetentionDays  longest "keep for" setting in Daily Snapshots
 *
 * SMTP_PASS may be plain or encrypted (enc:v1:… from `npm run encrypt-secret`).
 * Encrypted values are decrypted with AI_CONFIG_ENCRYPTION_KEY, which must be
 * set in the system environment, never in .env next to the encrypted value.
 */
const path = require('path');
const { createKeycard, sqliteStore, consoleMailer, smtpMailer } = require('keycard');
const { resolveApiKey } = require('./secret-crypto');

const useSmtp = !!process.env.SMTP_HOST;

// Plain passwords pass through unchanged; enc:v1:… values are decrypted.
// Stops startup with a clear message if an encrypted password can't be decrypted.
function smtpPassword() {
  try {
    return resolveApiKey(process.env.SMTP_PASS);
  } catch (e) {
    throw new Error(
      `SMTP_PASS in .env is encrypted but could not be decrypted (${e.message}). ` +
      'Set AI_CONFIG_ENCRYPTION_KEY in the system environment to the key used with `npm run encrypt-secret`.'
    );
  }
}

const auth = createKeycard({
  appName: 'Miti',
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  secret: process.env.AUTH_SECRET,
  store: sqliteStore({ filename: path.join(__dirname, 'data', 'auth.db') }),
  mailer: useSmtp
    ? smtpMailer({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER,
        pass: smtpPassword(),
        from: process.env.SMTP_FROM,
      })
    : consoleMailer(), // no SMTP configured: sign-in codes print in this terminal
  adminEmails: process.env.ADMIN_EMAILS,

  // Starting access mode for a brand-new install. After that it's changed in
  // /auth/admin → Access settings (e.g. Licence + Approval once you sell licences).
  access: { modes: ['allowlist'], contactUrl: process.env.CONTACT_URL || '' },

  // Base limits. Used as-is for people without a licence (e.g. admins); for
  // licensed people they only fill in anything their plan doesn't set.
  defaultEntitlements: { maxPages: 200, runsKept: 30, aiSummary: true, snapshotUrls: 10, snapshotRetentionDays: 400 },

  // Miti's own look on the sign-in and admin pages.
  theme: {
    primary: '#d97757',
    primaryText: '#ffffff',
    accent: '#f3e7e1',
    background: '#f5f4f0',
    surface: '#ffffff',
    text: '#151515',
    muted: '#737373',
    border: '#d8d6cf',
    font: '"Familjen Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontUrl: 'https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&display=swap',
    logoUrl: '/miti-logo.png',
  },
});

const PLANS = [
  { name: 'Trial',    entitlements: { maxPages: 50,  runsKept: 10,  aiSummary: false, snapshotUrls: 2,  snapshotRetentionDays: 30 },  defaultDays: 14,  defaultGraceDays: 0 },
  { name: 'Standard', entitlements: { maxPages: 200, runsKept: 30,  aiSummary: true,  snapshotUrls: 10, snapshotRetentionDays: 400 }, defaultDays: 365, defaultGraceDays: 7 },
  { name: 'Pro',      entitlements: { maxPages: 500, runsKept: 100, aiSummary: true,  snapshotUrls: 50, snapshotRetentionDays: 730 }, defaultDays: 365, defaultGraceDays: 7 },
];

// Creates missing plans. For plans that already exist, only ADDS limit keys
// they don't have yet (e.g. after an update introduces a new limit) — values
// edited in the admin panel are never changed.
auth.ensurePlans(PLANS).forEach((plan) => {
  const wanted = PLANS.find((p) => p.name === plan.name);
  if (!wanted) return;
  const missing = Object.keys(wanted.entitlements).filter((k) => !(k in plan.entitlements));
  if (missing.length) {
    const add = Object.fromEntries(missing.map((k) => [k, wanted.entitlements[k]]));
    auth.updatePlan(plan.id, { entitlements: { ...plan.entitlements, ...add } }, 'app');
  }
});

module.exports = auth;
