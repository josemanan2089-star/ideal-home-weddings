// ============================================
// MXL GOLD v10.0 — ELITE CONVERSION ENGINE
// INGENIERÍA DE ALTO RENDIMIENTO PARA AMAZON USA
// ============================================

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

// Configuración de Base de Datos con Pool Optimizado
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 30,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000
});

// Middlewares de Guerra (Performance & Security)
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

// ============================================================
// 📊 ESQUEMA DE DATOS DINÁMICO (SOPORTE CTR)
// ============================================================
async function initDB() {
    try {
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
            CREATE INDEX IF NOT EXISTS idx_articulos_performance ON articulos (is_featured DESC, ctr DESC, clics DESC);
            CREATE INDEX IF NOT EXISTS idx_articulos_status ON articulos (status);
        `);
        console.log('✅ MOTOR MXL GOLD v10.0: BASE DE DATOS OPTIMIZADA');
    } catch (err) {
        console.error('❌ FATAL ERROR DB:', err.message);
    }
}

// ============================================================
// 💰 REDIRECCIÓN INTELIGENTE (SUBTAGS DE DINERO REAL)
// ============================================================
app.get('/go/:id', async (req, res) => {
    const { id } = req.params;
    const sessionID = Math.random().toString(36).substring(2, 8);
    const ts = Date.now();

    try {
        // Registro de Clic + Recálculo Instantáneo de CTR (Evita desfases)
        const result = await db.query(`
            UPDATE articulos 
            SET clics = clics + 1,
                ctr = CASE 
                    WHEN impresiones > 0 THEN (clics + 1)::decimal / NULLIF(impresiones, 0)
                    ELSE 0 
                END
            WHERE id = $1 
            RETURNING link, titulo
        `, [id]);

        if (result.rows.length > 0) {
            let url = result.rows[0].link;
            const prodRef = result.rows[0].titulo.substring(0, 10).replace(/[^a-z0-9]/gi, '_');
            const separator = url.includes('?') ? '&' : '?';
            
            // Generación de Subtag Único para Amazon Reports (Tracking de conversión exacto)
            const subtag = `mxl_${prodRef}_${sessionID}_${ts}`;
            const finalUrl = `${url}${separator}tag=${AFFILIATE_TAG}&ascsubtag=${subtag}`;
            
            res.redirect(302, finalUrl);
        } else {
            res.status(404).redirect('/');
        }
    } catch (e) {
        res.status(500).redirect('/');
    }
});

// ============================================================
// 👀 TRACKING DE IMPRESIONES (DATA PARA CRECIMIENTO)
// ============================================================
app.post('/api/track/impression', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send();

    try {
        await db.query(`
            UPDATE articulos 
            SET impresiones = impresiones + 1,
                ctr = CASE 
                    WHEN (impresiones + 1) > 0 THEN clics::decimal / (impresiones + 1)
                    ELSE 0 
                END
            WHERE id = $1
        `, [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).send();
    }
});

// ============================================================
// 🏆 API PRODUCTOS (ORDEN DE CONVERSIÓN AGRESIVA)
// ============================================================
app.get('/api/productos', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT id, titulo, imagen, categoria, precio, clics, impresiones, ctr, is_featured
            FROM articulos 
            WHERE status = 'active' 
            ORDER BY 
                is_featured DESC, 
                ctr DESC,        -- Maximiza ingresos mostrando lo que más convierte
                clics DESC,      -- Social Proof
                fecha DESC       -- Freshness
            LIMIT 100
        `);
        res.json({ items: result.rows });
    } catch (e) {
        res.status(500).json({ items: [] });
    }
});

// ============================================================
// 💉 PANEL COMMANDER (CRUD SEGURO)
// ============================================================
app.post('/api/commander/inject', async (req, res) => {
    const { tituloReal, imagenUrl, categoria, url, precio } = req.body;
    try {
        const id = Date.now();
        await db.query(`
            INSERT INTO articulos (id, titulo, imagen, categoria, link, precio) 
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [id, tituloReal, imagenUrl, categoria, url, precio || 49.99]);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { tituloReal, precio, url, imagenUrl, categoria, is_featured } = req.body;
    try {
        await db.query(`
            UPDATE articulos 
            SET titulo = $1, precio = $2, link = $3, imagen = $4, categoria = $5, is_featured = $6
            WHERE id = $7
        `, [tituloReal, precio, url, imagenUrl, categoria, is_featured || false, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Stats para Panel de Control
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await db.query(`
            SELECT 
                COUNT(*) as total, 
                SUM(clics) as clics_total, 
                AVG(ctr) as ctr_avg 
            FROM articulos
        `);
        res.json({ 
            productos: stats.rows[0].total, 
            clicsHoy: stats.rows[0].clics_total || 0,
            ctrGlobal: (stats.rows[0].ctr_avg * 100).toFixed(2) + '%',
            affiliateTag: AFFILIATE_TAG 
        });
    } catch (e) { res.json({ productos: 0, clicsHoy: 0 }); }
});

// ============================================================
// 🚀 LANZAMIENTO
// ============================================================
app.use(express.static(__dirname));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`💎 MXL GOLD v10.0 | DINERO REAL | PORT: ${PORT}`);
    });
}

start();
