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
// POSTGRESQL - PROTOCOLO MXL v3.5 ULTIMATE
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
// MOTOR GEMINI - 2.0 FLASH LITE (EL SUCESOR DEL 1.5)
// ============================================================
let contentModel = null;

async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        // Grabado: El 1.5 murió. Usamos Flash Lite 2.0 para evitar el error 429.
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
        console.log("✅ MOTOR MXL: gemini-2.0-flash-lite ACTIVADO");
    }
}

// ============================================================
// PILOTO AUTOMÁTICO (CADA 40 MINUTOS)
// ============================================================
async function publicarCuriosidad() {
    if (!contentModel) return;
    console.log('⏰ [CRON] Generando Secreto de Lujo Automático...');
    try {
        const prompt = "Genera una curiosidad viral de lujo para mujeres millonarias en USA (NYC/Miami). Responde SOLO JSON: {\"titulo_es\": \"...\", \"texto_es\": \"...\"}";
        const result = await contentModel.generateContent(prompt);
        const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
        
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [Date.now(), data.titulo_es, data.texto_es, 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg', new Date().toISOString()]);
        
        console.log(`✨ [MXL] Publicado: ${data.titulo_es}`);
    } catch (e) { console.error('❌ Error Motor CRON:', e.message); }
}

// ============================================================
// ENDPOINTS API - SINCRONIZADOS CON INDEX.HTML
// ============================================================

// 🛡️ HEALTHCHECK PARA RAILWAY
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', mxl: 'v3.5' }));

// Obtener Productos para la Web
app.get('/api/productos', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

// Obtener Curiosidades para la Web
app.get('/api/curiosidades', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

// 🎯 COMMANDER MXL: INYECCIÓN MANUAL DE PRODUCTOS
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria } = req.body;
    if (!url || !imagenUrl || !contentModel) return res.status(400).json({ success: false });

    console.log(`🎯 [INYECCIÓN MXL] Procesando producto de Amazon...`);
    try {
        const prompt = `Genera un copy de venta premium para este producto de lujo. URL: ${url}. Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        const articulo = {
            id: Date.now(),
            asin: "MXL" + Date.now(),
            titulo: copy.titulo,
            meta: copy.meta,
            curiosidad: copy.curiosidad,
            imagen: imagenUrl,
            categoria: categoria || 'LUXURY',
            link: url,
            fecha: new Date().toISOString()
        };

        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, clicks, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [articulo.id, articulo.asin, articulo.titulo, articulo.meta, articulo.curiosidad, articulo.imagen, articulo.categoria, articulo.link, 0, articulo.fecha]);

        console.log(`✅ [MXL] Inyectado con éxito: ${articulo.titulo}`);
        res.json({ success: true, producto: articulo.titulo });
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
    console.log("🚀 Iniciando Protocolo MXL v3.5...");
    await initDB();
    await initGemini();
    
    // Piloto automático: Cada 40 minutos
    cron.schedule('*/40 * * * *', () => publicarCuriosidad());
    
    // Publicación inicial a los 15 seg para seguridad de cuota
    setTimeout(() => publicarCuriosidad(), 15000);

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 SERVIDOR MXL v3.5 ACTIVO - PUERTO ${PORT}`);
    });
}
start();
