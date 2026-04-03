// ============================================
// MXL GOLD v6.0 AGGRESSIVE CONVERSION ENGINE
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

// ============================================================
// CACHE
// ============================================================
const productCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const statsCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

// ============================================================
// MIDDLEWARES
// ============================================================
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
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
    connectionTimeoutMillis: 5000
});

let categoryCache = null;
let categoryCacheTime = 0;

async function initDB() {
    await db.query(`CREATE TABLE IF NOT EXISTS articulos (
        id BIGINT PRIMARY KEY, 
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
        precio DECIMAL(10,2) DEFAULT 49.99
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS clics (
        id BIGSERIAL PRIMARY KEY, 
        producto_id BIGINT,
        tipo VARCHAR(20) DEFAULT 'product',
        session_id VARCHAR(100),
        user_agent TEXT,
        city VARCHAR(50),
        variant_id INT DEFAULT 0,
        subtag VARCHAR(50),
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS impresiones (
        id BIGSERIAL PRIMARY KEY,
        producto_id BIGINT,
        session_id VARCHAR(100),
        variant_id INT DEFAULT 0,
        position INT DEFAULT 0,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, 
        accion VARCHAR(60) NOT NULL,
        producto_id BIGINT, 
        titulo TEXT, 
        affiliate_tag VARCHAR(60),
        detalle TEXT, 
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS learning_insights (
        id SERIAL PRIMARY KEY,
        insight_type VARCHAR(50),
        data JSONB,
        effectiveness DECIMAL(5,4),
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_ctr ON articulos(ctr DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_featured ON articulos(is_featured)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_clicks_producto ON clics(producto_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_impresiones_producto ON impresiones(producto_id)`);
    
    console.log('✅ DB lista');
}

// ============================================================
// HELPERS
// ============================================================
function generateSubtag(productId, variantId = 0) {
    return `mxl${productId}v${variantId}`;
}

function addAffiliateTag(url, productId = null, variantId = 0) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('tag', AFFILIATE_TAG);
        u.searchParams.set('linkCode', 'll1');
        u.searchParams.set('th', '1');
        if (productId) {
            const subtag = generateSubtag(productId, variantId);
            u.searchParams.set('subtag', subtag);
        }
        return u.toString();
    } catch { return url; }
}

async function audit(accion, producto_id, titulo, tag, detalle = '') {
    try {
        await db.query(
            `INSERT INTO audit_log (accion, producto_id, titulo, affiliate_tag, detalle) VALUES ($1,$2,$3,$4,$5)`,
            [accion, producto_id || null, titulo || null, tag || AFFILIATE_TAG, detalle]
        );
    } catch (e) {}
}

// ============================================================
// GEMINI
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(Boolean);

let geminiIndex = 0;
let lastCallTimestamps = [];

