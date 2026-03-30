const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, '/')));

const DB_PATH = path.join(__dirname, 'productos.json');

// Crear DB si no existe
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
    console.log('✅ Archivo productos.json creado');
}

// HEALTH CHECK para Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// RUTA PRINCIPAL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// RUTA DEL PANEL
app.get('/mxl-panel-2026.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mxl-panel-2026.html'));
});

// ENDPOINT PARA PUBLICAR PRODUCTOS
app.post('/api/publicar', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const nuevoProducto = {
            id: Date.now(),
            title: req.body.tEn || req.body.title || 'Sin título',
            title_es: req.body.tEs || '',
            description: req.body.dEn || '',
            description_es: req.body.dEs || '',
            image: req.body.img || req.body.image || '',
            link: req.body.link || '#',
            fecha: req.body.fecha || new Date().toISOString()
        };
        
        data.unshift(nuevoProducto);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        console.log(`✅ Producto publicado: ${nuevoProducto.title}`);
        res.json({ success: true, message: "Producto publicado" });
    } catch (error) {
        console.error('Error en /api/publicar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT PARA IA BOT
app.post('/api/ia-bot', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ success: false, error: "URL requerida" });
        }
        
        // Extraer ASIN de Amazon URL
        let asin = '';
        const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
        if (asinMatch) asin = asinMatch[1];
        
        // Generar contenido automático
        const tituloGenerado = asin ? `Premium Product - ${asin}` : 'Premium Amazon Product';
        const tituloEs = asin ? `Producto Premium - ${asin}` : 'Producto Premium Amazon';
        const descripcionGen = `Discover this amazing product on Amazon. Perfect for modern homes. High-quality materials, durable design. Limited time offer! ✓ Premium Quality ✓ Best Seller ✓ Fast Shipping`;
        const descripcionEs = `Descubre este increíble producto en Amazon. Perfecto para hogares modernos. Materiales de alta calidad, diseño duradero. ¡Oferta por tiempo limitado! ✓ Calidad Premium ✓ Más Vendido ✓ Envío Rápido`;
        
        res.json({
            success: true,
            tEn: tituloGenerado,
            tEs: tituloEs,
            dEn: descripcionGen,
            dEs: descripcionEs
        });
        
    } catch (error) {
        console.error('Error en /api/ia-bot:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT PARA OBTENER PRODUCTOS
app.get('/api/productos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        res.json(data);
    } catch (e) {
        console.error('Error leyendo productos:', e);
        res.json([]);
    }
});

// Manejo de señales para evitar que Railway mate el proceso
process.on('SIGTERM', () => {
    console.log('🛑 Recibido SIGTERM, cerrando servidor...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 Recibido SIGINT, cerrando servidor...');
    process.exit(0);
});

// Iniciar servidor
const server = app.listen(PORT, () => {
    console.log(`🚀 MXL GOLD MINER ONLINE EN PUERTO ${PORT}`);
    console.log(`✅ Health check: http://localhost:${PORT}/health`);
    console.log(`✅ Panel: http://localhost:${PORT}/mxl-panel-2026.html`);
});

// Timeout para mantener el proceso vivo
server.timeout = 0;
server.keepAliveTimeout = 0;
