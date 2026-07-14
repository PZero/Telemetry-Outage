// Global Error Diagnostic Boundary
window.onerror = function(message, source, lineno, colno, error) {
  const errText = `JS Error: ${message}\nSource: ${source}\nLine: ${lineno}:${colno}\nErrorObj: ${error ? error.stack : ''}`;
  console.error("[Diagnostic Boundary]", errText);
  alert(`[App Error Boundary]\nUn errore imprevisto ha bloccato l'applicazione:\n\n${message}\n\nFile: ${source.substring(source.lastIndexOf('/') + 1)} (riga ${lineno})`);
};

import { getUPById, UP_REGISTRY, UNIQUE_REGIONS, isScadaDisabled, setScadaDisabled, loadUPRegistry } from "./registry.js";
import { initDB, clearDatabase, deleteOlderThan, getPersistenceStatus, getObservations, saveObservations, saveOutages, clearClientCaches } from "./db.js";
import { isSimulatedMode, setSimulatedMode, getAuthHeaders, fetchObservations, fetchOutages, fetchObservationsRange } from "./api.js";
import { renderFleetHeatmap, renderUPDailyRibbons, renderProfileChart, classifyDayIntegrity, renderFleetStats, renderAuditReportPanel } from "./ui.js";

// Global Application State
const state = {
  view: "fleet", // "fleet" | "detail" | "settings"
  selectedUP: null,
  selectedDate: null, // format YYYY-MM-DD
  timelineDuration: 30, // visible window: 1 to 90 days
  timelineOffset: 60, // start day offset from 90 days ago (0 to 90)
  filters: {
    techWind: true,
    techSolar: true,
    region: "All",
    ppaTag: "All",
    onlyGaps: false,
    discrepancy: false,
    selectedUPs: new Set()
  },
  simulatedMode: true,
  retentionMonths: 3,
  syncDaysRange: 30, // days to download in admin sync
  activeSyncTasks: {}, // track currently running sync tasks per upId|date
  syncQueue: [],
  totalTasks: 0,
  completedTasks: 0,
  isSyncRunning: false,
  shouldCancelSync: false,
  swRegistration: null,
  ppaTags: [],
  user: null
};
window.appState = state;

/**
 * Fetch PPA Tags from central backend database.
 */
