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
app.use('/temp', express.static(path.join(__dirname, 'temp')));

const cache = new Map();
const CACHE_TTL = 300000;

// Inicializar Gemini - SOPORTE PARA 2.0 Y 2.5
let genAI, model;
let isGeminiAvailable = false;
let modeloUsado = 'gemini-1.5-flash'; // fallback

if (process.env.GEMINI_API_KEY) {
    try {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Detectar y usar el mejor modelo disponible
        const modelosDisponibles = [
            'gemini-2.5-pro-exp-03-25',  // Gemini 2.5 Pro (más potente)
            'gemini-2.0-flash-exp',       // Gemini 2.0 Flash (rápido)
            'gemini-2.0-flash',           // Gemini 2.0 Flash estable
            'gemini-1.5-flash',           // Fallback
            'gemini-1.5-pro'              // Fallback alternativo
        ];
        
        // Intentar usar el mejor modelo disponible
        for (const modelName of modelosDisponibles) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                // Probar con un ping rápido
                await testModel.generateContent('ping');
                model = testModel;
                modeloUsado = modelName;
                isGeminiAvailable = true;
                console.log(`✅ Gemini activado con modelo: ${modeloUsado}`);
                break;
            } catch (e) {
                console.log(`⚠️ Modelo ${modelName} no disponible, probando siguiente...`);
            }
        }
        
        if (!isGeminiAvailable) {
            // Fallback final
            model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            modeloUsado = "gemini-1.5-flash";
            isGeminiAvailable = true;
            console.log(`✅ Gemini activado con modelo fallback: ${modeloUsado}`);
        }
    } catch(e) {
        console.log('⚠️ Error inicializando Gemini:', e.message);
    }
}

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
if (!fs.existsSync(ESTADISTICAS_PATH)) fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify({
    totalClics: 0,
    clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
    curiosidadesGeneradas: 0,
    ultimaActualizacion: new Date().toISOString()
}));

function extraerASIN(url) {
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i,
        /\/dp\/([A-Z0-9]{10})/i
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

// ============================================================
// SISTEMA DE ADAPTACIÓN DE VENTAS (EL VENENO SE ADAPTA)
// ============================================================
let anguloVentaActual = 'A';
const historialClics = { A: [], B: [], C: [], D: [] };

function actualizarAnguloVenta() {
    const ahora = Date.now();
    const hace24h = ahora - 86400000;
    
    let mejorAngulo = 'A';
    let maxClics = -1;
    
    for (const [angulo, timestamps] of Object.entries(historialClics)) {
        const clicsUltimas24h = timestamps.filter(ts => ts > hace24h).length;
        if (clicsUltimas24h > maxClics) {
            maxClics = clicsUltimas24h;
            mejorAngulo = angulo;
        }
    }
    
    if (maxClics === 0) {
        const angulos = ['A', 'B', 'C', 'D'];
        const indiceActual = angulos.indexOf(anguloVentaActual);
        mejorAngulo = angulos[(indiceActual + 1) % angulos.length];
    }
    
    anguloVentaActual = mejorAngulo;
    console.log(`🔄 Ángulo de venta activo: ${anguloVentaActual} (${maxClics} clics últimas 24h)`);
    return anguloVentaActual;
}

const descripcionAngulos = {
    'A': 'ESTATUS PURO - Exclusividad y lujo silencioso',
    'B': 'FOMO - Escasez y tendencia imparable 2026',
    'C': 'BIO-HACKING - Salud, eficiencia y optimización',
    'D': 'INVERSIÓN INTELIGENTE - Activo que no deprecia'
};

const instruccionesAngulo = {
    'A': `Ángulo ESTATUS PURO: Enfócate en exclusividad, "lujo silencioso", materiales nobles, ediciones limitadas. La audiencia debe sentir que este producto la distingue de sus amigas. Usa frases como "el secreto que no cuentan en los showrooms de Soho", "el detalle que los diseñadores de interiores de Beverly Hills juran guardar en secreto", o "la única inversión que tu asesor financiero aprobaría sin preguntar".`,
    
    'B': `Ángulo FOMO (Fear Of Missing Out): Enfócate en la escasez y la tendencia imparable de 2026. Crea urgencia real. Usa datos como "más del 70% de las casas en los Hamptons ya lo incorporaron", "solo quedan 3 unidades en el distribuidor exclusivo de Miami", o "las mujeres que saben ya lo tienen instalado desde enero".`,
    
    'C': `Ángulo BIO-HACKING & WELLNESS: Enfócate en ganar tiempo, salud y eficiencia. Conecta el producto con longevidad, bienestar cognitivo y productividad. Usa términos como "optimización cognitiva", "rutina mañana de alto rendimiento", "el gadget que los CEO de Wall Street no mencionan en sus entrevistas", o "los 15 minutos que cambiarán tu salud este año".`,
    
    'D': `Ángulo INVERSIÓN INTELIGENTE: Enfócate en que el producto mantiene o aumenta el valor de la propiedad, es una inversión a largo plazo y tiene reventa asegurada. Usa frases como "el activo que los tasadores de bienes raíces en Manhattan ya están considerando", "el único gasto en tecnología que no deprecia", o "lo que los millonarios compran cuando el mercado baja".`
};

// ============================================================
// TEMAS SEO ROTATIVOS - EXPANDIDOS PARA GEMINI 2.5
// ============================================================
const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_es: "gadgets de lujo hogar 2026", kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury", kw_es: "spa en casa lujo baño", kw_en: "luxury home spa bathroom ideas" },
    { tema: "luxury kitchen appliances women NYC", kw_es: "cocina de lujo electrodomésticos", kw_en: "luxury kitchen appliances NYC women" },
    { tema: "minimalist luxury bedroom decor 2026", kw_es: "dormitorio minimalista lujo", kw_en: "minimalist luxury bedroom 2026" },
    { tema: "smart home automation Beverly Hills", kw_es: "hogar inteligente automatización", kw_en: "smart home automation Beverly Hills" },
    { tema: "luxury home office women entrepreneur", kw_es: "oficina en casa mujer emprendedora", kw_en: "luxury home office women 2026" },
    { tema: "sustainable luxury home eco design", kw_es: "hogar sostenible lujo eco", kw_en: "sustainable luxury home design" },
    { tema: "luxury home fragrance candles", kw_es: "fragancias hogar velas lujo", kw_en: "luxury home fragrance best 2026" },
    { tema: "luxury outdoor living Miami terrace", kw_es: "terraza lujo Miami exterior", kw_en: "luxury outdoor living Miami" },
    { tema: "high end morning routine luxury home", kw_es: "rutina mañana mujer lujo", kw_en: "luxury morning routine home 2026" },
    { tema: "luxury water purifier home health", kw_es: "purificador agua lujo hogar", kw_en: "best luxury water purifier home" },
    { tema: "smart mirror beauty luxury women", kw_es: "espejo inteligente belleza lujo", kw_en: "smart mirror luxury beauty women" },
    { tema: "luxury home theater setup 2026", kw_es: "cine en casa lujo", kw_en: "luxury home theater setup 2026" },
    { tema: "designer furniture NYC luxury", kw_es: "muebles de diseñador lujo", kw_en: "designer luxury furniture NYC" },
    { tema: "luxury home gym equipment women", kw_es: "gimnasio en casa lujo mujer", kw_en: "luxury home gym equipment women" },
    { tema: "artificial intelligence home concierge", kw_es: "conserje inteligente hogar", kw_en: "AI home concierge luxury 2026" },
    { tema: "luxury wine cellar smart technology", kw_es: "bodega inteligente lujo", kw_en: "smart luxury wine cellar 2026" },
    { tema: "meditation room design luxury", kw_es: "sala meditación diseño lujo", kw_en: "luxury meditation room design" },
    { tema: "pet luxury home accessories", kw_es: "accesorios lujo para mascotas", kw_en: "luxury pet accessories home 2026" },
    { tema: "home art collection lighting", kw_es: "iluminación colección arte", kw_en: "luxury art lighting home 2026" }
];

// ============================================================
// MÚLTIPLES FUENTES DE IMÁGENES
// ============================================================

async function buscarEnUnsplash(query) {
    if (!process.env.UNSPLASH_ACCESS_KEY) return null;
    
    try {
        const paginaAleatoria = Math.floor(Math.random() * 5) + 1;
        const response = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: query,
                per_page: 15,
                page: paginaAleatoria,
                orientation: 'landscape',
                order_by: 'relevant'
            },
            headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
            timeout: 8000
        });
        
        if (response.data.results && response.data.results.length > 0) {
            const randomIndex = Math.floor(Math.random() * Math.min(8, response.data.results.length));
            const imagen = response.data.results[randomIndex];
            return {
                url: imagen.urls.regular,
                fuente: 'unsplash',
                alt: imagen.alt_description || query
            };
        }
    } catch(e) {
        console.log('⚠️ Unsplash error:', e.message);
    }
    return null;
}

async function buscarEnPexels(query) {
    if (!process.env.PEXELS_API_KEY) return null;
    
    try {
        const response = await axios.get('https://api.pexels.com/v1/search', {
            params: {
                query: query,
                per_page: 10,
                orientation: 'landscape'
            },
            headers: { 'Authorization': process.env.PEXELS_API_KEY },
            timeout: 8000
        });
        
        if (response.data.photos && response.data.photos.length > 0) {
            const randomIndex = Math.floor(Math.random() * Math.min(5, response.data.photos.length));
            const imagen = response.data.photos[randomIndex];
            return {
                url: imagen.src.large,
                fuente: 'pexels',
                alt: query
            };
        }
    } catch(e) {
        console.log('⚠️ Pexels error:', e.message);
    }
    return null;
}

async function buscarEnGoogle(query) {
    if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CX) return null;
    
    try {
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: {
                key: process.env.GOOGLE_API_KEY,
                cx: process.env.GOOGLE_CX,
                q: query,
                searchType: 'image',
                num: 8,
                imgSize: 'large',
                imgType: 'photo'
            },
            timeout: 8000
        });
        
        if (response.data.items && response.data.items.length > 0) {
            const randomIndex = Math.floor(Math.random() * Math.min(5, response.data.items.length));
            const imagen = response.data.items[randomIndex];
            return {
                url: imagen.link,
                fuente: 'google',
                alt: imagen.title || query
            };
        }
    } catch(e) {
        console.log('⚠️ Google Images error:', e.message);
    }
    return null;
}

