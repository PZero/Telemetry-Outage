// UI Rendering Logic for Telemetry & Outage Integrity Dashboard
// Manages Canvas-based Fleet Heatmap, Daily Ribbons, and Profile Charts.

import { getUPById, isScadaDisabled } from "./registry.js";
import { getObservations, getOutagesForPeriod, getObservationRecord } from "./db.js";

// Helper: Classifies the integrity of a single day for a UP
// Returns: 'green' | 'red' | 'orange' | 'grey'
export async function classifyDayIntegrity(up, dateStr) {
  const meterRecord = await getObservationRecord(up.id, dateStr, "meter");
  const scadaRecord = await getObservationRecord(up.id, dateStr, "scada");
  const meterValues = meterRecord ? meterRecord.values : null;
  const scadaValues = scadaRecord ? scadaRecord.values : null;
  const outages = await getOutagesForPeriod(up.id, `${dateStr}T00:00:00Z`, `${dateStr}T23:59:59Z`);

  let meterDelay = meterRecord ? meterRecord.imported_in_delay : false;
  if (meterDelay && meterRecord && meterRecord.import_date) {
    const obsDate = new Date(dateStr);
    const dPlus1 = new Date(obsDate);
    dPlus1.setDate(dPlus1.getDate() + 1);
    const dPlus1Str = dPlus1.toISOString().split("T")[0];
    if (meterRecord.import_date <= dPlus1Str) {
      meterDelay = false;
    }
  }

  const importedInDelay = meterDelay || (scadaRecord && scadaRecord.imported_in_delay) || false;
  const importDate = (meterDelay && meterRecord && meterRecord.import_date) || (scadaRecord && scadaRecord.imported_in_delay && scadaRecord.import_date) || null;

  const countValids = (arr) => arr ? arr.filter(v => v !== null && v !== undefined).length : 0;
  const meterValids = countValids(meterValues);
  const scadaValids = countValids(scadaValues);

  const stepsMeter = meterValues ? meterValues.length : 96;
  const stepsScada = scadaValues ? scadaValues.length : (up.tech === "Wind" ? 144 : 96);

  const isApiError = (meterRecord && meterRecord.api_error) || (scadaRecord && scadaRecord.api_error) || false;
  let apiErrorMessage = "";
  if (meterRecord && meterRecord.api_error) {
    apiErrorMessage += `[METER] ${meterRecord.api_error_message} `;
  }
  if (scadaRecord && scadaRecord.api_error) {
    apiErrorMessage += `[SCADA] ${scadaRecord.api_error_message}`;
  }
  apiErrorMessage = apiErrorMessage.trim();

  const wrapResult = (status) => {
    return { 
      status, 
      importedInDelay, 
      importDate,
      meterValids,
      meterSteps: stepsMeter,
      scadaValids,
      scadaSteps: stepsScada,
      apiError: isApiError,
      apiErrorMessage: apiErrorMessage,
      meterValues: meterValues,
      scadaValues: scadaValues
    };
  };

  // If no data exists in IndexedDB for both, check if we have outages covering the whole day
  if (!meterValues && !scadaValues) {
    if (outages.length > 0) {
      // Check if outages cover the full day (e.g. total shutdown)
      const totalOutage = outages.some(o => o.reductionPercentage === 100);
      return wrapResult(totalOutage ? "grey" : "red");
    }
    return wrapResult("red"); // Missing completely
  }

  // We will divide the day into 288 slots of 5 minutes to cross-examine
  let greenSlots = 0;
  let justifiedSlots = 0;
  let gapSlots = 0;
  let mismatchSlots = 0;

  const dayStart = new Date(`${dateStr}T00:00:00Z`).getTime();

  for (let j = 0; j < 288; j++) {
    const slotMin = j * 5;
    const timeMs = dayStart + slotMin * 60 * 1000;
    
    // Map to indices
    const mIdx = Math.floor(slotMin / 15);
    const sIdx = Math.floor(slotMin / (up.tech === "Wind" ? 10 : 15));

    const mVal = meterValues ? meterValues[mIdx] : null;
    const sVal = scadaValues ? scadaValues[sIdx] : null;

    const mOk = mVal !== null && mVal !== undefined;
    const sOk = sVal !== null && sVal !== undefined;

    // Check outage status at this slot time
    const activeOutage = outages.find(o => {
      const oStart = new Date(o.startDate).getTime();
      const oEnd = new Date(o.endDate).getTime();
      return timeMs >= oStart && timeMs <= oEnd;
    });

    if (mOk && sOk) {
      greenSlots++;
    } else if (!mOk && !sOk) {
      // Both are missing (true gap)
      if (activeOutage) {
        justifiedSlots++;
      } else {
        gapSlots++;
      }
    } else {
      // One is present, other is missing (flow mismatch)
      if (activeOutage) {
        justifiedSlots++;
      } else {
        mismatchSlots++;
      }
    }
  }

  // 1. If we have any slots with absolutely no telemetry (both missing, no outage)
  if (gapSlots > 0) {
    return wrapResult("red");
  }

  // 2. If we have any flow mismatches (one stream missing, the other present, no outage)
  if (mismatchSlots > 0) {
    return wrapResult("orange");
  }

  // 3. If there are missing telemetries but they are all covered by active outages
  if (justifiedSlots > 0) {
    return wrapResult("grey");
  }

  // 4. Otherwise, both streams are 100% complete
  return wrapResult("green");
}

/**
 * LEVEL 1: Render Fleet Heatmap Matrix on HTML5 Canvas
 */
let cachedCanvas = null;
let cachedUpList = null;
let cachedDateRange = null;
let cachedMatrixData = null;
let cachedOnCellClick = null;

export function redrawHeatmapCached() {
  if (cachedCanvas && cachedUpList && cachedDateRange && cachedMatrixData && cachedOnCellClick) {
    drawHeatmapCached(cachedCanvas, cachedUpList, cachedDateRange, cachedMatrixData, cachedOnCellClick);
  }
}
window.redrawHeatmapCached = redrawHeatmapCached;

export async function refreshCellStatusCached(upId, dateStr) {
  if (!cachedUpList || !cachedDateRange || !cachedMatrixData) return;
  const upIdx = cachedUpList.findIndex(up => up.id === upId);
  const dateIdx = cachedDateRange.indexOf(dateStr);
  if (upIdx !== -1 && dateIdx !== -1) {
    const up = cachedUpList[upIdx];
    const newStatus = await classifyDayIntegrity(up, dateStr);
    cachedMatrixData[upIdx][dateIdx] = newStatus;
    redrawHeatmapCached();
  }
}
window.refreshCellStatusCached = refreshCellStatusCached;

/**
 * LEVEL 1: Render Fleet Heatmap Matrix on HTML5 Canvas
 */
export async function renderFleetHeatmap(canvas, upList, dateRange, onCellClick) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const numUPs = upList.length;
  const numDays = dateRange.length;

  if (numUPs === 0 || numDays === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "14px Outfit";
    ctx.fillText("Nessuna UP corrispondente ai filtri selezionati.", 20, 40);
    return;
  }

  // Load status grid concurrently for performance before modifying canvas size to prevent white flickering
  const allRowsPromises = upList.map(async (up) => {
    return await Promise.all(dateRange.map(dateStr => classifyDayIntegrity(up, dateStr)));
  });
  const matrixData = await Promise.all(allRowsPromises);

  cachedCanvas = canvas;
  cachedUpList = upList;
  cachedDateRange = dateRange;
  cachedMatrixData = matrixData;
  cachedOnCellClick = onCellClick;

  drawHeatmapCached(canvas, upList, dateRange, matrixData, onCellClick);
}

