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

  // Lector de CSV exportado de SharePoint (separador , o ;, comillas)
  function leerCSV(texto) {
    texto = texto.replace(/^﻿/, "");
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
        fila.push(campo); campo = "";
        if (fila.some(function (x) { return x.trim() !== ""; })) filas.push(fila);
        fila = [];
      } else campo += ch;
    }
    if (campo !== "" || fila.length) { fila.push(campo); if (fila.some(function (x) { return x.trim() !== ""; })) filas.push(fila); }
    if (!filas.length) return [];
    var enc = filas[0].map(function (h) {
      return h.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    });
    function col(nombres) {
      for (var a = 0; a < nombres.length; a++) { var k = enc.indexOf(nombres[a]); if (k >= 0) return k; }
      return -1;
    }
    var cM = col(["marca", "titulo", "title"]), cP = col(["proyecto"]), cE = col(["etapa"]), cQ = col(["cantidad"]);
    if (cM < 0 || cE < 0 || cQ < 0) throw new Error("El CSV debe tener columnas Marca, Etapa y Cantidad (y Proyecto).");
    return filas.slice(1).map(function (r) {
      return { marca: r[cM], proyecto: cP >= 0 ? r[cP] : "", etapa: r[cE], cantidad: r[cQ] };
    });
  }

  // "#2EAA4A" -> {r,g,b,a} opaco (Trimble Connect conserva la transparencia anterior si se manda solo el hex)
  function rgba(hex, a) {
    var h = String(hex).replace("#", "");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: a === undefined ? 255 : a };
  }

  var api = { rgba: rgba, normalizarMarca: normalizarMarca, normalizarEtapa: normalizarEtapa, marcaDeObjeto: marcaDeObjeto,
              sumarAvance: sumarAvance, repartir: repartir, leerCSV: leerCSV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.Logica = api;
})(this);
