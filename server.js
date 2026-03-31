const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares básicos
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir archivos estáticos después de montar las rutas API
// para evitar conflictos

// Directorios persistentes para Railway
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');

// Crear directorio y archivos iniciales
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Directorio creado: ${DATA_DIR}`);
}

const initFile = (filePath, defaultData) => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
        console.log(`📄 Archivo creado: ${path.basename(filePath)}`);
    }
};

initFile(ARTICULOS_PATH, []);
initFile(CURIOSIDADES_PATH, []);
initFile(ESTADISTICAS_PATH, {
    totalClics: 0,
    clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
    curiosidadesGeneradas: 0,
    ultimaActualizacion: new Date().toISOString()
});

// Gemini Configuration
let genAI = null;
let model = null;
let isGeminiAvailable = false;
let modeloUsado = 'none';

const initGemini = async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey || apiKey === 'tu_api_key_aqui' || apiKey === '') {
        console.log('⚠️ GEMINI_API_KEY no configurada');
        return false;
    }
    
    try {
        genAI = new GoogleGenerativeAI(apiKey);
        
        // Probar modelos en orden
        const modelos = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash'];
        
        for (const modelName of modelos) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                // Prueba simple con timeout
                const result = await Promise.race([
                    testModel.generateContent('ping'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                ]);
                
                if (result && result.response) {
                    model = testModel;
                    modeloUsado = modelName;
                    isGeminiAvailable = true;
                    console.log(`✅ Gemini activado: ${modeloUsado}`);
                    return true;
                }
            } catch (e) {
                console.log(`⚠️ ${modelName} no disponible: ${e.message}`);
            }
        }
        
        console.log('❌ No se pudo activar Gemini');
        return false;
    } catch (e) {
        console.log('❌ Error inicializando Gemini:', e.message);
        return false;
    }
};

// Helper functions
function extraerASIN(url) {
    if (!url) return null;
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i,
        /\/dp\/([A-Z0-9]{10})/i
    ];
    for (const p of patterns) {
        const match = url.match(p);
        if (match && match[1]) return match[1];
    }
    return null;
}

// Sistema de adaptación de ventas
let anguloVentaActual = 'A';
const historialClics = { A: [], B: [], C: [], D: [] };

function actualizarAnguloVenta() {
    const ahora = Date.now();
    const hace24h = ahora - 86400000;
    
    let mejorAngulo = 'A';
    let maxClics = -1;
    
    for (const [angulo, timestamps] of Object.entries(historialClics)) {
        const clics = timestamps.filter(ts => ts > hace24h).length;
        if (clics > maxClics) {
            maxClics = clics;
            mejorAngulo = angulo;
        }
    }
    
    if (maxClics === 0) {
        const angulos = ['A', 'B', 'C', 'D'];
        const idx = angulos.indexOf(anguloVentaActual);
        mejorAngulo = angulos[(idx + 1) % angulos.length];
    }
    
    anguloVentaActual = mejorAngulo;
    return anguloVentaActual;
}

const angulosDesc = {
    'A': 'ESTATUS PURO',
    'B': 'FOMO',
    'C': 'BIO-HACKING',
    'D': 'INVERSIÓN'
};

const angulosPrompt = {
    'A': 'Ángulo ESTATUS: exclusividad, lujo silencioso, "el secreto que no cuentan"',
    'B': 'Ángulo FOMO: escasez, urgencia, "solo quedan pocas unidades"',
    'C': 'Ángulo BIO-HACKING: salud, optimización, "rutina de alto rendimiento"',
    'D': 'Ángulo INVERSIÓN: valor patrimonial, "activo que no deprecia"'
};

// Temas SEO
const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury", kw_en: "luxury home spa bathroom ideas" },
    { tema: "luxury kitchen appliances women NYC", kw_en: "luxury kitchen appliances NYC women" },
    { tema: "minimalist luxury bedroom decor 2026", kw_en: "minimalist luxury bedroom 2026" },
    { tema: "smart home automation Beverly Hills", kw_en: "smart home automation Beverly Hills" },
    { tema: "luxury home office women entrepreneur", kw_en: "luxury home office women 2026" },
    { tema: "luxury outdoor living Miami terrace", kw_en: "luxury outdoor living Miami" },
    { tema: "smart mirror beauty luxury women", kw_en: "smart mirror luxury beauty women" }
];

// Imágenes de respaldo
const imagenesRespaldo = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
    'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
    'https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg',
    'https://images.pexels.com/photos/258154/pexels-photo-258154.jpeg',
    'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg',
    'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
    'https://images.pexels.com/photos/1648772/pexels-photo-1648772.jpeg',
    'https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg',
    'https://images.pexels.com/photos/1571459/pexels-photo-1571459.jpeg',
    'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg'
];

async function obtenerImagen(query) {
    const idx = Math.floor(Math.random() * imagenesRespaldo.length);
    return {
        url: imagenesRespaldo[idx],
        fuente: 'respaldo',
        alt: query || 'luxury home'
    };
}

// Generar curiosidad con Gemini
async function generarCuriosidadConGemini() {
    const angulo = actualizarAnguloVenta();
    const temaIdx = Math.floor(Date.now() / 3600000) % TEMAS_SEO.length;
    const tema = TEMAS_SEO[temaIdx];
    const porcentaje = Math.floor(Math.random() * 35 + 60);
    
    const fallback = {
        titulo_es: `El ${porcentaje}% de mujeres en NYC ya conoce este secreto de lujo`,
        titulo_en: `Best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026`,
        texto_es: `Descubre por qué el ${porcentaje}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo en este elemento exclusivo. ¿Ya eres de las que saben?`,
        texto_en: `Discover why ${porcentaje}% of high-income women in Manhattan are investing in this exclusive element.`,
        meta_descripcion_en: `Discover the best luxury home products 2026. What NYC women are buying.`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus. Ese acabado es el nuevo lujo silencioso.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status.",
        productoSugerido: tema.tema.split(' ')[0] + ' luxury product',
        anguloUsado: angulo
    };
    
    if (!isGeminiAvailable || !model) return fallback;
    
    try {
        const prompt = `Eres experto en marketing de lujo para mujeres de NYC, Miami, Beverly Hills.