export function drawHeatmapCached(canvas, upList, dateRange, matrixData, onCellClick) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const numUPs = upList.length;
  const numDays = dateRange.length;

  const dpr = window.devicePixelRatio || 1;
  const labelWidth = 160;
  const rowHeight = 22;
  const containerWidth = canvas.parentElement ? canvas.parentElement.clientWidth : canvas.clientWidth;
  const widthToUse = containerWidth > 200 ? containerWidth : 800;
  const colWidth = (widthToUse - labelWidth) / numDays;

  // Set sizing synchronously to prevent horizontal scrollbars
  canvas.width = widthToUse * dpr;
  canvas.height = (rowHeight * (numUPs + 1)) * dpr;
  canvas.style.width = widthToUse + "px";
  canvas.style.height = (rowHeight * (numUPs + 1)) + "px";
  ctx.scale(dpr, dpr);

  // Clear background
  ctx.fillStyle = "#0c101b";
  ctx.fillRect(0, 0, widthToUse, rowHeight * (numUPs + 1));

  // Draw Header dates
  ctx.fillStyle = "#9ca3af";
  ctx.font = "500 10px JetBrains Mono";
  ctx.textAlign = "center";
  
  dateRange.forEach((dateStr, colIdx) => {
    const x = labelWidth + colIdx * colWidth + colWidth / 2;
    const day = dateStr.substring(8, 10);
    const month = dateStr.substring(5, 7);
    if (colWidth > 20 || colIdx % 3 === 0) {
      ctx.fillText(`${day}/${month}`, x, 14);
    }
  });

  // Draw Grid Rows
  for (let r = 0; r < numUPs; r++) {
    const up = upList[r];
    const y = rowHeight * (r + 1);

    // Zebra striping background for row label
    ctx.fillStyle = r % 2 === 0 ? "rgba(22, 29, 47, 0.4)" : "rgba(18, 24, 36, 0.2)";
    ctx.fillRect(0, y, labelWidth, rowHeight);

    const noScada = isScadaDisabled(up.id);
    ctx.font = "600 11px Outfit";
    ctx.textAlign = "left";

    const maxChars = up.ppaTag ? 12 : 18;
    const displayName = up.name.length > maxChars ? up.name.substring(0, maxChars - 2) + "..." : up.name;

    ctx.fillStyle = noScada ? "#f59e0b" : "#f3f4f6";
    ctx.fillText(displayName, 8, y + 14);

    if (up.ppaTag) {
      const nameWidth = ctx.measureText(displayName).width;
      ctx.font = "400 8.5px Outfit";
      ctx.fillStyle = up.ppaColor ? up.ppaColor + "ad" : "rgba(255, 255, 255, 0.4)";
      ctx.fillText(`[${up.ppaTag}]`, 8 + nameWidth + 3, y + 13.5);
    }

    ctx.fillStyle = noScada ? "#f59e0b" : "#9ca3af";
    ctx.font = "300 9px Outfit";
    const techText = up.tech.toUpperCase() + (noScada ? " ⚠️" : "");
    ctx.fillText(techText, 125, y + 14);

    // Draw Day Cells
    for (let c = 0; c < numDays; c++) {
      const dateStr = dateRange[c];
      const statusObj = matrixData[r][c];
      const status = statusObj ? statusObj.status : null;
      const isDelay = statusObj ? statusObj.importedInDelay : false;
      const isApiError = statusObj ? statusObj.apiError : false;
      const x = labelWidth + c * colWidth;

      const taskKey = `${up.id}|${dateStr}`;
      const isActive = window.appState && window.appState.activeSyncTasks && window.appState.activeSyncTasks[taskKey];

      if (isActive) {
        // Draw updating state cell
        ctx.fillStyle = "#162032"; // Dark slate loading background
        ctx.fillRect(x + 1, y + 1, colWidth - 2, rowHeight - 2);

        // Draw rotating spinner
        const centerX = x + colWidth / 2;
        const centerY = y + rowHeight / 2;
        const radius = Math.min(colWidth, rowHeight) / 3.8;
        ctx.strokeStyle = "#3b82f6"; // Bright blue
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const rotationAngle = (Date.now() / 120) % (2 * Math.PI);
        ctx.arc(centerX, centerY, radius, rotationAngle, rotationAngle + 1.2 * Math.PI);
        ctx.stroke();
      } else {
        // Draw standard color cell
        let color = "#1e293b"; // Default empty
        if (status === "green") color = "#4ade80";      // Soft Green
        else if (status === "red") color = "#f87171";     // Soft Red
        else if (status === "orange") color = "#fbbf24";  // Soft Orange
        else if (status === "grey") color = "#9ca3af";    // Soft Grey

        ctx.fillStyle = color;
        ctx.fillRect(x + 1, y + 1, colWidth - 2, rowHeight - 2);

        // Draw production curves in transparency
        const mValues = statusObj ? statusObj.meterValues : null;
        const sValues = statusObj ? statusObj.scadaValues : null;

        if ((mValues && mValues.some(v => v !== null)) || (sValues && sValues.some(v => v !== null))) {
          const nominal = up.capacity || 10;
          let maxVal = nominal;
          if (mValues) mValues.forEach(v => { if (v !== null && v > maxVal) maxVal = v; });
          if (sValues) sValues.forEach(v => { if (v !== null && v > maxVal) maxVal = v; });

          // 1. Draw Meter area in semi-transparent white
          if (mValues && mValues.length > 0) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.beginPath();
            ctx.moveTo(x + 1, y + rowHeight - 1);
            let first = true;
            for (let i = 0; i < mValues.length; i++) {
              const val = mValues[i];
              const px = x + 1 + (i / (mValues.length - 1)) * (colWidth - 2);
              const py = (val !== null && val !== undefined)
                ? y + rowHeight - 1 - (Math.max(0, val) / maxVal) * (rowHeight - 3)
                : y + rowHeight - 1;
              if (first) {
                ctx.lineTo(px, py);
                first = false;
              } else {
                ctx.lineTo(px, py);
              }
            }
            ctx.lineTo(x + colWidth - 1, y + rowHeight - 1);
            ctx.closePath();
            ctx.fill();
          }

          // 2. Draw SCADA line in dark color to stand out from Meter area
          if (sValues && sValues.length > 0) {
            ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < sValues.length; i++) {
              const val = sValues[i];
              if (val !== null && val !== undefined) {
                const px = x + 1 + (i / (sValues.length - 1)) * (colWidth - 2);
                const py = y + rowHeight - 1 - (Math.max(0, val) / maxVal) * (rowHeight - 3);
                if (!started) {
                  ctx.moveTo(px, py);
                  started = true;
                } else {
                  ctx.lineTo(px, py);
                }
              } else {
                started = false;
              }
            }
            ctx.stroke();
          }
        }

        if (isDelay) {
          // Draw tiny clock icon in the top-right corner of the cell
          const cx = x + colWidth - 5;
          const cy = y + 5;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy - 2);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx + 1.5, cy);
          ctx.stroke();
        }

        if (isApiError) {
          // Draw tiny warning triangle in the bottom-left corner
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.moveTo(x + 2, y + rowHeight - 2);
          ctx.lineTo(x + 7, y + rowHeight - 2);
          ctx.lineTo(x + 4.5, y + rowHeight - 7);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }

  // Interactivity event registry
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    if (clickY > rowHeight) {
      const r = Math.floor((clickY - rowHeight) / rowHeight);
      if (r >= 0 && r < numUPs) {
        if (clickX <= labelWidth) {
          canvas.style.cursor = "pointer";
          showLabelTooltip(event.clientX, event.clientY, upList[r]);
        } else {
          const c = Math.floor((clickX - labelWidth) / colWidth);
          if (c >= 0 && c < numDays) {
            canvas.style.cursor = "pointer";
            const taskKey = `${upList[r].id}|${dateRange[c]}`;
            const isActive = window.appState && window.appState.activeSyncTasks && window.appState.activeSyncTasks[taskKey];
            const cellStatus = isActive ? "in aggiornamento" : matrixData[r][c];
            showTooltip(event.clientX, event.clientY, upList[r], dateRange[c], cellStatus);
          } else {
            canvas.style.cursor = "default";
            hideTooltip();
          }
        }
      } else {
        canvas.style.cursor = "default";
        hideTooltip();
      }
    } else {
      canvas.style.cursor = "default";
      hideTooltip();
    }
  };

  canvas.onmouseleave = () => {
    hideTooltip();
  };

  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    if (clickY > rowHeight) {
      const r = Math.floor((clickY - rowHeight) / rowHeight);
      if (r >= 0 && r < numUPs) {
        if (clickX <= labelWidth) {
          showUPActionMenu(event.clientX, event.clientY, upList[r].id, onCellClick, dateRange);
        } else {
          const c = Math.floor((clickX - labelWidth) / colWidth);
          if (c >= 0 && c < numDays) {
            showCellActionMenu(event.clientX, event.clientY, upList[r].id, dateRange[c], onCellClick);
          }
        }
      }
    }
  };

  // Render stats charts dynamically based on active fleet and time window
  renderFleetStats(upList, dateRange, matrixData);
}

function adjustMenuPosition(menu, clientX, clientY) {
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let adjustedLeft = clientX;
  let adjustedTop = clientY;

  if (clientX + menuWidth > viewportWidth) {
    adjustedLeft = viewportWidth - menuWidth - 12;
  }
  if (adjustedLeft < 12) adjustedLeft = 12;

  if (clientY + menuHeight > viewportHeight) {
    adjustedTop = viewportHeight - menuHeight - 12;
  }
  if (adjustedTop < 12) adjustedTop = 12;

  menu.style.left = `${adjustedLeft}px`;
  menu.style.top = `${adjustedTop}px`;
}

export function showUPActionMenu(clientX, clientY, upId, onCellClick, dateRange) {
  // Remove any existing menu first
  const existing = document.getElementById("cell-action-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "cell-action-menu";
  menu.style.position = "fixed";
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.style.background = "rgba(18, 24, 36, 0.95)";
  menu.style.border = "1px solid var(--panel-border)";
  menu.style.borderRadius = "8px";
  menu.style.padding = "6px 0";
  menu.style.boxShadow = "var(--shadow-xl)";
  menu.style.backdropFilter = "blur(8px)";
  menu.style.zIndex = "2000";
  menu.style.minWidth = "220px";
  menu.style.fontFamily = "var(--font-sans)";

  const title = document.createElement("div");
  title.style.padding = "6px 14px";
  title.style.fontSize = "0.7rem";
  title.style.color = "var(--text-muted)";
  title.style.borderBottom = "1px solid var(--panel-border)";
  title.style.marginBottom = "4px";
  title.style.fontWeight = "bold";
  title.innerText = `Opzioni UP: ${upId}`;
  menu.appendChild(title);

  // 1. Vai al Deep-Dive
  const btnDetail = document.createElement("button");
  btnDetail.style.width = "100%";
  btnDetail.style.background = "none";
  btnDetail.style.border = "none";
  btnDetail.style.color = "var(--text-main)";
  btnDetail.style.padding = "8px 14px";
  btnDetail.style.textAlign = "left";
  btnDetail.style.cursor = "pointer";
  btnDetail.style.fontSize = "0.78rem";
  btnDetail.style.display = "flex";
  btnDetail.style.alignItems = "center";
  btnDetail.style.gap = "8px";
  btnDetail.innerHTML = `<span>🔍</span> Apri Deep-Dive`;
  btnDetail.onmouseover = () => btnDetail.style.background = "rgba(59, 130, 246, 0.1)";
  btnDetail.onmouseout = () => btnDetail.style.background = "none";
  btnDetail.onclick = () => {
    menu.remove();
    onCellClick(upId, dateRange[dateRange.length - 1]);
  };
  menu.appendChild(btnDetail);

  // 2. Recupera Gap (Finestra Attiva)
  const btnRecover = document.createElement("button");
  btnRecover.style.width = "100%";
  btnRecover.style.background = "none";
  btnRecover.style.border = "none";
  btnRecover.style.color = "var(--text-main)";
  btnRecover.style.padding = "8px 14px";
  btnRecover.style.textAlign = "left";
  btnRecover.style.cursor = "pointer";
  btnRecover.style.fontSize = "0.78rem";
  btnRecover.style.display = "flex";
  btnRecover.style.alignItems = "center";
  btnRecover.style.gap = "8px";
  btnRecover.innerHTML = `<span>⚡</span> Recupera Gap (Finestra)`;
  btnRecover.onmouseover = () => btnRecover.style.background = "rgba(59, 130, 246, 0.1)";
  btnRecover.onmouseout = () => btnRecover.style.background = "none";
  btnRecover.onclick = () => {
    menu.remove();
    if (window.triggerUPSync) {
      window.triggerUPSync(upId, true);
    }
  };
  menu.appendChild(btnRecover);

  // 3. Riscrivi Dati (Finestra Attiva)
  const btnRewrite = document.createElement("button");
  btnRewrite.style.width = "100%";
  btnRewrite.style.background = "none";
  btnRewrite.style.border = "none";
  btnRewrite.style.color = "var(--text-main)";
  btnRewrite.style.padding = "8px 14px";
  btnRewrite.style.textAlign = "left";
  btnRewrite.style.cursor = "pointer";
  btnRewrite.style.fontSize = "0.78rem";
  btnRewrite.style.display = "flex";
  btnRewrite.style.alignItems = "center";
  btnRewrite.style.gap = "8px";
  btnRewrite.innerHTML = `<span>🔄</span> Forza Riscrivi (Finestra)`;
  btnRewrite.onmouseover = () => btnRewrite.style.background = "rgba(59, 130, 246, 0.1)";
  btnRewrite.onmouseout = () => btnRewrite.style.background = "none";
  btnRewrite.onclick = () => {
    menu.remove();
    if (window.triggerUPSync) {
      window.triggerUPSync(upId, false);
    }
  };
  menu.appendChild(btnRewrite);

  document.body.appendChild(menu);
  adjustMenuPosition(menu, clientX, clientY);

  // Close menu when clicking outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler, true);
    }
  };
  setTimeout(() => {
    document.addEventListener("click", closeHandler, true);
  }, 50);
}

export async function showCellActionMenu(clientX, clientY, upId, dateStr, onCellClick) {
  // Remove any existing menu first
  const existing = document.getElementById("cell-action-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "cell-action-menu";
  menu.style.position = "fixed";
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.style.background = "rgba(18, 24, 36, 0.95)";
  menu.style.border = "1px solid var(--panel-border)";
  menu.style.borderRadius = "8px";
  menu.style.padding = "6px 0";
  menu.style.boxShadow = "var(--shadow-xl)";
  menu.style.backdropFilter = "blur(8px)";
  menu.style.zIndex = "2000";
  menu.style.minWidth = "220px";
  menu.style.fontFamily = "var(--font-sans)";

  const title = document.createElement("div");
  title.style.padding = "6px 14px";
  title.style.fontSize = "0.7rem";
  title.style.color = "var(--text-muted)";
  title.style.borderBottom = "1px solid var(--panel-border)";
  title.style.marginBottom = "4px";
  title.innerText = `${upId} - ${dateStr}`;
  menu.appendChild(title);

  // Resolve cell integrity async and display error banner if present
  const up = getUPById(upId) || { id: upId };
  const cellStatus = await classifyDayIntegrity(up, dateStr);
  if (cellStatus.apiError && cellStatus.apiErrorMessage) {
    const errBox = document.createElement("div");
    errBox.style.margin = "6px 10px 6px 10px";
    errBox.style.padding = "8px 10px";
    errBox.style.background = "rgba(239, 68, 68, 0.08)";
    errBox.style.border = "1px solid rgba(239, 68, 68, 0.25)";
    errBox.style.borderRadius = "6px";
    errBox.style.color = "#fecaca";
    errBox.style.fontSize = "0.68rem";
    errBox.style.lineHeight = "1.3";
    errBox.style.userSelect = "text";
    errBox.innerHTML = `<span style="color:#ef4444; font-weight:700;">⚠️ Errore API:</span> ${cellStatus.apiErrorMessage}`;
    menu.appendChild(errBox);
  }

  const btnDetail = document.createElement("button");
  btnDetail.style.width = "100%";
  btnDetail.style.background = "none";
  btnDetail.style.border = "none";
  btnDetail.style.color = "var(--text-main)";
  btnDetail.style.padding = "8px 14px";
  btnDetail.style.textAlign = "left";
  btnDetail.style.cursor = "pointer";
  btnDetail.style.fontSize = "0.78rem";
  btnDetail.style.display = "flex";
  btnDetail.style.alignItems = "center";
  btnDetail.style.gap = "8px";
  btnDetail.innerHTML = `<span>🔍</span> Mostra Dettaglio`;
  btnDetail.onmouseover = () => btnDetail.style.background = "rgba(59, 130, 246, 0.1)";
  btnDetail.onmouseout = () => btnDetail.style.background = "none";
  btnDetail.onclick = () => {
    menu.remove();
    onCellClick(upId, dateStr);
  };
  menu.appendChild(btnDetail);

  const btnRefresh = document.createElement("button");
  btnRefresh.style.width = "100%";
  btnRefresh.style.background = "none";
  btnRefresh.style.border = "none";
  btnRefresh.style.color = "var(--text-main)";
  btnRefresh.style.padding = "8px 14px";
  btnRefresh.style.textAlign = "left";
  btnRefresh.style.cursor = "pointer";
  btnRefresh.style.fontSize = "0.78rem";
  btnRefresh.style.display = "flex";
  btnRefresh.style.alignItems = "center";
  btnRefresh.style.gap = "8px";
  btnRefresh.innerHTML = `<span>🔄</span> Forza Sincronizzazione`;
  btnRefresh.onmouseover = () => btnRefresh.style.background = "rgba(59, 130, 246, 0.1)";
  btnRefresh.onmouseout = () => btnRefresh.style.background = "none";
  btnRefresh.onclick = async () => {
    menu.remove();
    if (window.triggerDailyForceRefetchGlobal) {
      await window.triggerDailyForceRefetchGlobal(upId, dateStr);
    }
  };
  menu.appendChild(btnRefresh);

  document.body.appendChild(menu);
  adjustMenuPosition(menu, clientX, clientY);

  // Close menu when clicking outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener("click", closeHandler);
  }, 50);
}

