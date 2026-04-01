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
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// POSTGRESQL - PROTOCOLO MXL v4.0 (MOTOR 2.5)
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT, intro TEXT, 
                curiosidad TEXT, contenido TEXT, imagen TEXT, categoria VARCHAR(100), 
                link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP, clicks INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT, imagen TEXT, 
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ PostgreSQL Listo - Familia MXL');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR GEMINI 2.5 - LA ÚLTIMA GENERACIÓN
// ============================================================
let contentModel = null;

async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        // 🚀 MXL: ACTUALIZADO AL MOTOR 2.5 FLASH
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        console.log("✅ MOTOR MXL: gemini-2.5-flash ACTIVADO (Socio MXL tenía razón)");
    }
}

async function publicarCuriosidad() {
    if (!contentModel) return;
    console.log('⏰ [CRON] Generando Secreto de Lujo con Motor 2.5...');
    try {
        const prompt = "Genera una curiosidad viral de lujo extremo para millonarias en USA. Responde SOLO JSON: {\"titulo_es\": \"...\", \"texto_es\": \"...\"}";
        const result = await contentModel.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        const data = JSON.parse(text);
        
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [Date.now(), data.titulo_es, data.texto_es, 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg', new Date().toISOString()]);
        
        console.log(`✨ [MXL 2.5] Publicado: ${data.titulo_es}`);
    } catch (e) { 
        console.error('❌ Error Motor 2.5:', e.message);
    }
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', engine: '2.5-flash' }));

app.get('/api/productos', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.get('/api/curiosidades', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria } = req.body;
    if (!url || !imagenUrl || !contentModel) return res.status(400).json({ success: false });

    try {
        const prompt = `Genera un copy de venta nivel 2.5. URL: ${url}. Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, clicks, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
        `, [Date.now(), "MXL"+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria || 'LUXURY', url, new Date().toISOString()]);

        res.json({ success: true, producto: copy.titulo });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Servir Frontend
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// LANZAMIENTO
// ============================================================
async function start() {
    await initDB();
    await initGemini();
    
    cron.schedule('*/40 * * * *', () => publicarCuriosidad());
    
    // Pausa de 25 segundos para evitar bloqueos de quota al arrancar
    setTimeout(() => publicarCuriosidad(), 25000);

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 SERVIDOR MXL v4.0 - MOTOR 2.5 ACTIVO`);
    });
}
start();
