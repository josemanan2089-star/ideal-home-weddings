// ============================================
// MXL GOLD v7.0 AGGRESSIVE CONVERSION ENGINE
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
    connectionTimeoutMillis: 5000
});

// ============================================================
// SAFE initDB — usa ALTER TABLE IF NOT EXISTS para no romper schemas existentes
// ============================================================
async function initDB() {
    // Tabla base
    await db.query(`CREATE TABLE IF NOT EXISTS articulos (
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
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Añadir columnas opcionales de forma segura (no falla si ya existen)
    const optionalCols = [
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS fake_stock INT DEFAULT 15`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS last_fomo_update TIMESTAMP DEFAULT NOW()`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS conversion_rate DECIMAL(5,4) DEFAULT 0`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS quality_score DECIMAL(5,2) DEFAULT 0`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS winning_variant INT DEFAULT 0`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS precio DECIMAL(10,2) DEFAULT 49.99`,
        `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`,
    ];

    for (const sql of optionalCols) {
        try { await db.query(sql); } catch (e) { /* ignore */ }
    }

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

    // Índices
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_articulos_ctr ON articulos(ctr DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_articulos_featured ON articulos(is_featured)`,
        `CREATE INDEX IF NOT EXISTS idx_articulos_status ON articulos(status)`,
        `CREATE INDEX IF NOT EXISTS idx_clicks_producto ON clics(producto_id)`,
        `CREATE INDEX IF NOT EXISTS idx_impresiones_producto ON impresiones(producto_id)`,
        `CREATE INDEX IF NOT EXISTS idx_clics_fecha ON clics(fecha DESC)`,
    ];
    for (const sql of indexes) {
        try { await db.query(sql); } catch (e) { /* ignore */ }
    }

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
            u.searchParams.set('subtag', generateSubtag(productId, variantId));
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
    if (!geminiKeys.length) throw new Error('No Gemini keys configured');

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
                console.warn(`⚠️ Gemini key ${keyIndex + 1} attempt ${attempt}: ${e.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw new Error('All Gemini keys failed');
}

// ============================================================
// /go/:id — REDIRECT CON TRACKING + SUBTAG
// ============================================================
app.get('/go/:id', async (req, res) => {
    const productId = parseInt(req.params.id);
    const variantId = parseInt(req.query.variant) || 0;

    if (isNaN(productId)) return res.status(400).send('Invalid ID');

    try {
        const product = await db.query(`SELECT id, link, titulo FROM articulos WHERE id = $1`, [productId]);
        if (!product.rows.length) return res.status(404).send('Product not found');

        const prod = product.rows[0];

        // Registrar clic
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [productId]);
        await db.query(
            `INSERT INTO clics (producto_id, tipo, session_id, user_agent, variant_id, subtag)
             VALUES ($1, 'product', $2, $3, $4, $5)`,
            [productId, req.session.id, req.headers['user-agent'] || '', variantId, generateSubtag(productId, variantId)]
        );

        // Actualizar CTR
        await db.query(`
            UPDATE articulos
            SET ctr = CASE WHEN impresiones > 0 THEN clics::DECIMAL / impresiones ELSE 0 END
            WHERE id = $1
        `, [productId]);

        const finalUrl = addAffiliateTag(prod.link, productId, variantId);
        await audit('CLICK', productId, prod.titulo, AFFILIATE_TAG, `variant:${variantId}`);

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
            `INSERT INTO impresiones (producto_id, session_id, variant_id, position) VALUES ($1, $2, $3, $4)`,
            [producto_id, req.session.id, variant_id, position]
        );
        await db.query(`UPDATE articulos SET impresiones = impresiones + 1 WHERE id = $1`, [producto_id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false });
    }
});

// ============================================================
// PRODUCTOS — endpoint principal del frontend
// ============================================================
app.get('/api/productos', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const categoria = req.query.categoria || null;

    try {
        const params = [];
        let where = `WHERE (status = 'active' OR status IS NULL)`;
        if (categoria) {
            params.push(categoria);
            where += ` AND categoria = $${params.length}`;
        }

        const countResult = await db.query(`SELECT COUNT(*) FROM articulos ${where}`, params);
        const total = parseInt(countResult.rows[0].count);

        params.push(limit);
        params.push(offset);

        const result = await db.query(`
            SELECT id, titulo, meta, curiosidad, imagen, categoria, clics, impresiones, ctr,
                   is_featured, precio, seccion, conversion_rate, link, fecha
            FROM articulos ${where}
            ORDER BY is_featured DESC, ctr DESC, clics DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);

        res.json({
            items: result.rows,
            total,
            page,
            hasMore: offset + limit < total
        });
    } catch (e) {
        console.error('Products error:', e);
        res.status(500).json({ items: [], total: 0, hasMore: false, error: e.message });
    }
});

