const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('.')); 

const DB_PATH = path.join(__dirname, 'productos.json');

if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

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

app.get('/api/productos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 MXL GOLD MINER activo en puerto ${PORT}`);
});