Genera una curiosidad viral con este ángulo: ${angulosPrompt[angulo]}

TEMA: ${tema.tema}
KEYWORD EN: ${tema.kw_en}

RESPONDE SOLO CON JSON (sin markdown):
{
    "titulo_es": "Título en español con número impactante",
    "titulo_en": "Title in English with keyword",
    "texto_es": "Texto persuasivo en español 2-3 oraciones",
    "texto_en": "Persuasive text in English 2-3 sentences",
    "meta_descripcion_en": "Meta description 155 chars",
    "descripcion_visual_es": "Descripción sensorial en español",
    "descripcion_visual_en": "Sensory description in English",
    "productoSugerido": "Tipo específico de producto Amazon"
}`;
        
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        return {
            titulo_es: data.titulo_es || fallback.titulo_es,
            titulo_en: data.titulo_en || fallback.titulo_en,
            texto_es: data.texto_es || fallback.texto_es,
            texto_en: data.texto_en || fallback.texto_en,
            meta_descripcion_en: data.meta_descripcion_en || fallback.meta_descripcion_en,
            descripcion_visual_es: data.descripcion_visual_es || fallback.descripcion_visual_es,
            descripcion_visual_en: data.descripcion_visual_en || fallback.descripcion_visual_en,
            productoSugerido: data.productoSugerido || fallback.productoSugerido,
            anguloUsado: angulo
        };
    } catch (e) {
        console.log('⚠️ Error generando curiosidad con Gemini:', e.message);
        return fallback;
    }
}

// Publicar curiosidad
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando curiosidad...');
    
    try {
        const g = await generarCuriosidadConGemini();
        const img = await obtenerImagen(g.productoSugerido);
        
        const nueva = {
            id: Date.now(),
            titulo_es: g.titulo_es,
            titulo_en: g.titulo_en,
            texto_es: g.texto_es,
            texto_en: g.texto_en,
            meta_descripcion_en: g.meta_descripcion_en,
            descripcion_visual_es: g.descripcion_visual_es,
            descripcion_visual_en: g.descripcion_visual_en,
            imagen: img.url,
            imagenFuente: img.fuente,
            productoSugerido: g.productoSugerido,
            anguloUsado: g.anguloUsado,
            fecha: new Date().toISOString(),
            compartidas: 0
        };
        
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(nueva);
        if (data.length > 50) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.curiosidadesGeneradas++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        
        console.log(`✅ Publicada: "${nueva.titulo_en}"`);
        return nueva;
    } catch (e) {
        console.log('❌ Error publicando curiosidad:', e.message);
        return null;
    }
}

// Generar copy producto
async function generarCopyProducto(url, imagenUrl, categoria) {
    const fallback = {
        titulo: "Best Luxury Home Investment 2026",
        meta_descripcion: "Discover why NYC women are investing in this luxury home product.",
        intro: "The one detail interior designers can't stop recommending.",
        descripcion_visual: "Clean lines and elegant design that transforms any space.",
        problema: "Your home feels like it's missing something.",
        solucion: "This piece makes everything around it feel more considered.",
        beneficio_estatus: "Let your space speak for you.",
        prueba_social: "Gabriela from Miami: 'My designer was impressed.'",
        cierre: "This design won't wait.",
        curiosidad: "Interior designers report 150% increase in signature pieces.",
        palabras_clave: ["luxury home 2026", "best investment", "NYC lifestyle"]
    };
    
    if (!isGeminiAvailable || !model) return fallback;
    
    try {
        const prompt = `Genera copy de lujo para Amazon Affiliate. URL: ${url}. Responde con JSON: titulo, meta_descripcion, intro, descripcion_visual, problema, solucion, beneficio_estatus, prueba_social, cierre, curiosidad, palabras_clave.`;
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        console.log('⚠️ Error generando copy:', e.message);
        return fallback;
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${copy.titulo}</title>
    <meta name="description" content="${copy.meta_descripcion}">
    <meta name="keywords" content="${(copy.palabras_clave || []).join(', ')}">
    <meta property="og:image" content="${imagenUrl}">
    <link rel="canonical" href="${url}">
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:system-ui,sans-serif;background:#fffaf7;color:#1a1a1a;line-height:1.6;}
        .hero{background:linear-gradient(135deg,#1a1a2e,#2d2d44);padding:60px 20px;text-align:center;}
        .hero h1{font-size:2rem;color:#fff;max-width:800px;margin:0 auto;}
        .article-body{max-width:800px;margin:0 auto;padding:40px 20px;}
        .btn-buy{display:block;background:#ff4500;color:#fff;padding:16px 30px;text-decoration:none;border-radius:50px;text-align:center;margin:30px 0;font-weight:bold;}
        .btn-buy:hover{background:#ff6b35;}
        .social-proof{background:#fff;border-left:4px solid #ff4500;padding:20px;margin:30px 0;}
        img{max-width:100%;border-radius:12px;margin:20px 0;}
        footer{text-align:center;padding:30px;font-size:12px;border-top:1px solid #eee;}
        @media(max-width:600px){.hero h1{font-size:1.4rem}}
    </style>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
    </div>
    <div class="article-body">
        <p><strong>✨ ${copy.curiosidad}</strong></p>
        <p>${copy.intro}</p>
        <img src="${imagenUrl}" alt="${copy.titulo}">
        <p>${copy.descripcion_visual}</p>
        <p><strong>${copy.problema}</strong></p>
        <p>${copy.solucion}</p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow">🔴 VER PRECIO EN AMAZON →</a>
        <p><em>${copy.beneficio_estatus}</em></p>
        <div class="social-proof">
            "${copy.prueba_social}"
        </div>
        <p><strong>${copy.cierre}</strong></p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow">🔥 COMPRAR EN AMAZON →</a>
        <footer>As an Amazon Associate we earn from qualifying purchases. © 2026 MXL GOLD MINER</footer>
    </div>
</body>
</html>`;
}

