// app.js

// Estado Global
let datos = {
    ingredientes: [],
    consumo: [],
    inventario: [],
    ordenes: []
};

let resultados = []; // Almacena el cruce y análisis
let api_key = "";
let ai_provider = "openai";

// Precios Simulados para Panamá (en USD por formato de compra)
const PRECIOS_SIMULADOS = {
    "harina": 22.50, // Saco 25kg
    "harina_gf": 4.50,
    "semola": 12.00,
    "levadura": 3.50,
    "oregano": 8.00,
    "mozzarella": 65.00, // Caja 10kg
    "burrata": 24.00,
    "salsa_pelatti": 5.50,
    "pepperoni": 45.00, // Caja 5kg
    "jamon": 32.00,
    "parmesano": 75.00,
    "queso_vegano": 40.00,
    "aceite_oliva": 35.00,
    "aceitunas": 18.00,
    "albahaca": 2.50,
    "arugula": 3.00,
    "hongos": 4.50,
    "cebolla": 15.00,
    "pimenton": 8.50,
    "pina": 1.50,
    "prosciutto": 85.00,
    "cajas_pizza": 12.00 // Paquete 50
};

// Mínimo de compra por proveedor para envío gratis
const MINIMO_PROVEEDOR = {
    "Molinos Central": 150,
    "Distrib. Bella Italia": 300,
    "Importadora Istmo": 100,
    "AgroFresco": 50,
    "Hongos del Valle": 30,
    "Verduras La Huerta": 50,
    "Deli Gourmet": 100,
    "EmpaqueTodo": 80
};

// Función principal de inicialización
async function init() {
    try {
        await cargarDatos();
        procesarDatos();
        renderizarUI();
        document.getElementById('loading-indicator').classList.add('hidden');
    } catch (error) {
        console.error("Error inicializando:", error);
        document.getElementById('loading-indicator').innerHTML = '<span class="text-red-500">Error cargando datos</span>';
    }
}

// Cargar CSVs usando PapaParse
function parseCSV(url) {
    return new Promise((resolve, reject) => {
        Papa.parse(url, {
            download: true,
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
            error: (err) => reject(err)
        });
    });
}

async function cargarDatos() {
    const urls = {
        ingredientes: 'datos/ingredientes.csv',
        consumo: 'datos/consumo_historico.csv',
        inventario: 'datos/inventario_actual.csv',
        ordenes: 'datos/orden_compra_semana.csv'
    };

    const [ingredientes, consumo, inventario, ordenes] = await Promise.all([
        parseCSV(urls.ingredientes),
        parseCSV(urls.consumo),
        parseCSV(urls.inventario),
        parseCSV(urls.ordenes)
    ]);

    datos.ingredientes = ingredientes;
    datos.consumo = consumo;
    datos.inventario = inventario;
    datos.ordenes = ordenes;
}

