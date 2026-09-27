# Add Keycard sign-in to Miti

You get sign-in, an admin panel, plans, and a page limit per plan.
Time needed: about 15 minutes.

> **Important:** Miti still keeps crawls, tests and history in shared memory.
> Until the per-user update is done, keep access to yourself (the default below).

## Files in this bundle

| File | Put it in | What it does |
|---|---|---|
| `auth.js` | Miti root, next to `server.js` | Keycard settings for Miti, and the Trial/Standard/Pro plans |
| `public/keycard-nav.js` | Miti's `public/` folder | Account bar: your email, Admin link, Sign out |
| `.env.example` | Miti root | Settings template |

## Steps

**1. Copy the three files** into Miti as shown above.

**2. Install packages** in the Miti folder (skip keycard if already installed):
```
npm install dotenv
npm install git+ssh://git@github.com/YOUR-ACCOUNT/keycard.git#v1.1.0
```

**3. Create `.env`.** Copy `.env.example` to `.env`, then:
- Set `AUTH_SECRET`. Generate it with:
  ```
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
- Set `ADMIN_EMAILS` to your email.
- Leave the `SMTP_` lines empty for now. Codes will print in the terminal.

**4. Edit `server.js`: three changes.**

*Change 1*: add as the very first line (skip if `dotenv` is already loaded):
```js
require('dotenv').config();
```

*Change 2*: find these lines near the top:
```js
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
```
Replace them with:
```js
const auth = require('./auth');
const app = express();
app.use(express.json());
app.use(auth.basePath, auth.router);   // sign-in and admin pages under /auth
app.use(auth.requireAuth);             // everything after this needs sign-in
app.use(express.static(path.join(__dirname, 'public')));
```
The order matters: the `/auth` line must come before `requireAuth`, and `requireAuth` before `express.static`.
If Miti runs behind nginx, IIS or Azure, also add `app.set('trust proxy', 1);` after `const app = express();`.

*Change 3*: page limit from the plan. In `app.post('/api/crawl/:slot', ...)`, find:
```js
  const { url, maxPages, mode, urls, historyType, historyId, historySide } = req.body || {};
```
Add these two lines right below it:
```js
  const planMax = auth.getLimit(req.user, 'maxPages', 200);
  const effectiveMax = Math.min(Number(maxPages) || planMax, planMax);
```
Then, further down in the same route, change both occurrences of
```js
maxPages: maxPages || 500
```
to
```js
maxPages: effectiveMax
```

**5. Add the account bar** to each page in `public/` (`index.html`, `snapshots.html`, and any others), just before `</body>`:
```html
<script src="/keycard-nav.js" defer></script>
```

**6. Keep secrets out of git.** Add to `.gitignore`:
```
.env
data/
backups/
```

**7. Start Miti** (`node server.js`) and open it.
- You're sent to the sign-in page.
- Enter your `ADMIN_EMAILS` address.
- Copy the 6-digit code from the terminal.

**8. Check the admin panel.** Click **Admin** in the account bar (bottom left).
- **Plans** shows Trial, Standard and Pro.
- Leave **Access settings** on **Allowlist** for now.

## Later

- **Real email:** fill in the `SMTP_` lines in `.env` and restart. For Microsoft 365 use `smtp.office365.com`, port 587; the mailbox needs SMTP AUTH enabled.
- **Daily backup:**
  ```
  npx keycard backup data/auth.db backups/auth.db
  ```
- **Opening Miti to customers:** after the per-user update, switch **Access settings** to **Licence + Approval**. Then approve people and grant each a personal licence.

## If something goes wrong

| Problem | Fix |
|---|---|
| `keycard configuration problems: config.secret is required` | `.env` isn't loaded or `AUTH_SECRET` is empty. Check change 1 and step 3. |
| `Cannot find module 'keycard'` | Run the install in step 2 inside the Miti folder. |
| Pages load without asking you to sign in | `express.static` is above `requireAuth`. Recheck change 2. |
| Sign-in page shows "Sign in to continue" as JSON | The `/auth` line is below `requireAuth`. Recheck change 2. |
| No code appears | Look in the terminal running Miti. Wait 60 seconds between resends. |
| Crawls ignore the page limit | Recheck change 3: both `maxPages || 500` must become `effectiveMax`. |
