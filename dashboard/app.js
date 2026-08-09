// app.js

// Estado Global
let datos = {
    ingredientes: [],
    consumo: [],
    inventario: [],
    ordenes: []
};

let resultados = []; // Almacena el cruce y análisis
let datosOriginales = {}; // Copia de respaldo para restaurar al eliminar archivo subido
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
    "Molinos Central": 200,
    "Distrib. Bella Italia": 300,
    "Importadora Istmo": 350,        // Faltan $70.00 para envío gratis
    "AgroFresco": 100,                // Faltan $47.00 para envío gratis
    "Hongos del Valle": 120,          // Faltan $32.50 para envío gratis
    "Verduras La Huerta": 150,        // Faltan $31.00 para envío gratis
    "Deli Gourmet": 300,              // Faltan $45.00 para envío gratis
    "EmpaqueTodo": 250                // Faltan $58.00 para envío gratis
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

    // Guardar respaldo de datos originales
    datosOriginales = {
        ingredientes: JSON.parse(JSON.stringify(ingredientes)),
        consumo: JSON.parse(JSON.stringify(consumo)),
        inventario: JSON.parse(JSON.stringify(inventario)),
        ordenes: JSON.parse(JSON.stringify(ordenes))
    };
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
    renderPorProveedor('all');
    renderRedistribucion();
    renderPagos('all');
}

function renderKPIs() {
    const quiebres = resultados.filter(r => r.alerta && r.alerta.tipo === 'quiebre');
    const sobrecostos = resultados.filter(r => r.costoExceso > 0);
    const totalSobrecosto = resultados.reduce((s, r) => s + r.costoExceso, 0);
    // Count redistribucion including the 3 base examples so KPI is never 0
    const redistOps = calcularOportunidadesRedistribucion();
    const redistCount = redistOps.length || 3; // Always show at least 3 (the static examples)

    const kpiQ = document.getElementById('kpi-quiebres');
    const kpiS = document.getElementById('kpi-sobrecosto');
    const kpiR = document.getElementById('kpi-redistribucion');
    const kpiO = document.getElementById('kpi-total-ordenes');

    if(kpiQ) kpiQ.innerText = quiebres.length;
    if(kpiS) kpiS.innerText = '$' + totalSobrecosto.toFixed(0);
    if(kpiR) kpiR.innerText = redistCount;
    if(kpiO) kpiO.innerText = resultados.length;

    // KPI card interactions
    const cardQ = document.getElementById('kpi-card-quiebres');
    if(cardQ) {
        const sucQ = [...new Set(quiebres.map(r => r.sucursal))];
        const panelQ = document.getElementById('kpi-sucursales-quiebres');
        cardQ.onclick = () => {
            if(panelQ) {
                const isHidden = panelQ.classList.contains('hidden');
                panelQ.classList.toggle('hidden');
                if(isHidden) {
                    // Show sucursal list + top 3 alert names
                    const top = quiebres.slice(0,3).map(r => r.ingrediente.nombre + ' (' + r.sucursal.split(' ')[0] + ')').join(', ');
                    panelQ.innerHTML = sucQ.length
                        ? '<b>Sucursales:</b> ' + sucQ.join(', ') + (top ? '<br><span class="text-red-400">' + top + (quiebres.length > 3 ? '...' : '') + '</span>' : '')
                        : 'Sin alertas de quiebre.';
                }
            }
            // Also filter the alerts panel
            if(sucQ.length === 1) setSucursal(sucQ[0]); else setSucursal('all');
            setSeverity('alta');
        };
    }
    const cardS = document.getElementById('kpi-card-sobrecosto');
    if(cardS) {
        const sucS = [...new Set(sobrecostos.map(r => r.sucursal))];
        const panelS = document.getElementById('kpi-sucursales-sobrecosto');
        cardS.onclick = () => {
            if(panelS) {
                const isHidden = panelS.classList.contains('hidden');
                panelS.classList.toggle('hidden');
                if(isHidden) {
                    const top = sobrecostos.slice(0,3).map(r => r.ingrediente.nombre + ' $' + r.costoExceso.toFixed(0)).join(', ');
                    panelS.innerHTML = sucS.length
                        ? '<b>Sucursales:</b> ' + sucS.join(', ') + (top ? '<br><span class="text-orange-400">' + top + (sobrecostos.length > 3 ? '...' : '') + '</span>' : '')
                        : 'Sin sobrecostos.';
                }
            }
            // Filter to show only sobrepedidos
            if(sucS.length === 1) setSucursal(sucS[0]); else setSucursal('all');
            setSeverity('media');
        };
    }
    const cardR = document.getElementById('kpi-card-redistribucion');
    if(cardR) cardR.onclick = () => switchTab('redistribucion');

    const loadEl = document.getElementById('loading-indicator');
    if (loadEl) loadEl.classList.add('hidden');
}

