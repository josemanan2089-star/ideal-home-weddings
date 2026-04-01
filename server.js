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
// DB - PROTOCOLO MXL
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
                id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ DB Lista - Familia MXL');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR 2.5 - EL INMORTAL
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
// INYECCIÓN MANUAL BLINDADA
// ============================================================
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    
    if (!url || !contentModel) return res.status(400).json({ success: false });

    console.log(`🎯 [INYECCIÓN MXL] Creando contenido para: ${tituloReal}`);
    try {
        const prompt = `Eres experto en lujo para NYC. Producto: "${tituloReal}". URL: ${url}. 
        Crea un copy sofisticado. Si es cama, habla de sueño. Si es cocina, de chef. 
        Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [Date.now(), "MXL"+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria, url, new Date().toISOString()]);

        res.json({ success: true, producto: copy.titulo });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// APIs de lectura
app.get('/api/productos', async (req, res) => {
    const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 50`);
    res.json(r.rows);
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    await initGemini();
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MXL 2.5 ONLINE EN PUERTO ${PORT}`));
}
start();
