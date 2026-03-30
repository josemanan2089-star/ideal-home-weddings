const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// Cache
const cache = new Map();
const CACHE_TTL = 300000; // 5 minutos

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

// ============ PLANTILLAS PREGENERADAS (NO GASTAN API) ============
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
    },
    {
        titulo: "El secreto que las novias de Manhattan esconden en su lista de bodas",
        dato: "El 82% de las bodas de lujo en NYC ahora incluyen electrodomésticos inteligentes como los más pedidos, superando a la cristalería fina.",
        reflexion: "Las novias modernas saben que un hogar inteligente vale más que 12 copas de cristal que nunca usarán.",
        cierre: "¿Quieres una lista de bodas que impresione? Esto es lo que todas están pidiendo."
    },
    {
        titulo: "La razón por la que las mujeres de Chicago están tirando sus ollas de hierro fundido",
        dato: "El 71% de las cocinas remodeladas en Chicago en 2026 han eliminado los electrodomésticos tradicionales por versiones inteligentes y automáticas.",
        reflexion: "Porque el tiempo es el nuevo lujo. Una cocina que cocina sola vale más que cualquier utensilio manual.",
        cierre: "Las mujeres que saben, ya cocinan con tecnología. ¿Tú sigues perdiendo horas en la cocina?"
    },
    {
        titulo: "El aparato que está eliminando las colas del supermercado en Los Ángeles",
        dato: "Los hogares de lujo en LA están reduciendo sus compras de supermercado en un 47% gracias a los sistemas de compostaje y cultivo en casa.",
        reflexion: "Menos viajes al supermercado, más tiempo para ti. Eso es el verdadero lujo moderno.",
        cierre: "Mientras otras hacen fila, tú disfrutas tu tiempo. Eso es lo que las mujeres que saben eligen."
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
    },
    {
        titulo: "The $0 Trash Status Symbol Taking Over Manhattan",
        intro: "Upper East Side families now judge their neighbors by what ISN'T in their trash.",
        problema: "Sending organic waste to landfill is now considered 'visibly low-status' in 2026.",
        solucion: "This smart composter turns 19L of food scraps into soil in 4 hours, with zero odor and zero noise.",
        beneficio: "No plumbing, no installation. Just the quiet confidence of a zero-waste home.",
        cierre: "It's the #1 registry item for couples who want their friends to know they've 'made it'."
    },
    {
        titulo: "The Kitchen Upgrade That's Replacing Luxury Cars in Miami",
        intro: "Miami women are making a surprising choice with their disposable income.",
        problema: "A luxury car depreciates the moment you drive it off the lot. Your kitchen should appreciate your lifestyle.",
        solucion: "Smart appliances that do the work while you enjoy your mimosa with friends.",
        beneficio: "More time for Pilates, brunch, and actually enjoying your home.",
        cierre: "The women who know, invest where it matters. Will you?"
    }
];

// ============ FUNCIÓN PARA USAR GEMINI SOLO CUANDO ES NECESARIO ============
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
    
    if (plantilla && !plantilla.titulo?.includes('Gemini')) {
        return plantilla;
    }
    
    const prompt = `
    Genera una CURIOSIDAD FEMENINA sobre hogar, lujo, estilo de vida en USA.
    Formato: TITULO: ... DATO: ... REFLEXION: ... CIERRE: ...
    `;
    
    const response = await usarGeminiSoloCuandoNecesario(prompt, 'curiosidad_gemini');
    
    if (response && typeof response === 'string') {
        return {
            titulo: response.match(/TITULO:\s*(.+)/i)?.[1] || "El secreto femenino",
            dato: response.match(/DATO:\s*(.+)/i)?.[1] || "Descubre el nuevo lujo silencioso",
            reflexion: response.match(/REFLEXION:\s*(.+)/i)?.[1] || "Porque las mujeres que saben viven mejor",
            cierre: response.match(/CIERRE:\s*(.+)/i)?.[1] || "Únete al club de las que saben"
        };
    }
    
    return plantillasCuriosidades[0];
}

