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

// Inicializar Gemini
let genAI, model;
let isGeminiAvailable = false;

if (process.env.GEMINI_API_KEY) {
    try {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        isGeminiAvailable = true;
        console.log('✅ Bot Gemini activado');
    } catch(e) {
        console.log('⚠️ Error inicializando Gemini:', e.message);
    }
}

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

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
// MÚLTIPLES FUENTES DE IMÁGENES
// ============================================================

// Fuente 1: Unsplash (principal)
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

// Fuente 2: Pexels API (alternativa)
async function buscarEnPexels(query) {
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

// Fuente 3: Google Custom Search (si tienes configurado)
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

// Fuente 4: Lorem Picsum (imágenes de calidad para fallback)
const imagenesLoremPicsum = [
    'https://picsum.photos/id/104/1200/800', // Villa
    'https://picsum.photos/id/106/1200/800', // Flores
    'https://picsum.photos/id/107/1200/800', // Pasto
    'https://picsum.photos/id/108/1200/800', // Jardín
    'https://picsum.photos/id/116/1200/800', // Lago
    'https://picsum.photos/id/20/1200/800',  // Escritorio
    'https://picsum.photos/id/22/1200/800',  // Café
    'https://picsum.photos/id/26/1200/800',  // Playa
    'https://picsum.photos/id/30/1200/800',  // Planta
    'https://picsum.photos/id/38/1200/800',  // Ciudad
];

// Fuente 5: Pexels CDN (imágenes directas de alta calidad)
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
    'https://images.pexels.com/photos/1571470/pexels-photo-1571470.jpeg'
];