function showTooltip(clientX, clientY, up, date, cellStatus) {
  const tooltip = document.getElementById("heatmap-tooltip");
  if (!tooltip) return;

  let status = "";
  let isDelay = false;
  let importDate = null;
  let meterValids = 0;
  let meterSteps = 96;
  let scadaValids = 0;
  let scadaSteps = 96;
  let isApiError = false;
  let apiErrorMessage = "";

  if (typeof cellStatus === "string") {
    status = cellStatus;
  } else if (cellStatus) {
    status = cellStatus.status;
    isDelay = cellStatus.importedInDelay;
    importDate = cellStatus.importDate;
    meterValids = cellStatus.meterValids || 0;
    meterSteps = cellStatus.meterSteps || 96;
    scadaValids = cellStatus.scadaValids || 0;
    scadaSteps = cellStatus.scadaSteps || 96;
    isApiError = cellStatus.apiError || false;
    apiErrorMessage = cellStatus.apiErrorMessage || "";
  }

  let desc = "Completo";
  if (status === "red") desc = "Buchi dati non giustificati";
  else if (status === "orange") desc = "Discrepanza Meter vs SCADA";
  else if (status === "grey") desc = "Dati assenti (Manutenzione dichiarata)";
  else if (status === "in aggiornamento") desc = "🔄 Acquisizione dati in corso...";

  let delayHtml = "";
  if (isDelay && importDate) {
    delayHtml = `<br/><span style="color:#f59e0b; font-weight:600;">🕒 Importato in ritardo il: ${importDate}</span>`;
  }

  let countsHtml = "";
  if (status !== "in aggiornamento") {
    countsHtml = `<br/><strong>Misure:</strong> METER: <span style="font-family:var(--font-mono); color:#60a5fa">${meterValids}/${meterSteps}</span> | SCADA: <span style="font-family:var(--font-mono); color:#34d399">${scadaValids}/${scadaSteps}</span>`;
  }

  let apiErrorHtml = "";
  if (isApiError && apiErrorMessage) {
    apiErrorHtml = `<br/><span style="color:#f87171; font-weight:600;">⚠️ Errore API: ${apiErrorMessage}</span>`;
  }

  tooltip.innerHTML = `
    <strong style="color:#60a5fa">${up.name} (${up.id})</strong><br/>
    <strong>Giorno:</strong> ${date}<br/>
    <strong>Regione:</strong> ${up.region} | <strong>Cap:</strong> ${up.capacity} MW<br/>
    <strong>Stato:</strong> <span style="color:${
      status === "green" ? "#4ade80" : status === "red" ? "#f87171" : status === "orange" ? "#fbbf24" : status === "grey" ? "#9ca3af" : "#60a5fa"
    }">${desc}</span>${countsHtml}${apiErrorHtml}${delayHtml}
  `;
  
  tooltip.style.display = "block";
  const tooltipWidth = tooltip.offsetWidth || 220;
  const tooltipHeight = tooltip.offsetHeight || 130;
  
  let left = clientX + 15;
  let top = clientY + 15;
  if (left + tooltipWidth > window.innerWidth) {
    left = clientX - tooltipWidth - 15;
  }
  if (top + tooltipHeight > window.innerHeight) {
    top = clientY - tooltipHeight - 15;
  }
  tooltip.style.left = `${Math.max(10, left)}px`;
  tooltip.style.top = `${Math.max(10, top)}px`;
}

function hideTooltip() {
  const tooltip = document.getElementById("heatmap-tooltip");
  if (tooltip) tooltip.style.display = "none";
}

export function showLabelTooltip(clientX, clientY, up) {
  const tooltip = document.getElementById("heatmap-tooltip");
  if (!tooltip) return;

  const noScada = isScadaDisabled(up.id);
  const scadaStatusHtml = noScada 
    ? `<span style="color:#f59e0b; font-weight:600; font-size:0.75rem;">⚠️ Non censita in SCADA (Solo Meter)</span><br/>` 
    : "";

  tooltip.innerHTML = `
    <strong style="color:#60a5fa">${up.name} (${up.id})</strong><br/>
    ${scadaStatusHtml}
    <span style="color:var(--text-muted); font-size:0.75rem;">Fai clic per visualizzare il dettaglio dell'UP</span>
  `;
  
  tooltip.style.display = "block";
  const tooltipWidth = tooltip.offsetWidth || 220;
  const tooltipHeight = tooltip.offsetHeight || 60;
  
  let left = clientX + 15;
  let top = clientY + 15;
  if (left + tooltipWidth > window.innerWidth) {
    left = clientX - tooltipWidth - 15;
  }
  if (top + tooltipHeight > window.innerHeight) {
    top = clientY - tooltipHeight - 15;
  }
  tooltip.style.left = `${Math.max(10, left)}px`;
  tooltip.style.top = `${Math.max(10, top)}px`;
}


/**
 * LEVEL 2: Render UP Daily Ribbons (DOM elements)
 */
export async function renderUPDailyRibbons(container, upId, dateStr, onRefetchClick) {
  let up = getUPById(upId);
  if (!up) {
    const isWind = upId.toLowerCase().includes("wind");
    up = {
      id: upId,
      name: upId,
      tech: isWind ? "Wind" : "Solar",
      region: "Sicilia",
      capacity: isWind ? 25 : 10
    };
  }

  // Retrieve values from IndexedDB safely
  let meterValues = null;
  let scadaValues = null;
  let outages = [];
  try {
    meterValues = await getObservations(upId, dateStr, "meter");
    scadaValues = await getObservations(upId, dateStr, "scada");
    outages = await getOutagesForPeriod(upId, `${dateStr}T00:00:00Z`, `${dateStr}T23:59:59Z`) || [];
  } catch (err) {
    console.error(`[DB Error] Failed to load observations for ${upId} on ${dateStr}:`, err);
  }

  // Create ribbon wrapper
  const block = document.createElement("div");
  block.className = "ribbon-day-block";
  block.dataset.date = dateStr;

  // Title bar
  const titleBar = document.createElement("div");
  titleBar.className = "ribbon-day-title";
  titleBar.innerHTML = `
    <div>Giorno: <span style="color:#60a5fa">${dateStr}</span></div>
    <div class="ribbon-day-actions">
      <button class="icon-btn refetch-day-btn" style="font-size: 0.75rem; padding: 4px 8px;">
        🔄 Forza Aggiornamento Giornaliero
      </button>
    </div>
  `;
  block.appendChild(titleBar);

  // Hook force refetch event
  titleBar.querySelector(".refetch-day-btn").onclick = () => {
    onRefetchClick(upId, dateStr);
  };

  // Loading Overlay
  const overlay = document.createElement("div");
  overlay.className = "ribbon-loading-overlay";
  overlay.innerHTML = `<span>Sincronizzazione in corso...</span>`;
  block.appendChild(overlay);

  // Ribbons aligning grid
  const wrapper = document.createElement("div");
  wrapper.className = "ribbons-alignment-wrapper";

  // Lane 1: Meter (96 blocks)
  const laneMeter = createLaneElement("Meter (15m)", 96, meterValues, outages, "meter");
  wrapper.appendChild(laneMeter);

  // Lane 2: SCADA (96 or 144 blocks)
  const scadaSteps = scadaValues ? scadaValues.length : (up.tech === "Wind" ? 144 : 96);
  const laneScada = createLaneElement(`SCADA (${scadaSteps === 144 ? "10m" : "15m"})`, scadaSteps, scadaValues, outages, "scada");
  wrapper.appendChild(laneScada);

  // Lane 3: Outages (Outage blocks overlapping the timeline)
  const laneOutages = createOutageLaneElement(outages);
  wrapper.appendChild(laneOutages);

  block.appendChild(wrapper);
  container.appendChild(block);
}

function createLaneElement(label, steps, values, outages, type) {
  const row = document.createElement("div");
  row.className = "ribbon-row";

  const labelEl = document.createElement("div");
  labelEl.className = "ribbon-label";
  labelEl.innerText = label;
  row.appendChild(labelEl);

  const bar = document.createElement("div");
  bar.className = "ribbon-bar";

  for (let i = 0; i < steps; i++) {
    const cell = document.createElement("div");
    cell.className = "ribbon-cell";
    
    const val = values ? values[i] : null;

    if (val !== null && val !== undefined) {
      cell.className += " active";
      cell.style.backgroundColor = "#10b981"; // Intense Green (matches fleet view)
      cell.title = `Slot ${i + 1} (${formatIndexToTime(i, steps)}): ${val} MW`;
    } else {
      // Check if this time slot is covered by an outage
      const isCovered = checkSlotOutageCoverage(i, steps, outages);
      if (isCovered.active) {
        cell.className += isCovered.percentage === 100 ? " outage-100" : " outage-partial";
        cell.style.backgroundColor = isCovered.percentage === 100 ? "#4b5563" : "rgba(75, 85, 99, 0.6)"; // Outage dark grey
        cell.title = `Slot ${i + 1} (${formatIndexToTime(i, steps)}): Assente (Giustificato Outage ${isCovered.percentage}%)`;
      } else {
        cell.className += " empty";
        cell.style.backgroundColor = "#ef4444"; // Red for unjustified missing data
        cell.title = `Slot ${i + 1} (${formatIndexToTime(i, steps)}): Assente (NON Giustificato)`;
      }
    }
    bar.appendChild(cell);
  }

  row.appendChild(bar);
  return row;
}

