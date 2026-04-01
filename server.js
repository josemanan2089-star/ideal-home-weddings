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

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// DB POSTGRESQL - MANDO MXL
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT, 
                curiosidad TEXT, imagen TEXT, categoria VARCHAR(100), 
                link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT, 
                imagen TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ DB Lista - Familia MXL');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR 2.5 - INTELIGENCIA DE MERCADO
// ============================================================
let contentModel = null;
async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        console.log("✅ MOTOR MXL 2.5 ACTIVO");
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
        Responde SOLO JSON: {"titulo_es": "...", "texto_es": "...", "keyword": "..."}`;
        
        const result = await contentModel.generateContent(prompt);
        const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
        
        // 🚀 MXL FIX: Lista de IDs de imágenes de lujo reales de Pexels para que no fallen
        const fotosLujo = [
            '280229', '258154', '1643383', '323780', '1571460', '2093107', '1457842', '276724'
        ];
        const fotoRandom = fotosLujo[Math.floor(Math.random() * fotosLujo.length)];
        const imagenFinal = `https://images.pexels.com/photos/${fotoRandom}/pexels-photo-${fotoRandom}.jpeg?auto=compress&cs=tinysrgb&w=1200`;

        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [Date.now(), data.titulo_es, data.texto_es, imagenFinal, new Date().toISOString()]);
        
        console.log(`✨ [AUTO] Publicado con éxito: ${data.titulo_es}`);
    } catch (e) { console.error('❌ Error:', e.message); }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!contentModel || !tituloReal) return res.status(400).json({ success: false });

    try {
        const prompt = `Copywriter de lujo. TEMA: "${tituloReal}". Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [Date.now(), "MXL"+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria, url, new Date().toISOString()]);

        res.json({ success: true, producto: copy.titulo });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/productos', async (req, res) => {
    const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
    res.json(r.rows);
});

app.get('/api/curiosidades', async (req, res) => {
    const r = await db.query(`SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50`);
    res.json(r.rows);
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    await initGemini();
    cron.schedule('*/40 * * * *', () => publicarCuriosidadViral());
    setTimeout(() => publicarCuriosidadViral(), 20000);
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MXL 2.5 v4.8 - IMAGENES BLINDADAS`));
}
start();