async function fetchPPATagsFromServer() {
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/ppa/tags`, {
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    state.ppaTags = data;
    console.log(`[PPA] Loaded ${data.length} tags from backend database.`);
  } catch (err) {
    console.error("[PPA] Failed to load tags from backend, using local fallback:", err);
    state.ppaTags = [
      { name: "Enel", color: "#10b981" },
      { name: "Engie", color: "#3b82f6" },
      { name: "Edison", color: "#8b5cf6" },
      { name: "A2A", color: "#f59e0b" }
    ];
  }
}

// Date pool constants (90 days prior to 2026-07-03)
// Dynamic date pool ending 7 days in the future from today's local date
const POOL_END_DATE = new Date();
POOL_END_DATE.setDate(POOL_END_DATE.getDate() + 7); 
const POOL_START_DATE = new Date();
POOL_START_DATE.setDate(POOL_START_DATE.getDate() - 90); 

// Generate array of YYYY-MM-DD dates using local timezone formatting
const DATE_POOL = [];
for (let d = new Date(POOL_START_DATE); d <= POOL_END_DATE; d.setDate(d.getDate() + 1)) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  DATE_POOL.push(`${year}-${month}-${day}`);
}

/**
 * Bootstraps the application.
 */
window.addEventListener("DOMContentLoaded", async () => {
  console.log("[App] Booting Telemetry & Outage Integrity PWA...");
  
  // 1. Initialize user session and Google Identity Services
  const logoutBtn = document.getElementById("user-logout-btn");
  if (logoutBtn) {
    logoutBtn.onclick = logoutUser;
  }

  // Restore session if exists
  const storedSession = localStorage.getItem("google_user_session");
  let hasSession = false;
  if (storedSession) {
    try {
      const user = JSON.parse(storedSession);
      loginUser(user);
      hasSession = true;
    } catch (e) {
      console.warn("[Auth] Failed to restore session:", e);
      logoutUser();
    }
  } else {
    logoutUser();
  }

  // Fetch Google client configuration and setup login buttons
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const res = await fetch(`${apiUrl}/api/auth/google/config`);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const configData = await res.json();
    
    if (configData.googleClientId) {
      document.getElementById("google-signin-btn-container").style.display = "flex";
      document.getElementById("mock-signin-btn").style.display = "none";
      
      // Initialize GIS
      google.accounts.id.initialize({
        client_id: configData.googleClientId,
        callback: handleCredentialResponse
      });
      google.accounts.id.renderButton(
        document.getElementById("google-signin-btn"),
        { theme: "filled_dark", size: "large", width: 280 }
      );
    } else {
      // Setup mock bypass mode
      document.getElementById("google-signin-btn-container").style.display = "none";
      document.getElementById("mock-signin-btn").style.display = "block";
      document.getElementById("mock-signin-btn").onclick = handleMockLogin;
      document.getElementById("login-footer-note").innerText = "⚠️ Google Sign-In disabilitato (Client ID mancante). Accesso locale in modalità Demo.";
    }
  } catch (err) {
    console.error("[Auth] Google Sign-In setup failed:", err);
    // Fallback to local demo button
    document.getElementById("google-signin-btn-container").style.display = "none";
    document.getElementById("mock-signin-btn").style.display = "block";
    document.getElementById("mock-signin-btn").onclick = handleMockLogin;
    document.getElementById("login-footer-note").innerText = "⚠️ Errore connessione server. Accesso locale in modalità Demo.";
  }

  // 2. Register Service Worker
  await registerServiceWorker();

  // Calculate dynamic default duration: 1 full calendar month ending yesterday (D-1)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yYear = yesterday.getFullYear();
  const yMonth = String(yesterday.getMonth() + 1).padStart(2, "0");
  const yDay = String(yesterday.getDate()).padStart(2, "0");
  const yesterdayStr = `${yYear}-${yMonth}-${yDay}`;
  const yesterdayIdx = DATE_POOL.indexOf(yesterdayStr);

  const startOfWindow = new Date(yesterday);
  startOfWindow.setMonth(startOfWindow.getMonth() - 1);

  const oneDayMs = 24 * 60 * 60 * 1000;
  const yesterdayUTC = Date.UTC(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
  const startUTC = Date.UTC(startOfWindow.getFullYear(), startOfWindow.getMonth(), startOfWindow.getDate());
  const diffDays = Math.round((yesterdayUTC - startUTC) / oneDayMs) + 1;

  state.timelineDuration = diffDays;
  if (yesterdayIdx !== -1) {
    state.timelineOffset = Math.max(0, yesterdayIdx + 1 - state.timelineDuration);
  } else {
    state.timelineOffset = Math.max(0, DATE_POOL.length - state.timelineDuration - 7);
  }

  // Dynamically update the value of the "1 Mese" option in the duration selector to match diffDays
  const durationSelect = document.getElementById("timeline-duration-select");
  if (durationSelect) {
    const oneMonthOpt = durationSelect.querySelector('option[value="30"]');
    if (oneMonthOpt) {
      oneMonthOpt.value = diffDays;
      oneMonthOpt.innerText = `1 Mese (${diffDays} gg)`;
    }
  }

  const versionBadge = document.getElementById("app-version-badge");
  if (versionBadge) {
    versionBadge.innerText = window.APP_VERSION || "v83";
  }

  // 3. Initialize UI states and filters safely
  try {
    setupFilters();
  } catch (err) {
    console.error("[Bootstrap] setupFilters failed:", err);
  }

  try {
    setupTimelineControls();
  } catch (err) {
    console.error("[Bootstrap] setupTimelineControls failed:", err);
  }

  try {
    setupSettingsHandlers();
  } catch (err) {
    console.error("[Bootstrap] setupSettingsHandlers failed:", err);
  }

  try {
    setupViewRouting();
  } catch (err) {
    console.error("[Bootstrap] setupViewRouting failed:", err);
  }

  try {
    setupPPAHandlers();
  } catch (err) {
    console.error("[Bootstrap] setupPPAHandlers failed:", err);
  }

  try {
    setupSidebarToggle();
  } catch (err) {
    console.error("[Bootstrap] setupSidebarToggle failed:", err);
  }
  // 4. Handle window resizing to keep heatmap responsive and fit container width
  window.addEventListener("resize", () => {
    if (state.view === "fleet") {
      triggerFleetRedrawThrottled();
    }
  });

  // 5. Load initial view
  updatePersistenceBadge();
  applyFiltersAndRender();

  // 6. Auto-sync yesterday's data (D-1) on open (after a 2s delay)
  setTimeout(() => {
    triggerYesterdaySync(true);
  }, 2000);
});

/**
 * Registers PWA Service Worker.
 */

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      state.swRegistration = reg;
      console.log("[SW] Service Worker registered in scope:", reg.scope);

      // Force immediate update check to bypass stale cache-first policies
      reg.update();

      // Auto-reload on updates to bypass cache-first locks immediately
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (newWorker) {
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "activated") {
              console.log("[SW] New Service Worker activated. Reloading view...");
              window.location.reload();
            }
          });
        }
      });

      // Listen for message events from sw.js
      navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);

      // Trigger initial status check
      sendSWMessage({ action: "GET_STATUS" });

    } catch (err) {
      console.warn("[SW] Service Worker registration failed:", err);
    }
  } else {
    console.warn("[SW] Service Worker not supported in this browser.");
  }
}

/**
 * Safely posts a message to the Service Worker even if not yet controlling the page
 */
function sendSWMessage(message) {
  const worker = navigator.serviceWorker.controller || 
                 (state.swRegistration && state.swRegistration.active) || 
                 (state.swRegistration && state.swRegistration.waiting);
  if (worker) {
    worker.postMessage(message);
    return true;
  }
  return false;
}

/**
 * Handles communication received from Service Worker.
 */
function handleServiceWorkerMessage(event) {
  const data = event.data;
  if (!data) return;

  if (data.type === "TOKEN_REFRESH_REQUEST") {
    forceRefreshAzureToken().then(newToken => {
      sendSWMessage({
        type: "TOKEN_REFRESH_RESPONSE",
        messageId: data.messageId,
        token: newToken
      });
    });
    return;
  }

  if (data.type !== "SYNC_STATUS") return;

  // Print logs sent by SW fetch calls to the Settings Console
  const consolePre = document.getElementById("console-logs");
  if (consolePre && data.log) {
    const timestamp = new Date().toLocaleTimeString();
    consolePre.textContent += `[${timestamp}] ${data.log}\n`;
    consolePre.scrollTop = consolePre.scrollHeight;
  }
}/**
 * Calculates date range visible based on offset and duration sliders.
 */
function getActiveDateRange() {
  const startIdx = Math.max(0, Math.min(DATE_POOL.length - 1, state.timelineOffset));
  const endIdx = Math.min(DATE_POOL.length, startIdx + state.timelineDuration);
  return DATE_POOL.slice(startIdx, endIdx);
}

/**
 * Sets up timeline controls (duration, sliding dates).
 */
function setupTimelineControls() {
  const durationSelect = document.getElementById("timeline-duration-select");
  const slider = document.getElementById("timeline-range-slider");
  const picker = document.getElementById("timeline-date-picker");

  // Duration sets window size
  durationSelect.addEventListener("change", (e) => {
    state.timelineDuration = parseInt(e.target.value, 10);
    // Ensure offset + duration doesn't overrun DATE_POOL
    if (state.timelineOffset + state.timelineDuration > DATE_POOL.length) {
      state.timelineOffset = Math.max(0, DATE_POOL.length - state.timelineDuration);
      slider.value = state.timelineOffset;
    }
    updateSliderRange();
    applyFiltersAndRender();
  });

  // Slider shifts start offset
  slider.addEventListener("input", (e) => {
    state.timelineOffset = parseInt(e.target.value, 10);
    updateSliderRange();
    applyFiltersAndRender();
  });

  // Date picker selects end date of period
  if (picker) {
    picker.addEventListener("change", (e) => {
      const selectedDateStr = e.target.value;
      if (!selectedDateStr) return;

      const idx = DATE_POOL.indexOf(selectedDateStr);
      if (idx !== -1) {
        state.timelineOffset = Math.max(0, idx - state.timelineDuration + 1);
        slider.value = state.timelineOffset;
        applyFiltersAndRender();
      }
    });
  }

  updateSliderRange();
}

function updateSliderRange() {
  const slider = document.getElementById("timeline-range-slider");
  const picker = document.getElementById("timeline-date-picker");

  // Maximum offset is pool length minus window duration
  const maxOffset = Math.max(0, DATE_POOL.length - state.timelineDuration);
  slider.max = maxOffset;
  if (state.timelineOffset > maxOffset) {
    state.timelineOffset = maxOffset;
    slider.value = maxOffset;
  }

  // Update date picker min/max constraints
  if (picker) {
    picker.min = DATE_POOL[state.timelineDuration - 1] || DATE_POOL[0];
    picker.max = DATE_POOL[DATE_POOL.length - 1];
  }

  const range = getActiveDateRange();
  if (range.length > 0 && picker) {
    picker.value = range[range.length - 1];
  }
}

function formatDateLabel(isoStr) {
  const parts = isoStr.split("-");
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

/**
 * Sets up filters in Sidebar.
 */
/**
 * Populates dropdown lists in the Sidebar dynamically.
 */
function populateDropdowns() {
  const regionSel = document.getElementById("filter-region");
  const searchUpSel = document.getElementById("search-up-select");
  const ppaSel = document.getElementById("filter-ppa");
  if (!regionSel || !searchUpSel) return;

  const oldRegion = regionSel.value || "All";

  // Populate region list
  regionSel.innerHTML = '<option value="All">Tutte le Regioni</option>';
  UNIQUE_REGIONS.forEach(region => {
    const opt = document.createElement("option");
    opt.value = region;
    opt.innerText = region;
    regionSel.appendChild(opt);
  });

  if (UNIQUE_REGIONS.includes(oldRegion)) {
    regionSel.value = oldRegion;
  } else {
    regionSel.value = "All";
  }

  // Populate PPA filter list
  if (ppaSel) {
    const oldPPA = ppaSel.value || "All";
    ppaSel.innerHTML = '<option value="All">Tutti i Partner PPA</option><option value="None">Non Assegnate</option>';
    const tags = loadPPATags();
    tags.forEach(tag => {
      const opt = document.createElement("option");
      opt.value = tag.name;
      opt.innerText = tag.name;
      ppaSel.appendChild(opt);
    });
    ppaSel.value = oldPPA;
  }

  // Populate UP Search dropdown
  searchUpSel.innerHTML = '<option value="">-- Seleziona UP per Deep-Dive --</option>';
  const sortedUPs = [...UP_REGISTRY].sort((a, b) => a.name.localeCompare(b.name));
  sortedUPs.forEach(up => {
    const opt = document.createElement("option");
    opt.value = up.id;
    opt.innerText = `${up.name} (${up.id})`;
    searchUpSel.appendChild(opt);
  });

  // Populate Sync UP dropdown in settings
  const syncUpSel = document.getElementById("sync-up-select");
  if (syncUpSel) {
    const oldSyncUp = syncUpSel.value || "all";
    syncUpSel.innerHTML = '<option value="all">Tutte le UP (Flotta Completa)</option>';
    sortedUPs.forEach(up => {
      const opt = document.createElement("option");
      opt.value = up.id;
      opt.innerText = `${up.name} (${up.id})`;
      syncUpSel.appendChild(opt);
    });
    syncUpSel.value = oldSyncUp;
  }
}

/**
 * Sets up filters in Sidebar.
 */
function renderSelectedUPTags() {
  const container = document.getElementById("selected-ups-tags");
  if (!container) return;

  if (state.filters.selectedUPs.size === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = Array.from(state.filters.selectedUPs).map(upId => {
    const up = getUPById(upId) || { name: upId };
    return `
      <span class="selected-up-tag" style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 12px; color: #60a5fa; font-size: 0.65rem; font-weight: 600;">
        ${up.name}
        <span class="remove-tag-btn" data-up-id="${upId}" style="cursor: pointer; color: #f87171; font-weight: bold; margin-left: 2px;">×</span>
      </span>
    `;
  }).join("");

  container.querySelectorAll(".remove-tag-btn").forEach(btn => {
    btn.onclick = () => {
      const upId = btn.dataset.upId;
      state.filters.selectedUPs.delete(upId);
      renderSelectedUPTags();
      applyFiltersAndRender();
    };
  });
}

function setupFilters() {
  const windCb = document.getElementById("filter-wind");
  const solarCb = document.getElementById("filter-solar");
  const regionSel = document.getElementById("filter-region");
  const gapsCb = document.getElementById("filter-gaps");
  const discCb = document.getElementById("filter-discrepancies");
  const searchUpSel = document.getElementById("search-up-select");
  const ppaSel = document.getElementById("filter-ppa");

  if (!windCb || !solarCb || !regionSel || !gapsCb || !discCb || !searchUpSel) return;

  populateDropdowns();
  renderSelectedUPTags();

  searchUpSel.addEventListener("change", (e) => {
    const upId = e.target.value;
    if (upId) {
      state.filters.selectedUPs.add(upId);
      searchUpSel.value = ""; // Reset select
      renderSelectedUPTags();
      applyFiltersAndRender();
    }
  });

  const triggerFilterUpdate = () => {
    state.filters.techWind = windCb.checked;
    state.filters.techSolar = solarCb.checked;
    state.filters.region = regionSel.value;
    state.filters.ppaTag = ppaSel ? ppaSel.value : "All";
    state.filters.onlyGaps = gapsCb.checked;
    state.filters.discrepancy = discCb.checked;
    applyFiltersAndRender();
  };

  const btnWind = document.getElementById("tech-btn-wind");
  const btnSolar = document.getElementById("tech-btn-solar");

  if (btnWind) {
    btnWind.onclick = () => {
      const active = btnWind.classList.toggle("active");
      windCb.checked = active;
      btnWind.style.background = active ? "rgba(59, 130, 246, 0.15)" : "none";
      btnWind.style.borderColor = active ? "rgba(59, 130, 246, 0.3)" : "transparent";
      btnWind.style.color = active ? "var(--text-main)" : "var(--text-muted)";
      triggerFilterUpdate();
    };
  }

  if (btnSolar) {
    btnSolar.onclick = () => {
      const active = btnSolar.classList.toggle("active");
      solarCb.checked = active;
      btnSolar.style.background = active ? "rgba(251, 191, 36, 0.15)" : "none";
      btnSolar.style.borderColor = active ? "rgba(251, 191, 36, 0.3)" : "transparent";
      btnSolar.style.color = active ? "var(--text-main)" : "var(--text-muted)";
      triggerFilterUpdate();
    };
  }

  const updatePillVisuals = (cb, activeBg, activeBorder, activeColor, inactiveBg, inactiveBorder, inactiveColor) => {
    const label = cb.closest(".toggle-pill");
    if (label) {
      if (cb.checked) {
        label.style.background = activeBg;
        label.style.borderColor = activeBorder;
        label.style.color = activeColor;
      } else {
        label.style.background = inactiveBg;
        label.style.borderColor = inactiveBorder;
        label.style.color = inactiveColor;
      }
    }
  };

  // Initialize pill visuals on load
  updatePillVisuals(gapsCb, "rgba(239, 68, 68, 0.25)", "#ef4444", "#ffffff", "rgba(239, 68, 68, 0.04)", "rgba(239, 68, 68, 0.25)", "#f87171");
  updatePillVisuals(discCb, "rgba(251, 191, 36, 0.25)", "#fbbf24", "#ffffff", "rgba(251, 191, 36, 0.04)", "rgba(251, 191, 36, 0.25)", "#fbbf24");

  windCb.addEventListener("change", triggerFilterUpdate);
  solarCb.addEventListener("change", triggerFilterUpdate);
  regionSel.addEventListener("change", triggerFilterUpdate);
  if (ppaSel) {
    ppaSel.addEventListener("change", triggerFilterUpdate);
  }
  
  gapsCb.addEventListener("change", () => {
    updatePillVisuals(gapsCb, "rgba(239, 68, 68, 0.25)", "#ef4444", "#ffffff", "rgba(239, 68, 68, 0.04)", "rgba(239, 68, 68, 0.25)", "#f87171");
    triggerFilterUpdate();
  });
  
  discCb.addEventListener("change", () => {
    updatePillVisuals(discCb, "rgba(251, 191, 36, 0.25)", "#fbbf24", "#ffffff", "rgba(251, 191, 36, 0.04)", "rgba(251, 191, 36, 0.25)", "#fbbf24");
    triggerFilterUpdate();
  });
}

/**
 * Filters the flotta list and triggers heatmap redraw.
 */
async function applyFiltersAndRender() {
  if (!state.user) {
    console.log("[Render] Skipping render - User not authenticated.");
    return;
  }
  if (state.view !== "fleet" && state.view !== "stats" && state.view !== "audit") return;

  const canvas = document.getElementById("heatmap-canvas");
  if (state.view === "fleet" && !canvas) return;

  // Filter by basic parameters
  let filteredUPs = UP_REGISTRY.filter(up => {
    if (up.tech === "Wind" && !state.filters.techWind) return false;
    if (up.tech === "Solar" && !state.filters.techSolar) return false;
    if (state.filters.region !== "All" && up.region !== state.filters.region) return false;
    
    // Filter by PPA Tag
    if (state.filters.ppaTag && state.filters.ppaTag !== "All") {
      if (state.filters.ppaTag === "None") {
        if (up.ppaTag) return false;
      } else {
        if (up.ppaTag !== state.filters.ppaTag) return false;
      }
    }

    // Filter by specific selected UPs
    if (state.filters.selectedUPs && state.filters.selectedUPs.size > 0) {
      if (!state.filters.selectedUPs.has(up.id)) return false;
    }
    return true;
  });

  const range = getActiveDateRange();

  // Apply high-performance dynamic anomaly filters
  if (state.filters.onlyGaps || state.filters.discrepancy) {
    const statusPromises = filteredUPs.map(async (up) => {
      for (const dateStr of range) {
        const integrityResult = await classifyDayIntegrity(up, dateStr);
        const integrity = integrityResult.status;
        
        if (state.filters.onlyGaps && integrity === "red") {
          return { up, match: true };
        }
        if (state.filters.discrepancy && integrity === "orange") {
          return { up, match: true };
        }
      }
      return { up, match: false };
    });

    const results = await Promise.all(statusPromises);
    filteredUPs = results.filter(r => r.match).map(r => r.up);
  }

  // Draw Heatmap
  if (state.view === "fleet") {
    renderFleetHeatmap(canvas, filteredUPs, range, handleHeatmapCellClick);
  } else if (state.view === "stats") {
    // Generate matrixData asynchronously to run the stats rendering
    const allRowsPromises = filteredUPs.map(async (up) => {
      return await Promise.all(range.map(dateStr => classifyDayIntegrity(up, dateStr)));
    });
    const matrixData = await Promise.all(allRowsPromises);
    renderFleetStats(filteredUPs, range, matrixData);
  } else if (state.view === "audit") {
    const container = document.getElementById("audit-report-container");
    if (container) {
      renderAuditReportPanel(container, filteredUPs, range);
    }
  }
}

/**
 * Transition from Level 1 (Fleet) to Level 2/3 (UP details).
 */
function handleHeatmapCellClick(upId, dateStr) {
  state.selectedUP = upId;
  state.selectedDate = dateStr;
  navigateToView("detail");
}

/**
 * Navigates view panel tabs.
 */
function navigateToView(viewName) {
  // Guard access to settings for non-admin users
  if (viewName === "settings" && state.user && state.user.role !== 'admin') {
    console.warn("[Auth Security] Rejected unauthorized access to Settings.");
    viewName = "fleet";
  }

  // Safe PWA cache bypass: reload page if audit section is missing from HTML cache
  if (viewName === "audit" && !document.getElementById("audit-view")) {
    console.warn("Audit view panel not found in DOM. Reloading page to update cache.");
    window.location.reload();
    return;
  }

  state.view = viewName;

  // Hide all view panels safely
  const views = ["fleet-heatmap-view", "fleet-stats-view", "detail-deepdive-view", "settings-view", "ppa-view", "audit-view"];
  views.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  const timelineHeader = document.querySelector(".main-header");
  if (timelineHeader) {
    timelineHeader.style.display = (viewName === "fleet" || viewName === "stats" || viewName === "audit") ? "flex" : "none";
  }

  // Update top navbar active tab styling
  const tabs = {
    fleet: document.getElementById("nav-fleet-btn"),
    stats: document.getElementById("nav-stats-btn"),
    audit: document.getElementById("nav-audit-btn"),
    ppa: document.getElementById("nav-ppa-btn"),
    settings: document.getElementById("nav-settings-btn")
  };

  Object.keys(tabs).forEach(key => {
    const tab = tabs[key];
    if (!tab) return;
    if (key === viewName) {
      tab.classList.add("active");
      tab.style.background = "rgba(59, 130, 246, 0.1)";
      tab.style.borderColor = "rgba(59, 130, 246, 0.2)";
      tab.style.color = "var(--text-main)";
    } else {
      tab.classList.remove("active");
      tab.style.background = "none";
      tab.style.borderColor = "transparent";
      tab.style.color = "var(--text-muted)";
    }
  });

  // Show active view panel safely
  const viewIdMap = {
    fleet: "fleet-heatmap-view",
    stats: "fleet-stats-view",
    detail: "detail-deepdive-view",
    ppa: "ppa-view",
    settings: "settings-view",
    audit: "audit-view"
  };
  const targetId = viewIdMap[viewName];
  const targetEl = targetId ? document.getElementById(targetId) : null;
  if (targetEl) {
    targetEl.classList.remove("hidden");
  }

  // Run view init handlers
  if (viewName === "fleet") {
    const searchUpSel = document.getElementById("search-up-select");
    if (searchUpSel) searchUpSel.value = "";
    applyFiltersAndRender();
    if (state.isSyncRunning) {
      startHeatmapAnimation();
    }
  } else if (viewName === "stats") {
    applyFiltersAndRender();
  } else if (viewName === "detail") {
    renderDeepDivePanel();
  } else if (viewName === "ppa") {
    renderPPAPanel();
  } else if (viewName === "settings") {
    updateSettingsLogs();
    printDatabaseDiagnostics();
  } else if (viewName === "audit") {
    applyFiltersAndRender();
  }
}
window.navigateToView = navigateToView;

function setupViewRouting() {
  const syncYesterdayBtn = document.getElementById("sync-yesterday-btn");
  if (syncYesterdayBtn) {
    syncYesterdayBtn.onclick = () => {
      triggerYesterdaySync(false);
    };
  }

  const fleetBtn = document.getElementById("nav-fleet-btn");
  if (fleetBtn) fleetBtn.onclick = () => navigateToView("fleet");

  const statsBtn = document.getElementById("nav-stats-btn");
  if (statsBtn) statsBtn.onclick = () => navigateToView("stats");

  const auditBtn = document.getElementById("nav-audit-btn");
  if (auditBtn) auditBtn.onclick = () => navigateToView("audit");

  const ppaBtn = document.getElementById("nav-ppa-btn");
  if (ppaBtn) ppaBtn.onclick = () => navigateToView("ppa");

  const settingsBtn = document.getElementById("nav-settings-btn");
  if (settingsBtn) settingsBtn.onclick = () => navigateToView("settings");

  const backBtn = document.getElementById("detail-back-btn");
  if (backBtn) backBtn.onclick = () => navigateToView("fleet");

  const downloadPdfBtn = document.getElementById("download-audit-pdf-btn");
  if (downloadPdfBtn) {
    downloadPdfBtn.onclick = () => {
      const element = document.getElementById("audit-report-container");
      if (!element) return;
      
      // Temporarily add print class for light theme formatting
      element.classList.add("pdf-export-mode");
      
      const opt = {
        margin:       15,
        filename:     `Report_Audit_Integrita_${new Date().toISOString().split('T')[0]}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };

      if (window.html2pdf) {
        window.html2pdf().set(opt).from(element).save().then(() => {
          element.classList.remove("pdf-export-mode");
        }).catch((err) => {
          console.error("PDF generation failed:", err);
          element.classList.remove("pdf-export-mode");
          alert("Errore nella generazione del file PDF.");
        });
      } else {
        alert("Libreria di esportazione PDF non ancora caricata. Riprova tra qualche istante.");
        element.classList.remove("pdf-export-mode");
      }
    };
  }

  // Setup Stats Subtabs
  const tabQualita = document.getElementById("stats-tab-qualita");
  const tabProcessi = document.getElementById("stats-tab-processi");
  const panelQualita = document.getElementById("stats-panel-qualita");
  const panelProcessi = document.getElementById("stats-panel-processi");

  if (tabQualita && tabProcessi && panelQualita && panelProcessi) {
    tabQualita.onclick = () => {
      tabQualita.classList.add("active");
      tabProcessi.classList.remove("active");
      panelQualita.style.display = "flex";
      panelProcessi.classList.add("hidden");
      applyFiltersAndRender();
    };

    tabProcessi.onclick = () => {
      tabProcessi.classList.add("active");
      tabQualita.classList.remove("active");
      panelQualita.style.display = "none";
      panelProcessi.classList.remove("hidden");
      applyFiltersAndRender();
    };
  }

  // Setup segmented control buttons for charts grouping
  const btnGroup1 = document.getElementById("charts-group-1-btn");
  const btnGroup2 = document.getElementById("charts-group-2-btn");
  const group1 = document.getElementById("charts-group-1");
  const group2 = document.getElementById("charts-group-2");

  if (btnGroup1 && btnGroup2 && group1 && group2) {
    btnGroup1.onclick = () => {
      btnGroup1.classList.add("active");
      btnGroup2.classList.remove("active");
      group1.classList.remove("hidden");
      group2.classList.add("hidden");
      applyFiltersAndRender();
    };

    btnGroup2.onclick = () => {
      btnGroup2.classList.add("active");
      btnGroup1.classList.remove("active");
      group1.classList.add("hidden");
      group2.classList.remove("hidden");
      applyFiltersAndRender();
    };
  }

  window.navigateToDetailViewGlobal = (upId) => {
    state.selectedUPId = upId;
    const range = getActiveDateRange();
    if (range && range.length > 0) {
      state.selectedDate = range[range.length - 1];
    }
    navigateToView("detail");
  };

  const detailPicker = document.getElementById("detail-date-picker");
  if (detailPicker) {
    detailPicker.addEventListener("change", (e) => {
      const selected = e.target.value;
      if (selected && DATE_POOL.includes(selected)) {
        state.selectedDate = selected;
        renderDeepDivePanel();
      }
    });
  }

  const exportBtn = document.getElementById("export-table-btn");
  if (exportBtn) {
    exportBtn.onclick = () => {
      if (!window.currentTableDataCsv || window.currentTableDataCsv.length <= 1) {
        alert("Nessun dato da esportare.");
        return;
      }
      const csvContent = "data:text/csv;charset=utf-8," 
        + window.currentTableDataCsv.map(e => e.join(",")).join("\n");
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      const upId = state.selectedUP || "UP";
      link.setAttribute("download", `misure_${upId}_${state.selectedDate}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }
}

function setupSidebarToggle() {
  const sidebar = document.querySelector(".app-sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const toggleIcon = document.getElementById("sidebar-toggle-icon");
  
  if (!sidebar || !toggleBtn) return;
  
  const isCollapsed = localStorage.getItem("sidebar-collapsed") === "true";
  if (isCollapsed) {
    sidebar.classList.add("collapsed");
    if (toggleIcon) toggleIcon.innerText = "▶";
  }
  
  toggleBtn.addEventListener("click", () => {
    const collapsed = sidebar.classList.toggle("collapsed");
    localStorage.setItem("sidebar-collapsed", collapsed);
    if (toggleIcon) {
      toggleIcon.innerText = collapsed ? "▶" : "◀";
    }
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 260);
  });
}

/**
 * LEVEL 2 & 3: Render details for selected UP centered on date (3-day window)
 */
async function renderDeepDivePanel() {
  try {
    const upId = state.selectedUP;
    const targetDateStr = state.selectedDate;

    if (!upId || !targetDateStr) {
      navigateToView("fleet");
      return;
    }

    updateSettingsLogs(`[Debug DeepDive] Selezionato ID UP: "${upId}", Data: "${targetDateStr}"`);
    let up = getUPById(upId);
    if (!up) {
      updateSettingsLogs(`[Debug DeepDive WARNING] UP non trovata nel registro per ID: "${upId}". Generazione fallback.`);
      const isWind = upId.toLowerCase().includes("wind");
      up = {
        id: upId,
        name: upId,
        tech: isWind ? "Wind" : "Solar",
        region: "Sicilia",
        capacity: null
      };
    } else {
      updateSettingsLogs(`[Debug DeepDive SUCCESS] Risolta UP nel registro -> ID: "${up.id}", Nome: "${up.name}", Tech: "${up.tech}"`);
    }

    // Header meta data
    const picker = document.getElementById("detail-date-picker");
    if (picker) {
      picker.min = DATE_POOL[0];
      picker.max = DATE_POOL[DATE_POOL.length - 1];
      picker.value = targetDateStr;
    }

    document.getElementById("detail-up-title").innerText = `${up.name} (${up.id})`;
    document.getElementById("detail-up-tech").innerText = up.tech;
    document.getElementById("detail-up-region").innerText = up.region;
    
    const capEl = document.getElementById("detail-up-capacity");
    if (capEl) {
      if (up.capacity) {
        capEl.parentElement.style.display = "inline";
        capEl.innerText = `${up.capacity} MW`;
      } else {
        capEl.parentElement.style.display = "none";
      }
    }

    const noScadaCb = document.getElementById("detail-up-noscada-cb");
    if (noScadaCb) {
      noScadaCb.checked = isScadaDisabled(up.id);
      noScadaCb.onclick = (e) => {
        setScadaDisabled(up.id, e.target.checked);
        updateSettingsLogs(`[Registry Change] UP ${up.name} (${up.id}) impostata come ${e.target.checked ? "NON censita" : "censita"} SCADA.`);
      };
    }

    const container = document.getElementById("detail-ribbons-container");
    container.innerHTML = ""; // Clear

    // Define 3 days window (Target-1, Target, Target+1) in local timezone
    const parts = targetDateStr.split("-");
    const targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    
    const dPrev = new Date(targetDate);
    dPrev.setDate(dPrev.getDate() - 1);

    const dNext = new Date(targetDate);
    dNext.setDate(dNext.getDate() + 1);

    const formatLocal = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    const daysWindow = [
      formatLocal(dPrev),
      targetDateStr,
      formatLocal(dNext)
    ].filter(dStr => DATE_POOL.includes(dStr)); // keep within bounds

    // Render Ribbons for each day in window
    for (const dayStr of daysWindow) {
      await renderUPDailyRibbons(container, up.id, dayStr, triggerDailyForceRefetch);
    }

    // Draw Level 3: production profile chart for the main TARGET day
    const chartCanvas = document.getElementById("profile-chart-canvas");
    document.getElementById("chart-date-label").innerText = targetDateStr;
    await renderProfileChart(chartCanvas, up.id, targetDateStr);

    // Check if target day has API error and display banner
    const cellStatus = await classifyDayIntegrity(up, targetDateStr);
    const bannerEl = document.getElementById("detail-api-error-banner");
    const msgEl = document.getElementById("detail-api-error-message");
    if (bannerEl && msgEl) {
      if (cellStatus.apiError && cellStatus.apiErrorMessage) {
        bannerEl.style.display = "flex";
        msgEl.innerText = cellStatus.apiErrorMessage;
      } else {
        bannerEl.style.display = "none";
      }
    }
  } catch (err) {
    console.error("[DeepDive ERROR]", err);
    updateSettingsLogs(`[UI ERROR] Errore nel caricamento del pannello di dettaglio: ${err.message || err}`);
  }
}

/**
 * Triggers an immediate daily re-sync bypassing caches.
 */
async function triggerDailyForceRefetch(upId, dateStr) {
  const up = getUPById(upId);
  if (!up) return;

  // Visual feedback overlay active (if in detail view)
  const dayBlock = document.querySelector(`.ribbon-day-block[data-date="${dateStr}"]`);
  const overlay = dayBlock ? dayBlock.querySelector(".ribbon-loading-overlay") : null;
  if (overlay) overlay.classList.add("active");

  const taskKey = `${upId}|${dateStr}`;
  state.activeSyncTasks[taskKey] = true;
  
  // Set isSyncRunning to true and start animation if in fleet view
  const prevSyncRunning = state.isSyncRunning;
  state.isSyncRunning = true;
  
  if (state.view === "fleet") {
    startHeatmapAnimation();
    if (window.redrawHeatmapCached) {
      window.redrawHeatmapCached();
    }
  }

  // Auto-refresh token if credentials are set
  await autoRefreshAzureToken();

  const token = localStorage.getItem("azure_api_token") || "";
  const simMode = isSimulatedMode();

  try {
    updateSettingsLogs(`[Daily Refetch] Avvio re-sync immediato per ${up.name} in data ${dateStr}...`);
    
    // Call the backend sync engine for this specific UP/date
    const apiUrl = import.meta.env.VITE_API_URL || "https://telemetry-outage.onrender.com";
    const session = JSON.parse(localStorage.getItem("google_user_session") || "{}");
    const syncResponse = await fetch(`${apiUrl}/api/sync/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.token || ""}` },
      body: JSON.stringify({ rangeDays: 1, isSelective: false, upId, simMode, specificDate: dateStr })
    });
    if (!syncResponse.ok) throw new Error(`Backend sync error: ${syncResponse.status}`);

    updateSettingsLogs(`[Daily Refetch] Re-sync avviato per ${up.name} in data ${dateStr}. Attendi completamento...`);
    
    // Start status polling
    startSyncStatusPoller();
  } catch (err) {
    updateSettingsLogs(`[Daily Refetch ERROR] Sincronizzazione fallita: ${err.message || err}`);
    delete state.activeSyncTasks[taskKey];
    state.isSyncRunning = prevSyncRunning; // Restore previous sync state
    if (overlay) overlay.classList.remove("active");
  }
}
window.triggerDailyForceRefetchGlobal = triggerDailyForceRefetch;

/**
 * OAuth2 Client Credentials token fetcher
 */
async function runTokenAcquisition(tenantId, clientId, clientSecret, scope) {
  if (!tenantId || !clientId || !clientSecret || !scope) {
    throw new Error("Tutti i campi credenziali sono richiesti per acquisire il token.");
  }
  
  const tokenUrl = `/oauth-proxy/${tenantId}/oauth2/v2.0/token`;
  const bodyParams = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: scope
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`Richiesta token fallita (HTTP ${response.status}): ${errorDetails}`);
  }

  const data = await response.json();
  if (data && data.access_token) {
    localStorage.setItem("azure_api_token", data.access_token);
    
    // Save credentials in storage
    localStorage.setItem("azure_tenant_id", tenantId);
    localStorage.setItem("azure_client_id", clientId);
    localStorage.setItem("azure_client_secret", clientSecret);
    localStorage.setItem("azure_scope", scope);

    // Save expiration timestamp
    const expiresAt = Date.now() + (data.expires_in || 3599) * 1000;
    localStorage.setItem("azure_token_expires_at", expiresAt);

    return data.access_token;
  } else {
    throw new Error("Nessun access_token presente nella risposta di Azure AD.");
  }
}

/**
 * Automates token refreshing during sync runs
 */
async function autoRefreshAzureToken() {
  const simMode = isSimulatedMode();
  if (simMode) return;

  const expiresAt = parseInt(localStorage.getItem("azure_token_expires_at") || "0", 10);
  // Skip renewal if token is still valid for > 5 minutes
  if (expiresAt && Date.now() < expiresAt - 300 * 1000) {
    return;
  }

  const tenantId = localStorage.getItem("azure_tenant_id") || "";
  const clientId = localStorage.getItem("azure_client_id") || "";
  const clientSecret = localStorage.getItem("azure_client_secret") || "";
  const scope = localStorage.getItem("azure_scope") || "";

  if (tenantId && clientId && clientSecret && scope) {
    updateSettingsLogs("Rinnovo token automatico in corso...");
    try {
      const token = await runTokenAcquisition(tenantId, clientId, clientSecret, scope);
      const tokenIn = document.getElementById("api-token-input");
      if (tokenIn) tokenIn.value = token;
      updateSettingsLogs("Token Azure AD rinnovato con successo.");
    } catch (err) {
      updateSettingsLogs(`ERRORE rinnovo automatico token: ${err.message}`);
    }
  }
}

/**
 * Force refresh Azure token bypassing validity checks
 */
async function forceRefreshAzureToken() {
  const simMode = isSimulatedMode();
  if (simMode) return null;

  const tenantId = localStorage.getItem("azure_tenant_id") || "";
  const clientId = localStorage.getItem("azure_client_id") || "";
  const clientSecret = localStorage.getItem("azure_client_secret") || "";
  const scope = localStorage.getItem("azure_scope") || "";

  if (tenantId && clientId && clientSecret && scope) {
    updateSettingsLogs("[401 Rilevato] Rinnovo token forzato in corso...");
    try {
      const token = await runTokenAcquisition(tenantId, clientId, clientSecret, scope);
      const tokenIn = document.getElementById("api-token-input");
      if (tokenIn) tokenIn.value = token;
      updateSettingsLogs("Token Azure AD rinnovato con successo.");
      return token;
    } catch (err) {
      updateSettingsLogs(`ERRORE rinnovo forzato token: ${err.message}`);
    }
  }
  return null;
}

/**
 * Configuration & Administration Panel handlers.
 */
function setupSettingsHandlers() {
  const retSel = document.getElementById("retention-policy-select");
  const simCb = document.getElementById("api-simulation-cb");
  if (!retSel || !simCb) return;
  
  const tenantIn = document.getElementById("api-tenant-input");
  const clientIn = document.getElementById("api-client-input");
  const secretIn = document.getElementById("api-secret-input");
  const scopeIn = document.getElementById("api-scope-input");
  const acquireBtn = document.getElementById("acquire-token-btn");
  const tokenIn = document.getElementById("api-token-input");
  
  const startSyncBtn = document.getElementById("start-sync-btn");
  const syncDaysSel = document.getElementById("sync-days-select");
  const clearBtn = document.getElementById("clear-db-btn");

  const confirmModal = document.getElementById("confirm-clear-modal");
  const confirmYes = document.getElementById("modal-confirm-btn");
  const confirmNo = document.getElementById("modal-cancel-btn");

  // Load saved configurations
  retSel.value = state.retentionMonths;
  simCb.checked = isSimulatedMode();
  
  tenantIn.value = "Configurato nel backend (.env)";
  tenantIn.disabled = true;
  clientIn.value = "Configurato nel backend (.env)";
  clientIn.disabled = true;
  secretIn.value = "••••••••••••••••";
  secretIn.disabled = true;
  scopeIn.value = "Configurato nel backend (.env)";
  scopeIn.disabled = true;
  tokenIn.value = "Gestione automatica nel backend";
  tokenIn.disabled = true;

  simCb.addEventListener("change", (e) => {
    setSimulatedMode(e.target.checked);
  });

  // Acquire button behaves as a backend health check
  acquireBtn.innerHTML = "🔌 Verifica Connessione Backend";
  acquireBtn.onclick = async () => {
    updateSettingsLogs("Verifica connessione backend in corso...");
    acquireBtn.disabled = true;
    try {
      const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
      const response = await fetch(`${apiUrl}/api/health`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.status === 'online') {
        const confMsg = data.apiConfigured ? "configurato correttamente" : "non ancora configurato (imposta il file .env)";
        updateSettingsLogs(`Backend connesso con successo: Stato ${data.status.toUpperCase()}, API Azure ${confMsg}.`);
        alert(`Connessione al backend riuscita!\nStato: ${data.status}\nAPI configurate: ${data.apiConfigured}`);
      } else {
        updateSettingsLogs(`Stato backend imprevisto: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      updateSettingsLogs(`ERRORE connessione backend: ${err.message}. Verifica che il server backend sia avviato.`);
      alert(`Errore connessione backend: ${err.message}\nVerifica che il server sia avviato.`);
    } finally {
      acquireBtn.disabled = false;
    }
  };

  retSel.addEventListener("change", async (e) => {
    state.retentionMonths = parseInt(e.target.value, 10);
    // Enforce retention policy immediately
    await enforceRetentionPolicy();
  });

  // Clear Database logic with confirmation modal
  clearBtn.onclick = () => confirmModal.classList.add("active");
  confirmNo.onclick = () => confirmModal.classList.remove("active");
  confirmYes.onclick = async () => {
    confirmModal.classList.remove("active");
    await clearDatabase();
    updateSettingsLogs("Archivio svuotato con successo.");
    // Clear sync progress bar
    document.getElementById("sync-progress-fill").style.width = "0%";
    document.getElementById("sync-progress-text").innerText = "Nessuna sincronizzazione in corso";
    sendSWMessage({ action: "CANCEL_SYNC" });
  };

  const unregisterSwBtn = document.getElementById("unregister-sw-btn");
  if (unregisterSwBtn) {
    unregisterSwBtn.onclick = async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        let count = 0;
        for (const reg of registrations) {
          await reg.unregister();
          count++;
        }
        updateSettingsLogs(`[SW Manager] Disinstallati ${count} Service Worker attivi.`);
        alert(`Disinstallati con successo ${count} Service Worker. La pagina verrà ricaricata.`);
        window.location.reload();
      } catch (err) {
        updateSettingsLogs(`[SW Manager ERROR] Errore disinstallazione: ${err.message}`);
        alert(`Errore durante la disinstallazione: ${err.message}`);
      }
    };
  }

  const startSelectiveSyncBtn = document.getElementById("start-selective-sync-btn");

  // Mass Sync trigger
  startSyncBtn.onclick = () => {
    const daysToSync = parseInt(syncDaysSel.value, 10);
    state.syncDaysRange = daysToSync;
    triggerMassHistoricalSync(false); // Mass Sync (Overwrite)
  };

  if (startSelectiveSyncBtn) {
    startSelectiveSyncBtn.onclick = () => {
      const daysToSync = parseInt(syncDaysSel.value, 10);
      state.syncDaysRange = daysToSync;
      triggerMassHistoricalSync(true); // Selective Sync (Gap Recovery)
    };
  }

  const stopSyncBtn = document.getElementById("stop-sync-btn");
  if (stopSyncBtn) {
    stopSyncBtn.onclick = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
        await fetch(`${apiUrl}/api/sync/cancel`, {
          method: "POST",
          headers: getAuthHeaders()
        });
      } catch (e) {
        console.warn("[Cancel Sync] Failed:", e);
      }
    };
  }

  const clearLogsBtn = document.getElementById("clear-logs-btn");
  if (clearLogsBtn) {
    clearLogsBtn.onclick = () => {
      const consolePre = document.getElementById("console-logs");
      if (consolePre) {
        consolePre.textContent = "";
      }
    };
  }

  // Custom Fleet Import logic
  const fleetTextarea = document.getElementById("fleet-import-textarea");
  const saveFleetBtn = document.getElementById("save-fleet-import-btn");
  const resetFleetBtn = document.getElementById("reset-fleet-import-btn");

  // Load existing raw custom text if stored
  if (fleetTextarea) {
    fleetTextarea.value = localStorage.getItem("custom_up_raw_text") || "";
  }

  if (saveFleetBtn) {
    saveFleetBtn.onclick = () => {
      const rawText = fleetTextarea.value.trim();
      if (!rawText) {
        alert("Inserisci o incolla una lista di nomi prima di salvare.");
        return;
      }

      const lines = rawText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      const customList = [];

      lines.forEach((line, idx) => {
        if (line.includes(";")) {
          // Extended format: Name;Tech;Region;Capacity
          const parts = line.split(";").map(p => p.trim());
          const name = parts[0];
          const tech = (parts[1] && parts[1].toLowerCase() === "wind") ? "Wind" : "Solar";
          const region = parts[2] || "Sicilia";
          const capacity = parseFloat(parts[3]) || null;
          const id = `UP_C_${String(idx + 1).padStart(2, '0')}`;
          customList.push({
            id,
            name,
            tech,
            region,
            capacity,
            lat: 37.0 + ((idx * 13) % 100) / 15,
            lon: 12.0 + ((idx * 17) % 100) / 18
          });
        } else {
          // Name-only format
          const name = line;
          const lowerName = name.toLowerCase();
          let tech = "Solar";
          if (lowerName.includes("wind") || lowerName.includes("eolico") || lowerName.includes("pala") || lowerName.includes("vento") || lowerName.includes("turbina")) {
            tech = "Wind";
          }
          const id = `UP_C_${String(idx + 1).padStart(2, '0')}`;
          customList.push({
            id,
            name,
            tech,
            region: "Sicilia", // default
            capacity: null,
            lat: 37.0 + ((idx * 13) % 100) / 15,
            lon: 12.0 + ((idx * 17) % 100) / 18
          });
        }
      });

      if (customList.length === 0) {
        alert("Nessuna UP valida estratta dal testo inserito.");
        return;
      }

      // Save raw text locally for form preservation
      localStorage.setItem("custom_up_raw_text", rawText);

      // Save structured fleet to backend database
      const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
      fetch(`${apiUrl}/api/registry`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(customList)
      })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        await loadUPRegistry();
        
        // Re-populate region and search dropdowns in Sidebar
        populateDropdowns();
        
        updateSettingsLogs(`Flotta UP personalizzata importata con successo. Caricate ${customList.length} UP.`);
        alert(`Flotta importata con successo! Caricate ${customList.length} UP.`);
        applyFiltersAndRender();
      })
      .catch(err => {
        console.error(err);
        alert(`Errore salvataggio flotta sul database: ${err.message}`);
      });
    };
  }

  if (resetFleetBtn) {
    resetFleetBtn.onclick = () => {
      if (confirm("Sei sicuro di voler ripristinare la flotta di default (100 UP)?")) {
        localStorage.removeItem("custom_up_raw_text");
        if (fleetTextarea) fleetTextarea.value = "";

        const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
        fetch(`${apiUrl}/api/registry/reset`, {
          method: "POST",
          headers: getAuthHeaders()
        })
        .then(async response => {
          if (!response.ok) throw new Error(`HTTP error ${response.status}`);
          await loadUPRegistry();
          populateDropdowns();
          updateSettingsLogs("Flotta UP ripristinata ai valori predefiniti (100 UP).");
          alert("Flotta ripristinata ai valori predefiniti!");
          applyFiltersAndRender();
        })
        .catch(err => {
          console.error(err);
          alert(`Errore reset flotta sul database: ${err.message}`);
        });
      }
    };
  }

  const refreshUsersBtn = document.getElementById("refresh-users-btn");
  if (refreshUsersBtn) {
    refreshUsersBtn.onclick = () => loadUsersTable();
  }
}

