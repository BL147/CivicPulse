/**
 * CivicPulse AI Engine — server.js
 * Added: AI-powered issue clustering
 *
 * When a new issue is filed, the server:
 *   1. Scans Firestore for unresolved issues of the same category within 300m
 *   2. If 2+ nearby issues exist, downloads their images from Cloudinary
 *   3. Sends all images to Gemini and asks it to detect a pattern
 *   4. If Gemini confirms a pattern (confidence >= 60), creates a cluster doc
 *      in the 'clusters' collection, links all child issues to it, and marks
 *      them clustered so they don't spawn duplicate clusters
 *   5. Admin dashboard reads both /api/issues and /api/clusters
 *
 * Firestore collections:
 *   issues   — individual citizen reports
 *   clusters — AI-merged major issues
 *   workers  — worker roster (added by admin, username/password login)
 *   citizens — citizen accounts (self-registered, username/password login,
 *              tracks gamification: points, streak, totalReports, totalResolved)
 *
 * Gamification (citizens only):
 *   +POINTS_PER_REPORT     awarded immediately for every filed report
 *   +STREAK_BONUS_PER_DAY  per consecutive daily-reporting streak day (capped),
 *                          added on top of the report points, once per calendar day
 *   +POINTS_PER_RESOLVED   awarded to the original reporting citizen once a
 *                          worker's fix is AI-verified as resolved
 *
 * Required .env:
 *   GEMINI_API_KEY
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *   PORT=3000
 *   CLUSTER_RADIUS_METERS=300      (optional, default 300)
 *   CLUSTER_MIN_ISSUES=2           (optional, default 2)
 *   CLUSTER_CONFIDENCE_THRESHOLD=60 (optional, default 60)
 *   POINTS_PER_REPORT=10            (optional)
 *   POINTS_PER_RESOLVED=20          (optional)
 *   STREAK_BONUS_PER_DAY=2          (optional)
 *   STREAK_BONUS_CAP=20             (optional)
 *
 * Additional dependency required:
 *   npm install bcryptjs
 */

import express from 'express';
import cors    from 'cors';
import dotenv  from 'dotenv';
import bcrypt  from 'bcryptjs';
import { GoogleGenAI }            from '@google/genai';
import { initializeApp, cert }    from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { v2 as cloudinary }       from 'cloudinary';
import { readFileSync }           from 'fs';

dotenv.config();

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
for (const key of ['GEMINI_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET']) {
  if (!process.env[key]) { console.error(`❌  Missing ${key} in .env`); process.exit(1); }
}

// ─── CLUSTERING CONFIG (tunable via .env) ────────────────────────────────────
const CLUSTER_RADIUS_M      = parseInt(process.env.CLUSTER_RADIUS_METERS          ?? '300', 10);
const CLUSTER_MIN_ISSUES    = parseInt(process.env.CLUSTER_MIN_ISSUES             ?? '2',   10);
const CLUSTER_CONF_THRESH   = parseInt(process.env.CLUSTER_CONFIDENCE_THRESHOLD   ?? '60',  10);

// ─── GAMIFICATION CONFIG (tunable via .env) ──────────────────────────────────
const POINTS_PER_REPORT     = parseInt(process.env.POINTS_PER_REPORT    ?? '10', 10);
const POINTS_PER_RESOLVED   = parseInt(process.env.POINTS_PER_RESOLVED  ?? '20', 10);
const STREAK_BONUS_PER_DAY  = parseInt(process.env.STREAK_BONUS_PER_DAY ?? '2',  10);
const STREAK_BONUS_CAP      = parseInt(process.env.STREAK_BONUS_CAP     ?? '20', 10);
const SALT_ROUNDS           = 10;

// ─── INIT ─────────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db  = getFirestore();
const ai  = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '12mb' }));
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

function extractText(response) {
  if (typeof response?.text === 'string') return response.text;
  if (Array.isArray(response?.candidates) && response.candidates.length > 0) {
    const c = response.candidates[0];
    if (typeof c?.content?.text === 'string') return c.content.text;
    if (Array.isArray(c?.content?.parts)) return c.content.parts.map(p => p?.text ?? '').join(' ');
  }
  if (Array.isArray(response?.output))
    return response.output.flatMap(i => i?.content ?? []).map(p => p?.text ?? '').join(' ');
  return '';
}

