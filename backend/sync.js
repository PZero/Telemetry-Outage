import { dbService } from './database.js';
import { enqueueRequest } from './queue.js';

let syncQueue = [];
let totalTasks = 0;
let completedTasks = 0;
let isSyncRunning = false;
let shouldCancelSync = false;
let activeSyncTasks = {};
let logs = [];

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logMsg = `[${timestamp}] ${message}`;
  logs.push(logMsg);
  if (logs.length > 500) {
    logs.shift();
  }
  console.log(`[SyncEngine] ${message}`);
}

export function getSyncStatus() {
  return {
    isSyncRunning,
    totalTasks,
    completedTasks,
    activeSyncTasks,
    logs
  };
}

export function cancelSync() {
  if (isSyncRunning) {
    shouldCancelSync = true;
    addLog("Richiesta interruzione sincronizzazione ricevuta. Il processo si arresterà al prossimo intervallo.");
  }
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function classifyDayIntegrity(up, dateStr) {
  const meterValues = await dbService.getObservations(up.id, dateStr, 'meter');
  const scadaValues = await dbService.getObservations(up.id, dateStr, 'scada');
  const outages = await dbService.getOutages(up.id);
  
  const dayStart = new Date(`${dateStr}T00:00:00Z`).getTime();
  const dayEnd = new Date(`${dateStr}T23:59:59Z`).getTime();
  const dayOutages = outages.filter(o => {
    const start = new Date(o.startDate).getTime();
    const end = new Date(o.endDate).getTime();
    return start <= dayEnd && end >= dayStart;
  });

  const countValids = (arr) => arr ? arr.filter(v => v !== null && v !== undefined).length : 0;
  const meterValids = countValids(meterValues);
  const scadaValids = countValids(scadaValues);

  if (!meterValues && !scadaValues) {
    if (dayOutages.length > 0) {
      const totalOutage = dayOutages.some(o => o.reductionPercentage === 100);
      return totalOutage ? 'grey' : 'red';
    }
    return 'red';
  }

  const stepsMeter = meterValues ? meterValues.length : 96;
  const stepsScada = scadaValues ? scadaValues.length : (up.tech === 'Wind' ? 144 : 96);

  if (up.scada_disabled || up.scada_disabled === 1) {
    if (meterValids === stepsMeter) return 'green';
    return 'orange';
  }

  if (meterValids === stepsMeter && scadaValids === stepsScada) {
    return 'green';
  }

  return 'orange';
}

export async function startSync(params, proxyToAzure) {
  if (isSyncRunning) {
    throw new Error("Una sincronizzazione è già in corso.");
  }

  const { rangeDays, isSelective, upId, simMode } = params;
  
  isSyncRunning = true;
  shouldCancelSync = false;
  totalTasks = 0;
  completedTasks = 0;
  activeSyncTasks = {};
  logs = [];
  syncQueue = [];

  addLog(`Avvio sincronizzazione storica (Giorni: ${rangeDays}, Selettiva: ${isSelective}, UP: ${upId}, Simulata: ${simMode})`);

  const syncDates = [];
  const startDay = new Date();
  startDay.setDate(startDay.getDate() - 1);
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(startDay);
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    syncDates.push(`${year}-${month}-${day}`);
  }

  try {
    const allUPs = await dbService.getRegistry();
    const targetUPs = (upId === 'all') ? allUPs : allUPs.filter(up => up.id === upId);

    addLog("Verifica dello stato del database locale...");
    
    const tasks = [];

    for (const up of targetUPs) {
      const meterDates = [];
      const scadaDates = [];
      const outagesDates = [];
      const noScada = (up.scada_disabled === 1 || up.scada_disabled === true);

      for (const dateStr of syncDates) {
        if (isSelective) {
          if (noScada) {
            const meterObs = await dbService.getObservations(up.id, dateStr, 'meter');
            const meterComplete = meterObs && !meterObs.includes(null);
            if (!meterComplete) {
              meterDates.push(dateStr);
            }
          } else {
            const status = await classifyDayIntegrity(up, dateStr);
            if (status !== 'green' && status !== 'grey') {
              const meterObs = await dbService.getObservations(up.id, dateStr, 'meter');
              const meterHasNulls = !meterObs || meterObs.includes(null);
              if (meterHasNulls) {
                meterDates.push(dateStr);
              }

              const scadaObs = await dbService.getObservations(up.id, dateStr, 'scada');
              const scadaHasNulls = !scadaObs || scadaObs.includes(null);
              if (scadaHasNulls) {
                scadaDates.push(dateStr);
              }
            }
          }

          const status = await classifyDayIntegrity(up, dateStr);
          if (status !== 'green' && status !== 'grey') {
            outagesDates.push(dateStr);
          }
        } else {
          meterDates.push(dateStr);
          if (!noScada) {
            scadaDates.push(dateStr);
          }
          outagesDates.push(dateStr);
        }
      }

      chunkArray(meterDates, 5).forEach(chunk => {
        tasks.push({ upId: up.id, dates: chunk, type: 'meter', upName: up.name, upTech: up.tech, simulated: simMode });
      });

      chunkArray(scadaDates, 5).forEach(chunk => {
        tasks.push({ upId: up.id, dates: chunk, type: 'scada', upName: up.name, upTech: up.tech, simulated: simMode, noScada: false });
      });

      if (!isSelective && noScada) {
        chunkArray(syncDates, 5).forEach(chunk => {
          tasks.push({ upId: up.id, dates: chunk, type: 'scada', upName: up.name, upTech: up.tech, simulated: simMode, noScada: true });
        });
      }

      chunkArray(outagesDates, 5).forEach(chunk => {
        tasks.push({ upId: up.id, dates: chunk, type: 'outages', upName: up.name, upTech: up.tech, simulated: simMode });
      });
    }

    if (tasks.length === 0) {
      addLog("Tutti i dati sono già completi nel database. Fine.");
      isSyncRunning = false;
      return;
    }

    syncQueue = tasks;
    totalTasks = tasks.length;
    addLog(`Generati ${tasks.length} blocchi di sincronizzazione. Avvio loop in background...`);

    // Run in background without awaiting
    runBackgroundLoop(proxyToAzure);

  } catch (err) {
    addLog(`ERRORE critico durante la generazione della coda: ${err.message}`);
    isSyncRunning = false;
  }
}