async function enforceRetentionPolicy() {
  const limitDate = new Date();
  limitDate.setMonth(limitDate.getMonth() - state.retentionMonths);
  const limitDateStr = limitDate.toISOString().split("T")[0];

  const results = await deleteOlderThan(limitDateStr);
  updateSettingsLogs(`Cancellazione Retention Policy eseguita. Rimossi record anteriori al ${limitDateStr} (Obs: ${results.observations}, Outages: ${results.outages})`);
}

/**
 * Triggers background mass historical sync.
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Triggers background mass historical sync.
 */
async function triggerMassHistoricalSync(isSelective = false) {
  if (state.isSyncRunning) {
    alert("Una sincronizzazione storica è già in corso. Attendi il completamento o arrestala.");
    return;
  }

  const activeRange = getActiveDateRange();
  const rangeDays = (activeRange && activeRange.length > 0) ? activeRange.length : state.syncDaysRange;
  const syncUpSel = document.getElementById("sync-up-select");
  const selectedUpId = syncUpSel ? syncUpSel.value : "all";
  const simMode = isSimulatedMode();

  updateSettingsLogs("Invio richiesta di sincronizzazione al backend...");
  
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/sync/start`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ rangeDays, isSelective, upId: selectedUpId, simMode })
    });

    if (!response.ok) {
      const err = await response.json();
      updateSettingsLogs(`ERRORE avvio sync: ${err.error}`);
      return;
    }

    updateSettingsLogs(`Sincronizzazione ${isSelective ? "Selettiva/Gap" : "Massiva/Riscrivi"} avviata sul backend. Monitoraggio in corso...`);
    state.isSyncRunning = true;
    startSyncStatusPoller();
    updateSyncUI();

  } catch (err) {
    updateSettingsLogs(`ERRORE avvio sync: ${err.message}`);
  }
}

async function triggerUPSync(upId, isSelective = true) {
  const range = getActiveDateRange();
  if (!range || range.length === 0) return;

  const up = getUPById(upId);
  if (!up) return;

  const rangeDays = range.length;
  const simMode = isSimulatedMode();

  updateSettingsLogs(`Invio richiesta di recupero dati per UP ${up.name} al backend...`);

  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/sync/start`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ rangeDays, isSelective, upId, simMode })
    });

    if (!response.ok) {
      const err = await response.json();
      updateSettingsLogs(`ERRORE avvio sync per UP ${up.name}: ${err.error}`);
      return;
    }

    updateSettingsLogs(`Recupero dati per UP ${up.name} avviato sul backend. Monitoraggio in corso...`);
    showToastNotification(`Avviato recupero dati per ${up.name}`);
    state.isSyncRunning = true;
    startSyncStatusPoller();
    updateSyncUI();

  } catch (err) {
    updateSettingsLogs(`ERRORE avvio sync per UP ${up.name}: ${err.message}`);
  }
}

