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

// ============================================================
// AFFILIATE TAG — Configura tu ID en .env como AMAZON_AFFILIATE_TAG
// ============================================================
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'mxlgold-20';

function agregarAffiliateTag(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('tag', AFFILIATE_TAG);
        return u.toString();
    } catch {
        return url;
    }
}

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// HEALTH CHECK — Railway lo necesita (estaba en railway.json pero faltaba aquí)
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.9', tag: AFFILIATE_TAG }));

// ============================================================
// DB POSTGRESQL - MANDO MXL
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Cache simple en memoria — evita golpear la DB en cada visita
const cache = { productos: null, curiosidades: null, ts: {} };
const CACHE_TTL = 60 * 1000; // 60 segundos

function cacheValido(key) {
    return cache[key] && cache.ts[key] && (Date.now() - cache.ts[key] < CACHE_TTL);
}

async function initDB() {
    try {
        // FIX: Separar los dos CREATE TABLE en queries independientes
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY,
                asin VARCHAR(20),
                titulo TEXT,
                meta TEXT,
                curiosidad TEXT,
                imagen TEXT,
                categoria VARCHAR(100),
                link TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY,
                titulo_es TEXT,
                texto_es TEXT,
                imagen TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ DB Lista - Familia MXL');
    } catch (e) {
        console.error('❌ Error DB:', e.message);
    }
}

// ============================================================
// MOTOR 2.5 - INTELIGENCIA DE MERCADO
// ============================================================
let contentModel = null;
async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        contentModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        console.log('✅ MOTOR MXL 2.5 ACTIVO');
    }
}

// ============================================================
// PILOTO AUTOMÁTICO - CURIOSIDADES CON IMAGEN REAL
// ============================================================
async function publicarCuriosidadViral() {
    if (!contentModel) return;
    console.log('⏰ [CRON] Generando curiosidad con imagen real...');
    try {
        const prompt = `Genera una curiosidad viral de ultra-lujo para millonarias en NYC. 
        Responde SOLO JSON sin markdown: {"titulo_es": "...", "texto_es": "...", "keyword": "..."}`;

        const result = await contentModel.generateContent(prompt);
        const raw = result.response.text().replace(/```json|```/g, '').trim();
        const data = JSON.parse(raw);

        const fotosLujo = ['280229', '258154', '1643383', '323780', '1571460', '2093107', '1457842', '276724'];
        const fotoRandom = fotosLujo[Math.floor(Math.random() * fotosLujo.length)];
        const imagenFinal = `https://images.pexels.com/photos/${fotoRandom}/pexels-photo-${fotoRandom}.jpeg?auto=compress&cs=tinysrgb&w=1200`;

        await db.query(
            `INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`,
            [Date.now(), data.titulo_es, data.texto_es, imagenFinal, new Date().toISOString()]
        );

        cache.curiosidades = null; // Invalidar caché
        console.log(`✨ [AUTO] Publicado: ${data.titulo_es}`);
    } catch (e) {
        console.error('❌ Error curiosidad:', e.message);
    }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!contentModel || !tituloReal) return res.status(400).json({ success: false, error: 'Falta tituloReal o motor IA' });

    try {
        const prompt = `Copywriter de lujo para mujeres de alto poder adquisitivo en NYC. 
        TEMA: "${tituloReal}". 
        Responde SOLO JSON sin markdown: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;

        const result = await contentModel.generateContent(prompt);
        const raw = result.response.text().replace(/```json|```/g, '').trim();
        const copy = JSON.parse(raw);

        // 💰 Añadir affiliate tag automáticamente al guardar
        const linkConTag = agregarAffiliateTag(url);

        await db.query(
            `INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, fecha)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [Date.now(), 'MXL' + Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria, linkConTag, new Date().toISOString()]
        );

        cache.productos = null; // Invalidar caché
        res.json({ success: true, producto: copy.titulo, affiliateTag: AFFILIATE_TAG });
    } catch (e) {
        console.error('❌ Error inject:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        cache.productos = null;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/productos', async (req, res) => {
    if (cacheValido('productos')) return res.json(cache.productos);
    const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
    cache.productos = r.rows;
    cache.ts.productos = Date.now();
    res.json(r.rows);
});

app.get('/api/curiosidades', async (req, res) => {
    if (cacheValido('curiosidades')) return res.json(cache.curiosidades);
    const r = await db.query(`SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50`);
    cache.curiosidades = r.rows;
    cache.ts.curiosidades = Date.now();
    res.json(r.rows);
});

app.get('/api/stats', async (req, res) => {
    try {
        const [prods, curios] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query('SELECT COUNT(*) FROM curiosidades')
        ]);
        res.json({
            productos: parseInt(prods.rows[0].count),
            curiosidades: parseInt(curios.rows[0].count),
            affiliateTag: AFFILIATE_TAG,
            motor: contentModel ? 'Gemini 2.5 Flash ✅' : '❌ Sin API Key'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Sitemap dinámico para SEO
app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        const r = await db.query('SELECT id, fecha FROM articulos ORDER BY fecha DESC LIMIT 200');
        const urls = r.rows.map(p =>
            `<url><loc>${host}/producto/${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`
        ).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${host}</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>
${urls}
</urlset>`);
    } catch (e) {
        res.status(500).send('Error generando sitemap');
    }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    await initGemini();
    cron.schedule('*/40 * * * *', () => publicarCuriosidadViral());
    setTimeout(() => publicarCuriosidadViral(), 20000);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`🚀 MXL 2.5 v4.9 — TAG: ${AFFILIATE_TAG} — Puerto: ${PORT}`)
    );
}
start();
