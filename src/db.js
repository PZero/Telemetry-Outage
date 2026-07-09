// SQLite Database proxy manager for centralized storage.
// Replaces IndexedDB client-side storage with secure backend SQLite calls.

import { getAuthHeaders } from "./api.js";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

/**
 * No-op initialization for compatibility.
 */
export function initDB() {
  return Promise.resolve(true);
}

/**
 * Gets persistence status (always true as backend handles persistence).
 */
export async function getPersistenceStatus() {
  return true;
}

/**
 * Saves daily telemetry observations to the centralized database.
 */
export async function saveObservations(upId, date, type, values) {
  try {
    const url = `${BASE_URL}/api/db/observations`;
    const response = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ upId, date, type, values })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    return true;
  } catch (err) {
    console.error('[Storage Proxy] saveObservations failed:', err);
    return false;
  }
}

/**
 * Retrieves daily observations telemetry from the centralized database.
 */
export async function getObservations(upId, date, type) {
  try {
    const url = `${BASE_URL}/api/db/observations?upId=${upId}&date=${date}&type=${type}`;
    const response = await fetch(url, {
      headers: getAuthHeaders()
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    return data.values || null;
  } catch (err) {
    console.error('[Storage Proxy] getObservations failed:', err);
    return null;
  }
}

/**
 * Retrieves a daily telemetry record object with all metadata.
 */
export async function getObservationRecord(upId, date, type) {
  try {
    const values = await getObservations(upId, date, type);
    if (!values) return null;
    return {
      key: `${upId}|${date}|${type}`,
      up_id: upId,
      date,
      type,
      values,
      updated_at: new Date().toISOString()
    };
  } catch (err) {
    console.error('[Storage Proxy] getObservationRecord failed:', err);
    return null;
  }
}

/**
 * Saves outages in bulk.
 */
export async function saveOutages(outagesList) {
  try {
    const url = `${BASE_URL}/api/db/outages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ outages: outagesList })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    return true;
  } catch (err) {
    console.error('[Storage Proxy] saveOutages failed:', err);
    return false;
  }
}

/**
 * Retrieves all outages registered for a specific UP.
 */
export async function getOutages(upId) {
  try {
    const url = `${BASE_URL}/api/db/outages?upId=${upId}`;
    const response = await fetch(url, {
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    return data.outages || [];
  } catch (err) {
    console.error('[Storage Proxy] getOutages failed:', err);
    return [];
  }
}

/**
 * Get outages overlapping with a day/date range for a specific UP.
 */
export async function getOutagesForPeriod(upId, startDateISO, endDateISO) {
  try {
    const allOutages = await getOutages(upId);
    const start = new Date(startDateISO).getTime();
    const end = new Date(endDateISO).getTime();

    // Filter outages that intersect with the requested range
    return allOutages.filter(o => {
      const oStart = new Date(o.startDate).getTime();
      const oEnd = new Date(o.endDate).getTime();
      
      // Intersection condition
      return oStart <= end && oEnd >= start;
    });
  } catch (err) {
    console.error('[Storage Proxy] getOutagesForPeriod failed:', err);
    return [];
  }
}

/**
 * Clears all central database observations and outages.
 */
export async function clearDatabase() {
  try {
    const url = `${BASE_URL}/api/db/clear`;
    const response = await fetch(url, { 
      method: 'POST',
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    console.log('[Storage Proxy] Database cleared successfully.');
    return true;
  } catch (err) {
    console.error('[Storage Proxy] clearDatabase failed:', err);
    return false;
  }
}

/**
 * Deletes records older than a specific date string (retention policy).
 */
export async function deleteOlderThan(limitDate) {
  try {
    const url = `${BASE_URL}/api/db/retention`;
    const response = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ limitDate })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    console.log(`[Storage Proxy] Retention policy enforced.`, data.results);
    return data.results || { observations: 0, outages: 0 };
  } catch (err) {
    console.error('[Storage Proxy] deleteOlderThan failed:', err);
    return { observations: 0, outages: 0 };
  }
}