const imagenesPexelsDirectas = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
    'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
    'https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg',
    'https://images.pexels.com/photos/258154/pexels-photo-258154.jpeg',
    'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg',
    'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
    'https://images.pexels.com/photos/1648772/pexels-photo-1648772.jpeg',
    'https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg',
    'https://images.pexels.com/photos/1571459/pexels-photo-1571459.jpeg',
    'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg',
    'https://images.pexels.com/photos/1571465/pexels-photo-1571465.jpeg',
    'https://images.pexels.com/photos/2635646/pexels-photo-2635646.jpeg',
    'https://images.pexels.com/photos/2635638/pexels-photo-2635638.jpeg',
    'https://images.pexels.com/photos/1571455/pexels-photo-1571455.jpeg',
    'https://images.pexels.com/photos/279746/pexels-photo-279746.jpeg',
    'https://images.pexels.com/photos/1571466/pexels-photo-1571466.jpeg',
    'https://images.pexels.com/photos/1571462/pexels-photo-1571462.jpeg',
    'https://images.pexels.com/photos/1571464/pexels-photo-1571464.jpeg',
    'https://images.pexels.com/photos/1571469/pexels-photo-1571469.jpeg',
    'https://images.pexels.com/photos/1571470/pexels-photo-1571470.jpeg',
    'https://images.pexels.com/photos/1648776/pexels-photo-1648776.jpeg',
    'https://images.pexels.com/photos/1457847/pexels-photo-1457847.jpeg',
    'https://images.pexels.com/photos/2635039/pexels-photo-2635039.jpeg',
    'https://images.pexels.com/photos/1571458/pexels-photo-1571458.jpeg'
];

async function buscarImagenPorContenido(curiosidad) {
    const contenidoCompleto = `${curiosidad.titulo_es || ''} ${curiosidad.titulo_en || ''} ${curiosidad.texto_es || ''} ${curiosidad.texto_en || ''} ${curiosidad.productoSugeridoTipo || ''}`.toLowerCase();
    
    const categorias = {
        'kitchen': ['kitchen', 'cocina', 'cooking', 'gourmet', 'food', 'chef', 'appliance', 'refrigerator', 'oven'],
        'bedroom': ['bedroom', 'dormitorio', 'sleep', 'bed', 'cozy', 'mattress', 'linen', 'pillow'],
        'bathroom': ['bathroom', 'baño', 'spa', 'shower', 'bath', 'wellness', 'relax', 'mirror', 'vanity'],
        'living': ['living', 'sala', 'sofa', 'couch', 'tv', 'entertainment', 'coffee table'],
        'office': ['office', 'oficina', 'desk', 'work', 'study', 'entrepreneur', 'chair', 'monitor'],
        'outdoor': ['outdoor', 'exterior', 'terrace', 'garden', 'pool', 'patio', 'deck', 'backyard'],
        'tech': ['smart', 'gadget', 'tech', 'technology', 'digital', 'automation', 'mirror', 'speaker', 'ai'],
        'wellness': ['wellness', 'health', 'fitness', 'gym', 'relaxation', 'meditation', 'yoga', 'spa'],
        'decor': ['decor', 'decoration', 'style', 'design', 'furniture', 'elegant', 'art', 'lighting'],
        'luxury': ['luxury', 'lujo', 'elegant', 'premium', 'high-end', 'exclusive', 'designer']
    };
    
    let categoriaDetectada = 'luxury';
    for (const [categoria, palabras] of Object.entries(categorias)) {
        for (const palabra of palabras) {
            if (contenidoCompleto.includes(palabra)) {
                categoriaDetectada = categoria;
                break;
            }
        }
    }
    
    const ubicaciones = ['nyc', 'new york', 'manhattan', 'beverly hills', 'miami', 'brickell', 'coral gables', 'los angeles', 'california', 'hamptons'];
    let ubicacionDetectada = null;
    for (const ubicacion of ubicaciones) {
        if (contenidoCompleto.includes(ubicacion)) {
            ubicacionDetectada = ubicacion;
            break;
        }
    }
    
    const palabrasClave = contenidoCompleto
        .split(' ')
        .filter(p => p.length > 4 && !['para', 'como', 'que', 'una', 'las', 'los', 'con', 'sin', 'por', 'del', 'mujer', 'women', 'home', 'house', 'luxury', 'interior', 'design'].includes(p))
        .slice(0, 4);
    
    let queries = [];
    
    if (ubicacionDetectada) {
        queries.push(`${categoriaDetectada} luxury home ${ubicacionDetectada}`);
        queries.push(`elegant ${categoriaDetectada} design ${ubicacionDetectada}`);
    }
    
    if (palabrasClave.length >= 2) {
        queries.push(`${palabrasClave[0]} ${palabrasClave[1]} luxury interior`);
        queries.push(`modern ${palabrasClave[0]} ${categoriaDetectada} design`);
    }
    
    const queriesPorCategoria = {
        'kitchen': ['luxury modern kitchen design', 'elegant kitchen interior', 'high end kitchen appliances', 'gourmet kitchen luxury', 'italian kitchen design'],
        'bedroom': ['luxury bedroom interior', 'elegant master bedroom', 'modern bedroom design', 'cozy luxury bedroom', 'minimalist bedroom luxury'],
        'bathroom': ['luxury bathroom spa', 'elegant bathroom design', 'modern bathroom interior', 'spa bathroom luxury', 'marble bathroom design'],
        'living': ['luxury living room', 'elegant living room interior', 'modern living room design', 'contemporary living room', 'grand salon luxury'],
        'office': ['luxury home office', 'elegant office interior', 'modern home office design', 'executive office luxury', 'women home office design'],
        'outdoor': ['luxury outdoor terrace', 'elegant patio design', 'modern outdoor living', 'garden luxury design', 'rooftop terrace luxury'],
        'tech': ['smart home technology', 'luxury smart home', 'modern tech home', 'automation luxury home', 'ai home technology'],
        'wellness': ['luxury home spa', 'wellness home design', 'elegant spa bathroom', 'relaxation luxury home', 'meditation room design'],
        'decor': ['luxury home decor', 'elegant interior design', 'modern home decoration', 'high end decor', 'designer home accessories'],
        'luxury': ['luxury home interior', 'elegant mansion interior', 'modern luxury design', 'high end home decor', 'luxury living spaces']
    };
    
    queries.push(...(queriesPorCategoria[categoriaDetectada] || queriesPorCategoria['luxury']));
    
    queries = [...new Set(queries)];
    const querySeleccionada = queries[Math.floor(Math.random() * queries.length)];
    
    console.log(`🔍 Categoría: ${categoriaDetectada}`);
    console.log(`🔍 Ubicación: ${ubicacionDetectada || 'no especificada'}`);
    console.log(`🔍 Query: "${querySeleccionada}"`);
    
    const fuentes = [
        { nombre: 'Unsplash', func: () => buscarEnUnsplash(querySeleccionada) },
        { nombre: 'Pexels API', func: () => buscarEnPexels(querySeleccionada) },
        { nombre: 'Google Images', func: () => buscarEnGoogle(querySeleccionada) }
    ];
    
    for (const fuente of fuentes) {
        const resultado = await fuente.func();
        if (resultado) {
            console.log(`✅ Imagen encontrada en ${fuente.nombre}`);
            return resultado;
        }
    }
    
    console.log('🖼️ Usando imágenes de respaldo de alta calidad');
    
    const imagenesPorCategoria = {
        'kitchen': imagenesPexelsDirectas.filter(img => img.includes('2635038') || img.includes('1571460') || img.includes('280229')),
        'bedroom': imagenesPexelsDirectas.filter(img => img.includes('1648772') || img.includes('1457842') || img.includes('1648776')),
        'bathroom': imagenesPexelsDirectas.filter(img => img.includes('2635646') || img.includes('2635638') || img.includes('1571455')),
        'living': imagenesPexelsDirectas.filter(img => img.includes('1571459') || img.includes('1571463') || img.includes('1571465')),
        'office': imagenesPexelsDirectas.filter(img => img.includes('1571469') || img.includes('1571470')),
        'outdoor': imagenesPexelsDirectas.filter(img => img.includes('1571462') || img.includes('1571464')),
        'tech': imagenesPexelsDirectas.filter(img => img.includes('280229') || img.includes('258154')),
        'luxury': imagenesPexelsDirectas
    };
    
    const imagenesCategoria = imagenesPorCategoria[categoriaDetectada] || imagenesPexelsDirectas;
    const timestamp = Date.now();
    const indiceTemporal = Math.floor(timestamp / 3600000) % imagenesCategoria.length;
    const indiceAleatorio = Math.floor(Math.random() * imagenesCategoria.length);
    const indiceFinal = (indiceTemporal + indiceAleatorio) % imagenesCategoria.length;
    const imagenSeleccionada = imagenesCategoria[indiceFinal];
    
    console.log(`🖼️ Imagen fallback #${indiceFinal + 1}/${imagenesCategoria.length} (categoría: ${categoriaDetectada})`);
    
    return {
        url: imagenSeleccionada,
        fuente: 'fallback',
        alt: `${categoriaDetectada} luxury home interior`
    };
}