function stripFences(raw) { return raw.replace(/```(?:json)?/gi, '').trim(); }

async function callGeminiJSON(contents) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0 },
    contents,
  });
  const clean = stripFences(extractText(response));
  try { return JSON.parse(clean); }
  catch {
    const snippet = clean.slice(0, 300);
    console.error('[Gemini parse error]', snippet);
    throw Object.assign(new Error('AI returned non-JSON output.'), { code: 'AI_PARSE_ERROR', snippet });
  }
}

function missing(body, fields) {
  const m = fields.filter(k => body[k] == null || body[k] === '');
  return m.length ? `Missing: ${m.join(', ')}` : null;
}

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
async function hashPassword(plain) { return bcrypt.hash(plain, SALT_ROUNDS); }
async function checkPassword(plain, hash) {
  // A doc without a passwordHash (e.g. a stale/legacy record) should fail the
  // login cleanly instead of bcrypt throwing on a non-string argument.
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function normalizeUsername(u) { return String(u).trim().toLowerCase(); }

/** Strip sensitive fields before sending a user/worker doc to the client */
function sanitize(doc) {
  const { passwordHash, ...safe } = doc;
  return safe;
}

// ─── GAMIFICATION HELPERS ─────────────────────────────────────────────────────

/** YYYY-MM-DD for a given Date (UTC) — used as the daily streak key */
function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }

/**
 * Given a citizen's current streak state, work out the streak/bonus for a
 * report filed right now.
 *   - Same calendar day as last report → streak unchanged, no bonus (filing
 *     multiple reports in one day still earns base points, just no extra streak bonus)
 *   - Exactly one calendar day after last report → streak += 1
 *   - Anything else (first ever report, or a gap) → streak resets to 1
 */
function computeStreak(citizen) {
  const today     = todayStr();
  const yesterday = todayStr(new Date(Date.now() - 86400000));

  if (citizen.lastReportDate === today) {
    return { streak: citizen.streak ?? 1, bonus: 0, isNewDay: false };
  }
  const streak = citizen.lastReportDate === yesterday ? (citizen.streak ?? 0) + 1 : 1;
  const bonus  = Math.min(streak * STREAK_BONUS_PER_DAY, STREAK_BONUS_CAP);
  return { streak, bonus, isNewDay: true };
}

/** Haversine distance in metres between two lat/lon pairs */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Geographic centroid of a list of {latitude, longitude} objects */
function centroid(points) {
  const lat = points.reduce((s, p) => s + p.latitude,  0) / points.length;
  const lon = points.reduce((s, p) => s + p.longitude, 0) / points.length;
  return { latitude: lat, longitude: lon };
}

/** Download an image URL and return it as a base64 string */
async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

/** Upload a base64 jpeg to Cloudinary and return the secure URL */
async function uploadToCloudinary(base64Data, folder = 'civicpulse/before') {
  const result = await cloudinary.uploader.upload(`data:image/jpeg;base64,${base64Data}`, {
    folder,
    resource_type: 'image',
    transformation: [{ quality: 'auto:good', fetch_format: 'auto' }],
  });
  return result.secure_url;
}

// ─── CLUSTERING ENGINE ────────────────────────────────────────────────────────

/**
 * runClusterAnalysis
 * Called after every new issue is saved.
 * Returns the cluster doc if one was created/updated, otherwise null.
 */
async function runClusterAnalysis(newIssue) {
  const { id, category, latitude, longitude } = newIssue;

  // 1. Pull all unresolved, non-clustered issues of the same category
  //    Firestore has no geo-query, so we fetch the category bucket and filter in JS.
  const snap = await db.collection('issues')
    .where('category', '==', category)
    .where('status',   'in', ['pending', 'assigned', 'in_progress'])
    .get();

  // 2. Filter to those within CLUSTER_RADIUS_M of the new issue
  const nearby = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(issue =>
      issue.id !== id &&                                  // exclude the new issue itself
      !issue.clusterId &&                                 // not already clustered
      issue.imageUrl &&                                   // must have an image
      haversineMeters(latitude, longitude, issue.latitude, issue.longitude) <= CLUSTER_RADIUS_M
    );

  if (nearby.length < CLUSTER_MIN_ISSUES - 1) {
    // Not enough neighbours to form a cluster (need at least MIN_ISSUES total incl. new one)
    console.log(`[Cluster] Only ${nearby.length} nearby — below threshold of ${CLUSTER_MIN_ISSUES - 1}, skipping.`);
    return null;
  }

  console.log(`[Cluster] Found ${nearby.length} nearby ${category} issues — running pattern analysis…`);

  // 3. Download all images (new issue image is passed in as base64 already)
  //    We fetch nearby images from Cloudinary server-side
  let imageContents;
  try {
    const nearbyBase64s = await Promise.all(nearby.map(i => urlToBase64(i.imageUrl)));

    // Build the Gemini content array: one image block per issue + the prompt
    imageContents = [
      // New issue image is not yet in Cloudinary at this point, passed separately
      // so we fetch it from Cloudinary using newIssue.imageUrl
      { inlineData: { data: await urlToBase64(newIssue.imageUrl), mimeType: 'image/jpeg' } },
      ...nearbyBase64s.map(b64 => ({ inlineData: { data: b64, mimeType: 'image/jpeg' } })),
    ];
  } catch (fetchErr) {
    console.error('[Cluster] Image fetch error:', fetchErr.message);
    return null; // Non-fatal — individual issue was already saved
  }

  // 4. Ask Gemini to analyse for a systemic pattern across ALL images
  const allIssues = [newIssue, ...nearby];
  const PATTERN_PROMPT = `
You are a senior municipal infrastructure analyst reviewing ${allIssues.length} citizen-reported ${category} issues
from a ${CLUSTER_RADIUS_M}-metre radius in the same city area.

The images are provided in order — Image 1 is the newest report, the rest are prior reports from the same zone.

Your task: determine whether these issues share a common ROOT CAUSE or SYSTEMIC PATTERN
(e.g. same road segment deteriorating, same drainage system failing, same lighting circuit, same garbage collection failure).

A "pattern" means the problems are likely caused by the same underlying infrastructure failure,
not just coincidentally similar issues scattered around the area.

Respond ONLY with raw JSON (no markdown, no code fences):
{
  "patternDetected": true | false,
  "confidenceScore": <integer 0-100>,
  "patternType": "<short label e.g. 'Road surface degradation' | 'Drainage system failure' | 'Lighting circuit fault' | 'Waste collection gap'>",
  "clusterTitle": "<8 words max — a title for this cluster issue e.g. 'Multiple potholes on MG Road stretch'>",
  "rootCause": "<one sentence describing the likely systemic cause>",
  "recommendedAction": "<one sentence describing what department should do — be specific>",
  "suggestedSeverity": <integer 1-5, escalate from individual severities>,
  "affectedArea": "<describe the area e.g. 'North side of MG Road between Junction A and Junction B'>"
}

If no clear systemic pattern exists, set patternDetected to false. Confidence below ${CLUSTER_CONF_THRESH} = no pattern.
`.trim();

  let patternResult;
  try {
    patternResult = await callGeminiJSON([...imageContents, PATTERN_PROMPT]);
  } catch (aiErr) {
    console.error('[Cluster] Pattern AI error:', aiErr.message);
    return null;
  }

  console.log(`[Cluster] Pattern result: detected=${patternResult.patternDetected} conf=${patternResult.confidenceScore}%`);

  if (!patternResult.patternDetected || patternResult.confidenceScore < CLUSTER_CONF_THRESH) {
    return null; // No cluster warranted
  }

  // 5. Create the cluster document
  const clusterRef   = db.collection('clusters').doc();
  const clusterCentre = centroid(allIssues.map(i => ({ latitude: i.latitude, longitude: i.longitude })));
  const maxSeverity  = Math.max(...allIssues.map(i => i.severity ?? 1));
  const clusterData  = {
    id:                clusterRef.id,
    category,
    status:            'pending',                 // admin must act on it
    isCluster:         true,
    issueIds:          allIssues.map(i => i.id),  // all linked individual issues
    issueCount:        allIssues.length,
    patternType:       patternResult.patternType,
    clusterTitle:      patternResult.clusterTitle,
    rootCause:         patternResult.rootCause,
    recommendedAction: patternResult.recommendedAction,
    affectedArea:      patternResult.affectedArea,
    severity:          Math.min(5, Math.max(patternResult.suggestedSeverity ?? maxSeverity, maxSeverity)),
    confidenceScore:   patternResult.confidenceScore,
    latitude:          clusterCentre.latitude,
    longitude:         clusterCentre.longitude,
    workerId:          null,
    createdAt:         FieldValue.serverTimestamp(),
    updatedAt:         FieldValue.serverTimestamp(),
  };
  await clusterRef.set(clusterData);

  // 6. Back-link every child issue to the cluster
  const batch = db.batch();
  for (const issue of allIssues) {
    batch.update(db.collection('issues').doc(issue.id), {
      clusterId:    clusterRef.id,
      clusterTitle: patternResult.clusterTitle,
      updatedAt:    FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  console.log(`[Cluster] ✅ Created cluster ${clusterRef.id} — "${patternResult.clusterTitle}" (${allIssues.length} issues, sev ${clusterData.severity})`);
  return { ...clusterData, id: clusterRef.id };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', storage: 'cloudinary', clustering: true, timestamp: new Date().toISOString() })
);

// ─── AUTH ─────────────────────────────────────────────────────────────────────

// A. Citizen self-registration
app.post('/api/auth/citizen/register', async (req, res) => {
  const err = missing(req.body, ['username', 'password']);
  if (err) return res.status(400).json({ error: err });
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  try {
    const existing = await db.collection('citizens').where('username', '==', username).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'That username is already taken.' });

    const ref = db.collection('citizens').doc();
    const citizen = {
      id: ref.id, username,
      passwordHash:   await hashPassword(password),
      points:         0,
      streak:         0,
      lastReportDate: null,
      totalReports:   0,
      totalResolved:  0,
      createdAt:      FieldValue.serverTimestamp(),
    };
    await ref.set(citizen);
    console.log(`[Auth] New citizen registered: ${username}`);
    res.status(201).json({ citizen: sanitize(citizen) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// B. Citizen login
app.post('/api/auth/citizen/login', async (req, res) => {
  const err = missing(req.body, ['username', 'password']);
  if (err) return res.status(400).json({ error: err });
  const username = normalizeUsername(req.body.username);
  try {
    const snap = await db.collection('citizens').where('username', '==', username).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'Invalid username or password.' });
    const citizen = { id: snap.docs[0].id, ...snap.docs[0].data() };
    const ok = await checkPassword(req.body.password, citizen.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    res.json({ citizen: sanitize(citizen) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// C. Worker login (worker accounts are created by an admin, see /api/admin/workers)
app.post('/api/auth/worker/login', async (req, res) => {
  const err = missing(req.body, ['username', 'password']);
  if (err) return res.status(400).json({ error: err });
  const username = normalizeUsername(req.body.username);
  try {
    const snap = await db.collection('workers').where('username', '==', username).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'Invalid username or password.' });
    const worker = { id: snap.docs[0].id, ...snap.docs[0].data() };
    const ok = await checkPassword(req.body.password, worker.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    if (worker.active === false)
      return res.status(403).json({ error: 'This worker account has been deactivated. Contact your admin.' });
    res.json({ worker: sanitize(worker) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// D. Admin: create a worker account
app.post('/api/admin/workers', async (req, res) => {
  const err = missing(req.body, ['username', 'password', 'name']);
  if (err) return res.status(400).json({ error: err });
  const username = normalizeUsername(req.body.username);
  const { password, name } = req.body;
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  try {
    const existing = await db.collection('workers').where('username', '==', username).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: 'That username is already taken.' });

    const ref = db.collection('workers').doc();
    const worker = {
      id: ref.id, username, name,
      passwordHash: await hashPassword(password),
      active:       true,
      createdAt:    FieldValue.serverTimestamp(),
    };
    await ref.set(worker);
    console.log(`[Admin] New worker created: ${username} (${name})`);
    res.status(201).json({ worker: sanitize(worker) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// E. Admin: deactivate/reactivate a worker (soft-delete, keeps history intact)
app.post('/api/admin/workers/:id/active', async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: '`active` must be true or false.' });
  try {
    await db.collection('workers').doc(req.params.id).update({ active });
    res.json({ success: true, id: req.params.id, active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GAMIFICATION ─────────────────────────────────────────────────────────────

// F. Citizen profile (points, streak, totals)
app.get('/api/citizens/:id', async (req, res) => {
  try {
    const snap = await db.collection('citizens').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Citizen not found.' });
    res.json({ citizen: sanitize({ id: snap.id, ...snap.data() }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// G. Leaderboard — top citizens by points
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const s = await db.collection('citizens').orderBy('points', 'desc').limit(limit).get();
    const leaderboard = s.docs.map((d, i) => ({ rank: i + 1, ...sanitize({ id: d.id, ...d.data() }) }));
    res.json({ leaderboard });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 1. Citizen: report issue ──────────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  const err = missing(req.body, ['image', 'latitude', 'longitude', 'citizenId']);
  if (err) return res.status(400).json({ error: err });
  const { image, latitude, longitude, citizenId } = req.body;

  const TRIAGE_PROMPT = `You are a municipal infrastructure AI. Analyze this photo.
Location: ${latitude}, ${longitude}
Respond ONLY with raw JSON (no markdown, no code fences):
{"category":"Pothole|Trash|Streetlight|Water Leak|Other","severity":<integer 1-5>,"description":"<one concise sentence>"}`.trim();

  try {
    // Make sure this is a real, logged-in citizen account before doing any AI work
    const citizenRef  = db.collection('citizens').doc(citizenId);
    const citizenSnap = await citizenRef.get();
    if (!citizenSnap.exists)
      return res.status(404).json({ error: 'Citizen account not found. Please log in again.' });

    // 1. AI triage
    const aiResult = await callGeminiJSON([
      { inlineData: { data: image, mimeType: 'image/jpeg' } },
      TRIAGE_PROMPT,
    ]);
    const { category, severity, description } = aiResult;
    if (!category || typeof severity !== 'number' || !description)
      return res.status(500).json({ error: 'AI response missing expected fields.' });

    // 2. Upload image to Cloudinary
    const imageUrl = await uploadToCloudinary(image, 'civicpulse/before');

    // 3. Save individual issue to Firestore
    const issueRef  = db.collection('issues').doc();
    const issueData = {
      id: issueRef.id, category, severity, description,
      latitude, longitude, imageUrl,
      afterImageUrl: null, status: 'pending',
      workerId: null, workerNote: null,
      verificationResult: null,
      clusterId: null, clusterTitle: null,  // filled if clustered later
      citizenId,                            // who reported this, for gamification + history
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await issueRef.set(issueData);
    console.log(`[Report] ${category} sev:${severity} id:${issueRef.id} citizen:${citizenId}`);

    // 4. Gamification — award points for filing + daily streak bonus
    const citizen = citizenSnap.data();
    const { streak, bonus, isNewDay } = computeStreak(citizen);
    const pointsEarned = POINTS_PER_REPORT + bonus;
    const totalPoints  = (citizen.points ?? 0) + pointsEarned;
    await citizenRef.update({
      points:         totalPoints,
      streak,
      lastReportDate: todayStr(),
      totalReports:   FieldValue.increment(1),
    });
    console.log(`[Gamify] ${citizen.username} +${pointsEarned}pts (streak ${streak}) → ${totalPoints} total`);

    // 5. Respond to citizen immediately — don't make them wait for cluster analysis
    res.status(201).json({
      id: issueRef.id, category, severity, description, imageUrl,
      gamification: { pointsEarned, streak, totalPoints, isNewDay },
    });

    // 6. Run cluster analysis in background (non-blocking)
    //    We pass imageUrl so the engine can fetch the image from Cloudinary
    runClusterAnalysis({ ...issueData, id: issueRef.id })
      .then(cluster => {
        if (cluster) {
          console.log(`[Cluster] ⚡ New cluster raised: "${cluster.clusterTitle}"`);
        }
      })
      .catch(e => console.error('[Cluster] Background error:', e.message));

  } catch (e) {
    console.error('[/api/report]', e.message);
    res.status(e.code === 'AI_PARSE_ERROR' ? 502 : 500).json({ error: e.message });
  }
});

// ── 2. Worker: proof of fix ───────────────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
  const err = missing(req.body, ['issueId', 'workerId', 'newFixedImageBase64']);
  if (err) return res.status(400).json({ error: err });
  const { issueId, workerId, newFixedImageBase64, latitude, longitude } = req.body;

  const AUDIT_PROMPT = `You are a municipal infrastructure auditor.
Image 1 = the reported civic issue (before). Image 2 = the worker's after photo.
Does Image 2 show physical proof the issue in Image 1 was resolved?
Respond ONLY with raw JSON (no markdown, no code fences):
{"isFixed":true|false,"confidenceScore":<integer 0-100>,"reason":"<one sentence>"}`.trim();

  try {
    const snap = await db.collection('issues').doc(issueId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Issue not found.' });
    const issue = snap.data();

    // Use explicit number checks — `0` is a valid latitude/longitude (equator/prime
    // meridian) and must not be treated as "missing" by a truthy check.
    if (typeof latitude === 'number' && typeof longitude === 'number') {
      const distance = haversineMeters(latitude, longitude, issue.latitude, issue.longitude);
      if (distance > 10)
        return res.status(403).json({ error: `You are ${Math.round(distance)}m away. Must be within 10m.` });
    }

    let originalBase64;
    try {
      originalBase64 = await urlToBase64(issue.imageUrl);
    } catch (e) {
      return res.status(502).json({ error: `Could not fetch original image: ${e.message}` });
    }

    const verification = await callGeminiJSON([
      { inlineData: { data: originalBase64,      mimeType: 'image/jpeg' } },
      { inlineData: { data: newFixedImageBase64,  mimeType: 'image/jpeg' } },
      AUDIT_PROMPT,
    ]);
    const afterImageUrl = await uploadToCloudinary(newFixedImageBase64, 'civicpulse/after');
    const newStatus = verification.isFixed ? 'resolved' : 'in_progress';

    await db.collection('issues').doc(issueId).update({
      status: newStatus, afterImageUrl,
      verificationResult: {
        ...verification,
        verifiedAt: FieldValue.serverTimestamp(),
        verifiedByWorkerId: workerId,
      },
      updatedAt: FieldValue.serverTimestamp(),
    });

    // If this issue is part of a cluster and all sibling issues are now resolved,
    // auto-resolve the cluster too
    if (issue.clusterId && verification.isFixed) {
      resolveClusterIfComplete(issue.clusterId).catch(e =>
        console.error('[Cluster resolve check]', e.message)
      );
    }

    // Gamification — reward the original reporting citizen once their issue is fixed
    if (verification.isFixed && issue.citizenId) {
      db.collection('citizens').doc(issue.citizenId).update({
        points:        FieldValue.increment(POINTS_PER_RESOLVED),
        totalResolved: FieldValue.increment(1),
      }).then(() => {
        console.log(`[Gamify] Citizen ${issue.citizenId} +${POINTS_PER_RESOLVED}pts (issue resolved)`);
      }).catch(e => console.error('[Gamify] Resolve bonus failed:', e.message));
    }

    console.log(`[Verify] ${issueId} isFixed:${verification.isFixed} conf:${verification.confidenceScore}%`);
    res.json({ ...verification, status: newStatus, afterImageUrl });
  } catch (e) {
    console.error('[/api/verify]', e.message);
    res.status(e.code === 'AI_PARSE_ERROR' ? 502 : 500).json({ error: e.message });
  }
});

/** Check if all issues in a cluster are resolved; if so, resolve the cluster */
async function resolveClusterIfComplete(clusterId) {
  const clusterSnap = await db.collection('clusters').doc(clusterId).get();
  if (!clusterSnap.exists) return;
  const cluster = clusterSnap.data();

  const issueSnaps = await Promise.all(
    cluster.issueIds.map(id => db.collection('issues').doc(id).get())
  );
  const allResolved = issueSnaps.every(s => s.data()?.status === 'resolved');

  if (allResolved) {
    await db.collection('clusters').doc(clusterId).update({
      status: 'resolved',
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[Cluster] ✅ Cluster ${clusterId} auto-resolved — all ${cluster.issueIds.length} issues fixed.`);
  }
}

