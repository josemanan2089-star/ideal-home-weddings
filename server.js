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

let genAI, model;
try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    console.log('✅ Bot Gemini activado');
} catch (e) {
    console.log('⚠️ Bot Gemini no disponible');
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

async function buscarImagenParaCuriosidad(promptImagen) {
    if (process.env.UNSPLASH_ACCESS_KEY) {
        try {
            const r = await axios.get('https://api.unsplash.com/search/photos', {
                params: { query: promptImagen, per_page: 1, orientation: 'landscape' },
                headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
                timeout: 5000
            });
            if (r.data.results?.length > 0)
                return { url: r.data.results[0].urls.regular, fuente: 'unsplash' };
        } catch(e) {}
    }
    if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) {
        try {
            const r = await axios.get('https://www.googleapis.com/customsearch/v1', {
                params: { key: process.env.GOOGLE_API_KEY, cx: process.env.GOOGLE_CX,
                    q: promptImagen, searchType: 'image', num: 1, imgSize: 'large' },
                timeout: 5000
            });
            if (r.data.items?.length > 0)
                return { url: r.data.items[0].link, fuente: 'google' };
        } catch(e) {}
    }
    const map = {
        kitchen: 'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
        luxury:  'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        woman:   'https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg',
        default: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg'
    };
    const key = ['kitchen','luxury','woman'].find(k => promptImagen.toLowerCase().includes(k)) || 'default';
    return { url: map[key], fuente: 'placeholder' };
}

// ============================================================
// TEMAS SEO ROTATIVOS — variedad para Google
// ============================================================
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
];

// ============================================================
// MÓDULO 1 — CURIOSIDADES SEO (BOT GEMINI AUTÓNOMO)
// ============================================================
async function generarCuriosidadConGemini() {
    const tema = TEMAS_SEO[Math.floor(Date.now() / 3600000) % TEMAS_SEO.length];

    const prompt = `
Eres un experto en SEO, marketing de lujo y copywriting viral para el mercado USA.
Debes generar contenido que RANKEE en Google Y que la gente comparta en Pinterest, Instagram y TikTok.

AUDIENCIA TARGET: Mujeres 28-55 años, alto poder adquisitivo, USA (NYC, Miami, Beverly Hills) + diáspora dominicana en USA.
TEMA SEO DEL MOMENTO: "${tema.tema}"
KEYWORD EN INGLÉS (para Google USA): "${tema.kw_en}"
KEYWORD EN ESPAÑOL (para búsquedas Latinas): "${tema.kw_es}"

REGLAS SEO OBLIGATORIAS:
1. titulo_en DEBE incluir la keyword en inglés de forma natural (así Google rankea)
2. titulo_es DEBE ser clickbait emocional con número o dato ("El secreto que el 73%...")
3. texto_es y texto_en DEBEN incluir un dato estadístico verosímil
4. Usa "2026", "NYC women", "Beverly Hills", "Miami" — palabras de alta búsqueda
5. El texto termina con pregunta retórica o afirmación que invite a guardar/compartir
6. meta_descripcion_en: exactamente como aparece en Google (155 chars, con keyword)

REGLAS DE ESCRITURA VISUAL PARA ENGAGEMENT:
- Conecta con la imagen: "Ese acabado que ves...", "El detalle que notas en la foto..."
- Lenguaje sensorial: tacto, textura, olor, peso, calidez percibida
- Tono: Vogue en español + Wall Street Journal en inglés. Nunca genérico.

IMPORTANTE: Genera un tema DIFERENTE y FRESCO. No repitas "mujeres de Manhattan" siempre.
Varía entre: Beverly Hills, Miami Design District, Upper East Side, Brickell, Coral Gables.

RESPONDE SOLO CON JSON VÁLIDO, sin texto antes ni después, sin markdown:
{
    "titulo_es": "Título clickbait con dato o número, máx 65 chars",
    "titulo_en": "SEO title with exact keyword naturally placed, max 65 chars",
    "texto_es": "2-3 oraciones. Dato estadístico + descripción visual + pregunta al final.",
    "texto_en": "2-3 sentences. Statistical fact + visual connection + shareable ending.",
    "descripcion_visual_es": "2-3 oraciones sensoriales aspiracionales describiendo la imagen de lujo.",
    "descripcion_visual_en": "2-3 aspirational sensory sentences describing the luxury image.",
    "meta_descripcion_en": "Google meta description 120-155 chars with keyword for SEO ranking.",
    "imagen_prompt": "Detailed 12+ word English prompt: style + subject + lighting + colors + mood for Unsplash"
}`;

    const fallback = {
        titulo_es: "El secreto de lujo que el 78% de mujeres en NYC ya conocen",
        titulo_en: "Best Luxury Smart Home Gadgets 2026: What NYC Women Are Buying",
        texto_es: "El 78% de las mujeres de alto poder adquisitivo en Manhattan invierten más en tecnología para el hogar que en accesorios de moda. Como puedes ver en esta imagen, el nuevo lujo no se lleva — se vive. ¿Ya eres de las que saben?",
        texto_en: "78% of high-income women in NYC now invest more in home tech than luxury fashion. As you can see in this image, the new status isn't worn — it's lived. Are you one of them?",
        descripcion_visual_es: "Ese acabado que ves en la imagen no es casualidad — es la elección deliberada de una mujer que entiende que el verdadero estatus se siente desde adentro. Cada detalle habla sin decir una palabra.",
        descripcion_visual_en: "That finish you see is no accident — it's the deliberate choice of a woman who understands real status is felt from within. Every detail speaks without saying a word.",
        meta_descripcion_en: "Discover the best luxury smart home gadgets 2026 that NYC and Beverly Hills women are investing in. The new status symbol lives in your home.",
        imagen_prompt: "luxury modern living room elegant woman NYC apartment golden hour warm lighting minimalist decor"
    };

    if (!model) return fallback;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        const data = JSON.parse(clean);
        console.log(`✨ SEO Curiosidad: "${data.titulo_en}"`);
        return data;
    } catch(e) {
        console.log('⚠️ Error Gemini curiosidad:', e.message);
        return fallback;
    }
}

