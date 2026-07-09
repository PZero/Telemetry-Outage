import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data.sqlite');

// Default data registry structures to seed if database is empty
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

const defaultPpaTags = [
  { name: 'Enel', color: '#10b981' },
  { name: 'Engie', color: '#3b82f6' },
  { name: 'Edison', color: '#8b5cf6' },
  { name: 'A2A', color: '#f59e0b' }
];

// Open connection to SQLite database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[SQLite] Error opening database:', err.message);
  } else {
    console.log('[SQLite] Connected to SQLite database at:', DB_PATH);
    initializeTables();
  }
});

// Helper wrapper for DB queries using promises
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
  db.run(query, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const dbAll = (query, params = []) => new Promise((resolve, reject) => {
  db.all(query, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
  db.get(query, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

/**
 * Initialize all database tables and seed defaults if empty.
 */
async function initializeTables() {
  try {
    // 1. Observations Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS observations (
        key TEXT PRIMARY KEY,
        up_id TEXT,
        date TEXT,
        type TEXT,
        values_json TEXT,
        updated_at TEXT
      )
    `);

    // 2. Outages Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS outages (
        outage_id TEXT PRIMARY KEY,
        up_id TEXT,
        startDate TEXT,
        endDate TEXT,
        reductionPercentage REAL,
        residualCapacity REAL,
        notes TEXT
      )
    `);

    // 3. Registry Table (UP Fleet)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS registry (
        id TEXT PRIMARY KEY,
        name TEXT,
        tech TEXT,
        region TEXT,
        capacity REAL,
        lat REAL,
        lon REAL,
        ppa_partner TEXT,
        scada_disabled INTEGER DEFAULT 0
      )
    `);

    // 4. PPA Tags Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS ppa_tags (
        name TEXT PRIMARY KEY,
        color TEXT
      )
    `);

    // 5. Users Table (RBAC)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        name TEXT,
        role TEXT,
        created_at TEXT
      )
    `);

    // Seed PPA Tags if empty
    const ppaCount = await dbGet('SELECT COUNT(*) as count FROM ppa_tags');
    if (ppaCount.count === 0) {
      console.log('[SQLite] Seeding default PPA Tags...');
      for (const tag of defaultPpaTags) {
        await dbRun('INSERT INTO ppa_tags (name, color) VALUES (?, ?)', [tag.name, tag.color]);
      }
    }

    // Seed Super Admin if not exists
    await dbRun(`
      INSERT OR IGNORE INTO users (email, name, role, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `, ['fnicora@gmail.com', 'Francesco Nicora', 'admin']);

    // Seed Registry if empty
    const regCount = await dbGet('SELECT COUNT(*) as count FROM registry');
    if (regCount.count === 0) {
      console.log('[SQLite] Seeding default 100 UPs (50 Wind, 50 Solar)...');
      await seedDefaultRegistry();
    }

    console.log('[SQLite] Database initialization completed.');
  } catch (err) {
    console.error('[SQLite] Error initializing database tables:', err.message);
  }
}

/**
 * Generates and seeds default 100 production units (50 Wind, 50 Solar)
 */
async function seedDefaultRegistry() {
  // Wind UPs
  for (let i = 1; i <= 50; i++) {
    const regionIndex = (i - 1) % regions.length;
    const capacity = 15 + ((i * 7) % 61);
    await dbRun(`
      INSERT INTO registry (id, name, tech, region, capacity, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      `UP_WIND_${String(i).padStart(2, '0')}`,
      windNames[i - 1] || `Parco Eolico Wind ${i}`,
      "Wind",
      regions[regionIndex],
      capacity,
      37.0 + ((i * 13) % 100) / 15,
      12.0 + ((i * 17) % 100) / 18
    ]);
  }

  // Solar UPs
  for (let i = 1; i <= 50; i++) {
    const regionIndex = (i - 1) % regions.length;
    const capacity = 5 + ((i * 11) % 31);
    await dbRun(`
      INSERT INTO registry (id, name, tech, region, capacity, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      `UP_SOLAR_${String(i).padStart(2, '0')}`,
      solarNames[i - 1] || `Parco Solare Solar ${i}`,
      "Solar",
      regions[regionIndex],
      capacity,
      36.5 + ((i * 19) % 100) / 15,
      12.5 + ((i * 23) % 100) / 18
    ]);
  }
}

// ==================================================
// DATABASE SERVICE METHODS EXPORTS
// ==================================================

export const dbService = {
  // Observations CRUD
  async getObservations(upId, date, type) {
    const row = await dbGet('SELECT values_json FROM observations WHERE up_id = ? AND date = ? AND type = ?', [upId, date, type]);
    return row ? JSON.parse(row.values_json) : null;
  },

  async saveObservations(upId, date, type, values) {
    const key = `${upId}|${date}|${type}`;
    const valuesJson = JSON.stringify(values);
    const now = new Date().toISOString();
    await dbRun(`
      INSERT INTO observations (key, up_id, date, type, values_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at
    `, [key, upId, date, type, valuesJson, now]);
    return true;
  },

  async clearDatabase() {
    await dbRun('DELETE FROM observations');
    await dbRun('DELETE FROM outages');
    return true;
  },

  async deleteOlderThan(limitDate) {
    const obs = await dbRun('DELETE FROM observations WHERE date < ?', [limitDate]);
    // Outages records with end date before limit date
    const out = await dbRun("DELETE FROM outages WHERE substr(endDate, 1, 10) < ?", [limitDate]);
    return { observations: obs.changes, outages: out.changes };
  },

  // Outages CRUD
  async getOutages(upId) {
    return await dbAll('SELECT * FROM outages WHERE up_id = ?', [upId]);
  },

  async saveOutages(outagesList) {
    for (const out of outagesList) {
      await dbRun(`
        INSERT INTO outages (outage_id, up_id, startDate, endDate, reductionPercentage, residualCapacity, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outage_id) DO UPDATE SET 
          startDate = excluded.startDate,
          endDate = excluded.endDate,
          reductionPercentage = excluded.reductionPercentage,
          residualCapacity = excluded.residualCapacity,
          notes = excluded.notes
      `, [
        out.outage_id,
        out.up_id,
        out.startDate,
        out.endDate,
        out.reductionPercentage,
        out.residualCapacity,
        out.notes
      ]);
    }
    return true;
  },

  // Registry CRUD
  async getRegistry() {
    return await dbAll('SELECT * FROM registry');
  },

  async saveRegistry(upList) {
    // Drop all registry rows
    await dbRun('DELETE FROM registry');
    for (const up of upList) {
      const ppa = up.ppa_partner || up.ppaTag || null;
      const scada = (up.scada_disabled === true || up.scada_disabled === 1) ? 1 : 0;
      await dbRun(`
        INSERT INTO registry (id, name, tech, region, capacity, lat, lon, ppa_partner, scada_disabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [up.id, up.name, up.tech, up.region, up.capacity, up.lat, up.lon, ppa, scada]);
    }
    return true;
  },

  async resetRegistry() {
    await dbRun('DELETE FROM registry');
    await seedDefaultRegistry();
    return true;
  },

  async updateUPPpaAndScada(upId, ppaPartner, scadaDisabled) {
    // Dynamic updates depending on parameters passed (we support updating PPA, SCADA, or both)
    if (ppaPartner !== undefined && scadaDisabled !== undefined) {
      await dbRun('UPDATE registry SET ppa_partner = ?, scada_disabled = ? WHERE id = ?', [ppaPartner, scadaDisabled ? 1 : 0, upId]);
    } else if (ppaPartner !== undefined) {
      await dbRun('UPDATE registry SET ppa_partner = ? WHERE id = ?', [ppaPartner, upId]);
    } else if (scadaDisabled !== undefined) {
      await dbRun('UPDATE registry SET scada_disabled = ? WHERE id = ?', [scadaDisabled ? 1 : 0, upId]);
    }
    return true;
  },

  // PPA Tags CRUD
  async getPpaTags() {
    return await dbAll('SELECT * FROM ppa_tags');
  },

  async savePpaTag(name, color) {
    await dbRun(`
      INSERT INTO ppa_tags (name, color)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET color = excluded.color
    `, [name, color]);
    return true;
  },

  async deletePpaTag(name) {
    await dbRun('DELETE FROM ppa_tags WHERE name = ?', [name]);
    // Also remove reference from UPs
    await dbRun('UPDATE registry SET ppa_partner = NULL WHERE ppa_partner = ?', [name]);
    return true;
  },

  // Users & Roles CRUD
  async getUserByEmail(email) {
    return await dbGet('SELECT * FROM users WHERE email = ?', [email]);
  },

  async saveUser(email, name, role) {
    await dbRun(`
      INSERT INTO users (email, name, role, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(email) DO UPDATE SET 
        name = excluded.name,
        role = excluded.role
    `, [email, name, role]);
    return true;
  },

  async getAllUsers() {
    return await dbAll('SELECT * FROM users ORDER BY role ASC, name ASC');
  },

  async updateUserRole(email, role) {
    if (email === 'fnicora@gmail.com') {
      throw new Error('Non è consentito modificare il ruolo dell\'utente proprietario.');
    }
    await dbRun('UPDATE users SET role = ? WHERE email = ?', [role, email]);
    return true;
  },

  async getStats() {
    const obsCount = await dbGet('SELECT COUNT(*) as count FROM observations');
    const outCount = await dbGet('SELECT COUNT(*) as count FROM outages');
    return {
      observations: obsCount.count,
      outages: outCount.count
    };
  }
};
