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

// ============================================================
// 🧠 PROTOCOLO "COMMANDER MXL" - mxl es el Único Disparador
// ============================================================
// GEMINI_API_KEY_CONTENT → Fábrica de tráfico (siempre activa)
// GEMINI_API_KEY_SALES   → MASTERMIND (Genera artículos bajo demanda)
// GEMINI_API_KEY_TRAFFIC → GENERAL (Genera hooks automáticos post-producto)
// ============================================================

let contentModel = null;
let salesModel = null;
let trafficModel = null;
let isContentAvailable = false;
let isSalesAvailable = false;
let isTrafficAvailable = false;
let contentModelName = 'none';
let salesModelName = 'none';
let trafficModelName = 'none';

// Modelos a probar en orden de prioridad
const MODELOS_PRIORIDAD = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash'];

/**
 * Inicializa un motor Gemini específico
 */
async function initGeminiMotor(apiKey, motor) {
    if (!apiKey || apiKey === 'tu_api_key_aqui' || apiKey === '') {
        console.log(`⚠️ [${motor}] API_KEY no configurada`);
        return { model: null, modelName: 'none', available: false };
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        
        for (const modelName of MODELOS_PRIORIDAD) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                const result = await Promise.race([
                    testModel.generateContent('ping'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                ]);
                
                if (result && result.response) {
                    console.log(`✅ [${motor}] ACTIVADO: ${modelName}`);
                    return { model: testModel, modelName: modelName, available: true };
                }
            } catch (e) {
                console.log(`⚠️ [${motor}] ${modelName} no disponible: ${e.message}`);
            }
        }
        
        console.log(`❌ [${motor}] No se pudo activar Gemini`);
        return { model: null, modelName: 'none', available: false };
    } catch (e) {
        console.log(`❌ [${motor}] Error inicializando: ${e.message}`);
        return { model: null, modelName: 'none', available: false };
    }
}

/**
 * Inicializa los tres motores
 */
