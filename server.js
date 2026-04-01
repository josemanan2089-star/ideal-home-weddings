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
// AFFILIATE TAG
// ============================================================
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'mxlgold-20';

function agregarAffiliateTag(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('tag', AFFILIATE_TAG);
        return u.toString();
    } catch { return url; }
}

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', version: '5.0' }));

// ============================================================
// DB POSTGRESQL
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const cache = { productos: null, curiosidades: null, noticias: null, ts: {} };
const CACHE_TTL = 60 * 1000;
function cacheValido(key) {
    return cache[key] && cache.ts[key] && (Date.now() - cache.ts[key] < CACHE_TTL);
}

async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT,
                curiosidad TEXT, imagen TEXT, categoria VARCHAR(100),
                link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT,
                imagen TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS noticias (
                id BIGINT PRIMARY KEY, titulo TEXT, resumen TEXT, fuente TEXT,
                imagen TEXT, link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ DB Lista v5.0');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR GEMINI — ROTACIÓN DE 3 KEYS (evita rate limits)
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_CONTENT,
    process.env.GEMINI_API_KEY_SALES,
    process.env.GEMINI_API_KEY_TRAFFIC
].filter(Boolean);

let geminiIndex = 0;
async function generateContent(prompt) {
    for (let i = 0; i < geminiKeys.length; i++) {
        try {
            const key = geminiKeys[(geminiIndex + i) % geminiKeys.length];
            const genAI = new GoogleGenerativeAI(key.trim());
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent(prompt);
            geminiIndex = (geminiIndex + i + 1) % geminiKeys.length;
            return result.response.text().replace(/```json|```/g, '').trim();
        } catch (e) {
            console.warn(`⚠️ Gemini key ${i} falló: ${e.message}`);
        }
    }
    throw new Error('Todos los motores Gemini fallaron');
}

// ============================================================
// IMÁGENES: Pexels → Unsplash → Foto fija (nunca falla)
// ============================================================
async function buscarImagenPexels(keyword) {
    const key = process.env.PEXELS_API_KEY;
    if (!key) return null;
    try {
        const q = encodeURIComponent(keyword + ' luxury');
        const res = await fetch(`https://api.pexels.com/v1/search?query=${q}&per_page=5&orientation=landscape`, {
            headers: { Authorization: key }
        });
        const data = await res.json();
        if (data.photos && data.photos.length > 0) {
            const foto = data.photos[Math.floor(Math.random() * data.photos.length)];
            return foto.src.large;
        }
    } catch (e) { console.warn('Pexels falló:', e.message); }
    return null;
}

async function buscarImagenUnsplash(keyword) {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return null;
    try {
        const q = encodeURIComponent(keyword + ' luxury');
        const res = await fetch(`https://api.unsplash.com/search/photos?query=${q}&per_page=5&orientation=landscape`, {
            headers: { Authorization: `Client-ID ${key}` }
        });
        const data = await res.json();
        if (data.results && data.results.length > 0) {
            const foto = data.results[Math.floor(Math.random() * data.results.length)];
            return foto.urls.regular;
        }
    } catch (e) { console.warn('Unsplash falló:', e.message); }
    return null;
}