function createOutageLaneElement(outages) {
  const row = document.createElement("div");
  row.className = "ribbon-row";

  const labelEl = document.createElement("div");
  labelEl.className = "ribbon-label";
  labelEl.innerText = "Outages";
  row.appendChild(labelEl);

  const bar = document.createElement("div");
  bar.className = "ribbon-bar";
  bar.style.backgroundColor = "transparent";
  bar.style.border = "1px solid rgba(75, 85, 99, 0.3)";

  if (outages.length === 0) {
    const noOutages = document.createElement("div");
    noOutages.style.width = "100%";
    noOutages.style.height = "100%";
    noOutages.style.display = "flex";
    noOutages.style.alignItems = "center";
    noOutages.style.justifyContent = "center";
    noOutages.style.fontSize = "0.7rem";
    noOutages.style.color = "var(--text-muted)";
    noOutages.innerText = "Nessuna indisponibilità registrata";
    bar.appendChild(noOutages);
  } else {
    outages.forEach(outage => {
      // Calculate relative start/end offset percentages on 24 hours (1440 mins)
      const startMin = timeToMinutesFromMidnight(outage.startDate);
      const endMin = timeToMinutesFromMidnight(outage.endDate);

      const leftPct = (startMin / 1440) * 100;
      const widthPct = ((endMin - startMin) / 1440) * 100;

      const block = document.createElement("div");
      block.style.position = "absolute";
      block.style.left = `${leftPct}%`;
      block.style.width = `${widthPct}%`;
      block.style.height = "100%";
      
      // Opacity represents outage severity
      const opacity = outage.reductionPercentage / 100;
      block.style.backgroundColor = `rgba(139, 92, 246, ${Math.max(0.2, opacity)})`; // Purple theme for outages
      block.style.borderLeft = "2px solid #8b5cf6";
      block.style.borderRight = "2px solid #8b5cf6";
      block.title = `Outage: ${outage.notes || ""}\nDurata: ${outage.startDate.substring(11, 16)} - ${outage.endDate.substring(11, 16)}\nRiduzione: ${outage.reductionPercentage}%`;
      
      bar.appendChild(block);
    });
  }

  row.appendChild(bar);
  return row;
}

function checkSlotOutageCoverage(slotIdx, steps, outages) {
  if (outages.length === 0) return { active: false };

  const minutesPerStep = 1440 / steps;
  const slotStartMins = slotIdx * minutesPerStep;
  const slotEndMins = slotStartMins + minutesPerStep;

  // Find if slot intersects with any outage
  const activeOutage = outages.find(o => {
    const oStartMins = timeToMinutesFromMidnight(o.startDate);
    const oEndMins = timeToMinutesFromMidnight(o.endDate);
    // Overlap condition
    return oStartMins < slotEndMins && oEndMins > slotStartMins;
  });

  if (activeOutage) {
    return {
      active: true,
      percentage: activeOutage.reductionPercentage
    };
  }

  return { active: false };
}

function formatIndexToTime(idx, steps) {
  const minsPerStep = 1440 / steps;
  const totalMins = idx * minsPerStep;
  const h = Math.floor(totalMins / 60);
  const m = Math.floor(totalMins % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinutesFromMidnight(isoString) {
  const d = new Date(isoString);
  return d.getHours() * 60 + d.getMinutes();
}


/**
 * LEVEL 3: Render Production curves and Theoretical capacity ceilings on Canvas
 */
export async function renderProfileChart(canvas, upId, dateStr) {
  let up = getUPById(upId);
  if (!up) {
    const isWind = upId.toLowerCase().includes("wind");
    up = {
      id: upId,
      name: upId,
      tech: isWind ? "Wind" : "Solar",
      region: "Sicilia",
      capacity: null
    };
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Fetch data safely
  let meterValues = null;
  let scadaValues = null;
  let outages = [];
  try {
    meterValues = await getObservations(upId, dateStr, "meter");
    scadaValues = await getObservations(upId, dateStr, "scada");
    outages = await getOutagesForPeriod(upId, `${dateStr}T00:00:00Z`, `${dateStr}T23:59:59Z`) || [];
  } catch (err) {
    console.error(`[DB Error] Failed to load chart data for ${upId} on ${dateStr}:`, err);
  }

  // Calculate maximum telemetry value dynamically
  let maxVal = 0;
  if (meterValues) {
    meterValues.forEach(v => {
      if (v !== null) {
        const displayVal = Math.max(0, v);
        if (displayVal > maxVal) maxVal = displayVal;
      }
    });
  }
  if (scadaValues) {
    scadaValues.forEach(v => {
      if (v !== null) {
        const displayVal = Math.max(0, v);
        if (displayVal > maxVal) maxVal = displayVal;
      }
    });
  }

  const nominalCapacity = up.capacity;
  const isTelemetryInKw = maxVal > 150;
  const scaledNominalCapacity = isTelemetryInKw ? (nominalCapacity * 1000) : nominalCapacity;
  
  let maxY = Math.max(maxVal, scaledNominalCapacity);
  if (maxY <= 0) maxY = 10;
  maxY = maxY * 1.1; // Add 10% ceiling room

  const unitStr = isTelemetryInKw ? "kW" : "MW";

  const paddingLeft = 50;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;

  // Base drawing function for redrawing
  function drawBase(ctx, width, height, dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const chartWidth = width - paddingLeft - paddingRight;
    const chartHeight = height - paddingTop - paddingBottom;

    // Update table headers to match unit
    const meterHeader = document.querySelector("#detail-values-table th:nth-child(2)");
    const scadaHeader = document.querySelector("#detail-values-table th:nth-child(3)");
    const capHeader = document.querySelector("#detail-values-table th:nth-child(4)");
    
    if (meterHeader) meterHeader.innerText = `Meter (${unitStr})`;
    if (scadaHeader) {
      scadaHeader.style.display = "";
      scadaHeader.innerText = `SCADA (${unitStr})`;
    }
    if (capHeader) {
      capHeader.style.display = scaledNominalCapacity ? "" : "none";
    }

    // Draw grid lines (Y-axis: division lines for capacity)
    ctx.strokeStyle = "rgba(75, 85, 99, 0.2)";
    ctx.lineWidth = 1;
    
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const val = (maxY / yTicks) * i;
      const y = paddingTop + chartHeight - (val / maxY) * chartHeight;
      
      ctx.beginPath();
      ctx.moveTo(paddingLeft, y);
      ctx.lineTo(paddingLeft + chartWidth, y);
      ctx.stroke();

      ctx.fillStyle = "#9ca3af";
      ctx.font = "9px JetBrains Mono";
      ctx.textAlign = "right";
      ctx.fillText(`${val.toFixed(1)} ${unitStr}`, paddingLeft - 8, y + 3);
    }

    // Draw X axis grid lines (Time: every 4 hours: 00:00, 04:00, etc.)
    for (let h = 0; h <= 24; h += 4) {
      const x = paddingLeft + (h / 24) * chartWidth;
      
      ctx.beginPath();
      ctx.moveTo(x, paddingTop);
      ctx.lineTo(x, paddingTop + chartHeight);
      ctx.stroke();

      ctx.fillStyle = "#9ca3af";
      ctx.font = "9px JetBrains Mono";
      ctx.textAlign = "center";
      ctx.fillText(`${String(h).padStart(2, "0")}:00`, x, paddingTop + chartHeight + 16);
    }

    if (scaledNominalCapacity) {
      // Draw Theoretical Cap shadow area and border line
      const capPoints = [];
      for (let i = 0; i < 144; i++) {
        const tMin = i * 10;
        const timeMs = new Date(`${dateStr}T00:00:00Z`).getTime() + tMin * 60 * 1000;
        
        const activeOutage = outages.find(o => {
          const oStart = new Date(o.startDate).getTime();
          const oEnd = new Date(o.endDate).getTime();
          return timeMs >= oStart && timeMs <= oEnd;
        });

        const reduction = activeOutage ? activeOutage.reductionPercentage : 0;
        const cap = scaledNominalCapacity * (1 - reduction / 100);
        
        const xStart = paddingLeft + (tMin / 1440) * chartWidth;
        const xEnd = paddingLeft + ((tMin + 10) / 1440) * chartWidth;
        const y = paddingTop + chartHeight - (cap / maxY) * chartHeight;
        capPoints.push({ xStart, xEnd, y });
      }

      ctx.fillStyle = "rgba(59, 130, 246, 0.05)"; // Very light sky blue glow
      ctx.beginPath();
      ctx.moveTo(paddingLeft, paddingTop + chartHeight);
      capPoints.forEach(pt => {
        ctx.lineTo(pt.xStart, pt.y);
        ctx.lineTo(pt.xEnd, pt.y);
      });
      ctx.lineTo(paddingLeft + chartWidth, paddingTop + chartHeight);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "#8b5cf6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      capPoints.forEach((pt, idx) => {
        if (idx === 0) {
          ctx.moveTo(pt.xStart, pt.y);
        } else {
          ctx.lineTo(pt.xStart, pt.y);
        }
        ctx.lineTo(pt.xEnd, pt.y);
      });
      ctx.stroke();
      ctx.setLineDash([]); // Reset line dash
    }

    // Draw telemetry curves
    // 1. Meter Curve (96 points, solid Blue line) - Stepped & Clamped
    if (meterValues) {
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      let started = false;
      for (let i = 0; i < 96; i++) {
        const val = meterValues[i];
        if (val !== null && val !== undefined) {
          const displayVal = Math.max(0, val); // Clamp below zero values to 0 for chart presentation
          const xStart = paddingLeft + (i / 96) * chartWidth;
          const xEnd = paddingLeft + ((i + 1) / 96) * chartWidth;
          const y = paddingTop + chartHeight - (displayVal / maxY) * chartHeight;
          
          if (!started) {
            ctx.moveTo(xStart, y);
            started = true;
          } else {
            ctx.lineTo(xStart, y);
          }
          ctx.lineTo(xEnd, y);
        } else {
          started = false; // Break line on nulls
        }
      }
      ctx.stroke();
    }

    // 2. SCADA Curve (96 or 144 points, dotted/dashed Emerald line) - Stepped & Clamped
    if (scadaValues) {
      const scadaSteps = scadaValues.length;
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]); // Tiny dots
      ctx.beginPath();
      
      let started = false;
      for (let i = 0; i < scadaSteps; i++) {
        const val = scadaValues[i];
        if (val !== null && val !== undefined) {
          const displayVal = Math.max(0, val); // Clamp below zero values to 0
          const xStart = paddingLeft + (i / scadaSteps) * chartWidth;
          const xEnd = paddingLeft + ((i + 1) / scadaSteps) * chartWidth;
          const y = paddingTop + chartHeight - (displayVal / maxY) * chartHeight;
          
          if (!started) {
            ctx.moveTo(xStart, y);
            started = true;
          } else {
            ctx.lineTo(xStart, y);
          }
          ctx.lineTo(xEnd, y);
        } else {
          started = false;
        }
      }
      ctx.stroke();
      ctx.setLineDash([]); // Reset
    }

    // Legend markers inside chart
    ctx.font = "10px Outfit";
    ctx.textAlign = "left";
    
    // Meter label
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(paddingLeft + 10, paddingTop + 5, 12, 6);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText("Meter", paddingLeft + 28, paddingTop + 11);

    // SCADA label
    ctx.fillStyle = "#10b981";
    ctx.fillRect(paddingLeft + 80, paddingTop + 5, 12, 6);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText("SCADA", paddingLeft + 98, paddingTop + 11);

    if (scaledNominalCapacity) {
      // Theoretical limit label
      ctx.strokeStyle = "#8b5cf6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(paddingLeft + 150, paddingTop + 8);
      ctx.lineTo(paddingLeft + 165, paddingTop + 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#9ca3af";
      ctx.fillText("Tetto Teorico (Outages)", paddingLeft + 172, paddingTop + 11);
    }
  }

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  // Initial draw
  drawBase(ctx, width, height, dpr);

  // Populate dynamic table view
  const tbody = document.getElementById("detail-values-tbody");
  if (tbody) {
    tbody.innerHTML = ""; // Clear
    const steps = scadaValues ? scadaValues.length : (up.tech === "Wind" ? 144 : 96);
    const minsPerStep = 1440 / steps;
    
    // Setup CSV content array in window for exporting
    window.currentTableDataCsv = [];
    if (scaledNominalCapacity) {
      window.currentTableDataCsv.push(["Ora (UTC)", `Meter (${unitStr})`, `SCADA (${unitStr})`, `Tetto Outage (${unitStr})`, "Stato"]);
    } else {
      window.currentTableDataCsv.push(["Ora (UTC)", `Meter (${unitStr})`, `SCADA (${unitStr})`, "Stato"]);
    }

    for (let i = 0; i < steps; i++) {
      const timeStr = formatIndexToTime(i, steps);
      
      // Map Meter (96 steps) to current time slot
      const meterIdx = Math.floor((i * minsPerStep) / 15);
      const mVal = (meterValues && meterValues[meterIdx] !== null) ? meterValues[meterIdx] : null;
      
      // Map SCADA to current time slot
      const sVal = (scadaValues && scadaValues[i] !== null) ? scadaValues[i] : null;
      
      // Map Outages
      const tMin = i * minsPerStep;
      const timeMs = new Date(`${dateStr}T00:00:00Z`).getTime() + tMin * 60 * 1000;
      const activeOutage = outages.find(o => {
        const oStart = new Date(o.startDate).getTime();
        const oEnd = new Date(o.endDate).getTime();
        return timeMs >= oStart && timeMs <= oEnd;
      });
      
      const reduction = activeOutage ? activeOutage.reductionPercentage : 0;
      const capVal = scaledNominalCapacity * (1 - reduction / 100);
      
      let status = "OK";
      if (mVal === null && sVal === null) {
        status = activeOutage ? "Gap Giustificato (Outage)" : "Gap Non Giustificato";
      } else if (mVal === null || sVal === null) {
        status = "Discrepanza Flussi";
      }
      
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid var(--panel-border)";
      tr.style.height = "35px";
      
      // We print the exact raw values (even if negative) in the table for full transparency!
      const mText = mVal !== null ? `${mVal.toFixed(3)}` : "-";
      const sText = sVal !== null ? `${sVal.toFixed(3)}` : "-";
      const capText = `${capVal.toFixed(2)}`;
      
      let statusStyle = "color: #10b981;"; // green
      if (status.includes("Non Giustificato")) statusStyle = "color: #ef4444;"; // red
      else if (status.includes("Outage")) statusStyle = "color: #9ca3af;"; // grey
      else if (status.includes("Discrepanza")) statusStyle = "color: #f59e0b;"; // orange

      const capTd = scaledNominalCapacity ? `<td style="padding: 8px 10px; font-family: var(--font-mono);">${capText}</td>` : "";

      tr.innerHTML = `
        <td style="padding: 8px 10px; font-family: var(--font-mono);">${timeStr}</td>
        <td style="padding: 8px 10px; font-family: var(--font-mono);">${mText}</td>
        <td style="padding: 8px 10px; font-family: var(--font-mono);">${sText}</td>
        ${capTd}
        <td style="padding: 8px 10px; font-weight: 600; ${statusStyle}">${status}</td>
      `;
      tbody.appendChild(tr);
      
      if (scaledNominalCapacity) {
        window.currentTableDataCsv.push([timeStr, mText, sText, capText, status]);
      } else {
        window.currentTableDataCsv.push([timeStr, mText, sText, status]);
      }
    }
  }

  // INTERACTION EVENTS
  let tooltipTimeout = null;
  const tooltipEl = document.getElementById("chart-tooltip");

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const chartWidth = width - paddingLeft - paddingRight;
    const chartHeight = height - paddingTop - paddingBottom;

    // Reset view to clear old crosshairs
    drawBase(ctx, width, height, dpr);
    if (tooltipEl) tooltipEl.style.display = "none";
    if (tooltipTimeout) clearTimeout(tooltipTimeout);

    // If mouse inside chart canvas grid area
    if (mouseX >= paddingLeft && mouseX <= paddingLeft + chartWidth &&
        mouseY >= paddingTop && mouseY <= paddingTop + chartHeight) {
      
      const pctX = (mouseX - paddingLeft) / chartWidth;
      const mins = pctX * 1440;
      const hours = Math.floor(mins / 60);
      const minutes = Math.floor(mins % 60);
      const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

      // 1. Draw vertical and horizontal grey dashed crosshair lines
      ctx.strokeStyle = "rgba(156, 163, 175, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      // Vertical
      ctx.beginPath();
      ctx.moveTo(mouseX, paddingTop);
      ctx.lineTo(mouseX, paddingTop + chartHeight);
      ctx.stroke();

      // Horizontal
      ctx.beginPath();
      ctx.moveTo(paddingLeft, mouseY);
      ctx.lineTo(paddingLeft + chartWidth, mouseY);
      ctx.stroke();
      ctx.setLineDash([]); // Reset line dash

      // 2. Identify current time slot values
      const meterIdx = Math.floor(mins / 15);
      const mVal = (meterValues && meterIdx >= 0 && meterIdx < 96) ? meterValues[meterIdx] : null;

      const scadaSteps = scadaValues ? scadaValues.length : 96;
      const scadaIdx = Math.floor(mins / (1440 / scadaSteps));
      const sVal = (scadaValues && scadaIdx >= 0 && scadaIdx < scadaSteps) ? scadaValues[scadaIdx] : null;

      const tMin = Math.floor(mins / 10) * 10;
      const timeMs = new Date(`${dateStr}T00:00:00Z`).getTime() + tMin * 60 * 1000;
      const activeOutage = outages.find(o => {
        const oStart = new Date(o.startDate).getTime();
        const oEnd = new Date(o.endDate).getTime();
        return timeMs >= oStart && timeMs <= oEnd;
      });
      const reduction = activeOutage ? activeOutage.reductionPercentage : 0;
      const capVal = scaledNominalCapacity * (1 - reduction / 100);

      // Draw highlighting dots on curves
      const drawHighlightDot = (val, color) => {
        const displayVal = Math.max(0, val);
        const y = paddingTop + chartHeight - (displayVal / maxY) * chartHeight;

        ctx.fillStyle = color;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mouseX, y, 4.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      };

      if (mVal !== null) drawHighlightDot(mVal, "#3b82f6"); // Blue dot
      if (sVal !== null) drawHighlightDot(sVal, "#10b981"); // Green dot
      if (scaledNominalCapacity) drawHighlightDot(capVal, "#8b5cf6"); // Purple dot

      // 3. Debounce Tooltip (Show when mouse stops moving for 200ms)
      tooltipTimeout = setTimeout(() => {
        if (!tooltipEl) return;

        const mText = mVal !== null ? `${mVal.toFixed(3)} ${unitStr}` : "N/D";
        const sText = sVal !== null ? `${sVal.toFixed(3)} ${unitStr}` : "N/D";
        const capText = scaledNominalCapacity ? `${capVal.toFixed(2)} ${unitStr}` : null;

        let outageInfo = "";
        if (scaledNominalCapacity) {
          outageInfo = `
            <div style="margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px; color:#c084fc;">
              <span style="font-weight:600; color:#c084fc;">Tetto Outage:</span> ${capText}
            </div>
            ${activeOutage ? `<div style="font-size:0.7rem; color:#f472b6; margin-top:2px;">⚠️ Outage: ${activeOutage.notes}</div>` : ""}
          `;
        }

        tooltipEl.innerHTML = `
          <div style="font-weight:bold; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px; margin-bottom:6px; font-family:var(--font-mono); color:#9ca3af;">
            Ora (UTC): ${timeStr}
          </div>
          <div style="display:flex; justify-content:space-between; gap:20px; margin-bottom:3px;">
            <span style="color:#60a5fa; font-weight:600;">Meter:</span>
            <span style="font-family:var(--font-mono);">${mText}</span>
          </div>
          <div style="display:flex; justify-content:space-between; gap:20px;">
            <span style="color:#34d399; font-weight:600;">SCADA:</span>
            <span style="font-family:var(--font-mono);">${sText}</span>
          </div>
          ${outageInfo}
        `;

        tooltipEl.style.display = "block";
        const tooltipWidth = tooltipEl.offsetWidth || 180;
        const tooltipHeight = tooltipEl.offsetHeight || 100;
        
        let left = event.pageX + 15;
        let top = event.pageY - 20;
        
        if (left + tooltipWidth > window.innerWidth) {
          left = event.pageX - tooltipWidth - 15;
        }
        if (top + tooltipHeight > window.innerHeight + window.scrollY) {
          top = event.pageY - tooltipHeight - 15;
        }
        
        tooltipEl.style.left = `${Math.max(10, left)}px`;
        tooltipEl.style.top = `${Math.max(10, top)}px`;
      }, 250); // 250ms delay
    }
  };

  canvas.onmouseleave = () => {
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    if (tooltipEl) tooltipEl.style.display = "none";
    drawBase(ctx, width, height, dpr); // Restore clean chart
  };
}