// Función principal que combina múltiples fuentes
async function buscarImagenPorContenido(curiosidad) {
    // 1. Extraer palabras clave del contenido
    const contenidoCompleto = `${curiosidad.titulo_es || ''} ${curiosidad.titulo_en || ''} ${curiosidad.texto_es || ''} ${curiosidad.texto_en || ''}`.toLowerCase();
    
    // 2. Detectar categoría principal
    const categorias = {
        'kitchen': ['kitchen', 'cocina', 'cooking', 'gourmet', 'food', 'chef', 'appliance'],
        'bedroom': ['bedroom', 'dormitorio', 'sleep', 'bed', 'cozy', 'mattress'],
        'bathroom': ['bathroom', 'baño', 'spa', 'shower', 'bath', 'wellness', 'relax'],
        'living': ['living', 'sala', 'sofa', 'couch', 'tv', 'entertainment'],
        'office': ['office', 'oficina', 'desk', 'work', 'study', 'entrepreneur'],
        'outdoor': ['outdoor', 'exterior', 'terrace', 'garden', 'pool', 'patio'],
        'tech': ['smart', 'gadget', 'tech', 'technology', 'digital', 'automation', 'mirror'],
        'wellness': ['wellness', 'health', 'fitness', 'gym', 'relaxation', 'meditation'],
        'decor': ['decor', 'decoration', 'style', 'design', 'furniture', 'elegant'],
        'luxury': ['luxury', 'lujo', 'elegant', 'premium', 'high-end', 'exclusive']
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
    
    // 3. Extraer ubicaciones si las menciona
    const ubicaciones = ['nyc', 'new york', 'manhattan', 'beverly hills', 'miami', 'brickell', 'coral gables', 'los angeles', 'california'];
    let ubicacionDetectada = null;
    for (const ubicacion of ubicaciones) {
        if (contenidoCompleto.includes(ubicacion)) {
            ubicacionDetectada = ubicacion;
            break;
        }
    }
    
    // 4. Extraer palabras clave importantes
    const palabrasClave = contenidoCompleto
        .split(' ')
        .filter(p => p.length > 4 && !['para', 'como', 'que', 'una', 'las', 'los', 'con', 'sin', 'por', 'del', 'mujer', 'women', 'home', 'house', 'luxury', 'interior', 'design'].includes(p))
        .slice(0, 4);
    
    // 5. Construir queries de búsqueda
    let queries = [];
    
    // Query con categoría + ubicación
    if (ubicacionDetectada) {
        queries.push(`${categoriaDetectada} luxury home ${ubicacionDetectada}`);
        queries.push(`elegant ${categoriaDetectada} design ${ubicacionDetectada}`);
    }
    
    // Queries con palabras clave
    if (palabrasClave.length >= 2) {
        queries.push(`${palabrasClave[0]} ${palabrasClave[1]} luxury interior`);
        queries.push(`modern ${palabrasClave[0]} ${categoriaDetectada} design`);
    }
    
    // Queries por categoría
    const queriesPorCategoria = {
        'kitchen': ['luxury modern kitchen design', 'elegant kitchen interior', 'high end kitchen appliances', 'gourmet kitchen luxury'],
        'bedroom': ['luxury bedroom interior', 'elegant master bedroom', 'modern bedroom design', 'cozy luxury bedroom'],
        'bathroom': ['luxury bathroom spa', 'elegant bathroom design', 'modern bathroom interior', 'spa bathroom luxury'],
        'living': ['luxury living room', 'elegant living room interior', 'modern living room design', 'contemporary living room'],
        'office': ['luxury home office', 'elegant office interior', 'modern home office design', 'executive office luxury'],
        'outdoor': ['luxury outdoor terrace', 'elegant patio design', 'modern outdoor living', 'garden luxury design'],
        'tech': ['smart home technology', 'luxury smart home', 'modern tech home', 'automation luxury home'],
        'wellness': ['luxury home spa', 'wellness home design', 'elegant spa bathroom', 'relaxation luxury home'],
        'decor': ['luxury home decor', 'elegant interior design', 'modern home decoration', 'high end decor'],
        'luxury': ['luxury home interior', 'elegant mansion interior', 'modern luxury design', 'high end home decor']
    };
    
    queries.push(...(queriesPorCategoria[categoriaDetectada] || queriesPorCategoria['luxury']));
    
    // 6. Eliminar duplicados y seleccionar query aleatoria
    queries = [...new Set(queries)];
    const querySeleccionada = queries[Math.floor(Math.random() * queries.length)];
    
    console.log(`🔍 Categoría: ${categoriaDetectada}`);
    console.log(`🔍 Ubicación: ${ubicacionDetectada || 'no especificada'}`);
    console.log(`🔍 Query: "${querySeleccionada}"`);
    
    // 7. Intentar múltiples fuentes en orden
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
    
    // 8. Fallback: imágenes directas de alta calidad
    console.log('🖼️ Usando imágenes de respaldo de alta calidad');
    
    // Seleccionar imagen basada en la categoría para más coherencia
    const imagenesPorCategoria = {
        'kitchen': imagenesPexelsDirectas.filter(img => img.includes('2635038') || img.includes('1571460')),
        'bedroom': imagenesPexelsDirectas.filter(img => img.includes('1648772') || img.includes('1457842')),
        'bathroom': imagenesPexelsDirectas.filter(img => img.includes('2635646') || img.includes('2635638')),
        'living': imagenesPexelsDirectas.filter(img => img.includes('1571459') || img.includes('1571463')),
        'office': imagenesPexelsDirectas.filter(img => img.includes('1571469')),
        'outdoor': imagenesPexelsDirectas.filter(img => img.includes('1571462')),
        'tech': imagenesPexelsDirectas.filter(img => img.includes('280229')),
        'luxury': imagenesPexelsDirectas
    };
    
    const imagenesCategoria = imagenesPorCategoria[categoriaDetectada] || imagenesPexelsDirectas;
    
    // Usar timestamp para rotar imágenes y no repetir
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
// TEMAS SEO ROTATIVOS
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
    { tema: "luxury home gym equipment women", kw_es: "gimnasio en casa lujo mujer", kw_en: "luxury home gym equipment women" }
];

// ============================================================
// GENERAR CURIOSIDAD CON GEMINI
// ============================================================
async function generarCuriosidadConGemini() {
    const temaIndex = Math.floor(Date.now() / 3600000) % TEMAS_SEO.length;
    const tema = TEMAS_SEO[temaIndex];

    const prompt = `
Eres un experto en SEO y copywriting de lujo para el mercado USA.
Genera contenido viral para mujeres de alto poder adquisitivo.

TEMA: "${tema.tema}"
KEYWORD EN: "${tema.kw_en}"
KEYWORD ES: "${tema.kw_es}"

REGLAS:
- titulo_en: Incluye la keyword en inglés
- titulo_es: Clickbait con número o dato impactante
- texto_es y texto_en: Incluye dato estadístico + conexión visual
- Usa ubicaciones: NYC, Miami, Beverly Hills
- Termina con pregunta que invite a compartir
- meta_descripcion_en: 155 chars con keyword

RESPONDE SOLO CON JSON:
{
    "titulo_es": "Título en español con dato",
    "titulo_en": "SEO title in English with keyword",
    "texto_es": "2-3 oraciones en español",
    "texto_en": "2-3 sentences in English",
    "descripcion_visual_es": "Descripción sensorial en español",
    "descripcion_visual_en": "Sensory description in English",
    "meta_descripcion_en": "Meta description 155 chars",
    "imagen_prompt": "English prompt para buscar imagen en Unsplash"
}`;

    const fallback = {
        titulo_es: `El ${Math.floor(Math.random() * 30 + 65)}% de mujeres en NYC ya conocen este secreto de lujo`,
        titulo_en: `Best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026: What NYC Women Are Buying`,
        texto_es: `Estadísticas muestran que el ${Math.floor(Math.random() * 30 + 65)}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo más en tecnología para el hogar. ¿Ya eres de las que saben?`,
        texto_en: `${Math.floor(Math.random() * 30 + 65)}% of high-income women in NYC now invest more in home tech. Are you one of them?`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus. Ese acabado que ves es el nuevo lujo silencioso.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status. That finish you see is the new quiet luxury.",
        meta_descripcion_en: `Discover the best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026. What NYC and Beverly Hills women are investing in.`,
        imagen_prompt: `${tema.tema.split(' ')[0]} luxury interior design elegant`
    };

    if (!isGeminiAvailable || !model) return fallback;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        console.log(`✨ Curiosidad generada: "${data.titulo_en}"`);
        return data;
    } catch(e) {
        console.log('⚠️ Error en Gemini:', e.message);
        return fallback;
    }
}