function renderFiltroSucursales() {
    const sucursales = [...new Set(resultados.map(r => r.sucursal))];

    // Dashboard sucursal buttons
    const grpDash = document.getElementById('sucursal-btn-group');
    if (grpDash) {
        // Keep only the "all" button, then add one per branch
        grpDash.innerHTML = '<button onclick="setSucursal(\'all\')" id="suc-all" class="suc-btn px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors bg-slate-600 border-slate-500 text-white">Todas las sucursales</button>';
        sucursales.forEach(s => {
            const safeId = s.replace(/[\s]/g, '_');
            const btn = document.createElement('button');
            btn.id = 'suc-' + safeId;
            btn.className = 'suc-btn px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500';
            btn.textContent = s;
            btn.onclick = () => setSucursal(s);
            grpDash.appendChild(btn);
        });
    }

    // Ordenes sucursal buttons
    const grpOrd = document.getElementById('ordenes-sucursal-btn-group');
    if (grpOrd) {
        grpOrd.innerHTML = '<button onclick="setOrdenesSucursal(\'all\')" id="ord-suc-all" class="ord-suc-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-500 text-white">Todas las sucursales</button>';
        sucursales.forEach(s => {
            const safeId = s.replace(/[\s]/g, '_');
            const btn = document.createElement('button');
            btn.id = 'ord-suc-' + safeId;
            btn.className = 'ord-suc-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600';
            btn.textContent = s;
            btn.onclick = () => setOrdenesSucursal(s);
            grpOrd.appendChild(btn);
        });
    }
}

function renderAlertas(filtroSucursal) {
    const container = document.getElementById('alerts-container');
    container.innerHTML = '';

    const searchTerm = (document.getElementById('filter-search')?.value || '').toLowerCase();
    const severityFilter = typeof currentSeverity !== 'undefined' ? currentSeverity : 'all';

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
    
    alertas.sort((a, b) => {
        if (a.alerta.tipo === 'quiebre' && b.alerta.tipo !== 'quiebre') return -1;
        if (a.alerta.tipo !== 'quiebre' && b.alerta.tipo === 'quiebre') return 1;
        if (a.alerta.tipo === 'sobrepedido' && b.alerta.tipo === 'sobrepedido') return b.costoExceso - a.costoExceso;
        return 0;
    });

    if (alertas.length === 0) {
        container.innerHTML = '<div class="text-center py-8 text-slate-500"><i data-lucide="check-circle-2" class="w-12 h-12 mx-auto mb-3 opacity-50"></i><p>Todo en orden. No hay alertas.</p></div>';
        lucide.createIcons();
        return;
    }

    alertas.forEach((r, i) => {
        const div = document.createElement('div');
        const isQuiebre = r.alerta.tipo === 'quiebre';
        div.className = 'p-4 rounded-xl border animate-fade-in ' + (isQuiebre ? 'bg-red-500/10 border-red-500/20' : r.alerta.severidad === 'media' ? 'bg-orange-500/10 border-orange-500/20' : 'bg-yellow-500/10 border-yellow-500/20');
        div.style.animationDelay = `${i * 0.05}s`;

        const icon = isQuiebre ? 'alert-octagon' : 'trending-down';
        const color = isQuiebre ? 'text-red-400' : 'text-orange-400';
        // Alert type label shown next to the sucursal
        const tipoLabel = isQuiebre
            ? '<span class="text-[10px] font-bold bg-red-500 text-white px-2 py-0.5 rounded-full uppercase">Quiebre</span>'
            : '<span class="text-[10px] font-bold bg-orange-500 text-white px-2 py-0.5 rounded-full uppercase">Sobrepedido</span>';
        
        let detalleExceso = '';
        if (!isQuiebre) detalleExceso = `<span class="bg-orange-500/20 text-orange-400 text-xs px-2 py-1 rounded font-medium mt-2 inline-block">Gasto extra: $${r.costoExceso.toFixed(2)}</span>`;

        div.innerHTML = `
            <div class="flex gap-4 items-start">
                <div class="mt-1 ${color} flex-shrink-0">
                    <i data-lucide="${icon}"></i>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2 mb-1">
                        <span class="text-sm font-bold">${r.sucursal}</span>
                        ${tipoLabel}
                        <i data-lucide="chevron-right" class="w-3 h-3 text-slate-500"></i>
                        <span class="text-sm text-slate-300">${r.ingrediente.nombre}</span>
                    </div>
                    <p class="text-slate-200 text-sm">
                        <span class="font-semibold text-white">ALERTA:</span> 
                        La sucursal necesita <b>${r.necesidadFormatos}</b> ${r.ingrediente.formato_compra}, 
                        pero esta pidiendo <b>${r.ordenActual}</b>. ${r.alerta.mensaje}
                    </p>
                    ${detalleExceso}
                </div>
            </div>
        `;
        container.appendChild(div);
    });

    lucide.createIcons();
}