async function obtenerImagen(keyword) {
    const img = await buscarImagenPexels(keyword) || await buscarImagenUnsplash(keyword);
    if (img) return img;
    const fijas = ['280229','258154','1643383','323780','1571460','2093107','1457842','276724'];
    const id = fijas[Math.floor(Math.random() * fijas.length)];
    return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1200`;
}

// ============================================================
// PILOTO AUTOMÁTICO — Curiosidades con SEO + CTR + Afiliados
// ============================================================

// Temas con alta intención de búsqueda y compra — rotan para variedad
const TEMAS_SEO = [
    { tema: 'best luxury kitchen appliances Amazon 2026', keyword: 'luxury kitchen appliances' },
    { tema: 'smart home gadgets millionaires NYC buy', keyword: 'smart home luxury' },
    { tema: 'luxury bedroom upgrade products Amazon', keyword: 'luxury bedroom decor' },
    { tema: 'wine cooler refrigerator luxury home bar', keyword: 'luxury wine cooler' },
    { tema: 'best air purifier luxury apartment', keyword: 'luxury air purifier home' },
    { tema: 'luxury coffee maker espresso machine Amazon', keyword: 'luxury espresso machine' },
    { tema: 'heated towel rack bathroom luxury Amazon', keyword: 'heated towel rack luxury' },
    { tema: 'smart lighting luxury home Philips Hue', keyword: 'smart lighting luxury home' },
    { tema: 'luxury mattress sleep quality Amazon 2026', keyword: 'luxury mattress brand' },
    { tema: 'high end vacuum cleaner luxury apartment', keyword: 'luxury vacuum cleaner' },
    { tema: 'outdoor luxury furniture patio Manhattan', keyword: 'luxury outdoor furniture' },
    { tema: 'luxury candle home fragrance Amazon bestseller', keyword: 'luxury candle home decor' },
];

let temaIndex = 0;

async function publicarCuriosidadViral() {
    if (!geminiKeys.length) return;
    console.log('⏰ [CRON] Generando curiosidad SEO...');
    try {
        // Rotar temas para máxima cobertura de keywords
        const temaActual = TEMAS_SEO[temaIndex % TEMAS_SEO.length];
        temaIndex++;

        const prompt = `Eres un experto en SEO, marketing de afiliados de Amazon y copywriting de lujo.

TEMA: "${temaActual.tema}"
AUDIENCIA: Mujeres de 35-55 años, alto poder adquisitivo, viven en NYC, Miami o Beverly Hills. Buscan en Google productos premium para su hogar.

OBJETIVO DOBLE:
1. SEO: El título debe contener keywords que la gente realmente busca en Google (incluye año 2026 si aplica).
2. CTR + Afiliados: El texto debe despertar deseo de compra y llevar al lector a buscar el producto en Amazon.

REGLAS ESTRICTAS:
- El titulo_es debe sonar como un artículo de revista de lujo (máx 12 palabras). Ejemplo: "Las 5 Cafeteras de Lujo Que Todo Penthouse en NYC Necesita en 2026"
- El texto_es debe tener 3-4 oraciones: (1) dato sorprendente o estadística, (2) por qué las mujeres de élite lo quieren, (3) call-to-action suave hacia Amazon. Máx 120 palabras.
- La keyword debe ser exactamente lo que alguien escribiría en Google para buscar este producto (en inglés, 3-5 palabras).
- PROHIBIDO: títulos abstractos, filosóficos o que no hablen de un producto real.

Responde SOLO JSON sin markdown ni explicaciones:
{"titulo_es": "...", "texto_es": "...", "keyword": "..."}`;

        const raw = await generateContent(prompt);
        const data = JSON.parse(raw);
        const imagen = await obtenerImagen(data.keyword || temaActual.keyword);

        await db.query(
            `INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1,$2,$3,$4,$5)`,
            [Date.now(), data.titulo_es, data.texto_es, imagen, new Date().toISOString()]
        );
        cache.curiosidades = null;
        console.log(`✨ [SEO] Curiosidad publicada: ${data.titulo_es}`);
    } catch (e) { console.error('❌ Error curiosidad:', e.message); }
}

// ============================================================
// PILOTO AUTOMÁTICO — Noticias de lujo con NEWS_API
// ============================================================
async function publicarNoticiaLujo() {
    const newsKey = process.env.NEWS_API_KEY;
    if (!newsKey || !geminiKeys.length) return;
    console.log('📰 [CRON] Buscando noticias de lujo...');
    try {
        const queries = ['luxury home', 'luxury lifestyle NYC', 'elite real estate Manhattan'];
        const q = encodeURIComponent(queries[Math.floor(Math.random() * queries.length)]);
        const res = await fetch(
            `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=5`,
            { headers: { 'X-Api-Key': newsKey } }
        );
        const data = await res.json();
        if (!data.articles || data.articles.length === 0) return;

        const articulo = data.articles.find(a => a.title && a.description);
        if (!articulo) return;

        const raw = await generateContent(
            `Eres copywriter de lujo y experto en SEO para afiliados de Amazon.
             Reescribe esta noticia para mujeres de alto poder adquisitivo en NYC.
             El título debe sonar como artículo viral de Architectural Digest o Vogue Living.
             El resumen debe terminar con una frase que lleve a buscar el producto relacionado en Amazon (call-to-action suave).
             Noticia original: "${articulo.title} — ${articulo.description}"
             Responde SOLO JSON sin markdown: {"titulo": "...", "resumen": "...", "keyword": "..."}`
        );
        const copy = JSON.parse(raw);
        const imagen = articulo.urlToImage || await obtenerImagen(copy.keyword || 'luxury');

        await db.query(
            `INSERT INTO noticias (id, titulo, resumen, fuente, imagen, link, fecha) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [Date.now(), copy.titulo, copy.resumen, articulo.source?.name || 'MXL Gold', imagen, articulo.url, new Date().toISOString()]
        );
        cache.noticias = null;
        console.log(`📰 [AUTO] Noticia: ${copy.titulo}`);
    } catch (e) { console.error('❌ Error noticias:', e.message); }
}