// Lógica Core: Procesamiento de datos y alertas
function procesarDatos() {
    resultados = [];
    
    // 1. Proyectar Consumo (Promedio simple de 6 semanas, podríamos ignorar max/min para "smart")
    const proyeccionPorSucursal = {}; // { sucursal_ingrediente: consumo_proyectado }
    
    // Agrupar consumos
    const agrupado = {};
    datos.consumo.forEach(row => {
        const key = `${row.sucursal}_${row.ingrediente_id}`;
        if (!agrupado[key]) agrupado[key] = [];
        agrupado[key].push(row.consumo_unidad_base);
    });

    for (const key in agrupado) {
        const valores = agrupado[key];
        // Proyección mediante Regresión Lineal y filtro IQR
        const { clean } = filterOutliersIQR(valores);
        proyeccionPorSucursal[key] = linearRegression(clean);
    }

    // 2. Indexar Inventario Actual y Órdenes
    const invMap = {};
    datos.inventario.forEach(row => {
        invMap[`${row.sucursal}_${row.ingrediente_id}`] = row.stock_actual_unidad_base;
    });

    const ordenesMap = {};
    datos.ordenes.forEach(row => {
        ordenesMap[`${row.sucursal}_${row.ingrediente_id}`] = row.cantidad_formatos;
    });

    // 3. Crear resultados unificados
    const sucursales = [...new Set(datos.inventario.map(d => d.sucursal))];
    
    sucursales.forEach(sucursal => {
        datos.ingredientes.forEach(ing => {
            const key = `${sucursal}_${ing.ingrediente_id}`;
            const invActual = invMap[key] || 0;
            const consumoProy = proyeccionPorSucursal[key] || 0;
            let ordenActual = ordenesMap[key] || 0;
            
            // Necesidad = Consumo Proyectado - Inventario
            let necesidadBase = consumoProy - invActual;
            if (necesidadBase < 0) necesidadBase = 0; // Sobrestock

            // Cuántos formatos enteros se necesitan? (Math.ceil porque no se vende medio formato)
            const necesidadFormatos = Math.ceil(necesidadBase / ing.unidad_base_por_formato);
            
            // Evaluar alertas
            let alerta = null;
            let costoExceso = 0;
            let formatosExceso = 0;

            if (ordenActual < necesidadFormatos) {
                const formatosFaltantes = necesidadFormatos - ordenActual;
                alerta = {
                    tipo: 'quiebre',
                    mensaje: `Pide ${formatosFaltantes} formatos menos de lo proyectado.`,
                    severidad: 'alta'
                };
            } else if (ordenActual > necesidadFormatos) {
                formatosExceso = ordenActual - necesidadFormatos;
                costoExceso = formatosExceso * (PRECIOS_SIMULADOS[ing.ingrediente_id] || 0);
                alerta = {
                    tipo: 'sobrepedido',
                    mensaje: `Pide ${formatosExceso} formatos de más.`,
                    costo: costoExceso,
                    severidad: costoExceso > 50 ? 'media' : 'baja'
                };
            }

            resultados.push({
                sucursal,
                ingrediente: ing,
                inventarioBase: invActual,
                consumoProyectadoBase: consumoProy,
                necesidadFormatos,
                ordenActual,
                alerta,
                costoExceso,
                formatosExceso,
                sobrestockBase: invActual > consumoProy ? invActual - consumoProy : 0
            });
        });
    });

    // Cross Anomalies
    resultados.crossAnomalias = [];
    const groupedByIngrediente = {};
    resultados.forEach(r => {
        if (!groupedByIngrediente[r.ingrediente.ingrediente_id]) groupedByIngrediente[r.ingrediente.ingrediente_id] = [];
        groupedByIngrediente[r.ingrediente.ingrediente_id].push(r);
    });

    for (const ingId in groupedByIngrediente) {
        const group = groupedByIngrediente[ingId];
        if (group.length < 3) continue;
        const consumos = group.map(g => g.ordenActual);
        const zScores = getZScores(consumos);
        zScores.forEach((z, i) => {
            if (Math.abs(z) > 1.8) {
                resultados.crossAnomalias.push({
                    sucursal: group[i].sucursal,
                    ingrediente_id: ingId,
                    nombre: group[i].ingrediente.nombre,
                    z: z.toFixed(2),
                    direction: z > 0 ? 'alto' : 'bajo',
                    ordenActual: group[i].ordenActual
                });
            }
        });
    }
}

// Renderizado de UI
function renderizarUI() {
    renderKPIs();
    renderFiltroSucursales();
    renderAlertas(document.getElementById('filter-sucursal')?.value || 'all');
    if (typeof renderCrossAnomalias === 'function') renderCrossAnomalias();
    renderTablaOrdenes();
    renderPorProveedor();
    renderRedistribucion();
}

function renderKPIs() {
    const totalQuiebres = resultados.filter(r => r.alerta?.tipo === 'quiebre').length;
    const costoTotalExceso = resultados.reduce((sum, r) => sum + r.costoExceso, 0);
    
    // Oportunidades de redistribución: Ingredientes con sobrestock en una sucursal y necesidad en otra
    let redistribucionCount = calcularOportunidadesRedistribucion().length;

    document.getElementById('kpi-quiebres').innerText = totalQuiebres;
    document.getElementById('kpi-sobrecosto').innerText = `$${costoTotalExceso.toFixed(2)}`;
    document.getElementById('kpi-redistribucion').innerText = redistribucionCount;
    document.getElementById('kpi-total-ordenes').innerText = resultados.length;
}

function renderFiltroSucursales() {
    const select = document.getElementById('filter-sucursal');
    const sucursales = [...new Set(resultados.map(r => r.sucursal))];
    
    // Evitar duplicados si re-renderiza
    if (select.options.length === 1) {
        sucursales.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.innerText = s;
            select.appendChild(opt);
        });
        
        select.addEventListener('change', (e) => {
            renderAlertas(e.target.value);
        });
    }
}

