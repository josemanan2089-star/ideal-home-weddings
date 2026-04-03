<!DOCTYPE html>
<html lang="en-US">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MXL Gold | Elite Selection</title>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=DM+Sans:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root { --black: #0a0a0a; --gold: #c9a87b; --fire: #ff3300; --surface: #f8f7f5; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'DM Sans', sans-serif; background: var(--surface); color: var(--black); }
        
        nav { background: #fff; padding: 15px; text-align: center; border-bottom: 1px solid #eee; position: sticky; top: 0; z-index: 100; }
        .logo { font-family: 'Cormorant Garamond', serif; font-size: 1.8rem; font-weight: bold; }
        
        .hero { background: var(--black); color: #fff; padding: 40px 20px; text-align: center; }
        .hero h1 { font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; }
        
        /* GRID CENTRADO MXL */
        .grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 25px; 
            max-width: 1200px; 
            margin: 40px auto; 
            padding: 0 20px;
            justify-content: center;
        }

        .card { 
            background: #fff; 
            border-radius: 20px; 
            overflow: hidden; 
            border: 1px solid #eee; 
            transition: 0.3s; 
            position: relative;
            display: flex;
            flex-direction: column;
        }
        .card:hover { transform: translateY(-10px); box-shadow: 0 15px 30px rgba(0,0,0,0.1); }
        
        .card-img { width: 100%; aspect-ratio: 1; background: #fafafa; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
        
        .badge { position: absolute; top: 15px; left: 15px; background: var(--fire); color: #fff; padding: 4px 12px; border-radius: 50px; font-size: 10px; font-weight: bold; }

        .card-body { padding: 20px; flex-grow: 1; display: flex; flex-direction: column; }
        .card-title { font-family: 'Cormorant Garamond', serif; font-size: 1.2rem; margin-bottom: 10px; min-height: 2.8rem; }
        .fomo-text { color: var(--fire); font-size: 11px; font-weight: bold; margin-bottom: 10px; }
        .card-price { font-size: 1.4rem; font-weight: 700; margin-bottom: 15px; margin-top: auto; }

        .btn-cta { 
            width: 100%; 
            background: var(--black); 
            color: #fff; 
            border: none; 
            padding: 14px; 
            border-radius: 50px; 
            font-weight: bold; 
            cursor: pointer; 
            text-transform: uppercase; 
            font-size: 12px; 
        }
        .btn-cta:hover { background: var(--fire); }

        footer { text-align: center; padding: 30px; color: #888; font-size: 11px; }
    </style>
</head>
<body>

<nav><div class="logo">MXL <span style="color:var(--gold)">Gold</span></div></nav>
<header class="hero"><h1>Elite Selection <em>NYC & Miami</em></h1></header>

<main class="grid" id="productGrid"></main>

<footer>© 2026 MXL Gold. We earn from qualifying purchases on Amazon.</footer>

<script>
    async function loadProducts() {
        const grid = document.getElementById('productGrid');
        try {
            const res = await fetch('/api/productos');
            const { items } = await res.json();
            
            grid.innerHTML = items.map((p, index) => {
                const viewers = Math.floor(Math.random() * 25) + 8;
                
                // DISPARAR TRACKING DE IMPRESIÓN REAL
                fetch('/api/track/impression', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({id: p.id})
                });

                return `
                <article class="card">
                    ${p.ctr > 0.05 ? '<div class="badge">🔥 BEST SELLER</div>' : ''}
                    <div class="card-img"><img src="${p.imagen}" alt="${p.titulo}"></div>
                    <div class="card-body">
                        <h3 class="card-title">${p.titulo}</h3>
                        <div class="fomo-text">🔥 ${viewers} people buying right now</div>
                        <div class="card-price">$${parseFloat(p.precio).toFixed(2)} <span style="font-size:10px; color:#888;">USD</span></div>
                        <button class="btn-cta" onclick="window.open('/go/${p.id}', '_blank')">🔥 View on Amazon</button>
                    </div>
                </article>
                `;
            }).join('');
        } catch(e) { console.log("Error cargando"); }
    }
    loadProducts();
</script>
</body>
</html>
