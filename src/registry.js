// Centralized Registry of 100 Production Units (UPs)
// Fetches state dynamically from the backend SQLite database.

import { getAuthHeaders } from "./api.js";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

const regions = [
  "Sicilia", "Sardegna", "Puglia", "Campania", "Calabria", 
  "Basilicata", "Abruzzo", "Toscana", "Lazio", "Emilia-Romagna"
];

const windNames = [
  "Eolico Erice", "Vento Mazara", "Pala Castelvetrano", "Turbina Troina", "Parco Alcamo",
  "Altopiano Buddusò", "Vento Tempio", "Galtellì Ridge", "Campeda Wind", "Sassari Eolico",
  "Foggia Nord", "Cerignola Wind", "Gargano Power", "Candela Eolico", "Taranto Vento",
  "Vento Ariano", "Lacedonia Eolico", "Parco Conza", "Monteverde Wind", "Calitri Eolico",
  "Crotone Ridge", "Isola Capo Rizzuto", "Parco Albi", "Catanzaro Vento", "Reggio Eolico",
  "Melfi Eolico", "Rotondella Wind", "Parco Gorgoglione", "Matera Vento", "Potenza Ridge",
  "Colle Castiglione", "Vento Collarmele", "Parco Scanno", "Pescara Ridge", "Chieti Eolico",
  "Mugello Wind", "Pontedera Eolico", "Vento Piombino", "Grosseto Ridge", "Siena Eolico",
  "Castelli Romani", "Viterbo Vento", "Frosinone Wind", "Latina Coast", "Rieti Ridge",
  "Appennino Parma", "Piacenza Wind", "Ravenna Eolico", "Vento Bobbio", "Bologna Ridge"
];

const solarNames = [
  "Solare Catania", "Solar Agrigento", "Noto PV Grid", "Ragusa Sun", "Piana Gela PV",
  "Solare Cagliari", "Oristano Sun", "Solar Sassari", "Assemini PV", "Nuoro Sun",
  "Piana Foggia PV", "Brindisi Solar", "Lecce Solare", "Bari Sunfield", "Taranto Solar",
  "Piana Caserta", "Benevento PV", "Avellino Solare", "Salerno Solar", "Napoli Sun",
  "Sibari Solar", "Lamezia PV Grid", "Crotone Sunfield", "Reggio Solare", "Cosenza Solar",
  "Melfi Solar", "Metaponto PV", "Matera Sunfield", "Lavello Solare", "Venosa Sun",
  "L'Aquila Solar", "Sulmona PV", "Teramo Sunfield", "Chieti Solare", "Ortona Sun",
  "Maremma Solar", "Pisa PV Grid", "Lucca Solare", "Arezzo Sun", "Livorno Solar",
  "Viterbo Solar", "Latina PV Grid", "Rieti Solare", "Frosinone Sunfield", "Roma Solar",
  "Imola PV Grid", "Forlì Solare", "Ferrara Sunfield", "Modena Solar", "Parma PV"
];

export const UP_REGISTRY = [];
export const UNIQUE_REGIONS = [];

/**
 * Loads the registry asynchronously from the backend SQLite database.
 */
export async function loadUPRegistry() {
  // Don't attempt to load if there's no auth session yet — user hasn't logged in
  const session = localStorage.getItem("google_user_session");
  const hasToken = session && (() => { try { const u = JSON.parse(session); return !!(u && u.token); } catch(e) { return false; } })();
  if (!hasToken) {
    console.log("[Registry] No auth session available yet — skipping registry load until login.");
    return;
  }

  try {
    const response = await fetch(`${BASE_URL}/api/registry`, {
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    UP_REGISTRY.length = 0;
    // Map DB field ppa_partner → ppaTag so the frontend PPA filter works correctly
    UP_REGISTRY.push(...data.map(up => {
      const u = { ...up };
      u.ppaTag = u.ppa_partner || u.ppaTag || null;
      delete u.ppa_partner; // Prevent database override of updated ppaTag values
      u.scada_disabled = u.scada_disabled === 1 || u.scada_disabled === true;
      return u;
    }));
    updateUniqueRegions();
    console.log(`[Registry] Loaded ${data.length} UPs from backend database.`);

  } catch (err) {
    console.error("[Registry] Failed to fetch registry from backend:", err);
    // Only fall back to mock if we had a token (backend network error, not auth error)
    if (UP_REGISTRY.length === 0) {
      console.warn("[Registry] Falling back to mock data due to backend error.");
      loadDefaultMockRegistry();
    }
  }
}

/**
 * Generates local mock registry fallback if backend is unreachable.
 */
function loadDefaultMockRegistry() {
  UP_REGISTRY.length = 0;
  
  // Populate Wind UPs (1 to 50)
  for (let i = 1; i <= 50; i++) {
    const regionIndex = (i - 1) % regions.length;
    const capacity = 15 + ((i * 7) % 61); 
    UP_REGISTRY.push({
      id: `UP_WIND_${String(i).padStart(2, '0')}`,
      name: windNames[i - 1] || `Parco Eolico Wind ${i}`,
      tech: "Wind",
      region: regions[regionIndex],
      capacity: capacity,
      lat: 37.0 + ((i * 13) % 100) / 15,
      lon: 12.0 + ((i * 17) % 100) / 18,
      ppa_partner: null,
      scada_disabled: false
    });
  }

  // Populate Solar UPs (1 to 50)
  for (let i = 1; i <= 50; i++) {
    const regionIndex = (i - 1) % regions.length;
    const capacity = 5 + ((i * 11) % 31);
    UP_REGISTRY.push({
      id: `UP_SOLAR_${String(i).padStart(2, '0')}`,
      name: solarNames[i - 1] || `Parco Solare Solar ${i}`,
      tech: "Solar",
      region: regions[regionIndex],
      capacity: capacity,
      lat: 36.5 + ((i * 19) % 100) / 15,
      lon: 12.5 + ((i * 23) % 100) / 18,
      ppa_partner: null,
      scada_disabled: false
    });
  }

  updateUniqueRegions();
}

function updateUniqueRegions() {
  const regionsSet = [...new Set(UP_REGISTRY.map(up => up.region))].sort();
  UNIQUE_REGIONS.length = 0;
  UNIQUE_REGIONS.push(...regionsSet);
}

// Helper to get UP details by ID or Name
export function getUPById(id) {
  if (!id) return null;
  return UP_REGISTRY.find(up => up.id === id) || UP_REGISTRY.find(up => up.name === id);
}

export function isScadaDisabled(upId) {
  const up = getUPById(upId);
  return up ? up.scada_disabled : false;
}

export async function setScadaDisabled(upId, disabled) {
  try {
    const response = await fetch(`${BASE_URL}/api/registry/update`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ upId, scadaDisabled: disabled })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    
    // Update local state in memory
    const up = getUPById(upId);
    if (up) up.scada_disabled = disabled;
    
    console.log(`[Registry] SCADA disabled status updated for ${upId} to:`, disabled);
    return true;
  } catch (err) {
    console.error('[Registry Proxy] setScadaDisabled failed:', err);
    return false;
  }
}