function getYesterdayDateString() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const parts = formatter.formatToParts(d);
  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${year}-${month}-${day}`;
}

async function triggerYesterdaySync(isAuto = false) {
  const yesterdayStr = getYesterdayDateString();
  
  // Initialize storage if new day
  const storedDate = localStorage.getItem("yesterday_sync_date");
  if (storedDate !== yesterdayStr) {
    localStorage.setItem("yesterday_sync_date", yesterdayStr);
    localStorage.setItem("yesterday_sync_status", "pending");
  }

  // If already completed for yesterday, do nothing if it's an auto-trigger
  const status = localStorage.getItem("yesterday_sync_status");
  if (isAuto && status === "completed") {
    console.log(`[Auto-Sync] Yesterday's sync already completed on ${yesterdayStr}.`);
    return;
  }

  if (state.isSyncRunning) {
    return;
  }

  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/sync/start`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ rangeDays: 1, isSelective: true, upId: "all", simMode: isSimulatedMode() })
    });

    if (!response.ok) {
      const err = await response.json();
      updateSettingsLogs(`[Auto-Sync] ERRORE avvio: ${err.error}`);
      return;
    }

    state.isSyncRunning = true;
    localStorage.setItem("yesterday_sync_status", "completed");
    updateSettingsLogs("Sincronizzazione dati di ieri avviata con successo sul backend.");
    startSyncStatusPoller();
  } catch (err) {
    updateSettingsLogs(`[Auto-Sync] ERRORE di rete: ${err.message}`);
  }
}

function showToastNotification(message) {
  const existing = document.getElementById("app-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "app-toast";
  toast.style.position = "fixed";
  toast.style.bottom = "24px";
  toast.style.right = "24px";
  toast.style.background = "rgba(13, 16, 27, 0.95)";
  toast.style.border = "1px solid rgba(59, 130, 246, 0.4)";
  toast.style.borderLeft = "4px solid #3b82f6";
  toast.style.color = "#f3f4f6";
  toast.style.padding = "12px 20px";
  toast.style.borderRadius = "8px";
  toast.style.boxShadow = "0 10px 25px -5px rgba(0,0,0,0.5)";
  toast.style.zIndex = "3000";
  toast.style.fontFamily = "var(--font-sans, sans-serif)";
  toast.style.fontSize = "0.85rem";
  toast.style.display = "flex";
  toast.style.alignItems = "center";
  toast.style.gap = "10px";
  toast.style.opacity = "0";
  toast.style.transform = "translateY(10px)";
  toast.style.transition = "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)";

  toast.innerHTML = `<span style="color:#60a5fa; font-size:1.1rem;">⚡</span> <span>${message}</span>`;
  
  document.body.appendChild(toast);

  // Force reflow
  toast.offsetHeight;

  // Show
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  // Hide after 3.5 seconds
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}

window.triggerUPSync = triggerUPSync;

function updateSettingsLogs(message = null) {
  const consolePre = document.getElementById("console-logs");
  if (!consolePre) return;

  if (message) {
    const timestamp = new Date().toLocaleTimeString();
    consolePre.textContent += `[${timestamp}] ${message}\n`;
    consolePre.scrollTop = consolePre.scrollHeight;
  }
}
window.updateSettingsLogs = updateSettingsLogs;


async function updatePersistenceBadge() {
  const indicator = document.getElementById("persist-status-indicator");
  const textLabel = document.getElementById("persist-status-label");
  if (!indicator || !textLabel) return;
  
  const persisted = await getPersistenceStatus();
  if (persisted) {
    indicator.className = "status-indicator online";
    textLabel.innerText = "IDB Persistente Garantito";
  } else {
    indicator.className = "status-indicator";
    indicator.style.backgroundColor = "var(--accent-orange)";
    indicator.style.boxShadow = "0 0 8px var(--accent-orange)";
    textLabel.innerText = "IDB Temporaneo (Best Effort)";
  }
}

/**
 * Print database integrity record count and sample keys to the console log
 */
async function printDatabaseDiagnostics() {
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/db/stats`, {
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    updateSettingsLogs(`[DB Diagnostics] Record Osservazioni: ${stats.observations} | Record Outages: ${stats.outages}`);
  } catch (err) {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    updateSettingsLogs(`[DB Diagnostics ERROR] ${err.message} (URL: ${apiUrl}/api/db/stats)`);
  }
}

