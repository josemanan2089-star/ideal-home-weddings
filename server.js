const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
// REGLA DE ORO: Railway define el puerto dinámicamente
const PORT = process.env.PORT || 8080;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONFIGURACIÓN POSTGRESQL - PROTOCOLO MXL v3.2
// ============================================================
let db = null;
let useDatabase = false;

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('📁 DATABASE_URL no configurada, usando JSON fallback');
        return false;
    }
    try {
        db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await db.query('SELECT NOW()');
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY,
                asin VARCHAR(20),
                titulo TEXT NOT NULL,
                meta TEXT,
                intro TEXT,
                curiosidad TEXT,
                contenido TEXT,
                imagen TEXT,
                categoria VARCHAR(100),
                link TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                clicks INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY,
                titulo_es TEXT,
                texto_es TEXT,
                imagen TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS estadisticas (
                clave VARCHAR(50) PRIMARY KEY,
                valor JSONB NOT NULL
            );
        `);
        
        console.log('✅ Tablas PostgreSQL listas (Mando MXL v3.2)');
        useDatabase = true;
        return true;
    } catch (err) {
        console.error('❌ Error PostgreSQL:', err.message);
        return false;
    }
}

// ============================================================
// MOTORES GEMINI
// ============================================================
let contentModel = null;
let isContentAvailable = false;

async function initGemini() {
    const cKey = process.env.GEMINI_API_KEY_CONTENT;
    if (cKey) {
        const genAI = new GoogleGenerativeAI(cKey.trim());
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        isContentAvailable = true;
    }
}

// ============================================================
// PILOTO AUTOMÁTICO - CADA 40 MINUTOS
// ============================================================
async function publicarCuriosidadViral() {
    console.log('⏰ [CRON] Ejecutando publicación automática...');
    if (!isContentAvailable || !useDatabase) return;
    try {
        const prompt = "Genera una curiosidad viral de lujo para mujeres en NYC. Responde solo JSON: {\"titulo_es\": \"...\", \"texto_es\": \"...\"}";
        const result = await contentModel.generateContent(prompt);
        const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
        
        const nueva = {
            id: Date.now(),
            titulo_es: data.titulo_es,
            texto_es: data.texto_es,
            imagen: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
            fecha: new Date().toISOString()
        };
        
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [nueva.id, nueva.titulo_es, nueva.texto_es, nueva.imagen, nueva.fecha]);
        console.log('✅ [CRON] Publicada con éxito');
    } catch (e) { console.error('❌ [CRON] Error:', e.message); }
}

// ============================================================
// ENDPOINTS API
// ============================================================

// 🛡️ ENDPOINT DE VIDA (HEALTHCHECK) - Esto arregla el error de Railway
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        mxl_protocol: 'v3.2', 
        database: useDatabase ? 'connected' : 'disconnected' 
    });
});

app.get('/api/productos', async (req, res) => {
    if (!useDatabase) return res.json([]);
    const resDb = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
    res.json(resDb.rows);
});

app.get('/api/curiosidades', async (req, res) => {
    if (!useDatabase) return res.json([]);
    const result = await db.query(`SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50`);
    res.json(result.rows);
});

app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria } = req.body;
    if (!url || !imagenUrl || !useDatabase) return res.status(400).json({ success: false });

    const articulo = {
        id: Date.now(),
        asin: "AMZ" + Date.now(),
        titulo: "Luxury Item " + Date.now(),
        meta: "Exclusive luxury item",
        intro: "Discover excellence",
        curiosidad: "Limited edition",
        contenido: "Content coming soon",
        imagen: imagenUrl,
        categoria: categoria || 'LUXURY',
        link: url,
        fecha: new Date().toISOString()
    };

    try {
        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, clicks, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [articulo.id, articulo.asin, articulo.titulo, articulo.meta, articulo.intro, articulo.curiosidad, articulo.contenido, articulo.imagen, articulo.categoria, articulo.link, 0, articulo.fecha]);
        res.json({ success: true, producto: articulo.titulo });
    } catch(e) { res.status(500).json({ success: false }); }
});

// ============================================================
// LANZAMIENTO
// ============================================================
async function start() {
    await initDatabase();
    await initGemini();
    
    cron.schedule('*/40 * * * *', () => publicarCuriosidadViral());
    setTimeout(() => publicarCuriosidadViral(), 5000);

    // ESCUCHAR EN 0.0.0.0 y el PORT dinámico es vital para Railway
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 COMMANDER MXL v3.2 ACTIVO - PUERTO ${PORT}`);
    });
}
start();