async function publicarCuriosidadAutomatica() {
    console.log('🤖 Bot Gemini SEO: Publicando curiosidad...');
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
    console.log(`✨ Publicada: "${nueva.titulo_en}"`);
    return nueva;
}

// ============================================================
// MÓDULO 2 — COPY PRODUCTOS SEO (MXL LINK+FOTO, GEMINI ESCRIBE)
// ============================================================
async function generarCopyProductoConGemini(url, imagenUrl, categoria, precio) {
    const prompt = `
Eres el mejor copywriter de lujo y SEO para Amazon Affiliates en USA.
Tu copy hace que la lectora NECESITE el producto Y rankea en Google.

PRODUCTO AMAZON: ${url}
IMAGEN DEL PRODUCTO: ${imagenUrl}
CATEGORÍA: ${categoria || 'luxury home'}
PRECIO: ${precio || 'Premium USA'}

MISIÓN DOBLE:
1. SEO: El título debe rankear en Google con keywords de alta búsqueda
2. CONVERSIÓN: El copy debe hacer que la mujer haga clic en "Ver en Amazon" en menos de 30 segundos

REGLAS SEO PARA EL TÍTULO:
- Incluye año "2026" si es posible
- Incluye palabras como "best", "luxury", "review", "women", "home"  
- Máximo 70 caracteres
- Ejemplo: "Best Luxury Food Cycler 2026: Why NYC Women Are Ditching Trash Cans"

REGLAS DE COPY DE ALTO IMPACTO:
1. intro: Primeras 2 líneas determinan si sigue leyendo. Empieza con DATO o PREGUNTA impactante
2. descripcion_visual: Conecta con lo que SE VE en la imagen — "Ese diseño compacto que ves...", "La pantalla que notas..."
3. problema: El dolor real que este producto resuelve (tiempo, dinero, estatus, salud)
4. solucion: Cómo lo resuelve visualmente — menciona lo que se ve en la imagen
5. prueba_social: Nombre real + ciudad USA + resultado específico (no genérico)
6. cierre: FOMO real — escasez, tendencia, exclusividad

RESPONDE SOLO CON JSON VÁLIDO:
{
    "titulo": "SEO title with keywords, max 70 chars",
    "meta_descripcion": "Google meta description 155 chars max with main keyword",
    "intro": "Hook impactante en 2 oraciones — dato o pregunta que para el scroll",
    "descripcion_visual": "3-4 oraciones sensoriales conectadas con lo que se VE en la imagen",
    "problema": "El problema específico y costoso que resuelve este producto",
    "solucion": "Cómo lo resuelve — menciona el diseño/acabado visible en la imagen",
    "beneficio_estatus": "El nuevo estatus social que da tener esto. Lenguaje aspiracional.",
    "prueba_social": "Nombre + ciudad USA + resultado específico y creíble",
    "cierre": "Frase FOMO urgente que mencione algo visible del producto",
    "curiosidad": "Dato estadístico impactante sobre este tipo de producto en USA",
    "palabras_clave": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}`;

    const fallback = {
        titulo: "Best Luxury Home Investment 2026: What NYC Women Are Buying",
        meta_descripcion: "Discover why NYC and Beverly Hills women are investing in this luxury home product. The new status symbol that lives inside your home.",
        intro: "There's one detail in this image that interior designers in Beverly Hills can't stop recommending — and it costs less than one designer bag.",
        descripcion_visual: "Look at the clean lines you see in the image — that's not just design, that's intention. Every curve, every finish was engineered for the woman who has stopped settling for ordinary. This is what 2026 luxury looks like in practice.",
        problema: "You've invested in the right neighborhood, the right clothes — but your home still feels like it's missing something that money alone can't explain.",
        solucion: "That compact, elegant form you see is exactly the difference. It doesn't announce itself loudly; it simply makes everything around it feel more considered.",
        beneficio_estatus: "Women who own this don't explain their taste. They let their space speak. And their space says everything.",
        prueba_social: "Gabriela from Miami's Brickell: 'Three guests have asked me where I found it. I just smile. That's the point.'",
        cierre: "While others are still searching, you could already be living it. That design you see won't wait.",
        curiosidad: "Interior designers in Manhattan report a 156% increase in clients prioritizing signature home pieces over clothing budgets in 2026.",
        palabras_clave: ["luxury home 2026", "best home investment", "NYC women lifestyle", "luxury smart home", "Beverly Hills home"]
    };

    if (!model) return fallback;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        const copy = JSON.parse(clean);
        console.log(`🔥 SEO Copy: "${copy.titulo}"`);
        return copy;
    } catch(e) {
        console.log('⚠️ Error Gemini copy:', e.message);
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
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap');
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Lato',sans-serif; background:#fffaf7; color:#1a1a1a; line-height:1.7; }
        .hero { background:linear-gradient(135deg,#1a1a2e,#16213e); padding:60px 20px; text-align:center; }
        .hero h1 { font-family:'Playfair Display',serif; font-size:2.4rem; color:#fff; max-width:800px; margin:0 auto 20px; line-height:1.25; }
        .hero .fact-pill { display:inline-block; background:#ff4500; color:#fff; padding:10px 22px; border-radius:40px; font-size:13px; font-weight:700; margin-top:10px; }
        .article-body { max-width:800px; margin:0 auto; padding:50px 20px; }
        .intro-lead { font-family:'Playfair Display',serif; font-size:1.2rem; color:#4a3727; border-left:4px solid #ff4500; padding-left:20px; margin:30px 0; font-style:italic; line-height:1.6; }
        .product-image-wrap { text-align:${imagePosition||'center'}; margin:35px 0; background:#faf7f3; border-radius:20px; padding:${pad}; }
        .product-image-wrap img { max-width:100%; border-radius:12px; object-fit:contain; max-height:${maxH}; }
        .visual-description { background:linear-gradient(135deg,#fff5f0,#fdf0e8); border-left:4px solid #c9a87b; padding:25px 25px 25px 30px; border-radius:0 16px 16px 0; margin:30px 0; font-family:'Playfair Display',serif; font-style:italic; color:#4a3727; font-size:1.05rem; line-height:1.7; }
        h2 { font-family:'Playfair Display',serif; font-size:1.5rem; color:#2c2418; margin:40px 0 12px; }
        p { color:#3a2e24; margin-bottom:18px; font-size:1rem; }
        .social-proof { background:#fff; border:1px solid #f0e2d8; border-left:4px solid #ff4500; padding:22px; border-radius:0 16px 16px 0; margin:30px 0; font-style:italic; color:#6b5a48; }
        .social-proof strong { color:#2c2418; display:block; margin-top:10px; font-style:normal; font-size:0.85rem; }
        .btn-buy { display:block; background:linear-gradient(135deg,#ff4500,#ff6b35); color:#fff; padding:18px 35px; text-decoration:none; border-radius:50px; font-weight:700; text-align:center; margin:40px 0; font-size:1.1rem; transition:all .3s; box-shadow:0 8px 25px rgba(255,69,0,.3); }
        .btn-buy:hover { transform:translateY(-2px); box-shadow:0 12px 30px rgba(255,69,0,.4); }
        .stat-box { background:#1a1a2e; color:#fff; padding:25px; border-radius:16px; margin:30px 0; text-align:center; }
        .stat-box p { color:rgba(255,255,255,.85); font-size:0.95rem; }
        .breadcrumb { font-size:12px; color:#aaa; margin-bottom:30px; }
        footer { margin-top:60px; padding:30px 0; border-top:1px solid #f0e2d8; font-size:11px; color:#aaa; text-align:center; }
        @media(max-width:600px){ .hero h1{font-size:1.6rem} }
    </style>
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "${copy.titulo}",
        "description": "${copy.meta_descripcion || copy.curiosidad}",
        "image": "${imagenUrl}",
        "author": { "@type": "Organization", "name": "MXL Gold Miner" },
        "publisher": { "@type": "Organization", "name": "MXL Gold Miner" },
        "datePublished": "${new Date().toISOString()}"
    }
    </script>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
        <span class="fact-pill">🔥 ${copy.curiosidad}</span>
    </div>
    <div class="article-body">
        <div class="breadcrumb">Home &rsaquo; ${categoria || 'Luxury'} &rsaquo; ${copy.titulo}</div>
        <div class="intro-lead">${copy.intro}</div>
        <div class="product-image-wrap">
            <img src="${imagenUrl}" alt="${copy.titulo}" loading="lazy">
        </div>
        <div class="visual-description">✨ ${copy.descripcion_visual}</div>
        <h2>The Problem That's Costing You More Than Money</h2>
        <p>${copy.problema}</p>
        <h2>Why This Changes Everything in 2026</h2>
        <p>${copy.solucion}</p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">🔴 CHECK PRICE ON AMAZON →</a>
        <h2>The New Status Signal No One Talks About</h2>
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

app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const c = await publicarCuriosidadAutomatica();
        res.json({ success: true, curiosidad: c });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch(e) { res.json([]); }
});

app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const i = data.findIndex(c => c.id == req.params.id);
        if (i !== -1) { data[i].compartidas = (data[i].compartidas||0)+1; fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data,null,2)); }
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

app.post('/api/generar-copy-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, precio } = req.body;
        if (!url)       return res.status(400).json({ success: false, error: 'URL Amazon requerida' });
        if (!imagenUrl) return res.status(400).json({ success: false, error: 'URL imagen requerida' });
        const copy = await generarCopyProductoConGemini(url, imagenUrl, categoria, precio);
        res.json({ success: true, copy });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

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
        console.log(`✅ Producto SEO publicado: "${art.titulo}"`);
        res.json({ success: true, articulo: art });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch(e) { res.json([]); }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(req.body.articulos, null, 2));
        cache.clear();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) { data[i].clicks = (data[i].clicks||0)+1; fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data,null,2)); }
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// ============================================================
// CRON — Curiosidades SEO cada 3 horas
// ============================================================
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ CRON SEO: Generando curiosidad optimizada...');
    await publicarCuriosidadAutomatica();
});

app.listen(PORT, '0.0.0.0', () => {
    const art = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const cur = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    console.log(`
╔══════════════════════════════════════════════════════════╗
║       🏮 MXL GOLD MINER — SEO EXPERT SYSTEM 🏮          ║
╠══════════════════════════════════════════════════════════╣
║  💎 CURIOSIDADES SEO (Gemini autónomo)                  ║
║     ✅ 12 temas rotativos para variedad Google          ║
║     ✅ Keywords en EN + ES por cada post                ║
║     ✅ Meta descripción SEO incluida                    ║
║     📊 ${String(cur).padEnd(3)} curiosidades guardadas               ║
║                                                          ║
║  💰 COPY PRODUCTOS SEO (mxl link+foto)                  ║
║     ✅ Título optimizado para Google + Amazon           ║
║     ✅ Schema.org JSON-LD incluido                      ║
║     ✅ OG tags para redes sociales                      ║
║     ✅ Copy visual conectado con imagen real            ║
║     📊 ${String(art).padEnd(3)} productos publicados                 ║
║                                                          ║
║  🚀 Puerto: ${PORT}                                        ║
║  🤖 Gemini: ${model ? '✅ ACTIVADO     ' : '⚠️ NO DISPONIBLE'}               ║
╚══════════════════════════════════════════════════════════╝
    `);
    if (cur === 0) {
        console.log('📦 Generando primera curiosidad SEO...');
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
