import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

dotenv.config();

const firebaseConfigPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf-8')) as {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
};

const PORT = Number(process.env.PORT || 3000);
const PROJECT_ID = firebaseConfig.projectId;
const DATABASE_ID = firebaseConfig.firestoreDatabaseId || '(default)';
const API_KEY = firebaseConfig.apiKey;
const BOOTSTRAP_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'krishnasharma011981@gmail.com').toLowerCase();
// SHA-256 digest of initial bootstrap password or runtime env override (never exposed in frontend bundle)
const BOOTSTRAP_PASSWORD_SHA256 = process.env.SUPER_ADMIN_BOOTSTRAP_PASSWORD
  ? crypto.createHash('sha256').update(process.env.SUPER_ADMIN_BOOTSTRAP_PASSWORD).digest('hex')
  : '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92';

const HMAC_SECRET =
  process.env.SECURITY_HMAC_SECRET ||
  crypto.createHash('sha256').update(`${PROJECT_ID}:${DATABASE_ID}:vision-point-super-excel`).digest('hex');

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

interface ChallengeRecord {
  nonce: string;
  uid: string;
  centreId: string;
  expiresAt: number;
  used: boolean;
}

interface VerifiedProofRecord {
  verificationId: string;
  uid: string;
  centreId: string;
  expiresAt: number;
  overrideApplied: boolean;
}

const activeChallenges = new Map<string, ChallengeRecord>();
const verifiedProofs = new Map<string, VerifiedProofRecord>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of activeChallenges.entries()) {
    if (v.expiresAt < now) activeChallenges.delete(k);
  }
  for (const [k, v] of verifiedProofs.entries()) {
    if (v.expiresAt < now) verifiedProofs.delete(k);
  }
}, 60_000).unref();

interface AuthenticatedRequest extends Request {
  auth?: {
    uid: string;
    email: string;
    emailVerified: boolean;
    rawToken: string;
  };
}

function signToken(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySignedToken<T>(token: string): T | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as T;
  } catch {
    return null;
  }
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
}

function decodeFirestoreFields(fields?: Record<string, FirestoreValue>): Record<string, unknown> {
  if (!fields) return {};
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = Number(val.integerValue);
    else if (val.doubleValue !== undefined) result[key] = Number(val.doubleValue);
    else if (val.booleanValue !== undefined) result[key] = Boolean(val.booleanValue);
    else if (val.timestampValue !== undefined) result[key] = val.timestampValue;
  }
  return result;
}

async function fetchFirestoreDoc(docPath: string, idToken: string): Promise<Record<string, unknown> | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${docPath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore read failed (${res.status}): ${errText}`);
  }
  const data = (await res.json()) as { fields?: Record<string, FirestoreValue> };
  return decodeFirestoreFields(data.fields);
}

async function createFirestoreDoc(
  collectionPath: string,
  docId: string,
  fields: Record<string, FirestoreValue>,
  idToken: string,
): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore write failed (${res.status}): ${errText}`);
  }
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization Bearer token.' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID,
    });
    const uid = String(payload.sub || '');
    const email = String(payload.email || '').toLowerCase();
    const emailVerified = Boolean(payload.email_verified);
    if (!uid) {
      res.status(401).json({ error: 'Invalid Firebase ID token.' });
      return;
    }
    req.auth = { uid, email, emailVerified, rawToken: token };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication verification failed.', detail: (err as Error).message });
  }
}

