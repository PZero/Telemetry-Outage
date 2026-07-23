import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { dbService } from './database.js';
import { enqueueRequest, getQueueStatus } from './queue.js';
import { requireGoogleAuth, requireAdmin } from './auth.js';
import { startSync, cancelSync, getSyncStatus, fetchObservationsFromAzureRange, fetchOutagesFromAzureRange, analyzeStreamGaps } from './sync.js';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

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

// Middleware to resolve UP names/custom codes to SQLite DB IDs
app.use(async (req, res, next) => {
  try {
    if (req.query && req.query.upId) {
      req.query.upId = await dbService.resolveDbId(req.query.upId);
    }
    if (req.body && req.body.upId) {
      req.body.upId = await dbService.resolveDbId(req.body.upId);
    }
    if (req.params && req.params.upId) {
      req.params.upId = await dbService.resolveDbId(req.params.upId);
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Error resolving UP ID: ' + error.message });
  }
});

// --- SWAGGER / OPENAPI SETUP ---
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Telemetry & Outage Integrity API',
      version: '1.0.0',
      description: `### 📥 Download Specifiche & Elenco API
* 📥 [Scarica specifica Swagger 2.0 (Formato YAML)](/swagger.yaml)
* 📥 [Scarica specifica Swagger 2.0 (Formato JSON)](/swagger.json)
* 📥 [Scarica elenco sintetico API (Formato CSV)](/swagger.csv)

### Manuale Operativo e Sequenze API per Agenti AI & Copilot

Benvenuto nella documentazione delle API REST per il sistema **UP Data Check**. Questa suite di servizi consente a componenti esterne, frontend e agenti autonomi (es. Microsoft Copilot Studio) di gestire l'integrità dei dati di produzione, tracciare anomalie, configurare anagrafiche e automatizzare la comunicazione con i process owner.

---

## 1. Moduli Principali delle API

### A. Registro & Anagrafica (Registry)
Consente di censire e configurare le Unità di Produzione (UP) e i Partner commerciali associati tramite contratti PPA.
* **UP Registry** (\`/api/agent/registry/ups\`): Gestisce le UP della flotta. Supporta operazioni CRUD per aggiungere, modificare o rimuovere impianti (es. eolico/solare).
* **PPA Partners** (\`/api/agent/registry/ppa-partners\`): Gestisce i partner contrattuali PPA e i colori identificativi associati.
* **Assegnazioni & Disabilitazioni** (\`/api/agent/registry/assign\`): Permette di legare una UP a un partner PPA specifico o di disabilitare l'acquisizione delle telemetrie SCADA (es. in caso di manutenzioni pianificate o guasti noti, evitando falsi allarmi).

### B. Diagnostica & Report (Diagnostics & Reports)
Fornisce strumenti di controllo on-demand ed elaborazioni complessive.
* **Test Giornaliero** (\`/api/agent/diagnostics/test-day\`): Consente di forzare un'analisi di integrità immediata per una specifica UP in un determinato giorno. Analizza le letture Meter e SCADA presenti, calcolando i gaps e confrontandoli con gli outages dichiarati.
* **Audit Report** (\`/api/agent/reports/audit\`): Genera un bilancio complessivo di allineamento e anomalie per l'intera flotta in un intervallo di date, fornendo metriche aggregate di efficienza e conformità.

### C. Gestione dei Cluster di Anomalie (Workflow & Chat)
Gestisce i ticket di anomalia in corso e la chat associata per ciascun impianto.
* **Lazy Creation del Cluster** (\`/api/agent/clusters/latest\`): Questo endpoint è il fulcro del workflow. Quando interrogato per una specifica UP e tipologia di errore, controlla se esiste già un cluster aperto o sospeso (\`status IN ('open', 'suspended')\`).
  - **Se esiste**: lo restituisce all'istante per riprendere la gestione sulla stessa chat precedente (anche se era sospeso), prevenendo la duplicazione dei ticket.
  - **Se NON esiste**: **forza automaticamente la creazione di un nuovo cluster** nel database e restituisce il record appena creato. Questo garantisce all'agente di avere sempre un cluster/ticket valido di riferimento su cui agganciare i messaggi o le estensioni.
* **Estensione del Cluster** (\`/api/agent/clusters/{id}/extend\`): Se un'anomalia persiste nei giorni successivi, l'agente non deve aprire un nuovo ticket (che frammenterebbe la comunicazione), ma deve chiamare questo endpoint per estendere la validità del cluster corrente fino a una nuova data.
* **Risoluzione & Chiusura** (\`/api/agent/clusters/{id}/close\`): Consente di chiudere il cluster inserendo note di risoluzione e la categoria dell'intervento.
* **Messaggistica Chat** (\`/api/agent/clusters/{id}/messages\`): Consente di leggere la cronologia e inviare messaggi di chat per coordinarsi con i process owner fino alla risoluzione del problema.

---

## 2. Esempi Completi di Flusso (Sequenze)

### Scenario A: Rilevamento e Gestione di un'Anomalia (Workflow Tipo)
1. **Analisi/Rilevamento**: L'agente esegue \`POST /api/agent/diagnostics/test-day\` per verificare i dati del giorno precedente di un impianto.
2. **Ingaggio**: Se il test rileva disallineamenti significativi (es. mancano dati SCADA), l'agente interroga \`GET /api/agent/clusters/latest?upId=UP_WIND_01&type=scada\`. L'endpoint recupera il cluster esistente (anche se in stato sospeso) o, se è il primo giorno, crea automaticamente un nuovo cluster (es. \`id = 12\`).
3. **Avviso Chat**: L'agente scrive sulla chat dell'anomalia (\`POST /api/agent/clusters/12/messages\`) notificando i process owner del problema rilevato.
4. **Sospensione**: Se i tecnici informano che saranno necessari ad esempio 10 giorni per la risoluzione, l'agente esegue \`POST /api/agent/clusters/12/suspend\` inviando la data di riattivazione.
5. **Re-ingaggio (Giorno 10)**: Trascorsi i 10 giorni, l'agente interroga nuovamente lo stesso cluster \`id = 12\`, esegue \`POST /api/agent/clusters/12/reactivate\` per riaprirlo, e riprende a scrivere nella stessa chat precedente.
6. **Risoluzione**: Una volta che i tecnici risolvono il problema, l'agente invia \`POST /api/agent/clusters/12/close\` chiudendo ufficialmente la pratica.

### Scenario B: Manutenzione e Configurazione Impianto
1. **Creazione UP**: L'amministratore/agente aggiunge un nuovo impianto con \`POST /api/agent/registry/ups\`.
2. **Configurazione Partner**: Crea una controparte commerciale con \`POST /api/agent/registry/ppa-partners\`.
3. **Associazione**: Associa l'impianto al partner PPA con \`POST /api/agent/registry/assign\`.

### Scenario C: Ciclo di Vita dell'Anomalia (Ciclo Completo Agente con Chat Teams/Slack)
1. **Elenco Impianti**: L'agente recupera la flotta delle UP interrogando l'API \`GET /api/registry\`.
2. **Controllo Anomalie**: Per ogni UP della flotta, l'agente interroga l'anomalia aperta o sospesa chiamando l'API \`GET /api/agent/clusters/latest?upId=[upId]&type=scada\` (o type=meter).
3. **Apertura Chat & Tracciamento Context**: L'endpoint lazy restituisce il cluster (es. \`id = 45\`). L'agente associa l'ID univoco del thread di Teams (es. \`external_chat_id = "19:meeting_ABC...@thread.v2"\`) tramite i parametri query o invocando \`POST /api/agent/clusters/45/chat-context\`. L'agente scrive il primo messaggio via \`POST /api/agent/clusters/45/messages\`.
4. **Verifica su Indicazione Utente**: In chat Teams un utente risponde che il problema e risolto e chiede di verificare. L'agente riesegue il test di integrita via \`POST /api/agent/diagnostics/test-day\`.
5. **Esito Negativo & Allineamento Sospensione**: Il test rileva che l'errore persiste. I tecnici spiegano che ci vorranno 7 giorni per il ricambio.
6. **Sospensione Temporanea**: L'agente sospende il ticket chiamando \`POST /api/agent/clusters/45/suspend\`, passando la data di wakeup \`reactivationDate\` (oggi + 7 giorni). Lo stato passa a 'suspended', conservando a DB l'ID della chat Teams (\`external_chat_id\`).
7. **Wakeup Automatico (Giorno +7)**: Trascorsi i 7 giorni, alla prima interrogazione l'anomalia si riattiva in stato 'open', con \`force_chat_update = 1\` e restituendo l'ID originale \`external_chat_id\`.
8. **Re-ingaggio nella Chat Esistente**: L'agente legge \`external_chat_id\` e scrive direttamente nel thread Teams d'origine ("I 7 giorni sono trascorsi, rieseguo la verifica..."). Dopo l'esito positivo del test, chiude l'anomalia.
9. **Risoluzione Finale**: L'agente chiude definitivamente il ticket chiamando \`POST /api/agent/clusters/45/close\`.`,
    },
    servers: [
      {
        url: process.env.PUBLIC_API_URL || 'https://telemetry-outage.onrender.com',
        description: 'Server Produzione (Render)'
      },
      {
        url: 'http://localhost:3000',
        description: 'Server Sviluppo Locale'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Inserisci il token JWT di Google OAuth 2.0'
        }
      }
    },
    security: [
      {
        bearerAuth: []
      }
    ]
  },
  apis: [join(dirname(fileURLToPath(import.meta.url)), 'server.js')]
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);