// ENDPOINTS API
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        gemini: isGeminiAvailable ? 'active' : 'inactive',
        modelo: modeloUsado,
        uptime: process.uptime()
    });
});

app.get('/api/curiosidades', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const c = await publicarCuriosidadAutomatica();
        res.json({ success: true, curiosidad: c });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const filtered = data.filter(c => c.id != req.params.id);
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(filtered, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/curiosidades/all', (req, res) => {
    try {
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/generar-copy-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria } = req.body;
        if (!url) return res.status(400).json({ success: false, error: 'URL requerida' });
        const copy = await generarCopyProducto(url, imagenUrl, categoria);
        res.json({ success: true, copy });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/publicar-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, imageSize, imagePosition, copy } = req.body;
        if (!url || !imagenUrl || !copy) {
            return res.status(400).json({ success: false, error: 'Faltan datos' });
        }
        
        const html = generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy);
        const art = {
            id: Date.now(),
            asin: extraerASIN(url),
            titulo: copy.titulo,
            meta: copy.meta_descripcion,
            intro: copy.intro,
            curiosidad: copy.curiosidad,
            contenido: html,
            imagen: imagenUrl,
            categoria: categoria || 'LUXURY',
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0
        };
        
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(art);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true, articulo: art });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/articulos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(req.body.articulos, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) {
            data[i].clicks = (data[i].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            
            const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
            stats.totalClics++;
            stats.ultimaActualizacion = new Date().toISOString();
            fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.get('/api/estadisticas', (req, res) => {
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        res.json({
            ...stats,
            anguloActual: anguloVentaActual,
            descripcionAngulo: angulosDesc[anguloVentaActual],
            geminiDisponible: isGeminiAvailable,
            modeloGemini: modeloUsado
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/api/gemini-status', (req, res) => {
    res.json({
        hasKey: !!process.env.GEMINI_API_KEY,
        isWorking: isGeminiAvailable,
        modeloUsado: modeloUsado
    });
});

// Servir archivos estáticos AL FINAL para no interferir con las rutas API
app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// CRON cada 3 horas
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ CRON: Generando curiosidad programada...');
    await publicarCuriosidadAutomatica();
});

// Iniciar servidor con manejo de errores
const startServer = async () => {
    try {
        await initGemini();
        
        // Generar primera curiosidad si no hay ninguna
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        if (curiosidades.length === 0) {
            console.log('📝 Generando primera curiosidad...');
            setTimeout(() => publicarCuriosidadAutomatica(), 3000);
        }
        
        app.listen(PORT, '0.0.0.0', () => {
            const art = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
            const cur = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
            const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
            
            console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🏮 MXL GOLD MINER — SISTEMA LISTO 🏮              ║
╠══════════════════════════════════════════════════════════════╣
║  🤖 GEMINI: ${isGeminiAvailable ? `✅ ACTIVADO (${modeloUsado})` : '⚠️ NO DISPONIBLE'}${' '.repeat(30 - (isGeminiAvailable ? modeloUsado.length + 12 : 16))}║
║  🎯 Ángulo actual: ${angulosDesc[anguloVentaActual]}${' '.repeat(45 - angulosDesc[anguloVentaActual].length)}║
║  💎 Curiosidades: ${cur} guardadas | ${stats.curiosidadesGeneradas} generadas${' '.repeat(20)}║
║  💰 Productos: ${art} publicados | ${stats.totalClics} clics totales${' '.repeat(25)}║
║  🚀 Puerto: ${PORT}${' '.repeat(48)}║
║  📁 Datos: ${DATA_DIR}${' '.repeat(45 - DATA_DIR.length)}║
╚══════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (error) {
        console.error('❌ Error al iniciar servidor:', error);
        process.exit(1);
    }
};

startServer();
