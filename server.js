// ============================================================
// MXL GOLD v11.0 — ELITE CONVERSION & LEAD ENGINE
// OPTIMIZADO PARA DINERO REAL Y CAPTURA DE CLIENTES VIP
// ============================================================

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 30,
    idleTimeoutMillis: 10000
});

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

// ============================================================
// 📊 ESTRUCTURA DE DATOS v11.0 (CON TABLA DE LEADS)
// ============================================================
async function initDB() {
    try {
        // Tabla de Productos
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGSERIAL PRIMARY KEY,
                asin VARCHAR(20),
                titulo TEXT NOT NULL,
                imagen TEXT,
                categoria VARCHAR(100),
                link TEXT NOT NULL,
                precio DECIMAL(10,2) DEFAULT 49.99,
                clics INT DEFAULT 0,
                impresiones INT DEFAULT 0,
                ctr DECIMAL(12,8) DEFAULT 0,
                status VARCHAR(20) DEFAULT 'active',
                is_featured BOOLEAN DEFAULT FALSE,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // NUEVA TABLA: Captura de Emails VIP
        await db.query(`
            CREATE TABLE IF NOT EXISTS leads_vip (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                origen VARCHAR(100) DEFAULT 'Popup VIP',
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Parcheo de columnas por seguridad
        await db.query(`ALTER TABLE articulos ADD COLUMN IF NOT EXISTS impresiones INT DEFAULT 0`);
        await db.query(`ALTER TABLE articulos ADD COLUMN IF NOT EXISTS ctr DECIMAL(12,8) DEFAULT 0`);
        
        console.log('✅ ENGINE v11.0: BASE DE DATOS Y TABLA DE LEADS LISTAS');
    } catch (err) {
        console.error('❌ FATAL ERROR DB:', err.message);
    }
}

// ============================================================
// 📧 ENDPOINT: CAPTURA DE CORREOS VIP
// ============================================================
app.post('/api/subscribe', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ success: false });

    try {
        await db.query(`INSERT INTO leads_vip (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email.toLowerCase()]);
        res.json({ success: true, message: "Welcome to the VIP club!" });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// ============================================================
// 💰 REDIRECCIÓN CON SUBTAGS
// ============================================================
app.get('/go/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(`
            UPDATE articulos SET clics = clics + 1,
                ctr = CASE WHEN impresiones > 0 THEN (clics + 1)::decimal / NULLIF(impresiones, 0) ELSE 0 END
            WHERE id = $1 RETURNING link, titulo
        `, [id]);

        if (result.rows.length > 0) {
            const prodRef = result.rows[0].titulo.substring(0, 10).replace(/[^a-z0-9]/gi, '_');
            const separator = result.rows[0].link.includes('?') ? '&' : '?';
            const finalUrl = `${result.rows[0].link}${separator}tag=${AFFILIATE_TAG}&ascsubtag=mxl_${id}_${prodRef}`;
            res.redirect(302, finalUrl);
        } else { res.redirect('/'); }
    } catch (e) { res.redirect('/'); }
});

// ============================================================
// 👀 TRACKING IMPRESIONES
// ============================================================
app.post('/api/track/impression', async (req, res) => {
    const { id } = req.body;
    try {
        await db.query(`
            UPDATE articulos SET impresiones = impresiones + 1,
                ctr = CASE WHEN (impresiones + 1) > 0 THEN clics::decimal / (impresiones + 1) ELSE 0 END
            WHERE id = $1
        `, [id]);
        res.json({ success: true });
    } catch (e) { res.status(500).send(); }
});

// ============================================================
// 🏆 API PRODUCTOS Y STATS
// ============================================================
app.get('/api/productos', async (req, res) => {
    const result = await db.query(`SELECT * FROM articulos WHERE status = 'active' ORDER BY is_featured DESC, ctr DESC, clics DESC LIMIT 100`);
    res.json({ items: result.rows });
});

app.get('/api/stats', async (req, res) => {
    try {
        const s = await db.query(`SELECT COUNT(*) as total, SUM(clics) as clics_total FROM articulos`);
        const l = await db.query(`SELECT COUNT(*) as leads FROM leads_vip`);
        res.json({ 
            productos: s.rows[0].total, 
            clicsHoy: s.rows[0].clics_total || 0,
            leadsVIP: l.rows[0].leads || 0, // <--- NUEVO: Ver cuántos correos tienes
            affiliateTag: AFFILIATE_TAG 
        });
    } catch (e) { res.json({ productos: 0, clicsHoy: 0, leadsVIP: 0 }); }
});

// ============================================================
// 💉 CRUD PANEL
// ============================================================
app.post('/api/commander/inject', async (req, res) => {
    const { tituloReal, imagenUrl, categoria, url, precio } = req.body;
    await db.query(`INSERT INTO articulos (id, titulo, imagen, categoria, link, precio) VALUES ($1,$2,$3,$4,$5,$6)`, [Date.now(), tituloReal, imagenUrl, categoria, url, precio]);
    res.json({ success: true });
});

app.delete('/api/productos/:id', async (req, res) => {
    await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MXL GOLD v11.0 ACTIVE ON PORT ${PORT}`));
}
start();
