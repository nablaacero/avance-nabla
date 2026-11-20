/* Avance NABLA - extensión del visor 3D de Trimble Connect */
(function () {
  "use strict";
  var C = window.CONFIG, L = window.Logica;
  var API = null;
  var indice = null;          // { marca: [ {modelId, id} ] }  (una entrada por pieza física / ensamble)
  var filas = null;           // avance leído
  var ultimo = null;          // resultado del último coloreado
  var temporizador = null, ultimoArchivo = "";
  var tokTC = null, esperaTok = null, baseTC = null;
  var $ = function (id) { return document.getElementById(id); };

  function estado(txt, error) {
    var e = $("estado"); e.textContent = txt || ""; e.className = error ? "error" : "";
  }
  function ocupado(si) { $("btnColorear").disabled = si; $("btnReset").disabled = si; }

  // ------------------------------------------------------------ conexión con Trimble Connect
  async function conectar() {
    try {
      API = await TrimbleConnectWorkspace.connect(window.parent, function (evento, datos) {
        if (evento === "viewer.onModelStateChanged" || evento === "viewer.onModelReset") indice = null;
        if (evento === "extension.accessToken") {
          var t = datos && datos.data !== undefined ? datos.data : datos;
          if (t && t !== "pending" && t !== "denied") { tokTC = t; if (esperaTok) { esperaTok(t); esperaTok = null; } }
        }
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

  // ---------- archivo dentro del proyecto de Trimble Connect
  async function tokenTC() {
    if (tokTC) return tokTC;
    var t = await API.extension.requestPermission("accesstoken");
    if (t && t !== "pending" && t !== "denied") { tokTC = t; return t; }
    if (t === "denied") throw new Error("Trimble Connect no dio permiso a la extensión. Acepta el acceso e inténtalo de nuevo.");
    estado("Acepta el permiso que muestra Trimble Connect…");
    return await new Promise(function (ok, mal) {
      esperaTok = ok;
      setTimeout(function () { mal(new Error("Acepta el permiso de acceso de Trimble Connect y vuelve a presionar «Colorear avance».")); }, 90000);
    });
  }

  async function tc(ruta, tk) {
    var r = await fetch(baseTC + ruta, { headers: { Authorization: "Bearer " + tk } });
    if (r.status === 401) { tokTC = null; throw new Error("La sesión de Trimble Connect venció; vuelve a presionar «Colorear avance»."); }
    if (!r.ok) throw new Error("Trimble Connect respondió " + r.status + " en " + ruta);
    return r.json();
  }

  async function leerTrimble() {
    estado("Buscando el archivo en " + C.carpetaProduccion + "…");
    var tk = await tokenTC();
    var proy = await API.project.getProject();
    var info = null;
    if (!baseTC) {
      var bases = ["https://app.connect.trimble.com", "https://app21.connect.trimble.com", "https://app22.connect.trimble.com",
                   "https://app31.connect.trimble.com", "https://app32.connect.trimble.com"];
      for (var b = 0; b < bases.length && !info; b++) {
        try {
          var rr = await fetch(bases[b] + "/tc/api/2.0/projects/" + proy.id, { headers: { Authorization: "Bearer " + tk } });
          if (rr.ok) { info = await rr.json(); baseTC = bases[b] + "/tc/api/2.0"; }
        } catch (e) {}
      }
      if (!info) throw new Error("No pude abrir el proyecto con la API de Trimble Connect.");
    } else info = await tc("/projects/" + proy.id, tk);
    var carpeta = info.rootId;
    var partes = C.carpetaProduccion.split("/").filter(Boolean);
    for (var i = 0; i < partes.length; i++) {
      var items = await tc("/folders/" + carpeta + "/items", tk);
      var f = (items || []).filter(function (x) {
        return String(x.type).toUpperCase() === "FOLDER" && norm(x.name) === norm(partes[i]);
      })[0];
      if (!f) throw new Error("No encontré la carpeta «" + partes[i] + "» en Trimble Connect.");
      carpeta = f.id;
    }
    var arch = (await tc("/folders/" + carpeta + "/items", tk) || []).filter(function (x) {
      return String(x.type).toUpperCase() === "FILE" && /\.(xlsx|xlsm|xls|csv)$/i.test(x.name || "");
    });
    if (!arch.length) throw new Error("La carpeta " + C.carpetaProduccion + " no tiene archivos .xlsx o .csv.");
    var fecha = function (x) { return Date.parse(x.modifiedOn || x.modified || x.createdOn || 0) || 0; };
    arch.sort(function (x, y) { return fecha(y) - fecha(x); });
    var a = arch[0];
    estado("Leyendo " + a.name + "…");
    var du = await tc("/files/fs/" + a.id + "/downloadurl", tk);
    var url = du.url || du.downloadUrl || du;
    var resp = await fetch(url);
    if (!resp.ok) throw new Error("No se pudo descargar " + a.name + " (" + resp.status + ").");
    var buf = await resp.arrayBuffer();
    var filas = convertir(buf, a.name);
    ultimoArchivo = a.name + " · " + new Date(fecha(a)).toLocaleString("es-GT", { dateStyle: "short", timeStyle: "short" });
    return filas;
  }

  function norm(t) { return String(t || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

  // contenido (ArrayBuffer) de un .csv o .xlsx -> filas de avance
  function convertir(buf, nombre) {
    if (/\.csv$/i.test(nombre)) return L.leerCSV(new TextDecoder("utf-8").decode(buf));
    var wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    var error = null;
    for (var s = 0; s < wb.SheetNames.length; s++) {
      var m = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], { header: 1, raw: true, defval: "" });
      try { return L.leerTabla(m); } catch (e) { error = e; }
    }
    throw error || new Error("El archivo no tiene hojas.");
  }

  function leerArchivo() {
    return new Promise(function (ok, mal) {
      var fi = $("archivo").files[0];
      if (!fi) return mal(new Error("Elige el archivo CSV exportado de la lista."));
      var rd = new FileReader();
      rd.onload = function () { try { ultimoArchivo = fi.name; ok(convertir(rd.result, fi.name)); } catch (e) { mal(e); } };
      rd.onerror = function () { mal(new Error("No se pudo leer el archivo.")); };
      rd.readAsArrayBuffer(fi);
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
      var fu = $("fuente").value;
      filas = fu === "sp" ? await leerSharePoint() : fu === "tc" ? await leerTrimble() : await leerArchivo();
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
      estado("Actualizado " + hora + " · " + resumen.length + " marcas en el modelo · " + filas.length + " registros leídos" +
        (fu !== "sp" && ultimoArchivo ? " · archivo: " + ultimoArchivo : ""));
      programarAuto();
    } catch (e) {
      estado(e.message || String(e), true);
    } finally {
      ocupado(false);
    }
  }

  function programarAuto() {
    if (temporizador) clearInterval(temporizador);
    if ($("fuente").value !== "csv" && C.autoActualizarMin > 0) {
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

  var ICO_SEL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 3l7 17 2.5-7.5L21 10z"/></svg>';
  var ICO_OJO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  function pintarLeyenda() {
    var nombres = ["Sin avance"].concat(C.etapas.map(function (e) { return e.nombre; }));
    var colores = [C.colorSinAvance].concat(C.etapas.map(function (e) { return e.color; }));
    var cuentas = colores.map(function () { return 0; }), kgs = colores.map(function () { return 0; }), kgTot = 0, pzTot = 0;
    if (ultimo) ultimo.resumen.forEach(function (r) {
      r.rep.forEach(function (v, i) { cuentas[i] += v; kgs[i] += r.kg[i]; pzTot += v; });
      kgTot += r.kgTot;
    });
    var orden = C.etapas.map(function (e, i) { return i + 1; }).concat([0]);
    var pct = function (kg) { return kgTot ? (100 * kg / kgTot).toFixed(1) + "%" : ""; };
    var html = '<div class="tit">Estado actual de las piezas</div>' +
      '<table class="ley"><thead><tr><th>Etapa</th><th class="num">Pzas</th><th class="num">Ton</th><th class="num">% peso</th><th></th></tr></thead><tbody>' +
      orden.map(function (i) {
        var acc = ultimo && cuentas[i]
          ? '<button class="ico" data-sel="' + i + '" title="Seleccionar en el modelo las ' + cuentas[i] + ' piezas en ' + nombres[i] + '">' + ICO_SEL + "</button>" +
            '<button class="ico" data-solo="' + i + '" title="Mostrar solo las piezas en ' + nombres[i] + '">' + ICO_OJO + "</button>"
          : "";
        return '<tr' + (ultimo && !cuentas[i] ? ' class="vacia"' : "") + '><td><span class="sw" style="background:' + colores[i] + '"></span>' +
          nombres[i] + '</td><td class="num">' + (ultimo ? cuentas[i].toLocaleString("es-GT") : "") + '</td><td class="num">' +
          (ultimo ? ton(kgs[i]) : "") + '</td><td class="num">' + (ultimo ? pct(kgs[i]) : "") + '</td><td class="accs">' + acc + "</td></tr>";
      }).join("") +
      (ultimo ? '<tr class="tot"><td>Total en modelo</td><td class="num">' + pzTot.toLocaleString("es-GT") + '</td><td class="num">' + ton(kgTot) +
        '</td><td class="num">100%</td><td class="accs"><button class="ico" id="btnTodo" title="Volver a mostrar todo el modelo">' + ICO_OJO + "</button></td></tr>" : "") +
      "</tbody></table>";
    if (ultimo && kgTot > 0) {
      // lo que ya pasó por cada etapa (lo montado también se armó, pintó y despachó)
      var acum = 0, alc = [], alcPz = [], accPz = 0;
      for (var j = C.etapas.length; j >= 1; j--) { acum += kgs[j]; accPz += cuentas[j]; alc[j - 1] = acum; alcPz[j - 1] = accPz; }
      html += '<div class="tit" style="margin-top:10px">Avance acumulado <span style="font-weight:400;color:#6b7280">(lo que ya pasó por cada etapa)</span></div>' +
        C.etapas.map(function (e, i) {
          var p = 100 * alc[i] / kgTot;
          return '<div class="acum"><span class="en">' + e.nombre + '</span><div class="bar"><span style="width:' + p.toFixed(1) + "%;background:" + e.color +
            '"></span></div><span class="vl">' + p.toFixed(1) + "% · " + ton(alc[i]) + " t · " + alcPz[i] + " pzas</span></div>";
        }).join("");
    }
    if (ultimo) html += '<div class="nota">' + ICO_SEL + " selecciona en el modelo · " + ICO_OJO + " muestra solo esa etapa</div>";
    $("leyenda").innerHTML = html;
    $("encTabla").innerHTML = "<th>Marca</th><th class='num'>Pzas</th><th class='num'>Ton</th>" +
      C.etapas.map(function (e) { return "<th class='num' title='Piezas que ya pasaron por " + e.nombre + "'>" + e.nombre.slice(0, 3) + "</th>"; }).join("") +
      "<th></th>";
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
      var kg = ultimo.cubetas[i].reduce(function (s, x) { return s + (x.peso || 0); }, 0);
      estado((solo ? "Mostrando solo " : "Seleccionadas: ") + nombre + " · " + ultimo.cubetas[i].length + " piezas · " + ton(kg) + " t");
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
  var f0 = leerLocal("fuente") || (C.clientId ? "sp" : "tc");
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