async function initGeminiMotors() {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║   🧠 PROTOCOLO "COMMANDER MXL" - mxl = Único Disparador        ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    
    // Motor CONTENT (Fábrica de tráfico - SIEMPRE ACTIVA)
    const contentKey = process.env.GEMINI_API_KEY_CONTENT;
    console.log('🏭 MOTOR CONTENT (Fábrica de Tráfico - Ritmo constante)');
    console.log(`   🔑 Llave: ${contentKey ? `${contentKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const contentResult = await initGeminiMotor(contentKey, 'CONTENT');
    contentModel = contentResult.model;
    contentModelName = contentResult.modelName;
    isContentAvailable = contentResult.available;
    
    console.log('');
    
    // Motor SALES - MASTERMIND (Genera artículos cuando mxl ordena)
    const salesKey = process.env.GEMINI_API_KEY_SALES;
    console.log('🧠 MOTOR MASTERMIND (Ogilvy/Halbert - Bajo demanda)');
    console.log(`   🔑 Llave: ${salesKey ? `${salesKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const salesResult = await initGeminiMotor(salesKey, 'MASTERMIND');
    salesModel = salesResult.model;
    salesModelName = salesResult.modelName;
    isSalesAvailable = salesResult.available;
    
    console.log('');
    
    // Motor TRAFFIC - GENERAL (Genera hooks automáticos post-producto)
    const trafficKey = process.env.GEMINI_API_KEY_TRAFFIC;
    console.log('🚀 MOTOR TRAFFIC (Bombardeo Externo - Post-procesamiento)');
    console.log(`   🔑 Llave: ${trafficKey ? `${trafficKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const trafficResult = await initGeminiMotor(trafficKey, 'TRAFFIC');
    trafficModel = trafficResult.model;
    trafficModelName = trafficResult.modelName;
    isTrafficAvailable = trafficResult.available;
    
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('📊 ESTADO DE MOTORES - PROTOCOLO COMMANDER MXL:');
    console.log(`   🏭 CONTENT (Fábrica): ${isContentAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} - Ritmo: cada 3h`);
    console.log(`   🧠 MASTERMIND (Artículos): ${isSalesAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} - Modo: Bajo demanda`);
    console.log(`   🚀 TRAFFIC (Hooks): ${isTrafficAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} - Modo: Post-procesamiento`);
    console.log('══════════════════════════════════════════════════════════════════\n');
}

// ============================================================
// DIRECTORIOS PERSISTENTES
// ============================================================
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');
const SOCIAL_HOOKS_PATH = path.join(DATA_DIR, 'social_hooks.json');

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
    clicsPorProducto: {},
    curiosidadesGeneradas: 0,
    productosPublicados: 0,
    hooksGenerados: 0,
    ultimaActualizacion: new Date().toISOString()
});
initFile(SOCIAL_HOOKS_PATH, []);

// Ángulos de venta predefinidos
const angulosVenta = {
    'A': 'ESTATUS - Lujo Silencioso: "El secreto que solo las que saben conocen"',
    'B': 'FOMO - Escasez: "Mientras lees esto, alguien más está comprando"',
    'C': 'INVERSIÓN - Valor patrimonial: "Tu yo del futuro te lo agradecerá"'
};

let anguloActual = 'A';

// Temas SEO para CONTENT
const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury", kw_en: "luxury home spa bathroom ideas" },
    { tema: "luxury kitchen appliances women NYC", kw_en: "luxury kitchen appliances NYC women" },
    { tema: "minimalist luxury bedroom decor 2026", kw_en: "minimalist luxury bedroom 2026" },
    { tema: "smart home automation Beverly Hills", kw_en: "smart home automation Beverly Hills" }
];

// Imágenes de respaldo
const imagenesRespaldo = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
    'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
    'https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg'
];

async function obtenerImagen(query) {
    const idx = Math.floor(Math.random() * imagenesRespaldo.length);
    return { url: imagenesRespaldo[idx], fuente: 'respaldo', alt: query || 'luxury home' };
}

function extraerASIN(url) {
    if (!url) return null;
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i
    ];
    for (const p of patterns) {
        const match = url.match(p);
        if (match && match[1]) return match[1];
    }
    return null;
}

// ============================================================
// 🧠 MASTERMIND - Genera artículo completo (Ogilvy/Halbert)
// ============================================================
async function generarArticuloCompleto(url, imagenUrl, categoria) {
    const fallback = {
        titulo: "The Investment Every NYC Woman Is Making in 2026",
        meta_descripcion: "Discover why high-income women are investing in this exclusive piece.",
        intro: "There's a reason interior designers in Beverly Hills keep this one detail to themselves.",
        descripcion_visual: "The finish catches light differently. It's a statement of arrival.",
        problema: "Your home whispers when it should speak.",
        solucion: "This piece commands presence. Everything around it looks more considered.",
        beneficio_estatus: "They won't compliment the piece. They'll compliment your taste.",
        prueba_social: "Isabella from Miami: 'My decorator asked where I found it.'",
        cierre: "The women who know, know. Will you be one of them?",
        curiosidad: "Insiders say these pieces appreciate 30% within 18 months.",
        palabras_clave: ["luxury home investment 2026"]
    };
    
    if (!isSalesAvailable || !salesModel) {
        console.log('⚠️ [MASTERMIND] No disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`\n🧠 [MASTERMIND] Generando artículo para: ${url.substring(0, 50)}...`);
        
        const prompt = `Eres DAVID OGILVY + GARY HALBERT. Genera un artículo de venta para un producto de lujo.

URL: ${url}
Categoría: ${categoria}
Ángulo: ${angulosVenta[anguloActual]}

RESPONDE SOLO CON JSON:
{
    "titulo": "Título que detiene el scroll (max 60 chars)",
    "meta_descripcion": "Meta description 155 chars",
    "intro": "Gancho psicológico 1 frase",
    "descripcion_visual": "Descripción sensorial del producto",
    "problema": "El deseo inconsciente que satisface (1 frase)",
    "solucion": "Cómo lo resuelve (1 frase)",
    "beneficio_estatus": "Beneficio de estatus (1 frase)",
    "prueba_social": "Testimonio de mujer adinerada",
    "cierre": "CTA con urgencia",
    "curiosidad": "Dato exclusivo que crea FOMO",
    "palabras_clave": ["keyword1", "keyword2"]
}`;
        
        const result = await salesModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        console.log(`✅ [MASTERMIND] Artículo generado: ${data.titulo}`);
        
        return {
            titulo: data.titulo || fallback.titulo,
            meta_descripcion: data.meta_descripcion || fallback.meta_descripcion,
            intro: data.intro || fallback.intro,
            descripcion_visual: data.descripcion_visual || fallback.descripcion_visual,
            problema: data.problema || fallback.problema,
            solucion: data.solucion || fallback.solucion,
            beneficio_estatus: data.beneficio_estatus || fallback.beneficio_estatus,
            prueba_social: data.prueba_social || fallback.prueba_social,
            cierre: data.cierre || fallback.cierre,
            curiosidad: data.curiosidad || fallback.curiosidad,
            palabras_clave: data.palabras_clave || fallback.palabras_clave
        };
    } catch (e) {
        console.log(`⚠️ [MASTERMIND] Error: ${e.message}`);
        return fallback;
    }
}

// ============================================================
// 🚀 TRAFFIC - Genera hooks para el producto (Automático post-publicación)
// ============================================================
async function generarHooksParaProducto(producto) {
    const fallbackHooks = {
        pinterest: [
            "✨ The $10M Secret NYC Women Are Whispering About • Save this",
            "🕊️ Luxury isn't loud. It's silent. And she knows where to find it."
        ],
        twitter: [
            "The investment that outperformed her 401k? A piece so exclusive, only 47 women own it.",
            "She doesn't chase trends. She sets them. And this is what's next."
        ]
    };
    
    if (!isTrafficAvailable || !trafficModel) {
        console.log('⚠️ [TRAFFIC] No disponible, usando fallback');
        return fallbackHooks;
    }
    
    try {
        console.log(`\n🚀 [TRAFFIC] Generando hooks para: ${producto.titulo.substring(0, 40)}...`);
        
        const prompt = `Eres el GENERAL DE TRÁFICO. Genera hooks virales para este producto.

PRODUCTO: ${producto.titulo}
CURIOSIDAD: ${producto.curiosidad || 'Producto de lujo exclusivo'}

RESPONDE SOLO CON JSON:
{
    "pinterest": ["hook1", "hook2"],
    "twitter": ["hook1", "hook2"],
    "metaDescription": "Meta description optimizada 155 chars",
    "seoTitle": "SEO title 60 chars"
}`;
        
        const result = await trafficModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const hooks = JSON.parse(clean);
        
        console.log(`✅ [TRAFFIC] Hooks generados: Pinterest:${hooks.pinterest?.length || 0} Twitter:${hooks.twitter?.length || 0}`);
        
        return hooks;
    } catch (e) {
        console.log(`⚠️ [TRAFFIC] Error: ${e.message}`);
        return fallbackHooks;
    }
}

/**
 * Guarda los hooks en el historial
 */
async function guardarHooks(producto, hooks) {
    const registro = {
        id: Date.now(),
        productoId: producto.id,
        productoTitulo: producto.titulo,
        fecha: new Date().toISOString(),
        hooks: hooks
    };
    
    const historial = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
    historial.unshift(registro);
    if (historial.length > 50) historial.pop();
    fs.writeFileSync(SOCIAL_HOOKS_PATH, JSON.stringify(historial, null, 2));
    
    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
    stats.hooksGenerados = (stats.hooksGenerados || 0) + 
        (hooks.pinterest?.length || 0) + 
        (hooks.twitter?.length || 0);
    fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
    
    console.log(`💾 [TRAFFIC] Hooks guardados en historial`);
}

// ============================================================
// 🏭 CONTENT - Genera curiosidad (Ritmo constante cada 3h)
// ============================================================
async function generarCuriosidadConGemini() {
    const temaIdx = Math.floor(Date.now() / 3600000) % TEMAS_SEO.length;
    const tema = TEMAS_SEO[temaIdx];
    const porcentaje = Math.floor(Math.random() * 35 + 60);
    
    const fallback = {
        titulo_es: `El ${porcentaje}% de mujeres en NYC ya conoce este secreto de lujo`,
        titulo_en: `Best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026`,
        texto_es: `Descubre por qué el ${porcentaje}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo en este elemento exclusivo.`,
        texto_en: `Discover why ${porcentaje}% of high-income women in Manhattan are investing in this exclusive element.`,
        meta_descripcion_en: `Discover the best luxury home products 2026.`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status.",
        productoSugerido: tema.tema.split(' ')[0] + ' luxury product'
    };
    
    if (!isContentAvailable || !contentModel) {
        console.log('⚠️ [CONTENT] No disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`\n🏭 [CONTENT] Generando curiosidad (ritmo constante 3h)...`);
        
        const prompt = `Eres experto en marketing de lujo. Genera una curiosidad viral.

TEMA: ${tema.tema}
KEYWORD: ${tema.kw_en}

RESPONDE SOLO CON JSON:
{
    "titulo_es": "Título en español con número impactante",
    "titulo_en": "Title in English with keyword",
    "texto_es": "Texto persuasivo 2-3 oraciones",
    "texto_en": "Persuasive text 2-3 sentences",
    "meta_descripcion_en": "Meta description 155 chars",
    "descripcion_visual_es": "Descripción sensorial",
    "descripcion_visual_en": "Sensory description",
    "productoSugerido": "Tipo de producto Amazon"
}`;
        
        const result = await contentModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        console.log(`✅ [CONTENT] Curiosidad generada: ${data.titulo_en}`);
        
        return {
            titulo_es: data.titulo_es || fallback.titulo_es,
            titulo_en: data.titulo_en || fallback.titulo_en,
            texto_es: data.texto_es || fallback.texto_es,
            texto_en: data.texto_en || fallback.texto_en,
            meta_descripcion_en: data.meta_descripcion_en || fallback.meta_descripcion_en,
            descripcion_visual_es: data.descripcion_visual_es || fallback.descripcion_visual_es,
            descripcion_visual_en: data.descripcion_visual_en || fallback.descripcion_visual_en,
            productoSugerido: data.productoSugerido || fallback.productoSugerido
        };
    } catch (e) {
        console.log(`⚠️ [CONTENT] Error: ${e.message}`);
        return fallback;
    }
}

async function publicarCuriosidadAutomatica() {
    console.log('🏭 [CONTENT] Generando curiosidad programada (ritmo constante)...');
    
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
            productoSugerido: g.productoSugerido,
            fecha: new Date().toISOString()
        };
        
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(nueva);
        if (data.length > 50) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.curiosidadesGeneradas++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        
        console.log(`✅ [CONTENT] Publicada: "${nueva.titulo_en}"`);
        return nueva;
    } catch (e) {
        console.log('❌ [CONTENT] Error:', e.message);
        return null;
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, copy) {
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

// ============================================================
// ENDPOINTS API - mxl es el Único Disparador
// ============================================================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        protocol: 'COMMANDER MXL',
        timestamp: new Date().toISOString(),
        content: isContentAvailable ? 'active' : 'inactive',
        mastermind: isSalesAvailable ? 'active' : 'inactive',
        traffic: isTrafficAvailable ? 'active' : 'inactive',
        uptime: process.uptime()
    });
});