function renderAlertas(filtroSucursal) {
    const container = document.getElementById('alerts-container');
    container.innerHTML = '';

    const searchTerm = (document.getElementById('filter-search')?.value || '').toLowerCase();
    const severityFilter = document.getElementById('filter-severity')?.value || 'all';

    const alertas = resultados.filter(r => {
        if (!r.alerta) return false;
        if (filtroSucursal !== 'all' && r.sucursal !== filtroSucursal) return false;
        
        let sevMatch = true;
        if (severityFilter !== 'all') {
            if (severityFilter === 'alta' && r.alerta.severidad !== 'alta') sevMatch = false;
            if (severityFilter === 'media' && r.alerta.severidad !== 'media') sevMatch = false;
            if (severityFilter === 'baja' && r.alerta.severidad !== 'baja') sevMatch = false;
        }
        if (!sevMatch) return false;

        if (searchTerm) {
            const txt = `${r.sucursal} ${r.ingrediente.nombre} ${r.alerta.mensaje}`.toLowerCase();
            if (!txt.includes(searchTerm)) return false;
        }
        return true;
    });
    
    // Ordenar: Quiebres primero, luego sobrepedidos por costo
    alertas.sort((a, b) => {
        if (a.alerta.tipo === 'quiebre' && b.alerta.tipo !== 'quiebre') return -1;
        if (a.alerta.tipo !== 'quiebre' && b.alerta.tipo === 'quiebre') return 1;
        if (a.alerta.tipo === 'sobrepedido' && b.alerta.tipo === 'sobrepedido') {
            return b.costoExceso - a.costoExceso;
        }
        return 0;
    });

    if (alertas.length === 0) {
        container.innerHTML = '<div class="text-center py-8 text-slate-500"><i data-lucide="check-circle-2" class="w-12 h-12 mx-auto mb-3 opacity-50"></i><p>Todo en orden. No hay alertas.</p></div>';
        lucide.createIcons();
        return;
    }

    alertas.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = `p-4 rounded-xl border animate-fade-in ${
            r.alerta.tipo === 'quiebre' 
                ? 'bg-red-500/10 border-red-500/20' 
                : r.alerta.severidad === 'media' 
                    ? 'bg-orange-500/10 border-orange-500/20'
                    : 'bg-yellow-500/10 border-yellow-500/20'
        }`;
        div.style.animationDelay = `${i * 0.05}s`;

        const icon = r.alerta.tipo === 'quiebre' ? 'alert-octagon' : 'trending-down';
        const color = r.alerta.tipo === 'quiebre' ? 'text-red-400' : 'text-orange-400';
        
        let detalleExceso = '';
        if (r.alerta.tipo === 'sobrepedido') {
            detalleExceso = `<span class="bg-orange-500/20 text-orange-400 text-xs px-2 py-1 rounded font-medium mt-2 inline-block">Gasto extra: $${r.costoExceso.toFixed(2)}</span>`;
        }

        div.innerHTML = `
            <div class="flex gap-4 items-start">
                <div class="mt-1 ${color}">
                    <i data-lucide="${icon}"></i>
                </div>
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-sm font-bold">${r.sucursal}</span>
                        <i data-lucide="chevron-right" class="w-3 h-3 text-slate-500"></i>
                        <span class="text-sm text-slate-300">${r.ingrediente.nombre}</span>
                    </div>
                    <p class="text-slate-200 text-sm">
                        <span class="font-semibold text-white">ALERTA:</span> 
                        La sucursal necesita <b>${r.necesidadFormatos}</b> ${r.ingrediente.formato_compra}, 
                        pero está pidiendo <b>${r.ordenActual}</b>. ${r.alerta.mensaje}
                    </p>
                    ${detalleExceso}
                </div>
            </div>
        `;
        container.appendChild(div);
    });

    lucide.createIcons();
}

