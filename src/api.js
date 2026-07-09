// API Client for Azure REST Gateway & high-fidelity Client-Side Mock Data Generator.

import { getUPById } from "./registry.js";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

/**
 * Builds standard request headers with Authorization Bearer token from active session.
 */
export function getAuthHeaders(extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  const session = localStorage.getItem("google_user_session");
  if (session) {
    try {
      const user = JSON.parse(session);
      if (user && user.token) {
        headers['Authorization'] = `Bearer ${user.token}`;
      }
    } catch (e) {}
  }
  return headers;
}

/**
 * Check if the application should use the Simulated API.
 * Defaults to true since the real API requires subscription/bearer tokens and CORS authorization.
 */
export function isSimulatedMode() {
  const stored = localStorage.getItem("use_simulated_api");
  if (stored === null) {
    // Default to true for zero-install demo experience
    localStorage.setItem("use_simulated_api", "true");
    return true;
  }
  return stored === "true";
}

export function setSimulatedMode(enabled) {
  localStorage.setItem("use_simulated_api", enabled ? "true" : "false");
}

/**
 * Fetches daily observations for a given UP, date, and type (scada/meter).
 * Maps API response format to flat arrays of 96 or 144 values.
 * @param {string} upId 
 * @param {string} date YYYY-MM-DD
 * @param {string} type scada | meter
 * @returns {Promise<Array<number|null>>}
 */