// ============================================================
// GENERAR CURIOSIDAD CON GEMINI 2.0/2.5
// ============================================================
async function generarCuriosidadConGemini() {
    const angulo = actualizarAnguloVenta();
    const temaIndex = Math.floor(Date.now() / 3600000) % TEMAS_SEO.length;
    const tema = TEMAS_SEO[temaIndex];
    
    // Números aleatorios para datos estadísticos (más creíbles)
    const porcentaje1 = Math.floor(Math.random() * 35 + 60); // 60-95%
    const porcentaje2 = Math.floor(Math.random() * 40 + 150); // 150-190%
    const cifraMillones = Math.floor(Math.random() * 8 + 2); // 2-10 millones
    
    const promptAdaptativo = `
Eres un estratega de marketing de alto nivel especializado en el mercado de lujo de USA para mujeres de alto poder adquisitivo (NYC, Miami, Beverly Hills, Hamptons).
Tu misión: Crear una "Curiosidad Trampa" VIRAL que genere clics hacia productos de Amazon de lujo.

${instruccionesAngulo[angulo]}

DATOS PARA INCORPORAR (usa los que mejor encajen):
- Dato 1: El ${porcentaje1}% de mujeres en Manhattan ya...
- Dato 2: Las ventas de esta categoría crecieron un ${porcentaje2}% en 2026
- Dato 3: El mercado de lujo en USA mueve $${cifraMillones}B anuales en este sector

TEMA BASE: "${tema.tema}"
KEYWORD EN: "${tema.kw_en}"
KEYWORD ES: "${tema.kw_es}"

REGLAS ESTRICTAS:
1. **Define un Producto Específico:** Crea un productoSugeridoTipo realista y comercial (ej. "espejo inteligente con IA", "purificador de agua de cuarzo", "difusor de aromaterapia de lujo", "juego de sábanas de seda Mulberry").
2. **Título Clickbait:** Debe incluir un número impactante o un beneficio de estatus. Máximo 70 caracteres.
3. **Texto Persuasivo:** 2-3 oraciones que crean un problema aspiracional y presentan el producto como la solución de lujo inevitable.
4. **Ubicaciones Específicas:** Menciona NYC, Manhattan, Beverly Hills, Miami, Hamptons o Soho según el contexto.
5. **CTA Explicito:** La última oración debe invitar al clic. Ej: "Descubre cuál es el modelo que todas están instalando en nuestra selección exclusiva."

RESPONDE SOLO CON JSON VÁLIDO (sin markdown, solo el JSON):
{
    "titulo_es": "Título en español con número y gancho",
    "titulo_en": "SEO title in English with keyword and hook",
    "texto_es": "2-3 oraciones persuasivas en español",
    "texto_en": "2-3 persuasive sentences in English",
    "descripcion_visual_es": "Descripción sensorial de la imagen/lujo en español",
    "descripcion_visual_en": "Sensory description of the image/luxury in English",
    "meta_descripcion_en": "Meta description 155 chars max with keyword and CTA",
    "productoSugeridoTipo": "Tipo específico de producto Amazon (ej. smart mirror, water filter, luxury candle)",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;

    const fallback = {
        titulo_es: `El ${porcentaje1}% de mujeres en NYC ya conoce este secreto de lujo que transforma hogares`,
        titulo_en: `Best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026: What NYC Women Are Buying Now`,
        texto_es: `Las estadísticas revelan que el ${porcentaje1}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo en tecnología para el hogar. Los diseñadores de interiores de Beverly Hills confirman que es el elemento que más valor añade. ¿Ya eres de las que saben?`,
        texto_en: `Statistics show that ${porcentaje1}% of high-income women in Manhattan are now investing in home technology. Beverly Hills interior designers confirm it's the most value-adding element. Are you one of them?`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus. Ese acabado que ves es el nuevo lujo silencioso que distingue a las mujeres que saben.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status. That finish you see is the new quiet luxury that sets discerning women apart.",
        meta_descripcion_en: `Discover the best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026. What NYC, Miami and Beverly Hills women are investing in for their homes.`,
        productoSugeridoTipo: `${tema.tema.split(' ')[0]} luxury home product`,
        palabras_clave: [tema.kw_en, "luxury home 2026", "women lifestyle"]
    };

    if (!isGeminiAvailable || !model) {
        console.log('⚠️ Gemini no disponible, usando fallback');
        return { ...fallback, anguloUsado: angulo };
    }

    try {
        console.log(`🤖 Generando curiosidad con Gemini ${modeloUsado} - Ángulo ${angulo}: ${descripcionAngulos[angulo]}`);
        const result = await model.generateContent(promptAdaptativo);
        const text = result.response.text();
        
        // Limpiar respuesta JSON
        let clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        // A veces Gemini añade texto antes del JSON
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) clean = jsonMatch[0];
        
        const data = JSON.parse(clean);
        
        // Validar campos requeridos
        const curiosidadFinal = {
            titulo_es: data.titulo_es || fallback.titulo_es,
            titulo_en: data.titulo_en || fallback.titulo_en,
            texto_es: data.texto_es || fallback.texto_es,
            texto_en: data.texto_en || fallback.texto_en,
            descripcion_visual_es: data.descripcion_visual_es || fallback.descripcion_visual_es,
            descripcion_visual_en: data.descripcion_visual_en || fallback.descripcion_visual_en,
            meta_descripcion_en: data.meta_descripcion_en || fallback.meta_descripcion_en,
            productoSugeridoTipo: data.productoSugeridoTipo || fallback.productoSugeridoTipo,
            palabras_clave: data.palabras_clave || fallback.palabras_clave,
            anguloUsado: angulo
        };
        
        console.log(`✨ Curiosidad generada con Gemini ${modeloUsado}: "${curiosidadFinal.titulo_en}"`);
        console.log(`🎯 Producto sugerido: ${curiosidadFinal.productoSugeridoTipo}`);
        return curiosidadFinal;
    } catch(e) {
        console.log('⚠️ Error en Gemini:', e.message);
        return { ...fallback, anguloUsado: angulo };
    }
}

// ============================================================
// PUBLICAR CURIOSIDAD
// ============================================================
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando curiosidad ADAPTATIVA...');
    const g = await generarCuriosidadConGemini();
    
    const img = await buscarImagenPorContenido(g);
    
    // Buscar producto relacionado en artículos existentes
    let productoRelacionado = null;
    try {
        const articulos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const palabrasBusqueda = (g.productoSugeridoTipo + ' ' + (g.palabras_clave || []).join(' ')).toLowerCase();
        
        // Buscar artículos que coincidan con el producto sugerido
        const coincidencias = articulos.filter(art => {
            const tituloLower = (art.titulo || '').toLowerCase();
            const categoriaLower = (art.categoria || '').toLowerCase();
            return palabrasBusqueda.includes(tituloLower) || 
                   tituloLower.includes(g.productoSugeridoTipo.toLowerCase()) ||
                   categoriaLower.includes(g.productoSugeridoTipo.toLowerCase());
        });
        
        if (coincidencias.length > 0) {
            productoRelacionado = coincidencias[0];
            console.log(`🔗 Producto relacionado encontrado: ${productoRelacionado.titulo}`);
        }
    } catch(e) {
        console.log('⚠️ Error buscando producto relacionado:', e.message);
    }
    
    const nueva = {
        id: Date.now(),
        titulo_es: g.titulo_es,
        titulo_en: g.titulo_en,
        texto_es: g.texto_es,
        texto_en: g.texto_en,
        descripcion_visual_es: g.descripcion_visual_es,
        descripcion_visual_en: g.descripcion_visual_en,
        meta_descripcion_en: g.meta_descripcion_en,
        imagen: img.url,
        imagenFuente: img.fuente,
        productoSugeridoTipo: g.productoSugeridoTipo,
        palabras_clave: g.palabras_clave,
        anguloUsado: g.anguloUsado,
        productoRelacionado: productoRelacionado ? {
            id: productoRelacionado.id,
            titulo: productoRelacionado.titulo,
            link: productoRelacionado.link,
            imagen: productoRelacionado.imagen
        } : null,
        fecha: new Date().toISOString(),
        compartidas: 0,
        clicsGenerados: 0,
        categoria: 'luxury'
    };
    
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    data.unshift(nueva);
    if (data.length > 50) data.pop();
    fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
    
    // Actualizar estadísticas
    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
    stats.curiosidadesGeneradas++;
    stats.ultimaActualizacion = new Date().toISOString();
    fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
    
    console.log(`✅ Publicada: "${nueva.titulo_en}"`);
    console.log(`📷 Imagen desde: ${img.fuente}`);
    console.log(`🎯 Ángulo usado: ${descripcionAngulos[g.anguloUsado]}`);
    if (productoRelacionado) console.log(`🔗 Producto relacionado: ${productoRelacionado.titulo}`);
    
    return nueva;
}