// ============================================================
// PRODUCTOS v2 — para el frontend nuevo (/api/products)
// ============================================================
app.get('/api/products', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const seccion = req.query.seccion || null;

    try {
        const params = [];
        let where = `WHERE (status = 'active' OR status IS NULL)`;
        if (seccion) {
            params.push(seccion);
            where += ` AND seccion = $${params.length}`;
        }
        params.push(limit);

        const result = await db.query(`
            SELECT id, titulo, meta, curiosidad, imagen, categoria, clics, impresiones, ctr,
                   is_featured, precio, conversion_rate, link
            FROM articulos ${where}
            ORDER BY is_featured DESC, ctr DESC, clics DESC
            LIMIT $${params.length}
        `, params);

        const processed = result.rows.map(p => {
            let metaData = {};
            try { metaData = JSON.parse(p.meta || '{}'); } catch (e) {}

            let badge = null;
            if (p.is_featured) badge = { text: '🔥 BEST SELLER', color: '#e6b800' };
            else if ((p.ctr || 0) > 0.03) badge = { text: '📈 TRENDING', color: '#ff4500' };
            else if ((p.ctr || 0) > 0.01) badge = { text: '⭐ POPULAR', color: '#8b5cf6' };

            return {
                id: p.id,
                title: p.titulo,
                image: p.imagen,
                category: p.categoria,
                price: parseFloat(p.precio) || 49.99,
                ctr: p.ctr || 0,
                clicks: p.clics || 0,
                badge,
                teaser: metaData.text || p.curiosidad || `Premium ${p.categoria} product`,
                badgeText: metaData.badge || null,
                link: p.link
            };
        });

        res.json({ success: true, products: processed });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// CATEGORIAS
// ============================================================
app.get('/api/categorias', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT categoria, COUNT(*) as count
            FROM articulos
            WHERE (status = 'active' OR status IS NULL) AND categoria IS NOT NULL
            GROUP BY categoria
            ORDER BY count DESC
            LIMIT 10
        `);
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

// ============================================================
// FOMO POR PRODUCTO
// ============================================================
app.get('/api/producto/fomo/:id', async (req, res) => {
    try {
        const product = await db.query(`
            SELECT id, fake_stock, clics, impresiones, ctr
            FROM articulos WHERE id = $1
        `, [req.params.id]);

        if (!product.rows.length) return res.json({ stock: 15, viewers: 12, purchases: [] });

        const prod = product.rows[0];
        let stock = prod.fake_stock || 15;

        // Reducir stock basado en CTR
        if ((prod.ctr || 0) > 0.05 && stock > 3) {
            stock = Math.max(1, stock - 1);
            try {
                await db.query(`UPDATE articulos SET fake_stock = $1 WHERE id = $2`, [stock, req.params.id]);
            } catch (e) {}
        }

        const recentImpressions = await db.query(`
            SELECT COUNT(DISTINCT session_id) as viewers
            FROM impresiones
            WHERE producto_id = $1 AND fecha > NOW() - INTERVAL '10 minutes'
        `, [req.params.id]);

        const viewers = Math.max(3, Math.min(47, parseInt(recentImpressions.rows[0].viewers || 0) + Math.floor(Math.random() * 10)));

        // Generar compras recientes simuladas basadas en actividad real
        const names = ['Sophia', 'Isabella', 'Emma', 'Olivia', 'Ava', 'Mia', 'Luna', 'Victoria', 'Valentina', 'Camila'];
        const cities = ['NYC', 'Miami', 'LA', 'SoHo', 'Brickell', 'Beverly Hills'];
        const purchases = Array.from({ length: Math.min(3, Math.max(1, Math.floor((prod.clics || 0) / 3))) }, (_, i) => ({
            name: names[Math.floor(Math.random() * names.length)],
            city: cities[Math.floor(Math.random() * cities.length)],
            minutes: Math.floor(Math.random() * 30) + 1 + i * 10
        }));

        let urgency_text = '';
        if (stock < 5) urgency_text = `⚠️ ONLY ${stock} LEFT!`;
        else if (viewers > 15) urgency_text = `🔥 ${viewers} people viewing now`;
        else urgency_text = `✨ Premium selection ✨`;

        res.json({ stock, viewers, urgency_text, purchases, ctr: prod.ctr || 0 });
    } catch (e) {
        res.json({ stock: 15, viewers: 12, urgency_text: '✨ Premium selection ✨', purchases: [] });
    }
});

// Alias para compatibilidad
app.get('/api/product/fomo/:id', async (req, res) => {
    req.params.id = req.params.id;
    const fomoRes = await db.query(`SELECT id, fake_stock, clics, impresiones, ctr FROM articulos WHERE id = $1`, [req.params.id]);
    if (!fomoRes.rows.length) return res.json({ stock: 15, viewers: 12 });
    const p = fomoRes.rows[0];
    const stock = p.fake_stock || 15;
    const viewers = Math.floor(Math.random() * 30) + 5;
    res.json({ stock, viewers, urgency_text: stock < 5 ? `⚠️ ONLY ${stock} LEFT!` : `🔥 ${viewers} viewing now` });
});

// ============================================================
// STATS
// ============================================================
app.get('/api/stats', async (req, res) => {
    const cached = statsCache.get('stats');
    if (cached) return res.json(cached);

    try {
        const [totalProducts, totalClicks, avgCtr, convRate] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos WHERE (status = $1 OR status IS NULL)', ['active']),
            db.query(`SELECT COUNT(*) FROM clics WHERE fecha > NOW() - INTERVAL '24 hours'`),
            db.query('SELECT AVG(ctr) as avg_ctr FROM articulos WHERE impresiones > 50'),
            db.query('SELECT AVG(conversion_rate) as avg_conv FROM articulos WHERE clics > 10')
        ]);

        const stats = {
            productos: parseInt(totalProducts.rows[0].count),
            clicsHoy: parseInt(totalClicks.rows[0].count),
            avg_ctr: parseFloat(avgCtr.rows[0].avg_ctr || 0).toFixed(4),
            conversion_rate_avg: parseFloat((convRate.rows[0].avg_conv || 0) * 100).toFixed(2),
            affiliateTag: AFFILIATE_TAG,
            version: '7.0.0'
        };

        statsCache.set('stats', stats, 60);
        res.json(stats);
    } catch (e) {
        res.json({ productos: 0, clicsHoy: 0, avg_ctr: 0, affiliateTag: AFFILIATE_TAG });
    }
});

// ============================================================
// PRODUCTOS GANADORES
// ============================================================
app.get('/api/winning-products', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT id, titulo, clics, impresiones, ctr, conversion_rate, quality_score
            FROM articulos
            WHERE clics > 0 AND (status = 'active' OR status IS NULL)
            ORDER BY conversion_rate DESC, ctr DESC, clics DESC
            LIMIT 10
        `);
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

// ============================================================
// DELETE PRODUCTO
// ============================================================
app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query(`DELETE FROM articulos WHERE id = $1`, [req.params.id]);
        await audit('DELETE', req.params.id, null, AFFILIATE_TAG, 'manual delete');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// CLEANUP DEAD PRODUCTS
// ============================================================
app.delete('/api/cleanup/dead-products', async (req, res) => {
    try {
        const result = await db.query(`
            DELETE FROM articulos
            WHERE clics = 0 AND fecha < NOW() - INTERVAL '7 days'
            RETURNING id
        `);
        await audit('CLEANUP_DEAD', null, null, AFFILIATE_TAG, `deleted:${result.rowCount}`);
        res.json({ success: true, deleted: result.rowCount });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// AUDIT LOG
// ============================================================
app.get('/api/admin/audit', async (req, res) => {
    const limit = parseInt(req.query.limit) || 80;
    try {
        const result = await db.query(`
            SELECT id, accion, producto_id, titulo, affiliate_tag, detalle, fecha
            FROM audit_log
            ORDER BY fecha DESC
            LIMIT $1
        `, [limit]);
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

// ============================================================
// INYECTAR PRODUCTO CON IA
// ============================================================
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria = 'LUXURY', tituloReal, seccion = 'buying_now' } = req.body;
    if (!url || !tituloReal) return res.status(400).json({ success: false, error: 'Missing fields' });

    try {
        let asin = null;
        try {
            const match = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
            if (match) asin = match[1];
        } catch (e) {}

        let titulo = tituloReal;
        let meta = JSON.stringify({ badge: 'New Arrival', text: `Premium ${categoria.toLowerCase()} product — curated for the discerning buyer.` });
        let curiosidad = `Discover why elite shoppers in NYC, Miami, and LA are obsessing over this ${categoria.toLowerCase()} essential.`;

        if (geminiKeys.length > 0) {
            try {
                const prompt = `You are a luxury lifestyle copywriter for an Amazon affiliate site targeting affluent women in NYC, Miami, and LA.

Product: "${tituloReal}"
Category: ${categoria}

Generate EXACTLY this JSON (no markdown, no backticks):
{
  "titulo": "A captivating luxury title (max 80 chars, no ALL CAPS)",
  "badge": "One of: Editor's Pick | Must-Have | Trending Now | Best Seller | Staff Pick",
  "teaser": "A 1-2 sentence emotional hook that creates desire. Reference NYC/Miami/LA lifestyle. No generic language.",
  "curiosidad": "A fascinating fact or lifestyle insight about this product that makes someone want to click (1-2 sentences)"
}`;

                const raw = await generateContent(prompt);
                const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
                const parsed = JSON.parse(cleaned);

                titulo = parsed.titulo || tituloReal;
                meta = JSON.stringify({ badge: parsed.badge || 'Editor\'s Pick', text: parsed.teaser || '' });
                curiosidad = parsed.curiosidad || curiosidad;
            } catch (e) {
                console.warn('Gemini failed, using defaults:', e.message);
            }
        }

        const id = Date.now();
        const affiliateUrl = addAffiliateTag(url, id, 0);

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, seccion, clics, impresiones, ctr, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, 0, 'active')
        `, [id, asin, titulo, meta, curiosidad, imagenUrl || '', categoria, affiliateUrl, seccion]);

        await audit('INJECT_LUXURY', id, titulo, AFFILIATE_TAG, `asin:${asin || 'N/A'}`);

        let metaParsed = {};
        try { metaParsed = JSON.parse(meta); } catch (e) {}

        res.json({ success: true, product: titulo, badge: metaParsed.badge, id });
    } catch (e) {
        console.error('Inject error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// PREVIEW UPGRADE
// ============================================================
app.post('/api/admin/preview-upgrade', async (req, res) => {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ success: false, error: 'Missing productId' });

    try {
        const result = await db.query(`SELECT id, titulo, meta, curiosidad, categoria FROM articulos WHERE id = $1`, [productId]);
        if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });

        const p = result.rows[0];
        let currentMeta = {};
        try { currentMeta = JSON.parse(p.meta || '{}'); } catch (e) {}

        const prompt = `You are a luxury lifestyle copywriter for an Amazon affiliate site targeting affluent women in NYC, Miami, and LA.

Product: "${p.titulo}"
Category: ${p.categoria}
Current description: "${currentMeta.text || p.curiosidad || 'N/A'}"

Upgrade this to LUXURY copy. Return EXACTLY this JSON (no markdown):
{
  "titulo": "Elevated luxury title (max 80 chars)",
  "badge": "One of: Editor's Pick | Must-Have | Trending Now | Best Seller | Staff Pick",
  "teaser": "2 sentences of emotional, aspirational copy mentioning NYC/Miami/LA lifestyle",
  "curiosidad": "Fascinating insight that creates desire to click (1-2 sentences)"
}`;

        const raw = await generateContent(prompt);
        const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
        const preview = JSON.parse(cleaned);

        res.json({
            success: true,
            current: {
                title: p.titulo,
                badge: currentMeta.badge,
                teaser: currentMeta.text,
                metaText: p.curiosidad
            },
            preview
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// UPGRADE TO LUXURY
// ============================================================
app.post('/api/admin/upgrade-to-luxury', async (req, res) => {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ success: false, error: 'Missing productId' });

    try {
        const result = await db.query(`SELECT id, titulo, meta, curiosidad, categoria FROM articulos WHERE id = $1`, [productId]);
        if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });

        const p = result.rows[0];

        const prompt = `You are a luxury lifestyle copywriter for an Amazon affiliate site targeting affluent women in NYC, Miami, and LA.

Product: "${p.titulo}"
Category: ${p.categoria}

Upgrade to LUXURY copy. Return EXACTLY this JSON (no markdown):
{
  "titulo": "Elevated luxury title (max 80 chars)",
  "badge": "One of: Editor's Pick | Must-Have | Trending Now | Best Seller | Staff Pick",
  "teaser": "2 sentences of emotional aspirational copy mentioning NYC/Miami/LA",
  "curiosidad": "Fascinating insight creating desire to click (1-2 sentences)"
}`;

        const raw = await generateContent(prompt);
        const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
        const newCopy = JSON.parse(cleaned);

        const newMeta = JSON.stringify({ badge: newCopy.badge, text: newCopy.teaser });

        await db.query(`
            UPDATE articulos
            SET titulo = $1, meta = $2, curiosidad = $3
            WHERE id = $4
        `, [newCopy.titulo, newMeta, newCopy.curiosidad, productId]);

        await audit('MANUAL_UPGRADE_LUXURY', productId, newCopy.titulo, AFFILIATE_TAG, `badge:${newCopy.badge}`);

        res.json({ success: true, newCopy });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// AUDIT QUALITY
// ============================================================
app.get('/api/admin/audit-quality', async (req, res) => {
    try {
        const result = await db.query(`SELECT id, titulo, meta, curiosidad, conversion_rate FROM articulos WHERE (status = 'active' OR status IS NULL)`);
        let premium = 0, basic = 0, poor = 0, converters = 0;

        for (const p of result.rows) {
            let metaText = '';
            try { metaText = JSON.parse(p.meta || '{}').text || ''; } catch (e) {}
            const text = (metaText + ' ' + (p.curiosidad || '')).toLowerCase();
            const cheapWords = ['amazing', 'great', 'good', 'nice', 'high quality', 'very good', 'excellent'];
            const hasCheap = cheapWords.some(w => text.includes(w));
            const length = metaText.length + (p.curiosidad || '').length;
            const convRate = parseFloat(p.conversion_rate || 0);

            if (convRate > 0.5) converters++;
            else if (!hasCheap && length > 100) premium++;
            else if (hasCheap || length < 50) basic++;
            else poor++;
        }

        res.json({ success: true, premium, basic, poor, converters, total: result.rows.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// HEALTH - RESPUESTA INMEDIATA (CORREGIDO)
// ============================================================
// Healthcheck rápido para Railway - NO espera DB
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Healthcheck completo con DB (para monitoreo manual)
app.get('/health/full', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ status: 'healthy', database: 'connected', version: '7.0.0' });
    } catch (e) {
        res.status(500).json({ status: 'unhealthy', database: 'disconnected' });
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
            WHERE (status = 'active' OR status IS NULL)
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
    console.log('🧠 Auto-learning: analyzing CTR...');
    try {
        // Marcar productos con CTR alto como featured
        await db.query(`
            UPDATE articulos SET is_featured = TRUE
            WHERE ctr > 0.05 AND clics > 10 AND (status = 'active' OR status IS NULL)
        `);
        await db.query(`
            UPDATE articulos SET is_featured = FALSE
            WHERE ctr <= 0.05 AND is_featured = TRUE
        `);
        console.log('📊 Auto-learning complete');
    } catch (e) { console.error('Auto-learning error:', e.message); }
});

cron.schedule('0 */12 * * *', async () => {
    console.log('🧹 Cleanup: removing dead products...');
    try {
        const result = await db.query(`
            DELETE FROM articulos
            WHERE (impresiones < 50 AND fecha < NOW() - INTERVAL '14 days')
               OR (ctr < 0.005 AND impresiones > 200)
            RETURNING id
        `);
        console.log(`✅ Deleted ${result.rowCount} dead products`);
    } catch (e) { console.error('Cleanup error:', e.message); }
});

// ============================================================
// STATIC + SPA
// ============================================================
app.use(express.static(__dirname));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// START
// ============================================================
async function start() {
    try {
        await initDB();
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 MXL GOLD v7.0 | Port ${PORT} | Tag: ${AFFILIATE_TAG}`);
            console.log(`✅ Server ready`);
        });
    } catch (e) {
        console.error('❌ Startup failed:', e);
        process.exit(1);
    }
}

start();
