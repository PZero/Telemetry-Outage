// Telemetry & Outage Integrity PWA Service Worker (sw.js)
// Handles background processing queue, Azure rate limiting (2s delay), and IndexedDB operations.

const CACHE_NAME = "up-integrity-cache-v87";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/logo.svg",
  "./src/main.js",
  "./src/db.js",
  "./src/api.js",
  "./src/ui.js",
  "./src/registry.js",
  "./src/styles.css"
];

// Seedable pseudo-random generator (copied for self-containment in SW worker thread)
function seedRandom(upId, dateStr, extra = "") {
  let str = upId + dateStr + extra;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(Math.sin(hash)) % 1;
}

// Active Task State
let currentActiveTask = null;

// IndexedDB Helper inside Service Worker
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("UPTelemetryDB", 10);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("observations")) {
        db.createObjectStore("observations", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("outages")) {
        const outageStore = db.createObjectStore("outages", { keyPath: "outage_id" });
        outageStore.createIndex("up_id", "up_id", { unique: false });
        outageStore.createIndex("startDate", "startDate", { unique: false });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function saveObservationsToDB(db, upId, date, type, values) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("observations", "readwrite");
    const store = transaction.objectStore("observations");
    const key = `${upId}|${date}|${type}`;
    
    // Get today's local date in Italy
    const todayRomeStr = getRomeTimeParts(new Date()).dateStr;
    
    const countValids = (arr) => arr ? arr.filter(v => v !== null && v !== undefined).length : 0;
    const newValids = countValids(values);

    const getRequest = store.get(key);
    getRequest.onsuccess = (e) => {
      const existing = e.target.result;
      let firstAttemptDate = todayRomeStr;
      let importedInDelay = false;
      let prevValids = 0;

      if (existing) {
        firstAttemptDate = existing.first_attempt_date || todayRomeStr;
        prevValids = countValids(existing.values);
        importedInDelay = existing.imported_in_delay || false;
        
        // If we previously attempted when it was empty (0 valids), and now we have data (>0 valids)
        // and the first attempt was on a different day than today
        if (prevValids === 0 && newValids > 0 && firstAttemptDate !== todayRomeStr) {
          if (type === "meter") {
            // For meter, it's only in delay if imported on or after D+2 (i.e. today > D+1)
            const obsDate = new Date(date);
            const dPlus1 = new Date(obsDate);
            dPlus1.setDate(dPlus1.getDate() + 1);
            const dPlus1Str = dPlus1.toISOString().split("T")[0];
            if (todayRomeStr > dPlus1Str) {
              importedInDelay = true;
            }
          } else {
            // For scada (or others), if imported on a different day, it's in delay
            importedInDelay = true;
          }
        }
      }

      const record = {
        key,
        up_id: upId,
        date,
        type,
        values,
        first_attempt_date: firstAttemptDate,
        import_date: newValids > 0 ? todayRomeStr : null,
        imported_in_delay: importedInDelay,
        api_error: false,
        api_error_message: null,
        updated_at: new Date().toISOString()
      };

      const putRequest = store.put(record);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = (err) => reject(err.target.error);
    };
    getRequest.onerror = (err) => reject(err.target.error);
  });
}

function saveObservationErrorToDB(db, upId, date, type, errorMessage) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("observations", "readwrite");
    const store = transaction.objectStore("observations");
    const key = `${upId}|${date}|${type}`;
    
    const todayRomeStr = getRomeTimeParts(new Date()).dateStr;
    
    const getRequest = store.get(key);
    getRequest.onsuccess = (e) => {
      const existing = e.target.result;
      
      const record = {
        key,
        up_id: upId,
        date,
        type,
        values: existing ? existing.values : null,
        first_attempt_date: existing ? (existing.first_attempt_date || todayRomeStr) : todayRomeStr,
        import_date: existing ? existing.import_date : null,
        imported_in_delay: existing ? existing.imported_in_delay : false,
        api_error: true,
        api_error_message: errorMessage,
        updated_at: new Date().toISOString()
      };
      
      const putRequest = store.put(record);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = (err) => reject(err.target.error);
    };
    getRequest.onerror = (err) => reject(err.target.error);
  });
}

