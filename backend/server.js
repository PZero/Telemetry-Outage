import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { dbService } from './database.js';
import { enqueueRequest, getQueueStatus } from './queue.js';
import { requireGoogleAuth, requireAdmin } from './auth.js';
import { startSync, cancelSync, getSyncStatus } from './sync.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for GitHub Pages and local dev
app.use(cors({
  origin: [
    'https://pzero.github.io',
    'http://localhost:5000',
    'http://localhost:3000'
  ],
  credentials: true
}));

// Request Logger for Diagnostics
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Parse JSON request bodies
app.use(express.json());

// Token cache state
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Helper to fetch Azure AD token using Client Credentials Flow.
 * Caches the token and automatically refreshes it near expiration.
 */
async function getAzureToken() {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const scope = process.env.AZURE_SCOPE;

  if (!tenantId || !clientId || !clientSecret || !scope) {
    throw new Error('Azure AD credentials are not fully configured in backend environment.');
  }

  // Use cached token if valid (with 30-second buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 30000) {
    return cachedToken;
  }

  console.log('[Auth] Fetching new Azure AD Token...');
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const bodyParams = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: scope
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: bodyParams.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure AD Token request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  if (data && data.access_token) {
    cachedToken = data.access_token;
    const expiresIn = data.expires_in || 3599;
    tokenExpiresAt = Date.now() + expiresIn * 1000;
    console.log(`[Auth] Token successfully acquired. Expires in ${expiresIn}s.`);
    return cachedToken;
  } else {
    throw new Error('No access_token found in Azure AD response.');
  }
}

/**
 * Proxy POST request helper to talk to target Azure endpoints.
 */
async function proxyToAzure(endpointPath, clientRequestBody) {
  const apiBaseUrl = process.env.AZURE_API_BASE_URL || 'https://ergapim.azure-api.net/databrowsing/v2';
  const targetUrl = `${apiBaseUrl}${endpointPath}`;
  
  const token = await getAzureToken();

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(clientRequestBody)
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`Azure API error (${response.status}): ${errorDetails}`);
  }

  return await response.json();
}

// ==========================================
// API ENDPOINTS
// ==========================================

/**
 * Health Check endpoint
 */
app.get('/api/health', async (req, res) => {
  let dbStatus = 'Disconnected';
  let dbError = null;
  let stats = null;
  let debugBulkErrors = {};
  
  try {
    stats = await dbService.getStats();
    dbStatus = 'Connected';
  } catch (err) {
    dbError = err.message;
  }

  // Debug SQL queries
  try {
    await dbService.getOutagesBulk();
  } catch (err) {
    debugBulkErrors.outages = err.message;
  }
  try {
    await dbService.getObservationsBulk('2026-06-09', '2026-07-09');
  } catch (err) {
    debugBulkErrors.observations = err.message;
  }

  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    apiConfigured: !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET),
    database: dbStatus,
    dbError,
    stats,
    debugBulkErrors
  });
});
app.get('/api/auth/google/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null
  });
});

// Secure all subsequent API endpoints
app.use('/api', requireGoogleAuth);

/**
 * User Profile Endpoint
 */
app.get('/api/auth/profile', (req, res) => {
  res.json(req.user);
});

/**
 * Proxy for Daily Observations (SCADA/Meter telemetry)
 */
