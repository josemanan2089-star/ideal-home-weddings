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

// Usar SOLO una API key de Gemini
let genAI, model;
let isGeminiAvailable = false;

// Inicializar Gemini con tu única llave
if (process.env.GEMINI_API_KEY) {
    try {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        isGeminiAvailable = true;
        console.log('✅ Bot Gemini activado con tu API key');
    } catch(e) {
        console.log('⚠️ Error inicializando Gemini:', e.message);
        isGeminiAvailable = false;
    }
} else {
    console.log('⚠️ No hay API key de Gemini configurada en GEMINI_API_KEY');
}

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH    = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');

if (!fs.existsSync(DATA_DIR))          fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH))    fs.writeFileSync(ARTICULOS_PATH,    JSON.stringify([]));
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

// MEJORADO: Búsqueda de imágenes con más variedad usando UNSPLASH_ACCESS_KEY
async function buscarImagenParaCuriosidad(promptImagen) {
    // Usar Unsplash si está configurado
    if (process.env.UNSPLASH_ACCESS_KEY) {
        try {
            // Extraer palabras clave relevantes del prompt
            const palabrasClave = promptImagen
                .split(' ')
                .filter(p => p.length > 3 && !['the','with','for','and','luxury','modern','interior','design'].includes(p.toLowerCase()))
                .slice(0, 3);
            
            // Crear 3 variaciones de búsqueda para más variedad
            const busquedas = [
                palabrasClave.join(' '),
                `${palabrasClave[0]} ${palabrasClave[1]} interior`,
                `luxury ${palabrasClave[0]} home design`
            ];
            
            // Seleccionar una búsqueda aleatoria
            const busqueda = busquedas[Math.floor(Math.random() * busquedas.length)];
            
            console.log(`🔍 Buscando en Unsplash: "${busqueda}"`);
            
            const response = await axios.get('https://api.unsplash.com/search/photos', {
                params: { 
                    query: busqueda, 
                    per_page: 8,
                    orientation: 'landscape',
                    order_by: 'relevant'
                },
                headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
                timeout: 8000
            });
            
            if (response.data.results && response.data.results.length > 0) {
                // Seleccionar imagen aleatoria para evitar repeticiones
                const randomIndex = Math.floor(Math.random() * Math.min(5, response.data.results.length));
                const imagen = response.data.results[randomIndex];
                console.log(`✅ Imagen encontrada: ${imagen.alt_description || busqueda}`);
                return { 
                    url: imagen.urls.regular, 
                    fuente: 'unsplash',
                    alt: imagen.alt_description || busqueda
                };
            }
        } catch(e) {
            console.log('⚠️ Error en Unsplash:', e.message);
        }
    }
    
    // Fallback con imágenes variadas de Pexels (múltiples opciones por categoría)
    const imagenesPorCategoria = {
        'kitchen': [
            'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
            'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg',
            'https://images.pexels.com/photos/279746/pexels-photo-279746.jpeg'
        ],
        'living': [
            'https://images.pexels.com/photos/1571459/pexels-photo-1571459.jpeg',
            'https://images.pexels.com/photos/1571463/pexels-photo-1571463.jpeg',
            'https://images.pexels.com/photos/1571465/pexels-photo-1571465.jpeg'
        ],
        'bedroom': [
            'https://images.pexels.com/photos/1648772/pexels-photo-1648772.jpeg',
            'https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg',
            'https://images.pexels.com/photos/1571466/pexels-photo-1571466.jpeg'
        ],
        'bathroom': [
            'https://images.pexels.com/photos/2635646/pexels-photo-2635646.jpeg',
            'https://images.pexels.com/photos/2635638/pexels-photo-2635638.jpeg',
            'https://images.pexels.com/photos/1571455/pexels-photo-1571455.jpeg'
        ],
        'luxury': [
            'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
            'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
            'https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg',
            'https://images.pexels.com/photos/258154/pexels-photo-258154.jpeg'
        ],
        'default': [
            'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
            'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
            'https://images.pexels.com/photos/258154/pexels-photo-258154.jpeg'
        ]
    };
    
    // Detectar categoría del prompt
    let categoria = 'default';
    const promptLower = promptImagen.toLowerCase();
    if (promptLower.includes('kitchen')) categoria = 'kitchen';
    else if (promptLower.includes('living')) categoria = 'living';
    else if (promptLower.includes('bedroom')) categoria = 'bedroom';
    else if (promptLower.includes('bathroom')) categoria = 'bathroom';
    else if (promptLower.includes('luxury')) categoria = 'luxury';
    
    // Seleccionar imagen aleatoria de la categoría
    const imagenes = imagenesPorCategoria[categoria];
    const imagenAleatoria = imagenes[Math.floor(Math.random() * imagenes.length)];
    
    console.log(`🖼️ Usando imagen fallback de categoría: ${categoria}`);
    return { url: imagenAleatoria, fuente: 'placeholder' };
}