// 📌 ENDPOINT PRINCIPAL - mxl inyecta el link y el sistema procesa automáticamente
app.post('/api/commander/inject', async (req, res) => {
    const startTime = Date.now();
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🎯 [COMMANDER MXL] ORDEN RECIBIDA - Procesando inyección...');
    console.log('═══════════════════════════════════════════════════════════');
    
    try {
        const { url, imagenUrl, categoria } = req.body;
        
        // Validación - mxl debe inyectar URL e imagen
        if (!url || !imagenUrl) {
            console.log('❌ [COMMANDER] Falta URL o imagen - orden rechazada');
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ COMANDANTE: Debes inyectar URL y URL de imagen para procesar la orden' 
            });
        }
        
        console.log(`📦 Producto recibido:`);
        console.log(`   🔗 URL: ${url.substring(0, 80)}...`);
        console.log(`   🖼️ Imagen: ${imagenUrl.substring(0, 60)}...`);
        console.log(`   📁 Categoría: ${categoria || 'LUXURY'}`);
        
        // ============================================================
        // PASO 1: MASTERMIND genera el artículo completo
        // ============================================================
        console.log('\n🧠 [PASO 1/3] MASTERMIND generando artículo (Ogilvy/Halbert)...');
        const copy = await generarArticuloCompleto(url, imagenUrl, categoria || 'LUXURY');
        
        // ============================================================
        // PASO 2: Guardar el producto
        // ============================================================
        console.log('\n💾 [PASO 2/3] Guardando producto en base de datos...');
        const html = generarHTMLArticulo(url, imagenUrl, categoria || 'LUXURY', copy);
        const producto = {
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
        
        const articulos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        articulos.unshift(producto);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(articulos, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.productosPublicados++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        
        console.log(`✅ Producto guardado: ID ${producto.id} - ${producto.titulo}`);
        
        // ============================================================
        // PASO 3: TRAFFIC genera hooks automáticamente
        // ============================================================
        console.log('\n🚀 [PASO 3/3] TRAFFIC generando hooks virales para bombardeo externo...');
        const hooks = await generarHooksParaProducto(producto);
        await guardarHooks(producto, hooks);
        
        const elapsed = Date.now() - startTime;
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log(`✅ [COMMANDER MXL] ORDEN COMPLETADA en ${elapsed}ms`);
        console.log('═══════════════════════════════════════════════════════════\n');
        
        res.json({
            success: true,
            message: '✅ ORDEN EJECUTADA - Producto procesado por MASTERMIND y TRAFFIC',
            tiempoProcesamiento: `${elapsed}ms`,
            producto: {
                id: producto.id,
                titulo: producto.titulo,
                url: producto.link
            },
            hooks: hooks,
            motores: {
                mastermind: isSalesAvailable ? 'activado' : 'fallback',
                traffic: isTrafficAvailable ? 'activado' : 'fallback'
            }
        });
        
    } catch (e) {
        console.error('❌ [COMMANDER] Error en procesamiento:', e.message);
        res.status(500).json({ 
            success: false, 
            error: `Error procesando orden: ${e.message}` 
        });
    }
});

