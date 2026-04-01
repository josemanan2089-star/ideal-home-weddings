const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron'); // Añadido para el piloto automático
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
        // Creamos ambas tablas: Productos y Curiosidades
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
        console.log('✅ DB Lista (Articulos + Curiosidades) - Familia MXL');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR 2.5 - FOCO TOTAL EN EL TÍTULO
// ============================================================
let contentModel = null;
async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        console.log("✅ MOTOR MXL 2.5 ACTIVO - EL TÍTULO MANDA");
    }
}

// ============================================================
// PILOTO AUTOMÁTICO - CADA 40 MINUTOS
// ============================================================
async function publicarCuriosidadViral() {
    if (!contentModel) return;
    console.log('⏰ [CRON] Generando curiosidad de lujo automática...');
    try {
        const prompt = "Genera una curiosidad viral de lujo extremo para millonarias en NYC. Responde SOLO JSON: {\"titulo_es\": \"...\", \"texto_es\": \"...\"}";
        const result = await contentModel.generateContent(prompt);
        const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
        
        const id = Date.now();
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [id, data.titulo_es, data.texto_es, 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg', new Date().toISOString()]);
        
        console.log(`✨ [AUTO] Publicado: ${data.titulo_es}`);
    } catch (e) { console.error('❌ Error en Piloto Automático:', e.message); }
}

// ============================================================
// ENDPOINTS API
// ============================================================

// Inyección Manual (Tú mandas, la IA obedece al título)
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!contentModel || !tituloReal) return res.status(400).json({ success: false, error: "Faltan datos" });

    try {
        const prompt = `Eres un experto en marketing de lujo en NYC. TEMA OBLIGATORIO: "${tituloReal}". Escribe un artículo corto y persuasivo basado ÚNICAMENTE en ese título. Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [Date.now(), "MXL"+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria, url, new Date().toISOString()]);

        res.json({ success: true, producto: copy.titulo });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Lectura de Productos
app.get('/api/productos', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

// Lectura de Curiosidades (IMPORTANTE PARA EL FRONTEND)
app.get('/api/curiosidades', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// LANZAMIENTO
// ============================================================
async function start() {
    await initDB();
    await initGemini();
    
    // Programar cada 40 minutos
    cron.schedule('*/40 * * * *', () => publicarCuriosidadViral());
    
    // Publicar una al arrancar (espera 20 seg por seguridad)
    setTimeout(() => publicarCuriosidadViral(), 20000);

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 MXL 2.5 - MOTOR COMPLETO v4.6 - PUERTO ${PORT}`);
    });
}
start();