// ============ GENERAR ARTÍCULO ============
async function generarArticuloConProducto(url, imagenUrl = '', imageSize = 'medium', imagePosition = 'center') {
    let asin = '';
    const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
    if (asinMatch) asin = asinMatch[1];
    
    const plantilla = await usarGeminiSoloCuandoNecesario(null, 'articulo');
    
    if (plantilla && !plantilla.titulo?.includes('Gemini')) {
        return {
            id: Date.now(),
            asin: asin,
            titulo: plantilla.titulo,
            intro: plantilla.intro,
            problema: plantilla.problema,
            solucion: plantilla.solucion,
            beneficio: plantilla.beneficio,
            cierre: plantilla.cierre,
            imagen: imagenUrl || (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : 'https://picsum.photos/400/300'),
            imageSize: imageSize,
            imagePosition: imagePosition,
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0,
            orden: 0
        };
    }
    
    const prompt = `
    Genera un ARTÍCULO para producto Amazon: ${url}
    Formato JSON: {"titulo":"...", "intro":"...", "problema":"...", "solucion":"...", "beneficio":"...", "cierre":"..."}
    `;
    
    const response = await usarGeminiSoloCuandoNecesario(prompt, 'articulo_gemini');
    
    if (response && typeof response === 'string') {
        try {
            const cleanJson = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            const content = JSON.parse(cleanJson);
            return {
                id: Date.now(),
                asin: asin,
                ...content,
                imagen: imagenUrl || (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : 'https://picsum.photos/400/300'),
                imageSize: imageSize,
                imagePosition: imagePosition,
                link: url,
                fecha: new Date().toISOString(),
                clicks: 0,
                orden: 0
            };
        } catch (e) {
            console.error('Error parsing:', e);
        }
    }
    
    return {
        id: Date.now(),
        asin: asin,
        titulo: "The Essential Every Modern Home Needs",
        intro: "Discover why women across America are adding this to their homes",
        problema: "Your home deserves better than outdated solutions",
        solucion: "This revolutionary product transforms your daily life",
        beneficio: "Join thousands of women who already made the switch",
        cierre: "The women who know, already have theirs",
        imagen: imagenUrl || (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : 'https://picsum.photos/400/300'),
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
            console.log('📦 No hay contenido para rotar, generando uno nuevo...');
            await publicarCuriosidadAutomatica();
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
        
        if (curiosidades.length > 0) {
            const randomCuriosity = Math.floor(Math.random() * curiosidades.length);
            const curiosidadSeleccionada = curiosidades[randomCuriosity];
            
            curiosidadSeleccionada.fecha = new Date().toISOString();
            curiosidadSeleccionada.republicada = (curiosidadSeleccionada.republicada || 0) + 1;
            
            curiosidades.splice(randomCuriosity, 1);
            curiosidades.unshift(curiosidadSeleccionada);
            
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(curiosidades, null, 2));
            console.log(`✅ Republicada curiosidad: "${curiosidadSeleccionada.titulo}"`);
        }
        
        cache.clear();
        
    } catch (error) {
        console.error('❌ Error en bot rotador:', error.message);
    }
}

// ============ PUBLICACIÓN AUTOMÁTICA ============
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando NUEVA curiosidad con Gemini (1 vez al día)...');
    try {
        const nuevaCuriosidad = await generarCuriosidadFemenina();
        
        const curiosidadCompleta = {
            id: Date.now(),
            ...nuevaCuriosidad,
            fecha: new Date().toISOString(),
            compartidas: 0,
            generadaPor: 'gemini'
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
        gemini: model ? 'active' : 'inactive',
        articulos: JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length,
        curiosidades: JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
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

// 🔥 ENDPOINT PARA PUBLICAR ARTÍCULO (con tamaño y posición)
app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, imagenUrl, imageSize, imagePosition } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        const nuevoArticulo = await generarArticuloConProducto(url, imagenUrl, imageSize || 'medium', imagePosition || 'center');
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        res.json({ success: true, articulo: nuevoArticulo });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔥 NUEVO ENDPOINT PARA ORDENAR ARTÍCULOS
app.put('/api/ordenar-articulos', (req, res) => {
    try {
        const { articulos: nuevosArticulos } = req.body;
        
        if (!nuevosArticulos || !Array.isArray(nuevosArticulos)) {
            return res.status(400).json({ success: false, error: 'Datos inválidos' });
        }
        
        // Actualizar fechas para reflejar el nuevo orden
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

// 🔥 NUEVO ENDPOINT PARA EDITAR ARTÍCULO
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
            compartidas: 0,
            generadaPor: 'plantilla'
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

// ============ CRON JOBS ============
cron.schedule('0 */3 * * *', () => {
    console.log('⏰ CRON: Ejecutando Bot Rotador...');
    botRotador();
});

cron.schedule('0 10 * * *', () => {
    console.log('⏰ CRON: Ejecutando Gemini (1 vez al día)...');
    publicarCuriosidadAutomatica();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    const articulosCount = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const curiosidadesCount = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║     ✨ SISTEMA HÍBRIDO: GEMINI + BOT ROTADOR ✨         ║
    ╠══════════════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                                       ║
    ║  📰 Artículos: ${articulosCount} guardados                ║
    ║  💎 Curiosidades: ${curiosidadesCount} guardadas          ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO (solo 1 vez/día)' : '❌ NO DISPONIBLE'}    
    ║  🔄 Bot Rotador: CADA 3 HORAS (republica sin gastar API)  ║
    ║  📦 Plantillas: ${plantillasCuriosidades.length + plantillasArticulos.length} pregrabadas ║
    ║  🎨 Controles Visuales: Tamaño + Posición + Orden ✅      ║
    ║  💨 Cache: ACTIVADO (5 min)                               ║
    ╚══════════════════════════════════════════════════════════╝
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
                compartidas: 0,
                generadaPor: 'plantilla_inicial'
            };
            data.push(curiosidad);
        }
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        console.log('✅ Cargadas 3 curiosidades iniciales');
    }
});
