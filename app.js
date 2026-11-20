/* Avance NABLA - extensión del visor 3D de Trimble Connect */
(function () {
  "use strict";
  var C = window.CONFIG, L = window.Logica;
  var API = null;
  var indice = null;          // { marca: [ {modelId, id} ] }  (una entrada por pieza física / ensamble)
  var filas = null;           // avance leído
  var ultimo = null;          // resultado del último coloreado
  var temporizador = null;
  var $ = function (id) { return document.getElementById(id); };

  function estado(txt, error) {
    var e = $("estado"); e.textContent = txt || ""; e.className = error ? "error" : "";
  }
  function ocupado(si) { $("btnColorear").disabled = si; $("btnReset").disabled = si; }

  // ------------------------------------------------------------ conexión con Trimble Connect
  async function conectar() {
    try {
      API = await TrimbleConnectWorkspace.connect(window.parent, function (evento) {
        if (evento === "viewer.onModelStateChanged" || evento === "viewer.onModelReset") indice = null;
      }, 30000);
      try {
        var p = await API.project.getProject();
        var m = (p && p.name || "").match(new RegExp(C.patronProyecto));
        var guardado = leerLocal("proyecto:" + (p && p.id));
        $("proyecto").value = guardado || (m ? m[1] : "");
        $("proyecto").dataset.pid = p && p.id || "";
      } catch (e) { /* sin proyecto */ }
      estado("Listo. Carga los modelos y presiona «Colorear avance».");
    } catch (e) {
      estado("No se pudo conectar con Trimble Connect. Abre esta página desde el visor 3D.", true);
    }
  }

  function leerLocal(k) { try { return localStorage.getItem("avnabla:" + k); } catch (e) { return null; } }
  function guardarLocal(k, v) { try { localStorage.setItem("avnabla:" + k, v); } catch (e) {} }

  // ------------------------------------------------------------ índice marca -> piezas del modelo
  async function indexar() {
    estado("Leyendo propiedades de los modelos cargados…");
    var modelos = await API.viewer.getObjects();
    var asm = {}, partes = {}, asmSin = [], marcaPieza = {}, pesoObj = {};
    var total = 0;
    for (var a = 0; a < modelos.length; a++) {
      var mid = modelos[a].modelId;
      var ids = (modelos[a].objects || []).map(function (o) { return o.id; });
      for (var i = 0; i < ids.length; i += 1000) {
        var lote = ids.slice(i, i + 1000);
        var props = await API.viewer.getObjectProperties(mid, lote);
        props.forEach(function (o) {
          var pw = L.pesoDeObjeto(o, C.propiedadesPeso || []);
          if (pw) pesoObj[mid + ":" + o.id] = pw;
          var marca = L.marcaDeObjeto(o, C.propiedadesMarca);
          var esAsm = String(o.class || "").toUpperCase().indexOf("ASSEMBLY") >= 0;
          if (!marca) { if (esAsm) asmSin.push({ modelId: mid, id: o.id }); return; }
          if (esAsm) (asm[marca] = asm[marca] || []).push({ modelId: mid, id: o.id });
          else { (partes[marca] = partes[marca] || []).push({ modelId: mid, id: o.id }); marcaPieza[mid + ":" + o.id] = marca; }
        });
        total += lote.length;
        estado("Leyendo propiedades… " + total + " objetos");
      }
    }
    // ensambles sin marca propia (ej. Advance Steel): la marca se toma de sus piezas
    var cubiertas = {};
    for (var u = 0; u < asmSin.length; u += 40) {
      var lote0 = asmSin.slice(u, u + 40);
      var hh = await Promise.all(lote0.map(async function (x) {
        try { return await API.viewer.getHierarchyChildren(x.modelId, [x.id], 4, true); } catch (e) { return []; }
      }));
      lote0.forEach(function (x, j) {
        var ids = (hh[j] || []).map(function (e) { return e.id; });
        var m = null;
        for (var q = 0; q < ids.length && !m; q++) m = marcaPieza[x.modelId + ":" + ids[q]];
        if (!m) return;
        ids.forEach(function (i) { cubiertas[x.modelId + ":" + i] = 1; });
        (asm[m] = asm[m] || []).push({ modelId: x.modelId, id: x.id, hijos: ids });
      });
      estado("Leyendo ensambles… " + Math.min(u + 40, asmSin.length) + "/" + asmSin.length);
    }
    Object.keys(partes).forEach(function (m) {
      partes[m] = partes[m].filter(function (x) { return !cubiertas[x.modelId + ":" + x.id]; });
      if (!partes[m].length) delete partes[m];
    });
    // marcas con objeto ensamble: cada ensamble es una pieza física (se colorea con sus hijos)
    var idx = {};
    var listaAsm = [];
    Object.keys(asm).forEach(function (m) {
      asm[m].forEach(function (x) {
        if (x.hijos) (idx[m] = idx[m] || []).push({ modelId: x.modelId, ids: [x.id].concat(x.hijos), asm: true });
        else listaAsm.push({ m: m, x: x });
      });
    });
    for (var t = 0; t < listaAsm.length; t += 40) {
      var lote1 = listaAsm.slice(t, t + 40);
      var hijos = await Promise.all(lote1.map(async function (it) {
        try {
          var h = await API.viewer.getHierarchyChildren(it.x.modelId, [it.x.id], 4, true);
          return (h || []).map(function (e) { return e.id; });
        } catch (e) { return null; }
      }));
      lote1.forEach(function (it, j) {
        var inst = hijos[j] && hijos[j].length
          ? { modelId: it.x.modelId, ids: [it.x.id].concat(hijos[j]), asm: true }
          : { modelId: it.x.modelId, id: it.x.id, rec: true, asm: true };
        (idx[it.m] = idx[it.m] || []).push(inst);
      });
      estado("Agrupando piezas por ensamble… " + Math.min(t + 40, listaAsm.length) + "/" + listaAsm.length);
    }
    // marcas que solo aparecen en las piezas: agrupar por ensamble padre
    var soloPartes = Object.keys(partes).filter(function (m) { return !idx[m]; });
    for (var s = 0; s < soloPartes.length; s++) {
      var m = soloPartes[s], grupos = {};
      for (var k = 0; k < partes[m].length; k += 40) {
        var lote2 = partes[m].slice(k, k + 40);
        var claves = await Promise.all(lote2.map(async function (x) {
          try {
            var padres = await API.viewer.getHierarchyParents(x.modelId, [x.id], 4, false);
            if (padres && padres.length) return x.modelId + ":P" + padres[0].id;
          } catch (e) {}
          return x.modelId + ":" + x.id;
        }));
        lote2.forEach(function (x, j) {
          (grupos[claves[j]] = grupos[claves[j]] || { modelId: x.modelId, ids: [] }).ids.push(x.id);
        });
      }
      if (s % 20 === 0) estado("Agrupando piezas por ensamble… " + (s + 1) + "/" + soloPartes.length);
      idx[m] = Object.keys(grupos).map(function (g) { return { modelId: grupos[g].modelId, ids: grupos[g].ids }; });
    }
    // peso de cada pieza física: el del ensamble; si no lo trae, la suma de sus piezas
    Object.keys(idx).forEach(function (m) {
      idx[m].forEach(function (inst) {
        var ids = inst.ids || [inst.id];
        var w = inst.asm ? (pesoObj[inst.modelId + ":" + ids[0]] || 0) : 0;
        if (!w) for (var i = (inst.asm ? 1 : 0); i < ids.length; i++) w += pesoObj[inst.modelId + ":" + ids[i]] || 0;
        if (!w && inst.id) w = pesoObj[inst.modelId + ":" + inst.id] || 0;
        inst.peso = w;
      });
    });
    indice = idx;
    return idx;
  }

  // ------------------------------------------------------------ lectura del avance
  var msalApp = null;
  async function tokenGraph() {
    if (!C.clientId) throw new Error("Falta el clientId de Entra ID en config.js (lo da TI). Mientras tanto usa el modo CSV.");
    if (!msalApp) {
      msalApp = new msal.PublicClientApplication({
        auth: { clientId: C.clientId, authority: "https://login.microsoftonline.com/" + C.tenantId, redirectUri: C.redirectUri },
        cache: { cacheLocation: "localStorage" }
      });
      if (msalApp.initialize) await msalApp.initialize();
    }
    var pet = { scopes: ["Sites.Read.All"] };
    var cuentas = msalApp.getAllAccounts();
    if (cuentas.length) {
      try { return (await msalApp.acquireTokenSilent(Object.assign({ account: cuentas[0] }, pet))).accessToken; } catch (e) {}
    }
    return (await msalApp.acquireTokenPopup(pet)).accessToken;
  }

  async function leerSharePoint() {
    estado("Leyendo la lista de SharePoint…");
    var tk = await tokenGraph();
    var h = { Authorization: "Bearer " + tk };
    var r = await fetch("https://graph.microsoft.com/v1.0/sites/" + C.sharepointHost + ":" + C.sitePath, { headers: h });
    if (!r.ok) throw new Error("No se pudo abrir el sitio de SharePoint (" + r.status + ").");
    var sitio = await r.json();
    var f = C.campos;
    var url = "https://graph.microsoft.com/v1.0/sites/" + sitio.id + "/lists/" + encodeURIComponent(C.listName) +
      "/items?$top=999&$expand=fields($select=" + [f.marca, f.proyecto, f.etapa, f.cantidad].join(",") + ")";
    var out = [];
    while (url) {
      var rr = await fetch(url, { headers: h });
      if (!rr.ok) throw new Error("No se pudo leer la lista (" + rr.status + ").");
      var j = await rr.json();
      (j.value || []).forEach(function (it) {
        var x = it.fields || {};
        out.push({ marca: x[f.marca], proyecto: x[f.proyecto], etapa: x[f.etapa], cantidad: x[f.cantidad] });
      });
      url = j["@odata.nextLink"];
    }
    return out;
  }

  function leerArchivo() {
    return new Promise(function (ok, mal) {
      var fi = $("archivo").files[0];
      if (!fi) return mal(new Error("Elige el archivo CSV exportado de la lista."));
      var rd = new FileReader();
      rd.onload = function () { try { ok(L.leerCSV(rd.result)); } catch (e) { mal(e); } };
      rd.onerror = function () { mal(new Error("No se pudo leer el archivo.")); };
      rd.readAsText(fi, "utf-8");
    });
  }

  // ------------------------------------------------------------ coloreado
  function selector(lista) {
    var porModelo = {};
    lista.forEach(function (x) {
      var k = x.modelId + (x.rec ? "|r" : "");
      var g = porModelo[k] = porModelo[k] || { modelId: x.modelId, objectRuntimeIds: [], recursive: !!x.rec };
      if (x.ids) Array.prototype.push.apply(g.objectRuntimeIds, x.ids); else g.objectRuntimeIds.push(x.id);
    });
    return { modelObjectIds: Object.keys(porModelo).map(function (k) { return porModelo[k]; }) };
  }

  async function colorear(soloReleer) {
    if (!API) return;
    ocupado(true);
    try {
      var proyecto = $("proyecto").value.trim();
      guardarLocal("proyecto:" + $("proyecto").dataset.pid, proyecto);
      if (!indice) await indexar();
      if (!Object.keys(indice).length) {
        estado("No encontré marcas en los modelos cargados. Revisa en «Diagnóstico» en qué propiedad está la marca.", true);
        return;
      }
      filas = $("fuente").value === "sp" ? await leerSharePoint() : await leerArchivo();
      var sumas = L.sumarAvance(filas, proyecto, C.etapas);
      var colores = [C.colorSinAvance].concat(C.etapas.map(function (e) { return e.color; }));
      var cubetas = colores.map(function () { return []; });
      var resumen = [];
      Object.keys(indice).sort().forEach(function (m) {
        var inst = indice[m].slice().sort(function (a, b) { return (a.id || a.ids[0]) - (b.id || b.ids[0]); });
        var s = sumas[m] || C.etapas.map(function () { return 0; });
        var rep = L.repartir(inst.length, s);
        // las primeras piezas reciben la etapa más avanzada
        var pos = 0, kg = rep.map(function () { return 0; }), kgTot = 0;
        for (var b = rep.length - 1; b >= 0; b--) {
          for (var q = 0; q < rep[b]; q++) { var it = inst[pos++]; cubetas[b].push(it); kg[b] += it.peso || 0; kgTot += it.peso || 0; }
        }
        resumen.push({ marca: m, total: inst.length, rep: rep, kg: kg, kgTot: kgTot, reportado: !!sumas[m] });
      });
      estado("Aplicando colores…");
      await API.viewer.setObjectState(undefined, { color: "reset" });
      if (C.atenuarResto) await API.viewer.setObjectState(undefined, { color: { r: 225, g: 225, b: 225, a: 70 } });
      for (var c = 0; c < colores.length; c++) {
        if (cubetas[c].length) await API.viewer.setObjectState(selector(cubetas[c]), { color: L.rgba(colores[c], 255) });
      }
      resumen.sort(function (x, y) {
        var ax = x.total - x.rep[0], ay = y.total - y.rep[0];
        if ((ax > 0) !== (ay > 0)) return ax > 0 ? -1 : 1;
        if (ax > 0) {
          for (var i = x.rep.length - 1; i >= 1; i--) if (x.rep[i] !== y.rep[i]) return y.rep[i] - x.rep[i];
        }
        return x.marca < y.marca ? -1 : 1;
      });
      var noEnc = Object.keys(sumas).filter(function (m) { return !indice[m]; });
      ultimo = { resumen: resumen, noEnc: noEnc, cubetas: cubetas, colores: colores };
      pintarPanel();
      var hora = new Date().toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit" });
      estado("Actualizado " + hora + " · " + resumen.length + " marcas en el modelo · " + filas.length + " reportes leídos.");
      programarAuto();
    } catch (e) {
      estado(e.message || String(e), true);
    } finally {
      ocupado(false);
    }
  }

  function programarAuto() {
    if (temporizador) clearInterval(temporizador);
    if ($("fuente").value === "sp" && C.autoActualizarMin > 0) {
      temporizador = setInterval(function () { colorear(true); }, C.autoActualizarMin * 60000);
    }
  }

  async function quitarColores() {
    if (!API) return;
    if (temporizador) clearInterval(temporizador);
    await API.viewer.setObjectState(undefined, { color: "reset", visible: "reset" });
    estado("Colores restablecidos.");
  }

  // ------------------------------------------------------------ panel: leyenda y tabla
  function ton(kg) { return (kg / 1000).toLocaleString("es-GT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

  function pintarLeyenda() {
    var nombres = ["Sin avance"].concat(C.etapas.map(function (e) { return e.nombre; }));
    var colores = [C.colorSinAvance].concat(C.etapas.map(function (e) { return e.color; }));
    var cuentas = colores.map(function () { return 0; }), kgs = colores.map(function () { return 0; }), kgTot = 0;
    if (ultimo) ultimo.resumen.forEach(function (r) {
      r.rep.forEach(function (v, i) { cuentas[i] += v; kgs[i] += r.kg[i]; });
      kgTot += r.kgTot;
    });
    // orden: Armado, Pintura, Despacho, Montaje y al final Sin avance
    var orden = C.etapas.map(function (e, i) { return i + 1; }).concat([0]);
    var html = orden.map(function (i) {
      var acciones = ultimo && cuentas[i]
        ? '<span class="acc"><button class="mini" data-sel="' + i + '" title="Seleccionar los ensambles de esta etapa">Seleccionar</button>' +
          '<button class="mini" data-solo="' + i + '" title="Mostrar solo esta etapa">Solo</button></span>'
        : '<span class="acc"></span>';
      return '<div><span class="sw" style="background:' + colores[i] + '"></span>' + nombres[i] +
        '<span class="n">' + (ultimo ? cuentas[i] + " pzas · " + ton(kgs[i]) + " t" : "") + "</span>" + acciones + "</div>";
    }).join("");
    if (ultimo) html += '<div style="margin-top:4px"><button class="mini" id="btnTodo" style="flex:none">Mostrar todo</button></div>';
    if (ultimo && kgTot > 0) {
      // peso que alcanzó cada etapa (lo montado también pasó por armado, etc.)
      var acum = 0, alc = [];
      for (var j = C.etapas.length; j >= 1; j--) { acum += kgs[j]; alc[j - 1] = acum; }
      html += '<div style="margin-top:6px;border-top:1px solid #e5e7eb;padding-top:6px;font-size:12px;flex-wrap:wrap">' +
        "Total en modelo: <b>" + ton(kgTot) + " t</b></div>" +
        C.etapas.map(function (e, i) {
          return '<div style="font-size:12px">' + e.nombre + ": " + ton(alc[i]) + " t (" +
            (100 * alc[i] / kgTot).toFixed(1) + " %)</div>";
        }).join("");
    }
    $("leyenda").innerHTML = html;
    $("encTabla").innerHTML = "<th>Marca</th><th class='num'>Pzas</th><th class='num'>t</th>" +
      C.etapas.map(function (e) { return "<th class='num' title='" + e.nombre + "'>" + e.nombre.slice(0, 3) + "</th>"; }).join("") +
      "<th>Avance</th>";
  }

  function pintarPanel() {
    pintarLeyenda();
    if (!ultimo) return;
    var f = $("filtro").value.trim().toUpperCase();
    var colores = ultimo.colores;
    $("cuerpo").innerHTML = ultimo.resumen.filter(function (r) { return !f || r.marca.indexOf(f) >= 0; })
      .map(function (r) {
        var alc = []; var acum = 0;
        for (var i = r.rep.length - 1; i >= 1; i--) { acum += r.rep[i]; alc[i - 1] = acum; }
        var barra = r.rep.map(function (v, i) {
          return v ? '<span style="width:' + (100 * v / r.total) + '%;background:' + colores[i] + '"></span>' : "";
        });
        barra = barra.slice(1).reverse().concat(barra[0]).join("");
        return '<tr class="click" data-m="' + r.marca + '"' + (r.total - r.rep[0] > 0 ? "" : ' style="color:#9ca3af"') + '><td>' +
          r.marca + "</td><td class='num'>" + r.total + "</td><td class='num'>" + (r.kgTot ? ton(r.kgTot) : "") + "</td>" +
          alc.map(function (v) { return "<td class='num'>" + (v || "") + "</td>"; }).join("") +
          '<td><div class="barra">' + barra + "</div></td></tr>";
      }).join("");
    $("noEncontradas").innerHTML = ultimo.noEnc.length
      ? '<div class="aviso">Reportadas en SharePoint pero no encontradas en los modelos cargados: ' + ultimo.noEnc.join(", ") + "</div>"
      : "";
  }

  async function seleccionarEtapa(i, solo) {
    if (!ultimo || !ultimo.cubetas[i].length) return;
    var sel = selector(ultimo.cubetas[i]);
    try {
      if (solo) {
        await API.viewer.setObjectState(undefined, { visible: false });
        await API.viewer.setObjectState(sel, { visible: true });
      }
      await API.viewer.setSelection(sel, "set");
      await API.viewer.setCamera(sel, { animationTime: 400 });
      var nombre = i === 0 ? "Sin avance" : C.etapas[i - 1].nombre;
      estado((solo ? "Mostrando solo " : "Seleccionados: ") + nombre + " · " + ultimo.cubetas[i].length + " ensambles.");
    } catch (e) { estado("No se pudo seleccionar: " + (e.message || e), true); }
  }

  async function mostrarTodo() {
    try {
      await API.viewer.setObjectState(undefined, { visible: "reset" });
      estado("Se muestran todos los objetos.");
    } catch (e) {}
  }

  async function seleccionarMarca(m) {
    if (!indice || !indice[m]) return;
    var sel = selector(indice[m]);
    try {
      await API.viewer.setSelection(sel, "set");
      await API.viewer.setCamera(sel, { animationTime: 400 });
    } catch (e) {}
  }

  // ------------------------------------------------------------ diagnóstico
  async function diagnostico() {
    var out = $("diag");
    try {
      var sel = await API.viewer.getSelection();
      if (!sel.length || !sel[0].objectRuntimeIds || !sel[0].objectRuntimeIds.length) { out.textContent = "No hay nada seleccionado."; return; }
      var mid = sel[0].modelId, id = sel[0].objectRuntimeIds[0];
      var p = (await API.viewer.getObjectProperties(mid, [id]))[0] || {};
      var txt = "Clase: " + (p.class || "") + "\nProduct.Name: " + (p.product && p.product.name || "") +
        "\nMarca detectada: " + (L.marcaDeObjeto(p, C.propiedadesMarca) || "(ninguna)") + "\n\n";
      (p.properties || []).forEach(function (s) {
        (s.properties || []).forEach(function (q) { txt += s.name + "." + q.name + " = " + q.value + "\n"; });
      });
      try {
        var hijos = await API.viewer.getHierarchyChildren(mid, [id], 4, false);
        if (hijos && hijos.length) {
          var hp = (await API.viewer.getObjectProperties(mid, [hijos[0].id]))[0] || {};
          txt += "\n--- Primera pieza del ensamble (" + (hp.class || "") + ") ---\nProduct.Name: " + (hp.product && hp.product.name || "") +
            "\nMarca detectada: " + (L.marcaDeObjeto(hp, C.propiedadesMarca) || "(ninguna)") + "\n";
          (hp.properties || []).forEach(function (s) {
            (s.properties || []).forEach(function (q) { txt += s.name + "." + q.name + " = " + q.value + "\n"; });
          });
        }
      } catch (e) {}
      try {
        var padres = await API.viewer.getHierarchyParents(mid, [id], 4, false);
        if (padres && padres.length) {
          var pp = (await API.viewer.getObjectProperties(mid, [padres[0].id]))[0] || {};
          txt += "\n--- Ensamble padre (" + (pp.class || "") + ") ---\nProduct.Name: " + (pp.product && pp.product.name || "") +
            "\nMarca detectada: " + (L.marcaDeObjeto(pp, C.propiedadesMarca) || "(ninguna)") + "\n";
          (pp.properties || []).forEach(function (s) {
            (s.properties || []).forEach(function (q) { txt += s.name + "." + q.name + " = " + q.value + "\n"; });
          });
        }
      } catch (e) {}
      out.textContent = txt;
    } catch (e) { out.textContent = "Error: " + (e.message || e); }
  }

  // ------------------------------------------------------------ eventos de la página
  $("fuente").addEventListener("change", function () {
    $("cajaCSV").style.display = this.value === "csv" ? "block" : "none";
    guardarLocal("fuente", this.value);
  });
  var f0 = leerLocal("fuente") || (C.clientId ? "sp" : "csv");
  $("fuente").value = f0; $("cajaCSV").style.display = f0 === "csv" ? "block" : "none";
  $("btnColorear").addEventListener("click", function () { colorear(false); });
  $("btnReset").addEventListener("click", quitarColores);
  $("btnDiag").addEventListener("click", diagnostico);
  $("filtro").addEventListener("input", pintarPanel);
  $("leyenda").addEventListener("click", function (ev) {
    var b = ev.target.closest("button"); if (!b) return;
    if (b.id === "btnTodo") return mostrarTodo();
    if (b.dataset.sel !== undefined) return seleccionarEtapa(+b.dataset.sel, false);
    if (b.dataset.solo !== undefined) return seleccionarEtapa(+b.dataset.solo, true);
  });
  $("cuerpo").addEventListener("click", function (ev) {
    var tr = ev.target.closest("tr[data-m]"); if (tr) seleccionarMarca(tr.dataset.m);
  });
  pintarLeyenda();
  conectar();
})();
