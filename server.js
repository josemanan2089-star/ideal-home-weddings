// ============================================
// MXL GOLD v7.5 AGGRESSIVE CONVERSION ENGINE
// MAXIMIZA CLICS → MAXIMIZA COMISIONES AMAZON
// ============================================

const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

// Confiar en el proxy de Railway
app.set('trust proxy', 1);

// Healthchecks
app.get(['/health', '/api/health'], (req, res) => res.status(200).send('OK'));

// Middlewares
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// Base de Datos
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 25
});

// Inicialización de Tablas
async function initDB() {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS articulos (
            id BIGSERIAL PRIMARY KEY,
            asin VARCHAR(20),
            titulo TEXT,
            meta TEXT,
            curiosidad TEXT,
            imagen TEXT,
            categoria VARCHAR(100),
            link TEXT,
            clics INT DEFAULT 0,
            impresiones INT DEFAULT 0,
            ctr DECIMAL(5,4) DEFAULT 0,
            seccion VARCHAR(60) DEFAULT 'buying_now',
            status VARCHAR(20) DEFAULT 'active',
            is_featured BOOLEAN DEFAULT FALSE,
            precio DECIMAL(10,2) DEFAULT 49.99,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('✅ DB Lista y Blindada');
    } catch (err) { console.error('❌ DB Error:', err.message); }
}

// ============================================================
// RUTAS COMANDER MXL (EL PODER TOTAL)
// ============================================================

// 1. INYECTAR NUEVO (Corregido con Precio)
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal, precio } = req.body;
    try {
        const id = Date.now();
        await db.query(`
            INSERT INTO articulos (id, titulo, imagen, categoria, link, precio, status) 
            VALUES ($1, $2, $3, $4, $5, $6, 'active')
        `, [id, tituloReal, imagenUrl, categoria, url, precio || 49.99]);
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 2. EDITAR EXISTENTE (NUEVO)
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
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 3. BORRAR PRODUCTO (NUEVO)
app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 4. OBTENER TODO
app.get('/api/productos', async (req, res) => {
    try {
        const result = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC`);
        res.json({ items: result.rows });
    } catch (e) { res.json({ items: [] }); }
});

// 5. STATS
app.get('/api/stats', async (req, res) => {
    try {
        const count = await db.query('SELECT COUNT(*) FROM articulos');
        const clics = await db.query('SELECT SUM(clics) FROM articulos');
        res.json({ 
            productos: count.rows[0].count, 
            clicsHoy: clics.rows[0].sum || 0,
            affiliateTag: AFFILIATE_TAG 
        });
    } catch (e) { res.json({ productos: 0, clicsHoy: 0 }); }
});

// Redirección con Tag de Afiliado
app.get('/go/:id', async (req, res) => {
    const productId = req.params.id;
    try {
        const product = await db.query(`SELECT link FROM articulos WHERE id = $1`, [productId]);
        if (!product.rows.length) return res.redirect('/');
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [productId]);
        let finalUrl = product.rows[0].link;
        if (!finalUrl.includes('tag=')) {
            finalUrl += (finalUrl.includes('?') ? '&' : '?') + `tag=${AFFILIATE_TAG}`;
        }
        res.redirect(302, finalUrl);
    } catch (e) { res.redirect('/'); }
});

// Estáticos y SPA
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MXL GOLD v7.5 | Port ${PORT}`));
}
start();
