/**
 * CivicPulse — Citizen App (CitizenApp.js)
 * Install deps: expo install expo-camera expo-location react-native-maps
 *               expo install @react-native-async-storage/async-storage
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ActivityIndicator,
  Animated, Easing, StatusBar, SafeAreaView, ScrollView,
  Platform, Dimensions, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import MapView, { Marker, Circle } from 'react-native-maps';

const API_BASE   = 'http://192.168.1.39:3000'; // ← your LAN IP
const SESSION_KEY = 'civicpulse_citizen';

const C = {
  bg: '#0A1628', surface: '#0F1E3D', surfaceAlt: '#162440',
  blue: '#1565FF', blueLight: '#4D87FF',
  amber: '#F5A623', green: '#00C851', red: '#FF4757',
  text: '#E8EDF5', textMuted: '#7A8BAD', border: '#1E3060',
};

const SEVERITY_COLORS = ['', C.green, '#64DD17', C.amber, '#FF6D00', C.red];
const SEVERITY_LABELS = ['', 'Low', 'Moderate', 'Notable', 'High', 'Critical'];
const CATEGORY_ICONS  = { Pothole: '🕳️', Trash: '🗑️', Streetlight: '💡', 'Water Leak': '💧', Other: '⚠️' };

// ─── PULSE RING ───────────────────────────────────────────────────────────────
function PulseRing({ active, color = C.blue }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(Animated.parallel([
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.7, duration: 950, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: 950, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.6, duration: 0, useNativeDriver: true }),
      ]),
    ]));
    loop.start();
    return () => loop.stop();
  }, [active]);
  if (!active) return null;
  return <Animated.View style={[styles.pulseRing, { transform: [{ scale }], opacity, borderColor: color }]} pointerEvents="none" />;
}

// ─── GPS LOCATION PREVIEW ────────────────────────────────────────────────────
function LocationPreview({ coords, onConfirm, onRetry, loading }) {
  const slideY = useRef(new Animated.Value(80)).current;
  const fade   = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideY, { toValue: 0, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(fade,   { toValue: 1, duration: 380, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[styles.locationPreview, { opacity: fade, transform: [{ translateY: slideY }] }]}>
      <View style={styles.lpHeader}>
        <View style={styles.lpDot} />
        <Text style={styles.lpHeaderText}>CONFIRM LOCATION</Text>
      </View>

      {/* Mini map showing the pin */}
      <MapView
        style={styles.miniMap}
        initialRegion={{
          latitude: coords.latitude,
          longitude: coords.longitude,
          latitudeDelta: 0.003,
          longitudeDelta: 0.003,
        }}
        scrollEnabled={false}
        zoomEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        mapType="standard"
        userInterfaceStyle="dark"
      >
        <Marker
          coordinate={{ latitude: coords.latitude, longitude: coords.longitude }}
          pinColor={C.red}
        />
        <Circle
          center={{ latitude: coords.latitude, longitude: coords.longitude }}
          radius={30}
          fillColor="rgba(255,71,87,0.15)"
          strokeColor={C.red}
          strokeWidth={1}
        />
      </MapView>

      {/* Coordinates */}
      <View style={styles.coordRow}>
        <View style={styles.coordItem}>
          <Text style={styles.coordLabel}>LATITUDE</Text>
          <Text style={styles.coordValue}>{coords.latitude.toFixed(6)}</Text>
        </View>
        <View style={styles.coordSep} />
        <View style={styles.coordItem}>
          <Text style={styles.coordLabel}>LONGITUDE</Text>
          <Text style={styles.coordValue}>{coords.longitude.toFixed(6)}</Text>
        </View>
        <View style={styles.coordSep} />
        <View style={styles.coordItem}>
          <Text style={styles.coordLabel}>ACCURACY</Text>
          <Text style={[styles.coordValue, { color: C.green }]}>
            ±{Math.round(coords.accuracy ?? 0)}m
          </Text>
        </View>
      </View>

      <View style={styles.lpActions}>
        <TouchableOpacity style={styles.lpRetryBtn} onPress={onRetry} disabled={loading}>
          <Text style={styles.lpRetryText}>Re-lock GPS</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.lpConfirmBtn} onPress={onConfirm} disabled={loading}>
          {loading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.lpConfirmText}>Looks correct — Report it</Text>
          }
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