// ============================================================
// PUBLICAR CURIOSIDAD
// ============================================================
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando curiosidad SEO...');
    const g = await generarCuriosidadConGemini();
    
    // Buscar imagen basada en el CONTENIDO de la curiosidad
    const img = await buscarImagenPorContenido(g);

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
        fecha: new Date().toISOString(),
        compartidas: 0,
        categoria: img.categoria || 'luxury'
    };

    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    data.unshift(nueva);
    if (data.length > 30) data.pop();
    fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
    console.log(`✅ Publicada: "${nueva.titulo_en}"`);
    console.log(`📷 Imagen desde: ${img.fuente}`);
    return nueva;
}

// ============================================================
// GENERAR COPY PRODUCTO
// ============================================================
async function generarCopyProductoConGemini(url, imagenUrl, categoria, precio) {
    const prompt = `
Eres copywriter de lujo para Amazon Affiliates.
Genera copy que convierta y rankee en Google.

URL: ${url}
CATEGORÍA: ${categoria || 'luxury home'}
PRECIO: ${precio || 'Premium'}

RESPONDE SOLO CON JSON:
{
    "titulo": "SEO title con keyword, max 70 chars",
    "meta_descripcion": "Meta description 155 chars",
    "intro": "Hook impactante con dato o pregunta",
    "descripcion_visual": "Descripción conectada con la imagen",
    "problema": "El problema que resuelve",
    "solucion": "Cómo lo resuelve",
    "beneficio_estatus": "Beneficio de estatus",
    "prueba_social": "Testimonio con nombre y ciudad USA",
    "cierre": "Frase FOMO",
    "curiosidad": "Dato estadístico impactante",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;

    const fallback = {
        titulo: "Best Luxury Home Investment 2026: What NYC Women Are Buying",
        meta_descripcion: "Discover why NYC and Beverly Hills women are investing in this luxury home product.",
        intro: "There's one detail interior designers can't stop recommending — and it costs less than a designer bag.",
        descripcion_visual: "Look at the clean lines you see in the image — that's not just design, that's intention.",
        problema: "Your home still feels like it's missing something.",
        solucion: "That elegant form you see makes everything around it feel more considered.",
        beneficio_estatus: "Women who own this let their space speak for them.",
        prueba_social: "Gabriela from Miami: 'Three guests have asked me where I found it.'",
        cierre: "That design you see won't wait.",
        curiosidad: `Interior designers report a ${Math.floor(Math.random() * 100 + 100)}% increase in signature home pieces.`,
        palabras_clave: ["luxury home 2026", "best home investment", "NYC women lifestyle"]
    };

    if (!isGeminiAvailable || !model) return fallback;

    try {
        const result = await model.generateContent(prompt);
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
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Lato:wght@300;400;700&display=swap');
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Lato',sans-serif; background:#fffaf7; color:#1a1a1a; line-height:1.7; }
        .hero { background:linear-gradient(135deg,#1a1a2e,#16213e); padding:60px 20px; text-align:center; }
        .hero h1 { font-family:'Playfair Display',serif; font-size:2.4rem; color:#fff; max-width:800px; margin:0 auto 20px; }
        .hero .fact-pill { display:inline-block; background:#ff4500; color:#fff; padding:10px 22px; border-radius:40px; font-size:13px; font-weight:700; }
        .article-body { max-width:800px; margin:0 auto; padding:50px 20px; }
        .intro-lead { font-family:'Playfair Display',serif; font-size:1.2rem; color:#4a3727; border-left:4px solid #ff4500; padding-left:20px; margin:30px 0; font-style:italic; }
        .product-image-wrap { text-align:${imagePosition || 'center'}; margin:35px 0; background:#faf7f3; border-radius:20px; padding:${pad}; }
        .product-image-wrap img { max-width:100%; border-radius:12px; object-fit:contain; max-height:${maxH}; }
        .visual-description { background:linear-gradient(135deg,#fff5f0,#fdf0e8); border-left:4px solid #c9a87b; padding:25px; border-radius:0 16px 16px 0; margin:30px 0; font-family:'Playfair Display',serif; font-style:italic; }
        h2 { font-family:'Playfair Display',serif; font-size:1.5rem; color:#2c2418; margin:40px 0 12px; }
        p { color:#3a2e24; margin-bottom:18px; }
        .social-proof { background:#fff; border:1px solid #f0e2d8; border-left:4px solid #ff4500; padding:22px; border-radius:0 16px 16px 0; margin:30px 0; font-style:italic; }
        .btn-buy { display:block; background:linear-gradient(135deg,#ff4500,#ff6b35); color:#fff; padding:18px 35px; text-decoration:none; border-radius:50px; font-weight:700; text-align:center; margin:40px 0; transition:all .3s; }
        .btn-buy:hover { transform:translateY(-2px); }
        .stat-box { background:#1a1a2e; color:#fff; padding:25px; border-radius:16px; margin:30px 0; text-align:center; }
        footer { margin-top:60px; padding:30px 0; border-top:1px solid #f0e2d8; font-size:11px; text-align:center; }
        @media(max-width:600px){ .hero h1{font-size:1.6rem} }
    </style>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
        <span class="fact-pill">🔥 ${copy.curiosidad}</span>
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
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
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
        if (i !== -1) { data[i].clicks = (data[i].clicks || 0) + 1; fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2)); }
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.get('/api/gemini-status', (req, res) => {
    res.json({
        hasKey: !!process.env.GEMINI_API_KEY,
        isWorking: isGeminiAvailable,
        unsplashKey: !!process.env.UNSPLASH_ACCESS_KEY,
        googleKey: !!process.env.GOOGLE_API_KEY
    });
});

// CRON
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ CRON: Generando curiosidad...');
    await publicarCuriosidadAutomatica();
});

app.listen(PORT, '0.0.0.0', () => {
    const art = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const cur = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    console.log(`
╔══════════════════════════════════════════════════════════╗
║       🏮 MXL GOLD MINER — SISTEMA SEO 🏮                ║
╠══════════════════════════════════════════════════════════╣
║  💎 CURIOSIDADES                                        ║
║     ✅ 15 temas rotativos                               ║
║     ✅ Múltiples fuentes de imágenes:                   ║
║        • Unsplash API                                   ║
║        • Pexels API (si configurada)                    ║
║        • Google Images (si configurada)                 ║
║        • Banco de imágenes de respaldo (20+)            ║
║     ✅ Imagen según CONTENIDO de la curiosidad          ║
║     ✅ Botón para regenerar imagen                      ║
║     📊 ${String(cur).padEnd(3)} curiosidades guardadas               ║
║                                                          ║
║  💰 PRODUCTOS                                           ║
║     📊 ${String(art).padEnd(3)} productos publicados                 ║
║                                                          ║
║  🚀 Puerto: ${PORT}                                        ║
║  🤖 Gemini: ${isGeminiAvailable ? '✅ ACTIVADO' : '⚠️ NO DISPONIBLE'}               ║
║  🖼️ Unsplash: ${process.env.UNSPLASH_ACCESS_KEY ? '✅ CONFIGURADO' : '⚠️ NO CONFIGURADO'}          ║
║  🔍 Google: ${process.env.GOOGLE_API_KEY ? '✅ CONFIGURADO' : '⚠️ NO CONFIGURADO'}              ║
╚══════════════════════════════════════════════════════════╝
    `);
    if (cur === 0) {
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
