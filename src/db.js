// SQLite/PostgreSQL Database proxy manager for centralized storage.
// Replaces IndexedDB client-side storage with secure backend database calls.
// Optimized with request throttling and caching to prevent ERR_INSUFFICIENT_RESOURCES.

import { getAuthHeaders } from "./api.js";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

// --- REQUEST THROTTLING QUEUE (MAX 15 CONCURRENT FETCHES) ---
const MAX_CONCURRENT = 15;
let activeRequests = 0;
const requestQueue = [];

function throttledFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeRequests++;
      try {
        const response = await fetch(url, options);
        resolve(response);
      } catch (err) {
        reject(err);
      } finally {
        activeRequests--;
        processQueue();
      }
    };

    requestQueue.push(execute);
    processQueue();
  });
}

function processQueue() {
  if (activeRequests >= MAX_CONCURRENT || requestQueue.length === 0) return;
  const nextRequest = requestQueue.shift();
  nextRequest();
}

// --- IN-MEMORY CACHES FOR REDUNDANT REQUESTS ---
const outagesCache = {}; // upId -> Promise(outagesList)
const observationsCache = {}; // `${upId}|${date}|${type}` -> Promise(values)

export function clearClientCaches() {
  for (const k in outagesCache) delete outagesCache[k];
  for (const k in observationsCache) delete observationsCache[k];
  console.log('[Storage Proxy] Client-side memory caches cleared.');
}

/**
 * No-op initialization for compatibility.
 */
export function initDB() {
  clearClientCaches();
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
    const cacheKey = `${upId}|${date}|${type}`;
    // Invalidate observation cache on save
    delete observationsCache[cacheKey];

    const url = `${BASE_URL}/api/db/observations`;
    const response = await throttledFetch(url, {
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
 * Uses request throttling and memoization to prevent network congestion.
 */
export function getObservations(upId, date, type) {
  const cacheKey = `${upId}|${date}|${type}`;
  if (observationsCache[cacheKey]) {
    return observationsCache[cacheKey];
  }

  const fetchPromise = (async () => {
    try {
      const url = `${BASE_URL}/api/db/observations?upId=${upId}&date=${date}&type=${type}`;
      const response = await throttledFetch(url, {
        headers: getAuthHeaders()
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      return data.values || null;
    } catch (err) {
      console.error('[Storage Proxy] getObservations failed:', err);
      // Remove failed promise from cache so it can be retried if needed
      delete observationsCache[cacheKey];
      return null;
    }
  })();

  observationsCache[cacheKey] = fetchPromise;
  return fetchPromise;
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
    // Invalidate all outages cache on save
    for (const k in outagesCache) delete outagesCache[k];

    const url = `${BASE_URL}/api/db/outages`;
    const response = await throttledFetch(url, {
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
 * Memoized per UP to avoid dozens of redundant HTTP queries during fleet rendering.
 */
export function getOutages(upId) {
  if (outagesCache[upId]) {
    return outagesCache[upId];
  }

  const fetchPromise = (async () => {
    try {
      const url = `${BASE_URL}/api/db/outages?upId=${upId}`;
      const response = await throttledFetch(url, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      return data.outages || [];
    } catch (err) {
      console.error('[Storage Proxy] getOutages failed:', err);
      // Remove failed promise from cache
      delete outagesCache[upId];
      return [];
    }
  })();

  outagesCache[upId] = fetchPromise;
  return fetchPromise;
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
    clearClientCaches();
    const url = `${BASE_URL}/api/db/clear`;
    const response = await throttledFetch(url, { 
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
    const response = await throttledFetch(url, {
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
