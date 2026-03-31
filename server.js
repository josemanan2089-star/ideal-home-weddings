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
// 🧠 PROTOCOLO "THE MASTERMIND MXL" - SISTEMA DE LLAVES ESPECIALIZADAS
// ============================================================
// GEMINI_API_KEY_CONTENT → Fábrica de tráfico viral (curiosidades)
// GEMINI_API_KEY_SALES   → CEREBRO MAESTRO (Estrategia + Copywriting Élite)
// ============================================================

let contentAI = null;
let salesAI = null;
let contentModel = null;
let salesModel = null;
let isContentAvailable = false;
let isSalesAvailable = false;
let contentModelName = 'none';
let salesModelName = 'none';

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
 * Inicializa ambos motores con sus llaves específicas
 */
async function initGeminiMotors() {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║   🧠 PROTOCOLO "THE MASTERMIND MXL" - CEREBRO MAESTRO ACTIVADO   ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    
    // Motor CONTENT (Fábrica de tráfico)
    const contentKey = process.env.GEMINI_API_KEY_CONTENT;
    console.log('📝 MOTOR CONTENT (Fábrica de Tráfico Viral)');
    console.log(`   Llave: ${contentKey ? `${contentKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const contentResult = await initGeminiMotor(contentKey, 'CONTENT');
    contentModel = contentResult.model;
    contentModelName = contentResult.modelName;
    isContentAvailable = contentResult.available;
    
    console.log('');
    
    // Motor SALES - CEREBRO MAESTRO
    const salesKey = process.env.GEMINI_API_KEY_SALES;
    console.log('💰 MOTOR SALES - CEREBRO MAESTRO MXL');
    console.log('   🎯 Perfil A: Estratega de Madison Avenue (Marketing Intelligence)');
    console.log('   📝 Perfil B: Copywriter Élite (Ogilvy + Halbert)');
    console.log(`   🔑 Llave: ${salesKey ? `${salesKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const salesResult = await initGeminiMotor(salesKey, 'SALES');
    salesModel = salesResult.model;
    salesModelName = salesResult.modelName;
    isSalesAvailable = salesResult.available;
    
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('📊 ESTADO DE MOTORES:');
    console.log(`   🏭 CONTENT: ${isContentAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${contentModelName})`);
    console.log(`   🧠 SALES MASTERMIND: ${isSalesAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${salesModelName})`);
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
const ESTRATEGIA_PATH = path.join(DATA_DIR, 'estrategia.json');

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
    productosPublicados: 0,
    ultimaActualizacion: new Date().toISOString()
});
initFile(ESTRATEGIA_PATH, {
    ultimoAnalisis: null,
    tendenciasActuales: [],
    recomendaciones: [],
    nichoActual: 'LUXURY'
});

// ============================================================
// SISTEMA DE ÁNGULOS DE VENTA (Gestionado por MASTERMIND)
// ============================================================
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
    'A': 'ESTATUS PURO - Lujo Silencioso',
    'B': 'FOMO - Escasez y Urgencia',
    'C': 'BIO-HACKING - Salud y Optimización',
    'D': 'INVERSIÓN - Valor Patrimonial'
};

const angulosPrompt = {
    'A': 'Ángulo ESTATUS: exclusividad, lujo silencioso, "el secreto que no cuentan", pertenencia a un club selecto',
    'B': 'Ángulo FOMO: escasez, urgencia, "solo quedan pocas unidades", "mientras lees esto, alguien más lo está comprando"',
    'C': 'Ángulo BIO-HACKING: optimización humana, longevidad, energía, "la rutina de los CEO exitosos"',
    'D': 'Ángulo INVERSIÓN: activo que no deprecia, herencia, "tu yo del futuro te lo agradecerá"'
};

// Temas SEO para CONTENT
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

// ============================================================
// 🧠 MASTERMIND SALES - ANÁLISIS ESTRATÉGICO (Perfil A)
// ============================================================
async function analizarEstrategiaVentas() {
    if (!isSalesAvailable || !salesModel) {
        console.log('⚠️ [MASTERMIND] CEREBRO MAESTRO no disponible para análisis');
        return null;
    }
    
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        const articulos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const estrategiaActual = JSON.parse(fs.readFileSync(ESTRATEGIA_PATH));
        
        const clicsPorAngulo = stats.clicsPorAngulo || { A: 0, B: 0, C: 0, D: 0 };
        const totalClics = stats.totalClics || 0;
        const productosPublicados = stats.productosPublicados || 0;
        
        console.log(`\n🧠 [MASTERMIND] CEREBRO MAESTRO ANALIZANDO MERCADO 2026...`);
        console.log(`   📊 Datos: ${totalClics} clics | ${productosPublicados} productos`);
        console.log(`   🎯 Rendimiento ángulos: A:${clicsPorAngulo.A} B:${clicsPorAngulo.B} C:${clicsPorAngulo.C} D:${clicsPorAngulo.D}`);
        
        const prompt = `Eres el mejor estratega de mercadeo de Madison Avenue. 
Tu misión es maximizar el ROI del socio MXL.

ANÁLISIS DE DATOS (Railway):
- Total clics: ${totalClics}
- Productos publicados: ${productosPublicados}
- Rendimiento por ángulo:
  * ESTATUS: ${clicsPorAngulo.A} clics
  * FOMO: ${clicsPorAngulo.B} clics
  * BIO-HACKING: ${clicsPorAngulo.C} clics
  * INVERSIÓN: ${clicsPorAngulo.D} clics

MERCADO 2026 (NYC, Miami, Beverly Hills):
- Micro-tendencias actuales: lujo silencioso, bienestar integral, inversión en experiencias
- Consumidora objetivo: mujer 35-55, alto poder adquisitivo, busca diferenciación
- Psicología de compra: validación social, exclusividad, optimización personal

RESPONDE SOLO CON JSON (sin markdown):
{
    "anguloRecomendado": "A/B/C/D",
    "nichoEmergente": "nombre del nicho con mayor potencial",
    "reestructuracionNecesaria": true/false,
    "mensajeEstrategico": "Resumen ejecutivo de la nueva dirección (1 párrafo)",
    "tendenciasDetectadas": ["tendencia1", "tendencia2", "tendencia3"],
    "psicologiaDeVenta": "Ángulo psicológico principal a explotar",
    "proximoMovimiento": "Acción concreta a ejecutar"
}`;
        
        const result = await salesModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const analisis = JSON.parse(clean);
        
        // Actualizar estrategia si hay reestructuración
        if (analisis.reestructuracionNecesaria && analisis.anguloRecomendado !== anguloVentaActual) {
            console.log(`\n🔄 [MASTERMIND] REESTRUCTURACIÓN ESTRATÉGICA DETECTADA`);
            console.log(`   🎯 Nuevo ángulo recomendado: ${analisis.anguloRecomendado} (${angulosDesc[analisis.anguloRecomendado]})`);
            console.log(`   📝 ${analisis.mensajeEstrategico}`);
            
            // Guardar nueva estrategia
            const nuevaEstrategia = {
                ultimoAnalisis: new Date().toISOString(),
                anguloRecomendado: analisis.anguloRecomendado,
                nichoEmergente: analisis.nichoEmergente,
                tendenciasActuales: analisis.tendenciasDetectadas,
                recomendaciones: [analisis.mensajeEstrategico],
                psicologiaDeVenta: analisis.psicologiaDeVenta,
                proximoMovimiento: analisis.proximoMovimiento
            };
            fs.writeFileSync(ESTRATEGIA_PATH, JSON.stringify(nuevaEstrategia, null, 2));
            
            // Actualizar ángulo actual
            anguloVentaActual = analisis.anguloRecomendado;
        }
        
        console.log(`✅ [MASTERMIND] Análisis estratégico completado`);
        return analisis;
    } catch (e) {
        console.log(`⚠️ [MASTERMIND] Error en análisis: ${e.message}`);
        return null;
    }
}

// ============================================================
// 💰 MASTERMIND SALES - COPYWRITING ÉLITE (Perfil B)
// ============================================================
async function generarCopyProducto(url, imagenUrl, categoria) {
    const fallback = {
        titulo: "The Investment Every NYC Woman Is Making in 2026",
        meta_descripcion: "Discover why high-income women from Manhattan to Miami are investing in this exclusive piece. Limited availability.",
        intro: "There's a reason interior designers in Beverly Hills keep this one detail to themselves.",
        descripcion_visual: "The finish catches light differently. It's not just design—it's a statement of arrival.",
        problema: "Your home whispers when it should speak. It feels like it's missing that final layer of intention.",
        solucion: "This piece doesn't just fill space—it commands presence. Everything around it suddenly looks more considered.",
        beneficio_estatus: "When guests walk in, they won't compliment the piece. They'll compliment your taste. There's a difference.",
        prueba_social: "Isabella from Miami: 'My decorator asked where I found it. I told her it's our little secret.'",
        cierre: "The women who know, know. Will you be one of them before the next shipment sells out?",
        curiosidad: "Insiders say these pieces appreciate 30% within 18 months. Most don't sell them. They collect them.",
        palabras_clave: ["luxury home investment 2026", "what NYC women are buying", "Beverly Hills interior design"]
    };
    
    if (!isSalesAvailable || !salesModel) {
        console.log('⚠️ [MASTERMIND] CEREBRO MAESTRO no disponible, usando fallback');
        return fallback;
    }
    
    try {
        // Cargar estrategia actual para contexto
        let estrategiaContexto = '';
        try {
            const estrategia = JSON.parse(fs.readFileSync(ESTRATEGIA_PATH));
            if (estrategia.ultimoAnalisis) {
                estrategiaContexto = `
CONTEXTO ESTRATÉGICO (MASTERMIND):
- Nicho emergente: ${estrategia.nichoEmergente || 'Lujo'}
- Psicología de venta: ${estrategia.psicologiaDeVenta || 'Estatus'}
- Tendencias actuales: ${(estrategia.tendenciasActuales || []).join(', ')}
- Próximo movimiento: ${estrategia.proximoMovimiento || 'Venta por escasez'}`;
            }
        } catch(e) {}
        
        console.log(`\n💰 [MASTERMIND] CEREBRO MAESTRO generando copy de élite...`);
        console.log(`   📦 Producto: ${categoria} | URL: ${url.substring(0, 50)}...`);
        console.log(`   🎯 Ángulo activo: ${angulosDesc[anguloVentaActual]}`);
        
        const prompt = `Eres el mejor estratega de mercadeo y el mejor experto en marketing directo de Estados Unidos. Tu objetivo es maximizar el ROI del socio mxl. Analiza el mercado 2026, detecta el deseo del consumidor y genera un cierre de venta infalible.

ACTÚA COMO:
1. DAVID OGILVY: Maestro de la publicidad elegante. Cada palabra debe transmitir estatus sin gritarlo.
2. GARY HALBERT: Genio del marketing directo. El llamado a la acción debe ser irresistible.

PSICOLOGÍA DE VENTA APLICADA:
- Escasez: "Mientras lees esto, alguien más está comprando"
- Prueba social: "Las mujeres que saben, saben"
- Estatus: "No es para todos. Ese es el punto."
- Urgencia: "Esta oportunidad no espera"

DATOS DEL PRODUCTO:
- URL: ${url}
- Categoría: ${categoria}
- Ángulo de venta actual: ${angulosPrompt[anguloVentaActual]}
${estrategiaContexto}

REQUISITOS DEL COPY:
- Título: Que detenga el scroll en el celular
- Meta descripción: 155 caracteres con palabra clave principal
- Intro: Gancho psicológico en 1 frase
- Descripción visual: Que huela y se sienta el lujo
- Problema/Solución: Identificar el deseo inconsciente
- Prueba social: Testimonio de mujer de alto poder adquisitivo (NYC, Miami o Beverly Hills)
- Cierre: Que genere FOMO inmediato
- Curiosidad: Dato exclusivo que solo "las que saben" conocen

RESPONDE SOLO CON JSON (sin markdown):
{
    "titulo": "Título que detiene el scroll (máx 60 caracteres)",
    "meta_descripcion": "Meta description con keyword principal (155 chars)",
    "intro": "Gancho psicológico de 1 frase que crea curiosidad",
    "descripcion_visual": "Descripción sensorial que hace sentir el producto (textura, luz, presencia)",
    "problema": "El deseo inconsciente que este producto satisface (1 frase)",
    "solucion": "Cómo este producto resuelve ese deseo (1 frase)",
    "beneficio_estatus": "Beneficio de estatus/posicionamiento social (1 frase)",
    "prueba_social": "Testimonio de mujer de alto poder adquisitivo con nombre y ubicación",
    "cierre": "Llamada a acción con urgencia y exclusividad",
    "curiosidad": "Dato exclusivo sobre tendencias de lujo que crea FOMO",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;
        
        const result = await salesModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        console.log(`✅ [MASTERMIND] Copy generado exitosamente`);
        console.log(`   📝 Título: ${data.titulo}`);
        
        return {
            titulo: data.titulo || fallback.titulo,
            meta_descripcion: data.meta_descripcion || fallback.meta_descripcion,
            intro: data.intro || fallback.intro,
            descripcion_visual: data.descripso_visual || fallback.descripcion_visual,
            problema: data.problema || fallback.problema,
            solucion: data.solucion || fallback.solucion,
            beneficio_estatus: data.beneficio_estatus || fallback.beneficio_estatus,
            prueba_social: data.prueba_social || fallback.prueba_social,
            cierre: data.cierre || fallback.cierre,
            curiosidad: data.curiosidad || fallback.curiosidad,
            palabras_clave: data.palabras_clave || fallback.palabras_clave
        };
    } catch (e) {
        console.log(`⚠️ [MASTERMIND] Error generando copy: ${e.message}`);
        return fallback;
    }
}

// ============================================================
// 🏭 MOTOR CONTENT: Generar curiosidad viral
// ============================================================
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
    
    if (!isContentAvailable || !contentModel) {
        console.log('⚠️ [CONTENT] Motor no disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`🏭 [CONTENT] Generando curiosidad | Motor: ${contentModelName} | Ángulo: ${angulosDesc[angulo]}`);
        
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
        
        const result = await contentModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        console.log(`✅ [CONTENT] Curiosidad generada exitosamente`);
        
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
        console.log(`⚠️ [CONTENT] Error: ${e.message}`);
        return fallback;
    }
}

async function publicarCuriosidadAutomatica() {
    console.log('🏭 [CONTENT] Generando curiosidad programada...');
    
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
        
        console.log(`✅ [CONTENT] Publicada: "${nueva.titulo_en}"`);
        return nueva;
    } catch (e) {
        console.log('❌ [CONTENT] Error:', e.message);
        return null;
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

// ============================================================
// ENDPOINTS API
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mastermind: isSalesAvailable ? 'active' : 'inactive',
        content: isContentAvailable ? 'active' : 'inactive',
        contentModel: contentModelName,
        salesModel: salesModelName,
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
        res.json({ success: true, curiosidad: c, motor: 'CONTENT' });
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
        res.json({ success: true, copy, motor: 'MASTERMIND' });
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
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.productosPublicados++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        
        res.json({ success: true, articulo: art, motor: 'MASTERMIND' });
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
            
            // Registrar clic por ángulo
            if (anguloVentaActual) {
                stats.clicsPorAngulo[anguloVentaActual] = (stats.clicsPorAngulo[anguloVentaActual] || 0) + 1;
            }
            
            stats.ultimaActualizacion = new Date().toISOString();
            fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
            
            // Registrar en historial
            if (historialClics[anguloVentaActual]) {
                historialClics[anguloVentaActual].push(Date.now());
                if (historialClics[anguloVentaActual].length > 100) {
                    historialClics[anguloVentaActual].shift();
                }
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.get('/api/estadisticas', (req, res) => {
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        const estrategia = JSON.parse(fs.readFileSync(ESTRATEGIA_PATH));
        res.json({
            ...stats,
            anguloActual: anguloVentaActual,
            descripcionAngulo: angulosDesc[anguloVentaActual],
            contentDisponible: isContentAvailable,
            salesDisponible: isSalesAvailable,
            contentModelo: contentModelName,
            salesModelo: salesModelName,
            estrategia: estrategia
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/api/motores-status', (req, res) => {
    res.json({
        content: {
            disponible: isContentAvailable,
            modelo: contentModelName,
            apiKeyConfigurada: !!process.env.GEMINI_API_KEY_CONTENT
        },
        mastermind: {
            disponible: isSalesAvailable,
            modelo: salesModelName,
            apiKeyConfigurada: !!process.env.GEMINI_API_KEY_SALES,
            perfiles: ['Estratega Madison Avenue', 'Copywriter Élite (Ogilvy + Halbert)']
        }
    });
});

app.post('/api/analizar-estrategia', async (req, res) => {
    try {
        const analisis = await analizarEstrategiaVentas();
        res.json({ success: true, analisis });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Rutas estáticas (al final)
app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// CRON cada 3 horas (usa MOTOR CONTENT)
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ [CRON] Generando curiosidad programada (CONTENT)...');
    await publicarCuriosidadAutomatica();
});

// CRON cada 6 horas para análisis estratégico (MASTERMIND)
cron.schedule('0 */6 * * *', async () => {
    console.log('🧠 [CRON] MASTERMIND analizando estrategia de mercado...');
    await analizarEstrategiaVentas();
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
const startServer = async () => {
    try {
        await initGeminiMotors();
        
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        if (curiosidades.length === 0) {
            console.log('📝 Generando primera curiosidad en 3 segundos...');
            setTimeout(() => publicarCuriosidadAutomatica(), 3000);
        }
        
        // Análisis inicial de estrategia
        setTimeout(() => {
            console.log('🧠 MASTERMIND: Iniciando análisis estratégico inicial...');
            analizarEstrategiaVentas();
        }, 5000);
        
        app.listen(PORT, '0.0.0.0', () => {
            const art = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
            const cur = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
            const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
            
            console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     🧠 PROTOCOLO "THE MASTERMIND MXL" - CEREBRO MAESTRO ACTIVO  ║
╠══════════════════════════════════════════════════════════════════╣
║  🏭 CONTENT: ${isContentAvailable ? `✅ ACTIVO (${contentModelName})` : '⚠️ NO DISPONIBLE'}${' '.repeat(35 - (isContentAvailable ? contentModelName.length + 12 : 16))}║
║  🧠 MASTERMIND: ${isSalesAvailable ? `✅ ACTIVO (${salesModelName})` : '⚠️ NO DISPONIBLE'}${' '.repeat(35 - (isSalesAvailable ? salesModelName.length + 12 : 16))}║
║  🎯 Perfil A: Estratega Madison Avenue (Análisis de mercado)      ║
║  📝 Perfil B: Copywriter Élite (Ogilvy + Halbert)                 ║
║  🎯 Ángulo actual: ${angulosDesc[anguloVentaActual]}${' '.repeat(45 - angulosDesc[anguloVentaActual].length)}║
║  💎 Curiosidades: ${cur} guardadas | ${stats.curiosidadesGeneradas} generadas${' '.repeat(20)}║
║  💰 Productos: ${art} publicados | ${stats.totalClics} clics totales${' '.repeat(25)}║
║  🚀 Puerto: ${PORT}${' '.repeat(48)}║
║  📁 Datos: ${DATA_DIR}${' '.repeat(45 - DATA_DIR.length)}║
╚══════════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (error) {
        console.error('❌ Error al iniciar servidor:', error);
        process.exit(1);
    }
};

startServer();
