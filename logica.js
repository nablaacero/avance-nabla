// Lógica pura (sin dependencias de Trimble Connect) para poder probarla aparte.
(function (raiz) {
  "use strict";

  function normalizarMarca(m) {
    if (m === undefined || m === null) return "";
    return String(m).replace(/\(\?\)/g, "").trim().toUpperCase();
  }

  function normalizarEtapa(e, etapas) {
    var t = String(e || "").trim().toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (var i = 0; i < etapas.length; i++) {
      var n = etapas[i].nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (t === n) return i;
    }
    return -1;
  }

  // Busca la marca de un objeto de Trimble Connect según la lista de propiedades candidatas
  function marcaDeObjeto(obj, candidatos) {
    for (var c = 0; c < candidatos.length; c++) {
      var cand = candidatos[c];
      var p = cand.indexOf(".");
      var set = cand.slice(0, p), prop = cand.slice(p + 1);
      if (set === "Product") {
        // el nombre de producto solo se usa en objetos ensamble (en las piezas es "BEAM", "PLATE"…)
        if (String(obj.class || "").toUpperCase().indexOf("ASSEMBLY") < 0) continue;
        var pv = obj.product && obj.product[prop.charAt(0).toLowerCase() + prop.slice(1)];
        // una marca debe tener al menos una letra (descarta nombres como "-10033")
        if (pv && /[A-Za-z]/.test(String(pv))) return normalizarMarca(pv);
        continue;
      }
      var sets = obj.properties || [];
      for (var s = 0; s < sets.length; s++) {
        if ((sets[s].name || "").toLowerCase() !== set.toLowerCase()) continue;
        var props = sets[s].properties || [];
        for (var k = 0; k < props.length; k++) {
          if ((props[k].name || "").toLowerCase() === prop.toLowerCase() && props[k].value !== "" && props[k].value !== null &&
              /[A-Za-z]/.test(String(props[k].value))) {
            return normalizarMarca(props[k].value);
          }
        }
      }
    }
    return "";
  }

  // Suma lo reportado por marca y etapa para un proyecto.
  // filas: [{marca, proyecto, etapa, cantidad}]
  function sumarAvance(filas, proyecto, etapas) {
    var res = {};
    var proy = String(proyecto || "").trim();
    filas.forEach(function (f) {
      if (proy && String(f.proyecto || "").trim() !== proy) return;
      var m = normalizarMarca(f.marca);
      var e = normalizarEtapa(f.etapa, etapas);
      var q = Number(String(f.cantidad || "0").replace(",", "."));
      if (!m || e < 0 || !isFinite(q)) return;
      if (!res[m]) res[m] = etapas.map(function () { return 0; });
      res[m][e] += q;
    });
    return res;
  }

  // Para una marca con 'total' piezas y sumas por etapa, devuelve cuántas piezas
  // quedan en cada etapa como máxima alcanzada: [sinAvance, etapa0, etapa1, ...]
  // Regla: lo que llegó a una etapa posterior también pasó por las anteriores.
  function repartir(total, sumas) {
    var n = sumas.length;
    var alc = sumas.map(function (q) { return Math.max(0, Math.min(total, Math.round(q))); });
    for (var i = n - 2; i >= 0; i--) alc[i] = Math.max(alc[i], alc[i + 1]);
    var out = [total - alc[0]];
    for (var j = 0; j < n; j++) out.push(alc[j] - (j + 1 < n ? alc[j + 1] : 0));
    return out;
  }

  // CSV -> matriz de celdas (separador , o ;, comillas)
  function tokenizarCSV(texto) {
    texto = String(texto).replace(/^\uFEFF/, "");
    var primera = texto.split(/\r?\n/)[0] || "";
    var sep = (primera.split(";").length > primera.split(",").length) ? ";" : ",";
    var filas = [], fila = [], campo = "", comillas = false;
    for (var i = 0; i < texto.length; i++) {
      var ch = texto[i];
      if (comillas) {
        if (ch === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
        } else campo += ch;
      } else if (ch === '"') comillas = true;
      else if (ch === sep) { fila.push(campo); campo = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && texto[i + 1] === "\n") i++;
        fila.push(campo); campo = ""; filas.push(fila); fila = [];
      } else campo += ch;
    }
    if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
    return filas;
  }

  function norm(h) {
    return String(h === undefined || h === null ? "" : h).trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  }

  // Columnas que representan una etapa en un listado "por columnas" (ej. Enviadas = Despacho)
  var SINONIMOS = [
    { etapa: "Armado",   re: /^(armad|armado)/ },
    { etapa: "Pintura",  re: /^(pintad|pintura)/ },
    { etapa: "Despacho", re: /^(enviad|despach)/ },
    { etapa: "Montaje",  re: /^(montad|montaje)/ }
  ];

  // Matriz (CSV o Excel) -> [{marca, proyecto, etapa, cantidad}]
  // Acepta: (A) exportación de la lista (Marca, Proyecto, Etapa, Cantidad)
  //         (B) listado por columnas: Orden Pieza / Marca + columnas Enviadas, Montadas, etc.
  function leerTabla(m) {
    var limite = Math.min(m.length, 25);
    for (var r = 0; r < limite; r++) {
      var enc = (m[r] || []).map(norm);
      var col = function (nombres) {
        for (var a = 0; a < nombres.length; a++) { var k = enc.indexOf(nombres[a]); if (k >= 0) return k; }
        return -1;
      };
      var cM = col(["marca", "titulo", "title", "orden pieza", "ensamble", "marca ensamble", "assembly mark"]);
      if (cM < 0) continue;
      var cP = col(["proyecto", "codigo", "project"]);
      var cE = col(["etapa"]), cQ = col(["cantidad"]);
      var cO = col(["observaciones", "observacion", "envio", "no. envio", "numero de envio"]);
      var cW = col(["peso uni", "peso unitario", "peso uni.", "peso (kg)", "peso kg"]);
      var datos = m.slice(r + 1).filter(function (f) {
        var v = norm(f && f[cM]); return v && v !== "totales" && v !== "total";
      });
      var limpiar = function (marca, proy) {
        var t = String(marca).trim();
        var p = String(proy || "").trim();
        if (p && t.indexOf(p + "-") === 0) t = t.slice(p.length + 1);
        else { var mm = t.match(/^(\d{3,5})-(.+)$/); if (mm) { t = mm[2]; if (!p) p = mm[1]; } }
        return { marca: t, proyecto: p };
      };
      if (cE >= 0 && cQ >= 0) {
        return datos.map(function (f) {
          var x = limpiar(f[cM], cP >= 0 ? f[cP] : "");
          var env = cO >= 0 ? numeroEnvio(f[cO]) : "";
          return { marca: x.marca, proyecto: x.proyecto, etapa: f[cE], cantidad: f[cQ], envio: env };
        });
      }
      // columnas de envío: encabezado = número correlativo (ej. 6304) o "Envío 6304"
      var colsEnvio = [];
      (m[r] || []).forEach(function (h, i) {
        var t = String(h === undefined || h === null ? "" : h).trim();
        var mm = t.match(/^(?:env[ií]o\s*(?:n[o°º.]*\s*)?)?(\d{3,7})$/i);
        if (mm && i !== cM && i !== cP) colsEnvio.push({ i: i, envio: mm[1] });
      });
      var colsEtapa = [];
      enc.forEach(function (h, i) {
        if (!h || /peso|pendiente|kg|ton/.test(h)) return;
        SINONIMOS.forEach(function (s) {
          // si hay columnas por envío, el despacho sale de ellas (no de "Enviadas", que es su suma)
          if (s.re.test(h) && !(colsEnvio.length && s.etapa === "Despacho")) colsEtapa.push({ i: i, etapa: s.etapa });
        });
      });
      if (!colsEtapa.length && !colsEnvio.length) continue;
      var out = [];
      var num = function (v) { return Number(String(v === undefined || v === null ? "" : v).replace(",", ".")); };
      datos.forEach(function (f) {
        var x = limpiar(f[cM], cP >= 0 ? f[cP] : "");
        var pu = cW >= 0 ? num(f[cW]) : NaN;
        colsEnvio.forEach(function (c) {
          var q = num(f[c.i]);
          if (q > 0) out.push({ marca: x.marca, proyecto: x.proyecto, etapa: "Despacho", cantidad: q, envio: c.envio, pesoUni: pu > 0 ? pu : 0 });
        });
        colsEtapa.forEach(function (c) {
          var q = num(f[c.i]);
          if (q > 0) out.push({ marca: x.marca, proyecto: x.proyecto, etapa: c.etapa, cantidad: q, pesoUni: pu > 0 ? pu : 0 });
        });
      });
      return out;
    }
    throw new Error("No reconozco el formato: necesito columnas Marca/Etapa/Cantidad, o una columna de marca (ej. «Orden Pieza») con columnas Enviadas, Montadas, etc.");
  }

  function leerCSV(texto) { return leerTabla(tokenizarCSV(texto)); }

  // "Envío 6324" / "6324" / "Env. No. 6324" -> "6324"
  function numeroEnvio(v) {
    var m = String(v === undefined || v === null ? "" : v).match(/(?:^|env[ií]o\D{0,6})(\d{3,7})\b/i);
    return m ? m[1] : "";
  }

  // Envíos por marca: { marca: [{envio, q}] } en orden correlativo, y lista de envíos ordenada
  function sumarEnvios(filas, proyecto) {
    var proy = String(proyecto || "").trim(), por = {}, todos = {}, peso = {};
    filas.forEach(function (f) {
      if (!f.envio) return;
      if (proy && String(f.proyecto || "").trim() !== proy) return;
      var m = normalizarMarca(f.marca), q = Number(String(f.cantidad || "0").replace(",", "."));
      if (!m || !(q > 0)) return;
      var k = (por[m] = por[m] || {});
      k[f.envio] = (k[f.envio] || 0) + q;
      todos[f.envio] = 1;
      if (f.pesoUni > 0) peso[m] = f.pesoUni;
    });
    var orden = function (a, b) { return Number(a) - Number(b) || (a < b ? -1 : 1); };
    var envios = Object.keys(todos).sort(orden);
    var res = {};
    Object.keys(por).forEach(function (m) {
      res[m] = Object.keys(por[m]).sort(orden).map(function (e) { return { envio: e, q: por[m][e] }; });
    });
    return { porMarca: res, envios: envios, pesoUni: peso };
  }

  // Color de cada envío: escala de azul claro (más antiguo) a azul oscuro (más reciente)
  function colorEnvio(k, n) {
    var a = [191, 215, 245], b = [11, 46, 107], t = n > 1 ? k / (n - 1) : 1;
    var h = function (x) { return ("0" + Math.round(x).toString(16)).slice(-2); };
    return "#" + h(a[0] + (b[0] - a[0]) * t) + h(a[1] + (b[1] - a[1]) * t) + h(a[2] + (b[2] - a[2]) * t);
  }

  // "#2EAA4A" -> {r,g,b,a} opaco (Trimble Connect conserva la transparencia anterior si se manda solo el hex)
  function rgba(hex, a) {
    var h = String(hex).replace("#", "");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: a === undefined ? 255 : a };
  }

  function aNumero(v) {
    if (typeof v === "number") return v;
    var m = String(v || "").replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(",", ".")) : NaN;
  }

  // Peso (kg) de un objeto: primero propiedades de la lista, luego "… | 1366.7 kg" en la descripción
  function pesoDeObjeto(obj, candidatos) {
    for (var c = 0; c < candidatos.length; c++) {
      var cand = candidatos[c], p = cand.indexOf(".");
      var set = cand.slice(0, p), prop = cand.slice(p + 1);
      var sets = obj.properties || [];
      for (var s = 0; s < sets.length; s++) {
        if ((sets[s].name || "").toLowerCase() !== set.toLowerCase()) continue;
        var props = sets[s].properties || [];
        for (var k = 0; k < props.length; k++) {
          if ((props[k].name || "").toLowerCase() === prop.toLowerCase()) {
            var v = aNumero(props[k].value);
            if (isFinite(v) && v > 0) return v;
          }
        }
      }
    }
    var d = obj.product && obj.product.description;
    var m = d && String(d).match(/([\d.,]+)\s*kg/i);
    if (m) { var w = aNumero(m[1]); if (isFinite(w) && w > 0) return w; }
    return 0;
  }

  var api = { rgba: rgba, pesoDeObjeto: pesoDeObjeto, normalizarMarca: normalizarMarca, normalizarEtapa: normalizarEtapa, marcaDeObjeto: marcaDeObjeto,
              sumarAvance: sumarAvance, repartir: repartir, sumarEnvios: sumarEnvios, colorEnvio: colorEnvio, numeroEnvio: numeroEnvio, leerCSV: leerCSV, leerTabla: leerTabla, tokenizarCSV: tokenizarCSV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.Logica = api;
})(this);