let fleetRedrawTimeout = null;
function triggerFleetRedrawThrottled() {
  if (fleetRedrawTimeout) return;
  fleetRedrawTimeout = setTimeout(() => {
    fleetRedrawTimeout = null;
    if (state.view === "fleet") {
      applyFiltersAndRender();
    }
  }, 1000); // Throttled to max once per 1 second during sync
}

let isAnimating = false;
function startHeatmapAnimation() {
  if (isAnimating) return;
  isAnimating = true;
  function frame() {
    if (state.view === "fleet" && state.isSyncRunning) {
      if (window.redrawHeatmapCached) {
        window.redrawHeatmapCached();
      }
      requestAnimationFrame(frame);
    } else {
      isAnimating = false;
    }
  }
  requestAnimationFrame(frame);
}

let syncPollInterval = null;

function updateSettingsLogsFromBackend(logs) {
  const consoleEl = document.getElementById("settings-logs");
  if (!consoleEl) return;
  consoleEl.value = logs.join("\n") + "\n";
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function startSyncStatusPoller() {
  if (syncPollInterval) return;

  const poll = async () => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
      const response = await fetch(`${apiUrl}/api/sync/status`, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();

      const wasRunning = state.isSyncRunning;
      state.isSyncRunning = data.isSyncRunning;
      state.totalTasks = data.totalTasks;
      state.completedTasks = data.completedTasks;
      
      // Update active sync tasks for cell rendering
      state.activeSyncTasks = data.activeSyncTasks || {};

      if (state.view === "fleet" && window.redrawHeatmapCached) {
        window.redrawHeatmapCached();
      }

      updateSyncUI();

      if (data.logs && data.logs.length > 0) {
        updateSettingsLogsFromBackend(data.logs);
      }

      if (wasRunning && !data.isSyncRunning) {
        updateSettingsLogs("Sincronizzazione completata o interrotta dal backend.");
        clearInterval(syncPollInterval);
        syncPollInterval = null;
        
        // Wait 500ms to allow DB writes/replication to fully settle before reloading
        setTimeout(() => {
          clearClientCaches(); // Reset client caches to load new database observations
          printDatabaseDiagnostics();
          if (state.view === "fleet") {
            applyFiltersAndRender();
          } else if (state.view === "detail") {
            renderDeepDivePanel();
          }
        }, 500);
      }
    } catch (err) {
      console.warn("[Sync Poller] Failed to query status:", err.message);
    }
  };

  poll();
  syncPollInterval = setInterval(poll, 1500);
}