app.post('/api/observation', async (req, res) => {
  try {
    const { upId, date, type } = req.body;
    if (!upId || !date || !type) {
      console.log(`[Proxy Direct] Forwarding /api/observation request (no upId/date/type)`);
      const data = await proxyToAzure('/api/observation', req.body);
      return res.json(data);
    }
    
    // 1. Check SQLite cache first
    const cached = await dbService.getObservations(upId, date, type);
    if (cached) {
      return res.json(cached);
    }

    // 2. Enqueue cache-miss to prevent concurrent duplicate calls and rate-limiting
    const data = await enqueueRequest('/api/observation', req.body, async () => {
      const fetched = await proxyToAzure('/api/observation', req.body);
      // Cache fetched raw data to SQLite
      await dbService.saveObservations(upId, date, type, fetched);
      return fetched;
    });
    
    res.json(data);
  } catch (error) {
    console.error(`[Error] Observation proxy failed:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Proxy for Outages (Manutenzioni/Indisponibilità)
 */
app.post('/api/outage', async (req, res) => {
  try {
    const { upId, startDate, endDate } = req.body;
    if (!upId || !startDate || !endDate) {
      console.log(`[Proxy Direct] Forwarding /api/outage request (no upId/startDate/endDate)`);
      const data = await proxyToAzure('/api/outage', req.body);
      return res.json(data);
    }

    const data = await enqueueRequest('/api/outage', req.body, async () => {
      return await proxyToAzure('/api/outage', req.body);
    });
    res.json(data);
  } catch (error) {
    console.error(`[Error] Outage proxy failed:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Queue status query endpoint
 */
app.get('/api/queue/status', (req, res) => {
  try {
    const { upId, date, type, startDate, endDate } = req.query;
    const status = getQueueStatus(upId, date, type, startDate, endDate);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// DATABASE ENDPOINTS (CENTRALIZED STORE)
// ==========================================

/**
 * Observations Storage Endpoints
 */
app.get('/api/db/observations/bulk', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required parameters startDate or endDate.' });
    }
    const data = await dbService.getObservationsBulk(startDate, endDate);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/db/observations', async (req, res) => {
  try {
    const { upId, date, type } = req.query;
    if (!upId || !date || !type) {
      return res.status(400).json({ error: 'Missing required parameters upId, date, or type.' });
    }
    const values = await dbService.getObservations(upId, date, type);
    res.json({ values });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/db/observations', async (req, res) => {
  try {
    const { upId, date, type, values } = req.body;
    if (!upId || !date || !type || !values) {
      return res.status(400).json({ error: 'Missing required body fields upId, date, type, or values.' });
    }
    await dbService.saveObservations(upId, date, type, values);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Outages Storage Endpoints
 */
app.get('/api/db/outages/bulk', async (req, res) => {
  try {
    const outages = await dbService.getOutagesBulk();
    res.json({ outages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/db/outages', async (req, res) => {
  try {
    const { upId } = req.query;
    if (!upId) {
      return res.status(400).json({ error: 'Missing required parameter upId.' });
    }
    const outages = await dbService.getOutages(upId);
    res.json({ outages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/db/outages', async (req, res) => {
  try {
    const { outages } = req.body;
    if (!Array.isArray(outages)) {
      return res.status(400).json({ error: 'Body field outages must be an array.' });
    }
    await dbService.saveOutages(outages);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Database Administration Endpoints
 */
app.post('/api/db/clear', requireAdmin, async (req, res) => {
  try {
    await dbService.clearDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/db/retention', requireAdmin, async (req, res) => {
  try {
    const { limitDate } = req.body;
    if (!limitDate) {
      return res.status(400).json({ error: 'Missing required body field limitDate.' });
    }
    const results = await dbService.deleteOlderThan(limitDate);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/db/stats', async (req, res) => {
  try {
    const stats = await dbService.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Background Sync Queue Endpoints
 */
app.post('/api/sync/start', requireAdmin, async (req, res) => {
  try {
    const { rangeDays, isSelective, upId, simMode } = req.body;
    await startSync({ rangeDays: parseInt(rangeDays) || 30, isSelective: !!isSelective, upId: upId || 'all', simMode: !!simMode }, proxyToAzure);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync/cancel', requireAdmin, (req, res) => {
  cancelSync();
  res.json({ success: true });
});

app.get('/api/sync/status', requireGoogleAuth, (req, res) => {
  res.json(getSyncStatus());
});

/**
 * Registry (UP Fleet) Endpoints
 */
app.get('/api/registry', async (req, res) => {
  try {
    const registry = await dbService.getRegistry();
    // Map database fields to frontend structure (e.g. scada_disabled 1/0 to true/false)
    const formatted = registry.map(up => ({
      id: up.id,
      name: up.name,
      tech: up.tech,
      region: up.region,
      capacity: up.capacity,
      lat: up.lat,
      lon: up.lon,
      ppa_partner: up.ppa_partner,
      scada_disabled: up.scada_disabled === 1
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/registry', requireAdmin, async (req, res) => {
  try {
    const upList = req.body;
    if (!Array.isArray(upList)) {
      return res.status(400).json({ error: 'Registry payload must be an array of production units.' });
    }
    await dbService.saveRegistry(upList);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/registry/reset', requireAdmin, async (req, res) => {
  try {
    await dbService.resetRegistry();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/registry/update', async (req, res) => {
  try {
    const { upId, ppaPartner, scadaDisabled } = req.body;
    if (!upId) {
      return res.status(400).json({ error: 'Missing required field upId.' });
    }
    await dbService.updateUPPpaAndScada(upId, ppaPartner, scadaDisabled);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PPA Tags Endpoints
 */
app.get('/api/ppa/tags', async (req, res) => {
  try {
    const tags = await dbService.getPpaTags();
    res.json(tags);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ppa/tags', requireAdmin, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !color) {
      return res.status(400).json({ error: 'Missing name or color fields.' });
    }
    await dbService.savePpaTag(name, color);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ppa/tags', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Missing name in request body.' });
    }
    await dbService.deletePpaTag(name);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * User Management Endpoints (Admin only)
 */
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await dbService.getAllUsers();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/role', requireAdmin, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'Missing required parameters email or role.' });
    }
    if (email === 'fnicora@gmail.com') {
      return res.status(400).json({ error: 'Non è consentito modificare il ruolo dell\'utente proprietario.' });
    }
    await dbService.updateUserRole(email, role);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Telemetry Dashboard Backend running on port ${PORT}`);
  console.log(` Database: SQLite Centralized Store enabled`);
  console.log(`==================================================`);
});