const DEFAULT_CENTRE_COORDS: Record<string, { latitude: number; longitude: number; geofenceRadiusMeters: number; name: string }> = {
  vp_lookerganj: { latitude: 25.4358, longitude: 81.8256, geofenceRadiusMeters: 300, name: 'Vision Point Lookerganj, Prayagraj' },
  vp_civillines: { latitude: 25.4530, longitude: 81.8358, geofenceRadiusMeters: 300, name: 'Vision Point Civil Lines, Prayagraj' },
  xis_varanasi: { latitude: 25.3176, longitude: 82.9739, geofenceRadiusMeters: 300, name: 'Axis Academy, Varanasi' },
  xis_jaunpur: { latitude: 25.7464, longitude: 82.6837, geofenceRadiusMeters: 300, name: 'Axis Academy, Jaunpur' },
};

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'vision-point-super-excel', projectId: PROJECT_ID });
  });

  // Server-side bootstrap check for initial Super Admin login
  app.post('/api/auth/prepare-super-admin', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (email !== BOOTSTRAP_ADMIN_EMAIL || !password) {
      res.json({ ready: true });
      return;
    }

    const candidateHash = crypto.createHash('sha256').update(password).digest('hex');
    if (candidateHash !== BOOTSTRAP_PASSWORD_SHA256) {
      res.json({ ready: true });
      return;
    }

    // Attempt signUp in Firebase Auth if the owner's email/password user hasn't been created yet
    try {
      const signUpRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            displayName: 'Ashish Pandey',
            returnSecureToken: true,
          }),
        },
      );
      const data = (await signUpRes.json()) as {
        idToken?: string;
        error?: { message?: string };
      };

      if (signUpRes.ok && data.idToken) {
        await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(API_KEY)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestType: 'VERIFY_EMAIL',
              idToken: data.idToken,
            }),
          },
        ).catch(() => {});
        res.json({ ready: true, provisioned: true });
        return;
      }

      if (data.error?.message === 'OPERATION_NOT_ALLOWED') {
        res.json({ ready: false, providerDisabled: true });
        return;
      }

      res.json({ ready: true });
    } catch {
      res.json({ ready: true });
    }
  });

  // Verify whether current user matches authorized bootstrap owner email
  app.post('/api/setup/verify-owner', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authInfo = req.auth!;
    if (!authInfo.emailVerified) {
      res.status(403).json({
        allowed: false,
        error: 'Email verification is required before initializing the Super Admin account.',
      });
      return;
    }
    const requestedEmail = String(req.body?.authorizedEmail || '').trim().toLowerCase();
    const isBootstrapOwner = authInfo.email === BOOTSTRAP_ADMIN_EMAIL;
    if (!isBootstrapOwner && requestedEmail !== BOOTSTRAP_ADMIN_EMAIL) {
      res.status(403).json({
        allowed: false,
        error: `Unauthorized Super Admin setup attempt. Only the designated owner (${BOOTSTRAP_ADMIN_EMAIL}) can initialize the root Super Admin account.`,
      });
      return;
    }
    res.json({
      allowed: true,
      uid: authInfo.uid,
      email: authInfo.email,
      bootstrapCentreId: 'vp_lookerganj',
    });
  });

  // Issue single-use anti-replay location challenge nonce
  app.post('/api/security/location-challenge', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authInfo = req.auth!;
    const centreId = String(req.body?.centreId || 'vp_lookerganj');
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 90_000;
    activeChallenges.set(nonce, {
      nonce,
      uid: authInfo.uid,
      centreId,
      expiresAt,
      used: false,
    });
    const challengeToken = signToken({ nonce, uid: authInfo.uid, centreId, expiresAt });
    res.json({ challengeToken, nonce, expiresAt });
  });

  // Server-side geofence & anti-replay verification
  app.post('/api/security/verify-location', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authInfo = req.auth!;
    const {
      challengeToken,
      latitude,
      longitude,
      accuracy,
      clientTimestamp,
      operation,
      targetCentreId,
    } = req.body || {};

    const parsed = verifySignedToken<{ nonce: string; uid: string; centreId: string; expiresAt: number }>(
      String(challengeToken || ''),
    );
    if (!parsed || parsed.uid !== authInfo.uid || parsed.expiresAt < Date.now()) {
      res.status(403).json({
        allowed: false,
        error: 'Security challenge expired or invalid. Please retry the operation.',
      });
      return;
    }

    const challengeRecord = activeChallenges.get(parsed.nonce);
    if (!challengeRecord || challengeRecord.used || challengeRecord.uid !== authInfo.uid) {
      res.status(403).json({
        allowed: false,
        error: 'Replay attempt detected: location challenge has already been consumed.',
      });
      return;
    }
    challengeRecord.used = true;

    let userDoc: Record<string, unknown> | null = null;
    let settingsDoc: Record<string, unknown> | null = null;
    try {
      userDoc = await fetchFirestoreDoc(`users/${authInfo.uid}`, authInfo.rawToken);
      settingsDoc = await fetchFirestoreDoc('system_settings/global', authInfo.rawToken);
    } catch (err) {
      res.status(403).json({
        allowed: false,
        error: `Authorization verification failed: ${(err as Error).message}`,
      });
      return;
    }

    const isBootstrapAdmin = authInfo.emailVerified && authInfo.email === BOOTSTRAP_ADMIN_EMAIL;
    const role = isBootstrapAdmin && !userDoc ? 'super_admin' : String(userDoc?.role || '');
    const status = isBootstrapAdmin && !userDoc ? 'Active' : String(userDoc?.status || 'Inactive');
    const assignedCentreId = String(userDoc?.centreId || targetCentreId || 'vp_lookerganj');

    if (status !== 'Active') {
      res.status(403).json({
        allowed: false,
        error: 'ACCESS DENIED: Your account is currently inactive.',
      });
      return;
    }

    if (!authInfo.emailVerified) {
      res.status(403).json({
        allowed: false,
        error: 'ACCESS DENIED: Email verification is required before modifying records.',
      });
      return;
    }

    const latNum = Number(latitude);
    const lngNum = Number(longitude);
    const accNum = Number(accuracy);
    const tsNum = Number(clientTimestamp || Date.now());

    const centreConfig =
      (await fetchFirestoreDoc(`centres/${assignedCentreId}`, authInfo.rawToken).catch(() => null)) ||
      DEFAULT_CENTRE_COORDS[assignedCentreId] ||
      DEFAULT_CENTRE_COORDS.vp_lookerganj;

    const centreLat = Number(centreConfig.latitude ?? 25.4358);
    const centreLng = Number(centreConfig.longitude ?? 81.8256);
    const radiusMeters = Number(centreConfig.geofenceRadiusMeters ?? 300);
    const maxAccuracyMeters = Number(settingsDoc?.maxGpsAccuracyMeters ?? 500);
    const geofenceEnabled = settingsDoc?.geofenceEnabled !== false;
    const emergencyOverrideActive = settingsDoc?.emergencyOverrideActive === true;

    const hasValidCoords =
      Number.isFinite(latNum) &&
      Number.isFinite(lngNum) &&
      latNum >= -90 &&
      latNum <= 90 &&
      lngNum >= -180 &&
      lngNum <= 180;

    const distanceMeters = hasValidCoords ? haversineMeters(latNum, lngNum, centreLat, centreLng) : 999999;

    if (role === 'super_admin' || !geofenceEnabled || emergencyOverrideActive) {
      const verificationId = `loc_${crypto.randomBytes(8).toString('hex')}`;
      const overrideApplied = role !== 'super_admin' ? emergencyOverrideActive : distanceMeters > radiusMeters;
      verifiedProofs.set(verificationId, {
        verificationId,
        uid: authInfo.uid,
        centreId: assignedCentreId,
        expiresAt: Date.now() + 300_000,
        overrideApplied,
      });

      await createFirestoreDoc(
        'location_verifications',
        verificationId,
        {
          uid: { stringValue: authInfo.uid },
          userEmail: { stringValue: authInfo.email },
          role: { stringValue: role === 'super_admin' || role === 'centre_head' ? role : 'employee' },
          centreId: { stringValue: assignedCentreId },
          latitude: { doubleValue: hasValidCoords ? latNum : centreLat },
          longitude: { doubleValue: hasValidCoords ? lngNum : centreLng },
          accuracyMeters: { doubleValue: Number.isFinite(accNum) ? accNum : 0 },
          distanceMeters: { integerValue: String(distanceMeters) },
          radiusMeters: { integerValue: String(radiusMeters) },
          verified: { booleanValue: true },
          overrideApplied: { booleanValue: overrideApplied },
          operation: { stringValue: String(operation || 'restricted_mutation').slice(0, 120) },
          nonce: { stringValue: parsed.nonce },
          createdAt: { timestampValue: new Date().toISOString() },
        },
        authInfo.rawToken,
      ).catch(() => {});

      res.json({
        allowed: true,
        verificationId,
        distanceMeters,
        radiusMeters,
        overrideApplied,
        locationProofToken: signToken({ verificationId, uid: authInfo.uid, centreId: assignedCentreId }),
      });
      return;
    }

    if (!hasValidCoords) {
      res.status(403).json({
        allowed: false,
        error: 'ACCESS DENIED: Valid GPS coordinates are required from your browser to verify physical presence at your assigned centre.',
      });
      return;
    }

    if (Math.abs(Date.now() - tsNum) > 120_000) {
      res.status(403).json({
        allowed: false,
        error: 'ACCESS DENIED: GPS timestamp is stale or skewed. Please refresh location permissions and try again.',
      });
      return;
    }

    if (!Number.isFinite(accNum) || accNum <= 0 || accNum > maxAccuracyMeters) {
      res.status(403).json({
        allowed: false,
        error: `ACCESS DENIED: GPS accuracy (${Math.round(accNum || 0)}m) exceeds the maximum allowed threshold (${maxAccuracyMeters}m). Enable high-accuracy location.`,
      });
      return;
    }

    const verificationId = `loc_${crypto.randomBytes(8).toString('hex')}`;
    const withinFence = distanceMeters <= radiusMeters;

    await createFirestoreDoc(
      'location_verifications',
      verificationId,
      {
        uid: { stringValue: authInfo.uid },
        userEmail: { stringValue: authInfo.email },
        role: { stringValue: role === 'centre_head' ? 'centre_head' : 'employee' },
        centreId: { stringValue: assignedCentreId },
        latitude: { doubleValue: latNum },
        longitude: { doubleValue: lngNum },
        accuracyMeters: { doubleValue: accNum },
        distanceMeters: { integerValue: String(distanceMeters) },
        radiusMeters: { integerValue: String(radiusMeters) },
        verified: { booleanValue: withinFence },
        overrideApplied: { booleanValue: false },
        operation: { stringValue: String(operation || 'restricted_mutation').slice(0, 120) },
        nonce: { stringValue: parsed.nonce },
        createdAt: { timestampValue: new Date().toISOString() },
      },
      authInfo.rawToken,
    ).catch(() => {});

    if (!withinFence) {
      res.status(403).json({
        allowed: false,
        verificationId,
        distanceMeters,
        radiusMeters,
        error: 'ACCESS DENIED: You must be physically present at your assigned centre to perform this operation.',
      });
      return;
    }

    verifiedProofs.set(verificationId, {
      verificationId,
      uid: authInfo.uid,
      centreId: assignedCentreId,
      expiresAt: Date.now() + 300_000,
      overrideApplied: false,
    });

    res.json({
      allowed: true,
      verificationId,
      distanceMeters,
      radiusMeters,
      overrideApplied: false,
      locationProofToken: signToken({ verificationId, uid: authInfo.uid, centreId: assignedCentreId }),
    });
  });

  // Server-validated user provisioning without signing out the active administrator
  app.post('/api/users/provision', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authInfo = req.auth!;
    if (!authInfo.emailVerified) {
      res.status(403).json({ error: 'Verified email required to provision accounts.' });
      return;
    }

    const { email, password, fullName, role, centreId, department } = req.body || {};
    if (!email || !password || String(password).length < 6 || !fullName || !role || !centreId || !department) {
      res.status(400).json({ error: 'All fields are required and password must be at least 6 characters.' });
      return;
    }

    const callerDoc = await fetchFirestoreDoc(`users/${authInfo.uid}`, authInfo.rawToken).catch(() => null);
    const isBootstrapAdmin = authInfo.email === BOOTSTRAP_ADMIN_EMAIL;
    const callerRole = isBootstrapAdmin && !callerDoc ? 'super_admin' : String(callerDoc?.role || '');
    const callerCentre = String(callerDoc?.centreId || '');
    const callerStatus = isBootstrapAdmin && !callerDoc ? 'Active' : String(callerDoc?.status || 'Inactive');

    if (callerStatus !== 'Active') {
      res.status(403).json({ error: 'Inactive administrator account cannot provision users.' });
      return;
    }

    if (callerRole === 'employee' || !callerRole) {
      res.status(403).json({ error: 'Department employees cannot create user accounts.' });
      return;
    }

    if (callerRole === 'centre_head') {
      if (role !== 'employee' || centreId !== callerCentre || department === 'all') {
        res.status(403).json({
          error: 'Centre Heads can only create department employees within their assigned centre.',
        });
        return;
      }
    }

    if (role === 'super_admin' && callerRole !== 'super_admin') {
      res.status(403).json({ error: 'Only Super Admin can create privileged accounts.' });
      return;
    }

    const signUpRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(email).trim(),
          password: String(password),
          displayName: String(fullName).trim(),
          returnSecureToken: true,
        }),
      },
    );

    const signUpData = (await signUpRes.json()) as {
      localId?: string;
      idToken?: string;
      email?: string;
      error?: { message?: string };
    };

    if (!signUpRes.ok || !signUpData.localId) {
      const msg = signUpData.error?.message || 'Failed to provision authentication user.';
      if (msg === 'OPERATION_NOT_ALLOWED') {
        res.status(409).json({
          providerDisabled: true,
          code: 'OPERATION_NOT_ALLOWED',
          error: 'Email/Password sign-in is disabled in Firebase Console.',
        });
        return;
      }
      res.status(400).json({ error: msg });
      return;
    }

    let verificationSent = false;
    if (signUpData.idToken) {
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestType: 'VERIFY_EMAIL',
            idToken: signUpData.idToken,
          }),
        },
      );
      verificationSent = verifyRes.ok;
    }

    res.json({
      uid: signUpData.localId,
      email: signUpData.email || String(email).trim(),
      verificationSent,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VISION POINT SUPER EXCEL server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