// ============================================================
// GENERAR COPY PRODUCTO CON GEMINI 2.0/2.5
// ============================================================
async function generarCopyProductoConGemini(url, imagenUrl, categoria, precio) {
    const promptEstrategico = `
Eres un copywriter de lujo especializado en Amazon Affiliates para el mercado USA.
Tu objetivo es generar copy que convierta a mujeres de alto poder adquisitivo (NYC, Miami, Beverly Hills).

URL del producto: ${url}
CATEGORÍA: ${categoria || 'luxury home'}
PRECIO: ${precio || 'Premium'}

REGLAS DE CONVERSIÓN:
- Usa el ángulo de venta que mejor encaje: Estatus Puro, FOMO, Bio-Hacking o Inversión Inteligente
- Incluye un dato estadístico creíble (ej. "El 73% de las diseñadoras de interiores en Manhattan...")
- Menciona ubicaciones aspiracionales (NYC, Miami, Beverly Hills, Hamptons)
- Termina con un CTA urgente

RESPONDE SOLO CON JSON VÁLIDO:
{
    "titulo": "SEO title con keyword, max 70 chars",
    "meta_descripcion": "Meta description 155 chars con CTA",
    "intro": "Hook impactante con dato o pregunta provocadora",
    "descripcion_visual": "Descripción que conecta la imagen con el lujo",
    "problema": "El problema aspiracional que resuelve",
    "solucion": "Cómo este producto específico lo resuelve",
    "beneficio_estatus": "Beneficio de estatus que aporta",
    "prueba_social": "Testimonio con nombre y ciudad USA",
    "cierre": "Frase FOMO que impulse el clic",
    "curiosidad": "Dato estadístico impactante",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;

    const fallback = {
        titulo: "Best Luxury Home Investment 2026: What NYC Women Are Buying",
        meta_descripcion: "Discover why NYC, Miami and Beverly Hills women are investing in this luxury home product. Limited availability.",
        intro: "There's one detail interior designers can't stop recommending — and it costs less than a designer bag.",
        descripcion_visual: "Look at the clean lines you see in the image — that's not just design, that's intention. That's the difference between a house and a sanctuary.",
        problema: "Your home still feels like it's missing that intangible something. That quiet confidence that says 'I've arrived'.",
        solucion: "This piece transforms ordinary spaces into extraordinary experiences. It's the detail that makes guests ask 'where did you find this?'",
        beneficio_estatus: "Women who own this let their space speak for them. It's the silent signal of impeccable taste.",
        prueba_social: "Gabriela from Miami: 'Three guests have asked me where I found it. My interior designer was impressed I found it myself.'",
        cierre: "That design you see won't wait. The 2026 collection is selling faster than anticipated.",
        curiosidad: `Interior designers report a ${Math.floor(Math.random() * 100 + 150)}% increase in requests for signature home pieces in 2026.`,
        palabras_clave: ["luxury home 2026", "best home investment", "NYC women lifestyle"]
    };

    if (!isGeminiAvailable || !model) return fallback;

    try {
        console.log(`🔥 Generando copy con Gemini ${modeloUsado}`);
        const result = await model.generateContent(promptEstrategico);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const copy = JSON.parse(clean);
        console.log(`🔥 Copy generado: "${copy.titulo}"`);
        return copy;
    } catch(e) {
        console.log('⚠️ Error en Gemini copy:', e.message);
        return fallback;
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy) {
    const pad = { small: '40px', medium: '20px', large: '10px' }[imageSize] || '20px';
    const maxH = imageSize === 'large' ? '600px' : imageSize === 'small' ? '280px' : '420px';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${copy.titulo}</title>
    <meta name="description" content="${copy.meta_descripcion || copy.curiosidad}">
    <meta name="keywords" content="${(copy.palabras_clave || []).join(', ')}">
    <meta property="og:title" content="${copy.titulo}">
    <meta property="og:description" content="${copy.meta_descripcion || copy.intro}">
    <meta property="og:image" content="${imagenUrl}">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${url}">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap');
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Inter',sans-serif; background:#fffaf7; color:#1a1a1a; line-height:1.6; }
        .hero { background:linear-gradient(135deg,#1a1a2e,#2d2d44); padding:80px 20px; text-align:center; position:relative; overflow:hidden; }
        .hero::before { content:''; position:absolute; top:0; left:0; right:0; bottom:0; background:url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="rgba(255,255,255,0.03)" d="M0,0 L100,0 L100,100 L0,100 Z M20,20 L80,20 L80,80 L20,80 Z"/></svg>'); opacity:0.5; }
        .hero h1 { font-family:'Playfair Display',serif; font-size:2.8rem; color:#fff; max-width:900px; margin:0 auto 20px; position:relative; z-index:1; font-weight:600; letter-spacing:-0.02em; }
        .hero .fact-pill { display:inline-block; background:linear-gradient(135deg,#ff6b35,#ff4500); color:#fff; padding:12px 28px; border-radius:50px; font-size:14px; font-weight:600; letter-spacing:0.5px; position:relative; z-index:1; box-shadow:0 4px 15px rgba(255,69,0,0.3); }
        .article-body { max-width:850px; margin:0 auto; padding:60px 24px; }
        .intro-lead { font-family:'Playfair Display',serif; font-size:1.3rem; color:#4a3727; border-left:4px solid #ff4500; padding-left:24px; margin:40px 0; font-style:italic; font-weight:500; }
        .product-image-wrap { text-align:${imagePosition || 'center'}; margin:45px 0; background:#faf7f3; border-radius:24px; padding:${pad}; box-shadow:0 10px 30px rgba(0,0,0,0.05); }
        .product-image-wrap img { max-width:100%; border-radius:16px; object-fit:contain; max-height:${maxH}; box-shadow:0 8px 25px rgba(0,0,0,0.1); }
        .visual-description { background:linear-gradient(135deg,#fff5f0,#fdf0e8); border-left:4px solid #c9a87b; padding:28px 32px; border-radius:0 20px 20px 0; margin:35px 0; font-family:'Playfair Display',serif; font-style:italic; font-size:1.1rem; color:#2c2418; }
        h2 { font-family:'Playfair Display',serif; font-size:1.6rem; color:#2c2418; margin:50px 0 16px; font-weight:600; letter-spacing:-0.01em; }
        p { color:#3a2e24; margin-bottom:20px; font-size:1.05rem; line-height:1.7; }
        .social-proof { background:#fff; border:1px solid #f0e2d8; border-left:4px solid #ff4500; padding:28px; border-radius:0 20px 20px 0; margin:35px 0; font-style:italic; box-shadow:0 5px 20px rgba(0,0,0,0.03); }
        .social-proof strong { display:block; margin-top:12px; color:#ff4500; font-style:normal; }
        .btn-buy { display:block; background:linear-gradient(135deg,#ff4500,#ff6b35); color:#fff; padding:18px 35px; text-decoration:none; border-radius:60px; font-weight:700; text-align:center; margin:45px 0; transition:all 0.3s ease; font-size:1.1rem; letter-spacing:0.5px; box-shadow:0 5px 20px rgba(255,69,0,0.3); }
        .btn-buy:hover { transform:translateY(-3px); box-shadow:0 8px 30px rgba(255,69,0,0.4); }
        .stat-box { background:linear-gradient(135deg,#1a1a2e,#2d2d44); color:#fff; padding:32px; border-radius:24px; margin:40px 0; text-align:center; }
        .stat-box p { color:#fff; margin:0; font-size:1.1rem; font-weight:500; }
        footer { margin-top:70px; padding:35px 0; border-top:1px solid #f0e2d8; font-size:12px; text-align:center; color:#8b7355; }
        @media(max-width:650px){ .hero h1{font-size:1.8rem} .intro-lead{font-size:1.1rem} .article-body{padding:40px 20px} }
    </style>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
        <span class="fact-pill">✨ ${copy.curiosidad}</span>
    </div>
    <div class="article-body">
        <div class="intro-lead">${copy.intro}</div>
        <div class="product-image-wrap">
            <img src="${imagenUrl}" alt="${copy.titulo}" loading="lazy">
        </div>
        <div class="visual-description">✨ ${copy.descripcion_visual}</div>
        <h2>Why This Changes Everything</h2>
        <p>${copy.problema}</p>
        <p>${copy.solucion}</p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">🔴 CHECK PRICE ON AMAZON →</a>
        <h2>The New Status Signal</h2>
        <p>${copy.beneficio_estatus}</p>
        <div class="social-proof">
            "${copy.prueba_social}"
            <strong>⭐⭐⭐⭐⭐ Verified Purchase</strong>
        </div>
        <div class="stat-box">
            <p>💎 ${copy.cierre}</p>
        </div>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">🔥 GET IT ON AMAZON →</a>
        <footer>
            <p>As an Amazon Associate we earn from qualifying purchases. | © 2026 MXL GOLD MINER</p>
        </footer>
    </div>
</body>
</html>`;
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), modelo: modeloUsado }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// Curiosidades
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const c = await publicarCuriosidadAutomatica();
        res.json({ success: true, curiosidad: c });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) { res.json([]); }
});

app.delete('/api/curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const filteredData = data.filter(c => c.id != req.params.id);
        if (filteredData.length === data.length) {
            return res.status(404).json({ success: false, error: 'Curiosidad no encontrada' });
        }
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(filteredData, null, 2));
        cache.delete('curiosidades');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/curiosidades/all', (req, res) => {
    try {
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
        cache.delete('curiosidades');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/curiosidad/:id/refrescar-imagen', async (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const index = data.findIndex(c => c.id == req.params.id);
        if (index === -1) {
            return res.status(404).json({ success: false, error: 'Curiosidad no encontrada' });
        }
        const nuevaImagen = await buscarImagenPorContenido(data[index]);
        data[index].imagen = nuevaImagen.url;
        data[index].imagenFuente = nuevaImagen.fuente;
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        cache.delete('curiosidades');
        res.json({ success: true, imagen: nuevaImagen });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const i = data.findIndex(c => c.id == req.params.id);
        if (i !== -1) {
            data[i].compartidas = (data[i].compartidas || 0) + 1;
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// Productos
app.post('/api/generar-copy-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, precio } = req.body;
        if (!url) return res.status(400).json({ success: false, error: 'URL requerida' });
        if (!imagenUrl) return res.status(400).json({ success: false, error: 'URL imagen requerida' });
        const copy = await generarCopyProductoConGemini(url, imagenUrl, categoria, precio);
        res.json({ success: true, copy });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/publicar-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, imageSize, imagePosition, copy } = req.body;
        if (!url || !imagenUrl || !copy) return res.status(400).json({ success: false, error: 'Faltan datos' });
        const html = generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy);
        const art = {
            id: Date.now(), asin: extraerASIN(url),
            titulo: copy.titulo, meta: copy.meta_descripcion || copy.curiosidad,
            intro: copy.intro, curiosidad: copy.curiosidad,
            contenido: html, imagen: imagenUrl,
            imageSize: imageSize || 'medium', imagePosition: imagePosition || 'center',
            categoria: categoria || 'LUXURY', link: url,
            fecha: new Date().toISOString(), clicks: 0
        };
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(art);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        res.json({ success: true, articulo: art });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) { res.json([]); }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(req.body.articulos, null, 2));
        cache.clear();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) {
            data[i].clicks = (data[i].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            
            // Registrar clic para el feedback loop
            const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
            if (curiosidades.length > 0) {
                const ultimaCuriosidad = curiosidades[0];
                if (ultimaCuriosidad.anguloUsado && historialClics[ultimaCuriosidad.anguloUsado]) {
                    historialClics[ultimaCuriosidad.anguloUsado].push(Date.now());
                    
                    // Actualizar estadísticas
                    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
                    stats.totalClics++;
                    stats.clicsPorAngulo[ultimaCuriosidad.anguloUsado]++;
                    stats.ultimaActualizacion = new Date().toISOString();
                    fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
                    
                    console.log(`📊 Clic registrado para ángulo ${ultimaCuriosidad.anguloUsado}`);
                }
            }
        }
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.json({ success: false }); 
    }
});

