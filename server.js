const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));
app.use('/temp', express.static(path.join(__dirname, 'temp')));

// Cache
const cache = new Map();
const CACHE_TTL = 300000; // 5 minutos

// Crear carpeta temporal si no existe
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Gemini solo se usa cuando es necesario
let genAI;
let model;

try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-pro" });
    console.log('✅ Gemini inicializado (uso limitado)');
} catch (error) {
    console.log('⚠️ Gemini no disponible, modo solo rotación');
}

// Archivos
const ARTICULOS_PATH = path.join(__dirname, 'articulos.json');
const CURIOSIDADES_PATH = path.join(__dirname, 'curiosidades.json');

// Inicializar archivos
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

// ============ FUNCIONES PARA CAPTURAR CARRUSEL Y VIDEO DE AMAZON ============

// Función para extraer ASIN de URL de Amazon
function extraerASIN(url) {
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i,
        /\/dp\/([A-Z0-9]{10})/i
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Función para capturar imágenes del carrusel de Amazon
async function capturarCarruselAmazon(asin) {
    try {
        // URLs de imágenes de Amazon (alta calidad)
        const imagenes = [];
        
        // Imagen principal
        imagenes.push({
            url: `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_SL1500_.jpg`,
            tipo: 'principal',
            calidad: 'alta'
        });
        
        // Intentar capturar imágenes adicionales (carrusel)
        const variantes = ['61', '71', '81', '91', '41'];
        for (const variant of variantes) {
            imagenes.push({
                url: `https://images-na.ssl-images-amazon.com/images/I/${variant}${asin}._AC_SL1500_.jpg`,
                tipo: 'secundaria',
                calidad: 'alta'
            });
        }
        
        // También intentar capturar video de Amazon si existe
        const videoUrl = `https://www.amazon.com/dp/${asin}`;
        
        return {
            success: true,
            imagenes: imagenes,
            videoUrl: videoUrl,
            asin: asin
        };
        
    } catch (error) {
        console.error('Error capturando carrusel:', error);
        return {
            success: false,
            imagenes: [],
            videoUrl: null,
            asin: asin
        };
    }
}

// Función para descargar y comprimir imagen
async function descargarYComprimirImagen(url, nombreArchivo) {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const extension = url.split('.').pop().split('?')[0] || 'jpg';
        const rutaTemp = path.join(TEMP_DIR, `${nombreArchivo}_original.${extension}`);
        const rutaComprimida = path.join(TEMP_DIR, `${nombreArchivo}.webp`);
        
        // Guardar imagen original
        fs.writeFileSync(rutaTemp, response.data);
        
        // Intentar comprimir con sharp si está disponible, si no usar alternativa
        try {
            const sharp = require('sharp');
            await sharp(rutaTemp)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 80 })
                .toFile(rutaComprimida);
            
            // Eliminar original
            fs.unlinkSync(rutaTemp);
            
            return {
                success: true,
                ruta: rutaComprimida,
                url: `/temp/${nombreArchivo}.webp`,
                tamaño: fs.statSync(rutaComprimida).size
            };
        } catch (sharpError) {
            // Si sharp no está disponible, solo guardar original
            console.log('⚠️ Sharp no disponible, guardando imagen sin comprimir');
            const rutaFinal = path.join(TEMP_DIR, `${nombreArchivo}.${extension}`);
            fs.renameSync(rutaTemp, rutaFinal);
            return {
                success: true,
                ruta: rutaFinal,
                url: `/temp/${nombreArchivo}.${extension}`,
                tamaño: fs.statSync(rutaFinal).size
            };
        }
        
    } catch (error) {
        console.error('Error descargando imagen:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Función para capturar video de Amazon (embed)
function obtenerEmbedVideo(asin) {
    // Amazon tiene videos embebidos en las páginas de producto
    // Este es un placeholder para el video si existe
    return {
        embedUrl: `https://www.amazon.com/dp/${asin}`,
        thumbnail: `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg`,
        videoExiste: true
    };
}

// ============ PLANTILLAS PREGENERADAS ============
const plantillasCuriosidades = [
    {
        titulo: "El secreto que las mujeres de NYC esconden en su cocina",
        dato: "El 78% de las mujeres de alto poder adquisitivo en Manhattan consideran que un composter de lujo es más importante que un auto europeo en 2026.",
        reflexion: "Porque el verdadero estatus ya no se muestra en el garaje, sino en lo que NO sale de tu cocina.",
        cierre: "Las mujeres que saben, ya tienen el suyo. ¿Tú también quieres ser de las que saben?"
    },
    {
        titulo: "La tendencia que está eliminando las bolsas de basura en Beverly Hills",
        dato: "El 63% de las casas de lujo en Beverly Hills ya han eliminado por completo los desechos orgánicos de sus bolsas de basura.",
        reflexion: "En 2026, tener una casa 'zero-waste' es el nuevo símbolo de estatus silencioso que todas quieren mostrar.",
        cierre: "Mientras tus vecinas siguen sacando bolsas apestosas, tú ya estás en el futuro del lujo sostenible."
    },
    {
        titulo: "El gadget que está reemplazando a los bolsos de diseñador en Miami",
        dato: "Las mujeres de Miami están invirtiendo más en tecnología para el hogar que en bolsos de lujo. El aumento es del 156% desde 2024.",
        reflexion: "Porque el verdadero lujo ahora se vive en casa, no se lleva puesto. La comodidad es el nuevo estatus.",
        cierre: "Las mujeres que saben, ya tienen el suyo. ¿Te unes al club de las que invierten en su hogar?"
    }
];

const plantillasArticulos = [
    {
        titulo: "The Silent Luxury Revolution: Why NYC Women Are Ditching Designer Bags",
        intro: "There's a new status symbol in town, and it doesn't go on your arm—it goes in your kitchen.",
        problema: "You've been spending thousands on items that impress others for 5 seconds, while your home remains cluttered and inefficient.",
        solucion: "This revolutionary appliance transforms your daily routine into a seamless luxury experience.",
        beneficio: "Join the elite circle of women who understand true status isn't shown, it's lived.",
        cierre: "The women who know, already have theirs. Will you be next?"
    }
];

// ============ FUNCIÓN PARA USAR GEMINI ============
async function usarGeminiSoloCuandoNecesario(prompt, tipo) {
    if (tipo === 'curiosidad' && plantillasCuriosidades.length > 0) {
        const indice = Math.floor(Math.random() * plantillasCuriosidades.length);
        console.log(`📦 Usando plantilla de curiosidad (sin gastar API): ${plantillasCuriosidades[indice].titulo}`);
        return plantillasCuriosidades[indice];
    }
    
    if (tipo === 'articulo' && plantillasArticulos.length > 0) {
        const indice = Math.floor(Math.random() * plantillasArticulos.length);
        console.log(`📦 Usando plantilla de artículo (sin gastar API): ${plantillasArticulos[indice].titulo}`);
        return plantillasArticulos[indice];
    }
    
    if (!model) {
        console.log('⚠️ No hay plantillas ni Gemini disponible');
        return null;
    }
    
    console.log('🤖 Usando Gemini (gastando API key)...');
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        return text;
    } catch (error) {
        console.error('❌ Error Gemini:', error.message);
        return null;
    }
}

// ============ GENERAR CURIOSIDAD ============
async function generarCuriosidadFemenina() {
    const plantilla = await usarGeminiSoloCuandoNecesario(null, 'curiosidad');
    if (plantilla) return plantilla;
    
    return plantillasCuriosidades[0];
}

// ============ GENERAR ARTÍCULO CON CARRUSEL Y VIDEO ============
async function generarArticuloConProducto(url, imagenUrl = '', imageSize = 'medium', imagePosition = 'center') {
    const asin = extraerASIN(url);
    
    // Capturar carrusel de Amazon
    let carrusel = null;
    let imagenesCarrusel = [];
    let videoInfo = null;
    
    if (asin) {
        console.log(`🎬 Capturando carrusel para ASIN: ${asin}`);
        carrusel = await capturarCarruselAmazon(asin);
        
        if (carrusel.success) {
            // Descargar y comprimir primeras 3 imágenes del carrusel
            for (let i = 0; i < Math.min(3, carrusel.imagenes.length); i++) {
                const img = carrusel.imagenes[i];
                const nombreArchivo = `${asin}_carrusel_${i}`;
                const imagenComprimida = await descargarYComprimirImagen(img.url, nombreArchivo);
                
                if (imagenComprimida.success) {
                    imagenesCarrusel.push({
                        url: imagenComprimida.url,
                        tipo: img.tipo,
                        comprimido: true,
                        tamaño: imagenComprimida.tamaño
                    });
                } else {
                    imagenesCarrusel.push({
                        url: img.url,
                        tipo: img.tipo,
                        comprimido: false
                    });
                }
            }
            
            // Obtener información del video
            videoInfo = obtenerEmbedVideo(asin);
            console.log(`✅ Capturadas ${imagenesCarrusel.length} imágenes del carrusel`);
        }
    }
    
    // Usar plantilla para el contenido
    const plantilla = await usarGeminiSoloCuandoNecesario(null, 'articulo');
    
    let contenido;
    if (plantilla && !plantilla.titulo?.includes('Gemini')) {
        contenido = plantilla;
    } else {
        contenido = plantillasArticulos[0];
    }
    
    return {
        id: Date.now(),
        asin: asin,
        titulo: contenido.titulo,
        intro: contenido.intro,
        problema: contenido.problema,
        solucion: contenido.solucion,
        beneficio: contenido.beneficio,
        cierre: contenido.cierre,
        imagen: imagenUrl || (imagenesCarrusel[0]?.url || `https://picsum.photos/400/300`),
        imagenesCarrusel: imagenesCarrusel,
        video: videoInfo,
        imageSize: imageSize,
        imagePosition: imagePosition,
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0,
        orden: 0
    };
}

// ============ BOT ROTADOR ============
async function botRotador() {
    console.log('🔄 Bot Rotador: Republicando artículos existentes...');
    
    try {
        const articulos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        
        if (articulos.length === 0 && curiosidades.length === 0) {
            console.log('📦 No hay contenido para rotar');
            return;
        }
        
        if (articulos.length > 0) {
            const randomIndex = Math.floor(Math.random() * articulos.length);
            const articuloSeleccionado = articulos[randomIndex];
            
            articuloSeleccionado.fecha = new Date().toISOString();
            articuloSeleccionado.republicado = (articuloSeleccionado.republicado || 0) + 1;
            
            articulos.splice(randomIndex, 1);
            articulos.unshift(articuloSeleccionado);
            
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(articulos, null, 2));
            console.log(`✅ Republicado: "${articuloSeleccionado.titulo}"`);
        }
        
        cache.clear();
        
    } catch (error) {
        console.error('❌ Error en bot rotador:', error.message);
    }
}

