// ============================================
// MXL GOLD v9.9 — ULTIMATE CONVERSION ENGINE
// OPTIMIZADO PARA DINERO REAL Y TRACKING USA
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

// Configuración de Base de Datos
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000
});

// Middlewares de Alto Rendimiento
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);

// ============================================================
// 📊 INICIALIZACIÓN DE TABLAS (OPTIMIZADAS PARA CTR)
// ============================================================
async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGSERIAL PRIMARY KEY,
                asin VARCHAR(20),
                titulo TEXT,
                imagen TEXT,
                categoria VARCHAR(100),
                link TEXT,
                precio DECIMAL(10,2) DEFAULT 49.99,
                clics INT DEFAULT 0,
                impresiones INT DEFAULT 0,
                ctr DECIMAL(10,6) DEFAULT 0,
                status VARCHAR(20) DEFAULT 'active',
                is_featured BOOLEAN DEFAULT FALSE,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ DB MXL GOLD v9.9 Conectada y Lista');
    } catch (err) {
        console.error('❌ Error DB:', err.message);
    }
}

// ============================================================
// 💰 RUTA CRÍTICA /go/:id (REDIRECCIÓN + TRACKING DINERO)
// ============================================================
app.get('/go/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Registramos clic y recalculamos CTR al instante
        const result = await db.query(`
            UPDATE articulos 
            SET clics = clics + 1,
                ctr = CASE 
                    WHEN impresiones > 0 THEN (clics + 1)::decimal / impresiones 
                    ELSE 0 
                END
            WHERE id = $1 
            RETURNING link, titulo
        `, [id]);

        if (result.rows.length > 0) {
            let url = result.rows[0].link;
            const cleanTitle = result.rows[0].titulo.substring(0, 15).replace(/[^a-zA-Z0-9]/g, '_');
            const sep = url.includes('?') ? '&' : '?';
            
            // Subtag dinámico: Sabrás exactamente qué producto vendió en tu panel de Amazon
            const finalUrl = `${url}${sep}tag=${AFFILIATE_TAG}&ascsubtag=mxl_${id}_${cleanTitle}`;
            
            res.redirect(302, finalUrl);
        } else {
            res.redirect('/');
        }
    } catch (e) {
        res.redirect('/');
    }
});

// ============================================================
// 👀 TRACKING DE IMPRESIONES (PARA CALCULAR CTR)
// ============================================================
app.post('/api/track/impression', async (req, res) => {
    const { id } = req.body;
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
// 🏆 API PRODUCTOS (ORDENADOS POR LO QUE MÁS VENDE)
// ============================================================
app.get('/api/productos', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM articulos 
            WHERE status = 'active' 
            ORDER BY 
                is_featured DESC, 
                ctr DESC,        -- Primero lo que más clics genera
                clics DESC,      -- Luego lo más popular
                fecha DESC       -- Finalmente lo más nuevo
            LIMIT 60
        `);
        res.json({ items: result.rows });
    } catch (e) {
        res.json({ items: [] });
    }
});

// ============================================================
// 💉 COMMANDER MXL (INYECCIÓN, EDICIÓN Y BORRADO)
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
    const { tituloReal, precio, url, imagenUrl, categoria } = req.body;
    try {
        await db.query(`
            UPDATE articulos 
            SET titulo = $1, precio = $2, link = $3, imagen = $4, categoria = $5 
            WHERE id = $6
        `, [tituloReal, precio, url, imagenUrl, categoria, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// STATS PARA EL PANEL
app.get('/api/stats', async (req, res) => {
    try {
        const rProds = await db.query('SELECT COUNT(*) FROM articulos');
        const rClics = await db.query('SELECT SUM(clics) FROM articulos');
        res.json({ 
            productos: rProds.rows[0].count, 
            clicsHoy: rClics.rows[0].sum || 0,
            affiliateTag: AFFILIATE_TAG 
        });
    } catch (e) { res.json({ productos: 0, clicsHoy: 0 }); }
});

// ============================================================
// 🚀 SERVIDOR Y RUTAS ESTÁTICAS
// ============================================================
app.use(express.static(__dirname));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`💰 MXL GOLD v9.9 ACTIVO EN PUERTO ${PORT}`);
    });
}

start();