app.get('/api/estadisticas', (req, res) => {
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        res.json({
            ...stats,
            anguloActual: anguloVentaActual,
            descripcionAngulo: descripcionAngulos[anguloVentaActual],
            modeloGemini: modeloUsado,
            geminiDisponible: isGeminiAvailable
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/api/gemini-status', (req, res) => {
    res.json({
        hasKey: !!process.env.GEMINI_API_KEY,
        isWorking: isGeminiAvailable,
        modeloUsado: modeloUsado,
        unsplashKey: !!process.env.UNSPLASH_ACCESS_KEY,
        googleKey: !!process.env.GOOGLE_API_KEY,
        pexelsKey: !!process.env.PEXELS_API_KEY
    });
});

// CRON - Cada 3 horas
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ CRON: Generando curiosidad adaptativa...');
    await publicarCuriosidadAutomatica();
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', async () => {
    const art = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const cur = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
    
    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                    🏮 MXL GOLD MINER — SISTEMA ADAPTATIVO 2026 🏮                   ║
╠══════════════════════════════════════════════════════════════════════╣
║  🤖 GEMINI: ${isGeminiAvailable ? `✅ ACTIVADO (${modeloUsado})` : '⚠️ NO DISPONIBLE'}                              ║
║                                                                       ║
║  🎯 SISTEMA DE ADAPTACIÓN: "EL VENENO SE ADAPTA"                     ║
║     Ángulo actual: ${descripcionAngulos[anguloVentaActual].padEnd(45)}║
║     Clics totales: ${String(stats.totalClics).padEnd(40)}║
║                                                                       ║
║  💎 CURIOSIDADES                                                      ║
║     ✅ Generadas: ${String(stats.curiosidadesGeneradas).padEnd(40)}║
║     ✅ Guardadas: ${String(cur).padEnd(44)}║
║     ✅ Rotación de ángulos automática                                ║
║     ✅ Producto relacionado automático                               ║
║                                                                       ║
║  💰 PRODUCTOS                                                         ║
║     📊 Publicados: ${String(art).padEnd(44)}║
║                                                                       ║
║  🖼️ FUENTES DE IMÁGENES:                                              ║
║     ${process.env.UNSPLASH_ACCESS_KEY ? '✅ Unsplash' : '⚠️ Unsplash'} | ${process.env.PEXELS_API_KEY ? '✅ Pexels API' : '⚠️ Pexels API'} | ${process.env.GOOGLE_API_KEY ? '✅ Google Images' : '⚠️ Google Images'} | ✅ Fallback (24+ imágenes)║
║                                                                       ║
║  🚀 Servidor corriendo en puerto: ${PORT}                                            ║
║  📊 Panel de control: http://localhost:${PORT}/panel                               ║
╚══════════════════════════════════════════════════════════════════════╝
    `);
    
    if (cur === 0) {
        console.log('📝 Generando primera curiosidad...');
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});const express = require('express');
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
app.use('/temp', express.static(path.join(__dirname, 'temp')));

const cache = new Map();
const CACHE_TTL = 300000;

// Inicializar Gemini - SOPORTE PARA 2.0 Y 2.5
let genAI, model;
let isGeminiAvailable = false;
let modeloUsado = 'gemini-1.5-flash'; // fallback

if (process.env.GEMINI_API_KEY) {
    try {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Detectar y usar el mejor modelo disponible
        const modelosDisponibles = [
            'gemini-2.5-pro-exp-03-25',  // Gemini 2.5 Pro (más potente)
            'gemini-2.0-flash-exp',       // Gemini 2.0 Flash (rápido)
            'gemini-2.0-flash',           // Gemini 2.0 Flash estable
            'gemini-1.5-flash',           // Fallback
            'gemini-1.5-pro'              // Fallback alternativo
        ];
        
        // Intentar usar el mejor modelo disponible
        for (const modelName of modelosDisponibles) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                // Probar con un ping rápido
                await testModel.generateContent('ping');
                model = testModel;
                modeloUsado = modelName;
                isGeminiAvailable = true;
                console.log(`✅ Gemini activado con modelo: ${modeloUsado}`);
                break;
            } catch (e) {
                console.log(`⚠️ Modelo ${modelName} no disponible, probando siguiente...`);
            }
        }
        
        if (!isGeminiAvailable) {
            // Fallback final
            model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            modeloUsado = "gemini-1.5-flash";
            isGeminiAvailable = true;
            console.log(`✅ Gemini activado con modelo fallback: ${modeloUsado}`);
        }
    } catch(e) {
        console.log('⚠️ Error inicializando Gemini:', e.message);
    }
}

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
if (!fs.existsSync(ESTADISTICAS_PATH)) fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify({
    totalClics: 0,
    clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
    curiosidadesGeneradas: 0,
    ultimaActualizacion: new Date().toISOString()
}));

function extraerASIN(url) {
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i,
        /\/dp\/([A-Z0-9]{10})/i
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

// ============================================================
// SISTEMA DE ADAPTACIÓN DE VENTAS (EL VENENO SE ADAPTA)
// ============================================================
let anguloVentaActual = 'A';
const historialClics = { A: [], B: [], C: [], D: [] };

function actualizarAnguloVenta() {
    const ahora = Date.now();
    const hace24h = ahora - 86400000;
    
    let mejorAngulo = 'A';
    let maxClics = -1;
    
    for (const [angulo, timestamps] of Object.entries(historialClics)) {
        const clicsUltimas24h = timestamps.filter(ts => ts > hace24h).length;
        if (clicsUltimas24h > maxClics) {
            maxClics = clicsUltimas24h;
            mejorAngulo = angulo;
        }
    }
    
    if (maxClics === 0) {
        const angulos = ['A', 'B', 'C', 'D'];
        const indiceActual = angulos.indexOf(anguloVentaActual);
        mejorAngulo = angulos[(indiceActual + 1) % angulos.length];
    }
    
    anguloVentaActual = mejorAngulo;
    console.log(`🔄 Ángulo de venta activo: ${anguloVentaActual} (${maxClics} clics últimas 24h)`);
    return anguloVentaActual;
}

const descripcionAngulos = {
    'A': 'ESTATUS PURO - Exclusividad y lujo silencioso',
    'B': 'FOMO - Escasez y tendencia imparable 2026',
    'C': 'BIO-HACKING - Salud, eficiencia y optimización',
    'D': 'INVERSIÓN INTELIGENTE - Activo que no deprecia'
};

const instruccionesAngulo = {
    'A': `Ángulo ESTATUS PURO: Enfócate en exclusividad, "lujo silencioso", materiales nobles, ediciones limitadas. La audiencia debe sentir que este producto la distingue de sus amigas. Usa frases como "el secreto que no cuentan en los showrooms de Soho", "el detalle que los diseñadores de interiores de Beverly Hills juran guardar en secreto", o "la única inversión que tu asesor financiero aprobaría sin preguntar".`,
    
    'B': `Ángulo FOMO (Fear Of Missing Out): Enfócate en la escasez y la tendencia imparable de 2026. Crea urgencia real. Usa datos como "más del 70% de las casas en los Hamptons ya lo incorporaron", "solo quedan 3 unidades en el distribuidor exclusivo de Miami", o "las mujeres que saben ya lo tienen instalado desde enero".`,
    
    'C': `Ángulo BIO-HACKING & WELLNESS: Enfócate en ganar tiempo, salud y eficiencia. Conecta el producto con longevidad, bienestar cognitivo y productividad. Usa términos como "optimización cognitiva", "rutina mañana de alto rendimiento", "el gadget que los CEO de Wall Street no mencionan en sus entrevistas", o "los 15 minutos que cambiarán tu salud este año".`,
    
    'D': `Ángulo INVERSIÓN INTELIGENTE: Enfócate en que el producto mantiene o aumenta el valor de la propiedad, es una inversión a largo plazo y tiene reventa asegurada. Usa frases como "el activo que los tasadores de bienes raíces en Manhattan ya están considerando", "el único gasto en tecnología que no deprecia", o "lo que los millonarios compran cuando el mercado baja".`
};

// ============================================================
// TEMAS SEO ROTATIVOS - EXPANDIDOS PARA GEMINI 2.5
// ============================================================
const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_es: "gadgets de lujo hogar 2026", kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury", kw_es: "spa en casa lujo baño", kw_en: "luxury home spa bathroom ideas" },
    { tema: "luxury kitchen appliances women NYC", kw_es: "cocina de lujo electrodomésticos", kw_en: "luxury kitchen appliances NYC women" },
    { tema: "minimalist luxury bedroom decor 2026", kw_es: "dormitorio minimalista lujo", kw_en: "minimalist luxury bedroom 2026" },
    { tema: "smart home automation Beverly Hills", kw_es: "hogar inteligente automatización", kw_en: "smart home automation Beverly Hills" },
    { tema: "luxury home office women entrepreneur", kw_es: "oficina en casa mujer emprendedora", kw_en: "luxury home office women 2026" },
    { tema: "sustainable luxury home eco design", kw_es: "hogar sostenible lujo eco", kw_en: "sustainable luxury home design" },
    { tema: "luxury home fragrance candles", kw_es: "fragancias hogar velas lujo", kw_en: "luxury home fragrance best 2026" },
    { tema: "luxury outdoor living Miami terrace", kw_es: "terraza lujo Miami exterior", kw_en: "luxury outdoor living Miami" },
    { tema: "high end morning routine luxury home", kw_es: "rutina mañana mujer lujo", kw_en: "luxury morning routine home 2026" },
    { tema: "luxury water purifier home health", kw_es: "purificador agua lujo hogar", kw_en: "best luxury water purifier home" },
    { tema: "smart mirror beauty luxury women", kw_es: "espejo inteligente belleza lujo", kw_en: "smart mirror luxury beauty women" },
    { tema: "luxury home theater setup 2026", kw_es: "cine en casa lujo", kw_en: "luxury home theater setup 2026" },
    { tema: "designer furniture NYC luxury", kw_es: "muebles de diseñador lujo", kw_en: "designer luxury furniture NYC" },
    { tema: "luxury home gym equipment women", kw_es: "gimnasio en casa lujo mujer", kw_en: "luxury home gym equipment women" },
    { tema: "artificial intelligence home concierge", kw_es: "conserje inteligente hogar", kw_en: "AI home concierge luxury 2026" },
    { tema: "luxury wine cellar smart technology", kw_es: "bodega inteligente lujo", kw_en: "smart luxury wine cellar 2026" },
    { tema: "meditation room design luxury", kw_es: "sala meditación diseño lujo", kw_en: "luxury meditation room design" },
    { tema: "pet luxury home accessories", kw_es: "accesorios lujo para mascotas", kw_en: "luxury pet accessories home 2026" },
    { tema: "home art collection lighting", kw_es: "iluminación colección arte", kw_en: "luxury art lighting home 2026" }
];

// ============================================================
// MÚLTIPLES FUENTES DE IMÁGENES
// ============================================================

async function buscarEnUnsplash(query) {
    if (!process.env.UNSPLASH_ACCESS_KEY) return null;
    
    try {
        const paginaAleatoria = Math.floor(Math.random() * 5) + 1;
        const response = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: query,
                per_page: 15,
                page: paginaAleatoria,
                orientation: 'landscape',
                order_by: 'relevant'
            },
            headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
            timeout: 8000
        });
        
        if (response.data.results && response.data.results.length > 0) {
            const randomIndex = Math.floor(Math.random() * Math.min(8, response.data.results.length));
            const imagen = response.data.results[randomIndex];
            return {
                url: imagen.urls.regular,
                fuente: 'unsplash',
                alt: imagen.alt_description || query
            };
        }
    } catch(e) {
        console.log('⚠️ Unsplash error:', e.message);
    }
    return null;
}

async function buscarEnPexels(query) {
    if (!process.env.PEXELS_API_KEY) return null;
    
    try {
        const response = await axios.get('https://api.pexels.com/v1/search', {
            params: {
                query: query,
                per_page: 10,
                orientation: 'landscape'
            },
            headers: { 'Authorization': process.env.PEXELS_API_KEY },
            timeout: 8000
        });
        
        if (response.data.photos && response.data.photos.length > 0) {
            const randomIndex = Math.floor(Math.random() * Math.min(5, response.data.photos.length));
            const imagen = response.data.photos[randomIndex];
            return {
                url: imagen.src.large,
                fuente: 'pexels',
                alt: query
            };
        }
    } catch(e) {
        console.log('⚠️ Pexels error:', e.message);
    }
    return null;
}

async function buscarEnGoogle(query) {
    if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CX) return null;
    
    try {
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: {
                key: process.env.GOOGLE_API_KEY,
                cx: process.env.GOOGLE_CX,
                q: query,
                searchType: 'image',
                num: 8,
                imgSize: 'large',
                imgType: 'photo'
            },
            timeout: 8000
        });
        
        if (response.data.items && response.data.items.length > 0) {
            const randomIndex = Math.floor(Math.random() * Math.min(5, response.data.items.length));
            const imagen = response.data.items[randomIndex];
            return {
                url: imagen.link,
                fuente: 'google',
                alt: imagen.title || query
            };
        }
    } catch(e) {
        console.log('⚠️ Google Images error:', e.message);
    }
    return null;
}

const imagenesPexelsDirectas = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
    'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
    'https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg',
    'https://images.pexels.com/photos/258154/pexels-photo-258154.jpeg',
    'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg',
    'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
    'https://images.pexels.com/photos/1648772/pexels-photo-1648772.jpeg',
    'https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg',
    'https://images.pexels.com/photos/1571459/pexels-photo-1571459.jpeg',
    'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg',
    'https://images.pexels.com/photos/1571465/pexels-photo-1571465.jpeg',
    'https://images.pexels.com/photos/2635646/pexels-photo-2635646.jpeg',
    'https://images.pexels.com/photos/2635638/pexels-photo-2635638.jpeg',
    'https://images.pexels.com/photos/1571455/pexels-photo-1571455.jpeg',
    'https://images.pexels.com/photos/279746/pexels-photo-279746.jpeg',
    'https://images.pexels.com/photos/1571466/pexels-photo-1571466.jpeg',
    'https://images.pexels.com/photos/1571462/pexels-photo-1571462.jpeg',
    'https://images.pexels.com/photos/1571464/pexels-photo-1571464.jpeg',
    'https://images.pexels.com/photos/1571469/pexels-photo-1571469.jpeg',
    'https://images.pexels.com/photos/1571470/pexels-photo-1571470.jpeg',
    'https://images.pexels.com/photos/1648776/pexels-photo-1648776.jpeg',
    'https://images.pexels.com/photos/1457847/pexels-photo-1457847.jpeg',
    'https://images.pexels.com/photos/2635039/pexels-photo-2635039.jpeg',
    'https://images.pexels.com/photos/1571458/pexels-photo-1571458.jpeg'
];

async function buscarImagenPorContenido(curiosidad) {
    const contenidoCompleto = `${curiosidad.titulo_es || ''} ${curiosidad.titulo_en || ''} ${curiosidad.texto_es || ''} ${curiosidad.texto_en || ''} ${curiosidad.productoSugeridoTipo || ''}`.toLowerCase();
    
    const categorias = {
        'kitchen': ['kitchen', 'cocina', 'cooking', 'gourmet', 'food', 'chef', 'appliance', 'refrigerator', 'oven'],
        'bedroom': ['bedroom', 'dormitorio', 'sleep', 'bed', 'cozy', 'mattress', 'linen', 'pillow'],
        'bathroom': ['bathroom', 'baño', 'spa', 'shower', 'bath', 'wellness', 'relax', 'mirror', 'vanity'],
        'living': ['living', 'sala', 'sofa', 'couch', 'tv', 'entertainment', 'coffee table'],
        'office': ['office', 'oficina', 'desk', 'work', 'study', 'entrepreneur', 'chair', 'monitor'],
        'outdoor': ['outdoor', 'exterior', 'terrace', 'garden', 'pool', 'patio', 'deck', 'backyard'],
        'tech': ['smart', 'gadget', 'tech', 'technology', 'digital', 'automation', 'mirror', 'speaker', 'ai'],
        'wellness': ['wellness', 'health', 'fitness', 'gym', 'relaxation', 'meditation', 'yoga', 'spa'],
        'decor': ['decor', 'decoration', 'style', 'design', 'furniture', 'elegant', 'art', 'lighting'],
        'luxury': ['luxury', 'lujo', 'elegant', 'premium', 'high-end', 'exclusive', 'designer']
    };
    
    let categoriaDetectada = 'luxury';
    for (const [categoria, palabras] of Object.entries(categorias)) {
        for (const palabra of palabras) {
            if (contenidoCompleto.includes(palabra)) {
                categoriaDetectada = categoria;
                break;
            }
        }
    }
    
    const ubicaciones = ['nyc', 'new york', 'manhattan', 'beverly hills', 'miami', 'brickell', 'coral gables', 'los angeles', 'california', 'hamptons'];
    let ubicacionDetectada = null;
    for (const ubicacion of ubicaciones) {
        if (contenidoCompleto.includes(ubicacion)) {
            ubicacionDetectada = ubicacion;
            break;
        }
    }
    
    const palabrasClave = contenidoCompleto
        .split(' ')
        .filter(p => p.length > 4 && !['para', 'como', 'que', 'una', 'las', 'los', 'con', 'sin', 'por', 'del', 'mujer', 'women', 'home', 'house', 'luxury', 'interior', 'design'].includes(p))
        .slice(0, 4);
    
    let queries = [];
    
    if (ubicacionDetectada) {
        queries.push(`${categoriaDetectada} luxury home ${ubicacionDetectada}`);
        queries.push(`elegant ${categoriaDetectada} design ${ubicacionDetectada}`);
    }
    
    if (palabrasClave.length >= 2) {
        queries.push(`${palabrasClave[0]} ${palabrasClave[1]} luxury interior`);
        queries.push(`modern ${palabrasClave[0]} ${categoriaDetectada} design`);
    }
    
    const queriesPorCategoria = {
        'kitchen': ['luxury modern kitchen design', 'elegant kitchen interior', 'high end kitchen appliances', 'gourmet kitchen luxury', 'italian kitchen design'],
        'bedroom': ['luxury bedroom interior', 'elegant master bedroom', 'modern bedroom design', 'cozy luxury bedroom', 'minimalist bedroom luxury'],
        'bathroom': ['luxury bathroom spa', 'elegant bathroom design', 'modern bathroom interior', 'spa bathroom luxury', 'marble bathroom design'],
        'living': ['luxury living room', 'elegant living room interior', 'modern living room design', 'contemporary living room', 'grand salon luxury'],
        'office': ['luxury home office', 'elegant office interior', 'modern home office design', 'executive office luxury', 'women home office design'],
        'outdoor': ['luxury outdoor terrace', 'elegant patio design', 'modern outdoor living', 'garden luxury design', 'rooftop terrace luxury'],
        'tech': ['smart home technology', 'luxury smart home', 'modern tech home', 'automation luxury home', 'ai home technology'],
        'wellness': ['luxury home spa', 'wellness home design', 'elegant spa bathroom', 'relaxation luxury home', 'meditation room design'],
        'decor': ['luxury home decor', 'elegant interior design', 'modern home decoration', 'high end decor', 'designer home accessories'],
        'luxury': ['luxury home interior', 'elegant mansion interior', 'modern luxury design', 'high end home decor', 'luxury living spaces']
    };
    
    queries.push(...(queriesPorCategoria[categoriaDetectada] || queriesPorCategoria['luxury']));
    
    queries = [...new Set(queries)];
    const querySeleccionada = queries[Math.floor(Math.random() * queries.length)];
    
    console.log(`🔍 Categoría: ${categoriaDetectada}`);
    console.log(`🔍 Ubicación: ${ubicacionDetectada || 'no especificada'}`);
    console.log(`🔍 Query: "${querySeleccionada}"`);
    
    const fuentes = [
        { nombre: 'Unsplash', func: () => buscarEnUnsplash(querySeleccionada) },
        { nombre: 'Pexels API', func: () => buscarEnPexels(querySeleccionada) },
        { nombre: 'Google Images', func: () => buscarEnGoogle(querySeleccionada) }
    ];
    
    for (const fuente of fuentes) {
        const resultado = await fuente.func();
        if (resultado) {
            console.log(`✅ Imagen encontrada en ${fuente.nombre}`);
            return resultado;
        }
    }
    
    console.log('🖼️ Usando imágenes de respaldo de alta calidad');
    
    const imagenesPorCategoria = {
        'kitchen': imagenesPexelsDirectas.filter(img => img.includes('2635038') || img.includes('1571460') || img.includes('280229')),
        'bedroom': imagenesPexelsDirectas.filter(img => img.includes('1648772') || img.includes('1457842') || img.includes('1648776')),
        'bathroom': imagenesPexelsDirectas.filter(img => img.includes('2635646') || img.includes('2635638') || img.includes('1571455')),
        'living': imagenesPexelsDirectas.filter(img => img.includes('1571459') || img.includes('1571463') || img.includes('1571465')),
        'office': imagenesPexelsDirectas.filter(img => img.includes('1571469') || img.includes('1571470')),
        'outdoor': imagenesPexelsDirectas.filter(img => img.includes('1571462') || img.includes('1571464')),
        'tech': imagenesPexelsDirectas.filter(img => img.includes('280229') || img.includes('258154')),
        'luxury': imagenesPexelsDirectas
    };
    
    const imagenesCategoria = imagenesPorCategoria[categoriaDetectada] || imagenesPexelsDirectas;
    const timestamp = Date.now();
    const indiceTemporal = Math.floor(timestamp / 3600000) % imagenesCategoria.length;
    const indiceAleatorio = Math.floor(Math.random() * imagenesCategoria.length);
    const indiceFinal = (indiceTemporal + indiceAleatorio) % imagenesCategoria.length;
    const imagenSeleccionada = imagenesCategoria[indiceFinal];
    
    console.log(`🖼️ Imagen fallback #${indiceFinal + 1}/${imagenesCategoria.length} (categoría: ${categoriaDetectada})`);
    
    return {
        url: imagenSeleccionada,
        fuente: 'fallback',
        alt: `${categoriaDetectada} luxury home interior`
    };
}

// ============================================================
// GENERAR CURIOSIDAD CON GEMINI 2.0/2.5
// ============================================================
async function generarCuriosidadConGemini() {
    const angulo = actualizarAnguloVenta();
    const temaIndex = Math.floor(Date.now() / 3600000) % TEMAS_SEO.length;
    const tema = TEMAS_SEO[temaIndex];
    
    // Números aleatorios para datos estadísticos (más creíbles)
    const porcentaje1 = Math.floor(Math.random() * 35 + 60); // 60-95%
    const porcentaje2 = Math.floor(Math.random() * 40 + 150); // 150-190%
    const cifraMillones = Math.floor(Math.random() * 8 + 2); // 2-10 millones
    
    const promptAdaptativo = `
Eres un estratega de marketing de alto nivel especializado en el mercado de lujo de USA para mujeres de alto poder adquisitivo (NYC, Miami, Beverly Hills, Hamptons).
Tu misión: Crear una "Curiosidad Trampa" VIRAL que genere clics hacia productos de Amazon de lujo.

${instruccionesAngulo[angulo]}

DATOS PARA INCORPORAR (usa los que mejor encajen):
- Dato 1: El ${porcentaje1}% de mujeres en Manhattan ya...
- Dato 2: Las ventas de esta categoría crecieron un ${porcentaje2}% en 2026
- Dato 3: El mercado de lujo en USA mueve $${cifraMillones}B anuales en este sector

TEMA BASE: "${tema.tema}"
KEYWORD EN: "${tema.kw_en}"
KEYWORD ES: "${tema.kw_es}"

REGLAS ESTRICTAS:
1. **Define un Producto Específico:** Crea un productoSugeridoTipo realista y comercial (ej. "espejo inteligente con IA", "purificador de agua de cuarzo", "difusor de aromaterapia de lujo", "juego de sábanas de seda Mulberry").
2. **Título Clickbait:** Debe incluir un número impactante o un beneficio de estatus. Máximo 70 caracteres.
3. **Texto Persuasivo:** 2-3 oraciones que crean un problema aspiracional y presentan el producto como la solución de lujo inevitable.
4. **Ubicaciones Específicas:** Menciona NYC, Manhattan, Beverly Hills, Miami, Hamptons o Soho según el contexto.
5. **CTA Explicito:** La última oración debe invitar al clic. Ej: "Descubre cuál es el modelo que todas están instalando en nuestra selección exclusiva."

RESPONDE SOLO CON JSON VÁLIDO (sin markdown, solo el JSON):
{
    "titulo_es": "Título en español con número y gancho",
    "titulo_en": "SEO title in English with keyword and hook",
    "texto_es": "2-3 oraciones persuasivas en español",
    "texto_en": "2-3 persuasive sentences in English",
    "descripcion_visual_es": "Descripción sensorial de la imagen/lujo en español",
    "descripcion_visual_en": "Sensory description of the image/luxury in English",
    "meta_descripcion_en": "Meta description 155 chars max with keyword and CTA",
    "productoSugeridoTipo": "Tipo específico de producto Amazon (ej. smart mirror, water filter, luxury candle)",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;

    const fallback = {
        titulo_es: `El ${porcentaje1}% de mujeres en NYC ya conoce este secreto de lujo que transforma hogares`,
        titulo_en: `Best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026: What NYC Women Are Buying Now`,
        texto_es: `Las estadísticas revelan que el ${porcentaje1}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo en tecnología para el hogar. Los diseñadores de interiores de Beverly Hills confirman que es el elemento que más valor añade. ¿Ya eres de las que saben?`,
        texto_en: `Statistics show that ${porcentaje1}% of high-income women in Manhattan are now investing in home technology. Beverly Hills interior designers confirm it's the most value-adding element. Are you one of them?`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus. Ese acabado que ves es el nuevo lujo silencioso que distingue a las mujeres que saben.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status. That finish you see is the new quiet luxury that sets discerning women apart.",
        meta_descripcion_en: `Discover the best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026. What NYC, Miami and Beverly Hills women are investing in for their homes.`,
        productoSugeridoTipo: `${tema.tema.split(' ')[0]} luxury home product`,
        palabras_clave: [tema.kw_en, "luxury home 2026", "women lifestyle"]
    };

    if (!isGeminiAvailable || !model) {
        console.log('⚠️ Gemini no disponible, usando fallback');
        return { ...fallback, anguloUsado: angulo };
    }

    try {
        console.log(`🤖 Generando curiosidad con Gemini ${modeloUsado} - Ángulo ${angulo}: ${descripcionAngulos[angulo]}`);
        const result = await model.generateContent(promptAdaptativo);
        const text = result.response.text();
        
        // Limpiar respuesta JSON
        let clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        // A veces Gemini añade texto antes del JSON
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) clean = jsonMatch[0];
        
        const data = JSON.parse(clean);
        
        // Validar campos requeridos
        const curiosidadFinal = {
            titulo_es: data.titulo_es || fallback.titulo_es,
            titulo_en: data.titulo_en || fallback.titulo_en,
            texto_es: data.texto_es || fallback.texto_es,
            texto_en: data.texto_en || fallback.texto_en,
            descripcion_visual_es: data.descripcion_visual_es || fallback.descripcion_visual_es,
            descripcion_visual_en: data.descripcion_visual_en || fallback.descripcion_visual_en,
            meta_descripcion_en: data.meta_descripcion_en || fallback.meta_descripcion_en,
            productoSugeridoTipo: data.productoSugeridoTipo || fallback.productoSugeridoTipo,
            palabras_clave: data.palabras_clave || fallback.palabras_clave,
            anguloUsado: angulo
        };
        
        console.log(`✨ Curiosidad generada con Gemini ${modeloUsado}: "${curiosidadFinal.titulo_en}"`);
        console.log(`🎯 Producto sugerido: ${curiosidadFinal.productoSugeridoTipo}`);
        return curiosidadFinal;
    } catch(e) {
        console.log('⚠️ Error en Gemini:', e.message);
        return { ...fallback, anguloUsado: angulo };
    }
}