// ── 3. List individual issues ─────────────────────────────────────────────────
app.get('/api/issues', async (req, res) => {
  try {
    let query = db.collection('issues').orderBy('createdAt', 'desc').limit(100);
    if (req.query.workerId) query = query.where('workerId', '==', req.query.workerId);
    if (req.query.status)   query = query.where('status',   '==', req.query.status);
    if (req.query.category) query = query.where('category', '==', req.query.category);
    const s = await query.get();
    res.json({ issues: s.docs.map(d => ({ ...d.data(), id: d.id })), count: s.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 4. Single issue ───────────────────────────────────────────────────────────
app.get('/api/issues/:id', async (req, res) => {
  try {
    const snap = await db.collection('issues').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Issue not found.' });
    res.json({ ...snap.data(), id: snap.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. List clusters (admin dashboard) ───────────────────────────────────────
app.get('/api/clusters', async (req, res) => {
  try {
    let query = db.collection('clusters').orderBy('createdAt', 'desc').limit(50);
    if (req.query.status)   query = query.where('status',   '==', req.query.status);
    if (req.query.category) query = query.where('category', '==', req.query.category);
    const s = await query.get();
    res.json({ clusters: s.docs.map(d => ({ ...d.data(), id: d.id })), count: s.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 6. Single cluster with child issues ──────────────────────────────────────
app.get('/api/clusters/:id', async (req, res) => {
  try {
    const clusterSnap = await db.collection('clusters').doc(req.params.id).get();
    if (!clusterSnap.exists) return res.status(404).json({ error: 'Cluster not found.' });
    const cluster = { ...clusterSnap.data(), id: clusterSnap.id };

    // Hydrate child issues
    const issueSnaps = await Promise.all(
      cluster.issueIds.map(id => db.collection('issues').doc(id).get())
    );
    cluster.issues = issueSnaps
      .filter(s => s.exists)
      .map(s => ({ ...s.data(), id: s.id }));

    res.json(cluster);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 7. Admin: assign issue or cluster ────────────────────────────────────────
app.post('/api/issues/:id/assign', async (req, res) => {
  const { workerId, note } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId required.' });
  try {
    await db.collection('issues').doc(req.params.id).update({
      workerId, workerNote: note ?? null,
      status: 'assigned', updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true, workerId, issueId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clusters/:id/assign', async (req, res) => {
  const { workerId, note } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId required.' });
  try {
    // Assign the cluster and all its child issues in one batch
    const clusterSnap = await db.collection('clusters').doc(req.params.id).get();
    if (!clusterSnap.exists) return res.status(404).json({ error: 'Cluster not found.' });
    const cluster = clusterSnap.data();

    const batch = db.batch();
    batch.update(db.collection('clusters').doc(req.params.id), {
      workerId, workerNote: note ?? null,
      status: 'assigned', updatedAt: FieldValue.serverTimestamp(),
    });
    for (const issueId of cluster.issueIds) {
      batch.update(db.collection('issues').doc(issueId), {
        workerId, workerNote: note ?? null,
        status: 'assigned', updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    res.json({ success: true, workerId, clusterId: req.params.id, issuesAssigned: cluster.issueIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 8. Admin: change status ───────────────────────────────────────────────────
app.post('/api/issues/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'assigned', 'in_progress', 'resolved', 'rejected'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  try {
    await db.collection('issues').doc(req.params.id).update({ status, updatedAt: FieldValue.serverTimestamp() });
    res.json({ success: true, status, issueId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clusters/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'assigned', 'in_progress', 'resolved', 'rejected'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  try {
    await db.collection('clusters').doc(req.params.id).update({ status, updatedAt: FieldValue.serverTimestamp() });
    res.json({ success: true, status, clusterId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 9. List workers ───────────────────────────────────────────────────────────
app.get('/api/workers', async (_req, res) => {
  try {
    const s = await db.collection('workers').get();
    res.json({ workers: s.docs.map(d => sanitize({ id: d.id, ...d.data() })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ┌──────────────────────────────────────────────────────┐
  │  CivicPulse AI Engine                                │
  │  Storage: Cloudinary  ·  Database: Firestore         │
  │  Clustering: ON  (radius: ${CLUSTER_RADIUS_M}m, min: ${CLUSTER_MIN_ISSUES} issues)       │
  │  Listening on 0.0.0.0:${PORT}                            │
  ├──────────────────────────────────────────────────────┤
  │  POST /api/auth/citizen/register  Citizen sign up    │
  │  POST /api/auth/citizen/login     Citizen log in     │
  │  POST /api/auth/worker/login      Worker log in       │
  │  POST /api/admin/workers          Admin: add worker  │
  │  POST /api/admin/workers/:id/active  Toggle worker    │
  │  GET  /api/citizens/:id           Citizen profile     │
  │  GET  /api/leaderboard            Top citizens        │
  │  POST /api/report                 Citizen report      │
  │  POST /api/verify                 Worker proof        │
  │  GET  /api/issues                 List issues         │
  │  GET  /api/issues/:id             Single issue        │
  │  GET  /api/clusters               List clusters       │
  │  GET  /api/clusters/:id           Cluster + children  │
  │  POST /api/issues/:id/assign      Assign issue         │
  │  POST /api/clusters/:id/assign    Assign cluster       │
  │  POST /api/issues/:id/status      Change issue status  │
  │  POST /api/clusters/:id/status    Change cluster status│
  │  GET  /api/workers                List workers         │
  │  GET  /health                     Health check         │
  └──────────────────────────────────────────────────────┘
  `);
});