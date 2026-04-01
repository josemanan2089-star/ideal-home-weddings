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
// POSTGRESQL - PROTOCOLO MXL v4.2 (MOTOR 2.5)
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
// MOTOR GEMINI 2.5 - LA ÚLTIMA GENERACIÓN (GRABADO: 1.5 ROJO)
// ============================================================
let contentModel = null;

async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        // 🚀 MXL: Motor 2.5 Flash - Potencia pura para NYC
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        console.log("✅ MOTOR MXL: gemini-2.5-flash ACTIVADO");
    }
}

// ============================================================
// PILOTO AUTOMÁTICO (CURIOSIDADES CADA 40 MINUTOS)
// ============================================================
async function publicarCuriosidad() {
    if (!contentModel) return;
    console.log('⏰ [CRON] Generando Secreto de Lujo Automático...');
    try {
        const prompt = "Genera una curiosidad viral de lujo extremo para mujeres millonarias en NYC. Responde SOLO JSON: {\"titulo_es\": \"...\", \"texto_es\": \"...\"}";
        const result = await contentModel.generateContent(prompt);
        const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
        
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [Date.now(), data.titulo_es, data.texto_es, 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg', new Date().toISOString()]);
        
        console.log(`✨ [MXL 2.5] Publicado: ${data.titulo_es}`);
    } catch (e) { console.error('❌ Error Motor CRON:', e.message); }
}

// ============================================================
// ENDPOINTS API - SINCRONIZADOS CON EL FRONTEND
// ============================================================

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', mxl: 'v4.2', engine: '2.5-flash' }));

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

// 🎯 COMMANDER MXL: INYECCIÓN MANUAL BLINDADA
app.post('/api/commander/inject', async (req, res) => {
    // IMPORTANTE: Envía 'tituloReal' desde el panel para que no alucine con gomas de carro
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    
    if (!url || !imagenUrl || !contentModel) return res.status(400).json({ success: false });

    console.log(`🎯 [INYECCIÓN MXL] Procesando: ${tituloReal || 'Producto de Lujo'}`);
    try {
        const prompt = `Eres un redactor de lujo para la clase alta de Manhattan. 
        Analiza este producto: "${tituloReal || 'Producto Exclusivo'}".
        URL: ${url}.
        
        INSTRUCCIÓN: Crea un copy de venta sofisticado. 
        - Si es una cama, enfócate en el descanso real y exclusividad.
        - Si es electrodoméstico, en eficiencia gourmet.
        - NO hables de neumáticos ni Navidad si el producto no lo es.
        
        Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, clicks, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
        `, [Date.now(), "MXL"+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria || 'LUXURY', url, new Date().toISOString()]);

        console.log(`✅ [MXL] Inyectado Correctamente: ${copy.titulo}`);
        res.json({ success: true, producto: copy.titulo });
    } catch (e) { 
        console.error('❌ Error Inyección:', e.message);
        res.status(500).json({ success: false }); 
    }
});

// Servir Frontend
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// LANZAMIENTO
// ============================================================
async function start() {
    console.log("🚀 Iniciando Protocolo MXL v4.2...");
    await initDB();
    await initGemini();
    
    // Piloto automático: Cada 40 minutos
    cron.schedule('*/40 * * * *', () => publicarCuriosidad());
    
    // Publicación inicial después de 25 segundos para cuidar la cuota
    setTimeout(() => publicarCuriosidad(), 25000);

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 SERVIDOR MXL v4.2 - MOTOR 2.5 ACTIVO EN PUERTO ${PORT}`);
    });
}
start();