let statsAnimationId = null;

export function renderFleetStats(upList, dateRange, matrixData) {
  // 1. Calculate KPI values
  const numUPs = upList.length;
  const numDays = dateRange.length;
  
  if (numUPs === 0 || numDays === 0) {
    document.getElementById("kpi-completeness").innerText = "--%";
    document.getElementById("kpi-gaps").innerText = "0";
    document.getElementById("kpi-discrepancies").innerText = "0";
    document.getElementById("kpi-outages").innerText = "0";
    return;
  }

  let totalMeterValids = 0;
  let totalMeterSteps = 0;
  let totalScadaValids = 0;
  let totalScadaSteps = 0;

  let totalRedDays = 0;
  let totalOrangeDays = 0;
  let totalGreyDays = 0;

  for (let r = 0; r < numUPs; r++) {
    const up = upList[r];
    for (let c = 0; c < numDays; c++) {
      const cell = matrixData[r][c];
      if (cell) {
        totalMeterValids += cell.meterValids || 0;
        totalMeterSteps += cell.meterSteps || 96;
        if (!isScadaDisabled(up.id)) {
          totalScadaValids += cell.scadaValids || 0;
          totalScadaSteps += cell.scadaSteps || (up.tech === "Wind" ? 144 : 96);
        }

        if (cell.status === "red") totalRedDays++;
        else if (cell.status === "orange") totalOrangeDays++;
        else if (cell.status === "grey") totalGreyDays++;
      }
    }
  }

  const meterCompleteness = totalMeterSteps > 0 ? (totalMeterValids / totalMeterSteps) * 100 : 0;
  const scadaCompleteness = totalScadaSteps > 0 ? (totalScadaValids / totalScadaSteps) * 100 : 0;
  const averageCompleteness = totalScadaSteps > 0 
    ? (meterCompleteness + scadaCompleteness) / 2 
    : meterCompleteness;

  // Animate KPI numbers counter
  const kpiCompletenessEl = document.getElementById("kpi-completeness");
  const kpiGapsEl = document.getElementById("kpi-gaps");
  const kpiDiscrepanciesEl = document.getElementById("kpi-discrepancies");
  const kpiOutagesEl = document.getElementById("kpi-outages");

  // 2. Setup Animation loop
  if (statsAnimationId) {
    cancelAnimationFrame(statsAnimationId);
  }

  const duration = 800; // 800ms
  const start = performance.now();

  function animate(now) {
    const elapsed = now - start;
    const progress = Math.min(1, elapsed / duration);
    // Cubic ease-out
    const alpha = 1 - Math.pow(1 - progress, 3);

    // Update KPI numbers dynamically during animation
    if (kpiCompletenessEl) kpiCompletenessEl.innerText = `${(averageCompleteness * alpha).toFixed(1)}%`;
    if (kpiGapsEl) kpiGapsEl.innerText = Math.round(totalRedDays * alpha).toLocaleString();
    if (kpiDiscrepanciesEl) kpiDiscrepanciesEl.innerText = Math.round(totalOrangeDays * alpha).toLocaleString();
    if (kpiOutagesEl) kpiOutagesEl.innerText = Math.round(totalGreyDays * alpha).toLocaleString();

    renderTrendChart(dateRange, upList, matrixData, alpha);
    renderWorstPerformersChart(upList, dateRange, matrixData, alpha);
    renderDonutCharts(upList, dateRange, matrixData, alpha);
    renderRegionalChart(upList, dateRange, matrixData, alpha);
    renderProcessFeasibility(upList, dateRange, matrixData, alpha);

    if (progress < 1) {
      statsAnimationId = requestAnimationFrame(animate);
    } else {
      statsAnimationId = null;
    }
  }

  statsAnimationId = requestAnimationFrame(animate);
}

