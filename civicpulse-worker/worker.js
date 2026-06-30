/**
 * CivicPulse — Worker App
 * Fixes applied:
 *  1. Removed originalImageBase64 from verify payload — server fetches from Cloudinary URL itself
 *  2. Added useEffect to live-update distance from workerCoords
 *  3. Guarded geofence alert against null distance
 *  4. Upgraded GPS accuracy to High for reliable 10m geofence
 *  5. "Open in Maps" now actually opens native maps app via Linking
 *  6. Added a DEV_MODE bypass so you can test without walking to the site
 *  7. Replaced hardcoded WORKER_ID with a real login screen — worker accounts
 *     are created by an admin via the dashboard and authenticate against
 *     POST /api/auth/worker/login. Session is cached locally with AsyncStorage.
 *
 * Install deps: expo install @react-native-async-storage/async-storage
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ActivityIndicator,
  SafeAreaView, ScrollView, FlatList, StatusBar, Platform, Alert, Linking, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import MapView, { Marker, Circle, Polyline } from 'react-native-maps';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_BASE   = 'http://192.168.1.39:3000'; // ← replace with your LAN IP
const SESSION_KEY = 'civicpulse_worker';

// Set to true while testing indoors so the geofence doesn't block you
const DEV_MODE = true;

// ─── THEME ────────────────────────────────────────────────────────────────────
const C = {
  bg: '#071220', surface: '#0C1A2E', surfaceAlt: '#112038',
  teal: '#00BFA5', tealLight: '#4DD0C4',
  amber: '#F5A623', green: '#00C851', red: '#FF4757',
  blue: '#1565FF', blueLight: '#4D87FF',
  text: '#DDE4F0', textMuted: '#647A9B', border: '#172A46',
};

const SEVERITY_COLORS = ['', C.green, '#64DD17', C.amber, '#FF6D00', C.red];
const SEVERITY_LABELS = ['', 'Low', 'Moderate', 'Notable', 'High', 'Critical'];
const CATEGORY_ICONS  = { Pothole: '🕳️', Trash: '🗑️', Streetlight: '💡', 'Water Leak': '💧', Other: '⚠️' };

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    pending:     { color: C.amber, label: 'PENDING' },
    assigned:    { color: C.blue,  label: 'ASSIGNED' },
    in_progress: { color: C.teal,  label: 'IN PROGRESS' },
    resolved:    { color: C.green, label: 'RESOLVED' },
    rejected:    { color: C.red,   label: 'REJECTED' },
  };
  const { color, label } = map[status] ?? { color: C.textMuted, label: status?.toUpperCase() ?? '—' };
  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

// ─── ISSUE ROW ────────────────────────────────────────────────────────────────
function IssueRow({ issue, onPress }) {
  const sColor = SEVERITY_COLORS[issue.severity] || C.textMuted;
  return (
    <TouchableOpacity style={styles.issueRow} onPress={onPress} activeOpacity={0.78}>
      <View style={[styles.issueSeverityBar, { backgroundColor: sColor }]} />
      <View style={styles.issueRowContent}>
        <View style={styles.issueRowTop}>
          <Text style={styles.issueIcon}>{CATEGORY_ICONS[issue.category] ?? '⚠️'}</Text>
          <View style={styles.issueRowMeta}>
            <Text style={styles.issueCat}>{issue.category}</Text>
            <Text style={styles.issueId}>#{issue.id?.slice(-5).toUpperCase()}</Text>
          </View>
          <StatusBadge status={issue.status} />
        </View>
        <Text style={styles.issueDesc} numberOfLines={2}>{issue.description}</Text>
        <View style={styles.issueRowBottom}>
          <Text style={styles.issueMeta}>
            Sev {issue.severity}/5 · {issue.distance != null ? `${Math.round(issue.distance)}m away` : 'Locating…'}
          </Text>
          <Text style={styles.issueArrow}>›</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── ISSUE DETAIL SCREEN ──────────────────────────────────────────────────────
function IssueDetailScreen({ issue, workerCoords, workerId, onBack, onRefresh }) {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mode, setMode]             = useState('detail'); // detail | camera | uploading | done
  const [distance, setDistance]     = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [cameraReady, setCameraReady]   = useState(false);
  const cameraRef = useRef(null);

  // ── FIX 1: Live distance recalculation whenever workerCoords changes ─────────
  useEffect(() => {
    if (!workerCoords || issue.latitude == null || issue.longitude == null) return;
    const d = haversineMeters(
      workerCoords.latitude, workerCoords.longitude,
      issue.latitude, issue.longitude,
    );
    setDistance(d);
  }, [workerCoords, issue.latitude, issue.longitude]);

  // DEV_MODE bypasses the 10m geofence so you can test indoors
  const insideGeofence = DEV_MODE || (distance !== null && distance <= 10);
  const sColor         = SEVERITY_COLORS[issue.severity] || C.textMuted;

  // ── Open native maps for navigation ──────────────────────────────────────────
  const openMapsNavigation = () => {
    const { latitude, longitude } = issue;
    const label = encodeURIComponent(issue.category);
    const url   = Platform.OS === 'ios'
      ? `maps://?daddr=${latitude},${longitude}&dirflg=d`
      : `google.navigation:q=${latitude},${longitude}`;
    Linking.canOpenURL(url).then(supported => {
      if (supported) {
        Linking.openURL(url);
      } else {
        // Fallback to Google Maps web
        Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`);
      }
    });
  };

  // ── Open camera (with permission check) ──────────────────────────────────────
  const openCamera = async () => {
    // ── FIX 2: Guard against null distance before calling Math.round ─────────
    if (!DEV_MODE && !insideGeofence) {
      const dist = distance !== null ? Math.round(distance) : '?';
      Alert.alert(
        'Too far away',
        `You need to be within 10m of the issue.\nYou are currently ${dist}m away.`,
        [{ text: 'OK' }]
      );
      return;
    }
    if (!cameraPermission?.granted) {
      const { granted } = await requestCameraPermission();
      if (!granted) {
        Alert.alert('Camera permission denied', 'Please enable camera access in your device settings.');
        return;
      }
    }
    setMode('camera');
  };

  // ── Submit proof photo ────────────────────────────────────────────────────────
  const submitProof = async () => {
    if (!cameraRef.current) {
      Alert.alert('Error', 'Camera is not ready yet. Please wait a moment and try again.');
      return;
    }
    if (!cameraReady) {
      Alert.alert('Error', 'Camera is still initialising. Please wait a second and try again.');
      return;
    }
    // CRITICAL: capture the photo FIRST, then switch screens.
    // Calling setMode('uploading') before takePictureAsync unmounts the CameraView
    // mid-capture, which is exactly what causes "Failed to capture image".
    let photo;
    try {
      console.log('📸 Taking proof photo…');
      photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
    } catch (captureErr) {
      console.error('📸 Capture error:', captureErr.message);
      Alert.alert('Camera error', 'Could not take photo. Please tap Back and try again.');
      return;
    }

    if (!photo?.base64) {
      Alert.alert('Camera error', 'No image data returned. Please try again.');
      return;
    }

    // Photo is safely in memory — NOW switch to the uploading screen
    setMode('uploading');

    try {
      console.log('📸 Photo ready — sending to backend…');
      const res = await fetch(`${API_BASE}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueId:             issue.id,
          workerId:            workerId,
          newFixedImageBase64: photo.base64,
          latitude:            workerCoords?.latitude,
          longitude:           workerCoords?.longitude,
        }),
      });

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const raw = await res.text();
        throw new Error(`Server returned unexpected response: ${raw.slice(0, 120)}`);
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Server error ${res.status}`);

      console.log('✅ Verify result:', data);
      setVerifyResult(data);
      setMode('done');
      onRefresh?.();
    } catch (e) {
      console.error('🚨 submitProof error:', e.message);
      Alert.alert('Upload failed', e.message);
      setMode('camera');
    }
  };

  // ── CAMERA SCREEN ─────────────────────────────────────────────────────────────
  if (mode === 'camera') {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView style={StyleSheet.absoluteFill} ref={cameraRef} onCameraReady={() => setCameraReady(true)} />
        <View style={styles.vignetteBottom} />

        <SafeAreaView style={styles.topBarDark}>
          <TouchableOpacity onPress={() => setMode('detail')}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.wordmark}>PROOF OF FIX</Text>
          <View style={{ width: 60 }} />
        </SafeAreaView>

        {/* Corner guides */}
        {[
          { top: 80, left: 28 }, { top: 80, right: 28 },
          { bottom: 180, left: 28 }, { bottom: 180, right: 28 },
        ].map((pos, i) => (
          <View key={i} style={[styles.corner,
            pos.top    !== undefined ? { top: pos.top }       : { bottom: pos.bottom },
            pos.left   !== undefined ? { left: pos.left }     : { right: pos.right },
            i < 2 ? styles.cornerT : styles.cornerB,
            (i === 0 || i === 2) ? styles.cornerL : styles.cornerR,
          ]} pointerEvents="none" />
        ))}

        <View style={styles.cameraHint}>
          <Text style={styles.cameraHintText}>Photograph the repaired location</Text>
          <Text style={styles.cameraHintSub}>
            {CATEGORY_ICONS[issue.category]} {issue.category} — same angle as the original
          </Text>
          {DEV_MODE && (
            <View style={styles.devBadge}>
              <Text style={styles.devBadgeText}>DEV MODE — geofence bypassed</Text>
            </View>
          )}
        </View>

        <View style={styles.cameraControls}>
          <TouchableOpacity style={styles.snapBtn} onPress={submitProof} activeOpacity={0.85}>
            <View style={styles.snapInner} />
          </TouchableOpacity>
          <Text style={styles.snapHint}>Tap to submit proof</Text>
        </View>
      </View>
    );
  }

  // ── UPLOADING SCREEN ──────────────────────────────────────────────────────────
  if (mode === 'uploading') {
    return (
      <View style={[styles.centeredScreen, { backgroundColor: C.bg }]}>
        <ActivityIndicator size="large" color={C.teal} />
        <Text style={styles.uploadingText}>AI is reviewing your fix…</Text>
        <Text style={styles.uploadingSubtext}>Comparing before &amp; after photos</Text>
      </View>
    );
  }

  // ── DONE SCREEN ───────────────────────────────────────────────────────────────
  if (mode === 'done' && verifyResult) {
    const verified = verifyResult.isFixed;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onBack}><Text style={styles.backBtn}>← Issues</Text></TouchableOpacity>
          <Text style={styles.wordmark}>CIVICPULSE</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.doneContainer}>
          <Text style={styles.doneIcon}>{verified ? '✅' : '❌'}</Text>
          <Text style={[styles.doneTitle, { color: verified ? C.green : C.red }]}>
            {verified ? 'Fix Verified!' : 'Not Verified'}
          </Text>
          <Text style={styles.doneConf}>AI confidence: {verifyResult.confidenceScore}%</Text>
          <View style={styles.doneReason}>
            <Text style={styles.doneReasonText}>{verifyResult.reason}</Text>
          </View>
          {verifyResult.afterImageUrl && (
            <View style={styles.afterUrlBox}>
              <Text style={styles.afterUrlLabel}>PROOF PHOTO STORED</Text>
              <Text style={styles.afterUrlVal} numberOfLines={1}>{verifyResult.afterImageUrl}</Text>
            </View>
          )}
          {!verified && (
            <TouchableOpacity style={styles.retryBtn} onPress={() => setMode('camera')}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.retryBtn, { backgroundColor: C.surfaceAlt, borderColor: C.border }]}
            onPress={onBack}
          >
            <Text style={[styles.retryBtnText, { color: C.textMuted }]}>Back to issues</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── DETAIL SCREEN ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onBack}><Text style={styles.backBtn}>← Issues</Text></TouchableOpacity>
        <Text style={styles.wordmark}>CIVICPULSE</Text>
        <StatusBadge status={issue.status} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
        {/* Header card */}
        <View style={[styles.detailHeader, { borderLeftColor: sColor }]}>
          <Text style={styles.detailIcon}>{CATEGORY_ICONS[issue.category] ?? '⚠️'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailCat}>{issue.category}</Text>
            <Text style={styles.detailId}>#{issue.id?.slice(-8).toUpperCase()}</Text>
          </View>
          <View style={[styles.severityCircle, { borderColor: sColor }]}>
            <Text style={[styles.severityNum, { color: sColor }]}>{issue.severity}</Text>
            <Text style={[styles.severityOf, { color: sColor }]}>/5</Text>
          </View>
        </View>

        <Text style={styles.detailDesc}>{issue.description}</Text>
        <View style={styles.divider} />

        {/* Map */}
        <Text style={styles.sectionLabel}>LOCATION</Text>
        <MapView
          style={styles.detailMap}
          initialRegion={{
            latitude:      issue.latitude,
            longitude:     issue.longitude,
            latitudeDelta:  workerCoords
              ? Math.max(Math.abs(workerCoords.latitude  - issue.latitude)  * 3, 0.005)
              : 0.01,
            longitudeDelta: workerCoords
              ? Math.max(Math.abs(workerCoords.longitude - issue.longitude) * 3, 0.005)
              : 0.01,
          }}
          mapType="standard"
          userInterfaceStyle="dark"
        >
          {/* Issue pin */}
          <Marker
            coordinate={{ latitude: issue.latitude, longitude: issue.longitude }}
            pinColor={C.red}
            title={issue.category}
            description={issue.description}
          />
          <Circle
            center={{ latitude: issue.latitude, longitude: issue.longitude }}
            radius={10}
            fillColor="rgba(255,71,87,0.12)"
            strokeColor={C.red}
            strokeWidth={1.5}
          />

          {/* Worker position + route line */}
          {workerCoords && (
            <>
              <Marker
                coordinate={{ latitude: workerCoords.latitude, longitude: workerCoords.longitude }}
                pinColor={C.teal}
                title="You"
              />
              <Polyline
                coordinates={[
                  { latitude: workerCoords.latitude, longitude: workerCoords.longitude },
                  { latitude: issue.latitude,        longitude: issue.longitude },
                ]}
                strokeColor={C.teal}
                strokeWidth={2}
                lineDashPattern={[6, 4]}
              />
            </>
          )}
        </MapView>

        {/* Distance bar */}
        <View style={[styles.distanceBar, { borderColor: insideGeofence ? C.green : C.border }]}>
          <View style={[styles.distanceDot, { backgroundColor: insideGeofence ? C.green : C.amber }]} />
          <Text style={[styles.distanceText, { color: insideGeofence ? C.green : C.text }]}>
            {DEV_MODE
              ? 'DEV MODE — geofence bypassed'
              : distance !== null
                ? insideGeofence
                  ? 'Within geofence — you can file a fix'
                  : `${Math.round(distance)}m from issue (need to be within 10m)`
                : 'Calculating distance…'
            }
          </Text>
        </View>

        <View style={styles.divider} />

        {/* Submit proof button */}
        <TouchableOpacity
          style={[styles.fixBtn, !insideGeofence && styles.fixBtnDisabled]}
          onPress={openCamera}
          activeOpacity={0.85}
        >
          <Text style={styles.fixBtnText}>
            {insideGeofence
              ? '📸  Submit Proof of Fix'
              : `Move within ${distance != null ? Math.round(distance) : '?'}m to unlock`
            }
          </Text>
        </TouchableOpacity>

        {/* Open Maps button — now actually works */}
        <TouchableOpacity style={styles.navBtn} onPress={openMapsNavigation} activeOpacity={0.85}>
          <Text style={styles.navBtnText}>🗺️  Navigate with Maps</Text>
        </TouchableOpacity>

        {/* Worker note */}
        {issue.workerNote ? (
          <>
            <View style={styles.divider} />
            <Text style={styles.sectionLabel}>NOTE FROM ADMIN</Text>
            <View style={styles.noteBox}>
              <Text style={styles.noteText}>{issue.workerNote}</Text>
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
// Worker accounts are created by an admin via the dashboard (POST /api/admin/workers).
// Workers can't self-register — they just log in with the credentials they were given.
function WorkerLoginScreen({ onAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const submit = async () => {
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/auth/worker/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Login failed.');
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(data.worker));
      onAuthenticated(data.worker);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.loginScreen}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <ScrollView contentContainerStyle={styles.loginInner} keyboardShouldPersistTaps="handled">
        <Text style={styles.loginEmoji}>🛠️</Text>
        <Text style={styles.loginTitle}>CivicPulse</Text>
        <Text style={styles.loginSub}>Worker sign-in. Don't have an account? Ask your admin to create one.</Text>

        <View style={styles.loginField}>
          <Text style={styles.sectionLabel}>USERNAME</Text>
          <TextInput
            style={styles.loginInput}
            value={username}
            onChangeText={setUsername}
            placeholder="e.g. r.kumar"
            placeholderTextColor={C.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <View style={styles.loginField}>
          <Text style={styles.sectionLabel}>PASSWORD</Text>
          <TextInput
            style={styles.loginInput}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={C.textMuted}
            secureTextEntry
          />
        </View>

        {error ? <Text style={styles.loginError}>{error}</Text> : null}

        <TouchableOpacity style={styles.fixBtn} onPress={submit} disabled={loading} activeOpacity={0.85}>
          {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.fixBtnText}>Log in</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── MAIN WORKER APP ──────────────────────────────────────────────────────────
export default function WorkerApp() {
  const [issues, setIssues]           = useState([]);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [workerCoords, setWorkerCoords]   = useState(null);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);

  // ── Worker session ───────────────────────────────────────────────────────────
  const [worker, setWorker] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(SESSION_KEY);
        if (stored) setWorker(JSON.parse(stored));
      } catch (e) {
        console.warn('Could not load saved worker session:', e.message);
      } finally {
        setSessionChecked(true);
      }
    })();
  }, []);

  const handleLogout = () => {
    AsyncStorage.removeItem(SESSION_KEY).finally(() => setWorker(null));
  };

  const fetchIssues = useCallback(async (workerId) => {
    if (!workerId) return;
    try {
      const res  = await fetch(`${API_BASE}/api/issues?workerId=${workerId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to fetch issues');
      setIssues(data.issues ?? []);
    } catch (e) {
      console.error('fetchIssues error:', e.message);
      Alert.alert('Connection error', `Could not load issues: ${e.message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // ── FIX 4: GPS accuracy set to High for reliable 10m geofence ───────────────
  useEffect(() => {
    if (!worker) return;
    let sub;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location required', 'This app needs location access to verify you are at the issue site.');
        return;
      }
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2 },
        (loc) => setWorkerCoords(loc.coords),
      );
    })();
    fetchIssues(worker.id);
    return () => sub?.remove();
  }, [worker]);

  const enrichedIssues = issues
    .map(issue => ({
      ...issue,
      distance: workerCoords
        ? haversineMeters(workerCoords.latitude, workerCoords.longitude, issue.latitude, issue.longitude)
        : null,
    }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

  // Session still loading from storage → blank screen to avoid a login flash
  if (!sessionChecked) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  // Not logged in → show login screen
  if (!worker) return <WorkerLoginScreen onAuthenticated={setWorker} />;

  if (selectedIssue) {
    return (
      <IssueDetailScreen
        issue={selectedIssue}
        workerCoords={workerCoords}
        workerId={worker.id}
        onBack={() => setSelectedIssue(null)}
        onRefresh={() => fetchIssues(worker.id)}
      />
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.wordmark}>CIVICPULSE</Text>
          <Text style={styles.roleTag}>{worker.name?.toUpperCase() ?? 'WORKER VIEW'}</Text>
        </View>
        <TouchableOpacity style={styles.workerChip} onPress={handleLogout} activeOpacity={0.7}>
          <View style={[styles.badgeDot, { backgroundColor: C.teal }]} />
          <Text style={[styles.badgeText, { color: C.teal }]}>ON DUTY · LOG OUT</Text>
        </TouchableOpacity>
      </View>

      {/* GPS strip */}
      <View style={styles.gpsStrip}>
        {workerCoords ? (
          <>
            <View style={[styles.badgeDot, { backgroundColor: C.green }]} />
            <Text style={styles.gpsText}>
              GPS locked · {workerCoords.latitude.toFixed(5)}, {workerCoords.longitude.toFixed(5)}
            </Text>
          </>
        ) : (
          <>
            <ActivityIndicator size="small" color={C.amber} style={{ marginRight: 8 }} />
            <Text style={[styles.gpsText, { color: C.amber }]}>Acquiring GPS lock…</Text>
          </>
        )}
        {DEV_MODE && <Text style={[styles.gpsText, { color: C.red, marginLeft: 8 }]}>DEV</Text>}
      </View>

      {/* Stats row */}
      <View style={styles.statsRow}>
        {[
          { label: 'ASSIGNED',       value: enrichedIssues.filter(i => i.status === 'assigned' || i.status === 'in_progress').length, color: C.blue },
          { label: 'RESOLVED TODAY', value: enrichedIssues.filter(i => i.status === 'resolved').length,                               color: C.green },
          { label: 'HIGH PRIORITY',  value: enrichedIssues.filter(i => i.severity >= 4).length,                                        color: C.red },
        ].map(({ label, value, color }) => (
          <View key={label} style={styles.statCard}>
            <Text style={[styles.statValue, { color }]}>{value}</Text>
            <Text style={styles.statLabel}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Issue list */}
      {loading ? (
        <View style={styles.centeredScreen}>
          <ActivityIndicator size="large" color={C.teal} />
          <Text style={styles.uploadingText}>Loading your assignments…</Text>
        </View>
      ) : enrichedIssues.length === 0 ? (
        <View style={styles.centeredScreen}>
          <Text style={{ fontSize: 40 }}>✅</Text>
          <Text style={styles.emptyTitle}>All clear</Text>
          <Text style={styles.emptySubtitle}>No issues assigned to you right now.</Text>
          <TouchableOpacity style={styles.refreshBtn} onPress={() => fetchIssues(worker.id)}>
            <Text style={styles.refreshBtnText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={enrichedIssues}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <IssueRow issue={item} onPress={() => setSelectedIssue(item)} />
          )}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 40 }}
          onRefresh={() => { setRefreshing(true); fetchIssues(worker.id); }}
          refreshing={refreshing}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: C.border, marginLeft: 20 }} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // Login screen
  loginScreen: { flex: 1, backgroundColor: C.bg },
  loginInner:  { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  loginEmoji:  { fontSize: 48, marginBottom: 16 },
  loginTitle:  { fontSize: 32, fontWeight: '900', color: C.text, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 },
  loginSub:    { fontSize: 14, color: C.textMuted, textAlign: 'center', lineHeight: 20, marginBottom: 28 },
  loginField:  { width: '100%', marginBottom: 14 },
  loginInput: {
    width: '100%', backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 14, paddingVertical: 12, color: C.text, fontSize: 15, marginTop: 6,
  },
  loginError: { color: C.red, fontSize: 13, marginBottom: 12, textAlign: 'center' },

  topBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: C.border,
    paddingTop: Platform.OS === 'android' ? 44 : 14,
    backgroundColor: C.bg,
  },
  topBarDark: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    paddingTop: Platform.OS === 'android' ? 44 : 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  wordmark:   { fontSize: 13, fontWeight: '900', color: C.text, letterSpacing: 3 },
  roleTag:    { fontSize: 9, color: C.teal, letterSpacing: 2, fontWeight: '700', marginTop: 2 },
  backBtn:    { color: C.teal, fontSize: 14, fontWeight: '600' },
  workerChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.teal + '22', borderColor: C.teal, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  badge:    { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  badgeDot: { width: 5, height: 5, borderRadius: 2.5, marginRight: 5 },
  badgeText:{ fontSize: 9, fontWeight: '700', letterSpacing: 1 },

  gpsStrip:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 8, backgroundColor: C.surface },
  gpsText:    { fontSize: 11, color: C.textMuted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  statsRow:   { flexDirection: 'row', gap: 1, backgroundColor: C.border, borderBottomWidth: 1, borderBottomColor: C.border },
  statCard:   { flex: 1, backgroundColor: C.surface, padding: 16, alignItems: 'center' },
  statValue:  { fontSize: 26, fontWeight: '800' },
  statLabel:  { fontSize: 9, color: C.textMuted, letterSpacing: 1.5, marginTop: 2, textAlign: 'center' },

  issueRow:         { flexDirection: 'row', backgroundColor: C.surface },
  issueSeverityBar: { width: 4 },
  issueRowContent:  { flex: 1, padding: 16 },
  issueRowTop:      { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  issueIcon:        { fontSize: 22, marginRight: 10 },
  issueRowMeta:     { flex: 1 },
  issueCat:         { fontSize: 16, fontWeight: '700', color: C.text },
  issueId:          { fontSize: 11, color: C.textMuted, letterSpacing: 1 },
  issueDesc:        { fontSize: 13, color: C.textMuted, lineHeight: 18, marginBottom: 8 },
  issueRowBottom:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  issueMeta:        { fontSize: 11, color: C.textMuted },
  issueArrow:       { fontSize: 22, color: C.textMuted },

  sectionLabel: { fontSize: 9, fontWeight: '700', color: C.textMuted, letterSpacing: 2, marginBottom: 8 },
  divider:      { height: 1, backgroundColor: C.border, marginVertical: 20 },

  detailHeader: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 12,
    padding: 16, marginBottom: 16, borderLeftWidth: 4,
  },
  detailIcon:    { fontSize: 36, marginRight: 14 },
  detailCat:     { fontSize: 22, fontWeight: '800', color: C.text },
  detailId:      { fontSize: 11, color: C.textMuted, letterSpacing: 1 },
  severityCircle:{ width: 52, height: 52, borderRadius: 26, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  severityNum:   { fontSize: 20, fontWeight: '800', lineHeight: 22 },
  severityOf:    { fontSize: 10, fontWeight: '600' },
  detailDesc:    { fontSize: 15, color: C.text, lineHeight: 22, marginBottom: 4 },
  detailMap:     { height: 220, borderRadius: 12, overflow: 'hidden', marginBottom: 12 },

  distanceBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, gap: 10,
  },
  distanceDot:  { width: 8, height: 8, borderRadius: 4 },
  distanceText: { fontSize: 13, fontWeight: '600', flex: 1 },

  fixBtn:         { backgroundColor: C.teal, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginBottom: 12 },
  fixBtnDisabled: { backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border },
  fixBtnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
  navBtn:         { borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingVertical: 14, alignItems: 'center', backgroundColor: C.surfaceAlt },
  navBtnText:     { color: C.textMuted, fontWeight: '600', fontSize: 14 },

  noteBox:  { backgroundColor: C.surface, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: C.border },
  noteText: { color: C.text, fontSize: 14, lineHeight: 20 },

  // Camera screen
  vignetteBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 200, backgroundColor: 'rgba(0,0,0,0.72)' },
  corner:   { position: 'absolute', width: 22, height: 22, borderColor: 'rgba(0,191,165,0.85)' },
  cornerT:  { borderTopWidth: 2 },
  cornerB:  { borderBottomWidth: 2 },
  cornerL:  { borderLeftWidth: 2 },
  cornerR:  { borderRightWidth: 2 },
  cameraHint:     { position: 'absolute', top: 110, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 24 },
  cameraHintText: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 6, textAlign: 'center' },
  cameraHintSub:  { color: 'rgba(255,255,255,0.65)', fontSize: 12, textAlign: 'center' },
  devBadge:     { marginTop: 10, backgroundColor: C.red + '33', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: C.red },
  devBadgeText: { color: C.red, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  cameraControls: { position: 'absolute', bottom: 56, left: 0, right: 0, alignItems: 'center' },
  snapBtn:   { width: 72, height: 72, borderRadius: 36, backgroundColor: C.teal, justifyContent: 'center', alignItems: 'center', shadowColor: C.teal, shadowOpacity: 0.5, shadowRadius: 14, elevation: 10 },
  snapInner: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff' },
  snapHint:  { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 12, letterSpacing: 1 },

  // Uploading / Done screens
  centeredScreen:   { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: C.bg },
  uploadingText:    { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 12 },
  uploadingSubtext: { color: C.textMuted, fontSize: 13 },
  doneContainer:    { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  doneIcon:         { fontSize: 56, marginBottom: 8 },
  doneTitle:        { fontSize: 28, fontWeight: '800', textAlign: 'center' },
  doneConf:         { fontSize: 14, color: C.textMuted },
  doneReason:       { backgroundColor: C.surface, borderRadius: 12, padding: 18, width: '100%', borderWidth: 1, borderColor: C.border },
  doneReasonText:   { color: C.text, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  afterUrlBox:      { width: '100%', backgroundColor: C.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.border },
  afterUrlLabel:    { fontSize: 9, color: C.textMuted, letterSpacing: 1.5, fontWeight: '700', marginBottom: 4 },
  afterUrlVal:      { fontSize: 11, color: C.teal, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  retryBtn:         { width: '100%', backgroundColor: C.teal, borderRadius: 12, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  retryBtnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },

  emptyTitle:      { fontSize: 22, fontWeight: '800', color: C.text, marginTop: 8 },
  emptySubtitle:   { fontSize: 14, color: C.textMuted, textAlign: 'center' },
  refreshBtn:      { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border },
  refreshBtnText:  { color: C.teal, fontWeight: '600', fontSize: 14 },
});