// ============================================================
// PUBLICAR CURIOSIDAD
// ============================================================
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando curiosidad ADAPTATIVA...');
    const g = await generarCuriosidadConGemini();
    
    const img = await buscarImagenPorContenido(g);
    
    // Buscar producto relacionado en artículos existentes
    let productoRelacionado = null;
    try {
        const articulos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const palabrasBusqueda = (g.productoSugeridoTipo + ' ' + (g.palabras_clave || []).join(' ')).toLowerCase();
        
        // Buscar artículos que coincidan con el producto sugerido
        const coincidencias = articulos.filter(art => {
            const tituloLower = (art.titulo || '').toLowerCase();
            const categoriaLower = (art.categoria || '').toLowerCase();
            return palabrasBusqueda.includes(tituloLower) || 
                   tituloLower.includes(g.productoSugeridoTipo.toLowerCase()) ||
                   categoriaLower.includes(g.productoSugeridoTipo.toLowerCase());
        });
        
        if (coincidencias.length > 0) {
            productoRelacionado = coincidencias[0];
            console.log(`🔗 Producto relacionado encontrado: ${productoRelacionado.titulo}`);
        }
    } catch(e) {
        console.log('⚠️ Error buscando producto relacionado:', e.message);
    }
    
    const nueva = {
        id: Date.now(),
        titulo_es: g.titulo_es,
        titulo_en: g.titulo_en,
        texto_es: g.texto_es,
        texto_en: g.texto_en,
        descripcion_visual_es: g.descripcion_visual_es,
        descripcion_visual_en: g.descripcion_visual_en,
        meta_descripcion_en: g.meta_descripcion_en,
        imagen: img.url,
        imagenFuente: img.fuente,
        productoSugeridoTipo: g.productoSugeridoTipo,
        palabras_clave: g.palabras_clave,
        anguloUsado: g.anguloUsado,
        productoRelacionado: productoRelacionado ? {
            id: productoRelacionado.id,
            titulo: productoRelacionado.titulo,
            link: productoRelacionado.link,
            imagen: productoRelacionado.imagen
        } : null,
        fecha: new Date().toISOString(),
        compartidas: 0,
        clicsGenerados: 0,
        categoria: 'luxury'
    };
    
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    data.unshift(nueva);
    if (data.length > 50) data.pop();
    fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
    
    // Actualizar estadísticas
    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
    stats.curiosidadesGeneradas++;
    stats.ultimaActualizacion = new Date().toISOString();
    fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
    
    console.log(`✅ Publicada: "${nueva.titulo_en}"`);
    console.log(`📷 Imagen desde: ${img.fuente}`);
    console.log(`🎯 Ángulo usado: ${descripcionAngulos[g.anguloUsado]}`);
    if (productoRelacionado) console.log(`🔗 Producto relacionado: ${productoRelacionado.titulo}`);
    
    return nueva;
}