async function generateContent(prompt, maxRetries = 3) {
    if (!geminiKeys.length) throw new Error('No Gemini keys');
    
    const now = Date.now();
    lastCallTimestamps = lastCallTimestamps.filter(t => now - t < 1000);
    if (lastCallTimestamps.length >= 10) {
        await new Promise(r => setTimeout(r, 500));
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (let i = 0; i < geminiKeys.length; i++) {
            const keyIndex = (geminiIndex + i) % geminiKeys.length;
            try {
                const genAI = new GoogleGenerativeAI(geminiKeys[keyIndex].trim());
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const result = await model.generateContent(prompt);
                geminiIndex = (keyIndex + 1) % geminiKeys.length;
                lastCallTimestamps.push(Date.now());
                return result.response.text();
            } catch (e) {
                console.warn(`⚠️ Key ${keyIndex + 1} intento ${attempt}: ${e.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw new Error('All Gemini keys failed');
}

// ============================================================
// ENDPOINT PRINCIPAL: /go/:id (redirección con tracking)
// ============================================================
app.get('/go/:id', async (req, res) => {
    const productId = parseInt(req.params.id);
    const variantId = parseInt(req.query.variant) || 0;
    
    try {
        const product = await db.query(`SELECT id, link, titulo FROM articulos WHERE id = $1`, [productId]);
        if (product.rows.length === 0) {
            return res.status(404).send('Producto no encontrado');
        }
        
        const prod = product.rows[0];
        
        // Registrar clic
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [productId]);
        await db.query(
            `INSERT INTO clics (producto_id, tipo, session_id, user_agent, city, variant_id, subtag) 
             VALUES ($1, 'product', $2, $3, $4, $5, $6)`,
            [productId, req.session.id, req.headers['user-agent'] || '', req.session.city || 'NYC', variantId, generateSubtag(productId, variantId)]
        );
        
        // Actualizar CTR
        await db.query(`
            UPDATE articulos 
            SET ctr = CASE 
                WHEN impresiones > 0 THEN clics::DECIMAL / impresiones 
                ELSE 0 
            END
            WHERE id = $1
        `, [productId]);
        
        // Generar link con affiliate tag y subtag
        const finalUrl = addAffiliateTag(prod.link, productId, variantId);
        
        await audit('CLICK', productId, prod.titulo, AFFILIATE_TAG, `variant:${variantId}`);
        
        // Redirigir a Amazon
        res.redirect(302, finalUrl);
    } catch (e) {
        console.error('Redirect error:', e);
        res.status(500).send('Error');
    }
});

// ============================================================
// TRACKING DE IMPRESIONES
// ============================================================
app.post('/api/track/impression', async (req, res) => {
    const { producto_id, variant_id = 0, position = 0 } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    
    try {
        await db.query(
            `INSERT INTO impresiones (producto_id, session_id, variant_id, position) 
             VALUES ($1, $2, $3, $4)`,
            [producto_id, req.session.id, variant_id, position]
        );
        await db.query(`UPDATE articulos SET impresiones = impresiones + 1 WHERE id = $1`, [producto_id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false });
    }
});

// ============================================================
// PRODUCTOS GANADORES (ordenados por CTR)
// ============================================================
app.get('/api/products', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const seccion = req.query.seccion || null;
    
    try {
        let query = `
            SELECT id, titulo, imagen, categoria, clics, impresiones, ctr, is_featured, precio, curiosidad, meta
            FROM articulos 
            WHERE status = 'active' OR status IS NULL
        `;
        const params = [];
        
        if (seccion) {
            query += ` AND seccion = $1`;
            params.push(seccion);
        }
        
        query += ` ORDER BY is_featured DESC, ctr DESC, clics DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        
        const products = await db.query(query, params);
        
        // Procesar cada producto
        const processed = products.rows.map(p => {
            let metaData = {};
            try {
                metaData = JSON.parse(p.meta || '{}');
            } catch(e) {}
            
            // Determinar badge
            let badge = null;
            if (p.is_featured) badge = { text: '🔥 BEST SELLER', color: '#e6b800' };
            else if (p.ctr > 0.03) badge = { text: '📈 TRENDING', color: '#ff4500' };
            else if (p.ctr > 0.01) badge = { text: '⭐ POPULAR', color: '#8b5cf6' };
            
            return {
                id: p.id,
                title: p.titulo,
                image: p.imagen,
                category: p.categoria,
                price: parseFloat(p.precio) || 49.99,
                ctr: p.ctr || 0,
                clicks: p.clics || 0,
                badge: badge,
                teaser: metaData.text || p.curiosidad || `Premium ${p.categoria} product`,
                badgeText: metaData.badge || null
            };
        });
        
        res.json({ success: true, products: processed });
    } catch (e) {
        console.error('Products error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// FOMO PARA UN PRODUCTO
// ============================================================
app.get('/api/product/fomo/:id', async (req, res) => {
    try {
        const product = await db.query(`
            SELECT id, fake_stock, clics, impresiones, ctr
            FROM articulos WHERE id = $1
        `, [req.params.id]);
        
        if (product.rows.length === 0) return res.json({ stock: 15, viewers: 12 });
        
        const prod = product.rows[0];
        let stock = prod.fake_stock;
        
        // Reducir stock basado en CTR
        if (prod.ctr > 0.05 && stock > 3) {
            stock = Math.max(1, stock - 1);
            await db.query(`UPDATE articulos SET fake_stock = $1 WHERE id = $2`, [stock, req.params.id]);
        }
        
        // Calcular viewers activos basado en impresiones recientes
        const recentImpressions = await db.query(`
            SELECT COUNT(DISTINCT session_id) as viewers
            FROM impresiones 
            WHERE producto_id = $1 AND fecha > NOW() - INTERVAL '10 minutes'
        `, [req.params.id]);
        
        const viewers = Math.max(3, Math.min(47, (recentImpressions.rows[0].viewers || 0) + Math.floor(Math.random() * 10)));
        
        let urgencyText = '';
        if (stock < 5) urgencyText = `⚠️ ONLY ${stock} LEFT!`;
        else if (stock < 10) urgencyText = `🔥 ${viewers} people viewing now`;
        else urgencyText = `✨ Premium selection ✨`;
        
        res.json({
            stock: stock,
            viewers: viewers,
            urgency_text: urgencyText,
            ctr: prod.ctr || 0
        });
    } catch (e) {
        res.json({ stock: 15, viewers: 12, urgency_text: '✨ Premium selection ✨' });
    }
});

// ============================================================
// ESTADÍSTICAS
// ============================================================
app.get('/api/stats', async (req, res) => {
    const cached = statsCache.get('stats');
    if (cached) return res.json(cached);
    
    try {
        const [totalProducts, totalClicks, avgCtr] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query('SELECT COUNT(*) FROM clics WHERE fecha > NOW() - INTERVAL \'24 hours\''),
            db.query('SELECT AVG(ctr) as avg_ctr FROM articulos WHERE impresiones > 50')
        ]);
        
        const stats = {
            products: parseInt(totalProducts.rows[0].count),
            clicks_today: parseInt(totalClicks.rows[0].count),
            avg_ctr: parseFloat(avgCtr.rows[0].avg_ctr || 0).toFixed(4),
            version: '6.0.0'
        };
        
        statsCache.set('stats', stats, 60);
        res.json(stats);
    } catch (e) {
        res.json({ products: 0, clicks_today: 0, avg_ctr: 0 });
    }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ status: 'unhealthy' });
    }
});

// ============================================================
// SITEMAP
// ============================================================
app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        const products = await db.query(`
            SELECT id, fecha FROM articulos 
            WHERE impresiones > 0 OR ctr > 0
            ORDER BY ctr DESC LIMIT 500
        `);
        const urls = products.rows.map(p => 
            `<url><loc>${host}/product/${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod></url>`
        ).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    } catch { res.status(500).send('Error'); }
});