// Endpoint para ver productos (supervisión)
app.get('/api/productos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

// Endpoint para curiosidades (CONTENT)
app.get('/api/curiosidades', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

// Endpoint para hooks generados
app.get('/api/hooks', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

// Endpoint para estadísticas
app.get('/api/estadisticas', (req, res) => {
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const productos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        res.json({
            ...stats,
            curiosidadesActivas: curiosidades.length,
            productosActivos: productos.length,
            contentDisponible: isContentAvailable,
            mastermindDisponible: isSalesAvailable,
            trafficDisponible: isTrafficAvailable
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Endpoint para registrar clics
app.post('/api/click/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) {
            data[i].clicks = (data[i].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            
            const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
            stats.totalClics++;
            stats.clicsPorProducto[req.params.id] = (stats.clicsPorProducto[req.params.id] || 0) + 1;
            fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// Rutas estáticas
app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// CRON: CONTENT genera curiosidades cada 3 horas (SIEMPRE ACTIVO)
cron.schedule('0 */3 * * *', async () => {
    console.log('\n⏰ [CRON] CONTENT - Ritmo constante cada 3 horas');
    await publicarCuriosidadAutomatica();
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
const startServer = async () => {
    try {
        await initGeminiMotors();
        
        // Generar primera curiosidad si no hay
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        if (curiosidades.length === 0) {
            console.log('📝 Generando primera curiosidad en 3 segundos...');
            setTimeout(() => publicarCuriosidadAutomatica(), 3000);
        }
        
        app.listen(PORT, '0.0.0.0', () => {
            const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
            const productos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
            const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
            
            console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     🧠 PROTOCOLO "COMMANDER MXL" - mxl = Único Disparador       ║
╠══════════════════════════════════════════════════════════════════╣
║  🏭 CONTENT: ${isContentAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} - Ritmo: cada 3h           ║
║  🧠 MASTERMIND: ${isSalesAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} - Modo: Bajo demanda       ║
║  🚀 TRAFFIC: ${isTrafficAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} - Modo: Post-procesamiento  ║
║                                                                  ║
║  📊 ESTADO ACTUAL:                                              ║
║  💎 Curiosidades: ${curiosidades.length} activas | ${stats.curiosidadesGeneradas || 0} generadas     ║
║  💰 Productos: ${productos.length} publicados | ${stats.totalClics || 0} clics totales           ║
║  🎣 Hooks: ${stats.hooksGenerados || 0} generados                                                ║
║                                                                  ║
║  🎯 COMANDANTE MXL:                                             ║
║    1. Inyecta URL + Imagen en POST /api/commander/inject        ║
║    2. MASTERMIND genera artículo automáticamente                ║
║    3. TRAFFIC genera hooks virales para bombardeo               ║
║    4. CONTENT mantiene tráfico orgánico cada 3h                 ║
║                                                                  ║
║  🚀 Puerto: ${PORT}                                              ║
╚══════════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (error) {
        console.error('❌ Error al iniciar servidor:', error);
        process.exit(1);
    }
};

startServer();