async function checkSyncStatusOnStartup() {
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/sync/status`, {
      headers: getAuthHeaders()
    });
    if (response.ok) {
      const data = await response.json();
      if (data.isSyncRunning) {
        startSyncStatusPoller();
      } else {
        if (data.logs && data.logs.length > 0) {
          updateSettingsLogsFromBackend(data.logs);
        }
      }
    }
  } catch (e) {
    console.warn("[Startup Sync Check] Failed:", e);
  }
}

// sendTaskToSW removed - tasks are executed directly in the main thread via backend REST API.

/**
 * Updates progress and status labels inside UI
 */
function updateSyncUI() {
  const badge = document.getElementById("sync-status-indicator");
  const textLabel = document.getElementById("sync-status-label");
  const barFill = document.getElementById("sync-progress-fill");
  const barText = document.getElementById("sync-progress-text");
  const stopSyncBtn = document.getElementById("stop-sync-btn");

  if (state.isSyncRunning) {
    badge.className = "status-indicator syncing";
    const percent = state.totalTasks > 0 ? Math.round((state.completedTasks / state.totalTasks) * 100) : 0;
    textLabel.innerText = `Sync in corso (${percent}%)`;
    if (stopSyncBtn) stopSyncBtn.style.display = "inline-flex";
    
    if (barFill && barText) {
      barFill.style.width = `${percent}%`;
      barText.innerText = `${state.completedTasks} di ${state.totalTasks} richieste completate (${percent}%)`;
    }
  } else {
    badge.className = "status-indicator online";
    textLabel.innerText = "Sync in Background Attivo";
    if (stopSyncBtn) stopSyncBtn.style.display = "none";
    
    if (barFill && barText) {
      barFill.style.width = "0%";
      barText.innerText = "Nessuna sincronizzazione in corso";
    }
  }
}

let queuePollInterval = null;

/**
 * Starts a background poller to query the backend request queue status.
 */
function startQueueStatusPoller() {
  if (queuePollInterval) return;
  
  const poll = async () => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
      
      // Pass parameters if current view is a detail observation to get position
      let queryParams = "";
      if (state.view === "detail" && state.selectedUP && state.selectedDate) {
        queryParams = `?upId=${state.selectedUP}&date=${state.selectedDate}&type=scada`;
      }
      
      const response = await fetch(`${apiUrl}/api/queue/status${queryParams}`, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      
      updateQueueStatusUI(data);
    } catch (err) {
      console.warn("[Queue Poller] Failed to query status:", err.message);
    }
  };
  
  poll();
  queuePollInterval = setInterval(poll, 1500);
}

/**
 * Draws the queue status banner in the left sidebar.
 */
function updateQueueStatusUI(statusData) {
  const badge = document.getElementById("queue-status-badge");
  const title = document.getElementById("queue-status-title");
  const desc = document.getElementById("queue-status-desc");
  
  if (!badge || !title || !desc) return;
  
  if (statusData.queueLength > 0) {
    badge.style.display = "flex";
    title.innerText = `CODA SERVER: ${statusData.queueLength}`;
    
    if (statusData.position > 0) {
      desc.innerHTML = `La tua richiesta è in coda<br><strong style="color: #60a5fa;">Posizione: #${statusData.position}</strong>`;
    } else {
      desc.innerHTML = `<strong style="color: #60a5fa;">${statusData.activeCount} in corso</strong> e ${statusData.queueLength - statusData.activeCount} in attesa`;
    }
  } else {
    badge.style.display = "none";
  }
}