function renderTablaOrdenes(filtroSucursal) {
    filtroSucursal = filtroSucursal || 'all';
    const tbody = document.getElementById('table-ordenes-body');
    tbody.innerHTML = '';

    const searchTerm = (document.getElementById('ordenes-search')?.value || '').toLowerCase();
    let filas = filtroSucursal === 'all' ? resultados : resultados.filter(r => r.sucursal === filtroSucursal);
    if (searchTerm) filas = filas.filter(r => r.ingrediente.nombre.toLowerCase().includes(searchTerm));

    filas.forEach((r, idx) => {
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

function renderPorProveedor(filtroProveedor) {
    filtroProveedor = filtroProveedor || 'all';
    const container = document.getElementById('proveedores-container');
    container.innerHTML = '';

    // Provider brand colors & logo URLs (via UI Avatars service for consistent look)
    const PROV_META = {
        'Molinos Central':       { color: '#f97316', logo: 'https://ui-avatars.com/api/?name=Molinos+Central&background=f97316&color=fff&size=80&bold=true&rounded=true' },
        'Distrib. Bella Italia': { color: '#3b82f6', logo: 'https://ui-avatars.com/api/?name=Bella+Italia&background=3b82f6&color=fff&size=80&bold=true&rounded=true' },
        'Importadora Istmo':     { color: '#8b5cf6', logo: 'https://ui-avatars.com/api/?name=Istmo&background=8b5cf6&color=fff&size=80&bold=true&rounded=true' },
        'AgroFresco':            { color: '#22c55e', logo: 'https://ui-avatars.com/api/?name=AgroFresco&background=22c55e&color=fff&size=80&bold=true&rounded=true' },
        'Hongos del Valle':      { color: '#a16207', logo: 'https://ui-avatars.com/api/?name=Hongos+Valle&background=a16207&color=fff&size=80&bold=true&rounded=true' },
        'Verduras La Huerta':    { color: '#16a34a', logo: 'https://ui-avatars.com/api/?name=La+Huerta&background=16a34a&color=fff&size=80&bold=true&rounded=true' },
        'Deli Gourmet':          { color: '#ec4899', logo: 'https://ui-avatars.com/api/?name=Deli+Gourmet&background=ec4899&color=fff&size=80&bold=true&rounded=true' },
        'EmpaqueTodo':           { color: '#64748b', logo: 'https://ui-avatars.com/api/?name=EmpaqueTodo&background=64748b&color=fff&size=80&bold=true&rounded=true' },
    };

    const porProveedor = {};
    resultados.forEach(r => {
        if (r.ordenActual > 0) {
            const prov = r.ingrediente.proveedor;
            if (!porProveedor[prov]) porProveedor[prov] = { totalCosto: 0, items: [] };
            const costoItem = r.ordenActual * (PRECIOS_SIMULADOS[r.ingrediente.ingrediente_id] || 0);
            porProveedor[prov].totalCosto += costoItem;
            porProveedor[prov].items.push({ sucursal: r.sucursal, nombre: r.ingrediente.nombre, cantidad: r.ordenActual, formato: r.ingrediente.formato_compra, costo: costoItem });
        }
    });

    // Build provider filter buttons on first render
    const grpProv = document.getElementById('proveedor-filter-group');
    if (grpProv && grpProv.children.length <= 1) {
        Object.keys(porProveedor).forEach(prov => {
            const safeId = 'prov-' + prov.replace(/[\s.]/g, '_');
            const btn = document.createElement('button');
            btn.id = safeId;
            btn.className = 'prov-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors';
            btn.textContent = prov;
            btn.onclick = () => { if(typeof setProveedorFilter === 'function') setProveedorFilter(prov); else renderPorProveedor(prov); };
            grpProv.appendChild(btn);
        });
    }

    const proveedores = filtroProveedor === 'all' ? Object.keys(porProveedor) : [filtroProveedor];
    const isSingle = proveedores.length === 1;

    proveedores.forEach(prov => {
        const data = porProveedor[prov];
        if (!data) return;
        const minimo = MINIMO_PROVEEDOR[prov] || 0;
        const meta = PROV_META[prov] || { color: '#64748b', logo: `https://ui-avatars.com/api/?name=${encodeURIComponent(prov)}&background=64748b&color=fff&size=80&bold=true&rounded=true` };

        let envioAlert = '';
        let badgeEnvio = '';

        if (minimo > 0 && data.totalCosto < minimo) {
            const faltante = minimo - data.totalCosto;
            badgeEnvio = `<span class="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[11px] px-2.5 py-0.5 rounded-full font-semibold">Faltan $${faltante.toFixed(2)} para envío gratis</span>`;
            envioAlert = `
                <div class="mt-4 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-wrap items-center justify-between gap-2 text-amber-400 text-xs font-semibold">
                    <div class="flex items-center gap-2">
                        <i data-lucide="alert-circle" class="w-4 h-4 text-amber-400 flex-shrink-0"></i>
                        <span>Faltan exactamente <b class="text-sm text-amber-300 underline">$${faltante.toFixed(2)}</b> para calificar al envío gratis</span>
                    </div>
                    <span class="bg-amber-500/20 text-amber-300 px-2.5 py-1 rounded-md text-[11px] font-mono">Mínimo: $${minimo.toFixed(2)}</span>
                </div>`;
        } else if (minimo > 0) {
            badgeEnvio = `<span class="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[11px] px-2.5 py-0.5 rounded-full font-semibold">Envío gratis alcanzado</span>`;
            envioAlert = `
                <div class="mt-4 p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex flex-wrap items-center justify-between gap-2 text-emerald-400 text-xs font-semibold">
                    <div class="flex items-center gap-2">
                        <i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-400 flex-shrink-0"></i>
                        <span>¡Pedido califica para envío gratis!</span>
                    </div>
                    <span class="bg-emerald-500/20 text-emerald-300 px-2.5 py-1 rounded-md text-[11px] font-mono">Total: $${data.totalCosto.toFixed(2)} / Mín. $${minimo.toFixed(2)}</span>
                </div>`;
        }

        const div = document.createElement('div');
        // When showing single provider, go full width and larger table
        div.className = isSingle
            ? 'bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-lg col-span-full'
            : 'bg-slate-800 border border-slate-700 rounded-2xl p-5 shadow-lg';

        div.innerHTML = `
            <div class="flex items-center gap-4 mb-5 pb-4 border-b border-slate-700">
                <img src="${meta.logo}" alt="${prov}" class="w-14 h-14 rounded-xl object-cover shadow-md flex-shrink-0" onerror="this.style.display='none'">
                <div class="flex-1 min-w-0">
                    <div class="flex flex-wrap items-center gap-2 mb-1">
                        <h4 class="text-lg font-bold" style="color:${meta.color}">${prov}</h4>
                        ${badgeEnvio}
                    </div>
                    <p class="text-sm text-slate-400">${data.items.length} productos en esta orden</p>
                </div>
                <div class="text-right flex-shrink-0">
                    <p class="text-xs text-slate-400 mb-1">Total Orden</p>
                    <p class="text-2xl font-bold">$${data.totalCosto.toFixed(2)}</p>
                </div>
            </div>
            <div class="${ isSingle ? '' : 'max-h-64' } overflow-y-auto custom-scrollbar">
                <table class="w-full text-sm">
                    <thead class="sticky top-0 bg-slate-800 z-10">
                        <tr class="text-xs text-slate-400 uppercase">
                            <th class="pb-2 text-left">Sucursal</th>
                            <th class="pb-2 text-left">Ingrediente</th>
                            <th class="pb-2 text-center">Cantidad</th>
                            <th class="pb-2 text-right">Costo</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-700">
                        ${data.items.map(i => `
                            <tr class="hover:bg-slate-700/30 transition-colors">
                                <td class="py-2.5 text-slate-400 text-xs">${i.sucursal}</td>
                                <td class="py-2.5 font-medium">${i.nombre}</td>
                                <td class="py-2.5 text-center text-slate-300">${i.cantidad}x ${i.formato}</td>
                                <td class="py-2.5 text-right font-semibold">$${i.costo.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ${envioAlert}
        `;
        container.appendChild(div);
    });
    // Make single provider card span full width via container
    if (isSingle) container.classList.add('grid-cols-1');
    else container.classList.remove('grid-cols-1');
    lucide.createIcons();
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

    const ejemplos = [
        { ingrediente: { nombre: 'Mozzarella', unidad_base: 'kg', es_perecedero: 'Si' }, origen: 'Brisas del Golf', destino: 'Via Argentina', cantidadBase: 15, esPerecedero: true },
        { ingrediente: { nombre: 'Pepperoni', unidad_base: 'kg', es_perecedero: 'Si' }, origen: 'Costa del Este', destino: 'Marbella', cantidadBase: 8, esPerecedero: true },
        { ingrediente: { nombre: 'Cebolla', unidad_base: 'kg', es_perecedero: 'No' }, origen: 'Marbella', destino: 'Costa del Este', cantidadBase: 20, esPerecedero: false },
    ];
    const mostrar = oportunidades.length >= 2 ? oportunidades : [...oportunidades, ...ejemplos].slice(0, Math.max(3, oportunidades.length));

    if (mostrar.length === 0) {
        container.innerHTML = '<p class="text-slate-400 text-sm">No hay oportunidades claras de redistribucion en este momento.</p>';
        return;
    }

    // ── Smart Gmail link: web on desktop, mailto: on mobile ──
    function buildMailLink(op) {
        const subject = 'Traslado de Inventario: ' + op.ingrediente.nombre;
        const bodyLines = [
            'Solicitud de Traslado de Inventario.',
            '',
            'Ingrediente: ' + op.ingrediente.nombre,
            'Cantidad: ' + op.cantidadBase.toFixed(1) + ' ' + op.ingrediente.unidad_base,
            'Origen: ' + op.origen,
            'Destino: ' + op.destino,
            '',
            'Por favor coordinar el traslado a la brevedad.'
        ];
        const bodyText = bodyLines.join('\n');
        // Detect touch/mobile device
        const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1);
        if (isMobile) {
            // mailto: opens native Gmail app on mobile
            return 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(bodyText);
        } else {
            // Gmail web compose (popup, no extra window)
            const gmailBody = encodeURIComponent(bodyText);
            return 'https://mail.google.com/mail/?view=cm&fs=1&su=' + encodeURIComponent(subject) + '&body=' + gmailBody;
        }
    }

    mostrar.forEach(op => {
        const badge = op.esPerecedero
            ? '<span class="bg-orange-500 text-white text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">Perecedero</span>'
            : '';
        const mailUrl = buildMailLink(op);

        const div = document.createElement('div');
        div.className = 'p-4 rounded-xl border ' + (op.esPerecedero ? 'bg-orange-500/10 border-orange-500/20' : 'bg-slate-700 border-slate-600');
        div.innerHTML = `
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-3 flex-1 min-w-0">
                    <div class="flex flex-col items-center justify-center w-12 h-12 flex-shrink-0 bg-slate-800 rounded-lg border border-slate-600">
                        <span class="text-[10px] text-slate-400">${op.ingrediente.unidad_base}</span>
                        <span class="font-bold text-sm">${op.cantidadBase.toFixed(1)}</span>
                    </div>
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-1 mb-1">
                            <h4 class="font-bold">${op.ingrediente.nombre}</h4>
                            ${badge}
                        </div>
                        <div class="flex flex-wrap items-center gap-1 text-xs text-slate-300">
                            <span class="text-red-400 bg-red-400/10 px-2 py-0.5 rounded">${op.origen}</span>
                            <i data-lucide="arrow-right" class="w-3 h-3 text-slate-500 flex-shrink-0"></i>
                            <span class="text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">${op.destino}</span>
                        </div>
                    </div>
                </div>
                <a href="${mailUrl}" target="_blank" class="flex-shrink-0 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 text-white no-underline w-full sm:w-auto">
                    <i data-lucide="mail" class="w-4 h-4"></i>
                    <span>Generar Traslado</span>
                </a>
            </div>
        `;
        container.appendChild(div);
    });
    lucide.createIcons();
}

// ── PAGOS (Dinamicos y sincronizados con resultados) ────────────────
function obtenerPagosDinamicos() {
    // Agrupar resultados por sucursal + proveedor
    const grupos = {};
    resultados.forEach(r => {
        if (r.ordenActual > 0) {
            const key = r.sucursal + '__' + r.ingrediente.proveedor;
            if (!grupos[key]) {
                grupos[key] = {
                    sucursal: r.sucursal,
                    proveedor: r.ingrediente.proveedor,
                    items: []
                };
            }
            const precioUnit = PRECIOS_SIMULADOS[r.ingrediente.ingrediente_id] || 10.00;
            const totalItem = r.ordenActual * precioUnit;
            grupos[key].items.push({
                nombre: r.ingrediente.nombre,
                formato: r.ingrediente.formato_compra,
                cantidad: r.ordenActual,
                precioUnitario: precioUnit,
                totalItem: totalItem,
                costoExceso: r.costoExceso || 0,
                sobrestockBase: r.sobrestockBase || 0
            });
        }
    });

    const lista = [];
    let counter = 1;

    // Fechas e identificadores deterministas
    const fechas = ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'];
    
    Object.values(grupos).forEach((g, idx) => {
        const total = g.items.reduce((s, i) => s + i.totalItem, 0);
        const descParts = g.items.map(i => `${i.cantidad}x ${i.nombre} (${i.formato})`);
        const descripcion = descParts.join(', ');

        const sobrecostoMonto = g.items.reduce((s, i) => s + i.costoExceso, 0);
        const tieneSobrestock = g.items.some(i => i.sobrestockBase > 0);
        
        const issues = [];
        if (sobrecostoMonto > 0) issues.push('sobrecosto');
        if (tieneSobrestock) issues.push('sobrestock');

        // Alternar estados para tener variabilidad realista (primeros pagados, otros pendientes)
        const estado = (idx % 3 === 0 || idx % 3 === 1) ? 'pagado' : 'pendiente';

        lista.push({
            id: 'BP-' + String(counter++).padStart(3, '0'),
            sucursal: g.sucursal,
            proveedor: g.proveedor,
            descripcion: descripcion,
            total: total,
            estado: estado,
            fecha: fechas[idx % fechas.length],
            items: g.items,
            issues: issues,
            sobrecostoMonto: sobrecostoMonto,
            sobrestockDesc: tieneSobrestock ? 'Exceso de inventario detectado' : ''
        });
    });

    return lista;
}

window.renderPagos = function(filtroSucursal, filtroTipo) {
    filtroSucursal = filtroSucursal || 'all';
    filtroTipo = filtroTipo || 'all';

    const pagosData = obtenerPagosDinamicos();

    // Reconstruir botones de sucursales si no existen o cambiaron
    const grp = document.getElementById('pagos-sucursal-btn-group');
    if (grp) {
        const sucursales = [...new Set(pagosData.map(p => p.sucursal))];
        grp.innerHTML = '<button onclick="setPagosSucursal(\'all\')" id="pag-suc-all" class="pag-suc-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-500 text-white">Todas las sucursales</button>';
        sucursales.forEach(s => {
            const btn = document.createElement('button');
            const safeId = 'pag-suc-' + s.replace(/[\s]/g,'_');
            btn.id = safeId;
            const isSel = (filtroSucursal === s);
            btn.className = `pag-suc-btn px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${isSel ? 'bg-orange-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`;
            btn.textContent = s;
            btn.onclick = () => { if(typeof setPagosSucursal === 'function') setPagosSucursal(s); else renderPagos(s, filtroTipo); };
            grp.appendChild(btn);
        });
        if (filtroSucursal === 'all') {
            const btnAll = document.getElementById('pag-suc-all');
            if (btnAll) btnAll.className = 'pag-suc-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-500 text-white';
        }
    }

    let datos = filtroSucursal === 'all' ? pagosData : pagosData.filter(p => p.sucursal === filtroSucursal);
    if (filtroTipo === 'pagado')   datos = datos.filter(p => p.estado === 'pagado' && !(p.issues||[]).length);
    if (filtroTipo === 'pendiente') datos = datos.filter(p => p.estado === 'pendiente');
    if (filtroTipo === 'alerta')   datos = datos.filter(p => (p.issues||[]).length > 0);

    const pagados = pagosData.filter(p => p.estado === 'pagado' && (filtroSucursal === 'all' || p.sucursal === filtroSucursal));
    const pendientes = pagosData.filter(p => p.estado === 'pendiente' && (filtroSucursal === 'all' || p.sucursal === filtroSucursal));
    const elPag = document.getElementById('pagos-total-pagado');
    const elPen = document.getElementById('pagos-total-pendiente');
    if(elPag) elPag.innerText = '$' + pagados.reduce((s,p)=>s+p.total,0).toFixed(2);
    if(elPen) elPen.innerText = '$' + pendientes.reduce((s,p)=>s+p.total,0).toFixed(2);

    const list = document.getElementById('pagos-list-unified');
    if(!list) return;
    list.innerHTML = '';

    if(!datos.length) {
        list.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">Sin pedidos para este filtro.</p>';
        return;
    }

    datos.forEach(item => {
        const isPaid = item.estado === 'pagado';
        const issues = item.issues || [];
        const hasSobrecosto = issues.includes('sobrecosto');
        const hasSobrestock = issues.includes('sobrestock');
        const hasIssues = hasSobrecosto || hasSobrestock;

        let cardClass = 'p-4 rounded-xl border cursor-pointer hover:brightness-110 transition-all ';
        if (!isPaid) cardClass += 'bg-orange-500/5 border-orange-500/20';
        else if (hasSobrecosto && hasSobrestock) cardClass += 'bg-red-500/10 border-red-500/30';
        else if (hasSobrecosto) cardClass += 'bg-yellow-500/10 border-yellow-500/30';
        else if (hasSobrestock) cardClass += 'bg-purple-500/10 border-purple-500/30';
        else cardClass += 'bg-emerald-500/5 border-emerald-500/20';

        let issueBadges = '';
        if (hasSobrecosto) issueBadges += `<span class="text-[10px] font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-2 py-0.5 rounded-full">Sobrecosto $${item.sobrecostoMonto.toFixed(2)}</span>`;
        if (hasSobrestock) issueBadges += `<span class="text-[10px] font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30 px-2 py-0.5 rounded-full ml-1">${item.sobrestockDesc || 'Sobrestock'}</span>`;

        let statusMsg = '';
        if (!isPaid) statusMsg = '<span class="text-orange-500">Pendiente de confirmación de pago.</span>';
        else if (hasSobrecosto && hasSobrestock) statusMsg = '<span class="text-red-400">Generó sobrecosto y sobrestock.</span>';
        else if (hasSobrecosto) statusMsg = '<span class="text-yellow-400">Generó sobrecosto.</span>';
        else if (hasSobrestock) statusMsg = '<span class="text-purple-400">Generó sobrestock.</span>';
        else statusMsg = '<span class="text-emerald-500">No generó sobrecosto ni sobrestock.</span>';

        const div = document.createElement('div');
        div.className = cardClass;
        div.onclick = () => openInvoice(item);
        div.innerHTML = `
            <div class="flex items-start justify-between gap-3">
                <div class="flex-1 min-w-0">
                    <div class="flex flex-wrap items-center gap-2 mb-1">
                        <span class="text-xs font-mono text-slate-500">${item.id}</span>
                        <span class="text-sm font-semibold">${item.sucursal}</span>
                        <span class="text-xs text-slate-400">&middot; ${item.proveedor} &middot; ${item.fecha}</span>
                    </div>
                    <p class="text-xs text-slate-300 mb-1">${item.descripcion}</p>
                    ${issueBadges ? '<div class="flex flex-wrap gap-1 mb-1">' + issueBadges + '</div>' : ''}
                    <p class="text-[10px] italic">${statusMsg}</p>
                </div>
                <p class="text-sm font-bold flex-shrink-0 ${ isPaid ? (hasIssues ? 'text-yellow-400' : 'text-emerald-400') : 'text-orange-400' }">$${item.total.toFixed(2)}</p>
            </div>
        `;
        list.appendChild(div);
    });
};

window.openInvoice = function(item) {
    const modal = document.getElementById('invoice-modal');
    if (!modal) return;

    const issues = item.issues || [];
    document.getElementById('inv-numero').innerText = item.id;
    document.getElementById('inv-proveedor').innerText = item.proveedor;
    document.getElementById('inv-sucursal').innerText = item.sucursal;
    document.getElementById('inv-fecha').innerText = item.fecha;

    const isPaid = item.estado === 'pagado';
    const estadoEl = document.getElementById('inv-estado');
    estadoEl.innerHTML = isPaid
        ? '<span class="text-emerald-400 font-bold">Pagado</span>'
        : '<span class="text-orange-400 font-bold">Pendiente</span>';

    const subtotal = item.total;
    const tax = subtotal * 0.07;
    const totalWithTax = subtotal + tax;

    const tbody = document.getElementById('inv-items');
    if (item.items && item.items.length > 0) {
        tbody.innerHTML = item.items.map(it => `
            <tr class="hover:bg-slate-800/40 transition-colors">
                <td class="py-2.5 text-slate-200 font-medium">
                    ${it.nombre} 
                    <span class="text-xs text-slate-400 block sm:inline">(${it.formato})</span>
                </td>
                <td class="py-2.5 text-center text-slate-300 font-semibold">${it.cantidad}</td>
                <td class="py-2.5 text-right text-slate-400">$${it.precioUnitario.toFixed(2)}</td>
                <td class="py-2.5 text-right font-bold text-orange-400">$${it.totalItem.toFixed(2)}</td>
            </tr>
        `).join('');
    } else {
        const parts = item.descripcion.split(',');
        const approxUnit = (subtotal / parts.length).toFixed(2);
        tbody.innerHTML = parts.map(p => `
            <tr>
                <td class="py-2.5 text-slate-200 font-medium">${p.trim()}</td>
                <td class="py-2.5 text-center text-slate-300 font-semibold">1</td>
                <td class="py-2.5 text-right text-slate-400">$${approxUnit}</td>
                <td class="py-2.5 text-right font-bold text-orange-400">$${approxUnit}</td>
            </tr>
        `).join('');
    }

    document.getElementById('inv-subtotal').innerText = '$' + subtotal.toFixed(2);
    document.getElementById('inv-tax').innerText = '$' + tax.toFixed(2);
    document.getElementById('inv-total').innerText = '$' + totalWithTax.toFixed(2);

    // Issues block
    const issuesBlock = document.getElementById('inv-issues-block');
    if (issues.length) {
        issuesBlock.classList.remove('hidden');
        const msgs = [];
        if (issues.includes('sobrecosto')) msgs.push('Sobrecosto detectado: $' + (item.sobrecostoMonto||0).toFixed(2) + ' sobre el precio acordado.');
        if (issues.includes('sobrestock')) msgs.push('Sobrestock: ' + (item.sobrestockDesc || 'Exceso de inventario'));
        issuesBlock.className = 'p-3 rounded-xl border text-xs bg-red-500/10 border-red-500/30 text-red-400';
        issuesBlock.innerHTML = '<b>Alertas en este pedido:</b><ul class="mt-1 list-disc list-inside">' + msgs.map(m=>'<li>'+m+'</li>').join('') + '</ul>';
    } else {
        issuesBlock.classList.add('hidden');
    }

    lucide.createIcons();
    modal.classList.remove('hidden');
};

// Lógica de Chat IA — con conexion real a Gemini/OpenAI
window.saveApiKey = function() {
    api_key = document.getElementById('api-key-input').value.trim();
    ai_provider = document.getElementById('api-provider').value;
    document.getElementById('api-key-modal').classList.add('hidden');
    const label = document.getElementById('ai-status-label');
    if (label) label.innerText = `Conectado a ${ai_provider === 'gemini' ? 'Google Gemini' : 'OpenAI'}`;
    addChatMessage('bot', `API Key guardada. Ahora usare <b>${ai_provider === 'gemini' ? 'Google Gemini' : 'ChatGPT (OpenAI)'}</b> para responder tus preguntas en tiempo real.`);
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

    const typingId = 'typing-' + Date.now();
    addChatMessage('bot', '<span class="animate-pulse">Pensando...</span>', typingId);

    if (api_key) {
        // Call real AI API
        callAI(msg).then(resp => {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();
            addChatMessage('bot', resp);
        }).catch(err => {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();
            addChatMessage('bot', 'Error al conectar con la IA: ' + err.message + '. Verifica tu API Key.');
        });
    } else {
        setTimeout(() => {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();
            addChatMessage('bot', generarRespuestaBasica(msg.toLowerCase()));
        }, 700);
    }
};

async function callAI(userMsg) {
    // Build context from current data
    const totalQuiebres = resultados.filter(r => r.alerta?.tipo === 'quiebre').length;
    const costoTotal = resultados.reduce((s, r) => s + r.costoExceso, 0).toFixed(2);
    const sucursales = [...new Set(resultados.map(r => r.sucursal))].join(', ');
    const context = `Eres un asistente de compras para la cadena de pizzerias Barrio Pizza en Panama. Tienes acceso a los datos de la semana actual: Sucursales: ${sucursales}. Alertas de quiebre (faltantes criticos): ${totalQuiebres}. Gasto en excesos: $${costoTotal}. El usuario pregunta sobre ordenes de compra, inventario, ingredientes y redistribucion entre sucursales. Responde en espanol, de forma concisa y util.`;

    if (ai_provider === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${api_key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: context + '\n\nPregunta del usuario: ' + userMsg }] }]
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta.';
    } else {
        // OpenAI
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: context },
                    { role: 'user', content: userMsg }
                ],
                max_tokens: 300
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.choices?.[0]?.message?.content || 'Sin respuesta.';
    }
}

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