// ============================================================
// ENDPOINTS
// ============================================================

// Inyectar producto — imagen automática si no se provee
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!geminiKeys.length || !tituloReal) return res.status(400).json({ success: false, error: 'Falta tituloReal o motor IA' });

    try {
        const raw = await generateContent(
            `Eres un copywriter experto en afiliados de Amazon y psicología de compra de lujo.
             PRODUCTO: "${tituloReal}"
             AUDIENCIA: Mujeres 35-55, alto poder adquisitivo, NYC/Miami/Beverly Hills.

             Escribe copy que venda sin parecer que vende. Reglas:
             - titulo: Nombre del producto elevado, con adjetivo de lujo. Máx 10 palabras.
             - meta: Una frase de 20 palabras que explique el beneficio principal. Para Google.
             - curiosidad: 2-3 oraciones. Empieza con un dato o problema que el producto resuelve. Termina creando urgencia o exclusividad. Máx 60 palabras.
             - keyword: 3-4 palabras en inglés que alguien buscaría en Google para comprar esto.

             Responde SOLO JSON sin markdown: {"titulo": "...", "meta": "...", "curiosidad": "...", "keyword": "..."}`
        );
        const copy = JSON.parse(raw);
        const imagen = imagenUrl || await obtenerImagen(copy.keyword || tituloReal);
        const linkConTag = agregarAffiliateTag(url);

        await db.query(
            `INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, fecha)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [Date.now(), 'MXL'+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagen, categoria, linkConTag, new Date().toISOString()]
        );
        cache.productos = null;
        res.json({ success: true, producto: copy.titulo, affiliateTag: AFFILIATE_TAG, imagen });
    } catch (e) {
        console.error('❌ Error inject:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Búsqueda Google desde Commander
app.get('/api/commander/buscar', async (req, res) => {
    const { q } = req.query;
    const googleKey = process.env.GOOGLE_API_KEY;
    const googleCX = process.env.GOOGLE_CX;
    if (!googleKey || !googleCX || !q) return res.status(400).json({ results: [] });

    try {
        const query = encodeURIComponent(q + ' site:amazon.com');
        const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCX}&q=${query}&num=5`);
        const data = await r.json();
        const results = (data.items || []).map(item => ({
            titulo: item.title,
            link: item.link,
            snippet: item.snippet,
            imagen: item.pagemap?.cse_image?.[0]?.src || null
        }));
        res.json({ results });
    } catch (e) {
        res.status(500).json({ results: [], error: e.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        cache.productos = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
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

app.get('/api/noticias', async (req, res) => {
    if (cacheValido('noticias')) return res.json(cache.noticias);
    const r = await db.query(`SELECT * FROM noticias ORDER BY fecha DESC LIMIT 20`);
    cache.noticias = r.rows;
    cache.ts.noticias = Date.now();
    res.json(r.rows);
});

app.get('/api/stats', async (req, res) => {
    try {
        const [prods, curios, news] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query('SELECT COUNT(*) FROM curiosidades'),
            db.query('SELECT COUNT(*) FROM noticias')
        ]);
        res.json({
            productos: parseInt(prods.rows[0].count),
            curiosidades: parseInt(curios.rows[0].count),
            noticias: parseInt(news.rows[0].count),
            affiliateTag: AFFILIATE_TAG,
            motor: geminiKeys.length ? `Gemini 2.5 Flash ✅ (${geminiKeys.length} keys)` : '❌ Sin API Key',
            pexels: process.env.PEXELS_API_KEY ? '✅ Activo' : '❌',
            unsplash: process.env.UNSPLASH_ACCESS_KEY ? '✅ Activo' : '❌',
            newsApi: process.env.NEWS_API_KEY ? '✅ Activo' : '❌',
            google: (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) ? '✅ Activo' : '❌'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).send('Error sitemap'); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    console.log(`🔑 Gemini keys activas: ${geminiKeys.length}`);
    cron.schedule('*/40 * * * *', () => publicarCuriosidadViral());
    cron.schedule('0 */2 * * *', () => publicarNoticiaLujo());
    setTimeout(() => publicarCuriosidadViral(), 15000);
    setTimeout(() => publicarNoticiaLujo(), 35000);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`🚀 MXL v5.0 — TAG:${AFFILIATE_TAG} — Keys:${geminiKeys.length} — Puerto:${PORT}`)
    );
}
start();
