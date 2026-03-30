const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const DB_PATH = path.join(__dirname, 'productos.json');
const SCHEDULE_PATH = path.join(__dirname, 'schedule.json');

// Inicializar archivos
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

if (!fs.existsSync(SCHEDULE_PATH)) {
    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify({
        enabled: true,
        schedule: '0 */4 * * *', // Cada 4 horas
        lastRun: null,
        nextRun: null
    }));
}

// ============ FUNCIÓN PARA GENERAR CONTENIDO CON GEMINI ============
async function generarContenidoConGemini(url, customOptions = {}) {
    try {
        // Extraer ASIN de Amazon
        let asin = '';
        const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
        if (asinMatch) asin = asinMatch[1];
        
        // Lista de productos de ejemplo para rotación (si no hay URL)
        const productosEjemplo = [
            { url: 'https://amazon.com/dp/B0C3H7K2X1', name: 'Smart Composter' },
            { url: 'https://amazon.com/dp/B09Y2X8W4V', name: 'Air Purifier' },
            { url: 'https://amazon.com/dp/B08K7J5H3G', name: 'Smart Mirror' },
            { url: 'https://amazon.com/dp/B07M9N2P4R', name: 'Robot Vacuum' }
        ];
        
        // Prompt mejorado para Gemini con enfoque en mujeres y CTR
        const prompt = `
        Actúa como experta en copywriting de lujo para revista de hogar dirigida a mujeres de alto poder adquisitivo en USA (NYC, Miami, Beverly Hills).
        
        Producto: ${asin ? `ASIN ${asin} de Amazon` : 'Producto premium para el hogar'}
        
        Genera contenido en formato JSON con:
        {
            "title_en": "Título corto magnético (max 60 caracteres) que hable de estatus, tecnología invisible o lujo silencioso",
            "title_es": "Título en español igual de magnético",
            "curiosity_en": "Una curiosidad impactante sobre el mercado de lujo en USA que enganche al lector (1-2 oraciones). Ejemplo: 'Did you know that 73% of Manhattan elites now prioritize zero-waste status symbols?'",
            "curiosity_es": "Misma curiosidad en español",
            "description_en": "Descripción seductora que mezcla estatus, tecnología y beneficio emocional. Terminar con llamado a la acción. (3-4 oraciones)",
            "description_es": "Descripción en español",
            "seo_keywords": ["palabra1", "palabra2", "palabra3", "palabra4"]
        }
        
        REGLAS IMPORTANTES:
        - Tono: aspiracional, sofisticado, como revista Vogue o Architectural Digest
        - Enfoque: mujeres que planean bodas, decoran su hogar, buscan estatus
        - Palabras clave: silent luxury, wedding registry, status symbol, smart home, zero-waste
        - Siempre incluir un dato de impacto (estadística o tendencia de USA)
        - Hacer que la curiosidad genere FOMO (Fear Of Missing Out)
        `;
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Limpiar y parsear JSON
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const iaContent = JSON.parse(cleanJson);
        
        // Imagen automática si no hay URL
        const imagenUrl = customOptions.image || 
            (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : 
            'https://via.placeholder.com/400x300?text=Luxury+Home+Essential');
        
        return {
            id: Date.now(),
            asin: asin,
            title_en: iaContent.title_en,
            title_es: iaContent.title_es,
            curiosity_en: iaContent.curiosity_en,
            curiosity_es: iaContent.curiosity_es,
            description_en: iaContent.description_en,
            description_es: iaContent.description_es,
            image: imagenUrl,
            imageSize: customOptions.imageSize || 'medium',
            imagePosition: customOptions.imagePosition || 'center',
            link: url,
            seo_keywords: iaContent.seo_keywords || [],
            fecha: new Date().toISOString(),
            views: 0,
            clicks: 0,
            scheduled: customOptions.scheduled || false
        };
        
    } catch (error) {
        console.error('Error Gemini:', error);
        // Contenido de respaldo si Gemini falla
        return {
            id: Date.now(),
            title_en: '✨ The New Silent Luxury Essential',
            title_es: '✨ El Nuevo Esencial de Lujo Silencioso',
            curiosity_en: 'Did you know that luxury home automation is now the #1 status symbol among NYC elites?',
            curiosity_es: '¿Sabías que la automatización del hogar es ahora el símbolo de estatus #1 entre las elites de NYC?',
            description_en: 'Elevate your home with this carefully curated essential. Perfect for the discerning couple planning their dream wedding registry.',
            description_es: 'Eleva tu hogar con este esencial cuidadosamente seleccionado. Perfecto para la pareja exigente que planea su lista de bodas de ensueño.',
            image: 'https://via.placeholder.com/400x300?text=Luxury+Home',
            link: url,
            fecha: new Date().toISOString(),
            views: 0,
            clicks: 0
        };
    }
}

// ============ PUBLICACIÓN AUTOMÁTICA PROGRAMADA ============
async function publicarProductoAutomatico() {
    console.log('🤖 Ejecutando publicación automática programada...');
    
    // Lista de productos de ejemplo para publicar automáticamente
    const productosProgramados = [
        'https://amazon.com/dp/B0C3H7K2X1', // Smart Composter
        'https://amazon.com/dp/B09Y2X8W4V', // Air Purifier
        'https://amazon.com/dp/B08K7J5H3G', // Smart Mirror
        'https://amazon.com/dp/B07M9N2P4R', // Robot Vacuum
        'https://amazon.com/dp/B0B5Z9L3W7', // Smart Lock
        'https://amazon.com/dp/B0A8K4M2N6'  // Smart Lighting
    ];
    
    // Seleccionar un producto aleatorio
    const urlAleatoria = productosProgramados[Math.floor(Math.random() * productosProgramados.length)];
    
    try {
        const nuevoProducto = await generarContenidoConGemini(urlAleatoria, {
            scheduled: true,
            imageSize: ['small', 'medium', 'large'][Math.floor(Math.random() * 3)],
            imagePosition: ['left', 'center', 'right'][Math.floor(Math.random() * 3)]
        });
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(nuevoProducto);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        
        // Actualizar schedule.json
        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH));
        schedule.lastRun = new Date().toISOString();
        schedule.nextRun = calcularProximaEjecucion(schedule.schedule);
        fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2));
        
        console.log(`✅ Publicación automática completada: ${nuevoProducto.title_en}`);
        console.log(`📊 Total productos: ${data.length}`);
        
    } catch (error) {
        console.error('❌ Error en publicación automática:', error);
    }
}