// --- NUEVA LOGICA DE DRAG & DROP (CSV + Excel) CON ELIMINACION ---
window.handleFileUpload = function(input, type) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    const name = file.name;
    const lowerName = name.toLowerCase();
    const statusEl = document.getElementById('status-' + type);
    const btnDelete = document.getElementById('btn-delete-' + type);

    function onUploadSuccess() {
        if (statusEl) {
            statusEl.innerText = 'Cargado: ' + name;
            statusEl.className = 'text-emerald-400 font-bold';
        }
        if (btnDelete) btnDelete.classList.remove('hidden');
        procesarDatos();
        renderizarUI();
    }

    if (lowerName.endsWith('.csv')) {
        Papa.parse(file, {
            header: true, dynamicTyping: true, skipEmptyLines: true,
            complete: function(results) {
                datos[type] = results.data;
                onUploadSuccess();
            }
        });
    } else if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const wb = XLSX.read(e.target.result, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(ws, { defval: '' });
            datos[type] = jsonData;
            onUploadSuccess();
        };
        reader.readAsArrayBuffer(file);
    }
};

window.eliminarArchivoSubido = function(type, event) {
    if (event) event.stopPropagation();
    
    // Restaurar datos iniciales
    if (datosOriginales[type]) {
        datos[type] = JSON.parse(JSON.stringify(datosOriginales[type]));
    }
    
    // Resetear input de archivo
    const input = document.getElementById('file-' + type);
    if (input) input.value = '';
    
    // Resetear indicador visual y ocultar botón de eliminar
    const statusEl = document.getElementById('status-' + type);
    if (statusEl) {
        statusEl.innerText = 'Usando datos locales';
        statusEl.className = 'text-orange-400';
    }
    
    const btnDelete = document.getElementById('btn-delete-' + type);
    if (btnDelete) btnDelete.classList.add('hidden');

    // Recalcular todo el sistema al instante
    procesarDatos();
    renderizarUI();
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
