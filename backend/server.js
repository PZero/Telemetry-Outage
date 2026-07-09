import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());

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
    // Calculate absolute expiration timestamp
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
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    apiConfigured: !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET)
  });
});

/**
 * Proxy for Daily Observations (SCADA/Meter telemetry)
 */
app.post('/api/observation', async (req, res) => {
  try {
    console.log(`[Proxy] Forwarding /api/observation request for: ${req.body.upname || 'unknown'}`);
    const data = await proxyToAzure('/api/observation', req.body);
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
    console.log(`[Proxy] Forwarding /api/outage request for: ${req.body.upname || 'unknown'}`);
    const data = await proxyToAzure('/api/outage', req.body);
    res.json(data);
  } catch (error) {
    console.error(`[Error] Outage proxy failed:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Telemetry Dashboard Backend running on port ${PORT}`);
  console.log(` Mode: proxying queries to Azure API Gateway`);
  console.log(`==================================================`);
});
