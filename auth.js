'use strict';
/**
 * Keycard setup for SiteMiti. All sign-in settings live here;
 * server.js only needs: const auth = require('./auth');
 *
 * Settings come from .env (see .env.example).
 *
 * AUTH_MODE in .env switches how much of Keycard is used:
 *   full    (default) email sign-in + plans page, trial, licences, payments
 *   signin  email sign-in only; no plans/licences/payments; everyone gets FULL_ACCESS limits
 *   off     no sign-in at all; one local user with FULL_ACCESS limits (local/private use)
 *
 * Plan limits (entitlements) Miti reads:
 *   maxPages               pages per crawl
 *   runsKept               saved runs kept per tool in History
 *   aiSummary              AI summaries and page-score forecasts on/off
 *   snapshotUrls           pages tracked in Daily Snapshots
 *   snapshotRetentionDays  longest "keep for" setting in Daily Snapshots
 *
 * Plans page and payments (Cashfree): see PLANS and `billing` below. Prices
 * live next to each plan's limits; limits can also be edited in the admin panel.
 *
 * SMTP_PASS and CASHFREE_CLIENT_SECRET may be plain or encrypted (enc:v1:… from `npm run encrypt-secret`).
 * Encrypted values are decrypted with AI_CONFIG_ENCRYPTION_KEY, which must be
 * set in the system environment, never in .env next to the encrypted value.
 */
const path = require('path');
const keycard = require('keycard');
const { createKeycard, sqliteStore, consoleMailer, smtpMailer, cashfreeGateway } = keycard;
const { resolveApiKey } = require('./secret-crypto');

const useSmtp = !!process.env.SMTP_HOST;

// Plain secrets pass through unchanged; enc:v1:… values are decrypted.
// Stops startup with a clear message if an encrypted value can't be decrypted.
function secretFromEnv(name) {
  try {
    return resolveApiKey(process.env[name]);
  } catch (e) {
    throw new Error(
      `${name} in .env is encrypted but could not be decrypted (${e.message}). ` +
      'Set AI_CONFIG_ENCRYPTION_KEY in the system environment to the key used with `npm run encrypt-secret`.'
    );
  }
}
const smtpPassword = () => secretFromEnv('SMTP_PASS');

// ---------------------------------------------------------------------------
// Plans. Order = lowest to highest (upgrades only go up).
//   entitlements  the limits SiteMiti enforces (also editable in Admin → Plans)
//   prices        per currency: INR for customers in India, USD for everyone
//                 else (chosen by billing country at checkout). Remove a period
//                 to stop selling it. No prices = not for sale (Trial).
//                 GST: none while SELLER_GSTIN is empty (not registered). If you
//                 register later, 18% is added for Indian customers only;
//                 customers abroad are never charged tax (export of services).
// ---------------------------------------------------------------------------
const PLANS = [
  {
    name: 'Trial',
    description: 'Try SiteMiti free for 14 days.',
    entitlements: { maxPages: 50, runsKept: 10, aiSummary: false, snapshotUrls: 2, snapshotRetentionDays: 30 },
    defaultDays: 14,
    defaultGraceDays: 0,
  },
  {
    name: 'Standard',
    description: 'For regular site checks and comparisons.',
    prices: {
      INR: { monthly: 999, yearly: 9990 },
      USD: { monthly: 12, yearly: 120 },
    },
    entitlements: { maxPages: 200, runsKept: 30, aiSummary: true, snapshotUrls: 10, snapshotRetentionDays: 400 },
    defaultDays: 365,
    defaultGraceDays: 7,
  },
  {
    name: 'Pro',
    description: 'For large sites and daily monitoring.',
    prices: {
      INR: { monthly: 2499, yearly: 24990 },
      USD: { monthly: 29, yearly: 290 },
    },
    entitlements: { maxPages: 5000, runsKept: 100, aiSummary: true, snapshotUrls: 50, snapshotRetentionDays: 730 },
    defaultDays: 365,
    defaultGraceDays: 7,
  },
];