export async function fetchObservations(upId, date, type) {
  if (isSimulatedMode()) {
    return generateMockObservations(upId, date, type);
  }

  // Real Azure API post request via backend proxy
  const url = `${BASE_URL}/api/observation`;
  const up = getUPById(upId);
  if (!up) throw new Error(`UP ${upId} not found in registry.`);

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

  const response = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      from_UTC: `${prevDateStr}T21:00:00`,
      to_UTC: `${nextDateStr}T03:00:00`,
      update: false,
      upname: [up.name],
      aggregatedData: false,
      type: type,
      upId: upId,
      date: date
    })
  });

  if (!response.ok) {
    throw new Error(`Azure API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) {
    return data;
  }
  return parseObservationResponse(data, up, date, type);
}

/**
 * Fetches observations for a range of dates, returning an object mapping date strings to parsed arrays.
 */
export async function fetchObservationsRange(upId, startDate, endDate, type) {
  const up = getUPById(upId);
  if (!up) throw new Error(`UP ${upId} not found in registry.`);

  if (isSimulatedMode()) {
    const results = {};
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      results[dateStr] = generateMockObservations(upId, dateStr, type);
    }
    return results;
  }

  const url = `${BASE_URL}/api/observation`;
  const startObj = new Date(`${startDate}T00:00:00Z`);
  const endObj = new Date(`${endDate}T00:00:00Z`);
  
  const prevDateObj = new Date(startObj.getTime() - 24 * 60 * 60 * 1000);
  const prevDateStr = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;

  const nextDateObj = new Date(endObj.getTime() + 24 * 60 * 60 * 1000);
  const nextDateStr = `${nextDateObj.getUTCFullYear()}-${String(nextDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDateObj.getUTCDate()).padStart(2, "0")}`;

  const response = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      from_UTC: `${prevDateStr}T21:00:00`,
      to_UTC: `${nextDateStr}T03:00:00`,
      update: false,
      upname: [up.name],
      aggregatedData: false,
      type: type,
      upId: upId,
      startDate: startDate,
      endDate: endDate
    })
  });

  if (!response.ok) {
    throw new Error(`Azure API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  const results = {};
  const startD = new Date(startObj);
  for (let d = new Date(startD); d <= endObj; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    results[dateStr] = parseObservationResponse(data, up, dateStr, type);
  }
  return results;
}

/**
 * Fetches outages for a given UP and date range.
 * @param {string} upId 
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {Promise<Array<Object>>}
 */
export async function fetchOutages(upId, startDate, endDate) {
  if (isSimulatedMode()) {
    return generateMockOutages(upId, startDate, endDate);
  }

  const url = `${BASE_URL}/api/outage`;
  const up = getUPById(upId);
  if (!up) throw new Error(`UP ${upId} not found in registry.`);

  const response = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      fromDate_UTC: `${startDate}T00:00:00+0000`,
      toDate_UTC: `${endDate}T23:59:59+0000`,
      limitationType: "ACTUALFACILITY, FACILITY, ACTUALGRID, GRID, ODD",
      upname: [up.name],
      provider: [],
      upId: upId,
      startDate: startDate,
      endDate: endDate
    })
  });

  if (!response.ok) {
    throw new Error(`Azure API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return parseOutageResponse(data, upId);
}

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

/**
 * Parses observation response into structured IndexedDB-friendly flat array.
 */
function parseObservationResponse(data, up, date, type) {
  let steps = type === "scada" && up.tech === "Wind" ? 144 : 96;
  if (data && data[0] && data[0].tag && data[0].tag.samplingRate) {
    const rateStr = String(data[0].tag.samplingRate).toLowerCase();
    if (rateStr.includes("10")) {
      steps = 144;
    } else if (rateStr.includes("15")) {
      steps = 96;
    }
  }

  const values = Array(steps).fill(null);
  
  if (!data || data.length === 0 || !data[0].tag || !data[0].tag.series) {
    return values;
  }

  const series = data[0].tag.series;
  series.forEach(item => {
    let dateObj;
    const dtStr = item.deliveryDateTime;
    if (dtStr && dtStr.includes("-") && dtStr.indexOf("-") === 2) {
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

    let adjustedDateObj = dateObj;
    if (type === "scada") {
      adjustedDateObj = new Date(dateObj.getTime() - 60000);
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

/**
 * Parses outage response.
 */
function parseOutageResponse(data, upId) {
  const outages = [];
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
          startDate: scope.fromDate, // Expected as ISO
          endDate: scope.toDate,     // Expected as ISO
          reductionPercentage: pct,
          residualCapacity: 100 - pct,
          notes: scope.notes || "Outage declared via Azure API"
        });
      });
    });
  });

  return outages;
}

// ==========================================
// HIGH-FIDELITY CLIENT-SIDE MOCK GENERATOR
// ==========================================

// Seedable pseudo-random generator to make anomalies deterministic by UP and Date.
function seedRandom(upId, dateStr, extra = "") {
  let str = upId + dateStr + extra;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(Math.sin(hash)) % 1;
}

/**
 * Generates high-fidelity mock telemetry values.
 * Models clean days, data gaps, outages, and source discrepancies.
 */
function generateMockObservations(upId, date, type) {
  const up = getUPById(upId);
  const steps = type === "scada" && up.tech === "Wind" ? 144 : 96;
  const values = Array(steps).fill(null);
  
  // Deterministic daily state using seeds
  const daySeed = seedRandom(upId, date, "state");
  const discrepancySeed = seedRandom(upId, date, "discrepancy");
  const gapSeed = seedRandom(upId, date, "gaps");

  // Determine Daily Scenario:
  // 1. Clean Day (75% probability): data is complete in both streams
  // 2. Outage Day (10% probability): has gaps corresponding to outage intervals
  // 3. Unjustified Gap Day (10% probability): gaps exist, no outage registered
  // 4. Discrepancy Day (5% probability): one stream is complete, the other is completely empty
  
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

  // Handle Complete Discrepancy Scenario
  if (scenario === "discrepancy") {
    // SCADA or Meter is completely missing
    const missingSource = discrepancySeed < 0.5 ? "scada" : "meter";
    if (type === missingSource) {
      return values; // Completely empty
    }
    scenario = "clean"; // The other is clean
  }

  // Define Gaps for SCADA/Meter
  let gapStartBucket = -1;
  let gapEndBucket = -1;

  if (scenario === "outage") {
    // Gap corresponds to the outage period (e.g. from 10:00 to 14:00)
    // 10:00 is 10 hours * 4 = 40 (or 60 for Wind)
    const ratio = steps / 24;
    gapStartBucket = Math.floor(10 * ratio);
    gapEndBucket = Math.floor(14 * ratio);
  } else if (scenario === "gap") {
    // Unjustified gaps. For example a chunk of 2 hours at random time
    const ratio = steps / 24;
    const startHour = 8 + Math.floor(gapSeed * 8); // random between 8 and 16
    gapStartBucket = Math.floor(startHour * ratio);
    gapEndBucket = Math.floor((startHour + 2) * ratio);
  }

  // Generate curves depending on technology
  const nominal = up.capacity;
  for (let i = 0; i < steps; i++) {
    // Check if we are in a gap zone
    if (i >= gapStartBucket && i <= gapEndBucket) {
      values[i] = null;
      continue;
    }

    // Add some random dropouts (1% chance of individual packet drops)
    if (seedRandom(upId, date, `drop-${type}-${i}`) < 0.01) {
      values[i] = null;
      continue;
    }

    const hour = (i / steps) * 24;
    let baseProduction = 0;

    if (up.tech === "Solar") {
      // Solar Curve (bell curve during daylight hours 6:00 to 20:00)
      if (hour >= 6 && hour <= 20) {
        const peak = 13; // peak production around 13:00
        const width = 4;
        baseProduction = nominal * Math.exp(-Math.pow(hour - peak, 2) / (2 * width * width));
      }
    } else {
      // Wind Curve (cycles/fluctuations over 24 hours)
      const windCycle = Math.sin(hour * Math.PI / 12) * 0.3 + 
                         Math.cos(hour * Math.PI / 4) * 0.15 + 
                         0.5; // average 50% capacity
      baseProduction = nominal * Math.max(0.05, Math.min(0.95, windCycle));
    }

    // Add high-frequency noise
    const noise = (seedRandom(upId, date, `noise-${i}`) - 0.5) * 0.05 * nominal;
    values[i] = Math.max(0, parseFloat((baseProduction + noise).toFixed(2)));
  }

  return values;
}

/**
 * Generates high-fidelity mock outages.
 * If the day is designated as an Outage Day, it generates an outage matching the gaps.
 */
function generateMockOutages(upId, startDateStr, endDateStr) {
  const startDay = new Date(startDateStr);
  const endDay = new Date(endDateStr);
  const outages = [];

  // Loop through days in range and generate outages deterministically
  for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const daySeed = seedRandom(upId, dateStr, "state");

    // If daySeed matches the "outage" scenario condition (0.75 <= daySeed < 0.85)
    if (daySeed >= 0.75 && daySeed < 0.85) {
      const severitySeed = seedRandom(upId, dateStr, "severity");
      
      // Determine outage reduction (e.g. 30%, 50%, or 100% complete shut down)
      let pct = 100;
      if (severitySeed < 0.4) {
        pct = 40; // 40% reduction
      } else if (severitySeed < 0.7) {
        pct = 70; // 70% reduction
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
  }

  return outages;
}
