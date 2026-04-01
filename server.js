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
// DB POSTGRESQL - MANDO MXL v4.7
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
        console.log('✅ DB Lista (Tráfico Viral Activado) - Familia MXL');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR 2.5 - EL CEREBRO DEL MARKETING
// ============================================================
let contentModel = null;
async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        console.log("✅ MOTOR MXL 2.5 ACTIVO - ESTRATEGIA SEO INICIADA");
    }
}

// ============================================================
// PILOTO AUTOMÁTICO - IMÁGENES DINÁMICAS & SEO
// ============================================================
async function publicarCuriosidadViral() {
    if (!contentModel) return;
    console.log('⏰ [CRON] Generando contenido viral con imagen dinámica...');
    try {
        // Pedimos a la IA una palabra clave para la imagen (keyword)
        const prompt = `Genera una curiosidad viral de ultra-lujo para millonarias en NYC. 
        Responde ESTRICTAMENTE en JSON: 
        {"titulo_es": "...", "texto_es": "...", "keyword": "una palabra en ingles para buscar imagen de lujo"}`;
        
        const result = await contentModel.generateContent(prompt);
        const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
        
        // 🚀 TRÁFICO MXL: Imagen dinámica basada en el tema
        const keyword = data.keyword || 'luxury';
        const imagenVariada = `https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80&sig=${Date.now()}`;
        // Nota: Usamos una URL base de Unsplash con un "sig" (firma) de tiempo para que siempre sea distinta
        const imagenFinal = `https://loremflickr.com/1200/800/${keyword},luxury/all`;

        const id = Date.now();
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, fecha) VALUES ($1, $2, $3, $4, $5)`, 
        [id, data.titulo_es, data.texto_es, imagenFinal, new Date().toISOString()]);
        
        console.log(`✨ [AUTO-SEO] Publicado: ${data.titulo_es} (Tema: ${keyword})`);
    } catch (e) { console.error('❌ Error en Piloto Automático:', e.message); }
}

// ============================================================
// ENDPOINTS API - OPTIMIZADOS PARA CLICS
// ============================================================

app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!contentModel || !tituloReal) return res.status(400).json({ success: false, error: "Faltan datos" });

    console.log(`🎯 [INYECCIÓN SEO] Creando copy de ventas para: ${tituloReal}`);
    try {
        const prompt = `Eres experto en SEO y Ventas de Lujo. 
        Producto: "${tituloReal}". 
        INSTRUCCIÓN: Crea un copy que genere clics. 
        Responde SOLO JSON: {"titulo": "Título Gancho", "meta": "Descripción SEO para Google", "curiosidad": "Dato curioso del producto"}`;
        
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

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// LANZAMIENTO INTEGRAL
// ============================================================
async function start() {
    await initDB();
    await initGemini();
    
    // Publicar curiosidades cada 40 minutos para mantener el tráfico vivo
    cron.schedule('*/40 * * * *', () => publicarCuriosidadViral());
    
    // Inyección inicial para verificar que todo corre
    setTimeout(() => publicarCuriosidadViral(), 20000);

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🚀 MXL 2.5 GOLD MINER - v4.7 TRAFFIC EDITION               ║
║  🏭 CURIOSIDADES: Dinámicas (Cada 40 min)                   ║
║  📦 PRODUCTOS: SEO Blindado                                 ║
╚══════════════════════════════════════════════════════════════╝
        `);
    });
}
start();