/**
 * Handles real Google Sign-In response
 */
function handleCredentialResponse(response) {
  const token = response.credential;
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    
    const payload = JSON.parse(jsonPayload);
    
    const user = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      token: token
    };
    
    loginUser(user);
  } catch (err) {
    console.error('[Auth] Failed to parse google credential:', err);
    alert('Errore di autenticazione con Google.');
  }
}

/**
 * Handles mock login for local development
 */
function handleMockLogin() {
  const user = {
    name: 'Sviluppatore PZero (Demo)',
    email: 'demo.developer@pzero.io',
    picture: '',
    token: 'mock-google-token-id'
  };
  loginUser(user);
}

/**
 * Persists session and updates the UI state
 */
function loginUser(user) {
  state.user = user;
  localStorage.setItem("google_user_session", JSON.stringify(user));
  
  // Update sidebar profile widget
  const widget = document.getElementById("user-profile-widget");
  const avatarImg = document.getElementById("user-avatar-img");
  const avatarFallback = document.getElementById("user-avatar-fallback");
  const displayName = document.getElementById("user-display-name");
  
  if (widget && displayName) {
    widget.style.display = "flex";
    displayName.innerText = user.name;
    displayName.title = user.email;
    
    if (user.picture) {
      avatarImg.src = user.picture;
      avatarImg.style.display = "block";
      avatarFallback.style.display = "none";
    } else {
      avatarImg.style.display = "none";
      avatarFallback.style.display = "flex";
      
      const parts = user.name.split(' ');
      const initials = parts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
      avatarFallback.innerText = initials || 'US';
    }
  }

  // Fade out and hide login screen overlay
  const loginScreen = document.getElementById("login-screen");
  if (loginScreen) {
    loginScreen.style.opacity = "0";
    setTimeout(() => {
      loginScreen.style.display = "none";
    }, 500);
  }
  
  console.log(`[Auth] User ${user.email} successfully logged in.`);
  
  // Initialize and load everything securely with auth headers active
  (async () => {
    try {
      // 1. Fetch complete profile including the database role
      const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
      const profileRes = await fetch(`${apiUrl}/api/auth/profile`, {
        headers: getAuthHeaders()
      });
      if (!profileRes.ok) throw new Error("Failed to load user profile");
      const profile = await profileRes.json();
      state.user.role = profile.role; // Set the role from backend database!
      
      // Update session storage with the role
      localStorage.setItem("google_user_session", JSON.stringify(state.user));
      
      // 2. Hide or show settings and ppa nav tabs based on admin role
      const navSettingsBtn = document.getElementById("nav-settings-btn");
      const navPpaBtn = document.getElementById("nav-ppa-btn");
      if (navSettingsBtn) {
        if (state.user.role === 'admin') {
          navSettingsBtn.style.setProperty("display", "flex", "important");
        } else {
          navSettingsBtn.style.setProperty("display", "none", "important");
          // If the user was somehow looking at settings, redirect them to map
          if (state.view === "settings") {
            navigateToView("fleet");
          }
        }
      }
      if (navPpaBtn) {
        if (state.user.role === 'admin') {
          navPpaBtn.style.setProperty("display", "flex", "important");
        } else {
          navPpaBtn.style.setProperty("display", "none", "important");
          // If the user was somehow looking at PPA panel, redirect them to map
          if (state.view === "ppa") {
            navigateToView("fleet");
          }
        }
      }

      await fetchPPATagsFromServer();
      await initDB();
      await loadUPRegistry();
      startQueueStatusPoller();
      
      if (state.user.role === 'admin') {
        loadUsersTable(); // Load the users management table if admin!
      }
      
      // Re-populate dropdowns
      if (typeof populateDropdowns === 'function') {
        populateDropdowns();
      }
      
      // Update badge
      if (typeof updatePersistenceBadge === 'function') {
        updatePersistenceBadge();
      }
      await checkSyncStatusOnStartup();
      applyFiltersAndRender();
    } catch (err) {
      console.error("[Auth Boot] Failed to load secure backend data:", err);
      logoutUser(); // Force logout to clear invalid/expired token and show login screen
    }
  })();
}

/**
 * Handles user logout
 */
function logoutUser() {
  state.user = null;
  localStorage.removeItem("google_user_session");
  
  // Show login screen
  const loginScreen = document.getElementById("login-screen");
  if (loginScreen) {
    loginScreen.style.opacity = "1";
    loginScreen.style.display = "flex";
  }
  
  // Hide sidebar widget
  const widget = document.getElementById("user-profile-widget");
  if (widget) widget.style.display = "none";

  // Hide settings nav tab for security
  const navSettingsBtn = document.getElementById("nav-settings-btn");
  if (navSettingsBtn) {
    navSettingsBtn.style.setProperty("display", "none", "important");
  }
  
  console.log('[Auth] User logged out.');
}

// ====================================================
// PPA (POWER PURCHASE AGREEMENT) MANAGEMENT SECTION
// ====================================================

function loadPPATags() {
  return state.ppaTags || [];
}

async function savePPATagToServer(name, color) {
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/ppa/tags`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ name, color })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    await fetchPPATagsFromServer();
  } catch (err) {
    console.error("[PPA] Failed to save tag:", err);
  }
}

async function deletePPATagFromServer(name) {
  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/ppa/tags`, {
      method: "DELETE",
      headers: getAuthHeaders(),
      body: JSON.stringify({ name })
    });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    await fetchPPATagsFromServer();
  } catch (err) {
    console.error("[PPA] Failed to delete tag:", err);
  }
}

// Global selection state for UPs in the table
let ppaSelectedUPs = new Set();

