# CivicPulse

AI-powered civic issue reporting: citizens report problems (potholes, trash, streetlights, leaks) with photo + GPS, Gemini triages and clusters them, workers fix them and prove it with a photo, and an admin dashboard runs the whole pipeline. Citizens earn points and streaks for reporting.

## Project structure

This matches the layout in your editor:

```
civicpulse/
├── civicpulse-citizen/      # Expo app — citizens report issues
│   └── CitizenApp.js
├── civicpulse-server/       # Node/Express backend + Gemini + Firestore + Cloudinary
│   └── server.js
├── civicpulse-worker/       # Expo app — workers fix issues
│   └── WorkerApp.js
└── AdminDashboard.html      # Static admin dashboard (open directly in a browser)
```

## Architecture

```
civicpulse-citizen (Expo)  ─┐
civicpulse-worker  (Expo)  ─┼──►  civicpulse-server (Express)  ──►  Firestore (data)
AdminDashboard.html        ─┘                                  ──►  Cloudinary (images)
                                                                 ──►  Gemini (AI triage/cluster/verify)
```

All three clients talk to `civicpulse-server` over plain HTTP — there's no separate auth service, the server itself issues/validates logins against Firestore.

---

## 1. Prerequisites

- **Node.js** 18+ and npm
- **Expo CLI** — `npm install -g expo-cli` (or just use `npx expo`)
- The **Expo Go** app on your phone (or an emulator) for the citizen/worker apps
- A **Firebase** project with **Firestore** enabled
- A **Cloudinary** account (free tier is fine)
- A **Gemini API key** (Google AI Studio)
- Your computer's **LAN IP address** (e.g. `192.168.1.39`) — your phone and computer must be on the same Wi-Fi network

---

## 2. Set up `civicpulse-server`

```bash
cd civicpulse-server
npm init -y
npm install express cors dotenv @google/genai firebase-admin cloudinary bcryptjs
```

### 2a. Firebase service account

1. Firebase Console → Project Settings → Service Accounts → **Generate new private key**
2. Save the downloaded JSON as `civicpulse-server/serviceAccountKey.json`
3. **Never commit this file** — see the GitHub section below

### 2b. Environment variables

Create `civicpulse-server/.env`:

```env
GEMINI_API_KEY=your_gemini_key
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_key
CLOUDINARY_API_SECRET=your_cloudinary_secret
PORT=3000

# Optional tuning (defaults shown)
CLUSTER_RADIUS_METERS=300
CLUSTER_MIN_ISSUES=2
CLUSTER_CONFIDENCE_THRESHOLD=60
POINTS_PER_REPORT=10
POINTS_PER_RESOLVED=20
STREAK_BONUS_PER_DAY=2
STREAK_BONUS_CAP=20
```

### 2c. Run it

```bash
node server.js
```

You should see a banner listing every route. Confirm it's reachable from your phone too — visit `http://YOUR_LAN_IP:3000/health` in your phone's browser; it should return `{"status":"ok", ...}`.

> Firestore collections (`issues`, `clusters`, `workers`, `citizens`) are created automatically the first time something writes to them — no manual setup needed.

---

## 3. Set up `civicpulse-citizen`

```bash
npx create-expo-app civicpulse-citizen
cd civicpulse-citizen
npx expo install expo-camera expo-location react-native-maps @react-native-async-storage/async-storage
```

Replace the generated `App.js` with the contents of `CitizenApp.js` (or keep the filename and just `import CitizenApp from './CitizenApp'; export default CitizenApp;` in `App.js`).

Open `CitizenApp.js` and update the LAN IP at the top:

```js
const API_BASE = "http://YOUR_LAN_IP:3000";
```

Run it:

```bash
npx expo start
```

Scan the QR code with Expo Go. First launch will show a **create account / log in** screen — that's the citizen account, stored in the `citizens` Firestore collection.

---

## 4. Set up `civicpulse-worker`

```bash
npx create-expo-app civicpulse-worker
cd civicpulse-worker
npx expo install expo-camera expo-location react-native-maps @react-native-async-storage/async-storage
```

Same deal: drop `WorkerApp.js` in, point `App.js` at it, and update:

```js
const API_BASE = "http://YOUR_LAN_IP:3000";
```

Worker accounts **aren't** self-registered — they're created by an admin (see next section). Until at least one worker exists, the login screen will just reject every attempt.

> `DEV_MODE = true` at the top of `WorkerApp.js` bypasses the 10‑metre geofence check so you can test the "mark as fixed" flow without physically standing at the issue. Set it to `false` before any real-world use.

---

## 5. Set up `AdminDashboard.html`

No build step — it's a static file. Just open it directly:

```bash
open AdminDashboard.html      # macOS
# or double-click it in Finder/Explorer
```

Inside the `<script>` tag, update:

```js
const API = "http://localhost:3000"; // or your LAN IP if opening from another device
```

From the dashboard you can:

- Review and assign issues/clusters to workers
- **+ Add Worker** — create the username/password a worker uses to log into `civicpulse-worker`
- **🏆 Leaderboard** — see citizens ranked by points and streaks

---

## 6. First-run walkthrough