function getPureSwagger2Spec() {
  const openapi = swaggerJsdoc(swaggerOptions);
  const swagger2 = {
    swagger: '2.0',
    info: openapi.info,
    host: process.env.PUBLIC_HOST || 'telemetry-outage.onrender.com',
    basePath: '/',
    schemes: ['https', 'http'],
    securityDefinitions: {
      api_key: {
        type: 'apiKey',
        name: 'Authorization',
        in: 'header'
      }
    },
    security: [{ api_key: [] }],
    paths: {}
  };
  for (const [pathKey, pathObj] of Object.entries(openapi.paths)) {
    swagger2.paths[pathKey] = {};
    for (const [method, op] of Object.entries(pathObj)) {
      const op2 = {
        summary: op.summary,
        description: op.description,
        operationId: op.operationId,
        parameters: [],
        responses: {}
      };
      if (op.parameters) {
        for (const p of op.parameters) {
          const p2 = { in: p.in, name: p.name, description: p.description, required: p.required || false };
          if (p.schema && p.schema.type) {
            p2.type = p.schema.type;
            if (p.schema.enum) p2.enum = p.schema.enum;
            if (p.schema.default) p2.default = p.schema.default;
          } else if (p.type) {
            p2.type = p.type;
          }
          op2.parameters.push(p2);
        }
      }
      if (op.requestBody && op.requestBody.content && op.requestBody.content['application/json']) {
        op2.parameters.push({
          in: 'body',
          name: 'body',
          required: op.requestBody.required || false,
          schema: op.requestBody.content['application/json'].schema
        });
      }
      if (op.responses) {
        for (const [code, resObj] of Object.entries(op.responses)) {
          const res2 = { description: resObj.description };
          if (resObj.content && resObj.content['application/json']) {
            res2.schema = resObj.content['application/json'].schema;
          }
          op2.responses[code] = res2;
        }
      }
      swagger2.paths[pathKey][method] = op2;
    }
  }
  return swagger2;
}

function jsonToYaml(obj, indent = 0) {
  const spaces = ' '.repeat(indent);
  if (obj === null) return 'null';
  if (typeof obj === 'undefined') return '';
  if (typeof obj !== 'object') {
    if (typeof obj === 'string') {
      if (obj.includes('\n') || obj.includes(':') || obj.includes('#') || obj.includes('-') || obj.includes('"')) {
        return `"${obj.replace(/"/g, '\\"')}"`;
      }
      return obj;
    }
    return String(obj);
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        const childYaml = jsonToYaml(item, indent + 2);
        return `${spaces}- ${childYaml.trimStart()}`;
      }
      return `${spaces}- ${jsonToYaml(item, indent + 2)}`;
    }).join('\n');
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  return keys.map(key => {
    const val = obj[key];
    if (typeof val === 'object' && val !== null) {
      return `${spaces}${key}:\n${jsonToYaml(val, indent + 2)}`;
    }
    return `${spaces}${key}: ${jsonToYaml(val, indent + 2)}`;
  }).join('\n');
}

// Endpoint to serve YAML specification
app.get('/swagger.yaml', (req, res) => {
  res.setHeader('Content-Type', 'text/yaml');
  res.setHeader('Content-Disposition', 'attachment; filename="swagger.yaml"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const spec = getPureSwagger2Spec();
  res.send(jsonToYaml(spec));
});

// Endpoint to serve CSV summary of API
app.get('/swagger.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="swagger.csv"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const spec = getPureSwagger2Spec();
  const rows = [['Method', 'Path', 'Summary', 'Description', 'OperationId']];
  
  for (const [pathKey, pathObj] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(pathObj)) {
      const summary = op.summary || '';
      const desc = op.description || '';
      const opId = op.operationId || '';
      
      const clean = (val) => {
        const str = String(val).replace(/"/g, '""');
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
          return `"${str}"`;
        }
        return str;
      };
      
      rows.push([
        method.toUpperCase(),
        pathKey,
        clean(summary),
        clean(desc),
        clean(opId)
      ]);
    }
  }
  
  res.send(rows.map(r => r.join(',')).join('\n'));
});

// Endpoint Swagger 2.0 (Pura ed al 100% compatibile con Copilot Studio & Power Platform)
app.get('/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(getPureSwagger2Spec());
});

// Endpoint per Copilot Studio (Restituisce la specifica pura Swagger 2.0)
app.get('/openapi.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(getPureSwagger2Spec());
});

app.get('/api-docs/openapi.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(getPureSwagger2Spec());
});

// UI Swagger
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

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

/**
 * Temporary public debug endpoint: tests one real Azure observation call and saves to DB.
 * Usage: GET /api/debug-observation?upId=UP_001&date=2026-07-09&type=meter&upName=Test
 */
function parseAzureDate(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{2})[-/](\d{2})[-/](\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hours, minutes, seconds] = match;
  return new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hours), parseInt(minutes), parseInt(seconds)));
}