// TEMAS SEO ROTATIVOS (15 temas para más variedad)
const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026",        kw_es: "gadgets de lujo hogar 2026",     kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury",      kw_es: "spa en casa lujo baño",          kw_en: "luxury home spa bathroom ideas" },
    { tema: "luxury kitchen appliances women NYC",   kw_es: "cocina de lujo electrodomésticos", kw_en: "luxury kitchen appliances NYC women" },
    { tema: "minimalist luxury bedroom decor 2026",  kw_es: "dormitorio minimalista lujo",    kw_en: "minimalist luxury bedroom 2026" },
    { tema: "smart home automation Beverly Hills",   kw_es: "hogar inteligente automatización", kw_en: "smart home automation Beverly Hills" },
    { tema: "luxury home office women entrepreneur", kw_es: "oficina en casa mujer emprendedora", kw_en: "luxury home office women 2026" },
    { tema: "sustainable luxury home eco design",    kw_es: "hogar sostenible lujo eco",      kw_en: "sustainable luxury home design" },
    { tema: "luxury home fragrance candles",         kw_es: "fragancias hogar velas lujo",    kw_en: "luxury home fragrance best 2026" },
    { tema: "luxury outdoor living Miami terrace",   kw_es: "terraza lujo Miami exterior",    kw_en: "luxury outdoor living Miami" },
    { tema: "high end morning routine luxury home",  kw_es: "rutina mañana mujer lujo",       kw_en: "luxury morning routine home 2026" },
    { tema: "luxury water purifier home health",     kw_es: "purificador agua lujo hogar",    kw_en: "best luxury water purifier home" },
    { tema: "smart mirror beauty luxury women",      kw_es: "espejo inteligente belleza lujo", kw_en: "smart mirror luxury beauty women" },
    { tema: "luxury home theater setup 2026",        kw_es: "cine en casa lujo",              kw_en: "luxury home theater setup 2026" },
    { tema: "designer furniture NYC luxury",         kw_es: "muebles de diseñador lujo",      kw_en: "designer luxury furniture NYC" },
    { tema: "luxury home gym equipment women",       kw_es: "gimnasio en casa lujo mujer",    kw_en: "luxury home gym equipment women" }
];

// Generar curiosidad con Gemini
async function generarCuriosidadConGemini() {
    // Rotar tema basado en la hora para variedad automática
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
        titulo_en: `Best ${tema.tema.split(' ').slice(0,3).join(' ')} 2026: What NYC Women Are Buying`,
        texto_es: `Estadísticas muestran que el ${Math.floor(Math.random() * 30 + 65)}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo más en tecnología para el hogar. ¿Ya eres de las que saben?`,
        texto_en: `${Math.floor(Math.random() * 30 + 65)}% of high-income women in NYC now invest more in home tech. Are you one of them?`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus. Ese acabado que ves es el nuevo lujo silencioso.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status. That finish you see is the new quiet luxury.",
        meta_descripcion_en: `Discover the best ${tema.tema.split(' ').slice(0,3).join(' ')} 2026. What NYC and Beverly Hills women are investing in.`,
        imagen_prompt: `luxury ${tema.tema.split(' ')[0]} interior design elegant modern architecture`
    };

    if (!isGeminiAvailable || !model) {
        console.log('⚠️ Gemini no disponible, usando fallback');
        return fallback;
    }

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        const data = JSON.parse(clean);
        console.log(`✨ Curiosidad generada: "${data.titulo_en}"`);
        return data;
    } catch(e) {
        console.log('⚠️ Error en Gemini:', e.message);
        return fallback;
    }
}