// ─── RESULT CARD ─────────────────────────────────────────────────────────────
function ResultCard({ data, coords, gamification, onReset }) {
  const slideY = useRef(new Animated.Value(60)).current;
  const fade   = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideY, { toValue: 0, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(fade,   { toValue: 1, duration: 420, useNativeDriver: true }),
    ]).start();
  }, []);
  const ticketId = `CP-${Math.floor(Math.random() * 90000 + 10000)}`;
  const sColor = SEVERITY_COLORS[data.severity] || C.textMuted;

  return (
    <Animated.View style={[styles.resultCard, { opacity: fade, transform: [{ translateY: slideY }] }]}>
      {gamification && (
        <View style={styles.pointsBanner}>
          <Text style={styles.pointsBannerMain}>+{gamification.pointsEarned} points</Text>
          <Text style={styles.pointsBannerSub}>
            {gamification.streak > 1
              ? `🔥 ${gamification.streak}-day reporting streak — ${gamification.totalPoints} total points`
              : `${gamification.totalPoints} total points`}
          </Text>
        </View>
      )}
      <View style={[styles.rcHeader, { backgroundColor: C.blue }]}>
        <View>
          <Text style={styles.rcLabel}>ISSUE FILED</Text>
          <Text style={styles.rcTicket}>{ticketId}</Text>
        </View>
        <Text style={styles.rcIcon}>{CATEGORY_ICONS[data.category] ?? '⚠️'}</Text>
      </View>

      <View style={styles.rcBody}>
        <Text style={styles.rcCategory}>{data.category}</Text>
        <View style={[styles.badge, { backgroundColor: sColor + '22', borderColor: sColor }]}>
          <View style={[styles.badgeDot, { backgroundColor: sColor }]} />
          <Text style={[styles.badgeText, { color: sColor }]}>{SEVERITY_LABELS[data.severity]?.toUpperCase()} SEVERITY</Text>
        </View>
        <View style={styles.divider} />
        <Text style={styles.rcSectionLabel}>ASSESSMENT</Text>
        <Text style={styles.rcDescription}>{data.description}</Text>
        <View style={styles.divider} />

        {/* Location on map */}
        {coords && (
          <>
            <Text style={styles.rcSectionLabel}>PINNED LOCATION</Text>
            <MapView
              style={styles.resultMap}
              initialRegion={{
                latitude: coords.latitude,
                longitude: coords.longitude,
                latitudeDelta: 0.004,
                longitudeDelta: 0.004,
              }}
              scrollEnabled={false}
              zoomEnabled={false}
              mapType="standard"
              userInterfaceStyle="dark"
            >
              <Marker coordinate={{ latitude: coords.latitude, longitude: coords.longitude }} pinColor={C.red} />
              <Circle
                center={{ latitude: coords.latitude, longitude: coords.longitude }}
                radius={40}
                fillColor="rgba(255,71,87,0.12)"
                strokeColor={C.red}
                strokeWidth={1}
              />
            </MapView>
            <View style={styles.divider} />
          </>
        )}

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>SEVERITY</Text>
            <Text style={[styles.metaValue, { color: sColor }]}>{data.severity} / 5</Text>
          </View>
          <View style={styles.metaSep} />
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>STATUS</Text>
            <Text style={[styles.metaValue, { color: C.amber }]}>PENDING</Text>
          </View>
          <View style={styles.metaSep} />
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>AI</Text>
            <Text style={[styles.metaValue, { color: C.blueLight }]}>VERIFIED</Text>
          </View>
        </View>
      </View>

      <TouchableOpacity style={styles.anotherBtn} onPress={onReset} activeOpacity={0.8}>
        <Text style={styles.anotherBtnText}>+ Report another issue</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── AUTH SCREEN (login / register) ──────────────────────────────────────────
function AuthScreen({ onAuthenticated }) {
  const [mode, setMode]         = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const submit = async () => {
    if (!username.trim() || !password) {
      setError('Enter a username and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const endpoint = mode === 'login' ? '/api/auth/citizen/login' : '/api/auth/citizen/register';
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Something went wrong.');
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(data.citizen));
      onAuthenticated(data.citizen);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.authScreen}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <ScrollView contentContainerStyle={styles.authInner} keyboardShouldPersistTaps="handled">
        <Text style={styles.permEmoji}>📍</Text>
        <Text style={styles.permTitle}>CivicPulse</Text>
        <Text style={styles.permSub}>
          {mode === 'login'
            ? 'Welcome back — log in to report issues and earn points.'
            : 'Create an account to start reporting and earning points.'}
        </Text>

        <View style={styles.authField}>
          <Text style={styles.coordLabel}>USERNAME</Text>
          <TextInput
            style={styles.authInput}
            value={username}
            onChangeText={setUsername}
            placeholder="e.g. jane_civic"
            placeholderTextColor={C.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <View style={styles.authField}>
          <Text style={styles.coordLabel}>PASSWORD</Text>
          <TextInput
            style={styles.authInput}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={C.textMuted}
            secureTextEntry
          />
        </View>

        {error ? <Text style={styles.authError}>{error}</Text> : null}

        <TouchableOpacity style={styles.grantBtn} onPress={submit} disabled={loading} activeOpacity={0.85}>
          {loading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.grantBtnText}>{mode === 'login' ? 'Log in' : 'Create account'}</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
          disabled={loading}
        >
          <Text style={styles.authSwitch}>
            {mode === 'login' ? "New here? Create an account" : 'Already have an account? Log in'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── POINTS / STREAK CHIP ─────────────────────────────────────────────────────
function PointsChip({ citizen, onLogout }) {
  if (!citizen) return null;
  return (
    <TouchableOpacity style={styles.pointsChip} onPress={onLogout} activeOpacity={0.7}>
      <Text style={styles.pointsChipPoints}>⭐ {citizen.points ?? 0}</Text>
      {citizen.streak > 0 && (
        <Text style={styles.pointsChipStreak}>🔥 {citizen.streak}</Text>
      )}
    </TouchableOpacity>
  );
}


function PermissionScreen({ onRequest }) {
  return (
    <SafeAreaView style={styles.permScreen}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={styles.permInner}>
        <Text style={styles.permEmoji}>📍</Text>
        <Text style={styles.permTitle}>CivicPulse</Text>
        <Text style={styles.permSub}>Community infrastructure, held accountable.</Text>
        <View style={styles.permList}>
          {['Camera — photograph the issue', 'Location — GPS-pin it to the map'].map(s => (
            <View key={s} style={styles.permRow}>
              <View style={styles.permDot} />
              <Text style={styles.permRowText}>{s}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={styles.grantBtn} onPress={onRequest} activeOpacity={0.85}>
          <Text style={styles.grantBtnText}>Enable & Continue</Text>
        </TouchableOpacity>
        <Text style={styles.permNote}>
          Photos are sent for AI analysis. We never sell your data.
        </Text>
      </View>
    </SafeAreaView>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function CitizenApp() {
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState('camera'); // camera | preview | result
  const [gpsCoords, setGpsCoords] = useState(null);
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [result, setResult] = useState(null);
  const [gamification, setGamification] = useState(null);
  const cameraRef = useRef(null);

  // ── Citizen session ──────────────────────────────────────────────────────────
  const [citizen, setCitizen] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(SESSION_KEY);
        if (stored) setCitizen(JSON.parse(stored));
      } catch (e) {
        console.warn('Could not load saved session:', e.message);
      } finally {
        setSessionChecked(true);
      }
    })();
  }, []);

  const handleLogout = () => {
    AsyncStorage.removeItem(SESSION_KEY).finally(() => setCitizen(null));
  };

  // Session still loading from storage → blank screen to avoid an auth-screen flash
  if (!sessionChecked) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  // Not logged in → show login/register
  if (!citizen) return <AuthScreen onAuthenticated={setCitizen} />;

  if (!permission) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  if (!permission.granted) return <PermissionScreen onRequest={requestPermission} />;

  // Step 1: Snap + lock GPS → show preview
  const snapAndPreview = async () => {
    if (!cameraRef.current || loading) return;
    setLoading(true);
    setLoadingMsg('Getting GPS fix…');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw new Error('Location permission denied');
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });

      setLoadingMsg('Capturing photo…');
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });

      setGpsCoords(loc.coords);
      setCapturedPhoto(photo.base64);
      setStage('preview');
    } catch (e) {
      alert(`Could not capture: ${e.message}`);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  };

  // Step 2: Re-lock GPS without re-snapping
  const relockGps = async () => {
    setLoading(true);
    setLoadingMsg('Re-locking GPS…');
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setGpsCoords(loc.coords);
    } catch (e) {
      alert(`GPS error: ${e.message}`);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  };

  // Step 3: Send to backend
  const submitReport = async () => {
    setLoading(true);
    setLoadingMsg('Running AI analysis…');
    try {
      const response = await fetch(`${API_BASE}/api/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: capturedPhoto,
          latitude: gpsCoords.latitude,
          longitude: gpsCoords.longitude,
          citizenId: citizen.id,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Server error');
      setResult(data);
      if (data.gamification) {
        setGamification(data.gamification);
        // Keep the local citizen record (and saved session) in sync with the
        // points/streak the server just awarded.
        const updated = {
          ...citizen,
          points: data.gamification.totalPoints,
          streak: data.gamification.streak,
          totalReports: (citizen.totalReports ?? 0) + 1,
        };
        setCitizen(updated);
        AsyncStorage.setItem(SESSION_KEY, JSON.stringify(updated)).catch(() => {});
      }
      setStage('result');
    } catch (e) {
      alert(`Could not file report: ${e.message}`);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  };

  const reset = () => {
    setStage('camera');
    setGpsCoords(null);
    setCapturedPhoto(null);
    setResult(null);
    setGamification(null);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── CAMERA ── */}
      {stage === 'camera' && (
        <View style={{ flex: 1 }}>
          <CameraView style={StyleSheet.absoluteFill} ref={cameraRef} />
          <View style={styles.vignetteBottom} />

          {/* Top bar */}
          <SafeAreaView style={styles.topBar}>
            <Text style={styles.wordmark}>CIVICPULSE</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <PointsChip citizen={citizen} onLogout={handleLogout} />
              <View style={styles.roleChip}>
                <Text style={styles.roleChipText}>CITIZEN</Text>
              </View>
            </View>
          </SafeAreaView>

          {/* Crosshair corners */}
          {[
            { top: 80, left: 24 },
            { top: 80, right: 24 },
            { bottom: 200, left: 24 },
            { bottom: 200, right: 24 },
          ].map((pos, i) => (
            <View key={i} style={[styles.corner,
              pos.top   !== undefined ? { top: pos.top }      : { bottom: pos.bottom },
              pos.left  !== undefined ? { left: pos.left }    : { right: pos.right },
              pos.left  !== undefined ? styles.cornerBL : styles.cornerBR,
              i < 2 ? styles.cornerTop : {},
            ]} pointerEvents="none" />
          ))}

          <View style={styles.bottomControls}>
            <Text style={styles.captureHint}>
              {loading ? loadingMsg : 'Point at the issue and tap'}
            </Text>
            <View style={styles.captureRing}>
              <PulseRing active={!loading} />
              <TouchableOpacity
                style={[styles.captureBtn, loading && { backgroundColor: C.surfaceAlt }]}
                onPress={snapAndPreview}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator size="small" color={C.text} />
                  : <View style={styles.innerDot} />
                }
              </TouchableOpacity>
            </View>
            <Text style={styles.captureSubhint}>GPS + AI-verified report</Text>
          </View>
        </View>
      )}

      {/* ── GPS PREVIEW ── */}
      {stage === 'preview' && gpsCoords && (
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.topBar}>
            <TouchableOpacity onPress={reset}>
              <Text style={[styles.wordmark, { fontSize: 13, color: C.textMuted }]}>← Retake</Text>
            </TouchableOpacity>
            <Text style={styles.wordmark}>CIVICPULSE</Text>
            <View style={{ width: 60 }} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8 }}>
            <LocationPreview
              coords={gpsCoords}
              onConfirm={submitReport}
              onRetry={relockGps}
              loading={loading}
            />
            {loading && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color={C.blue} />
                <Text style={styles.loadingText}>{loadingMsg}</Text>
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      )}

      {/* ── RESULT ── */}
      {stage === 'result' && result && (
        <SafeAreaView style={{ flex: 1 }}>
          <View style={styles.topBar}>
            <Text style={styles.wordmark}>CIVICPULSE</Text>
            <View style={styles.liveChip}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>FILED</Text>
            </View>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
            <ResultCard data={result} coords={gpsCoords} gamification={gamification} onReset={reset} />
          </ScrollView>
        </SafeAreaView>
      )}
    </View>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // Auth (login / register)
  authScreen: { flex: 1, backgroundColor: C.bg },
  authInner:  { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  authField:  { width: '100%', marginBottom: 14 },
  authInput: {
    width: '100%', backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 14, paddingVertical: 12, color: C.text, fontSize: 15, marginTop: 6,
  },
  authError:  { color: C.red, fontSize: 13, marginBottom: 12, textAlign: 'center' },
  authSwitch: { color: C.blueLight, fontSize: 13, fontWeight: '600', marginTop: 18, textAlign: 'center' },

  // Points chip (camera/preview/result top bars)
  pointsChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(0,0,0,0.4)', borderColor: C.border, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  pointsChipPoints: { color: C.amber, fontSize: 12, fontWeight: '700' },
  pointsChipStreak: { color: '#FF6D00', fontSize: 12, fontWeight: '700' },

  // Points-earned banner on the result card
  pointsBanner: {
    backgroundColor: C.amber + '22', borderBottomWidth: 1, borderBottomColor: C.amber,
    paddingVertical: 14, alignItems: 'center',
  },
  pointsBannerMain: { color: C.amber, fontSize: 20, fontWeight: '800', letterSpacing: 0.5 },
  pointsBannerSub:  { color: C.text, fontSize: 12, marginTop: 2, opacity: 0.85 },

  // Permission
  permScreen: { flex: 1, backgroundColor: C.bg },
  permInner:  { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  permEmoji:  { fontSize: 48, marginBottom: 16 },
  permTitle:  { fontSize: 32, fontWeight: '900', color: C.text, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 },
  permSub:    { fontSize: 14, color: C.textMuted, textAlign: 'center', lineHeight: 20, marginBottom: 32 },
  permList:   { width: '100%', marginBottom: 36 },
  permRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  permDot:    { width: 6, height: 6, borderRadius: 3, backgroundColor: C.blue, marginRight: 12 },
  permRowText:{ color: C.text, fontSize: 14 },
  grantBtn:   { width: '100%', backgroundColor: C.blue, paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  grantBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  permNote:   { color: C.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 16 },

  // Top bar
  topBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.border,
    paddingTop: Platform.OS === 'android' ? 44 : 14,
  },
  wordmark: { fontSize: 14, fontWeight: '900', color: C.text, letterSpacing: 3 },
  roleChip: {
    backgroundColor: C.blue + '22', borderColor: C.blue, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
  },
  roleChipText: { color: C.blue, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  liveChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.green + '22', borderColor: C.green, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.green, marginRight: 5 },
  liveText: { color: C.green, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },

  // Camera
  vignetteBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0, height: 200,
    backgroundColor: 'rgba(10,22,40,0.8)',
  },
  corner: { position: 'absolute', width: 24, height: 24, borderColor: 'rgba(69,136,255,0.8)', borderWidth: 0 },
  cornerBL: { borderLeftWidth: 2, borderBottomWidth: 2 },
  cornerBR: { borderRightWidth: 2, borderBottomWidth: 2 },
  cornerTop: { borderBottomWidth: 0, borderTopWidth: 2 },
  bottomControls: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', paddingBottom: 44, paddingTop: 16 },
  captureHint: { color: C.text, fontSize: 13, marginBottom: 20, opacity: 0.85 },
  captureRing: { width: 80, height: 80, justifyContent: 'center', alignItems: 'center' },
  pulseRing: { position: 'absolute', width: 80, height: 80, borderRadius: 40, borderWidth: 2 },
  captureBtn: {
    width: 68, height: 68, borderRadius: 34, backgroundColor: C.blue,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: C.blue, shadowOpacity: 0.5, shadowRadius: 12, elevation: 10,
  },
  innerDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff' },
  captureSubhint: { color: C.textMuted, fontSize: 10, letterSpacing: 1.5, marginTop: 14, textTransform: 'uppercase' },

  // Location preview
  locationPreview: { backgroundColor: C.surface, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  lpHeader: { flexDirection: 'row', alignItems: 'center', padding: 16, backgroundColor: C.surfaceAlt, borderBottomWidth: 1, borderBottomColor: C.border },
  lpDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green, marginRight: 10 },
  lpHeaderText: { fontSize: 11, fontWeight: '700', color: C.green, letterSpacing: 2 },
  miniMap: { height: 180, width: '100%' },
  coordRow: { flexDirection: 'row', padding: 16 },
  coordItem: { flex: 1, alignItems: 'center' },
  coordSep: { width: 1, backgroundColor: C.border, height: '100%' },
  coordLabel: { fontSize: 9, color: C.textMuted, letterSpacing: 1.5, fontWeight: '700', marginBottom: 4 },
  coordValue: { fontSize: 13, color: C.text, fontWeight: '600' },
  lpActions: { flexDirection: 'row', padding: 16, gap: 12 },
  lpRetryBtn: { flex: 1, padding: 14, backgroundColor: C.surfaceAlt, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  lpRetryText: { color: C.textMuted, fontWeight: '600', fontSize: 14 },
  lpConfirmBtn: { flex: 2, padding: 14, backgroundColor: C.blue, borderRadius: 10, alignItems: 'center' },
  lpConfirmText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Loading overlay
  loadingOverlay: { marginTop: 20, alignItems: 'center', gap: 12 },
  loadingText: { color: C.textMuted, fontSize: 13 },

  // Result card
  resultCard: { backgroundColor: C.surface, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  rcHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  rcLabel: { color: 'rgba(255,255,255,0.65)', fontSize: 9, letterSpacing: 2, fontWeight: '700' },
  rcTicket: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: 1 },
  rcIcon: { fontSize: 36 },
  rcBody: { padding: 24 },
  rcCategory: { fontSize: 28, fontWeight: '800', color: C.text, marginBottom: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, marginBottom: 4 },
  badgeDot: { width: 6, height: 6, borderRadius: 3, marginRight: 7 },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 20 },
  rcSectionLabel: { fontSize: 9, fontWeight: '700', color: C.textMuted, letterSpacing: 2, marginBottom: 8 },
  rcDescription: { fontSize: 15, color: C.text, lineHeight: 22 },
  resultMap: { height: 160, borderRadius: 10, overflow: 'hidden', marginTop: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  metaItem: { flex: 1, alignItems: 'center' },
  metaSep: { width: 1, height: 32, backgroundColor: C.border },
  metaLabel: { fontSize: 9, color: C.textMuted, letterSpacing: 1.5, fontWeight: '700', marginBottom: 4 },
  metaValue: { fontSize: 15, fontWeight: '800' },
  anotherBtn: { margin: 20, marginTop: 4, backgroundColor: C.surfaceAlt, borderRadius: 12, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  anotherBtnText: { color: C.blueLight, fontWeight: '700', fontSize: 14, letterSpacing: 0.5 },
});