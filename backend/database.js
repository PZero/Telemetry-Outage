import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('[PG] Connected to PostgreSQL (Supabase)'));
pool.on('error', (err) => console.error('[PG] Pool error:', err.message));

// Helper wrappers
const dbRun = async (query, params = []) => {
  const client = await pool.connect();
  try {
    const res = await client.query(query, params);
    return res;
  } finally {
    client.release();
  }
};

const dbAll = async (query, params = []) => {
  const res = await pool.query(query, params);
  return res.rows;
};

const dbGet = async (query, params = []) => {
  const res = await pool.query(query, params);
  return res.rows[0] || null;
};

// Default seed data
const regions = [
  "Sicilia", "Sardegna", "Puglia", "Campania", "Calabria",
  "Basilicata", "Abruzzo", "Toscana", "Lazio", "Emilia-Romagna"
];

const windNames = [
  "Eolico Erice", "Vento Mazara", "Pala Castelvetrano", "Turbina Troina", "Parco Alcamo",
  "Altopiano Budduso", "Vento Tempio", "Galtelli Ridge", "Campeda Wind", "Sassari Eolico",
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
  "Imola PV Grid", "Forli Solare", "Ferrara Sunfield", "Modena Solar", "Parma PV"
];

const defaultPpaTags = [
  { name: 'Enel', color: '#10b981' },
  { name: 'Engie', color: '#3b82f6' },
  { name: 'Edison', color: '#8b5cf6' },
  { name: 'A2A', color: '#f59e0b' }
];

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
        "startDate" TEXT,
        "endDate" TEXT,
        "reductionPercentage" DOUBLE PRECISION,
        "residualCapacity" DOUBLE PRECISION,
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
        capacity DOUBLE PRECISION,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
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
    const ppaRow = await dbGet('SELECT COUNT(*) as count FROM ppa_tags');
    if (parseInt(ppaRow.count) === 0) {
      console.log('[PG] Seeding default PPA Tags...');
      for (const tag of defaultPpaTags) {
        await dbRun(
          'INSERT INTO ppa_tags (name, color) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
          [tag.name, tag.color]
        );
      }
    }

    // Seed Super Admin if not exists
    await dbRun(`
      INSERT INTO users (email, name, role, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email) DO NOTHING
    `, ['fnicora@gmail.com', 'Fabio Nicora', 'admin']);

    // Correct name if wrong
    await dbRun(`
      UPDATE users SET name = 'Fabio Nicora' WHERE email = 'fnicora@gmail.com' AND name = 'Francesco Nicora'
    `);

    // Seed Registry if empty
    const regRow = await dbGet('SELECT COUNT(*) as count FROM registry');
    if (parseInt(regRow.count) === 0) {
      console.log('[PG] Seeding default 100 UPs (50 Wind, 50 Solar)...');
      await seedDefaultRegistry();
    }

    console.log('[PG] Database initialization completed.');
  } catch (err) {
    console.error('[PG] Error initializing database tables:', err.message);
  }
}

