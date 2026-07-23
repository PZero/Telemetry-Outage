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

  const syncRangePayload = {
    upId: 'UP_TEST_99',
    startDate: '2026-07-10',
    endDate: '2026-07-14'
  };
  await assertAPI('Esporta e Sincronizza Intervallo Telemetrie', '/api/registry/sync-range', {
    method: 'POST',
    body: JSON.stringify(syncRangePayload)
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

    // Test updating external_chat_id context
    await assertAPI('Associa chat context Teams al cluster', `/api/agent/clusters/${clusterId}/chat-context`, {
      method: 'POST',
      body: JSON.stringify({ external_chat_id: '19:teams_thread_12345@thread.v2', chat_platform: 'teams' })
    });

    // Suspend cluster
    const suspendPayload = {
      reactivationDate: '2026-07-25',
      notes: 'Sospensione di test per 10 giorni'
    };
    await assertAPI('Sospendi cluster temporaneamente', `/api/agent/clusters/${clusterId}/suspend`, {
      method: 'POST',
      body: JSON.stringify(suspendPayload)
    });

    // Reactivate cluster
    const reactivatePayload = {
      notes: 'Test di riattivazione'
    };
    await assertAPI('Riattiva cluster sospeso', `/api/agent/clusters/${clusterId}/reactivate`, {
      method: 'POST',
      body: JSON.stringify(reactivatePayload)
    });

    // Suspend cluster with expired date
    const suspendExpiredPayload = {
      reactivationDate: '2026-07-01',
      notes: 'Sospensione scaduta'
    };
    await assertAPI('Sospendi cluster con data scaduta', `/api/agent/clusters/${clusterId}/suspend`, {
      method: 'POST',
      body: JSON.stringify(suspendExpiredPayload)
    });

    // Fetch latest cluster to trigger auto-reactivation
    const response = await fetch(`${BASE_URL}/api/agent/clusters/latest?upId=UP_TEST_99&type=both`, {
      headers: { 'Authorization': 'Bearer mock-google-token-id' }
    });
    const latestCluster = await response.json();
    console.log('latestCluster returned to test:', latestCluster);
    if (latestCluster.status === 'open' && latestCluster.force_chat_update === 1) {
      console.log('[PASS] Auto-riattivazione cluster e flag force_chat_update impostato.');
    } else {
      console.error(`[FAIL] Auto-riattivazione fallita. Got status: ${latestCluster.status}, force_chat_update: ${latestCluster.force_chat_update}`);
      process.exit(1);
    }

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

  // --- 3B. AGENT CHAT & INTERCEPTOR TESTS ---
  console.log('\n--- [3B] Agent Chat Simulator & Interceptor ---');
  const chatRes = await assertAPI('Chiedi lista delle UP alla chat agent', '/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'dammi la lista delle up' })
  });
  if (chatRes.ok && chatRes.body && chatRes.body.trace) {
    const hasRegistryTrace = chatRes.body.trace.some(t => t.endpoint === '/api/agent/registry');
    if (hasRegistryTrace) {
      console.log('[PASS] Chat intercetta e logga chiamata a /api/agent/registry.');
    } else {
      console.error('[FAIL] Manca la traccia della chiamata API /api/agent/registry nella chat.');
      process.exit(1);
    }
  } else {
    console.error('[FAIL] Errore risposta chat:', chatRes.body);
    process.exit(1);
  }

  const chatDiagRes = await assertAPI('Esegui test diagnostico via chat agent', '/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'esegui test diagnostica' })
  });
  if (chatDiagRes.ok && chatDiagRes.body && chatDiagRes.body.trace) {
    const hasDiagTrace = chatDiagRes.body.trace.some(t => t.endpoint === '/api/agent/diagnostics/test-day');
    if (hasDiagTrace) {
      console.log('[PASS] Chat intercetta e logga chiamata a /api/agent/diagnostics/test-day.');
    } else {
      console.error('[FAIL] Manca la traccia della chiamata diagnostica nella chat.');
      process.exit(1);
    }
  } else {
    console.error('[FAIL] Errore risposta chat diagnostica:', chatDiagRes.body);
    process.exit(1);
  }

  const chatPpaRes = await assertAPI('Chiedi associazione PPA di una UP specifica', '/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({ message: "sai dirmi se l'up: UP_TEST_99 è associata ad un ppa?" })
  });
  if (chatPpaRes.ok && chatPpaRes.body && chatPpaRes.body.trace) {
    const hasRegistryTrace = chatPpaRes.body.trace.some(t => t.endpoint === '/api/agent/registry');
    if (hasRegistryTrace && chatPpaRes.body.answer.includes("Test Partner PPA")) {
      console.log('[PASS] Chat risponde correttamente sull\'associazione PPA della UP richiesta.');
    } else {
      console.error('[FAIL] Risposta chat PPA errata o traccia mancante. Risposta:', chatPpaRes.body.answer);
      process.exit(1);
    }
  } else {
    console.error('[FAIL] Errore risposta chat PPA:', chatPpaRes.body);
    process.exit(1);
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
