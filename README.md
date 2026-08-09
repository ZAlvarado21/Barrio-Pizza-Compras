# Barrio Pizza - Tablero de Compras e Inventario 🍕

Este es un tablero web diseñado para ayudar al gerente de compras de Barrio Pizza a revisar de manera automática las órdenes semanales de las sucursales. 

La herramienta cruza los datos de consumo histórico, inventario actual y las órdenes que subió cada sucursal para detectar rápidamente si se van a quedar sin insumos (quiebre) o si están pidiendo demasiada mercancía (sobrepedido), ahorrando tiempo y dinero.

## 🚀 Cómo correr el proyecto

El proyecto es estático, lo que significa que no necesitas instalar bases de datos ni herramientas complejas (no usa Node.js, npm, ni bases de datos). Es puro HTML, CSS y Javascript. 

Para verlo funcionando:

1. **Opción A (Recomendada si usas VS Code):**
   - Abre la carpeta del proyecto en Visual Studio Code.
   - Instala la extensión **Live Server**.
   - Haz clic derecho sobre el archivo `index.html` y dale a **"Open with Live Server"**.
   - Listo, se abrirá en tu navegador automáticamente.

2. **Opción B (Python):**
   - Si tienes Python instalado, abre tu terminal en esta carpeta y corre: `python -m http.server 8000`.
   - Luego ve a tu navegador y entra a `http://localhost:8000`.

*(Ojo: Si le das doble clic al `index.html` directamente, tu navegador va a bloquear la lectura de los archivos CSV por motivos de seguridad CORS. Por eso necesitas correrlo con un servidor local de los que te menciono arriba).*

## 🧠 Supuestos y consideraciones que tomé

Para armar la lógica y darle un toque más apegado a la realidad, tuve que asumir un par de cosas porque los datos originales no las incluían:

- **Precios de los insumos:** Los archivos CSV originales no tenían los costos de cada producto. Inventé un listado de precios (basado en promedios de Panamá) para poder calcular exactamente cuánto dinero está perdiendo la pizzería por "sobrepedidos" e inmovilización de capital.
- **Mínimos de compra:** Para la pestaña de proveedores, asumí que cada distribuidor exige un monto mínimo para dar envío gratis. Así el tablero te avisa, por ejemplo, si solo te faltan $10 para que el envío de "Molinos Central" salga gratis.
- **Redondeo hacia arriba (Formatos enteros):** Si la proyección indica que la sucursal necesita 12 kg de harina, y el saco viene de 25 kg, la fórmula asume que necesitan pedir 1 saco completo (25kg). El sobrante (13kg) se considera redondeo normal y no marca alerta de sobrepedido.
- **Chat Asistente:** Como este es un proyecto de frontend puro (corre 100% en el navegador de quien lo usa), dejé el chat configurado con algunas preguntas frecuentes ya programadas. De todas formas, dejé la conexión lista por si luego quieren pegarle una API Key real de OpenAI o Gemini para que responda cualquier cosa leyendo la data.

## 📂 Estructura de archivos

- `index.html`: Toda la estructura visual y pestañas del tablero.
- `app.js`: Acá vive la lógica fuerte. Cruza los CSV, hace las proyecciones y levanta las alertas.
- `styles.css`: Detalles extra de diseño (barras de scroll, animaciones) para complementar a Tailwind.
- `datos/`: Carpeta con los CSV originales (`consumo_historico`, `ingredientes`, `inventario_actual`, `orden_compra_semana`).

---
