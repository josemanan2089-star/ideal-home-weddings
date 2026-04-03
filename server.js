const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// DB CON POOL OPTIMIZADO
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
});

let categoryCache = null;
let categoryCacheTime = 0;

async function initDB() {
    await db.query(`CREATE TABLE IF NOT EXISTS articulos (
        id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT,
        curiosidad TEXT, imagen TEXT, categoria VARCHAR(100),
        link TEXT, keyword TEXT, clics INT DEFAULT 0,
        seccion VARCHAR(60) DEFAULT 'buying_now',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS clics (
        id BIGSERIAL PRIMARY KEY, producto_id BIGINT,
        tipo VARCHAR(20) DEFAULT 'product',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, accion VARCHAR(60) NOT NULL,
        producto_id BIGINT, titulo TEXT, affiliate_tag VARCHAR(60),
        detalle TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS curiosidades (
        id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT,
        imagen TEXT, keyword TEXT, producto_id BIGINT,
        seccion VARCHAR(60) DEFAULT 'trending',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Índices para velocidad
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_fecha ON articulos(fecha DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_seccion ON articulos(seccion)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_clics ON articulos(clics DESC)`);
    
    console.log('✅ DB lista');
}

function addAffiliateTag(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('tag', AFFILIATE_TAG);
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
// GEMINI CON ROTACIÓN DE 3 KEYS
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(Boolean);

let geminiIndex = 0;

async function generateContent(prompt, maxRetries = 2) {
    if (!geminiKeys.length) throw new Error('No Gemini keys');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (let i = 0; i < geminiKeys.length; i++) {
            const keyIndex = (geminiIndex + i) % geminiKeys.length;
            try {
                const genAI = new GoogleGenerativeAI(geminiKeys[keyIndex].trim());
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const result = await model.generateContent(prompt);
                geminiIndex = (keyIndex + 1) % geminiKeys.length;
                return result.response.text();
            } catch (e) {
                console.warn(`⚠️ Key ${keyIndex + 1}: ${e.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw new Error('All Gemini keys failed');
}

async function generateSellingCopy(titulo, categoria) {
    const prompt = `Eres una experta en ventas de lujo para mujeres de NYC, Miami y LA.

PRODUCTO: "${titulo}"
CATEGORÍA: "${categoria}"

REGLAS:
- NO describas características técnicas
- VENDE el ESTILO DE VIDA
- Usa: "porque te lo mereces", "mujeres exitosas", "el secreto"
- Incluye una ciudad (NYC, SoHo, Miami, Brickell, LA)
- Crea URGENCIA real

Responde SOLO este JSON:
{
  "title": "titulo que vende (max 10 palabras, incluye ciudad)",
  "meta": "frase que genera DESEO (max 15 palabras)",
  "teaser": "2 frases: 1) prueba social 2) qué pasa si NO lo compras",
  "keyword": "3-5 palabras para buscar esto",
  "badge": "NYC's Favorite, Best Seller, Editor's Pick, o Top Rated",
  "fomo": "frase que da MIEDO perderse esto",
  "cta": "acción inmediata"
}`;

    const raw = await generateContent(prompt);
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : clean);
    return parsed;
}

// ============================================================
// ENDPOINTS
// ============================================================

app.post('/api/track/click', async (req, res) => {
    const { producto_id } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    try {
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [producto_id]);
        await db.query(`INSERT INTO clics (producto_id) VALUES ($1)`, [producto_id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/api/productos', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 12;
    const offset = (page - 1) * limit;
    const seccion = req.query.seccion;
    
    try {
        let query = `SELECT * FROM articulos`;
        let countQuery = `SELECT COUNT(*) FROM articulos`;
        const params = [];
        
        if (seccion) {
            query += ` WHERE seccion = $1`;
            countQuery += ` WHERE seccion = $1`;
            params.push(seccion);
        }
        
        query += ` ORDER BY fecha DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const [rows, total] = await Promise.all([
            db.query(query, params),
            db.query(countQuery, seccion ? [seccion] : [])
        ]);
        
        res.json({ items: rows.rows, total: parseInt(total.rows[0].count), page, hasMore: offset + limit < parseInt(total.rows[0].count) });
    } catch (e) { res.status(500).json({ items: [] }); }
});

app.get('/api/categorias', async (req, res) => {
    const now = Date.now();
    if (categoryCache && (now - categoryCacheTime) < 300000) {
        return res.json(categoryCache);
    }
    try {
        const r = await db.query(`SELECT DISTINCT categoria, COUNT(*) as total FROM articulos GROUP BY categoria ORDER BY total DESC`);
        categoryCache = r.rows;
        categoryCacheTime = now;
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal, seccion = 'buying_now' } = req.body;
    if (!tituloReal || !url) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    try {
        const copy = await generateSellingCopy(tituloReal, categoria || 'LUXURY');
        const image = imagenUrl || `https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg?auto=compress&cs=tinysrgb&w=600`;
        const linkWithTag = addAffiliateTag(url);
        const metaWithBadge = JSON.stringify({ badge: copy.badge, text: copy.meta });
        const id = Date.now();
        
        await db.query(
            `INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, keyword, seccion, clics, fecha) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11)`,
            [id, 'MXL'+id, copy.title, metaWithBadge, copy.teaser, image, categoria || 'LUXURY', linkWithTag, copy.keyword, seccion, new Date()]
        );
        
        await audit('INJECT', id, copy.title, AFFILIATE_TAG, `seccion:${seccion}|badge:${copy.badge}`);
        categoryCache = null;
        
        console.log(`✅ Inyectado: ${copy.title}`);
        res.json({ success: true, product: copy.title, badge: copy.badge, fomo: copy.fomo, cta: copy.cta, affiliateTag: AFFILIATE_TAG });
    } catch (e) {
        console.error('❌ Inject error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        await db.query('DELETE FROM clics WHERE producto_id = $1', [req.params.id]);
        categoryCache = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        const [prods, clicsHoy, topClick] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query(`SELECT COUNT(*) FROM clics WHERE fecha > NOW() - INTERVAL '24 hours'`),
            db.query('SELECT titulo, clics FROM articulos ORDER BY clics DESC LIMIT 1')
        ]);
        res.json({
            productos: parseInt(prods.rows[0].count),
            clicsHoy: parseInt(clicsHoy.rows[0].count),
            topProducto: topClick.rows[0] || null,
            affiliateTag: AFFILIATE_TAG,
            geminiKeys: geminiKeys.length,
            version: '4.0.0'
        });
    } catch (e) { res.json({ productos: 0, clicsHoy: 0 }); }
});

app.get('/api/admin/audit', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM audit_log ORDER BY fecha DESC LIMIT 100`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.post('/api/admin/repair-tags', async (req, res) => {
    try {
        const rows = await db.query(`SELECT id, titulo, link FROM articulos`);
        let fixed = 0;
        for (const row of rows.rows) {
            const corrected = addAffiliateTag(row.link);
            const currentTag = new URL(row.link).searchParams.get('tag');
            if (currentTag !== AFFILIATE_TAG) {
                await db.query(`UPDATE articulos SET link = $1 WHERE id = $2`, [corrected, row.id]);
                fixed++;
            }
        }
        res.json({ success: true, fixed, total: rows.rows.length });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        const r = await db.query('SELECT id, fecha FROM articulos ORDER BY fecha DESC LIMIT 500');
        const urls = r.rows.map(p => `<url><loc>${host}/product/${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod></url>`).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc></url>${urls}</urlset>`);
    } catch { res.status(500).send('Error'); }
});

// Auto-pilot cada 45 min
async function generateInsight() {
    if (!geminiKeys.length) return;
    try {
        const prompt = `Escribe un insight de lujo para mujeres de NYC/Miami/LA. Responde SOLO JSON: {"title":"...","body":"...","keyword":"..."}`;
        const raw = await generateContent(prompt);
        const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, keyword, fecha) VALUES ($1,$2,$3,$4,$5,$6)`,
            [Date.now(), data.title, data.body, `https://images.pexels.com/photos/1643383/pexels-photo-1643383.jpeg`, data.keyword, new Date()]);
        console.log(`✨ Insight: ${data.title}`);
    } catch (e) {}
}

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    console.log(`🚀 MXL v4.0 | Gemini: ${geminiKeys.length} keys | Tag: ${AFFILIATE_TAG}`);
    if (geminiKeys.length) {
        cron.schedule('*/45 * * * *', () => generateInsight());
        setTimeout(() => generateInsight(), 30000);
    }
    app.listen(PORT, '0.0.0.0', () => console.log(`✅ Puerto ${PORT}`));
}

start();