// ============================================================
// GENERAR COPY PRODUCTO CON GEMINI 2.0/2.5
// ============================================================
async function generarCopyProductoConGemini(url, imagenUrl, categoria, precio) {
    const promptEstrategico = `
Eres un copywriter de lujo especializado en Amazon Affiliates para el mercado USA.
Tu objetivo es generar copy que convierta a mujeres de alto poder adquisitivo (NYC, Miami, Beverly Hills).

URL del producto: ${url}
CATEGORÍA: ${categoria || 'luxury home'}
PRECIO: ${precio || 'Premium'}

REGLAS DE CONVERSIÓN:
- Usa el ángulo de venta que mejor encaje: Estatus Puro, FOMO, Bio-Hacking o Inversión Inteligente
- Incluye un dato estadístico creíble (ej. "El 73% de las diseñadoras de interiores en Manhattan...")
- Menciona ubicaciones aspiracionales (NYC, Miami, Beverly Hills, Hamptons)
- Termina con un CTA urgente

RESPONDE SOLO CON JSON VÁLIDO:
{
    "titulo": "SEO title con keyword, max 70 chars",
    "meta_descripcion": "Meta description 155 chars con CTA",
    "intro": "Hook impactante con dato o pregunta provocadora",
    "descripcion_visual": "Descripción que conecta la imagen con el lujo",
    "problema": "El problema aspiracional que resuelve",
    "solucion": "Cómo este producto específico lo resuelve",
    "beneficio_estatus": "Beneficio de estatus que aporta",
    "prueba_social": "Testimonio con nombre y ciudad USA",
    "cierre": "Frase FOMO que impulse el clic",
    "curiosidad": "Dato estadístico impactante",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;

    const fallback = {
        titulo: "Best Luxury Home Investment 2026: What NYC Women Are Buying",
        meta_descripcion: "Discover why NYC, Miami and Beverly Hills women are investing in this luxury home product. Limited availability.",
        intro: "There's one detail interior designers can't stop recommending — and it costs less than a designer bag.",
        descripcion_visual: "Look at the clean lines you see in the image — that's not just design, that's intention. That's the difference between a house and a sanctuary.",
        problema: "Your home still feels like it's missing that intangible something. That quiet confidence that says 'I've arrived'.",
        solucion: "This piece transforms ordinary spaces into extraordinary experiences. It's the detail that makes guests ask 'where did you find this?'",
        beneficio_estatus: "Women who own this let their space speak for them. It's the silent signal of impeccable taste.",
        prueba_social: "Gabriela from Miami: 'Three guests have asked me where I found it. My interior designer was impressed I found it myself.'",
        cierre: "That design you see won't wait. The 2026 collection is selling faster than anticipated.",
        curiosidad: `Interior designers report a ${Math.floor(Math.random() * 100 + 150)}% increase in requests for signature home pieces in 2026.`,
        palabras_clave: ["luxury home 2026", "best home investment", "NYC women lifestyle"]
    };

    if (!isGeminiAvailable || !model) return fallback;

    try {
        console.log(`🔥 Generando copy con Gemini ${modeloUsado}`);
        const result = await model.generateContent(promptEstrategico);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const copy = JSON.parse(clean);
        console.log(`🔥 Copy generado: "${copy.titulo}"`);
        return copy;
    } catch(e) {
        console.log('⚠️ Error en Gemini copy:', e.message);
        return fallback;
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy) {
    const pad = { small: '40px', medium: '20px', large: '10px' }[imageSize] || '20px';
    const maxH = imageSize === 'large' ? '600px' : imageSize === 'small' ? '280px' : '420px';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${copy.titulo}</title>
    <meta name="description" content="${copy.meta_descripcion || copy.curiosidad}">
    <meta name="keywords" content="${(copy.palabras_clave || []).join(', ')}">
    <meta property="og:title" content="${copy.titulo}">
    <meta property="og:description" content="${copy.meta_descripcion || copy.intro}">
    <meta property="og:image" content="${imagenUrl}">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${url}">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap');
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Inter',sans-serif; background:#fffaf7; color:#1a1a1a; line-height:1.6; }
        .hero { background:linear-gradient(135deg,#1a1a2e,#2d2d44); padding:80px 20px; text-align:center; position:relative; overflow:hidden; }
        .hero::before { content:''; position:absolute; top:0; left:0; right:0; bottom:0; background:url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="rgba(255,255,255,0.03)" d="M0,0 L100,0 L100,100 L0,100 Z M20,20 L80,20 L80,80 L20,80 Z"/></svg>'); opacity:0.5; }
        .hero h1 { font-family:'Playfair Display',serif; font-size:2.8rem; color:#fff; max-width:900px; margin:0 auto 20px; position:relative; z-index:1; font-weight:600; letter-spacing:-0.02em; }
        .hero .fact-pill { display:inline-block; background:linear-gradient(135deg,#ff6b35,#ff4500); color:#fff; padding:12px 28px; border-radius:50px; font-size:14px; font-weight:600; letter-spacing:0.5px; position:relative; z-index:1; box-shadow:0 4px 15px rgba(255,69,0,0.3); }
        .article-body { max-width:850px; margin:0 auto; padding:60px 24px; }
        .intro-lead { font-family:'Playfair Display',serif; font-size:1.3rem; color:#4a3727; border-left:4px solid #ff4500; padding-left:24px; margin:40px 0; font-style:italic; font-weight:500; }
        .product-image-wrap { text-align:${imagePosition || 'center'}; margin:45px 0; background:#faf7f3; border-radius:24px; padding:${pad}; box-shadow:0 10px 30px rgba(0,0,0,0.05); }
        .product-image-wrap img { max-width:100%; border-radius:16px; object-fit:contain; max-height:${maxH}; box-shadow:0 8px 25px rgba(0,0,0,0.1); }
        .visual-description { background:linear-gradient(135deg,#fff5f0,#fdf0e8); border-left:4px solid #c9a87b; padding:28px 32px; border-radius:0 20px 20px 0; margin:35px 0; font-family:'Playfair Display',serif; font-style:italic; font-size:1.1rem; color:#2c2418; }
        h2 { font-family:'Playfair Display',serif; font-size:1.6rem; color:#2c2418; margin:50px 0 16px; font-weight:600; letter-spacing:-0.01em; }
        p { color:#3a2e24; margin-bottom:20px; font-size:1.05rem; line-height:1.7; }
        .social-proof { background:#fff; border:1px solid #f0e2d8; border-left:4px solid #ff4500; padding:28px; border-radius:0 20px 20px 0; margin:35px 0; font-style:italic; box-shadow:0 5px 20px rgba(0,0,0,0.03); }
        .social-proof strong { display:block; margin-top:12px; color:#ff4500; font-style:normal; }
        .btn-buy { display:block; background:linear-gradient(135deg,#ff4500,#ff6b35); color:#fff; padding:18px 35px; text-decoration:none; border-radius:60px; font-weight:700; text-align:center; margin:45px 0; transition:all 0.3s ease; font-size:1.1rem; letter-spacing:0.5px; box-shadow:0 5px 20px rgba(255,69,0,0.3); }
        .btn-buy:hover { transform:translateY(-3px); box-shadow:0 8px 30px rgba(255,69,0,0.4); }
        .stat-box { background:linear-gradient(135deg,#1a1a2e,#2d2d44); color:#fff; padding:32px; border-radius:24px; margin:40px 0; text-align:center; }
        .stat-box p { color:#fff; margin:0; font-size:1.1rem; font-weight:500; }
        footer { margin-top:70px; padding:35px 0; border-top:1px solid #f0e2d8; font-size:12px; text-align:center; color:#8b7355; }
        @media(max-width:650px){ .hero h1{font-size:1.8rem} .intro-lead{font-size:1.1rem} .article-body{padding:40px 20px} }
    </style>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
        <span class="fact-pill">✨ ${copy.curiosidad}</span>
    </div>
    <div class="article-body">
        <div class="intro-lead">${copy.intro}</div>
        <div class="product-image-wrap">
            <img src="${imagenUrl}" alt="${copy.titulo}" loading="lazy">
        </div>
        <div class="visual-description">✨ ${copy.descripcion_visual}</div>
        <h2>Why This Changes Everything</h2>
        <p>${copy.problema}</p>
        <p>${copy.solucion}</p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">🔴 CHECK PRICE ON AMAZON →</a>
        <h2>The New Status Signal</h2>
        <p>${copy.beneficio_estatus}</p>
        <div class="social-proof">
            "${copy.prueba_social}"
            <strong>⭐⭐⭐⭐⭐ Verified Purchase</strong>
        </div>
        <div class="stat-box">
            <p>💎 ${copy.cierre}</p>
        </div>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">🔥 GET IT ON AMAZON →</a>
        <footer>
            <p>As an Amazon Associate we earn from qualifying purchases. | © 2026 MXL GOLD MINER</p>
        </footer>
    </div>
</body>
</html>`;
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), modelo: modeloUsado }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// Curiosidades
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const c = await publicarCuriosidadAutomatica();
        res.json({ success: true, curiosidad: c });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) { res.json([]); }
});