function saveOutagesToDB(db, outages) {
  return new Promise((resolve, reject) => {
    if (outages.length === 0) {
      resolve();
      return;
    }
    const transaction = db.transaction("outages", "readwrite");
    const store = transaction.objectStore("outages");
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);

    outages.forEach(outage => {
      if (!outage.outage_id) {
        outage.outage_id = `outage_${outage.up_id}_${outage.startDate.replace(/[:.-]/g, "")}`;
      }
      store.put(outage);
    });
  });
}

// ----------------------------------------------------
// CACHE STRATEGY (Network First)
// ----------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Cache fetch interceptor: Network First, falling back to Cache
self.addEventListener("fetch", (event) => {
  // Bypasses Azure API and local dev web sockets / hot reloading
  if (event.request.url.includes("azure-api.net") || 
      event.request.url.includes("hot-update") || 
      event.request.url.includes("@vite") ||
      event.request.url.includes("/api-proxy") ||
      event.request.url.includes("/oauth-proxy")) {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache new static resources dynamically
        if (response.status === 200 && response.type === "basic") {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache if network is unavailable
        return caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Offline fallback for navigations
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
      })
  );
});

// ----------------------------------------------------
// SINGLE TASK PROCESSING DRIVEN BY MAIN THREAD
// ----------------------------------------------------
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;

  if (data.action === "PROCESS_SINGLE_TASK") {
    event.waitUntil(
      (async () => {
        const port = event.ports[0];
        const task = data.task;
        currentActiveTask = task;
        try {
          let details = "";
          if (task.type === "meter" || task.type === "scada") {
            let values;
            if (task.type === "scada" && task.noScada) {
              const steps = (task.upTech === "Wind") ? 144 : 96;
              values = Array(steps).fill(null);
              notifyClients({
                type: "SYNC_STATUS",
                log: `[Registry Info] UP ${task.upName || task.upId} marcata come NON censita SCADA. Salto chiamata API e scrivo null.`
              });
            } else if (task.simulated) {
              values = generateMockObservationsInternal(task.upId, task.date, task.type);
            } else {
              values = await fetchObservationsFromAzure(task.upId, task.date, task.type);
            }
            const db = await openDatabase();
            await saveObservationsToDB(db, task.upId, task.date, task.type, values);

            const total = values ? values.length : 0;
            const valid = values ? values.filter(v => v !== null && v !== undefined).length : 0;
            details = `Scritta telemetria (${total} punti, di cui ${valid} validi/non nulli)`;
          } else if (task.type === "outages") {
            let outages;
            if (task.simulated) {
              outages = generateMockOutagesInternal(task.upId, task.date, task.date);
            } else {
              outages = await fetchOutagesFromAzure(task.upId, task.date, task.date);
            }
            const db = await openDatabase();
            await saveOutagesToDB(db, outages);
            details = `Salvati ${outages ? outages.length : 0} record outages`;
          }

          if (port) {
            port.postMessage({ success: true, details });
          }
        } catch (err) {
          console.error("Single task execution failed:", err);
          
          if (task && (task.type === "meter" || task.type === "scada")) {
            try {
              const db = await openDatabase();
              await saveObservationErrorToDB(db, task.upId, task.date, task.type, err.message || String(err));
            } catch (dbErr) {
              console.error("Failed to save observation error to DB:", dbErr);
            }
          }

          if (port) {
            port.postMessage({ success: false, error: err.message || err });
          }
        } finally {
          currentActiveTask = null;
        }
      })()
    );
  }
});

// Send message to all connected clients (browsers tabs)
function notifyClients(message) {
  self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage(message);
    });
  });
}

// ----------------------------------------------------
// REAL HTTP FETCH METHODS FOR AZURE GATEWAY
// ----------------------------------------------------
function getRomeTimeParts(dateObj) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(dateObj);
  const partMap = {};
  parts.forEach(p => partMap[p.type] = p.value);
  
  let hourVal = parseInt(partMap.hour, 10);
  if (hourVal === 24) hourVal = 0;

  return {
    dateStr: `${partMap.year}-${partMap.month}-${partMap.day}`,
    hours: hourVal,
    minutes: parseInt(partMap.minute, 10)
  };
}