async function runBackgroundLoop(proxyToAzure) {
  while (syncQueue.length > 0 && !shouldCancelSync) {
    const task = syncQueue.shift();
    
    task.dates.forEach(d => {
      activeSyncTasks[`${task.upId}|${d}`] = true;
    });

    const sortedDates = [...task.dates].sort();
    const startDate = sortedDates[0];
    const endDate = sortedDates[sortedDates.length - 1];
    const datesInfo = task.dates.length === 1 ? task.dates[0] : `${startDate} al ${endDate} (${task.dates.length} gg)`;

    addLog(`Richiesta inviata: ${task.type.toUpperCase()} (${task.upName || task.upId}, Periodo: ${datesInfo})`);

    try {
      if (task.type === 'meter' || task.type === 'scada') {
        if (task.type === 'scada' && task.noScada) {
          const steps = (task.upTech === 'Wind') ? 144 : 96;
          const values = Array(steps).fill(null);
          for (const d of task.dates) {
            await dbService.saveObservations(task.upId, d, task.type, values);
          }
          addLog(`Completato: SCADA (${task.upName || task.upId}, Periodo: ${datesInfo}) -> OK. Marcata come NO-SCADA.`);
        } else {
          const valuesMap = await fetchObservationsFromAzureRange(task.upId, startDate, endDate, task.type, task.simulated, proxyToAzure, task.upTech, task.upName);
          for (const d of task.dates) {
            const values = valuesMap[d] || Array((task.upTech === 'Wind' && task.type === 'scada') ? 144 : 96).fill(null);
            await dbService.saveObservations(task.upId, d, task.type, values);
          }
          addLog(`Completato: ${task.type.toUpperCase()} (${task.upName || task.upId}, Periodo: ${datesInfo}) -> OK.`);
        }
      } else if (task.type === 'outages') {
        const outages = await fetchOutagesFromAzureRange(task.upId, startDate, endDate, task.simulated, proxyToAzure);
        await dbService.saveOutages(outages);
        addLog(`Completato: OUTAGES (${task.upName || task.upId}, Periodo: ${datesInfo}) -> OK.`);
      }
    } catch (err) {
      addLog(`ERRORE su ${task.type.toUpperCase()} (${task.upName || task.upId}, Periodo: ${datesInfo}): ${err.message || String(err)}`);
    }

    completedTasks++;
    
    task.dates.forEach(d => {
      delete activeSyncTasks[`${task.upId}|${d}`];
    });

    if (syncQueue.length > 0 && !shouldCancelSync) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  isSyncRunning = false;
  activeSyncTasks = {};

  if (shouldCancelSync) {
    addLog("Sincronizzazione storica interrotta dall'utente.");
  } else {
    addLog(`Sincronizzazione terminata con successo! ${completedTasks} blocchi gestiti.`);
  }
}

async function fetchObservationsFromAzureRange(upId, startDate, endDate, type, simulated, proxyToAzure, upTech, upName) {
  if (simulated) {
    const results = {};
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      results[dateStr] = generateMockObservations(upId, dateStr, type, upTech);
    }
    return results;
  }

  const startObj = new Date(`${startDate}T00:00:00Z`);
  const endObj = new Date(`${endDate}T00:00:00Z`);
  
  const prevDateObj = new Date(startObj.getTime() - 24 * 60 * 60 * 1000);
  const prevDateStr = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;

  const nextDateObj = new Date(endObj.getTime() + 24 * 60 * 60 * 1000);
  const nextDateStr = `${nextDateObj.getUTCFullYear()}-${String(nextDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDateObj.getUTCDate()).padStart(2, "0")}`;

  const reqBody = {
    from_UTC: `${prevDateStr}T21:00:00`,
    to_UTC: `${nextDateStr}T03:00:00`,
    update: false,
    upname: [upName || upId],
    aggregatedData: false,
    type: type,
    upId: upId,
    startDate: startDate,
    endDate: endDate
  };

  const rawData = await enqueueRequest('/api/observation', reqBody, async () => {
    return await proxyToAzure('/api/observation', reqBody);
  });

  const seriesLen = rawData?.tag?.series?.length ?? 'NO_SERIES';
  const sampleDates = rawData?.tag?.series
    ? [...new Set(rawData.tag.series.slice(0, 5).map(i => i.date))]
    : [];
  console.log(`[SyncEngine] Azure response for ${upName}/${type}: seriesLen=${seriesLen}, sampleDates=${JSON.stringify(sampleDates)}`);

  const results = {};
  const startD = new Date(startObj);
  for (let d = new Date(startD); d <= endObj; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const parsed = parseObservationResponse(rawData, upName || upId, upTech || "Solar", dateStr, type);
    const nonNull = parsed.filter(v => v !== null).length;
    console.log(`[SyncEngine] Parsed ${dateStr} ${type}: ${nonNull}/${parsed.length} non-null values`);
    results[dateStr] = parsed;
  }
  return results;
}

