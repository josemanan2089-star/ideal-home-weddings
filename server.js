// ============================================
// MXL GOLD v7.1 AGGRESSIVE CONVERSION ENGINE
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
const NodeCache = require('node-cache');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

// REPARACIÓN CRÍTICA: Confiar en el proxy de Railway para evitar errores de IP
app.set('trust proxy', 1);

// ============================================================
// HEALTHCHECK INMEDIATO (Para que Railway no apague la app)
// ============================================================
app.get(['/health', '/api/health'], (req, res) => {
    res.status(200).send('OK');
});

// ============================================================
// MIDDLEWARES
// ============================================================
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

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'Too many requests', ok: false },
    skip: (req) => ['/api/track/click', '/api/track/impression', '/go/'].some(p => req.path.startsWith(p))
});
app.use('/api/', limiter);

// ============================================================
// DATABASE
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 25,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

// ============================================================
// REPARACIÓN DE TABLAS (initDB)
// ============================================================
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

        // Columnas de seguridad por si ya existía la tabla
        const cols = [
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS fake_stock INT DEFAULT 15`,
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS conversion_rate DECIMAL(5,4) DEFAULT 0`,
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS quality_score DECIMAL(5,2) DEFAULT 0`
        ];
        for (const sql of cols) { try { await db.query(sql); } catch (e) {} }

        await db.query(`CREATE TABLE IF NOT EXISTS clics (id BIGSERIAL PRIMARY KEY, producto_id BIGINT, fecha TIMESTAMP DEFAULT NOW())`);
        await db.query(`CREATE TABLE IF NOT EXISTS impresiones (id BIGSERIAL PRIMARY KEY, producto_id BIGINT, fecha TIMESTAMP DEFAULT NOW())`);
        await db.query(`CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, accion VARCHAR(60), titulo TEXT, fecha TIMESTAMP DEFAULT NOW())`);

        console.log('✅ DB Lista y Reparada');
    } catch (err) {
        console.error('❌ Error inicializando DB (pero el servidor sigue vivo):', err.message);
    }
}

// ============================================================
// LÓGICA DE IA (GEMINI)
// ============================================================
const geminiKeys = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean);
let geminiIndex = 0;

async function generateContent(prompt) {
    if (!geminiKeys.length) return null;
    const key = geminiKeys[geminiIndex % geminiKeys.length];
    try {
        const genAI = new GoogleGenerativeAI(key.trim());
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent(prompt);
        geminiIndex++;
        return result.response.text();
    } catch (e) { return null; }
}

// ============================================================
// ENDPOINTS CLAVE
// ============================================================

// Redirección /go/
app.get('/go/:id', async (req, res) => {
    const productId = req.params.id;
    try {
        const product = await db.query(`SELECT link, titulo FROM articulos WHERE id = $1`, [productId]);
        if (!product.rows.length) return res.redirect('/');
        
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [productId]);
        
        let finalUrl = product.rows[0].link;
        if (!finalUrl.includes('tag=')) {
            const separator = finalUrl.includes('?') ? '&' : '?';
            finalUrl += `${separator}tag=${AFFILIATE_TAG}`;
        }
        res.redirect(302, finalUrl);
    } catch (e) { res.redirect('/'); }
});

// Inyectar producto
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    try {
        const id = Date.now();
        await db.query(`
            INSERT INTO articulos (id, titulo, imagen, categoria, link, status) 
            VALUES ($1, $2, $3, $4, $5, 'active')
        `, [id, tituloReal, imagenUrl, categoria, url]);
        res.json({ success: true, product: tituloReal, id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Obtener productos
app.get('/api/productos', async (req, res) => {
    try {
        const result = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 50`);
        res.json({ items: result.rows });
    } catch (e) { res.json({ items: [] }); }
});

// Stats para el panel
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

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
app.use(express.static(__dirname));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 MXL GOLD v7.1 en Puerto ${PORT}`);
    });
}

start();