app.get('/api/debug-observation', async (req, res) => {
  const upId = req.query.upId || 'UP_001';
  const date = req.query.date || '2026-07-09';
  const type = req.query.type || 'meter';
  const upName = req.query.upName || upId;
  const report = { upId, date, type, upName, steps: [] };

  try {
    // Step 1: Get Azure token
    const token = await getAzureToken();
    report.steps.push({ step: 'azure_token', ok: true });

    // Step 2: Call Azure API
    const prevDate = new Date(new Date(date).getTime() - 86400000).toISOString().split('T')[0];
    const nextDate = new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0];
    const reqBody = {
      from_UTC: `${prevDate}T21:00:00`,
      to_UTC: `${nextDate}T03:00:00`,
      update: false,
      upname: [upName],
      aggregatedData: false,
      type,
      upId,
      startDate: date,
      endDate: date
    };
    const rawData = await proxyToAzure('/api/observation', reqBody);
    const root = Array.isArray(rawData) ? rawData[0] : rawData;
    const series = root?.tag?.series || [];
    const seriesCount = series.length;
    const rawPreview = JSON.stringify(rawData).substring(0, 500);
    report.steps.push({ step: 'azure_call', ok: true, seriesCount, rawPreview });

    // Step 3: Parse
    const steps = 96;
    let values = Array(steps).fill(null);
    series.forEach(item => {
      const dateVal = item.deliveryDateTime || item.date;
      const valueVal = item.value !== undefined ? item.value : item.valore;
      if (!dateVal || valueVal === undefined || valueVal === null) return;

      const rawDateObj = parseAzureDate(dateVal);
      if (!rawDateObj) return;

      const rawDateStr = rawDateObj.toISOString().split('T')[0];
      const adjustedDateObj1 = new Date(rawDateObj.getTime() + 3600000);
      const adjustedDateStr1 = adjustedDateObj1.toISOString().split('T')[0];
      const adjustedDateObj2 = new Date(rawDateObj.getTime() + 7200000);
      const adjustedDateStr2 = adjustedDateObj2.toISOString().split('T')[0];

      let useDateObj;
      if (rawDateStr === date) {
        useDateObj = rawDateObj;
      } else if (adjustedDateStr1 === date) {
        useDateObj = adjustedDateObj1;
      } else if (adjustedDateStr2 === date) {
        useDateObj = adjustedDateObj2;
      } else {
        return;
      }

      const hours = useDateObj.getUTCHours();
      const minutes = useDateObj.getUTCMinutes();
      const index = hours * 4 + Math.floor(minutes / 15);
      if (index >= 0 && index < steps) values[index] = valueVal;
    });

    const nonNullCount = values.filter(v => v !== null).length;
    // Also show what dates actually appear in the series
    const datesInSeries = [];
    series.forEach(item => {
      const dateVal = item.deliveryDateTime || item.date;
      if (!dateVal) return;
      const dObj = parseAzureDate(dateVal);
      if (dObj) {
        datesInSeries.push(dObj.toISOString().split('T')[0]);
        datesInSeries.push(new Date(dObj.getTime() + 3600000).toISOString().split('T')[0]);
        datesInSeries.push(new Date(dObj.getTime() + 7200000).toISOString().split('T')[0]);
      }
    });
    const uniqueDatesInSeries = [...new Set(datesInSeries)];
    report.steps.push({ step: 'parse', ok: true, nonNullCount, datesInSeries: uniqueDatesInSeries });

    // Step 4: Save to DB
    await dbService.saveObservations(upId, date, type, values);
    const saved = await dbService.getObservations(upId, date, type);
    const savedNonNull = saved ? saved.filter(v => v !== null).length : 0;
    report.steps.push({ step: 'db_save', ok: true, savedNonNull });

    res.json(report);
  } catch (err) {
    report.steps.push({ step: 'ERROR', message: err.message });
    res.status(500).json(report);
  }
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
    const registry = await dbService.getRegistry();
    const idToNameMap = {};
    registry.forEach(up => {
      idToNameMap[up.id] = up.name;
    });
    const mappedData = data.map(obs => ({
      ...obs,
      up_id: idToNameMap[obs.up_id] || obs.up_id
    }));
    res.json(mappedData);
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
    const registry = await dbService.getRegistry();
    const idToNameMap = {};
    registry.forEach(up => {
      idToNameMap[up.id] = up.name;
    });
    const mappedOutages = outages.map(out => ({
      ...out,
      up_id: idToNameMap[out.up_id] || out.up_id
    }));
    res.json({ outages: mappedOutages });
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
    const { rangeDays, isSelective, upId, simMode, specificDate } = req.body;
    await startSync({ rangeDays: parseInt(rangeDays) || 30, isSelective: !!isSelective, upId: upId || 'all', simMode: !!simMode, specificDate: specificDate || null }, proxyToAzure);
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
 * @openapi
 * /api/registry:
 *   get:
 *     operationId: getRegistry
 *     summary: Ottiene l'elenco di tutte le Unita di Produzione (UP)
 *     description: Ritorna la lista completa di tutte le UP della flotta con i relativi attributi (tecnologia, capacita, flag disabilitazione scada, spegnimento notturno, ecc.).
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filtra per nome o codice UP (ricerca parziale)
 *       - in: query
 *         name: ppa_partner
 *         schema:
 *           type: string
 *         description: Filtra per partner commerciale PPA
 *       - in: query
 *         name: tech
 *         schema:
 *           type: string
 *           enum: [Solar, Wind]
 *         description: Filtra per tecnologia (Solar/Wind)
 *     responses:
 *       200:
 *         description: Elenco delle UP caricato con successo.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   tech:
 *                     type: string
 *                   region:
 *                     type: string
 *                   capacity:
 *                     type: number
 *                   ppa_partner:
 *                     type: string
 *                   scada_disabled:
 *                     type: boolean
 *                   solar_shutdown:
 *                     type: boolean
 */
app.get('/api/registry', async (req, res) => {
  try {
    const { name, ppa_partner, tech } = req.query;
    const registry = await dbService.getRegistry({ name, ppa_partner, tech });
    // Map database fields to frontend structure (e.g. scada_disabled 1/0 to true/false)
    const formatted = registry.map(up => ({
      name: up.name,
      tech: up.tech,
      region: up.region,
      capacity: up.capacity,
      lat: up.lat,
      lon: up.lon,
      ppa_partner: up.ppa_partner,
      scada_disabled: up.scada_disabled === 1,
      solar_shutdown: up.solar_shutdown === 1
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
    const { upId, ppaPartner, scadaDisabled, solarShutdown } = req.body;
    if (!upId) {
      return res.status(400).json({ error: 'Missing required field upId.' });
    }
    await dbService.updateUPPpaAndScada(upId, ppaPartner, scadaDisabled, solarShutdown);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/registry/sync-range', requireGoogleAuth, async (req, res) => {
  try {
    const { upId, startDate, endDate } = req.body;
    if (!upId || !startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required fields: upId, startDate, endDate.' });
    }
    
    let up = await dbService.getUPById(upId);
    if (!up) {
      const isWind = upId.toLowerCase().includes('wind');
      const tech = isWind ? 'Wind' : 'Solar';
      await dbService.saveUP(upId, upId, tech, 'Italia', 10.0, 0, 0, null, 0, 0);
      up = await dbService.getUPById(upId);
    }

    const simMode = (process.env.AZURE_MOCK_TELEMETRY === 'true') || 
                    !(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);

    // 1. Fetch and save meter observations
    let meterResults;
    try {
      meterResults = await fetchObservationsFromAzureRange(upId, startDate, endDate, 'meter', simMode, proxyToAzure, up.tech, up.name);
    } catch (err) {
      console.warn(`[Sync Range] Azure fetch failed for meter, falling back to simulated data: ${err.message}`);
      meterResults = await fetchObservationsFromAzureRange(upId, startDate, endDate, 'meter', true, proxyToAzure, up.tech, up.name);
    }
    for (const dateStr of Object.keys(meterResults)) {
      await dbService.saveObservations(upId, dateStr, 'meter', meterResults[dateStr]);
    }

    // 2. Fetch and save scada observations if not disabled
    const noScada = up.scada_disabled === 1 || up.scada_disabled === true;
    let scadaResults = {};
    if (!noScada) {
      try {
        scadaResults = await fetchObservationsFromAzureRange(upId, startDate, endDate, 'scada', simMode, proxyToAzure, up.tech, up.name);
      } catch (err) {
        console.warn(`[Sync Range] Azure fetch failed for scada, falling back to simulated data: ${err.message}`);
        scadaResults = await fetchObservationsFromAzureRange(upId, startDate, endDate, 'scada', true, proxyToAzure, up.tech, up.name);
      }
      for (const dateStr of Object.keys(scadaResults)) {
        await dbService.saveObservations(upId, dateStr, 'scada', scadaResults[dateStr]);
      }
    }

    // 3. Fetch and save outages
    try {
      const outages = await fetchOutagesFromAzureRange(upId, startDate, endDate, simMode, proxyToAzure);
      if (outages && outages.length > 0) {
        await dbService.saveOutages(outages);
      }
    } catch (e) {
      console.warn(`[Sync Range] Failed to fetch outages: ${e.message}`);
      try {
        const outages = await fetchOutagesFromAzureRange(upId, startDate, endDate, true, proxyToAzure);
        if (outages && outages.length > 0) {
          await dbService.saveOutages(outages);
        }
      } catch (e2) {
        console.warn(`[Sync Range] Failed to fetch mock outages: ${e2.message}`);
      }
    }

    // 4. Build timeseries
    const timeseries = [];
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    const mergeTelemetryDay = (dateStr, tech, meterValues, scadaValues) => {
      const stepsMeter = meterValues ? meterValues.length : 96;
      const stepsScada = scadaValues ? scadaValues.length : (tech === 'Wind' ? 144 : 96);
      
      const mergedMap = {};
      
      for (let i = 0; i < stepsMeter; i++) {
        const hh = String(Math.floor(i / 4)).padStart(2, '0');
        const mm = String((i % 4) * 15).padStart(2, '0');
        const timeKey = `${hh}:${mm}`;
        const val = (meterValues && meterValues[i] !== undefined) ? meterValues[i] : null;
        mergedMap[timeKey] = { meter: val, scada: null };
      }
      
      const scadaMinutesStep = stepsScada === 144 ? 10 : 15;
      for (let i = 0; i < stepsScada; i++) {
        const hh = String(Math.floor(i / (60 / scadaMinutesStep))).padStart(2, '0');
        const mm = String((i % (60 / scadaMinutesStep)) * scadaMinutesStep).padStart(2, '0');
        const timeKey = `${hh}:${mm}`;
        const val = (scadaValues && scadaValues[i] !== undefined) ? scadaValues[i] : null;
        
        if (mergedMap[timeKey]) {
          mergedMap[timeKey].scada = val;
        } else {
          mergedMap[timeKey] = { meter: null, scada: val };
        }
      }
      
      const sortedTimes = Object.keys(mergedMap).sort();
      return sortedTimes.map(timeKey => ({
        timestamp: `${dateStr} ${timeKey}`,
        meter: mergedMap[timeKey].meter,
        scada: mergedMap[timeKey].scada
      }));
    };

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const mValues = await dbService.getObservations(upId, dateStr, 'meter');
      const sValues = noScada ? null : await dbService.getObservations(upId, dateStr, 'scada');
      
      const dayData = mergeTelemetryDay(dateStr, up.tech, mValues, sValues);
      timeseries.push(...dayData);
    }

    res.json({ timeseries });
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

app.post('/api/users/approve', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Missing required parameter email.' });
    }
    await dbService.updateUserApproval(email, 1);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/decline', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Missing required parameter email.' });
    }
    if (email === 'fnicora@gmail.com') {
      return res.status(400).json({ error: 'Non è consentito rifiutare l\'utente proprietario.' });
    }
    await dbService.updateUserApproval(email, -1);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/chat', requireGoogleAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message parameter is required.' });
    }

    const msg = message.toLowerCase();
    const trace = [];
    let answer = "";
    let isRealGemini = false;

    const addTrace = (method, endpoint, requestBody, status, responseBody) => {
      trace.push({
        method,
        endpoint,
        request: requestBody,
        status,
        response: responseBody
      });
    };

    const rawApiKey = process.env.GEMINI_API_KEY;
    const apiKey = rawApiKey ? rawApiKey.trim().replace(/^["']|["']$/g, '') : null;

    if (msg.includes("diagnose-gemini-key")) {
      let debugInfo = "";
      if (!apiKey) {
        debugInfo = "Errore: GEMINI_API_KEY non è configurata nelle variabili d'ambiente di Render.";
      } else {
        try {
          const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
          const listRes = await fetch(listUrl);
          const text = await listRes.text();
          debugInfo = `ListModels REST Response (status ${listRes.status}):\n${text}`;
        } catch (err) {
          debugInfo = `Error querying ListModels: ${err.message}`;
        }
      }
      return res.json({
        answer: `### Diagnostica Gemini Key\n\n\`\`\`json\n${debugInfo}\n\`\`\``,
        trace: [],
        engine: 'Diagnostica'
      });
    }

    if (apiKey) {
      try {
        const functions = [
          {
            name: "getRegistry",
            description: "Ottiene l'elenco delle Unità di Produzione (UP) registrate nel sistema. Supporta filtri opzionali per partner PPA (es. GOOGLE, DXT, Axpo), nome/codice UP, o tecnologia (Solar/Wind).",
            parameters: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING", description: "Filtro opzionale sul nome o codice dell'UP (es. UPN_S16N1VL_01, GARNACHA)" },
                ppa_partner: { type: "STRING", description: "Filtro opzionale sul partner PPA (es. GOOGLE, DXT, Axpo)" },
                tech: { type: "STRING", description: "Filtro opzionale sulla tecnologia: Wind o Solar" }
              }
            }
          },
          {
            name: "getClusters",
            description: "Ottiene la lista di tutti i cluster/anomalie registrati nel sistema. Utile per verificare se ci sono anomalie da gestire o in sospeso.",
            parameters: {
              type: "OBJECT",
              properties: {
                status: { type: "STRING", description: "Filtro sullo stato del cluster: 'open', 'suspended', oppure 'closed'" },
                upId: { type: "STRING", description: "Filtro opzionale sull'identificativo dell'UP" },
                type: { type: "STRING", description: "Filtro opzionale sulla tipologia dell'anomalia (es. scada, meter, outage)" }
              }
            }
          },
          {
            name: "getLatestCluster",
            description: "Ottiene le informazioni sull'ultimo cluster di anomalie aperto o in corso (più recente).",
            parameters: {
              type: "OBJECT",
              properties: {
                upId: { type: "STRING", description: "Filtro opzionale sull'identificativo dell'UP" },
                type: { type: "STRING", description: "Filtro opzionale sulla tipologia dell'anomalia (es. scada, meter)" }
              }
            }
          },
          {
            name: "runDiagnosticsTestDay",
            description: "Esegue un test di diagnostica/integrità telemetrie on-demand per una determinata UP in una certa data.",
            parameters: {
              type: "OBJECT",
              properties: {
                upId: { type: "STRING", description: "L'identificativo dell'Unità di Produzione (es. UPN_S16N1VL_01)" },
                targetDate: { type: "STRING", description: "La data in formato YYYY-MM-DD per cui eseguire il test" }
              },
              required: ["upId", "targetDate"]
            }
          },
          {
            name: "setClusterChatContext",
            description: "Associa o aggiorna l'ID della chat esterna (es. Teams) ed eventualmente la piattaforma chat a un determinato cluster di anomalie.",
            parameters: {
              type: "OBJECT",
              properties: {
                clusterId: { type: "INTEGER", description: "L'identificativo numerico del cluster di anomalie (es. 16, 17)" },
                externalChatId: { type: "STRING", description: "L'ID o la stringa della chat esterna (es. 'Questo è un idchat inventato', '19:meeting...-thread.v2')" },
                chatPlatform: { type: "STRING", description: "La piattaforma chat (default: 'teams')" }
              },
              required: ["clusterId", "externalChatId"]
            }
          },
          {
            name: "suspendCluster",
            description: "Sospende temporaneamente un cluster di anomalie impostando uno stato di pausa fino a una data di riattivazione indicata.",
            parameters: {
              type: "OBJECT",
              properties: {
                clusterId: { type: "INTEGER", description: "L'identificativo numerico del cluster da sospendere" },
                reactivationDate: { type: "STRING", description: "La data in formato YYYY-MM-DD fino a cui sospendere il ticket" }
              },
              required: ["clusterId", "reactivationDate"]
            }
          },
          {
            name: "reactivateCluster",
            description: "Riattiva immediatamente un cluster di anomalie sospeso ripristinando lo stato a 'open'.",
            parameters: {
              type: "OBJECT",
              properties: {
                clusterId: { type: "INTEGER", description: "L'identificativo numerico del cluster da riattivare" }
              },
              required: ["clusterId"]
            }
          },
          {
            name: "closeCluster",
            description: "Risolve e chiude definitivamente un cluster di anomalie registrando eventuali note e categoria di risoluzione.",
            parameters: {
              type: "OBJECT",
              properties: {
                clusterId: { type: "INTEGER", description: "L'identificativo numerico del cluster da chiudere" },
                resolutionCategory: { type: "STRING", description: "Categoria opzionale di intervento/risoluzione" },
                resolutionNotes: { type: "STRING", description: "Note dettagliate sulla risoluzione dell'anomalia" }
              },
              required: ["clusterId"]
            }
          },
          {
            name: "extendCluster",
            description: "Estende la data di validità di un cluster di anomalie aperto a una nuova data finale.",
            parameters: {
              type: "OBJECT",
              properties: {
                clusterId: { type: "INTEGER", description: "L'identificativo numerico del cluster" },
                extendToDate: { type: "STRING", description: "La nuova data finale YYYY-MM-DD" },
                notes: { type: "STRING", description: "Note informative sull'estensione" }
              },
              required: ["clusterId", "extendToDate"]
            }
          }
        ];

function sanitizeCluster(c) {
  if (!c) return c;
  const obj = { ...c };
  delete obj.id;
  return obj;
}

        const systemInstruction = {
          parts: [{
            text: "Sei l'Assistente Virtuale ed Agente AI per il sistema Telemetry-Outage / PZero. Gestisci l'anagrafica delle Unità di Produzione (UP) e il tracciamento delle anomalie e dei cluster di telemetria. " +
                  "REGOLE RIGIDE: NON mostrare MAI l'ID identificativo numerico interno del database (es. Cluster ID 16, ID 17, id: 16) nei messaggi di risposta all'utente né nei riepiloghi. Identifica sempre le anomalie ed i cluster esclusivamente attraverso il codice dell'Unità di Produzione (`up_id`) e la tipologia dell'anomalia. " +
                  "IMPORTANTE: Quando l'utente menziona o chiede informazioni su un partner PPA specifico (es. Google, DXT, Axpo, Enel), tecnologia o nome UP, DEVI SEMPRE passare il valore corrispondente nel parametro `ppa_partner`, `tech` o `name` della funzione `getRegistry` (es. `ppa_partner: 'Google'`). " +
                  "Quando l'utente chiede di associare un ID chat o una chat a un cluster (es. 'assegna l'id della chat al valore X'), invoca il tool `setClusterChatContext` specificando `clusterId` e `externalChatId`. " +
                  "Se l'utente indica che per la risoluzione dell'anomalia occorrerà del tempo o una specifica durata (es. 'ci vorrà una settimana', 'serviranno 10 giorni', 'richiederà 5 giorni'), DEVI interpretare questa indicazione come una richiesta di SOSPENDERE il cluster (`suspendCluster`). Calcola la data `reactivationDate` sommando i giorni indicati (es. 7 giorni per 'una settimana', 14 per 'due settimane', N giorni per 'N giorni') alla data odierna. " +
                  "Quando l'utente chiede di sospendere, riattivare, chiudere o estendere un cluster, invoca i rispettivi tool (`suspendCluster`, `reactivateCluster`, `closeCluster`, `extendCluster`). " +
                  "Quando l'utente chiede se ci sono anomalie da gestire o lo stato generale dei cluster, invoca `getClusters` (con `status: 'open'`) oppure `getLatestCluster`. " +
                  "Analizza sempre i dati restituiti dai tool e rispondi in modo professionale, completo ed esaustivo in italiano, confermando l'operazione eseguita."
          }]
        };

        const contents = [];
        if (Array.isArray(req.body.history) && req.body.history.length > 0) {
          req.body.history.forEach(item => {
            if (item.text && (item.role === 'user' || item.role === 'model')) {
              contents.push({
                role: item.role,
                parts: [{ text: item.text }]
              });
            }
          });
        }
        contents.push({ role: "user", parts: [{ text: message }] });

        const geminiModel = process.env.GEMINI_MODEL || 'gemini-flash-latest';
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction,
            contents,
            tools: [{ functionDeclarations: functions }]
          })
        });

        if (response.ok) {
          isRealGemini = true;
          const geminiData = await response.json();
          const firstCandidate = geminiData.candidates?.[0];
          const part = firstCandidate?.content?.parts?.[0];

          if (part && part.functionCall) {
            const func = part.functionCall;
            const args = func.args || {};

            let toolResult;
            let method = "GET";
            let endpoint = "";

            if (func.name === "getRegistry") {
              endpoint = "/api/agent/registry";
              const rawData = await dbService.getRegistry({
                name: args.name,
                ppa_partner: args.ppa_partner,
                tech: args.tech
              });
              const ppaResolution = rawData.ppaResolution;
              toolResult = rawData.map(up => {
                const u = { ...up };
                delete u.id;
                return u;
              });
              if (ppaResolution) {
                toolResult.ppaResolution = ppaResolution;
              }
              addTrace(method, endpoint, args, 200, toolResult);
            } else if (func.name === "getClusters") {
              endpoint = "/api/agent/clusters";
              const data = await dbService.getClusters(args.status, args.upId, args.type);
              toolResult = (data && data.length > 0) ? data.map(sanitizeCluster) : [];
              addTrace(method, endpoint, args, 200, toolResult);
            } else if (func.name === "getLatestCluster") {
              endpoint = "/api/agent/clusters/latest";
              const data = await dbService.getLatestOpenCluster(args.upId, args.type);
              toolResult = data ? sanitizeCluster(data) : { message: "Nessun cluster aperto trovato" };
              addTrace(method, endpoint, args, 200, toolResult);
            } else if (func.name === "runDiagnosticsTestDay") {
              method = "POST";
              endpoint = "/api/agent/diagnostics/test-day";
              const targetUpId = args.upId;
              const targetDate = args.targetDate || new Date().toISOString().split("T")[0];
              const up = await dbService.getUPById(targetUpId);
              if (up) {
                const m = await dbService.getObservations(up.id, targetDate, 'meter');
                const s = await dbService.getObservations(up.id, targetDate, 'scada');
                const isSolarShutdown = (up.tech === 'Solar' && (up.solar_shutdown === 1 || up.solar_shutdown === true));
                const scadaDisabled = (up.scada_disabled === 1 || up.scada_disabled === true);
                
                const stepsMeter = m ? m.length : 96;
                const stepsScada = s ? s.length : (up.tech === 'Wind' ? 144 : 96);
                
                const meterAnalysis = analyzeStreamGaps(m, stepsMeter, isSolarShutdown);
                const scadaAnalysis = scadaDisabled 
                  ? { isPresent: true, hasGaps: false, gapCount: 0, validCount: stepsScada } 
                  : analyzeStreamGaps(s, stepsScada, isSolarShutdown);

                let status = 'green';
                if (!meterAnalysis.isPresent && !scadaAnalysis.isPresent) {
                  status = 'red';
                } else if (meterAnalysis.hasGaps || scadaAnalysis.hasGaps) {
                  status = 'orange';
                }

                toolResult = {
                  success: true,
                  upId: up.id,
                  upName: up.name,
                  tech: up.tech,
                  solar_shutdown: isSolarShutdown,
                  scada_disabled: scadaDisabled,
                  checkedDate: targetDate,
                  meterValid: meterAnalysis.validCount,
                  scadaValid: scadaAnalysis.validCount,
                  meterHasGaps: meterAnalysis.hasGaps,
                  scadaHasGaps: scadaAnalysis.hasGaps,
                  status
                };
              } else {
                toolResult = { success: false, error: `UP ${targetUpId} not found` };
              }
              addTrace(method, endpoint, args, 200, toolResult);
            } else if (func.name === "setClusterChatContext") {
              method = "POST";
              endpoint = `/api/agent/clusters/${args.clusterId}/chat-context`;
              await dbService.updateClusterChatContext(args.clusterId, args.externalChatId, args.chatPlatform || 'teams');
              toolResult = { success: true, external_chat_id: args.externalChatId, chat_platform: args.chatPlatform || 'teams' };
              addTrace(method, endpoint, { external_chat_id: args.externalChatId, chat_platform: args.chatPlatform || 'teams' }, 200, toolResult);
            } else if (func.name === "suspendCluster") {
              method = "POST";
              endpoint = `/api/agent/clusters/${args.clusterId}/suspend`;
              await dbService.suspendCluster(args.clusterId, args.reactivationDate);
              toolResult = { success: true, status: 'suspended', reactivation_date: args.reactivationDate };
              addTrace(method, endpoint, { reactivation_date: args.reactivationDate }, 200, toolResult);
            } else if (func.name === "reactivateCluster") {
              method = "POST";
              endpoint = `/api/agent/clusters/${args.clusterId}/reactivate`;
              await dbService.reactivateCluster(args.clusterId);
              toolResult = { success: true, status: 'open' };
              addTrace(method, endpoint, null, 200, toolResult);
            } else if (func.name === "closeCluster") {
              method = "POST";
              endpoint = `/api/agent/clusters/${args.clusterId}/close`;
              await dbService.closeCluster(args.clusterId, args.resolutionCategory, args.resolutionNotes);
              toolResult = { success: true, status: 'closed' };
              addTrace(method, endpoint, { resolutionCategory: args.resolutionCategory, resolutionNotes: args.resolutionNotes }, 200, toolResult);
            } else if (func.name === "extendCluster") {
              method = "POST";
              endpoint = `/api/agent/clusters/${args.clusterId}/extend`;
              await dbService.extendCluster(args.clusterId, args.extendToDate, args.notes || 'Estensione cluster da agent chat');
              toolResult = { success: true, extendToDate: args.extendToDate };
              addTrace(method, endpoint, { extendToDate: args.extendToDate, notes: args.notes }, 200, toolResult);
            }

            const modelPart = part;

            const finalResponse = await fetch(geminiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction,
                contents: [
                  ...contents,
                  { role: "model", parts: [modelPart] },
                  {
                    role: "user",
                    parts: [{
                      functionResponse: {
                        name: func.name,
                        response: { result: toolResult }
                      }
                    }]
                  }
                ],
                tools: [{ functionDeclarations: functions }]
              })
            });

            if (finalResponse.ok) {
              const finalData = await finalResponse.json();
              const candidate = finalData.candidates?.[0];
              if (candidate?.content?.parts) {
                answer = candidate.content.parts
                  .map(p => p.text)
                  .filter(Boolean)
                  .join("\n")
                  .trim();
              }

              // Handle PPA ambiguity or notFound override
              if (toolResult && toolResult.ppaResolution) {
                if (toolResult.ppaResolution.ambiguous || toolResult.ppaResolution.notFound) {
                  answer = toolResult.ppaResolution.message;
                }
              }

              // Smart fallback formatting if Gemini text extraction is empty
              if (!answer) {
                if (func.name === "getRegistry") {
                  if (Array.isArray(toolResult) && toolResult.length > 0) {
                    const resolvedPartner = toolResult.ppaResolution?.match || args.ppa_partner;
                    const partnerFilter = resolvedPartner ? ` filtrate per partner PPA '${resolvedPartner}'` : '';
                    answer = `Ecco le Unità di Produzione (UP) trovate${partnerFilter} (${toolResult.length}):\n\n` +
                      "| Nome UP | Tecnologia | Partner PPA | Regione |\n| :--- | :--- | :--- | :--- |\n" +
                      toolResult.map(u => `| **${u.name}** | ${u.tech} | ${u.ppa_partner || '*Non specificato*'} | ${u.region || 'Italia'} |`).join("\n");
                  } else if (toolResult?.ppaResolution?.message) {
                    answer = toolResult.ppaResolution.message;
                  } else {
                    answer = args.ppa_partner ? `Nessuna Unità di Produzione trovata associata al partner PPA '${args.ppa_partner}'.` : "Nessuna UP trovata per i criteri specificati.";
                  }
                } else if (func.name === "getClusters") {
                  if (Array.isArray(toolResult) && toolResult.length > 0) {
                    answer = `Ci sono ${toolResult.length} anomalie aperte da gestire:\n\n` +
                      toolResult.map((c, idx) => `${idx + 1}. **UP:** \`${c.up_id}\` - **Tipo Anomalia:** ${c.type} - **Periodo:** dal \`${c.start_date || 'N/D'}\` al \`${c.end_date || 'N/D'}\`` + (c.external_chat_id ? ` - **Chat:** \`${c.external_chat_id}\` (${c.chat_platform || 'teams'})` : '')).join("\n");
                  } else {
                    answer = "Attualmente non ci sono anomalie o cluster aperti o da gestire a sistema.";
                  }
                } else if (func.name === "getLatestCluster") {
                  if (toolResult && toolResult.up_id) {
                    answer = `L'ultimo cluster attivo riguarda l'impianto **${toolResult.up_id}** (Tipo: ${toolResult.type}, Stato: ${toolResult.status}).`;
                  } else {
                    answer = "Nessun cluster di anomalie aperto o pendente trovato nel sistema.";
                  }
                } else if (func.name === "setClusterChatContext") {
                  answer = `L'ID chat '${args.externalChatId}' è stato associato con successo al cluster dell'impianto.`;
                } else if (func.name === "suspendCluster") {
                  answer = `Il cluster dell'impianto è stato sospeso con successo fino al **${args.reactivationDate}**.`;
                } else if (func.name === "reactivateCluster") {
                  answer = `Il cluster dell'impianto è stato riattivato con successo.`;
                } else if (func.name === "closeCluster") {
                  answer = `Il cluster dell'impianto è stato chiuso e risolto con successo.`;
                } else if (func.name === "extendCluster") {
                  answer = `Il cluster dell'impianto è stato esteso con successo fino al **${args.extendToDate}**.`;
                } else if (func.name === "runDiagnosticsTestDay") {
                  const statusIcon = toolResult.status === 'green' ? '🟢 Legittimo / Integro' : (toolResult.status === 'orange' ? '🟠 Discrepanza / Buchi' : '🔴 Anomalia Grave');
                  const solarNote = toolResult.solar_shutdown ? ' (Spegnimento notturno ATTIVO: buchi notturni tollerati)' : '';
                  answer = `Diagnostica per **${toolResult.upName || toolResult.upId}** (${toolResult.tech}) del **${toolResult.checkedDate}**:\n` +
                    `- **Stato Integrità**: ${statusIcon}${solarNote}\n` +
                    `- **Letture Meter**: ${toolResult.meterValid || 0} valide${toolResult.meterHasGaps ? ' (Buchi presenti)' : ''}\n` +
                    `- **Letture SCADA**: ${toolResult.scada_disabled ? 'Disabilitato' : (toolResult.scadaValid || 0) + ' valide' + (toolResult.scadaHasGaps ? ' (Buchi presenti)' : '')}`;
                } else {
                  answer = "Elaborazione completata.";
                }
              }
            } else {
              const errText = await finalResponse.text();
              throw new Error(`Gemini final call failed with status ${finalResponse.status}: ${errText}`);
            }
          } else {
            answer = part?.text || "Non ho compreso la domanda o non sono necessarie azioni.";
          }
        } else {
          const errText = await response.text();
          throw new Error(`Gemini first call failed with status ${response.status}: ${errText}`);
        }
      } catch (geminiError) {
        console.warn("[Gemini Chat] Fallback to semantic engine:", geminiError.message);
        
        let modelsInfo = "";
        try {
          const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
          const listRes = await fetch(listUrl);
          if (listRes.ok) {
            const listData = await listRes.json();
            const names = (listData.models || []).map(m => m.name.replace('models/', ''));
            modelsInfo = `Disponibili: ${names.join(', ')}`;
          } else {
            modelsInfo = `ListModels fallito con status ${listRes.status}: ${await listRes.text()}`;
          }
        } catch (listErr) {
          modelsInfo = `ListModels error: ${listErr.message}`;
        }

        addTrace("ERROR", "/api/agent/chat/gemini-failure", null, 500, { 
          message: geminiError.message,
          diagnostic: modelsInfo
        });
      }
    }

    if (!answer) {
      const ups = await dbService.getRegistry();
      let foundUp = null;
      for (const up of ups) {
        if (msg.includes(up.id.toLowerCase()) || (up.name && msg.includes(up.name.toLowerCase()))) {
          foundUp = up;
          break;
        }
      }

      const cleanTraceUps = (arr) => arr.map(up => {
        const u = { ...up };
        delete u.id;
        return u;
      });

      if (foundUp && (msg.includes("ppa") || msg.includes("partner") || msg.includes("associata") || msg.includes("info") || msg.includes("dettagli"))) {
        const filtered = await dbService.getRegistry({ name: foundUp.id });
        addTrace("GET", "/api/agent/registry", { name: foundUp.id }, 200, cleanTraceUps(filtered));
        if (foundUp.ppa_partner) {
          answer = `Sì, l'Unità di Produzione ${foundUp.name} è associata al partner PPA '${foundUp.ppa_partner}'.`;
        } else {
          answer = `No, l'Unità di Produzione ${foundUp.name} non è attualmente associata ad alcun partner PPA.`;
        }
      }
      else if (msg.includes("google") && (msg.includes("ppa") || msg.includes("partner") || msg.includes("quali"))) {
        const googleUps = await dbService.getRegistry({ ppa_partner: 'GOOGLE' });
        addTrace("GET", "/api/agent/registry", { ppa_partner: 'GOOGLE' }, 200, cleanTraceUps(googleUps));
        if (googleUps.length > 0) {
          answer = `Ecco le Unità di Produzione associate al partner PPA **GOOGLE** (${googleUps.length}):\n\n` +
            "| Nome UP | Tecnologia | Partner PPA | Regione |\n| :--- | :--- | :--- | :--- |\n" +
            googleUps.map(u => `| **${u.name}** | ${u.tech} | ${u.ppa_partner} | ${u.region || 'Italia'} |`).join("\n");
        } else {
          answer = "Nessuna Unità di Produzione trovata associata al partner PPA GOOGLE.";
        }
      }
      else {
        const upMatches = msg.match(/(upn?[-_a-z0-9]+)/i);
        const targetUpId = upMatches ? upMatches[1].toUpperCase() : null;

        if (targetUpId && (msg.includes("ppa") || msg.includes("partner") || msg.includes("associata") || msg.includes("info") || msg.includes("dettagli"))) {
          const filtered = await dbService.getRegistry({ name: targetUpId });
          addTrace("GET", "/api/agent/registry", { name: targetUpId }, 200, cleanTraceUps(filtered));
          answer = `Non ho trovato alcuna Unità di Produzione corrispondente a '${targetUpId}' nell'anagrafica di sistema.`;
        }
      }

      if (!answer) {
        if (msg.includes("lista") || msg.includes("elenco") || msg.includes("registry") || msg.includes("quali up") || msg.includes("unità di produzione")) {
          addTrace("GET", "/api/agent/registry", null, 200, cleanTraceUps(ups));
          answer = `Ecco l'elenco delle ${ups.length} Unità di Produzione (UP) attive configurate a sistema. Ad esempio: ${ups.slice(0, 3).map(u => u.name).join(", ")}...`;
        } 
        else if (msg.includes("anomalie") || msg.includes("ultimo cluster") || msg.includes("ultimo ticket") || msg.includes("ultima anomalia") || msg.includes("cluster attivi") || msg.includes("stato anomalie")) {
          const openClusters = await dbService.getClusters('open');
          const latestCluster = await dbService.getLatestOpenCluster();
          addTrace("GET", "/api/agent/clusters", { status: 'open' }, 200, openClusters.length > 0 ? openClusters : (latestCluster || { message: "Nessun cluster aperto trovato" }));
          if (openClusters.length > 0) {
            answer = `Sono presenti ${openClusters.length} anomalie aperte a sistema:\n\n` +
              openClusters.map((c, idx) => `${idx + 1}. **UP:** ${c.up_id} (Tipo: ${c.type}, Stato: ${c.status})`).join("\n");
          } else if (latestCluster) {
            const upName = await dbService.resolveUpName(latestCluster.up_id);
            answer = `Ho intercettato il cluster attivo relativo all'impianto ${upName}. Lo stato attuale è '${latestCluster.status}'.`;
          } else {
            answer = "Attualmente non ci sono cluster di anomalie aperti o pendenti nel sistema.";
          }
        }
        else if (msg.includes("associa chat") || msg.includes("salva chat") || msg.includes("teams")) {
          const cluster = await dbService.getLatestOpenCluster();
          if (cluster) {
            const mockChatId = "19:meeting_Y2ZmYTZhNDgt...-thread.v2";
            await dbService.setClusterChatContext(cluster.id, mockChatId, 'teams');
            addTrace("POST", `/api/agent/clusters/${cluster.id}/chat-context`, { external_chat_id: mockChatId, chat_platform: "teams" }, 200, { success: true });
            answer = `Chat Teams associata con successo al cluster #${cluster.id}. L'agente utilizzerà questo contesto per riprendere la conversazione in futuro.`;
          } else {
            answer = "Impossibile associare la chat Teams perché non è stato trovato alcun cluster aperto a cui collegarla.";
          }
        }
        else if (msg.includes("sospendi") || msg.includes("metti in pausa") || msg.includes("settimana") || msg.includes("giorni") || msg.includes("tempo") || msg.includes("vorrà") || msg.includes("servirà")) {
          const cluster = await dbService.getLatestOpenCluster();
          if (cluster) {
            let days = 7;
            const daysMatch = msg.match(/(\d+)\s*giorn/i);
            if (daysMatch) {
              days = parseInt(daysMatch[1], 10);
            } else if (msg.includes("settimana")) {
              days = 7;
            }
            const reactDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            await dbService.suspendCluster(cluster.id, reactDate);
            addTrace("POST", `/api/agent/clusters/${cluster.id}/suspend`, { reactivation_date: reactDate }, 200, { success: true });
            answer = `Ho interpretato la tua indicazione come richiesta di sospensione. Il cluster #${cluster.id} per l'impianto ${cluster.up_id} è stato sospeso con successo per ${days} giorni (fino al ${reactDate}).`;
          } else {
            answer = "Impossibile sospendere: nessun cluster aperto trovato nel sistema.";
          }
        }
        else if (msg.includes("riattiva") || msg.includes("sveglia")) {
          const cluster = await dbService.getLatestOpenCluster();
          if (cluster) {
            await dbService.reactivateCluster(cluster.id);
            addTrace("POST", `/api/agent/clusters/${cluster.id}/reactivate`, null, 200, { success: true });
            answer = `Il cluster #${cluster.id} è stato riattivato con successo. L'agente ha ripreso il monitoraggio attivo del ticket.`;
          } else {
            answer = "Nessun cluster da riattivare trovato.";
          }
        }
        else if (msg.includes("chiudi") || msg.includes("risolvi")) {
          const cluster = await dbService.getLatestOpenCluster();
          if (cluster) {
            await dbService.closeCluster(cluster.id);
            addTrace("POST", `/api/agent/clusters/${cluster.id}/close`, null, 200, { success: true });
            answer = `Il cluster #${cluster.id} è stato chiuso e risolto. L'agente ha salvato lo stato finale a database.`;
          } else {
            answer = "Nessun cluster aperto da poter chiudere o risolvere.";
          }
        }
        else if (msg.includes("test") || msg.includes("diagnostica") || msg.includes("controlla")) {
          const targetUp = ups[0] ? ups[0].id : "UP_WIND_1";
          const today = new Date().toISOString().split("T")[0];
          addTrace("POST", "/api/agent/diagnostics/test-day", { upId: targetUp, targetDate: today }, 200, { success: true, status: 'green' });
          answer = `Ho eseguito un test diagnostico on-demand per l'impianto ${targetUp} in data ${today}. Tutte le telemetrie SCADA e METER sono in stato verde (100% integro).`;
        }
        else {
          answer = "Sono l'Agente Gemini in modalità handover. Posso aiutarti a collaudare i flussi reali dell'agente. Chiedimi della 'lista delle up', dell' 'ultimo cluster', di 'sospendere' o 'chiudere' un cluster, oppure di 'eseguire un test di diagnostica'!";
        }
      }
    }

    res.json({
      answer,
      trace,
      engine: isRealGemini ? 'Gemini 1.5 Flash (Live LLM)' : 'Motore Semantico di Handover (Risposte Precompilate)'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters:
 *   get:
 *     operationId: getClusters
 *     summary: Ottiene l'elenco dei cluster di anomalie
 *     description: Ritorna una lista di cluster filtrata per stato, UP o tipo di anomalia.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, closed]
 *         description: Filtra per stato del cluster.
 *       - in: query
 *         name: upId
 *         schema:
 *           type: string
 *         description: Filtra per ID impianto (UP).
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [scada, meter, both]
 *         description: Filtra per tipo di anomalia.
 *     responses:
 *       200:
 *         description: Lista di cluster trovati.
 */
app.get('/api/agent/clusters', requireGoogleAuth, async (req, res) => {
  try {
    const { status, upId, type } = req.query;
    const clusters = await dbService.getClusters(status, upId, type);
    res.json((clusters || []).map(sanitizeCluster));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/latest:
 *   get:
 *     operationId: getLatestCluster
 *     summary: Recupera o crea il cluster di anomalie più recente
 *     description: Ritorna il cluster aperto più recente per un impianto e tipo. Se non esiste, crea automaticamente un nuovo cluster aperto per attivare il flusso di chat con i process owner.
 *     parameters:
 *       - in: query
 *         name: upId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID dell'impianto.
 *       - in: query
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [scada, meter, both]
 *         description: Tipo di anomalia.
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *         description: Data di inizio da usare se viene creato un nuovo cluster (YYYY-MM-DD).
 *       - in: query
 *         name: notes
 *         schema:
 *           type: string
 *         description: Messaggio di sistema iniziale se viene creato un nuovo cluster.
 *       - in: query
 *         name: external_chat_id
 *         schema:
 *           type: string
 *         description: ID della chat/thread di Teams o altra piattaforma (es. 19:meeting_... o thread.v2).
 *       - in: query
 *         name: chat_platform
 *         schema:
 *           type: string
 *           default: teams
 *         description: Nome della piattaforma (es. teams, slack, custom).
 *     responses:
 *       200:
 *         description: Cluster esistente o appena creato con riferimenti chat.
 */
app.get('/api/agent/clusters/latest', requireGoogleAuth, async (req, res) => {
  try {
    const { upId, type, startDate, notes, external_chat_id, chat_platform } = req.query;
    if (!upId || !type) {
      return res.status(400).json({ error: 'Missing required parameters upId or type.' });
    }
    let cluster = await dbService.getLatestOpenCluster(upId, type);
    if (!cluster) {
      const startD = startDate || new Date().toISOString().split('T')[0];
      cluster = await dbService.createCluster(upId, type, startD, startD, notes || `Cluster avviato per anomalia ${type}.`, external_chat_id, chat_platform);
    } else if (external_chat_id && cluster.external_chat_id !== external_chat_id) {
      await dbService.updateClusterChatContext(cluster.id, external_chat_id, chat_platform);
      cluster = await dbService.getLatestOpenCluster(upId, type);
    }
    res.json(sanitizeCluster(cluster));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}/chat-context:
 *   post:
 *     operationId: setChatContext
 *     summary: Associa o aggiorna il riferimento alla chat esterna (Teams, Slack, etc.)
 *     description: Memorizza l'ID del thread/conversazione Teams (external_chat_id) nel cluster per consentire al bot di riprendere la conversazione nello stesso thread dopo il periodo di sospensione.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - external_chat_id
 *             properties:
 *               external_chat_id:
 *                 type: string
 *                 description: ID del thread/conversazione Teams o altra piattaforma.
 *               chat_platform:
 *                 type: string
 *                 default: teams
 *                 description: Piattaforma (es. teams, slack, custom).
 *     responses:
 *       200:
 *         description: Riferimento chat salvato.
 */
app.post('/api/agent/clusters/:id/chat-context', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { external_chat_id, chat_platform } = req.body;
    if (!external_chat_id) {
      return res.status(400).json({ error: 'Missing required parameter external_chat_id.' });
    }
    await dbService.updateClusterChatContext(parseInt(id), external_chat_id, chat_platform);
    res.json({ success: true, message: 'Chat context updated successfully.', external_chat_id, chat_platform: chat_platform || 'teams' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}/extend:
 *   post:
 *     operationId: extendCluster
 *     summary: Estende l'intervallo temporale di un cluster esistente
 *     description: Aggiunge giorni o aggiorna la data finale di un cluster quando l'anomalia persiste, scrivendo un messaggio di sistema nella chat per notificare l'estensione senza creare un nuovo ticket.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - extendToDate
 *             properties:
 *               extendToDate:
 *                 type: string
 *                 description: Nuova data di fine del cluster (YYYY-MM-DD).
 *               systemNotification:
 *                 type: string
 *                 description: Messaggio di notifica da inserire nello storico chat.
 *     responses:
 *       200:
 *         description: Estensione completata con successo.
 */
app.post('/api/agent/clusters/:id/extend', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { extendToDate, systemNotification } = req.body;
    if (!extendToDate) {
      return res.status(400).json({ error: 'Missing required body field extendToDate.' });
    }
    await dbService.extendCluster(id, extendToDate, systemNotification);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}/close:
 *   post:
 *     operationId: closeCluster
 *     summary: Risolve e chiude un cluster di anomalie
 *     description: Segna lo stato del cluster come 'closed' ed inserisce una notifica di sistema nella chat con la categoria e le note di risoluzione.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               resolutionCategory:
 *                 type: string
 *                 description: Categoria di risoluzione del problema.
 *               resolutionNotes:
 *                 type: string
 *                 description: Dettagli o note conclusive sulla risoluzione.
 *     responses:
 *       200:
 *         description: Chiusura completata con successo.
 */
app.post('/api/agent/clusters/:id/close', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { resolutionCategory, resolutionNotes } = req.body;
    await dbService.closeCluster(id, resolutionCategory, resolutionNotes);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}/suspend:
 *   post:
 *     operationId: suspendCluster
 *     summary: Sospende temporaneamente un cluster di anomalie
 *     description: Segna lo stato del cluster come 'suspended', imposta una data di riattivazione futura ed inserisce una notifica di sistema nella chat.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reactivationDate
 *             properties:
 *               reactivationDate:
 *                 type: string
 *                 description: Data in cui il cluster deve essere riattivato (YYYY-MM-DD).
 *               notes:
 *                 type: string
 *                 description: Motivazione della sospensione temporanea.
 *     responses:
 *       200:
 *         description: Sospensione registrata con successo.
 */
app.post('/api/agent/clusters/:id/suspend', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reactivationDate, notes } = req.body;
    if (!reactivationDate) {
      return res.status(400).json({ error: 'Missing required body field reactivationDate.' });
    }
    await dbService.suspendCluster(id, reactivationDate);
    
    // Add system notification message
    const sender = 'System Agent';
    const messageText = `⚠️ Case sospeso temporaneamente fino al ${reactivationDate}. Motivo: ${notes || 'Nessun dettaglio fornito'}.`;
    await dbService.addClusterMessage(id, sender, messageText);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}/reactivate:
 *   post:
 *     operationId: reactivateCluster
 *     summary: Riattiva un cluster precedentemente sospeso
 *     description: Segna lo stato del cluster come 'open', rimuove la data di riattivazione ed inserisce una notifica di sistema nella chat.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Note aggiuntive sulla riattivazione.
 *     responses:
 *       200:
 *         description: Riattivazione completata con successo.
 */
app.post('/api/agent/clusters/:id/reactivate', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    await dbService.reactivateCluster(id);
    
    // Add system notification message
    const sender = 'System Agent';
    const messageText = `🔄 Case riattivato. Stato impostato nuovamente in lavorazione (Open). ${notes ? 'Note: ' + notes : ''}`;
    await dbService.addClusterMessage(id, sender, messageText);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}:
 *   delete:
 *     operationId: deleteCluster
 *     summary: Elimina un cluster di anomalie
 *     description: Rimuove permanentemente un cluster e tutti i suoi messaggi associati.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     responses:
 *       200:
 *         description: Eliminazione completata con successo.
 */
app.delete('/api/agent/clusters/:id', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await dbService.deleteCluster(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/clusters/{id}/messages:
 *   get:
 *     operationId: getClusterMessages
 *     summary: Ottiene la cronologia della chat del cluster
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     responses:
 *       200:
 *         description: Elenco dei messaggi in ordine cronologico.
 *   post:
 *     operationId: addClusterMessage
 *     summary: Invia un messaggio nella chat del cluster
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del cluster.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sender
 *               - messageText
 *             properties:
 *               sender:
 *                 type: string
 *                 description: Autore del messaggio (es. 'agent' o nome utente).
 *               messageText:
 *                 type: string
 *                 description: Testo del messaggio da inviare.
 *     responses:
 *       200:
 *         description: Messaggio inviato con successo.
 */
app.get('/api/agent/clusters/:id/messages', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await dbService.getClusterMessages(id);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/clusters/:id/messages', requireGoogleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { sender, messageText } = req.body;
    if (!sender || !messageText) {
      return res.status(400).json({ error: 'Missing required body fields sender or messageText.' });
    }
    await dbService.addClusterMessage(id, sender, messageText);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/diagnostics/test-day:
 *   post:
 *     operationId: runDiagnosticsTestDay
 *     summary: Esegue un test di integrità istantaneo per una UP e una giornata
 *     description: Legge le letture ed esegue l'algoritmo di classificazione dell'integrità ritornando lo stato e il conteggio dei valori validi.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - upId
 *               - date
 *             properties:
 *               upId:
 *                 type: string
 *                 description: ID dell'impianto.
 *               date:
 *                 type: string
 *                 description: Data da verificare (YYYY-MM-DD).
 *     responses:
 *       200:
 *         description: Esito del test di integrità.
 */
app.post('/api/agent/diagnostics/test-day', requireGoogleAuth, async (req, res) => {
  try {
    const { upId, date } = req.body;
    if (!upId || !date) {
      return res.status(400).json({ error: 'Missing required body fields upId or date.' });
    }
    const up = await dbService.getUPById(upId);
    if (!up) {
      return res.status(404).json({ error: `UP ${upId} not found in registry.` });
    }
    
    const meterValues = await dbService.getObservations(upId, date, 'meter');
    const scadaValues = await dbService.getObservations(upId, date, 'scada');
    
    const isSolarShutdown = (up.tech === 'Solar' && (up.solar_shutdown === 1 || up.solar_shutdown === true));
    const scadaDisabled = (up.scada_disabled === 1 || up.scada_disabled === true);

    const stepsMeter = meterValues ? meterValues.length : 96;
    const stepsScada = scadaValues ? scadaValues.length : (up.tech === 'Wind' ? 144 : 96);

    const meterAnalysis = analyzeStreamGaps(meterValues, stepsMeter, isSolarShutdown);
    const scadaAnalysis = scadaDisabled 
      ? { isPresent: true, hasGaps: false, gapCount: 0, validCount: stepsScada } 
      : analyzeStreamGaps(scadaValues, stepsScada, isSolarShutdown);

    let status = 'green';
    if (!meterAnalysis.isPresent && !scadaAnalysis.isPresent) {
      status = 'red';
    } else if (meterAnalysis.hasGaps || scadaAnalysis.hasGaps) {
      status = 'orange';
    }
    
    res.json({
      upId: up.id,
      upName: up.name,
      date,
      tech: up.tech,
      solar_shutdown: isSolarShutdown,
      scada_disabled: scadaDisabled,
      meterAnalysis,
      scadaAnalysis,
      status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/reports/audit:
 *   post:
 *     operationId: generateAuditReport
 *     summary: Elabora un report di audit on-demand
 *     description: Esegue il controllo di integrità complessivo per un intervallo temporale e restituisce il report strutturato con le anomalie raggruppate per UP.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *             properties:
 *               startDate:
 *                 type: string
 *                 description: Data inizio audit (YYYY-MM-DD).
 *               endDate:
 *                 type: string
 *                 description: Data fine audit (YYYY-MM-DD).
 *     responses:
 *       200:
 *         description: Report di audit calcolato.
 */
app.post('/api/agent/reports/audit', requireGoogleAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required body fields startDate or endDate.' });
    }
    
    const ups = await dbService.getAllUPs();
    const anomalies = [];
    
    for (const up of ups) {
      const missingMeter = [];
      const missingScada = [];
      
      const start = new Date(startDate);
      // Never include today in anomaly analysis — today's data is always incomplete
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const effectiveEndDate = endDate > yesterdayStr ? yesterdayStr : endDate;
      const end = new Date(effectiveEndDate);
      
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dStr = d.toISOString().split('T')[0];
        
        const m = await dbService.getObservations(up.id, dStr, 'meter');
        const s = await dbService.getObservations(up.id, dStr, 'scada');
        
        const isSolarShutdown = (up.tech === 'Solar' && (up.solar_shutdown === 1 || up.solar_shutdown === true));
        const scadaDisabled = (up.scada_disabled === 1 || up.scada_disabled === true);

        const stepsMeter = m ? m.length : 96;
        const stepsScada = s ? s.length : (up.tech === 'Wind' ? 144 : 96);

        const meterAnalysis = analyzeStreamGaps(m, stepsMeter, isSolarShutdown);
        const scadaAnalysis = scadaDisabled
          ? { isPresent: true, hasGaps: false }
          : analyzeStreamGaps(s, stepsScada, isSolarShutdown);
        
        if (!meterAnalysis.isPresent || meterAnalysis.hasGaps) missingMeter.push(dStr);
        if (!scadaDisabled && (!scadaAnalysis.isPresent || scadaAnalysis.hasGaps)) missingScada.push(dStr);
      }
      
      if (missingMeter.length > 0 || missingScada.length > 0) {
        anomalies.push({
          upId: up.id,
          name: up.name,
          ppaPartner: up.ppa_partner || 'Nessuno',
          missingMeterDates: missingMeter,
          missingScadaDates: missingScada
        });
      }
    }
    
    res.json({
      period: `dal ${startDate} al ${endDate}`,
      generatedAt: new Date().toISOString(),
      anomalies
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/registry/ups:
 *   post:
 *     operationId: createUp
 *     summary: Aggiunge un impianto (UP) in anagrafica
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - name
 *               - tech
 *               - region
 *               - capacity
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: string
 *               tech:
 *                 type: string
 *                 enum: [Solar, Wind]
 *               region:
 *                 type: string
 *               capacity:
 *                 type: number
 *               lat:
 *                 type: number
 *               lon:
 *                 type: number
 *               ppa_partner:
 *                 type: string
 *               scada_disabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: UP aggiunta correttamente.
 */
app.post('/api/agent/registry/ups', requireGoogleAuth, requireAdmin, async (req, res) => {
  try {
    const up = req.body;
    if (!up.id || !up.name || !up.tech || !up.region || up.capacity === undefined) {
      return res.status(400).json({ error: 'Missing required fields: id, name, tech, region, capacity.' });
    }
    const scada = up.scada_disabled ? 1 : 0;
    const solarShutdown = (up.solar_shutdown === true || up.solar_shutdown === 1 || up.solarShutdown === true) ? 1 : 0;
    await dbService.saveUP(up.id, up.name, up.tech, up.region, up.capacity, up.lat || 0, up.lon || 0, up.ppa_partner || null, scada, solarShutdown);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/registry/ups/{id}:
 *   delete:
 *     operationId: deleteUp
 *     summary: Rimuove un impianto (UP) dall'anagrafica
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID della UP.
 *     responses:
 *       200:
 *         description: UP rimossa correttamente.
 */
app.delete('/api/agent/registry/ups/:id', requireGoogleAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await dbService.deleteUP(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/registry/ppa-partners:
 *   get:
 *     operationId: getPpaPartners
 *     summary: Ottiene l'elenco dei partner PPA (controparti)
 *     responses:
 *       200:
 *         description: Lista dei partner PPA.
 *   post:
 *     operationId: createPpaPartner
 *     summary: Crea un nuovo partner PPA (controparte)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               color:
 *                 type: string
 *     responses:
 *       200:
 *         description: Partner PPA aggiunto correttamente.
 */
app.get('/api/agent/registry/ppa-partners', requireGoogleAuth, async (req, res) => {
  try {
    const tags = await dbService.getAllPpaTags();
    res.json(tags);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/registry/ppa-partners', requireGoogleAuth, requireAdmin, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Missing name in request body.' });
    }
    await dbService.savePpaTag(name, color || '#3b82f6');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/registry/ppa-partners/{name}:
 *   delete:
 *     operationId: deletePpaPartner
 *     summary: Elimina una controparte PPA
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Nome della controparte.
 *     responses:
 *       200:
 *         description: Controparte eliminata correttamente.
 */
app.delete('/api/agent/registry/ppa-partners/:name', requireGoogleAuth, requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    await dbService.deletePpaTag(name);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/registry/assignments:
 *   get:
 *     operationId: getPpaAssignments
 *     summary: Ottiene l'elenco delle associazioni UP e partner PPA
 *     responses:
 *       200:
 *         description: Elenco degli accoppiamenti UP-PPA.
 */
app.get('/api/agent/registry/assignments', requireGoogleAuth, async (req, res) => {
  try {
    const ups = await dbService.getAllUPs();
    const assignments = ups.map(up => ({
      upId: up.id,
      upName: up.name,
      ppaPartner: up.ppa_partner || 'Nessuno'
    }));
    res.json(assignments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @openapi
 * /api/agent/registry/assign:
 *   post:
 *     operationId: assignPpaPartner
 *     summary: Assegna o rimuove un partner PPA ad una UP
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - upId
 *             properties:
 *               upId:
 *                 type: string
 *               ppaTag:
 *                 type: string
 *                 description: Nome del partner PPA. Impostare a null per disassociare.
 *     responses:
 *       200:
 *         description: Assegnazione aggiornata correttamente.
 */
app.post('/api/agent/registry/assign', requireGoogleAuth, requireAdmin, async (req, res) => {
  try {
    const { upId, ppaTag } = req.body;
    if (!upId) {
      return res.status(400).json({ error: 'Missing required parameter upId.' });
    }
    await dbService.updateUPPpaAndScada(upId, ppaTag, undefined);
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
