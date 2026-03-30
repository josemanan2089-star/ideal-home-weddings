const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

// Configuración para recibir datos del panel
app.use(express.json());

// 🚀 ESTO ES LO QUE RESUELVE LA PANTALLA BLANCA
// Le dice al servidor que busque los archivos en la carpeta principal
app.use(express.static(__dirname));

const DB_PATH = path.join(__dirname, 'productos.json');

// Crear la base de datos si no existe
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

// Ruta principal para ver la tienda
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Ruta para recibir los productos del botón verde
app.post('/api/publicar', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(req.body); 
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ruta para que la web lea los productos guardados
app.get('/api/productos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 MXL GOLD MINER ACTIVO EN PUERTO ${PORT}`);
});
