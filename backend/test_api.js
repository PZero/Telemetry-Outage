import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BASE_URL = 'http://localhost:3000';
const TOKEN = 'mock-google-token-id';

async function runTests() {
  console.log('==================================================');
  console.log(' STARTING API INTEGRATION TEST BATTERY');
  console.log('==================================================');

  let testCount = 0;
  let passCount = 0;

  async function assertAPI(name, urlPath, options = {}) {
    testCount++;
    const url = `${BASE_URL}${urlPath}`;
    const headers = {
      'Authorization': `Bearer ${options.token || TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    
    try {
      const response = await fetch(url, { ...options, headers });
      const status = response.status;
      let body = null;
      try {
        body = await response.json();
      } catch (e) {
        body = await response.text();
      }
      
      const expectedStatus = options.expectedStatus || 200;
      if (status === expectedStatus) {
        console.log(`[PASS] ${name} - Status: ${status}`);
        passCount++;
        return { ok: true, body, status };
      } else {
        console.error(`[FAIL] ${name} - Expected: ${expectedStatus}, Got: ${status}`);
        console.error(`       Response: ${JSON.stringify(body)}`);
        return { ok: false, body, status };
      }
    } catch (err) {
      console.error(`[FAIL] ${name} - Error: ${err.message}`);
      return { ok: false, error: err };
    }
  }

  // --- 0. USER APPROVAL WORKFLOW TESTS ---
  console.log('\n--- [0] User Approval & Authorization Block ---');
  
  await assertAPI('Utente in attesa viene bloccato sulle API dati', '/api/agent/registry/assignments', {
    token: 'mock-pending-token-id',
    expectedStatus: 403
  });

  await assertAPI('Utente in attesa può leggere il proprio profilo', '/api/auth/profile', {
    token: 'mock-pending-token-id',
    expectedStatus: 200
  });

  await assertAPI('Utente rifiutato viene bloccato sulle API dati', '/api/agent/registry/assignments', {
    token: 'mock-declined-token-id',
    expectedStatus: 403
  });

  await assertAPI('Utente rifiutato può leggere il proprio profilo', '/api/auth/profile', {
    token: 'mock-declined-token-id',
    expectedStatus: 200
  });

  // --- 1. REGISTRY TESTS ---
  console.log('\n--- [1] Anagrafica & Partner PPA ---');
  
  // Add a test UP
  const upPayload = {
    id: 'UP_TEST_99',
    name: 'Impianto Eolico Test 99',
    tech: 'Wind',
    region: 'Sicilia',
    capacity: 10.5,
    scada_disabled: false
  };
  await assertAPI('Aggiungi UP in anagrafica', '/api/agent/registry/ups', {
    method: 'POST',
    body: JSON.stringify(upPayload)
  });

  // List assignments
  const listAss = await assertAPI('Elenca associazioni PPA', '/api/agent/registry/assignments', {
    method: 'GET'
  });

  // Create PPA Partner
  const ppaPayload = {
    name: 'Test Partner PPA',
    color: '#ff0000'
  };
  await assertAPI('Crea partner PPA', '/api/agent/registry/ppa-partners', {
    method: 'POST',
    body: JSON.stringify(ppaPayload)
  });

  // Assign PPA to UP
  const assignPayload = {
    upId: 'UP_TEST_99',
    ppaTag: 'Test Partner PPA'
  };
  await assertAPI('Assegna partner PPA alla UP', '/api/agent/registry/assign', {
    method: 'POST',
    body: JSON.stringify(assignPayload)
  });

  // --- 2. DIAGNOSTICS TESTS ---
  console.log('\n--- [2] Diagnostica On-Demand ---');
  
  const diagPayload = {
    upId: 'UP_TEST_99',
    date: '2026-07-14'
  };
  await assertAPI('Esegui test integrità UP', '/api/agent/diagnostics/test-day', {
    method: 'POST',
    body: JSON.stringify(diagPayload)
  });

  const auditPayload = {
    startDate: '2026-07-10',
    endDate: '2026-07-14'
  };
  await assertAPI('Genera Audit Report', '/api/agent/reports/audit', {
    method: 'POST',
    body: JSON.stringify(auditPayload)
  });

  // --- 3. ANOMALY CLUSTER CRUD TESTS ---
  console.log('\n--- [3] Cluster & Chat Workflow ---');

  // Create/Get latest cluster
  const latestClusterRes = await assertAPI('Ottieni/Crea ultimo open cluster', '/api/agent/clusters/latest?upId=UP_TEST_99&type=both&notes=Test%20iniziale%20di%20sistema', {
    method: 'GET'
  });
  
  if (latestClusterRes.ok && latestClusterRes.body && latestClusterRes.body.id) {
    const clusterId = latestClusterRes.body.id;

    // Send chat message
    const msgPayload = {
      sender: 'Copilot Test Agent',
      messageText: 'Messaggio automatico di verifica'
    };
    await assertAPI('Invia messaggio in chat del cluster', `/api/agent/clusters/${clusterId}/messages`, {
      method: 'POST',
      body: JSON.stringify(msgPayload)
    });

    // Get messages history
    await assertAPI('Leggi cronologia messaggi', `/api/agent/clusters/${clusterId}/messages`, {
      method: 'GET'
    });

    // Extend cluster
    const extendPayload = {
      extendToDate: '2026-07-15',
      systemNotification: 'Cluster esteso per persistenza anomalia'
    };
    await assertAPI('Estendi durata cluster', `/api/agent/clusters/${clusterId}/extend`, {
      method: 'POST',
      body: JSON.stringify(extendPayload)
    });

    // Close cluster
    const closePayload = {
      resolutionCategory: 'Verifica completata',
      resolutionNotes: 'Tutti i test delle API sono passati.'
    };
    await assertAPI('Risolvi e chiudi cluster', `/api/agent/clusters/${clusterId}/close`, {
      method: 'POST',
      body: JSON.stringify(closePayload)
    });

    // Delete cluster
    await assertAPI('Elimina cluster', `/api/agent/clusters/${clusterId}`, {
      method: 'DELETE'
    });
  }

  // --- 4. TEARDOWN / CLEANUP ---
  console.log('\n--- [4] Ripristino Anagrafiche ---');
  
  await assertAPI('Rimuovi controparte PPA di test', '/api/agent/registry/ppa-partners/Test%20Partner%20PPA', {
    method: 'DELETE'
  });

  await assertAPI('Rimuovi UP di test', '/api/agent/registry/ups/UP_TEST_99', {
    method: 'DELETE'
  });

  console.log('\n==================================================');
  console.log(` TEST BATTERY COMPLETED: ${passCount}/${testCount} PASSED`);
  console.log('==================================================');
  
  if (passCount === testCount) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

// Small delay to let database settle or for standard invocation
setTimeout(runTests, 500);