async function seedDefaultRegistry() {
  for (let i = 1; i <= 50; i++) {
    const regionIndex = (i - 1) % regions.length;
    const capacity = 15 + ((i * 7) % 61);
    await dbRun(`
      INSERT INTO registry (id, name, tech, region, capacity, lat, lon)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
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
  for (let i = 1; i <= 50; i++) {
    const regionIndex = (i - 1) % regions.length;
    const capacity = 5 + ((i * 11) % 31);
    await dbRun(`
      INSERT INTO registry (id, name, tech, region, capacity, lat, lon)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
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

// Initialize on startup
initializeTables();

// ==================================================
// DATABASE SERVICE METHODS EXPORTS
// ==================================================

export const dbService = {
  async getObservations(upId, date, type) {
    const row = await dbGet(
      'SELECT values_json FROM observations WHERE up_id = $1 AND date = $2 AND type = $3',
      [upId, date, type]
    );
    return row ? JSON.parse(row.values_json) : null;
  },

  async saveObservations(upId, date, type, values) {
    const key = `${upId}|${date}|${type}`;
    const valuesJson = JSON.stringify(values);
    const now = new Date().toISOString();
    await dbRun(`
      INSERT INTO observations (key, up_id, date, type, values_json, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (key) DO UPDATE SET values_json = EXCLUDED.values_json, updated_at = EXCLUDED.updated_at
    `, [key, upId, date, type, valuesJson, now]);
    return true;
  },

  async clearDatabase() {
    await dbRun('DELETE FROM observations');
    await dbRun('DELETE FROM outages');
    return true;
  },

  async deleteOlderThan(limitDate) {
    const obs = await dbRun('DELETE FROM observations WHERE date < $1', [limitDate]);
    const out = await dbRun('DELETE FROM outages WHERE SUBSTRING("endDate", 1, 10) < $1', [limitDate]);
    return { observations: obs.rowCount, outages: out.rowCount };
  },

  async getObservationsBulk(startDate, endDate) {
    return await dbAll(
      'SELECT up_id, date, type, values_json FROM observations WHERE date >= $1 AND date <= $2',
      [startDate, endDate]
    );
  },

  async getOutagesBulk() {
    return await dbAll('SELECT * FROM outages');
  },

  async getOutages(upId) {
    return await dbAll('SELECT * FROM outages WHERE up_id = $1', [upId]);
  },

  async saveOutages(outagesList) {
    for (const out of outagesList) {
      await dbRun(`
        INSERT INTO outages (outage_id, up_id, "startDate", "endDate", "reductionPercentage", "residualCapacity", notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (outage_id) DO UPDATE SET
          "startDate" = EXCLUDED."startDate",
          "endDate" = EXCLUDED."endDate",
          "reductionPercentage" = EXCLUDED."reductionPercentage",
          "residualCapacity" = EXCLUDED."residualCapacity",
          notes = EXCLUDED.notes
      `, [
        out.outage_id, out.up_id, out.startDate, out.endDate,
        out.reductionPercentage, out.residualCapacity, out.notes
      ]);
    }
    return true;
  },

  async getRegistry() {
    return await dbAll('SELECT * FROM registry');
  },

  async saveRegistry(upList) {
    await dbRun('DELETE FROM registry');
    for (const up of upList) {
      const ppa = up.ppa_partner || up.ppaTag || null;
      const scada = (up.scada_disabled === true || up.scada_disabled === 1) ? 1 : 0;
      await dbRun(`
        INSERT INTO registry (id, name, tech, region, capacity, lat, lon, ppa_partner, scada_disabled)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    if (ppaPartner !== undefined && scadaDisabled !== undefined) {
      await dbRun('UPDATE registry SET ppa_partner = $1, scada_disabled = $2 WHERE id = $3',
        [ppaPartner, scadaDisabled ? 1 : 0, upId]);
    } else if (ppaPartner !== undefined) {
      await dbRun('UPDATE registry SET ppa_partner = $1 WHERE id = $2', [ppaPartner, upId]);
    } else if (scadaDisabled !== undefined) {
      await dbRun('UPDATE registry SET scada_disabled = $1 WHERE id = $2', [scadaDisabled ? 1 : 0, upId]);
    }
    return true;
  },

  async getPpaTags() {
    return await dbAll('SELECT * FROM ppa_tags');
  },

  async savePpaTag(name, color) {
    await dbRun(`
      INSERT INTO ppa_tags (name, color) VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
    `, [name, color]);
    return true;
  },

  async deletePpaTag(name) {
    await dbRun('DELETE FROM ppa_tags WHERE name = $1', [name]);
    await dbRun('UPDATE registry SET ppa_partner = NULL WHERE ppa_partner = $1', [name]);
    return true;
  },

  async getUserByEmail(email) {
    return await dbGet('SELECT * FROM users WHERE email = $1', [email]);
  },

  async saveUser(email, name, role) {
    await dbRun(`
      INSERT INTO users (email, name, role, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
    `, [email, name, role]);
    return true;
  },

  async getAllUsers() {
    return await dbAll('SELECT * FROM users ORDER BY role ASC, name ASC');
  },

  async updateUserRole(email, role) {
    if (email === 'fnicora@gmail.com') {
      throw new Error('Non e consentito modificare il ruolo dell utente proprietario.');
    }
    await dbRun('UPDATE users SET role = $1 WHERE email = $2', [role, email]);
    return true;
  },

  async getStats() {
    const obsRow = await dbGet('SELECT COUNT(*) as count FROM observations');
    const outRow = await dbGet('SELECT COUNT(*) as count FROM outages');
    const regRow = await dbGet('SELECT COUNT(*) as count FROM registry');
    return {
      observations: parseInt(obsRow.count),
      outages: parseInt(outRow.count),
      registry: parseInt(regRow.count)
    };
  }
};