function renderTrendChart(dateRange, upList, matrixData, alpha = 1) {
  const canvas = document.getElementById("trend-chart-canvas");
  if (!canvas) return;
  if (canvas.parentElement.offsetWidth === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.offsetWidth || 400;
  const height = canvas.parentElement.offsetHeight || 260;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const numDays = dateRange.length;
  const numUPs = upList.length;
  if (numDays === 0 || numUPs === 0) return;

  const dataPoints = [];
  for (let c = 0; c < numDays; c++) {
    let green = 0, red = 0, orange = 0, grey = 0;
    for (let r = 0; r < numUPs; r++) {
      const statusObj = matrixData[r][c];
      const status = statusObj ? statusObj.status : "red";
      if (status === "green") green++;
      else if (status === "red") red++;
      else if (status === "orange") orange++;
      else if (status === "grey") grey++;
      else red++;
    }
    const total = numUPs;
    dataPoints.push({
      date: dateRange[c],
      green: (green / total) * 100,
      red: (red / total) * 100,
      orange: (orange / total) * 100,
      grey: (grey / total) * 100
    });
  }

  const margin = { top: 15, right: 15, bottom: 25, left: 35 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  function drawTrend(hoverColIdx) {
    ctx.clearRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let pct = 0; pct <= 100; pct += 25) {
      const y = margin.top + h - (pct / 100) * h;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + w, y);
      ctx.stroke();

      // Axis label
      ctx.fillStyle = "#9ca3af";
      ctx.font = "10px JetBrains Mono";
      ctx.textAlign = "right";
      ctx.fillText(`${pct}%`, margin.left - 6, y + 3);
    }

    // Stacked Area curves
    const states = ["grey", "red", "orange", "green"];
    const colors = {
      grey: "rgba(156, 163, 175, 0.45)",
      red: "rgba(248, 113, 113, 0.55)",
      orange: "rgba(251, 191, 36, 0.55)",
      green: "rgba(74, 222, 128, 0.55)"
    };

    states.forEach((stateKey, stateIdx) => {
      ctx.fillStyle = colors[stateKey];
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top + h);

      for (let i = 0; i < numDays; i++) {
        const dp = dataPoints[i];
        const px = margin.left + (i / (numDays - 1)) * w;
        let cumulativeVal = 0;
        for (let s = 0; s <= stateIdx; s++) {
          cumulativeVal += dp[states[s]];
        }
        const py = margin.top + h - (cumulativeVal / 100) * h * alpha;
        ctx.lineTo(px, py);
      }

      for (let i = numDays - 1; i >= 0; i--) {
        const dp = dataPoints[i];
        const px = margin.left + (i / (numDays - 1)) * w;
        let cumulativeVal = 0;
        for (let s = 0; s < stateIdx; s++) {
          cumulativeVal += dp[states[s]];
        }
        const py = margin.top + h - (cumulativeVal / 100) * h * alpha;
        ctx.lineTo(px, py);
      }

      ctx.closePath();
      ctx.fill();
    });

    // Draw X axis labels
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px JetBrains Mono";
    ctx.textAlign = "center";
    
    const firstDate = dateRange[0].substring(8, 10) + "/" + dateRange[0].substring(5, 7);
    const lastDate = dateRange[numDays - 1].substring(8, 10) + "/" + dateRange[numDays - 1].substring(5, 7);
    ctx.fillText(firstDate, margin.left, margin.top + h + 15);
    ctx.fillText(lastDate, margin.left + w, margin.top + h + 15);

    if (numDays > 2) {
      const midIdx = Math.floor(numDays / 2);
      const midDate = dateRange[midIdx].substring(8, 10) + "/" + dateRange[midIdx].substring(5, 7);
      const midX = margin.left + (midIdx / (numDays - 1)) * w;
      ctx.fillText(midDate, midX, margin.top + h + 15);
    }

    if (hoverColIdx !== null && hoverColIdx >= 0 && hoverColIdx < numDays) {
      const hx = margin.left + (hoverColIdx / (numDays - 1)) * w;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, margin.top);
      ctx.lineTo(hx, margin.top + h);
      ctx.stroke();

      states.forEach((stateKey, stateIdx) => {
        let cumulativeVal = 0;
        for (let s = 0; s <= stateIdx; s++) {
          cumulativeVal += dataPoints[hoverColIdx][states[s]];
        }
        const hy = margin.top + h - (cumulativeVal / 100) * h;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(hx, hy, 3, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
  }

  drawTrend(null);

  const tooltipEl = document.getElementById("chart-tooltip");

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    if (clickX >= margin.left && clickX <= margin.left + w) {
      const hoverColIdx = Math.round(((clickX - margin.left) / w) * (numDays - 1));
      drawTrend(hoverColIdx);

      const dp = dataPoints[hoverColIdx];
      if (tooltipEl) {
        tooltipEl.style.display = "block";
        tooltipEl.style.left = `${event.pageX + 15}px`;
        tooltipEl.style.top = `${event.pageY + 15}px`;
        tooltipEl.innerHTML = `
          <strong style="color:#60a5fa">${dp.date}</strong><br/>
          🟢 Green: <span style="font-family:var(--font-mono); font-weight:600; color:#4ade80">${Math.round(dp.green)}%</span><br/>
          🔴 Red: <span style="font-family:var(--font-mono); font-weight:600; color:#f87171">${Math.round(dp.red)}%</span><br/>
          🟡 Orange: <span style="font-family:var(--font-mono); font-weight:600; color:#fbbf24">${Math.round(dp.orange)}%</span><br/>
          ⚫ Grey: <span style="font-family:var(--font-mono); font-weight:600; color:#9ca3af">${Math.round(dp.grey)}%</span>
        `;
      }
    } else {
      drawTrend(null);
      if (tooltipEl) tooltipEl.style.display = "none";
    }
  };

  canvas.onmouseleave = () => {
    drawTrend(null);
    if (tooltipEl) tooltipEl.style.display = "none";
  };
}

function renderWorstPerformersChart(upList, dateRange, matrixData, alpha = 1) {
  const canvas = document.getElementById("worst-performers-chart-canvas");
  if (!canvas) return;
  if (canvas.parentElement.offsetWidth === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.offsetWidth || 400;
  const height = canvas.parentElement.offsetHeight || 260;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const numUPs = upList.length;
  const numDays = dateRange.length;
  if (numUPs === 0 || numDays === 0) return;

  // Aggregate red and orange days per UP
  const upStats = [];
  for (let r = 0; r < numUPs; r++) {
    const up = upList[r];
    let redCount = 0;
    let orangeCount = 0;
    for (let c = 0; c < numDays; c++) {
      const cell = matrixData[r][c];
      if (cell) {
        if (cell.status === "red") redCount++;
        else if (cell.status === "orange") orangeCount++;
      }
    }
    const totalAnomalies = redCount + orangeCount;
    upStats.push({ up, redCount, orangeCount, totalAnomalies });
  }

  // Sort and select top 5
  upStats.sort((a, b) => b.totalAnomalies - a.totalAnomalies);
  const worst5 = upStats.slice(0, 5).filter(u => u.totalAnomalies > 0);

  const margin = { top: 20, right: 20, bottom: 40, left: 140 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  function drawBars(hoverIdx) {
    ctx.clearRect(0, 0, width, height);

    if (worst5.length === 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px Outfit";
      ctx.textAlign = "center";
      ctx.fillText("Nessuna anomalia rilevata nei dati caricati", width / 2, height / 2);
      return;
    }

    // Find max anomalies value to scale X axis
    const maxVal = Math.max(numDays, ...worst5.map(w => w.totalAnomalies));

    // Draw grid lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((i / 4) * maxVal);
      const x = margin.left + (val / maxVal) * w;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + h);
      ctx.stroke();

      ctx.fillStyle = "#9ca3af";
      ctx.font = "9px JetBrains Mono";
      ctx.textAlign = "center";
      ctx.fillText(`${val}g`, x, margin.top + h + 14);
    }

    // Draw bars
    const barHeight = Math.min(26, h / 5 - 8);
    const spacing = h / 5;

    worst5.forEach((item, idx) => {
      const y = margin.top + idx * spacing + (spacing - barHeight) / 2;

      // Draw UP Name label
      ctx.fillStyle = "#f3f4f6";
      ctx.font = "11px Outfit";
      ctx.textAlign = "right";
      ctx.fillText(item.up.name, margin.left - 10, y + barHeight / 2 + 4);

      const redW = (item.redCount / maxVal) * w * alpha;
      const orangeW = (item.orangeCount / maxVal) * w * alpha;

      const isHovered = hoverIdx === idx;

      // Draw Red Days bar
      if (redW > 0) {
        ctx.fillStyle = isHovered ? "#ef4444" : "#f87171";
        ctx.beginPath();
        ctx.roundRect(margin.left, y, redW, barHeight, orangeW === 0 ? [0, 4, 4, 0] : [0, 0, 0, 0]);
        ctx.fill();
      }

      // Draw Orange Days bar
      if (orangeW > 0) {
        ctx.fillStyle = isHovered ? "#f59e0b" : "#fbbf24";
        ctx.beginPath();
        ctx.roundRect(margin.left + redW, y, orangeW, barHeight, [0, 4, 4, 0]);
        ctx.fill();
      }

      // Hover indicator outline
      if (isHovered) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(margin.left - 2, y - 2, redW + orangeW + 4, barHeight + 4);
      }
    });
  }

  drawBars(null);

  const tooltipEl = document.getElementById("chart-tooltip");

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const clickY = event.clientY - rect.top;

    if (worst5.length === 0) return;

    const spacing = h / 5;
    const hoverIdx = Math.floor((clickY - margin.top) / spacing);

    if (hoverIdx >= 0 && hoverIdx < worst5.length) {
      drawBars(hoverIdx);

      const item = worst5[hoverIdx];
      if (tooltipEl) {
        tooltipEl.style.display = "block";
        tooltipEl.style.left = `${event.pageX + 15}px`;
        tooltipEl.style.top = `${event.pageY + 15}px`;
        tooltipEl.innerHTML = `
          <strong style="color:#60a5fa">${item.up.name}</strong><br/>
          <strong>ID:</strong> ${item.up.id}<br/>
          🔴 Giorni con Gap: <span style="font-family:var(--font-mono); font-weight:600; color:#f87171">${item.redCount}</span><br/>
          🟡 Discrepanze: <span style="font-family:var(--font-mono); font-weight:600; color:#fbbf24">${item.orangeCount}</span><br/>
          <strong>Totale Anomalie:</strong> <span style="font-family:var(--font-mono); font-weight:700;">${item.totalAnomalies} giorni</span>
        `;
      }
    } else {
      drawBars(null);
      if (tooltipEl) tooltipEl.style.display = "none";
    }
  };

  canvas.onmouseleave = () => {
    drawBars(null);
    if (tooltipEl) tooltipEl.style.display = "none";
  };
}

