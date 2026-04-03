// scripts/migrate.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 MXL GOLD - Running migrations...');

    // Tabla articulos (productos)
    await client.query(`
      CREATE TABLE IF NOT EXISTS articulos (
        id BIGSERIAL PRIMARY KEY,
        asin VARCHAR(20),
        titulo TEXT,
        meta TEXT,
        curiosidad TEXT,
        imagen TEXT,
        categoria VARCHAR(100),
        link TEXT,
        keyword TEXT,
        clics INT DEFAULT 0,
        impresiones INT DEFAULT 0,
        ctr DECIMAL(5,4) DEFAULT 0,
        seccion VARCHAR(60) DEFAULT 'buying_now',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fake_stock INT DEFAULT 15,
        last_fomo_update TIMESTAMP DEFAULT NOW(),
        conversion_rate DECIMAL(5,4) DEFAULT 0,
        is_featured BOOLEAN DEFAULT FALSE,
        quality_score DECIMAL(5,2) DEFAULT 0,
        winning_variant INT DEFAULT 0,
        precio DECIMAL(10,2) DEFAULT 49.99,
        status VARCHAR(20) DEFAULT 'active'
      );
    `);

    // Tabla clics
    await client.query(`
      CREATE TABLE IF NOT EXISTS clics (
        id BIGSERIAL PRIMARY KEY,
        producto_id BIGINT,
        tipo VARCHAR(20) DEFAULT 'product',
        session_id VARCHAR(100),
        user_agent TEXT,
        city VARCHAR(50),
        variant_id INT DEFAULT 0,
        subtag VARCHAR(50),
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla impresiones
    await client.query(`
      CREATE TABLE IF NOT EXISTS impresiones (
        id BIGSERIAL PRIMARY KEY,
        producto_id BIGINT,
        session_id VARCHAR(100),
        variant_id INT DEFAULT 0,
        position INT DEFAULT 0,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla audit_log
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        accion VARCHAR(60) NOT NULL,
        producto_id BIGINT,
        titulo TEXT,
        affiliate_tag VARCHAR(60),
        detalle TEXT,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla learning_insights
    await client.query(`
      CREATE TABLE IF NOT EXISTS learning_insights (
        id SERIAL PRIMARY KEY,
        insight_type VARCHAR(50),
        data JSONB,
        effectiveness DECIMAL(5,4),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Índices para mejorar performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_articulos_ctr ON articulos(ctr DESC)',
      'CREATE INDEX IF NOT EXISTS idx_articulos_featured ON articulos(is_featured)',
      'CREATE INDEX IF NOT EXISTS idx_articulos_status ON articulos(status)',
      'CREATE INDEX IF NOT EXISTS idx_clicks_producto ON clics(producto_id)',
      'CREATE INDEX IF NOT EXISTS idx_impresiones_producto ON impresiones(producto_id)',
      'CREATE INDEX IF NOT EXISTS idx_clicks_fecha ON clics(fecha DESC)',
      'CREATE INDEX IF NOT EXISTS idx_articulos_categoria ON articulos(categoria)'
    ];

    for (const sql of indexes) {
      try { await client.query(sql); } catch (e) { console.log('Index warning:', e.message); }
    }

    console.log('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