// ============ PUBLICACIÓN AUTOMÁTICA ============
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando NUEVA curiosidad...');
    try {
        const nuevaCuriosidad = await generarCuriosidadFemenina();
        
        const curiosidadCompleta = {
            id: Date.now(),
            ...nuevaCuriosidad,
            fecha: new Date().toISOString(),
            compartidas: 0
        };
        
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidadCompleta);
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        cache.clear();
        console.log(`✅ NUEVA curiosidad creada: ${curiosidadCompleta.titulo}`);
        
    } catch (error) {
        console.error('❌ Error publicación automática:', error.message);
    }
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        gemini: model ? 'active' : 'inactive'
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// ============ NUEVO ENDPOINT: CAPTURAR CARRUSEL DE AMAZON ============
app.post('/api/capturar-carrusel', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        const asin = extraerASIN(url);
        if (!asin) {
            return res.status(400).json({ success: false, error: 'No se pudo extraer ASIN de la URL' });
        }
        
        const carrusel = await capturarCarruselAmazon(asin);
        
        // Descargar y comprimir imágenes del carrusel
        const imagenesProcesadas = [];
        for (let i = 0; i < Math.min(5, carrusel.imagenes.length); i++) {
            const img = carrusel.imagenes[i];
            const nombreArchivo = `${asin}_preview_${i}`;
            const imagenComprimida = await descargarYComprimirImagen(img.url, nombreArchivo);
            
            imagenesProcesadas.push({
                url: imagenComprimida.success ? imagenComprimida.url : img.url,
                comprimida: imagenComprimida.success,
                tamaño: imagenComprimida.tamaño || 0
            });
        }
        
        res.json({
            success: true,
            asin: asin,
            imagenes: imagenesProcesadas,
            video: obtenerEmbedVideo(asin)
        });
        
    } catch (error) {
        console.error('Error capturando carrusel:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ARTÍCULOS ============
app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
    }
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, imagenUrl, imageSize, imagePosition } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        console.log(`📦 Publicando artículo para URL: ${url}`);
        const nuevoArticulo = await generarArticuloConProducto(url, imagenUrl, imageSize || 'medium', imagePosition || 'center');
        
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        
        console.log(`✅ Artículo publicado: ${nuevoArticulo.titulo}`);
        res.json({ success: true, articulo: nuevoArticulo });
        
    } catch (error) {
        console.error('Error publicando artículo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        const { articulos: nuevosArticulos } = req.body;
        
        if (!nuevosArticulos || !Array.isArray(nuevosArticulos)) {
            return res.status(400).json({ success: false, error: 'Datos inválidos' });
        }
        
        const articulosConOrden = nuevosArticulos.map((art, idx) => ({
            ...art,
            orden: idx,
            fecha: new Date(Date.now() - idx * 60000).toISOString()
        }));
        
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(articulosConOrden, null, 2));
        cache.clear();
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error guardando orden:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/editar-articulo/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const index = data.findIndex(a => a.id == id);
        
        if (index !== -1) {
            data[index] = { ...data[index], ...updates };
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            cache.clear();
            res.json({ success: true, articulo: data[index] });
        } else {
            res.status(404).json({ success: false, error: 'Artículo no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const index = data.findIndex(a => a.id == id);
        if (index !== -1) {
            data[index].clicks = (data[index].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// ============ API CURIOSIDADES ============
app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
    }
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const nuevaCuriosidad = await generarCuriosidadFemenina();
        const curiosidadCompleta = {
            id: Date.now(),
            ...nuevaCuriosidad,
            fecha: new Date().toISOString(),
            compartidas: 0
        };
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidadCompleta);
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        res.json({ success: true, curiosidad: curiosidadCompleta });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const index = data.findIndex(c => c.id == id);
        if (index !== -1) {
            data[index].compartidas = (data[index].compartidas || 0) + 1;
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// Limpiar archivos temporales viejos cada hora
setInterval(() => {
    const files = fs.readdirSync(TEMP_DIR);
    const ahora = Date.now();
    files.forEach(file => {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        // Eliminar archivos de más de 24 horas
        if (ahora - stats.mtimeMs > 24 * 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Eliminado archivo temporal: ${file}`);
        }
    });
}, 60 * 60 * 1000);

// ============ CRON JOBS ============
cron.schedule('0 */3 * * *', () => {
    console.log('⏰ CRON: Ejecutando Bot Rotador...');
    botRotador();
});

cron.schedule('0 10 * * *', () => {
    console.log('⏰ CRON: Ejecutando publicación automática...');
    publicarCuriosidadAutomatica();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════════════════════╗
    ║     ✨ SISTEMA COMPLETO: CARRUSEL + VIDEO + COMPRESIÓN ✨    ║
    ╠══════════════════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                                           ║
    ║  🎬 Captura Carrusel: ✅ ACTIVADO                             ║
    ║  🎥 Captura Video: ✅ ACTIVADO                                ║
    ║  🗜️ Compresión Imágenes: ✅ ACTIVADO (WebP)                   ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO' : '❌ NO DISPONIBLE'}                 ║
    ║  🔄 Bot Rotador: CADA 3 HORAS                                 ║
    ║  🎨 Controles Visuales: Tamaño + Posición + Orden             ║
    ║  💨 Cache: ACTIVADO (5 min)                                   ║
    ╚══════════════════════════════════════════════════════════════╝
    `);
    
    // Inicializar con contenido si está vacío
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    if (data.length === 0) {
        console.log('📦 Inicializando con plantillas...');
        for (const plantilla of plantillasCuriosidades.slice(0, 3)) {
            const curiosidad = {
                id: Date.now() + Math.random(),
                ...plantilla,
                fecha: new Date().toISOString(),
                compartidas: 0
            };
            data.push(curiosidad);
        }
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        console.log('✅ Cargadas 3 curiosidades iniciales');
    }
});