function renderDonutCharts(upList, dateRange, matrixData, alpha = 1) {
  const numUPs = upList.length;
  const numDays = dateRange.length;

  const windCanvas = document.getElementById("donut-wind-canvas");
  const solarCanvas = document.getElementById("donut-solar-canvas");

  if (!windCanvas || !solarCanvas) return;
  if (windCanvas.parentElement.offsetWidth === 0) return;

  // Aggregate states
  const windStats = { green: 0, red: 0, orange: 0, grey: 0 };
  const solarStats = { green: 0, red: 0, orange: 0, grey: 0 };

  for (let r = 0; r < numUPs; r++) {
    const up = upList[r];
    const statsObj = up.tech === "Wind" ? windStats : solarStats;
    for (let c = 0; c < numDays; c++) {
      const cell = matrixData[r][c];
      if (cell) {
        const s = cell.status || "red";
        if (statsObj[s] !== undefined) {
          statsObj[s]++;
        } else {
          statsObj.red++;
        }
      }
    }
  }

  function drawDonut(canvas, stats, hoverSlice) {
    const dpr = window.devicePixelRatio || 1;
    const parentWidth = canvas.parentElement.offsetWidth || 200;
    const parentHeight = canvas.parentElement.offsetHeight || 220;
    const width = parentWidth;
    const height = parentHeight - 20;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const total = stats.green + stats.red + stats.orange + stats.grey;
    if (total === 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "11px Outfit";
      ctx.textAlign = "center";
      ctx.fillText("Nessun dato", width / 2, height / 2);
      return;
    }

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2.3;
    const innerRadius = radius * 0.55;

    const data = [
      { key: "green", val: stats.green, color: "#4ade80" },
      { key: "orange", val: stats.orange, color: "#fbbf24" },
      { key: "red", val: stats.red, color: "#f87171" },
      { key: "grey", val: stats.grey, color: "#9ca3af" }
    ].filter(d => d.val > 0);

    let startAngle = -Math.PI / 2;

    data.forEach((slice, idx) => {
      const angle = (slice.val / total) * 2 * Math.PI * alpha;
      const endAngle = startAngle + angle;

      const isHovered = hoverSlice === slice.key;

      ctx.fillStyle = slice.color;
      ctx.beginPath();
      // Outer arc
      ctx.arc(centerX, centerY, isHovered ? radius + 4 : radius, startAngle, endAngle);
      // Inner arc backwards
      ctx.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fill();

      // Thin separation lines
      ctx.strokeStyle = "#161d2f";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      startAngle = endAngle;
    });

    // Draw center hole overlay
    ctx.fillStyle = "#161d2f";
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius - 1, 0, 2 * Math.PI);
    ctx.fill();

    // Center value (OK percentage)
    const okPct = total > 0 ? (stats.green / total) * 100 : 0;
    ctx.fillStyle = okPct > 80 ? "#4ade80" : okPct > 50 ? "#fbbf24" : "#f87171";
    ctx.font = "bold 13px JetBrains Mono";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(okPct * alpha)}% OK`, centerX, centerY + 4);
  }

  function handleDonutHover(event, canvas, stats, techName) {
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);
    const centerX = width / 2;
    const centerY = height / 2;
    const dist = Math.sqrt((clickX - centerX) ** 2 + (clickY - centerY) ** 2);
    const radius = Math.min(width, height) / 2.3;
    const innerRadius = radius * 0.55;

    const tooltipEl = document.getElementById("chart-tooltip");

    if (dist >= innerRadius && dist <= radius + 10) {
      // Find hovered angle
      let angle = Math.atan2(clickY - centerY, clickX - centerX);
      if (angle < -Math.PI / 2) {
        angle += 2 * Math.PI;
      }
      
      const total = stats.green + stats.red + stats.orange + stats.grey;
      const data = [
        { key: "green", val: stats.green, color: "#4ade80", label: "Green (Ok)" },
        { key: "orange", val: stats.orange, color: "#fbbf24", label: "Orange (Discrepanza)" },
        { key: "red", val: stats.red, color: "#f87171", label: "Red (Gap)" },
        { key: "grey", val: stats.grey, color: "#9ca3af", label: "Grey (Outage)" }
      ].filter(d => d.val > 0);

      let currentAngle = -Math.PI / 2;
      let matchedSlice = null;

      for (let i = 0; i < data.length; i++) {
        const sliceAngle = (data[i].val / total) * 2 * Math.PI;
        if (angle >= currentAngle && angle <= currentAngle + sliceAngle) {
          matchedSlice = data[i];
          break;
        }
        currentAngle += sliceAngle;
      }

      if (matchedSlice) {
        drawDonut(canvas, stats, matchedSlice.key);
        if (tooltipEl) {
          tooltipEl.style.display = "block";
          tooltipEl.style.left = `${event.pageX + 15}px`;
          tooltipEl.style.top = `${event.pageY + 15}px`;
          tooltipEl.innerHTML = `
            <strong style="color:#60a5fa">${techName}</strong><br/>
            <strong>Stato:</strong> <span style="color:${matchedSlice.color}; font-weight:700;">${matchedSlice.label}</span><br/>
            <strong>Giorni:</strong> ${matchedSlice.val} (${Math.round((matchedSlice.val / total) * 100)}%)
          `;
        }
      } else {
        drawDonut(canvas, stats, null);
        if (tooltipEl) tooltipEl.style.display = "none";
      }
    } else {
      drawDonut(canvas, stats, null);
      if (tooltipEl) tooltipEl.style.display = "none";
    }
  }

  // Draw initial donuts
  drawDonut(windCanvas, windStats, null);
  drawDonut(solarCanvas, solarStats, null);

  // Hook up hover events
  windCanvas.onmousemove = (e) => handleDonutHover(e, windCanvas, windStats, "Eolico (Wind)");
  solarCanvas.onmousemove = (e) => handleDonutHover(e, solarCanvas, solarStats, "Fotovoltaico (Solar)");

  windCanvas.onmouseleave = () => {
    drawDonut(windCanvas, windStats, null);
    const tooltipEl = document.getElementById("chart-tooltip");
    if (tooltipEl) tooltipEl.style.display = "none";
  };

  solarCanvas.onmouseleave = () => {
    drawDonut(solarCanvas, solarStats, null);
    const tooltipEl = document.getElementById("chart-tooltip");
    if (tooltipEl) tooltipEl.style.display = "none";
  };

  const windStatsEl = document.getElementById("donut-wind-stats");
  if (windStatsEl) {
    const total = windStats.green + windStats.red + windStats.orange + windStats.grey;
    const windUPCount = upList.filter(up => up.tech === "Wind").length;
    if (total === 0) {
      windStatsEl.innerHTML = `
        <div style="font-weight: 700; color: #60a5fa; margin-bottom: 2px;">WIND EOLICO</div>
        <div style="font-style:italic; color:var(--text-muted); font-size:0.6rem;">Nessuna unità monitorata</div>
      `;
    } else {
      const greenPct = ((windStats.green / total) * 100).toFixed(1);
      windStatsEl.innerHTML = `
        <div style="font-weight: 700; color: #60a5fa; margin-bottom: 2px; display: flex; justify-content: space-between;"><span>WIND (EOLICO)</span> <span style="color: var(--text-main);">${windUPCount} UP</span></div>
        <div style="display: grid; grid-template-columns: 1fr auto; gap: 2px; line-height: 1.3;">
          <span>🟢 OK (Green):</span><strong>${greenPct}%</strong>
          <span>🛑 Gap (Red):</span><strong>${((windStats.red / total) * 100).toFixed(1)}%</strong>
          <span>⚠️ Discrep. (Orange):</span><strong>${((windStats.orange / total) * 100).toFixed(1)}%</strong>
        </div>
      `;
    }
  }

  const solarStatsEl = document.getElementById("donut-solar-stats");
  if (solarStatsEl) {
    const total = solarStats.green + solarStats.red + solarStats.orange + solarStats.grey;
    const solarUPCount = upList.filter(up => up.tech === "Solar").length;
    if (total === 0) {
      solarStatsEl.innerHTML = `
        <div style="font-weight: 700; color: #fbbf24; margin-bottom: 2px;">SOLAR FOTOVOLTAICO</div>
        <div style="font-style:italic; color:var(--text-muted); font-size:0.6rem;">Nessuna unità monitorata</div>
      `;
    } else {
      const greenPct = ((solarStats.green / total) * 100).toFixed(1);
      solarStatsEl.innerHTML = `
        <div style="font-weight: 700; color: #fbbf24; margin-bottom: 2px; display: flex; justify-content: space-between;"><span>SOLAR (SOLARE)</span> <span style="color: var(--text-main);">${solarUPCount} UP</span></div>
        <div style="display: grid; grid-template-columns: 1fr auto; gap: 2px; line-height: 1.3;">
          <span>🟢 OK (Green):</span><strong>${greenPct}%</strong>
          <span>🛑 Gap (Red):</span><strong>${((solarStats.red / total) * 100).toFixed(1)}%</strong>
          <span>⚠️ Discrep. (Orange):</span><strong>${((solarStats.orange / total) * 100).toFixed(1)}%</strong>
        </div>
      `;
    }
  }
}

function renderRegionalChart(upList, dateRange, matrixData, alpha = 1) {
  const canvas = document.getElementById("regional-chart-canvas");
  if (!canvas) return;
  if (canvas.parentElement.offsetWidth === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.offsetWidth || 400;
  const height = canvas.parentElement.offsetHeight || 260;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const numUPs = upList.length;
  const numDays = dateRange.length;
  if (numUPs === 0 || numDays === 0) return;

  // Group UPs by region and calculate completeness averages
  const regionsData = {};
  for (let r = 0; r < numUPs; r++) {
    const up = upList[r];
    const reg = up.region || "Centro-Sud";

    if (!regionsData[reg]) {
      regionsData[reg] = { totalValids: 0, totalSteps: 0, upCount: 0 };
    }

    regionsData[reg].upCount++;
    for (let c = 0; c < numDays; c++) {
      const cell = matrixData[r][c];
      if (cell) {
        regionsData[reg].totalValids += cell.meterValids || 0;
        regionsData[reg].totalSteps += cell.meterSteps || 96;
        if (!isScadaDisabled(up.id)) {
          regionsData[reg].totalValids += cell.scadaValids || 0;
          regionsData[reg].totalSteps += cell.scadaSteps || (up.tech === "Wind" ? 144 : 96);
        }
      }
    }
  }

  // Calculate percentages
  const regionsList = Object.keys(regionsData).map(region => {
    const d = regionsData[region];
    const completeness = d.totalSteps > 0 ? (d.totalValids / d.totalSteps) * 100 : 0;
    return { region, completeness, upCount: d.upCount };
  });

  // Sort descending
  regionsList.sort((a, b) => b.completeness - a.completeness);

  const margin = { top: 20, right: 30, bottom: 35, left: 100 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  function drawRegBars(hoverIdx) {
    ctx.clearRect(0, 0, width, height);

    // Draw grids
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let pct = 0; pct <= 100; pct += 25) {
      const x = margin.left + (pct / 100) * w;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + h);
      ctx.stroke();

      ctx.fillStyle = "#9ca3af";
      ctx.font = "9px JetBrains Mono";
      ctx.textAlign = "center";
      ctx.fillText(`${pct}%`, x, margin.top + h + 14);
    }

    const spacing = h / Math.max(1, regionsList.length);
    const barHeight = Math.min(22, spacing - 8);

    regionsList.forEach((item, idx) => {
      const y = margin.top + idx * spacing + (spacing - barHeight) / 2;

      // Region name label
      ctx.fillStyle = "#f3f4f6";
      ctx.font = "11px Outfit";
      ctx.textAlign = "right";
      ctx.fillText(item.region, margin.left - 10, y + barHeight / 2 + 4);

      const isHovered = hoverIdx === idx;
      const barW = (item.completeness / 100) * w * alpha;

      // Draw glassmorphic background bar track
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.beginPath();
      ctx.roundRect(margin.left, y, w, barHeight, [0, 4, 4, 0]);
      ctx.fill();

      // Progress bar fill (gradient blue to purple)
      const grad = ctx.createLinearGradient(margin.left, 0, margin.left + barW, 0);
      grad.addColorStop(0, "rgba(59, 130, 246, 0.6)");
      grad.addColorStop(1, "rgba(139, 92, 246, 0.6)");

      ctx.fillStyle = isHovered ? "rgba(59, 130, 246, 0.85)" : grad;
      ctx.beginPath();
      ctx.roundRect(margin.left, y, barW, barHeight, [0, 4, 4, 0]);
      ctx.fill();

      // Percentage label inside or outside the bar
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 9px JetBrains Mono";
      ctx.textAlign = "left";
      ctx.fillText(`${(item.completeness * alpha).toFixed(1)}%`, margin.left + barW + 6, y + barHeight / 2 + 3);
    });
  }

  drawRegBars(null);

  const tooltipEl = document.getElementById("chart-tooltip");

  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const clickY = event.clientY - rect.top;

    const spacing = h / Math.max(1, regionsList.length);
    const hoverIdx = Math.floor((clickY - margin.top) / spacing);

    if (hoverIdx >= 0 && hoverIdx < regionsList.length) {
      drawRegBars(hoverIdx);

      const item = regionsList[hoverIdx];
      if (tooltipEl) {
        tooltipEl.style.display = "block";
        tooltipEl.style.left = `${event.pageX + 15}px`;
        tooltipEl.style.top = `${event.pageY + 15}px`;
        tooltipEl.innerHTML = `
          <strong style="color:#a855f7">${item.region}</strong><br/>
          <strong>UP monitorate:</strong> ${item.upCount}<br/>
          <strong>Completezza Media:</strong> <span style="font-family:var(--font-mono); font-weight:700; color:#3b82f6">${item.completeness.toFixed(2)}%</span>
        `;
      }
    } else {
      drawRegBars(null);
      if (tooltipEl) tooltipEl.style.display = "none";
    }
  };

  canvas.onmouseleave = () => {
    drawRegBars(null);
    if (tooltipEl) tooltipEl.style.display = "none";
  };

  const regionalTableTbody = document.getElementById("regional-table-tbody");
  if (regionalTableTbody) {
    if (regionsList.length === 0) {
      regionalTableTbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:12px; color:var(--text-muted);">Nessun dato</td></tr>`;
    } else {
      regionalTableTbody.innerHTML = regionsList.map(item => `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
          <td style="padding: 4px; font-weight:600; color:var(--text-main); font-size:0.65rem;">${item.region}</td>
          <td style="padding: 4px; text-align:center; color:var(--text-muted); font-size:0.65rem;">${item.upCount}</td>
          <td style="padding: 4px; text-align:right; font-family:var(--font-mono); font-weight:700; color:#3b82f6; font-size:0.65rem;">${(item.completeness * alpha).toFixed(1)}%</td>
        </tr>
      `).join("");
    }
  }
}