1. Start `civicpulse-server`
2. Open `AdminDashboard.html` → **+ Add Worker** → create a worker account
3. Open `civicpulse-worker` on a phone → log in with that worker account
4. Open `civicpulse-citizen` on a phone → **create an account** → report an issue (camera + GPS)
5. Watch the issue land in the admin dashboard → assign it to the worker
6. In `civicpulse-worker`, walk to (or, in `DEV_MODE`, fake being at) the issue → take an "after" photo → Gemini verifies the fix
7. The reporting citizen automatically gets bonus points — check the leaderboard

---

## 7. Gamification reference

| Event                    | Points                                | Notes                                                                                             |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Filing a report          | `POINTS_PER_REPORT` (default 10)      | Awarded instantly                                                                                 |
| Daily reporting streak   | up to `STREAK_BONUS_CAP` (default 20) | `streak × STREAK_BONUS_PER_DAY`, only the first report of a calendar day counts toward the streak |
| Report verified as fixed | `POINTS_PER_RESOLVED` (default 20)    | Paid to the original reporting citizen when a worker's "after" photo is AI-confirmed              |

All of these are tunable via the server's `.env` file.

---

## 8. Troubleshooting

- **"Network request failed" on phone, works on computer** → your phone and computer aren't on the same Wi-Fi, or `API_BASE` still says `localhost` instead of your LAN IP.
- **CORS errors in the admin dashboard** → the server already sets `cors({ origin: '*' })`; double-check `API` in `AdminDashboard.html` matches where the server is actually running.
- **Worker login always fails** → no worker account exists yet, or it was created before the gamification update (old worker docs without `username`/`passwordHash` can't log in — recreate them via **+ Add Worker**).
- **Geofence blocking testing** → set `DEV_MODE = true` in `WorkerApp.js`.

---

## 9. Putting this on GitHub safely

The only things in this project that are actually secret are: `serviceAccountKey.json`, the `.env` file, and anything inside Expo's `.expo/` cache. Everything else (your LAN IP, the code itself) is fine to publish.

### 9a. Create a `.gitignore` first — before your first commit

Put this at the **root** of `civicpulse/` (next to the three folders and `AdminDashboard.html`), as `.gitignore`:

```gitignore
# Secrets — never commit these
civicpulse-server/.env
civicpulse-server/serviceAccountKey.json
.env
*.env.local

# Dependencies
node_modules/
.npm/

# Expo / React Native
.expo/
.expo-shared/
dist/
web-build/
*.jks
*.p8
*.p12
*.key
*.mobileprovision

# Build & cache
*.log
.cache/
.DS_Store

# Editor
.vscode/
.idea/
```

(I've included this as a separate `.gitignore` file alongside this README — just drop it in your project root.)

### 9b. Double-check before committing

```bash
cd civicpulse
git init
git status            # confirm .env and serviceAccountKey.json do NOT appear in the list
```

If either file shows up under "Untracked files," your `.gitignore` isn't catching it — fix the path before continuing. `git status` is your safety net; always glance at it before `git add .`.

### 9c. First commit and push

1. Create a new **empty** repo on GitHub (don't let it auto-generate a README/.gitignore/license — you already have a README and .gitignore, and adding theirs too just causes a merge conflict on first push).
2. Then:

```bash
git add .
git commit -m "Initial commit: CivicPulse citizen, worker, server, admin dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/civicpulse.git
git push -u origin main
```

### 9d. If you've already committed a secret

If `serviceAccountKey.json` or `.env` made it into a commit (even a previous one, even if you later deleted it), removing the file in a new commit is **not enough** — it's still sitting in your git history, and now it's a quick `git log` away from anyone with repo access.

1. **Rotate the leaked credentials immediately** — in Firebase, delete that service account key and generate a new one; in Cloudinary/Google AI Studio, regenerate the API keys. Treat the old ones as burned, even if the repo is private.
2. Then strip the file from history with [`git filter-repo`](https://github.com/newren/git-filter-repo) (BFG Repo-Cleaner works too):
   ```bash
   git filter-repo --path civicpulse-server/serviceAccountKey.json --invert-paths
   ```
3. Force-push the cleaned history: `git push origin --force --all`
4. If anyone else cloned the repo before the cleanup, their local copies still have the secret in history — rotation in step 1 is what actually protects you, not the history rewrite alone.

### 9e. A couple of extra habits worth keeping

- Add a `civicpulse-server/.env.example` file (committed, no real values) so anyone setting the project up knows which variables to fill in, without you ever risking a real key going in:
  ```env
  GEMINI_API_KEY=
  GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
  CLOUDINARY_CLOUD_NAME=
  CLOUDINARY_API_KEY=
  CLOUDINARY_API_SECRET=
  PORT=3000
  ```
- GitHub scans public repos for known secret patterns and will block a push that contains one (push protection) — useful, but don't rely on it as your only safeguard; it doesn't catch everything (e.g. it generally won't flag a Firebase service-account JSON).
- If the repo will stay private, you can relax slightly, but it's still worth keeping secrets out of git entirely — private repos get shared, forked, or made public by accident more often than people expect.

---

## 10. License

Add a license of your choice (MIT is a common default for personal/hackathon projects) before making the repo public.
