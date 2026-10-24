# CA Desk — practice management & client portal

One place for every client's master data, compliance portal logins, documents and due dates.
You (and staff) manage everything; each client logs in and sees only their own data, read-only, and can download it.

**Stack:** static web app on GitHub Pages + Firebase (Authentication + Firestore). Works on Firebase's free Spark plan — documents are stored inside Firestore, so no paid Storage bucket is needed.

## What it does

| Area | CA / staff | Client |
|---|---|---|
| Master data (PAN, GSTIN, TAN, CIN/LLPIN, address, partners/directors, applicability) | Edit; auto-fill from uploaded documents | View |
| Portal logins (GST, Income Tax, TRACES, MCA, EPFO, ESIC, E-Way Bill, IRP, Udyam, DGFT, PT, other) | Add / edit; one-click **Login** | View, copy, one-click **Login** |
| Documents (certificates, returns, acks) | Upload / delete | Download |
| Compliance calendar (GST, TDS, PF/ESIC, ITR, tax audit, advance tax, ROC, LLP) | Mark filed with ARN | View status |
| Dashboard of overdue & upcoming across all clients | ✓ | — |
| Excel import / export of all clients incl. passwords | ✓ | Own data only |

**Auto-fill from documents** — upload a GST certificate (REG-06), PAN card, TAN letter, Aadhaar, Certificate of Incorporation or LLP incorporation/deed as PDF or photo. Digital PDFs are read directly; scans and photos are OCR'd in the browser (nothing is sent to any server). You review every field, tick what to apply, and the document is filed under the client.

**One-click portal login** — with the included Chrome extension, **Login** opens the portal and fills the user ID and password (and TAN on TRACES; on Income Tax it fills the password after you click Continue). You enter CAPTCHA / OTP and sign in. Without the extension, Login opens the portal and copies the password.

## Setup (about 15 minutes)

### 1. Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (e.g. `ca-desk`). Analytics not needed.
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** → production mode → region **asia-south1 (Mumbai)**.
4. Firestore → **Rules** tab → replace everything with the contents of `firestore.rules` → **Publish**.
5. **Project settings (⚙) → Your apps → Web (</>)** → register app → copy the `firebaseConfig` values into `firebase-config.js`.
6. Authentication → **Settings → Authorized domains** → add `smishra724.github.io`.

### 2. Publish on GitHub Pages
1. Create a repo (e.g. `ca-desk`) and upload everything **except** the `extension` folder (it can stay; it's harmless).
2. Repo **Settings → Pages** → Deploy from branch `main`, folder `/ (root)`.
3. Open `https://smishra724.github.io/ca-desk/`.

### 3. First run
1. On the login page, fill **First-time setup** (firm name, your name, email, password). This creates the owner login and can only happen once.
2. **Excel import → Download the template**, fill your clients and their portal user IDs/passwords, upload. Or use **Clients → New client from documents**.
3. For each client who should log in: open the client → **Client access** → create a login and share the email + temporary password. They can reset it with “Forgot password”.
4. Staff: **Settings → Staff logins**.

### 4. Autofill extension (you, staff and clients)
1. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select the `extension` folder.
2. Reload CA Desk. The Portal logins tab will say “Autofill extension active”.
3. If you host the app on another domain, add it to the first `matches` list in `extension/manifest.json`.

## Security notes
- Firestore rules (`firestore.rules`) enforce access: CA/staff have full access; a client account can read only its own client record and sub-records and can write nothing. Data is encrypted at rest by Google and in transit by HTTPS.
- Portal passwords are stored as entered so they can be shown to the client and filled into portals. Protect owner/staff logins with strong passwords; revoke a client's access from **Client access** at any time.
- Optional hardening: Firebase console → Authentication → Settings → enable **Multi-factor (SMS)** for owner/staff; App Check with reCAPTCHA.
- The extension keeps a login only in memory for 5 minutes, only for `*.gov.in` portals, and never fills CAPTCHA/OTP fields or clicks Sign in.

## Due-date engine
Statutory dates from `compliance.js`, driven by master data: GSTIN + GST filing type (Monthly / QRMP with 22nd/24th by state / Composition), TDS, PF/ESIC, tax audit, advance tax, and constitution (company → AOC-4, MGT-7, DPT-3, DIR-3 KYC, MSME-1; LLP → Form 8, Form 11). Government extensions are not applied automatically — mark items filed as you file them.

## Files
```
index.html, styles.css, app.js     the app
extract.js                         PDF text / OCR + field extraction
compliance.js                      due-date engine
portals.js                         portal list and login URLs (edit to add more)
firebase-config.js                 your Firebase keys
firestore.rules                    security rules — paste into Firebase console
extension/                         CA Desk Autofill Chrome extension
```