async function fetchOutagesFromAzureRange(upId, startDate, endDate, simulated, proxyToAzure) {
  if (simulated) {
    return generateMockOutages(upId, startDate, endDate);
  }

  const reqBody = {
    from_UTC: `${startDate}T00:00:00Z`,
    to_UTC: `${endDate}T23:59:59Z`,
    upname: [upId],
    upId: upId,
    startDate: startDate,
    endDate: endDate
  };

  const rawData = await enqueueRequest('/api/outage', reqBody, async () => {
    return await proxyToAzure('/api/outage', reqBody);
  });

  console.log(`[SyncEngine] Outage raw response for ${upId}: ${JSON.stringify(rawData).substring(0, 300)}`);

  // Parse outage response: Azure returns an array directly or wrapped
  let outageList = [];
  if (Array.isArray(rawData)) {
    outageList = rawData;
  } else if (rawData && Array.isArray(rawData.data)) {
    outageList = rawData.data;
  } else if (rawData && Array.isArray(rawData.outages)) {
    outageList = rawData.outages;
  } else if (rawData && Array.isArray(rawData.items)) {
    outageList = rawData.items;
  }

  // Normalize outage objects to our schema
  return outageList.map(o => ({
    outage_id: o.outage_id || o.id || `${upId}_${o.startDate || o.start_date || Date.now()}`,
    up_id: upId,
    startDate: o.startDate || o.start_date || o.from_UTC || startDate,
    endDate: o.endDate || o.end_date || o.to_UTC || endDate,
    reductionPercentage: o.reductionPercentage || o.reduction_percentage || o.reduction || 0,
    residualCapacity: o.residualCapacity || o.residual_capacity || 0,
    notes: o.notes || o.description || ''
  }));
}

function generateMockObservations(upId, date, type, tech) {
  const steps = (tech === 'Wind' && type === 'scada') ? 144 : 96;
  const values = [];
  const hash = upId.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const dateHash = date.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const seed = (hash + dateHash) % 100;
  
  for (let i = 0; i < steps; i++) {
    if (seed < 8 && i % 15 === 0) {
      values.push(null);
    } else {
      const base = type === 'meter' ? 8.0 : 7.8;
      const wave = Math.sin((i / steps) * Math.PI) * base;
      const noise = (Math.sin(i * 12.34) * 0.5);
      values.push(Math.max(0, parseFloat((wave + noise).toFixed(2))));
    }
  }
  return values;
}

function generateMockOutages(upId, startDate, endDate) {
  const outages = [];
  const startObj = new Date(startDate);
  const hash = upId.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  
  if (hash % 10 < 3) {
    const dStr = startObj.toISOString().split("T")[0];
    outages.push({
      outage_id: `${upId}_outage_${dStr}`,
      up_id: upId,
      startDate: `${dStr}T10:00:00Z`,
      endDate: `${dStr}T14:30:00Z`,
      reductionPercentage: 50,
      residualCapacity: 5.0,
      notes: "Limitazione programmata per manutenzione linea"
    });
  }
  return outages;
}

function parseObservationResponse(rawData, upId, tech, date, type) {
  let steps = type === 'scada' && tech === 'Wind' ? 144 : 96;
  if (!rawData || !rawData.tag || !rawData.tag.series) {
    return Array(steps).fill(null);
  }

  const series = rawData.tag.series;
  const values = Array(steps).fill(null);

  series.forEach(item => {
    if (!item.date || item.valore === undefined || item.valore === null) return;
    const adjustedDateObj = new Date(new Date(item.date).getTime() + 3600000);
    const romeDateStr = adjustedDateObj.toISOString().split("T")[0];
    if (romeDateStr !== date) return;

    const hours = adjustedDateObj.getHours();
    const minutes = adjustedDateObj.getMinutes();
    let index;
    if (steps === 144) {
      index = hours * 6 + Math.floor(minutes / 10);
    } else {
      index = hours * 4 + Math.floor(minutes / 15);
    }

    if (index >= 0 && index < steps) {
      values[index] = item.valore;
    }
  });

  return values;
}