function calcularProximaEjecucion(cronExpression) {
    // Simplificado - en producción usaría cron-parser
    const next = new Date();
    next.setHours(next.getHours() + 4);
    return next.toISOString();
}

// ============ KEEP-AWAKE: Evitar que Railway duerma ============
let keepAliveInterval;

function startKeepAlive() {
    // Ping cada 4 minutos (menos de 5 minutos de Railway)
    keepAliveInterval = setInterval(async () => {
        try {
            const response = await axios.get(`http://localhost:${PORT}/health`);
            console.log(`💓 Keep-alive ping: ${response.status} - ${new Date().toISOString()}`);
        } catch (error) {
            console.log(`💓 Keep-alive ping falló pero continuamos...`);
        }
    }, 240000); // 4 minutos
}

// ============ CRON: Publicación automática programada ============
function startScheduledPosts() {
    const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH));
    
    if (schedule.enabled) {
        // Programar publicación cada 4 horas
        cron.schedule('0 */4 * * *', async () => {
            console.log('⏰ CRON: Ejecutando publicación programada...');
            await publicarProductoAutomatico();
        });
        
        console.log('✅ Sistema de publicación automática ACTIVADO (cada 4 horas)');
        
        // Ejecutar una vez al inicio si no hay productos
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        if (data.length === 0) {
            console.log('📦 No hay productos, publicando uno inicial...');
            setTimeout(() => publicarProductoAutomatico(), 5000);
        }
    } else {
        console.log('⚠️ Sistema de publicación automática DESACTIVADO');
    }
}

// ============ ENDPOINTS DE LA API ============

// Health check para Railway
app.get('/health', (req, res) => {
    const data = JSON.parse(fs.readFileSync(DB_PATH));
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        productos: data.length,
        memory: process.memoryUsage()
    });
});

// RUTAS PRINCIPALES
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/mxl-panel-2026.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mxl-panel-2026.html'));
});

// PUBLICAR CON IA (manual desde panel)
app.post('/api/publicar-con-ia', async (req, res) => {
    try {
        const { url, customImage, imageSize, imagePosition } = req.body;
        
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        const nuevoProducto = await generarContenidoConGemini(url, {
            image: customImage,
            imageSize: imageSize || 'medium',
            imagePosition: imagePosition || 'center',
            scheduled: false
        });
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(nuevoProducto);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        
        res.json({ success: true, producto: nuevoProducto });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// EDITAR PRODUCTO
app.put('/api/editar-producto/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const index = data.findIndex(p => p.id == id);
        
        if (index !== -1) {
            data[index] = { ...data[index], ...updates };
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
            res.json({ success: true, producto: data[index] });
        } else {
            res.status(404).json({ success: false, error: 'Producto no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// CONTADOR DE CLICKS
app.post('/api/click/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const index = data.findIndex(p => p.id == id);
        if (index !== -1) {
            data[index].clicks = (data[index].clicks || 0) + 1;
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// OBTENER TODOS LOS PRODUCTOS
app.get('/api/productos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

// OBTENER ESTADO DEL SISTEMA
app.get('/api/system-status', (req, res) => {
    const data = JSON.parse(fs.readFileSync(DB_PATH));
    const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH));
    
    res.json({
        productos: data.length,
        clicksTotales: data.reduce((sum, p) => sum + (p.clicks || 0), 0),
        ultimaPublicacion: data[0]?.fecha || null,
        schedule: schedule,
        uptime: process.uptime()
    });
});

// CONFIGURAR SCHEDULE (desde panel)
app.post('/api/config-schedule', (req, res) => {
    try {
        const { enabled, schedule } = req.body;
        const scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_PATH));
        
        if (enabled !== undefined) scheduleData.enabled = enabled;
        if (schedule) scheduleData.schedule = schedule;
        
        fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleData, null, 2));
        res.json({ success: true, schedule: scheduleData });
        
        console.log(`📅 Schedule actualizado: ${scheduleData.enabled ? 'ACTIVADO' : 'DESACTIVADO'} - ${scheduleData.schedule}`);
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ INICIAR SERVIDOR ============
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     🏮 MXL GOLD MINER - SISTEMA PREMIUM 🏮       ║
    ╠══════════════════════════════════════════════════╣
    ║  🚀 Servidor: http://localhost:${PORT}            ║
    ║  📊 Health Check: /health                        ║
    ║  ✨ Panel Editor: /mxl-panel-2026.html           ║
    ║  🤖 Gemini: ACTIVADO                             ║
    ║  ⏰ Auto-Publicación: CADA 4 HORAS              ║
    ║  💓 Keep-Alive: ACTIVADO (cada 4 min)           ║
    ╚══════════════════════════════════════════════════╝
    `);
    
    // Iniciar sistemas
    startKeepAlive();
    startScheduledPosts();
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
    console.log('🛑 Recibido SIGTERM, cerrando servidor...');
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    server.close(() => process.exit(0));
});