function renderProcessFeasibility(upList, dateRange, matrixData, alpha) {
  const numUPs = upList.length;
  const numDays = dateRange.length;
  if (numUPs === 0 || numDays === 0) return;
  const testCanvas = document.getElementById("feasibility-scada-canvas");
  if (testCanvas && testCanvas.parentElement.offsetWidth === 0) return;

  // 1. SCADA Feasibility: % of days where SCADA has 100% of samples (for UPs with SCADA enabled)
  let scadaTotalDays = 0;
  let scadaCompleteDays = 0;
  let scadaBlockedCells = 0;
  const scadaDailyTrend = [];

  for (let c = 0; c < numDays; c++) {
    let activeUPs = 0;
    let completeUPsOnDay = 0;
    for (let r = 0; r < numUPs; r++) {
      const up = upList[r];
      if (isScadaDisabled(up.id)) continue;
      
      activeUPs++;
      scadaTotalDays++;
      const cell = matrixData[r][c];
      const isComplete = cell && cell.scadaValids === cell.scadaSteps && cell.scadaSteps > 0;
      if (isComplete) {
        scadaCompleteDays++;
        completeUPsOnDay++;
      } else {
        scadaBlockedCells++;
      }
    }
    const pct = activeUPs > 0 ? (completeUPsOnDay / activeUPs) * 100 : 0;
    scadaDailyTrend.push(pct);
  }
  const scadaFeasibilityPct = scadaTotalDays > 0 ? (scadaCompleteDays / scadaTotalDays) * 100 : 0;

  // 2. METER Feasibility: % of days where METER has 100% of samples
  let meterTotalDays = 0;
  let meterCompleteDays = 0;
  let meterBlockedCells = 0;
  const meterDailyTrend = [];

  for (let c = 0; c < numDays; c++) {
    let completeUPsOnDay = 0;
    for (let r = 0; r < numUPs; r++) {
      meterTotalDays++;
      const cell = matrixData[r][c];
      const isComplete = cell && cell.meterValids === cell.meterSteps && cell.meterSteps > 0;
      if (isComplete) {
        meterCompleteDays++;
        completeUPsOnDay++;
      } else {
        meterBlockedCells++;
      }
    }
    const pct = numUPs > 0 ? (completeUPsOnDay / numUPs) * 100 : 0;
    meterDailyTrend.push(pct);
  }
  const meterFeasibilityPct = meterTotalDays > 0 ? (meterCompleteDays / meterTotalDays) * 100 : 0;

  // Update DOM general stats labels
  const scadaMonEl = document.getElementById("scada-stats-monitored");
  const scadaBlkEl = document.getElementById("scada-stats-blocked");
  if (scadaMonEl) scadaMonEl.innerText = `${numUPs - upList.filter(up => isScadaDisabled(up.id)).length} / ${numUPs} UP`;
  if (scadaBlkEl) scadaBlkEl.innerText = Math.round(scadaBlockedCells * alpha);

  const meterMonEl = document.getElementById("meter-stats-monitored");
  const meterBlkEl = document.getElementById("meter-stats-blocked");
  if (meterMonEl) meterMonEl.innerText = `${numUPs} / ${numUPs} UP`;
  if (meterBlkEl) meterBlkEl.innerText = Math.round(meterBlockedCells * alpha);

  // Render SCADA Gauge
  const scadaCanvas = document.getElementById("feasibility-scada-canvas");
  if (scadaCanvas) {
    drawFeasibilityGauge(scadaCanvas, scadaFeasibilityPct, "Previsione RT (SCADA)", "#22d3ee", alpha);
  }

  // Render METER Gauge
  const meterCanvas = document.getElementById("feasibility-meter-canvas");
  if (meterCanvas) {
    drawFeasibilityGauge(meterCanvas, meterFeasibilityPct, "Consuntivazione (METER)", "#6366f1", alpha);
  }

  // Render SCADA Sparkline
  const scadaSparklineCanvas = document.getElementById("feasibility-scada-sparkline");
  if (scadaSparklineCanvas) {
    drawMiniTrendSparkline(scadaSparklineCanvas, scadaDailyTrend, "rgba(34, 211, 238, 1)", alpha);
  }

  // Render METER Sparkline
  const meterSparklineCanvas = document.getElementById("feasibility-meter-sparkline");
  if (meterSparklineCanvas) {
    drawMiniTrendSparkline(meterSparklineCanvas, meterDailyTrend, "rgba(99, 102, 241, 1)", alpha);
  }

  // 3. Render Blockers lists
  // SCADA blockers: sort UPs by SCADA completeness
  const scadaBlockers = upList
    .filter(up => !isScadaDisabled(up.id))
    .map(up => {
      const idx = upList.indexOf(up);
      let completeDays = 0;
      for (let c = 0; c < numDays; c++) {
        const cell = matrixData[idx][c];
        if (cell && cell.scadaValids === cell.scadaSteps && cell.scadaSteps > 0) {
          completeDays++;
        }
      }
      const pct = (completeDays / numDays) * 100;
      return { up, pct, missingDays: numDays - completeDays };
    })
    .filter(item => item.pct < 100)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 3);

  // METER blockers: sort UPs by METER completeness
  const meterBlockers = upList
    .map(up => {
      const idx = upList.indexOf(up);
      let completeDays = 0;
      for (let c = 0; c < numDays; c++) {
        const cell = matrixData[idx][c];
        if (cell && cell.meterValids === cell.meterSteps && cell.meterSteps > 0) {
          completeDays++;
        }
      }
      const pct = (completeDays / numDays) * 100;
      return { up, pct, missingDays: numDays - completeDays };
    })
    .filter(item => item.pct < 100)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 3);

  // Update DOM lists
  const scadaBlockersListEl = document.getElementById("scada-blockers-list");
  if (scadaBlockersListEl) {
    if (scadaBlockers.length === 0) {
      scadaBlockersListEl.innerHTML = `<div style="color:var(--text-muted); font-size:0.75rem; text-align:center; padding:12px;">Nessuna unità bloccante. Previsioni operative al 100%!</div>`;
    } else {
      scadaBlockersListEl.innerHTML = scadaBlockers.map(item => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:6px; font-size:0.72rem; line-height:1.2;">
          <div>
            <strong style="color:var(--text-main); cursor:pointer;" onclick="window.navigateToDetailViewGlobal ? window.navigateToDetailViewGlobal('${item.up.id}') : null">${item.up.name}</strong>
            <div style="font-size:0.6rem; color:var(--text-muted)">Gaps in ${item.missingDays} gg</div>
          </div>
          <span style="font-family:var(--font-mono); font-weight:700; color:#ef4444">${Math.round(item.pct)}% OK</span>
        </div>
      `).join("");
    }
  }

  const meterBlockersListEl = document.getElementById("meter-blockers-list");
  if (meterBlockersListEl) {
    if (meterBlockers.length === 0) {
      meterBlockersListEl.innerHTML = `<div style="color:var(--text-muted); font-size:0.75rem; text-align:center; padding:12px;">Nessuna unità bloccante. Consuntivazione operativa al 100%!</div>`;
    } else {
      meterBlockersListEl.innerHTML = meterBlockers.map(item => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 12px; background:rgba(255,255,255,0.02); border:1px solid var(--panel-border); border-radius:6px; font-size:0.72rem; line-height:1.2;">
          <div>
            <strong style="color:var(--text-main); cursor:pointer;" onclick="window.navigateToDetailViewGlobal ? window.navigateToDetailViewGlobal('${item.up.id}') : null">${item.up.name}</strong>
            <div style="font-size:0.6rem; color:var(--text-muted)">Gaps in ${item.missingDays} gg</div>
          </div>
          <span style="font-family:var(--font-mono); font-weight:700; color:#fbbf24">${Math.round(item.pct)}% OK</span>
        </div>
      `).join("");
    }
  }
}

function drawMiniTrendSparkline(canvas, dailyValues, color, alpha) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.offsetWidth || 300;
  const h = 70;
  
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const len = dailyValues.length;
  if (len < 2) return;

  const padding = { top: 10, bottom: 5, left: 10, right: 10 };
  const graphWidth = w - padding.left - padding.right;
  const graphHeight = h - padding.top - padding.bottom;

  // Path coordinates
  const points = [];
  for (let i = 0; i < len; i++) {
    const val = dailyValues[i] * alpha;
    const x = padding.left + (i / (len - 1)) * graphWidth;
    const y = padding.top + graphHeight - (val / 100) * graphHeight;
    points.push({ x, y });
  }

  // Draw gradient area
  const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + graphHeight);
  grad.addColorStop(0, color.replace("1)", "0.15)"));
  grad.addColorStop(1, color.replace("1)", "0.0)"));

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + graphHeight);
  for (const pt of points) {
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.lineTo(points[len - 1].x, padding.top + graphHeight);
  ctx.closePath();
  ctx.fill();

  // Draw stroke line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < len; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  // Draw end value text and dot
  const lastPt = points[len - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(lastPt.x, lastPt.y, 3, 0, 2 * Math.PI);
  ctx.fill();
  
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 8px JetBrains Mono";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(dailyValues[len - 1] * alpha)}%`, lastPt.x - 6, lastPt.y - 3);
}

function drawFeasibilityGauge(canvas, percentage, label, color, alpha) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.offsetWidth || 180;
  const h = canvas.parentElement.offsetHeight || 180;
  
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const centerX = w / 2;
  const centerY = h / 2 - 4;
  const radius = Math.min(w, h) / 3.2;

  // Background track (semi-circular track)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.stroke();

  // Progress arc
  const angleMultiplier = alpha * (percentage / 100);
  const endAngle = 0.75 * Math.PI + angleMultiplier * 1.5 * Math.PI;

  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0.75 * Math.PI, endAngle);
  ctx.stroke();

  // Percentage text
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px JetBrains Mono";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(percentage * alpha)}%`, centerX, centerY);
}