app.delete('/api/curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const filteredData = data.filter(c => c.id != req.params.id);
        if (filteredData.length === data.length) {
            return res.status(404).json({ success: false, error: 'Curiosidad no encontrada' });
        }
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(filteredData, null, 2));
        cache.delete('curiosidades');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/curiosidades/all', (req, res) => {
    try {
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
        cache.delete('curiosidades');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/curiosidad/:id/refrescar-imagen', async (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const index = data.findIndex(c => c.id == req.params.id);
        if (index === -1) {
            return res.status(404).json({ success: false, error: 'Curiosidad no encontrada' });
        }
        const nuevaImagen = await buscarImagenPorContenido(data[index]);
        data[index].imagen = nuevaImagen.url;
        data[index].imagenFuente = nuevaImagen.fuente;
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        cache.delete('curiosidades');
        res.json({ success: true, imagen: nuevaImagen });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const i = data.findIndex(c => c.id == req.params.id);
        if (i !== -1) {
            data[i].compartidas = (data[i].compartidas || 0) + 1;
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// Productos
app.post('/api/generar-copy-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, precio } = req.body;
        if (!url) return res.status(400).json({ success: false, error: 'URL requerida' });
        if (!imagenUrl) return res.status(400).json({ success: false, error: 'URL imagen requerida' });
        const copy = await generarCopyProductoConGemini(url, imagenUrl, categoria, precio);
        res.json({ success: true, copy });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/publicar-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, imageSize, imagePosition, copy } = req.body;
        if (!url || !imagenUrl || !copy) return res.status(400).json({ success: false, error: 'Faltan datos' });
        const html = generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy);
        const art = {
            id: Date.now(), asin: extraerASIN(url),
            titulo: copy.titulo, meta: copy.meta_descripcion || copy.curiosidad,
            intro: copy.intro, curiosidad: copy.curiosidad,
            contenido: html, imagen: imagenUrl,
            imageSize: imageSize || 'medium', imagePosition: imagePosition || 'center',
            categoria: categoria || 'LUXURY', link: url,
            fecha: new Date().toISOString(), clicks: 0
        };
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(art);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        res.json({ success: true, articulo: art });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) { res.json([]); }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(req.body.articulos, null, 2));
        cache.clear();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) {
            data[i].clicks = (data[i].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            
            // Registrar clic para el feedback loop
            const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
            if (curiosidades.length > 0) {
                const ultimaCuriosidad = curiosidades[0];
                if (ultimaCuriosidad.anguloUsado && historialClics[ultimaCuriosidad.anguloUsado]) {
                    historialClics[ultimaCuriosidad.anguloUsado].push(Date.now());
                    
                    // Actualizar estadísticas
                    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
                    stats.totalClics++;
                    stats.clicsPorAngulo[ultimaCuriosidad.anguloUsado]++;
                    stats.ultimaActualizacion = new Date().toISOString();
                    fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
                    
                    console.log(`📊 Clic registrado para ángulo ${ultimaCuriosidad.anguloUsado}`);
                }
            }
        }
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.json({ success: false }); 
    }
});

app.get('/api/estadisticas', (req, res) => {
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        res.json({
            ...stats,
            anguloActual: anguloVentaActual,
            descripcionAngulo: descripcionAngulos[anguloVentaActual],
            modeloGemini: modeloUsado,
            geminiDisponible: isGeminiAvailable
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/api/gemini-status', (req, res) => {
    res.json({
        hasKey: !!process.env.GEMINI_API_KEY,
        isWorking: isGeminiAvailable,
        modeloUsado: modeloUsado,
        unsplashKey: !!process.env.UNSPLASH_ACCESS_KEY,
        googleKey: !!process.env.GOOGLE_API_KEY,
        pexelsKey: !!process.env.PEXELS_API_KEY
    });
});

// CRON - Cada 3 horas
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ CRON: Generando curiosidad adaptativa...');
    await publicarCuriosidadAutomatica();
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', async () => {
    const art = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const cur = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
    
    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                    🏮 MXL GOLD MINER — SISTEMA ADAPTATIVO 2026 🏮                   ║
╠══════════════════════════════════════════════════════════════════════╣
║  🤖 GEMINI: ${isGeminiAvailable ? `✅ ACTIVADO (${modeloUsado})` : '⚠️ NO DISPONIBLE'}                              ║
║                                                                       ║
║  🎯 SISTEMA DE ADAPTACIÓN: "EL VENENO SE ADAPTA"                     ║
║     Ángulo actual: ${descripcionAngulos[anguloVentaActual].padEnd(45)}║
║     Clics totales: ${String(stats.totalClics).padEnd(40)}║
║                                                                       ║
║  💎 CURIOSIDADES                                                      ║
║     ✅ Generadas: ${String(stats.curiosidadesGeneradas).padEnd(40)}║
║     ✅ Guardadas: ${String(cur).padEnd(44)}║
║     ✅ Rotación de ángulos automática                                ║
║     ✅ Producto relacionado automático                               ║
║                                                                       ║
║  💰 PRODUCTOS                                                         ║
║     📊 Publicados: ${String(art).padEnd(44)}║
║                                                                       ║
║  🖼️ FUENTES DE IMÁGENES:                                              ║
║     ${process.env.UNSPLASH_ACCESS_KEY ? '✅ Unsplash' : '⚠️ Unsplash'} | ${process.env.PEXELS_API_KEY ? '✅ Pexels API' : '⚠️ Pexels API'} | ${process.env.GOOGLE_API_KEY ? '✅ Google Images' : '⚠️ Google Images'} | ✅ Fallback (24+ imágenes)║
║                                                                       ║
║  🚀 Servidor corriendo en puerto: ${PORT}                                            ║
║  📊 Panel de control: http://localhost:${PORT}/panel                               ║
╚══════════════════════════════════════════════════════════════════════╝
    `);
    
    if (cur === 0) {
        console.log('📝 Generando primera curiosidad...');
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