function requestNewTokenFromClient() {
  return new Promise((resolve, reject) => {
    const messageId = Math.random().toString(36).substring(2);
    
    const onMessage = (event) => {
      if (event.data && event.data.type === "TOKEN_REFRESH_RESPONSE" && event.data.messageId === messageId) {
        self.removeEventListener("message", onMessage);
        if (event.data.token) {
          resolve(event.data.token);
        } else {
          reject(new Error("Rinnovo token fallito o rifiutato dal client."));
        }
      }
    };
    
    self.addEventListener("message", onMessage);
    
    self.clients.matchAll().then(clients => {
      if (clients.length === 0) {
        self.removeEventListener("message", onMessage);
        reject(new Error("Nessun client controllato attivo per richiedere il token."));
        return;
      }
      clients.forEach(client => {
        client.postMessage({
          type: "TOKEN_REFRESH_REQUEST",
          messageId: messageId
        });
      });
    });
    
    setTimeout(() => {
      self.removeEventListener("message", onMessage);
      reject(new Error("Timeout attesa rinnovo token dal client."));
    }, 15000);
  });
}

async function fetchObservationsFromAzure(upId, date, type) {
  // Since names and technologies are needed, the UI will pass the name/tech inside the task context
  const name = currentActiveTask.upName || upId;
  const tech = currentActiveTask.upTech || "Solar";

  const baseUrl = currentActiveTask.apiUrl || "http://localhost:3000";
  const url = `${baseUrl}/api/observation`;

  const dateObj = new Date(`${date}T00:00:00Z`);
  const prevDateObj = new Date(dateObj.getTime() - 24 * 60 * 60 * 1000);
  const prevYear = prevDateObj.getUTCFullYear();
  const prevMonth = String(prevDateObj.getUTCMonth() + 1).padStart(2, "0");
  const prevDay = String(prevDateObj.getUTCDate()).padStart(2, "0");
  const prevDateStr = `${prevYear}-${prevMonth}-${prevDay}`;

  const nextDateObj = new Date(dateObj.getTime() + 24 * 60 * 60 * 1000);
  const nextYear = nextDateObj.getUTCFullYear();
  const nextMonth = String(nextDateObj.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(nextDateObj.getUTCDate()).padStart(2, "0");
  const nextDateStr = `${nextYear}-${nextMonth}-${nextDay}`;

  const reqBody = {
    from_UTC: `${prevDateStr}T21:00:00`,
    to_UTC: `${nextDateStr}T03:00:00`,
    update: false,
    upname: [name],
    aggregatedData: false,
    type: type,
    upId: upId,
    date: date
  };

  notifyClients({
    type: "SYNC_STATUS",
    log: `[REQ Backend] POST /api/observation | UP: ${name}`
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(reqBody)
  });

  notifyClients({
    type: "SYNC_STATUS",
    log: `[RES Backend] HTTP ${response.status} ${response.statusText}`
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    notifyClients({
      type: "SYNC_STATUS",
      log: `[RES Backend ERROR] Corpo: ${errorDetails.substring(0, 300)}`
    });
    throw new Error(`REST API HTTP ${response.status}: ${errorDetails}`);
  }

  const text = await response.text();
  
  // Default steps fallback
  let steps = (type === "scada" && tech === "Wind") ? 144 : 96;
  if (!text || text.trim() === "") {
    return Array(steps).fill(null);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON parsing failed: ${err.message}`);
  }

  if (!data || data.length === 0 || !data[0].tag) {
    return Array(steps).fill(null);
  }

  // Determine sampling steps dynamically from response metadata
  if (data[0].tag.samplingRate) {
    const rateStr = String(data[0].tag.samplingRate).toLowerCase();
    if (rateStr.includes("10")) {
      steps = 144;
    } else if (rateStr.includes("15")) {
      steps = 96;
    }
  }

  const values = Array(steps).fill(null);

  if (!data[0].tag.series) {
    return values;
  }

  const series = data[0].tag.series;
  series.forEach(item => {
    let dateObj;
    const dtStr = item.deliveryDateTime;
    if (dtStr && dtStr.includes("-") && dtStr.indexOf("-") === 2) {
      // European format: DD-MM-YYYY HH:mm:ss (e.g. "30-06-2026 00:00:00")
      const parts = dtStr.split(" ");
      if (parts.length >= 2) {
        const dateParts = parts[0].split("-");
        const timeParts = parts[1].split(":");
        if (dateParts.length === 3 && timeParts.length >= 2) {
          const day = parseInt(dateParts[0], 10);
          const month = parseInt(dateParts[1], 10) - 1; // 0-indexed
          const year = parseInt(dateParts[2], 10);
          const hour = parseInt(timeParts[0], 10);
          const minute = parseInt(timeParts[1], 10);
          const second = timeParts[2] ? parseInt(timeParts[2], 10) : 0;
          dateObj = new Date(Date.UTC(year, month, day, hour, minute, second));
        }
      }
    }
    
    if (!dateObj || isNaN(dateObj.getTime())) {
      dateObj = new Date(dtStr);
    }
    
    if (!dateObj || isNaN(dateObj.getTime())) return;

    // Apply the SCADA shift by subtracting 1 minute from the point time so that it aligns
    // with the start of the interval (the user said: "i timestamps scada rappresentano la fine dell'intervallo, mentre quelli meter l'inizio")
    let adjustedDateObj = dateObj;
    if (type === "scada") {
      adjustedDateObj = new Date(dateObj.getTime() - 60000); // subtract 1 minute (60,000 ms)
    }

    const romeParts = getRomeTimeParts(adjustedDateObj);
    if (romeParts.dateStr !== date) return;

    let bucketIdx = 0;
    if (steps === 96) {
      bucketIdx = romeParts.hours * 4 + Math.floor(romeParts.minutes / 15);
    } else {
      bucketIdx = romeParts.hours * 6 + Math.floor(romeParts.minutes / 10);
    }

    if (bucketIdx >= 0 && bucketIdx < steps) {
      values[bucketIdx] = Math.max(0, item.value);
    }
  });

  return values;
}

async function fetchOutagesFromAzure(upId, startDate, endDate) {
  const name = currentActiveTask.upName || upId;
  const baseUrl = currentActiveTask.apiUrl || "http://localhost:3000";
  const url = `${baseUrl}/api/outage`;
  const reqBody = {
    fromDate_UTC: `${startDate}T00:00:00+0000`,
    toDate_UTC: `${endDate}T23:59:59+0000`,
    limitationType: "ACTUALFACILITY, FACILITY, ACTUALGRID, GRID, ODD",
    upname: [name],
    provider: [],
    upId: upId,
    startDate: startDate,
    endDate: endDate
  };

  notifyClients({
    type: "SYNC_STATUS",
    log: `[REQ Backend] POST /api/outage | UP: ${name}`
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(reqBody)
  });

  notifyClients({
    type: "SYNC_STATUS",
    log: `[RES Backend] HTTP ${response.status} ${response.statusText}`
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    notifyClients({
      type: "SYNC_STATUS",
      log: `[RES Backend ERROR] Corpo: ${errorDetails.substring(0, 300)}`
    });
    throw new Error(`REST API HTTP ${response.status}: ${errorDetails}`);
  }

  const text = await response.text();
  const outages = [];
  if (!text || text.trim() === "") {
    return outages; // Return empty array if response body is empty
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON parsing failed: ${err.message}`);
  }

  if (!data || data.length === 0) return outages;

  data.forEach(item => {
    if (!item.outages) return;
    item.outages.forEach(out => {
      if (!out.scopes) return;
      out.scopes.forEach(scope => {
        const pct = parseFloat(scope.powerPercentage || "0");
        outages.push({
          outage_id: scope.protocolId || `out_${upId}_${Date.now()}_${Math.random()}`,
          up_id: upId,
          startDate: scope.fromDate,
          endDate: scope.toDate,
          reductionPercentage: 100 - pct, // powerPercentage is the available percentage, so reduction is 100 - available
          residualCapacity: pct,
          notes: scope.notes || "Outage via SW"
        });
      });
    });
  });

  return outages;
}

// ----------------------------------------------------
// INTERNAL HIGH-FIDELITY MOCK TELEMETRY GENERATOR FOR SW
// ----------------------------------------------------
function generateMockObservationsInternal(upId, date, type) {
  // Extract tech from task or default based on ID string
  const isWind = (currentActiveTask && currentActiveTask.upTech) ? currentActiveTask.upTech === "Wind" : upId.includes("WIND");
  const steps = type === "scada" && isWind ? 144 : 96;
  const values = Array(steps).fill(null);
  
  const daySeed = seedRandom(upId, date, "state");
  const discrepancySeed = seedRandom(upId, date, "discrepancy");
  const gapSeed = seedRandom(upId, date, "gaps");

  let scenario = "clean";
  if (daySeed < 0.75) {
    scenario = "clean";
  } else if (daySeed < 0.85) {
    scenario = "outage";
  } else if (daySeed < 0.95) {
    scenario = "gap";
  } else {
    scenario = "discrepancy";
  }

  if (scenario === "discrepancy") {
    const missingSource = discrepancySeed < 0.5 ? "scada" : "meter";
    if (type === missingSource) {
      return values;
    }
    scenario = "clean";
  }

  let gapStartBucket = -1;
  let gapEndBucket = -1;

  if (scenario === "outage") {
    const ratio = steps / 24;
    gapStartBucket = Math.floor(10 * ratio);
    gapEndBucket = Math.floor(14 * ratio);
  } else if (scenario === "gap") {
    const ratio = steps / 24;
    const startHour = 8 + Math.floor(gapSeed * 8);
    gapStartBucket = Math.floor(startHour * ratio);
    gapEndBucket = Math.floor((startHour + 2) * ratio);
  }

  // Set nominal capacity based on ID
  // Wind capacities 15-75, Solar capacities 5-35
  const upIndex = parseInt(upId.substring(8), 10) || 1;
  const nominal = isWind ? (15 + ((upIndex * 7) % 61)) : (5 + ((upIndex * 11) % 31));

  for (let i = 0; i < steps; i++) {
    if (i >= gapStartBucket && i <= gapEndBucket) {
      values[i] = null;
      continue;
    }

    if (seedRandom(upId, date, `drop-${type}-${i}`) < 0.01) {
      values[i] = null;
      continue;
    }

    const hour = (i / steps) * 24;
    let baseProduction = 0;

    if (!isWind) {
      // Solar Curve
      if (hour >= 6 && hour <= 20) {
        const peak = 13;
        const width = 4;
        baseProduction = nominal * Math.exp(-Math.pow(hour - peak, 2) / (2 * width * width));
      }
    } else {
      // Wind Curve
      const windCycle = Math.sin(hour * Math.PI / 12) * 0.3 + 
                         Math.cos(hour * Math.PI / 4) * 0.15 + 
                         0.5;
      baseProduction = nominal * Math.max(0.05, Math.min(0.95, windCycle));
    }

    const noise = (seedRandom(upId, date, `noise-${i}`) - 0.5) * 0.05 * nominal;
    values[i] = Math.max(0, parseFloat((baseProduction + noise).toFixed(2)));
  }

  return values;
}

function generateMockOutagesInternal(upId, startDateStr, endDateStr) {
  const dateStr = startDateStr; // Outage is computed single day
  const daySeed = seedRandom(upId, dateStr, "state");
  const outages = [];

  if (daySeed >= 0.75 && daySeed < 0.85) {
    const severitySeed = seedRandom(upId, dateStr, "severity");
    let pct = 100;
    if (severitySeed < 0.4) {
      pct = 40;
    } else if (severitySeed < 0.7) {
      pct = 70;
    }

    outages.push({
      outage_id: `outage_${upId}_${dateStr.replace(/-/g, "")}_1000`,
      up_id: upId,
      startDate: `${dateStr}T10:00:00Z`,
      endDate: `${dateStr}T14:00:00Z`,
      reductionPercentage: pct,
      residualCapacity: 100 - pct,
      notes: `Intervento programmato manutenzione - Riduzione ${pct}%`
    });
  }

  return outages;
}