function renderPPAPanel() {
  const tagsListContainer = document.getElementById("ppa-tags-list");
  const upTableTbody = document.getElementById("ppa-up-table-tbody");
  const batchSelect = document.getElementById("ppa-batch-tag-select");

  if (!tagsListContainer || !upTableTbody || !batchSelect) return;

  const tags = loadPPATags();

  // 1. Populate Batch dropdown select
  const currentSelectVal = batchSelect.value;
  batchSelect.innerHTML = `<option value="">-- Seleziona Partner --</option>` + 
    tags.map(t => `<option value="${t.name}">${t.name}</option>`).join("");
  batchSelect.value = currentSelectVal;

  // 2. Render Left Sidebar Tags List
  tagsListContainer.innerHTML = tags.map(tag => {
    // Count UPs assigned to this tag
    const count = UP_REGISTRY.filter(up => up.ppaTag === tag.name).length;
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(255,255,255,0.02); border: 1px solid var(--panel-border); border-radius: 8px; font-size: 0.75rem;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 10px; height: 10px; border-radius: 50%; background-color: ${tag.color}; box-shadow: 0 0 6px ${tag.color};"></div>
          <div>
            <div style="font-weight: 600; color: var(--text-main);">${tag.name}</div>
            <div style="font-size: 0.65rem; color: var(--text-muted);">${count} unità assegnate</div>
          </div>
        </div>
        <button class="icon-btn ppa-delete-tag-btn" data-tag-name="${tag.name}" style="background: none; border: none; color: #f87171; cursor: pointer; font-size: 0.8rem; padding: 4px; border-radius: 4px;" title="Elimina Partner">
          🗑️
        </button>
      </div>
    `;
  }).join("");

  // Bind delete tag buttons
  tagsListContainer.querySelectorAll(".ppa-delete-tag-btn").forEach(btn => {
    btn.onclick = () => {
      const tagName = btn.dataset.tagName;
      if (confirm(`Sei sicuro di voler eliminare il partner "${tagName}"? Tutte le UP ad esso assegnate verranno dissociate.`)) {
        deletePPATagFromServer(tagName).then(() => {
          // Dissociate UPs
          UP_REGISTRY.forEach(up => {
            if (up.ppaTag === tagName) {
              delete up.ppaTag;
              delete up.ppaColor;
              delete up.ppa_partner;
            }
          });
          const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
          return fetch(`${apiUrl}/api/registry`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(UP_REGISTRY)
          });
        }).then(() => {
          renderPPAPanel();
          applyFiltersAndRender();
        });
      }
    };
  });

  // 3. Render UP table body
  const searchQuery = (document.getElementById("ppa-up-search").value || "").toLowerCase().trim();
  const showOnlyUnassigned = document.getElementById("ppa-filter-unassigned").checked;

  const filteredUPs = UP_REGISTRY.filter(up => {
    // Filter by search query
    if (searchQuery) {
      const nameMatch = up.name.toLowerCase().includes(searchQuery);
      const idMatch = up.id.toLowerCase().includes(searchQuery);
      const tagMatch = up.ppaTag ? up.ppaTag.toLowerCase().includes(searchQuery) : false;
      const techMatch = up.tech.toLowerCase().includes(searchQuery);
      const regMatch = up.region.toLowerCase().includes(searchQuery);
      if (!nameMatch && !idMatch && !tagMatch && !techMatch && !regMatch) return false;
    }
    // Filter by unassigned
    if (showOnlyUnassigned && up.ppaTag) {
      return false;
    }
    return true;
  });

  // Check if select-all checkbox should be checked
  const selectAllCb = document.getElementById("ppa-select-all-ups");
  if (selectAllCb) {
    const allFilteredSelected = filteredUPs.length > 0 && filteredUPs.every(up => ppaSelectedUPs.has(up.id));
    selectAllCb.checked = allFilteredSelected;
  }

  // Draw rows
  upTableTbody.innerHTML = filteredUPs.map(up => {
    const isSelected = ppaSelectedUPs.has(up.id);
    const tagBadge = up.ppaTag ? `
      <span style="display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 12px; background: ${up.ppaColor}1a; border: 1px solid ${up.ppaColor}40; color: ${up.ppaColor}; font-weight: 600; font-size: 0.65rem;">
        <span style="width: 6px; height: 6px; border-radius: 50%; background: ${up.ppaColor};"></span>
        ${up.ppaTag}
      </span>
    ` : `<span style="color: var(--text-muted); font-style: italic;">Nessuno</span>`;

    return `
      <tr style="border-bottom: 1px solid var(--panel-border); background: ${isSelected ? "rgba(59, 130, 246, 0.05)" : "transparent"}; transition: background 0.15s; height: 35px;">
        <td style="padding: 6px 12px; text-align: center;">
          <input type="checkbox" class="ppa-up-row-cb" data-up-id="${up.id}" ${isSelected ? "checked" : ""} style="cursor: pointer;">
        </td>
        <td style="padding: 6px 12px; font-family: var(--font-mono); font-weight: 600; color: var(--text-main);">${up.id}</td>
        <td style="padding: 6px 12px; font-weight: 600; color: ${up.ppaColor || "var(--text-main)"};">${up.name}</td>
        <td style="padding: 6px 12px; color: var(--text-muted);">${up.tech}</td>
        <td style="padding: 6px 12px; color: var(--text-muted);">${up.region}</td>
        <td style="padding: 6px 12px;">${tagBadge}</td>
      </tr>
    `;
  }).join("");

  // Bind row checkbox event listeners
  upTableTbody.querySelectorAll(".ppa-up-row-cb").forEach(cb => {
    cb.onchange = (e) => {
      const id = cb.dataset.upId;
      if (cb.checked) {
        ppaSelectedUPs.add(id);
      } else {
        ppaSelectedUPs.delete(id);
      }
      updatePPASelectionCount();
      // Re-highlight row background without full re-render
      const tr = cb.closest("tr");
      if (tr) {
        tr.style.background = cb.checked ? "rgba(59, 130, 246, 0.05)" : "transparent";
      }
    };
  });

  updatePPASelectionCount();
  populateDropdowns();
}

function updatePPASelectionCount() {
  const selectionStatusLabel = document.getElementById("ppa-selection-status");
  if (selectionStatusLabel) {
    selectionStatusLabel.innerText = `Selezionate: ${ppaSelectedUPs.size} / 100 UP`;
  }
}

// Bind PPA Setup Handlers once
function setupPPAHandlers() {
  // Create Tag Button
  const createTagBtn = document.getElementById("ppa-create-tag-btn");
  if (createTagBtn) {
    createTagBtn.onclick = () => {
      const nameInput = document.getElementById("ppa-new-tag-name");
      const colorInput = document.getElementById("ppa-new-tag-color");
      if (!nameInput || !colorInput) return;

      const name = nameInput.value.trim();
      const color = colorInput.value;

      if (!name) {
        alert("Inserisci un nome valido per il partner PPA.");
        return;
      }

      const tags = loadPPATags();
      if (tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
        alert("Un partner con questo nome esiste già.");
        return;
      }

      savePPATagToServer(name, color).then(() => {
        // Reset form
        nameInput.value = "";
        colorInput.value = "#3b82f6";
        renderPPAPanel();
      });
    };
  }

  // Search Input
  const searchInput = document.getElementById("ppa-up-search");
  if (searchInput) {
    searchInput.oninput = () => renderPPAPanel();
  }

  // Filter Unassigned Checkbox
  const unassignedCb = document.getElementById("ppa-filter-unassigned");
  if (unassignedCb) {
    unassignedCb.onchange = () => renderPPAPanel();
  }

  // Select All Checkbox
  const selectAllCb = document.getElementById("ppa-select-all-ups");
  if (selectAllCb) {
    selectAllCb.onchange = (e) => {
      const isChecked = e.target.checked;
      
      // Get all filtered UPs currently visible
      const searchQuery = (document.getElementById("ppa-up-search").value || "").toLowerCase().trim();
      const showOnlyUnassigned = document.getElementById("ppa-filter-unassigned").checked;

      const visibleUPs = UP_REGISTRY.filter(up => {
        if (searchQuery) {
          const nameMatch = up.name.toLowerCase().includes(searchQuery);
          const idMatch = up.id.toLowerCase().includes(searchQuery);
          const tagMatch = up.ppaTag ? up.ppaTag.toLowerCase().includes(searchQuery) : false;
          const techMatch = up.tech.toLowerCase().includes(searchQuery);
          const regMatch = up.region.toLowerCase().includes(searchQuery);
          if (!nameMatch && !idMatch && !tagMatch && !techMatch && !regMatch) return false;
        }
        if (showOnlyUnassigned && up.ppaTag) return false;
        return true;
      });

      visibleUPs.forEach(up => {
        if (isChecked) {
          ppaSelectedUPs.add(up.id);
        } else {
          ppaSelectedUPs.delete(up.id);
        }
      });

      renderPPAPanel();
    };
  }

  // Apply Batch Assignment Button
  const applyBtn = document.getElementById("ppa-apply-assignment-btn");
  if (applyBtn) {
    applyBtn.onclick = () => {
      if (ppaSelectedUPs.size === 0) {
        alert("Seleziona prima una o più unità (UP) dalla tabella.");
        return;
      }

      const batchSelect = document.getElementById("ppa-batch-tag-select");
      const selectedTagName = batchSelect.value;
      if (!selectedTagName) {
        alert("Seleziona un partner PPA dal menu a tendina.");
        return;
      }

      const tags = loadPPATags();
      const matchedTag = tags.find(t => t.name === selectedTagName);
      if (!matchedTag) return;

      // Update selected UPs
      UP_REGISTRY.forEach(up => {
        if (ppaSelectedUPs.has(up.id)) {
          up.ppaTag = matchedTag.name;
          up.ppaColor = matchedTag.color;
          up.ppa_partner = matchedTag.name;
        }
      });

      // Save registry to backend database
      const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
      fetch(`${apiUrl}/api/registry`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(UP_REGISTRY)
      })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        ppaSelectedUPs.clear();
        showToastNotification(`Assegnate UP a ${matchedTag.name}`);
        renderPPAPanel();
      })
      .catch(err => {
        console.error(err);
        alert(`Errore nel salvataggio dell'assegnazione: ${err.message}`);
      });
    };
  }

  // Clear Batch Assignment Button
  const clearBtn = document.getElementById("ppa-clear-assignment-btn");
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (ppaSelectedUPs.size === 0) {
        alert("Seleziona prima una o più unità (UP) dalla tabella.");
        return;
      }

      if (confirm(`Sei sicuro di voler rimuovere l'assegnazione PPA per le ${ppaSelectedUPs.size} unità selezionate?`)) {
        UP_REGISTRY.forEach(up => {
          if (ppaSelectedUPs.has(up.id)) {
            delete up.ppaTag;
            delete up.ppaColor;
            delete up.ppa_partner;
          }
        });

        // Save registry to backend database
        const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
        fetch(`${apiUrl}/api/registry`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify(UP_REGISTRY)
        })
        .then(response => {
          if (!response.ok) throw new Error(`HTTP error ${response.status}`);
          ppaSelectedUPs.clear();
          showToastNotification("Rimosse assegnazioni PPA per le UP selezionate");
          renderPPAPanel();
        })
        .catch(err => {
          console.error(err);
          alert(`Errore nella cancellazione dell'assegnazione: ${err.message}`);
        });
      }
    };
  }
}

/**
 * Fetches and renders the User Management table inside the Settings View.
 */
async function loadUsersTable() {
  const tbody = document.getElementById("settings-users-tbody");
  const refreshBtn = document.getElementById("refresh-users-btn");
  if (!tbody) return;

  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
    const response = await fetch(`${apiUrl}/api/users`, {
      headers: getAuthHeaders()
    });
    
    if (!response.ok) {
      if (response.status === 403) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #f87171; font-style: italic; padding: 20px;">Accesso negato. Privilegi di amministratore richiesti.</td></tr>`;
        return;
      }
      throw new Error(`HTTP error ${response.status}`);
    }

    const users = await response.json();
    
    tbody.innerHTML = users.map(user => {
      const isOwner = user.email === 'fnicora@gmail.com';
      const isSelf = user.email === (state.user ? state.user.email : '');
      const isAdmin = user.role === 'admin';
      
      // Avatar initials
      const parts = user.name.split(' ');
      const initials = parts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
      
      const avatarHtml = user.picture 
        ? `<img src="${user.picture}" alt="" style="width: 24px; height: 24px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.1);">`
        : `<div style="width: 24px; height: 24px; border-radius: 50%; background: ${isAdmin ? 'linear-gradient(135deg, #a855f7, #3b82f6)' : 'rgba(255,255,255,0.08)'}; color: white; display: flex; align-items: center; justify-content: center; font-size: 0.6rem; font-weight: 700; border: 1px solid rgba(255,255,255,0.1);">${initials || 'US'}</div>`;

      const roleBadge = isAdmin
        ? `<span style="padding: 2px 6px; border-radius: 4px; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.3); color: #c084fc; font-weight: 600; font-size: 0.65rem;">Admin</span>`
        : `<span style="padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--text-muted); font-size: 0.65rem;">Utente</span>`;

      // Action Button details
      let actionBtnHtml = '';
      if (isOwner) {
        actionBtnHtml = `<span style="color: var(--text-muted); font-size: 0.65rem; display: inline-flex; align-items: center; gap: 4px; font-style: italic;">🔒 Proprietario Protetto</span>`;
      } else if (isSelf) {
        actionBtnHtml = `<span style="color: var(--text-muted); font-size: 0.65rem; display: inline-flex; align-items: center; gap: 4px; font-style: italic;">👤 Tu (Protetto)</span>`;
      } else if (isAdmin) {
        actionBtnHtml = `<button class="btn btn-danger ppa-delete-tag-btn change-user-role-btn" data-email="${user.email}" data-target-role="normal" style="font-size: 0.65rem; padding: 4px 8px; width: auto; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171;">Rimuovi Admin</button>`;
      } else {
        actionBtnHtml = `<button class="btn btn-primary change-user-role-btn" data-email="${user.email}" data-target-role="admin" style="font-size: 0.65rem; padding: 4px 8px; width: auto; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); color: #60a5fa;">Promuovi ad Admin</button>`;
      }

      return `
        <tr style="border-bottom: 1px solid var(--panel-border); height: 45px;">
          <td style="padding: 6px 16px; text-align: center;">${avatarHtml}</td>
          <td style="padding: 6px 16px; font-weight: 600; color: var(--text-main);">${user.name}</td>
          <td style="padding: 6px 16px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.7rem;">${user.email}</td>
          <td style="padding: 6px 16px;">${roleBadge}</td>
          <td style="padding: 6px 16px; text-align: right;">${actionBtnHtml}</td>
        </tr>
      `;
    }).join("");

    // Bind action buttons
    tbody.querySelectorAll(".change-user-role-btn").forEach(btn => {
      btn.onclick = async () => {
        const email = btn.dataset.email;
        const targetRole = btn.dataset.targetRole;
        const actionLabel = targetRole === 'admin' ? 'promuovere ad Admin' : 'rimuovere da Admin';
        
        if (confirm(`Sei sicuro di voler ${actionLabel} l'utente "${email}"?`)) {
          try {
            const updateUrl = `${apiUrl}/api/users/role`;
            const res = await fetch(updateUrl, {
              method: 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({ email, role: targetRole })
            });
            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || `HTTP error ${res.status}`);
            }
            showToastNotification(`Ruolo aggiornato con successo per ${email}`);
            await loadUsersTable();
          } catch (e) {
            console.error(e);
            alert(`Errore cambio ruolo: ${e.message}`);
          }
        }
      };
    });

  } catch (error) {
    console.error("[Settings Users] Failed to load users list:", error);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--accent-red); font-style: italic; padding: 20px;">Impossibile recuperare l'elenco utenti dal server.</td></tr>`;
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}