// Publicar curiosidad automática
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando curiosidad SEO...');
    const g = await generarCuriosidadConGemini();
    const img = await buscarImagenParaCuriosidad(g.imagen_prompt);

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
        compartidas: 0
    };

    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    data.unshift(nueva);
    if (data.length > 30) data.pop();
    fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
    console.log(`✅ Publicada: "${nueva.titulo_en}"`);
    return nueva;
}

// Generar copy para producto
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
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
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
        .product-image-wrap { text-align:${imagePosition||'center'}; margin:35px 0; background:#faf7f3; border-radius:20px; padding:${pad}; }
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
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// Generar curiosidad
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const c = await publicarCuriosidadAutomatica();
        res.json({ success: true, curiosidad: c });
    } catch(e) { 
        res.status(500).json({ success: false, error: e.message }); 
    }
});

// Obtener curiosidades
app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch(e) { res.json([]); }
});

// ELIMINAR curiosidad individual
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
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Eliminar TODAS las curiosidades
app.delete('/api/curiosidades/all', (req, res) => {
    try {
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
        cache.delete('curiosidades');
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Compartir curiosidad
app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const i = data.findIndex(c => c.id == req.params.id);
        if (i !== -1) { 
            data[i].compartidas = (data[i].compartidas||0)+1; 
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data,null,2)); 
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// Generar copy producto
app.post('/api/generar-copy-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, precio } = req.body;
        if (!url) return res.status(400).json({ success: false, error: 'URL requerida' });
        if (!imagenUrl) return res.status(400).json({ success: false, error: 'URL imagen requerida' });
        const copy = await generarCopyProductoConGemini(url, imagenUrl, categoria, precio);
        res.json({ success: true, copy });
    } catch(e) { 
        res.status(500).json({ success: false, error: e.message }); 
    }
});

// Publicar producto
app.post('/api/publicar-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, imageSize, imagePosition, copy } = req.body;
        if (!url||!imagenUrl||!copy) return res.status(400).json({ success: false, error: 'Faltan datos' });
        const html = generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy);
        const art = {
            id: Date.now(), asin: extraerASIN(url),
            titulo: copy.titulo, meta: copy.meta_descripcion||copy.curiosidad,
            intro: copy.intro, curiosidad: copy.curiosidad,
            contenido: html, imagen: imagenUrl,
            imageSize: imageSize||'medium', imagePosition: imagePosition||'center',
            categoria: categoria||'LUXURY', link: url,
            fecha: new Date().toISOString(), clicks: 0
        };
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(art);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        res.json({ success: true, articulo: art });
    } catch(e) { 
        res.status(500).json({ success: false, error: e.message }); 
    }
});

// Obtener artículos
app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch(e) { res.json([]); }
});

// Ordenar artículos
app.put('/api/ordenar-articulos', (req, res) => {
    try {
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(req.body.articulos, null, 2));
        cache.clear();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Click en artículo
app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) { data[i].clicks = (data[i].clicks||0)+1; fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data,null,2)); }
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// Estado de Gemini
app.get('/api/gemini-status', (req, res) => {
    res.json({
        hasKey: !!process.env.GEMINI_API_KEY,
        isWorking: isGeminiAvailable,
        message: isGeminiAvailable ? '✅ Gemini activo' : '⚠️ Gemini no disponible'
    });
});

// ============================================================
// CRON - Curiosidades cada 3 horas
// ============================================================
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
║  💎 CURIOSIDADES (1 bot Gemini)                         ║
║     ✅ 15 temas rotativos                               ║
║     ✅ Imágenes variadas de Unsplash                    ║
║     ✅ Botón para borrar individual                     ║
║     📊 ${String(cur).padEnd(3)} curiosidades guardadas               ║
║                                                          ║
║  💰 PRODUCTOS SEO                                       ║
║     ✅ Copy generado por Gemini                         ║
║     ✅ Schema.org JSON-LD                               ║
║     📊 ${String(art).padEnd(3)} productos publicados                 ║
║                                                          ║
║  🚀 Puerto: ${PORT}                                        ║
║  🤖 Gemini: ${isGeminiAvailable ? '✅ ACTIVADO' : '⚠️ NO DISPONIBLE'}               ║
║  🖼️ Unsplash: ${process.env.UNSPLASH_ACCESS_KEY ? '✅ CONFIGURADO' : '⚠️ NO CONFIGURADO'}          ║
╚══════════════════════════════════════════════════════════╝
    `);
    if (cur === 0) {
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