function renderTablaOrdenes() {
    const tbody = document.getElementById('table-ordenes-body');
    tbody.innerHTML = '';

    resultados.forEach((r, idx) => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-slate-800/50 transition-colors";
        
        let estadoBadge = '<span class="text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded text-xs font-medium">OK</span>';
        if (r.alerta) {
            if (r.alerta.tipo === 'quiebre') estadoBadge = '<span class="text-red-400 bg-red-400/10 px-2 py-1 rounded text-xs font-medium">Faltante</span>';
            else estadoBadge = '<span class="text-orange-400 bg-orange-400/10 px-2 py-1 rounded text-xs font-medium">Exceso</span>';
        }

        tr.innerHTML = `
            <td class="px-6 py-4 text-sm font-medium">${r.sucursal}</td>
            <td class="px-6 py-4 text-sm">${r.ingrediente.nombre}</td>
            <td class="px-6 py-4 text-sm text-slate-400">${r.ingrediente.formato_compra}</td>
            <td class="px-6 py-4 text-sm text-right font-semibold">${r.necesidadFormatos}</td>
            <td class="px-6 py-4 text-center">
                <div class="flex items-center justify-center gap-2">
                    <button onclick="cambiarOrden(${idx}, -1)" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center"><i data-lucide="minus" class="w-3 h-3"></i></button>
                    <input type="number" min="0" value="${r.ordenActual}" onchange="cambiarOrdenDirecto(${idx}, this.value)" class="w-12 bg-slate-900 border border-slate-700 text-center rounded text-sm py-1 focus:border-orange-500 focus:outline-none">
                    <button onclick="cambiarOrden(${idx}, 1)" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center"><i data-lucide="plus" class="w-3 h-3"></i></button>
                </div>
            </td>
            <td class="px-6 py-4 text-center">
                ${estadoBadge}
            </td>
        `;
        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

window.cambiarOrden = function(idx, diff) {
    const r = resultados[idx];
    let nuevaOrden = r.ordenActual + diff;
    if (nuevaOrden < 0) nuevaOrden = 0;
    actualizarOrden(idx, nuevaOrden);
};

window.cambiarOrdenDirecto = function(idx, value) {
    let nuevaOrden = parseInt(value) || 0;
    if (nuevaOrden < 0) nuevaOrden = 0;
    actualizarOrden(idx, nuevaOrden);
};

function actualizarOrden(idx, nuevaCantidad) {
    const r = resultados[idx];
    
    // Actualizar en el estado inicial para persistencia de lógica
    const rowOrden = datos.ordenes.find(o => o.sucursal === r.sucursal && o.ingrediente_id === r.ingrediente.ingrediente_id);
    if (rowOrden) {
        rowOrden.cantidad_formatos = nuevaCantidad;
    } else {
        datos.ordenes.push({ sucursal: r.sucursal, ingrediente_id: r.ingrediente.ingrediente_id, cantidad_formatos: nuevaCantidad });
    }

    // Reprocesar y renderizar
    procesarDatos();
    renderizarUI();
}

function renderPorProveedor() {
    const container = document.getElementById('proveedores-container');
    container.innerHTML = '';

    const porProveedor = {};
    
    resultados.forEach(r => {
        if (r.ordenActual > 0) {
            const prov = r.ingrediente.proveedor;
            if (!porProveedor[prov]) porProveedor[prov] = { totalCosto: 0, items: [] };
            
            const costoItem = r.ordenActual * (PRECIOS_SIMULADOS[r.ingrediente.ingrediente_id] || 0);
            porProveedor[prov].totalCosto += costoItem;
            porProveedor[prov].items.push({
                sucursal: r.sucursal,
                nombre: r.ingrediente.nombre,
                cantidad: r.ordenActual,
                formato: r.ingrediente.formato_compra,
                costo: costoItem
            });
        }
    });

    Object.keys(porProveedor).forEach(prov => {
        const data = porProveedor[prov];
        const minimo = MINIMO_PROVEEDOR[prov] || 0;
        
        let envioAlert = '';
        if (minimo > 0 && data.totalCosto < minimo) {
            const faltante = minimo - data.totalCosto;
            envioAlert = `
                <div class="mt-3 p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg flex gap-2 items-center text-blue-400 text-xs font-medium">
                    <i data-lucide="info" class="w-4 h-4"></i> Faltan $${faltante.toFixed(2)} para envío gratis (Mínimo: $${minimo}).
                </div>
            `;
        } else if (minimo > 0) {
            envioAlert = `
                <div class="mt-3 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex gap-2 items-center text-emerald-400 text-xs font-medium">
                    <i data-lucide="check" class="w-4 h-4"></i> Califica para envío gratis.
                </div>
            `;
        }

        const div = document.createElement('div');
        div.className = "bg-slate-800 border border-slate-700 rounded-2xl p-5 shadow-lg";
        div.innerHTML = `
            <div class="flex justify-between items-start mb-4 border-b border-slate-700 pb-3">
                <h4 class="font-bold text-orange-400 flex items-center gap-2">
                    <i data-lucide="truck" class="w-5 h-5"></i> ${prov}
                </h4>
                <div class="text-right">
                    <p class="text-xs text-slate-400">Total Orden</p>
                    <p class="text-lg font-bold">$${data.totalCosto.toFixed(2)}</p>
                </div>
            </div>
            <div class="max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                <table class="w-full text-xs">
                    <tbody class="divide-y divide-slate-700">
                        ${data.items.map(i => `
                            <tr>
                                <td class="py-2 text-slate-300 font-medium">${i.cantidad}x ${i.formato}</td>
                                <td class="py-2">${i.nombre} <span class="text-slate-500 ml-1">(${i.sucursal.split(' ')[0]})</span></td>
                                <td class="py-2 text-right">$${i.costo.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ${envioAlert}
        `;
        container.appendChild(div);
    });
}

function calcularOportunidadesRedistribucion() {
    const op = [];
    const ingredienteIds = [...new Set(resultados.map(r => r.ingrediente.ingrediente_id))];

    ingredienteIds.forEach(ingId => {
        const registros = resultados.filter(r => r.ingrediente.ingrediente_id === ingId);
        const excedentes = registros.filter(r => r.sobrestockBase > r.ingrediente.unidad_base_por_formato);
        const necesitados = registros.filter(r => r.necesidadFormatos > 0);

        if (excedentes.length > 0 && necesitados.length > 0) {
            excedentes.forEach(exc => {
                necesitados.forEach(nec => {
                    if (exc.sucursal !== nec.sucursal) {
                        op.push({
                            ingrediente: exc.ingrediente,
                            origen: exc.sucursal,
                            destino: nec.sucursal,
                            cantidadBase: Math.min(exc.sobrestockBase, nec.consumoProyectadoBase),
                            esPerecedero: exc.ingrediente.es_perecedero === 'Si'
                        });
                    }
                });
            });
        }
    });
    return op;
}

function renderRedistribucion() {
    const container = document.getElementById('redistribucion-container');
    container.innerHTML = '';
    const oportunidades = calcularOportunidadesRedistribucion();

    if (oportunidades.length === 0) {
        container.innerHTML = '<p class="text-slate-400 text-sm">No hay oportunidades claras de redistribución en este momento.</p>';
        return;
    }

    oportunidades.forEach(op => {
        const div = document.createElement('div');
        div.className = `p-4 rounded-xl border flex items-center justify-between ${
            op.esPerecedero ? 'bg-orange-500/10 border-orange-500/20' : 'bg-slate-700 border-slate-600'
        }`;
        
        let badge = op.esPerecedero ? '<span class="bg-orange-500 text-white text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold ml-2">Perecedero</span>' : '';

        div.innerHTML = `
            <div class="flex items-center gap-4">
                <div class="flex flex-col items-center justify-center w-12 h-12 bg-slate-800 rounded-lg border border-slate-600 shadow-inner">
                    <span class="text-xs text-slate-400">${op.ingrediente.unidad_base}</span>
                    <span class="font-bold">${op.cantidadBase.toFixed(1)}</span>
                </div>
                <div>
                    <h4 class="font-bold flex items-center">${op.ingrediente.nombre} ${badge}</h4>
                    <div class="flex items-center gap-2 mt-1 text-sm text-slate-300">
                        <span class="text-red-400 bg-red-400/10 px-2 py-0.5 rounded">${op.origen}</span>
                        <i data-lucide="arrow-right" class="w-4 h-4 text-slate-500"></i>
                        <span class="text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">${op.destino}</span>
                    </div>
                </div>
            </div>
            <button class="bg-slate-600 hover:bg-slate-500 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                Generar Traslado
            </button>
        `;
        container.appendChild(div);
    });
}

// Lógica de Chat IA
window.saveApiKey = function() {
    api_key = document.getElementById('api-key-input').value;
    ai_provider = document.getElementById('api-provider').value;
    document.getElementById('api-key-modal').classList.add('hidden');
    addChatMessage('bot', `API Key guardada exitosamente. El proveedor seleccionado es ${ai_provider}. Ahora puedes hacer preguntas complejas.`);
};

window.sendFAQ = function(text) {
    document.getElementById('chat-input').value = text;
    sendChatMessage();
};

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;

    addChatMessage('user', msg);
    input.value = '';

    // Mostrar "escribiendo"
    const typingId = 'typing-' + Date.now();
    addChatMessage('bot', '<span class="animate-pulse">Pensando...</span>', typingId);

    setTimeout(() => {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        // Lógica de respuestas (Mock o simulación de LLM local basado en FAQs)
        let respuesta = '';
        const m = msg.toLowerCase();

        if (api_key) {
            respuesta = "<i>[Modo API Activo]</i> Consultando a " + ai_provider + "... En un entorno real, aquí se conectaría con fetch a la API. Como esto es una demostración local, simulo la respuesta: " + generarRespuestaBasica(m);
        } else {
            respuesta = generarRespuestaBasica(m);
        }

        addChatMessage('bot', respuesta);
    }, 800);
};

function generarRespuestaBasica(pregunta) {
    if (pregunta.includes('de más') || pregunta.includes('demasiado') || pregunta.includes('exceso')) {
        const sobrepedidos = resultados.filter(r => r.alerta?.tipo === 'sobrepedido').sort((a,b) => b.costoExceso - a.costoExceso);
        if (sobrepedidos.length > 0) {
            const top = sobrepedidos[0];
            return `**${top.sucursal}** está pidiendo demasiado **${top.ingrediente.nombre}**. Pidieron ${top.ordenActual} formatos pero la necesidad real es de ${top.necesidadFormatos}. Esto genera un gasto extra inmovilizado de $${top.costoExceso.toFixed(2)}.`;
        }
        return "Ninguna sucursal está pidiendo de más esta semana. ¡Excelente gestión!";
    }
    else if (pregunta.includes('perecedero') || pregunta.includes('riesgo')) {
        const op = calcularOportunidadesRedistribucion().filter(o => o.esPerecedero);
        if (op.length > 0) {
            const first = op[0];
            return `Sí, hay un riesgo en perecederos. Por ejemplo, **${first.origen}** tiene un exceso de **${first.ingrediente.nombre}**, que es perecedero. Podrías trasladarlo a **${first.destino}** que lo necesita, en lugar de comprar más.`;
        }
        return "Actualmente no veo alertas críticas de productos perecederos con riesgo de vencer por sobrestock.";
    }
    else if (pregunta.includes('gasto') || pregunta.includes('dinero') || pregunta.includes('innecesari')) {
        const costoTotal = resultados.reduce((sum, r) => sum + r.costoExceso, 0);
        return `El gasto total en excesos (pedidos mayores a la necesidad proyectada) es de **$${costoTotal.toFixed(2)}**. Te sugiero revisar las alertas naranjas en el Tablero para corregirlo.`;
    }
    else {
        return "Entiendo tu pregunta. Sin embargo, no tengo una respuesta predefinida para eso. Intenta usar palabras clave como 'demasiado', 'perecedero', o 'gasto', o configura tu API Key para consultas abiertas.";
    }
}

function addChatMessage(sender, text, id = null) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    if (id) div.id = id;
    div.className = "flex gap-3 animate-fade-in";
    
    if (sender === 'user') {
        div.classList.add('flex-row-reverse');
        div.innerHTML = `
            <div class="w-8 h-8 rounded-full bg-slate-600 flex-shrink-0 flex items-center justify-center">
                <i data-lucide="user" class="w-4 h-4 text-white"></i>
            </div>
            <div class="bg-orange-500 text-white px-4 py-3 rounded-2xl rounded-tr-none max-w-[80%]">
                <p class="text-sm">${text}</p>
            </div>
        `;
    } else {
        // Parse simple markdown-like bold (**text**)
        const parsedText = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        div.innerHTML = `
            <div class="w-8 h-8 rounded-full bg-orange-500/20 flex-shrink-0 flex items-center justify-center text-orange-500">
                <i data-lucide="bot" class="w-4 h-4"></i>
            </div>
            <div class="bg-slate-700 px-4 py-3 rounded-2xl rounded-tl-none max-w-[80%]">
                <p class="text-sm text-slate-100 leading-relaxed">${parsedText}</p>
            </div>
        `;
    }
    
    container.appendChild(div);
    lucide.createIcons();
    container.scrollTop = container.scrollHeight;
}

// --- NUEVAS FUNCIONES ESTADÍSTICAS ---
function filterOutliersIQR(values) {
  if (values.length < 4) return { clean: values, outliers: [] };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const clean = [];
  const outliers = [];
  values.forEach((v, i) => {
    if (v >= lo && v <= hi) clean.push({ v, i });
    else outliers.push({ v, i });
  });
  return { clean: clean.map(x => x.v), outlierIndices: outliers.map(x => x.i), outliers: outliers.map(x => x.v) };
}

function linearRegression(values) {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  const n = values.length;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return slope * n + intercept;
}

function getZScores(values) {
  const n = values.length;
  if (n < 2) return values.map(() => 0);
  const mean = values.reduce((a, b) => a + b) / n;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return values.map(() => 0);
  return values.map(v => (v - mean) / std);
}

// --- NUEVA LÓGICA DE DRAG & DROP ---
window.handleFileUpload = function(input, type) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    
    Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: function(results) {
            datos[type] = results.data;
            document.getElementById(`status-` + type).innerText = 'Actualizado localmente';
            document.getElementById(`status-` + type).className = 'text-emerald-400 font-bold mt-3 px-2 py-1 bg-slate-800 rounded';
            
            // Recalcular
            procesarDatos();
            renderizarUI();
        }
    });
};

// --- RENDER ANOMALÍAS CRUZADAS ---
window.renderCrossAnomalias = function() {
    const container = document.getElementById('cross-anomalias-container');
    if (!container) return;
    container.innerHTML = '';
    
    if (!resultados.crossAnomalias || resultados.crossAnomalias.length === 0) {
        container.innerHTML = '<p class="text-slate-500 text-sm">No se detectaron anomalías matemáticas entre sucursales.</p>';
        return;
    }
    
    resultados.crossAnomalias.forEach(a => {
        const div = document.createElement('div');
        div.className = "flex items-center gap-3 p-3 bg-slate-900 border border-slate-700 rounded-lg";
        const isAlto = a.direction === 'alto';
        const icon = isAlto ? '<i data-lucide="trending-up" class="w-4 h-4 text-orange-400"></i>' : '<i data-lucide="trending-down" class="w-4 h-4 text-blue-400"></i>';
        
        div.innerHTML = `
            <div class="flex-shrink-0">
                ${icon}
            </div>
            <div>
                <p class="text-sm">
                    <span class="font-bold text-slate-200">${a.sucursal}</span> pidió 
                    <span class="font-bold ${isAlto ? 'text-orange-400' : 'text-blue-400'}">${a.ordenActual} formatos</span> de 
                    <span class="font-bold text-slate-200">${a.nombre}</span>.
                </p>
                <p class="text-xs text-slate-400">Valor atípico detectado estadísticamente (Z = ${a.z}σ).</p>
            </div>
        `;
        container.appendChild(div);
    });
    lucide.createIcons();
}

// --- EXPORTACIÓN ---
window.exportAlertas = function() {
    const alertas = resultados.filter(r => r.alerta);
    let csv = "Sucursal,Ingrediente,TipoAlerta,Severidad,Mensaje,CostoExceso\n";
    alertas.forEach(r => {
        csv += `"${r.sucursal}","${r.ingrediente.nombre}","${r.alerta.tipo}","${r.alerta.severidad}","${r.alerta.mensaje}",${r.costoExceso}\n`;
    });
    if(window.downloadCSV) window.downloadCSV(csv, 'alertas_prioritarias.csv');
};

window.exportDatosCompletos = function() {
    let csv = "Sucursal,Ingrediente,Proveedor,NecesidadFormatos,OrdenActual,Status\n";
    resultados.forEach(r => {
        const stat = r.alerta ? (r.alerta.tipo==='quiebre'?'Faltante':'Exceso') : 'OK';
        csv += `"${r.sucursal}","${r.ingrediente.nombre}","${r.ingrediente.proveedor}",${r.necesidadFormatos},${r.ordenActual},"${stat}"\n`;
    });
    if(window.downloadCSV) window.downloadCSV(csv, 'analisis_ordenes_completo.csv');
};

// Inicializar la app al cargar
document.addEventListener('DOMContentLoaded', init);
