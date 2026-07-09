// Deterministic Registry of 100 Production Units (UPs)
// 50 Wind Units, 50 Solar Units, distributed across Italian regions.

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

export function loadUPRegistry() {
  const custom = localStorage.getItem("custom_up_registry");
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.length > 0) {
        UP_REGISTRY.length = 0;
        UP_REGISTRY.push(...parsed);
        updateUniqueRegions();
        console.log(`[Registry] Loaded ${parsed.length} custom UPs from localStorage.`);
        return;
      }
    } catch (err) {
      console.error("[Registry] Failed to parse custom UP registry:", err);
    }
  }

  // Fallback to default deterministic mock UPs
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
      lon: 12.0 + ((i * 17) % 100) / 18
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
      lon: 12.5 + ((i * 23) % 100) / 18
    });
  }

  updateUniqueRegions();
}

function updateUniqueRegions() {
  const regionsSet = [...new Set(UP_REGISTRY.map(up => up.region))].sort();
  UNIQUE_REGIONS.length = 0;
  UNIQUE_REGIONS.push(...regionsSet);
}

// Initial load
loadUPRegistry();

// Helper to get UP details by ID or Name
export function getUPById(id) {
  if (!id) return null;
  return UP_REGISTRY.find(up => up.id === id) || UP_REGISTRY.find(up => up.name === id);
}

export function isScadaDisabled(upId) {
  try {
    const list = JSON.parse(localStorage.getItem("disabled_scada_ups") || "[]");
    return list.includes(upId);
  } catch (e) {
    return false;
  }
}

export function setScadaDisabled(upId, disabled) {
  try {
    let list = JSON.parse(localStorage.getItem("disabled_scada_ups") || "[]");
    if (disabled) {
      if (!list.includes(upId)) list.push(upId);
    } else {
      list = list.filter(id => id !== upId);
    }
    localStorage.setItem("disabled_scada_ups", JSON.stringify(list));
  } catch (e) {
    console.error(e);
  }
}