// ============================================================
// CRON JOBS
// ============================================================
cron.schedule('0 */6 * * *', async () => {
    console.log('🧠 Auto-learning: analizando CTR...');
    try {
        const topVariants = await db.query(`
            SELECT variant_id, AVG(ctr) as avg_ctr
            FROM (
                SELECT i.variant_id, 
                       COUNT(DISTINCT c.id)::DECIMAL / NULLIF(COUNT(DISTINCT i.id), 0) as ctr
                FROM impresiones i
                LEFT JOIN clics c ON c.session_id = i.session_id AND c.producto_id = i.producto_id
                WHERE i.fecha > NOW() - INTERVAL '7 days'
                GROUP BY i.variant_id, i.session_id
            ) subq
            GROUP BY variant_id
        `);
        console.log('📊 Análisis completado');
    } catch(e) {}
});

cron.schedule('0 */12 * * *', async () => {
    console.log('🧹 Cleanup: eliminando productos muertos...');
    try {
        const result = await db.query(`
            DELETE FROM articulos 
            WHERE (impresiones < 50 AND fecha < NOW() - INTERVAL '14 days')
            OR (ctr < 0.005 AND impresiones > 100)
            RETURNING id
        `);
        console.log(`✅ Eliminados ${result.rowCount} productos`);
    } catch(e) {}
});

// ============================================================
// FRONTEND
// ============================================================
app.use(express.static(__dirname));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// START
// ============================================================
async function start() {
    await initDB();
    console.log(`🚀 MXL GOLD v6.0 | Puerto ${PORT} | Tag: ${AFFILIATE_TAG}`);
    app.listen(PORT, '0.0.0.0', () => console.log(`✅ Servidor listo`));
}

start();
