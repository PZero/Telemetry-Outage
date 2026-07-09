// IndexedDB manager for local storage persistence of UP telemetry and outages.

const DB_NAME = "UPTelemetryDB";
const DB_VERSION = 10;

let dbInstance = null;

/**
 * Initializes the IndexedDB database.
 * Sets up object stores:
 *  - 'observations' with key path 'key' (up_id|date|type)
 *  - 'outages' with key path 'outage_id' and index on 'up_id'
 */
export function initDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Observations store: key is "up_id|date|type"
      if (!db.objectStoreNames.contains("observations")) {
        db.createObjectStore("observations", { keyPath: "key" });
      }

      // Outages store: key is "outage_id"
      if (!db.objectStoreNames.contains("outages")) {
        const outageStore = db.createObjectStore("outages", { keyPath: "outage_id" });
        outageStore.createIndex("up_id", "up_id", { unique: false });
        outageStore.createIndex("startDate", "startDate", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      
      // Request persistent storage if available
      requestPersistentStorage();
      
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error("IndexedDB initialization error:", event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Requests browser persistent storage to prevent automatic eviction.
 */
async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`[Storage] Persistent storage granted: ${isPersisted ? "🟢 YES" : "🔴 NO (Best Effort)"}`);
      return isPersisted;
    } catch (err) {
      console.warn("[Storage] Error requesting persistence:", err);
    }
  }
  return false;
}

/**
 * Gets storage persistence status.
 */
export async function getPersistenceStatus() {
  if (navigator.storage && navigator.storage.persisted) {
    return await navigator.storage.persisted();
  }
  return false;
}

/**
 * Saves a single daily telemetry record for a specific type (meter/scada).
 * @param {string} upId 
 * @param {string} date YYYY-MM-DD
 * @param {string} type meter | scada
 * @param {Array<number|null>} values Flat array of telemetry points
 */
export async function saveObservations(upId, date, type, values) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("observations", "readwrite");
    const store = transaction.objectStore("observations");
    
    const key = `${upId}|${date}|${type}`;
    const record = {
      key,
      up_id: upId,
      date,
      type,
      values,
      updated_at: new Date().toISOString()
    };

    const request = store.put(record);

    request.onsuccess = () => resolve(true);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Retrieves a daily telemetry record.
 * @param {string} upId 
 * @param {string} date YYYY-MM-DD
 * @param {string} type meter | scada
 * @returns {Promise<Array<number|null>|null>}
 */
export async function getObservations(upId, date, type) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("observations", "readonly");
    const store = transaction.objectStore("observations");
    const key = `${upId}|${date}|${type}`;
    
    const request = store.get(key);

    request.onsuccess = (event) => {
      const result = event.target.result;
      resolve(result ? result.values : null);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Retrieves a daily telemetry record object with all metadata.
 * @param {string} upId 
 * @param {string} date YYYY-MM-DD
 * @param {string} type meter | scada
 * @returns {Promise<Object|null>}
 */
export async function getObservationRecord(upId, date, type) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("observations", "readonly");
    const store = transaction.objectStore("observations");
    const key = `${upId}|${date}|${type}`;
    
    const request = store.get(key);

    request.onsuccess = (event) => {
      resolve(event.target.result || null);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Saves outages in bulk.
 * @param {Array<Object>} outagesList 
 */
export async function saveOutages(outagesList) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    if (outagesList.length === 0) {
      resolve(true);
      return;
    }
    const transaction = db.transaction("outages", "readwrite");
    const store = transaction.objectStore("outages");

    transaction.oncomplete = () => resolve(true);
    transaction.onerror = (event) => reject(event.target.error);

    outagesList.forEach(outage => {
      // Ensure outage has an id
      if (!outage.outage_id) {
        outage.outage_id = `outage_${outage.up_id}_${outage.startDate.replace(/[:.-]/g, "")}`;
      }
      store.put(outage);
    });
  });
}

/**
 * Retrieves all outages registered for a specific UP.
 * @param {string} upId 
 * @returns {Promise<Array<Object>>}
 */
export async function getOutages(upId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("outages", "readonly");
    const store = transaction.objectStore("outages");
    const index = store.index("up_id");
    const request = index.getAll(upId);

    request.onsuccess = (event) => {
      resolve(event.target.result || []);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Get outages overlapping with a day/date range for a specific UP
 * @param {string} upId 
 * @param {string} startDateISO e.g. "2026-05-10T00:00:00Z"
 * @param {string} endDateISO e.g. "2026-05-10T23:59:59Z"
 */
export async function getOutagesForPeriod(upId, startDateISO, endDateISO) {
  const allOutages = await getOutages(upId);
  const start = new Date(startDateISO).getTime();
  const end = new Date(endDateISO).getTime();

  // Filter outages that intersect with the requested range
  return allOutages.filter(o => {
    const oStart = new Date(o.startDate).getTime();
    const oEnd = new Date(o.endDate).getTime();
    
    // Intersection condition: start of one is before or at end of another, and vice-versa
    return oStart <= end && oEnd >= start;
  });
}

/**
 * Clears all local database stores.
 */
export async function clearDatabase() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["observations", "outages"], "readwrite");
    const obsStore = transaction.objectStore("observations");
    const outStore = transaction.objectStore("outages");

    obsStore.clear();
    outStore.clear();

    transaction.oncomplete = () => {
      console.log("[Storage] Database cleared successfully.");
      resolve(true);
    };
    transaction.onerror = (event) => {
      console.error("[Storage] Error clearing database:", event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Deletes records older than a specific date string (retention policy enforcement).
 * @param {string} limitDate YYYY-MM-DD
 */
export async function deleteOlderThan(limitDate) {
  const db = await initDB();
  
  // Clean observations
  const obsPromise = new Promise((resolve, reject) => {
    const transaction = db.transaction("observations", "readwrite");
    const store = transaction.objectStore("observations");
    const request = store.openCursor();
    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const record = cursor.value;
        // Compare dates (e.g., "2026-04-12" < "2026-05-01")
        if (record.date < limitDate) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };
    request.onerror = (event) => reject(event.target.error);
  });

  // Clean outages
  const outPromise = new Promise((resolve, reject) => {
    const transaction = db.transaction("outages", "readwrite");
    const store = transaction.objectStore("outages");
    const request = store.openCursor();
    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const record = cursor.value;
        // Check if outage end date is before the limit date
        // Format of record.endDate is ISO String (e.g. "2026-04-12T14:30:00Z")
        const endDay = record.endDate.substring(0, 10);
        if (endDay < limitDate) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      } else {
        resolve(deletedCount);
      }
    };
    request.onerror = (event) => reject(event.target.error);
  });

  const [obsCount, outCount] = await Promise.all([obsPromise, outPromise]);
  console.log(`[Storage] Retention policy wiped: ${obsCount} observations, ${outCount} outages older than ${limitDate}.`);
  return { observations: obsCount, outages: outCount };
}