// Free tier: what everyone gets without an active plan (after the trial ends).
const FREE_TIER = { maxPages: 25, runsKept: 5, aiSummary: false, snapshotUrls: 1, snapshotRetentionDays: 7 };

// Limits for everyone when plans are off (AUTH_MODE=signin or off): the top plan's limits.
const FULL_ACCESS = { ...PLANS[PLANS.length - 1].entitlements };

const MODE = String(process.env.AUTH_MODE || 'full').trim().toLowerCase();
if (!['full', 'signin', 'off'].includes(MODE)) {
  throw new Error(`AUTH_MODE in .env must be full, signin or off (got "${process.env.AUTH_MODE}").`);
}
const DB_FILE = path.join(__dirname, 'data', 'auth.db');

// Payments are switched on once Cashfree keys are in .env (full mode only).
const gateway = MODE === 'full' && process.env.CASHFREE_CLIENT_ID
  ? cashfreeGateway({
      clientId: process.env.CASHFREE_CLIENT_ID,
      clientSecret: secretFromEnv('CASHFREE_CLIENT_SECRET'),
      mode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
    })
  : null;

function startKeycard(mode) {
  const auth = createKeycard({
    appName: 'SiteMiti',
    appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
    secret: process.env.AUTH_SECRET,
    store: sqliteStore({ filename: DB_FILE }),
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
    // Starting access for a new install (changed later in Admin → Access settings).
    // Open: anyone can sign up (trial, then free tier). Licence: paid plans.
    access: { modes: mode === 'full' ? ['open', 'license'] : ['open'], contactUrl: process.env.CONTACT_URL || '' },

    // Full mode: the free tier (also fills any limit a plan doesn't set).
    // Sign-in-only mode: everyone's limits.
    defaultEntitlements: mode === 'full' ? FREE_TIER : FULL_ACCESS,

    // Plans page, trial and payments: full mode only.
    billing: mode !== 'full' ? undefined : {
      gateway,
      homeCountry: 'IN',      // customers here pay INR…
      currency: 'INR',
      foreignCurrency: 'USD', // …everyone else pays USD
      plans: PLANS.map(({ name, description, prices }) => ({ name, description, prices, highlight: name === 'Pro' })),
      trial: { planName: 'Trial', days: 14 },
      freeTier: { name: 'Free', description: 'Basic checks, always free.' },
      // Rows on the plans page comparison, in this order.
      features: [
        { key: 'maxPages', label: 'Pages per crawl' },
        { key: 'runsKept', label: 'Saved runs per tool' },
        { key: 'aiSummary', label: 'AI summaries and forecasts' },
        { key: 'snapshotUrls', label: 'Daily Snapshot pages' },
        { key: 'snapshotRetentionDays', label: 'Keep snapshots for', suffix: ' days' },
      ],
      tax: { rate: 18, pricesIncludeTax: false },
      // Your business details for invoices. Leave SELLER_GSTIN empty while not GST-registered.
      seller: {
        name: process.env.SELLER_NAME || 'SiteMiti',
        address: process.env.SELLER_ADDRESS || '',
        gstin: process.env.SELLER_GSTIN || '',
        email: process.env.SELLER_EMAIL || process.env.SUPPORT_EMAIL || '',
      },
      invoice: {
        prefix: process.env.INVOICE_PREFIX || 'SM',
        sac: process.env.INVOICE_SAC || '998314',
        footer: process.env.INVOICE_FOOTER || (process.env.SELLER_GSTIN ? '' : 'Supplier not registered under GST. No GST charged.'),
      },
      supportEmail: process.env.SUPPORT_EMAIL || '',
    },

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

  if (mode === 'full') {
    // Creates missing plans. For plans that already exist, only ADDS limit keys
    // they don't have yet (e.g. after an update introduces a new limit) — values
    // edited in the admin panel are never changed.
    auth.ensurePlans(PLANS.map(({ name, entitlements, defaultDays, defaultGraceDays }) => ({ name, entitlements, defaultDays, defaultGraceDays }))).forEach((plan) => {
      const wanted = PLANS.find((p) => p.name === plan.name);
      if (!wanted) return;
      const missing = Object.keys(wanted.entitlements).filter((k) => !(k in plan.entitlements));
      if (missing.length) {
        const add = Object.fromEntries(missing.map((k) => [k, wanted.entitlements[k]]));
        auth.updatePlan(plan.id, { entitlements: { ...plan.entitlements, ...add } }, 'app');
      }
    });
  }

  if (mode === 'full') {
    // Coming back from sign-in-only mode: licences decide access again.
    const saved = auth.getAccessSettings();
    if (!saved.modes.includes('license')) auth.setAccessSettings({ modes: [...saved.modes, 'license'] }, 'app');
  }

  if (mode === 'signin') {
    // Licences no longer decide who gets in: drop "Licence" from the saved access
    // modes (keeps Open / Allowlist / Approval as set in the admin panel).
    const saved = auth.getAccessSettings();
    if (saved.modes.includes('license')) {
      const modes = saved.modes.filter((m) => m !== 'license');
      auth.setAccessSettings({ modes: modes.length ? modes : ['open'] }, 'app');
    }
    // …and licences no longer decide limits: everyone gets FULL_ACCESS.
    const fixed = (u) => u && { ...u, access: { ...(u.access || {}), entitlements: FULL_ACCESS } };
    auth.getLimit = (u, key, fallback) => keycard.getLimit(fixed(u), key, fallback);
    auth.hasEntitlement = (u, key) => keycard.hasEntitlement(fixed(u), key);
    auth.getEntitlement = (u, key, fallback) => keycard.getEntitlement(fixed(u), key, fallback);
    const getUserAccess = auth.getUserAccess;
    auth.getUserAccess = async (email) => {
      const a = await getUserAccess(email);
      return { ...a, entitlements: FULL_ACCESS, license: null };
    };
  }

  auth.mode = mode;
  return auth;
}

/**
 * AUTH_MODE=off: no sign-in. A stand-in with the same shape server.js and
 * snapshots.js use, where everyone is one local admin user with FULL_ACCESS.
 * If you used sign-in before, that admin's account id is reused so your
 * History and Daily Snapshots stay where they are.
 */
function noAuth() {
  const express = require('express');
  const email = String(process.env.ADMIN_EMAILS || '').split(',')[0].trim().toLowerCase() || 'local@sitemiti';
  let id = 'local-user';
  const fs = require('fs');
  if (fs.existsSync(DB_FILE)) {
    const store = sqliteStore({ filename: DB_FILE });
    const existing = store.getUserByEmail(email);
    if (existing) id = existing.id;
    store.close();
  }
  const user = {
    id, email, role: 'admin', isAdmin: true,
    access: { via: 'off', entitlements: FULL_ACCESS, license: null },
  };
  const asLocalUser = (req, res, next) => { req.user = user; next(); };
  return {
    mode: 'off',
    basePath: '/auth',
    router: express.Router(),        // no /auth pages: sign-in, plans and admin are all off
    requireAuth: asLocalUser,
    optionalAuth: asLocalUser,
    requireAdmin: asLocalUser,
    csrfProtect: (req, res, next) => next(),
    errorHandler: (err, req, res, next) => next(err),
    getLimit: keycard.getLimit,
    hasEntitlement: keycard.hasEntitlement,
    getEntitlement: keycard.getEntitlement,
    store: { getUserById: (uid) => (uid === user.id ? user : null) },
    getUserByEmail: (e) => (String(e || '').toLowerCase() === email ? user : undefined),
    getUserAccess: async () => ({ allowed: true, via: 'off', entitlements: FULL_ACCESS, license: null }),
    close() {},
  };
}

module.exports = MODE === 'off' ? noAuth() : startKeycard(MODE);
