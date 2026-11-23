// =====================================================================
//  CONFIGURACIÓN - Avance NABLA (extensión de Trimble Connect)
//  Este es el único archivo que normalmente hay que editar.
// =====================================================================
window.CONFIG = {
  // --- SharePoint (lista donde la app de Power Apps guarda los avances) ---
  sharepointHost: "gruponablagt.sharepoint.com",
  sitePath: "/sites/NablaAcero-Produccion",
  listName: "Avance de produccion",

  // Nombres INTERNOS de las columnas de la lista
  // (la columna "Marca" internamente se sigue llamando "Title")
  campos: {
    marca: "Title",
    proyecto: "Proyecto",
    etapa: "Etapa",
    cantidad: "Cantidad"
  },

  // --- Archivo de avance dentro del proyecto de Trimble Connect ---
  // Se toma el archivo más reciente (.xlsx, .xls o .csv) de esta carpeta.
  carpetaProduccion: "5_FAB/5.3_LISTADOS/5.3.4-PRODUCCION",

  // --- Microsoft Entra ID (los da TI después de registrar la aplicación) ---
  // Mientras clientId esté vacío, la extensión solo funciona en modo CSV.
  clientId: "",
  tenantId: "36b8dde3-214e-4d8f-bbfd-c54aae7423b4",
  redirectUri: "https://nablaacero.github.io/avance-nabla/",

  // --- Etapas en orden de avance y su color ---
  etapas: [
    { nombre: "Armado",   color: "#F2C500" },   // amarillo
    { nombre: "Pintura",  color: "#F28C28" },   // naranja
    { nombre: "Despacho", color: "#2E75D6" },   // azul
    { nombre: "Montaje",  color: "#2EAA4A" }    // verde
  ],
  colorSinAvance: "#BDBDBD",          // marcas del modelo sin ningún reporte
  atenuarResto: true,                  // objetos sin marca reconocida -> gris transparente

  // --- Dónde buscar la marca del ensamble en las propiedades del modelo ---
  // Se prueban en este orden. "Product.Name" = nombre del producto IFC.
  propiedadesMarca: [
    "Tekla Assembly.Assembly/Cast unit Mark",
    "Tekla Assembly.ASSEMBLY_POS",
    "Assembly.ASSEMBLY_POS",
    "Part Properties.Assembly Mark",
    "Nabla Aceros.MainPartMark",
    "Nabla Aceros.Main Part",
    "Nabla Aceros.Marca",
    "Identity Data.Mark",
    "Product.Name"          // solo en objetos ensamble
  ],

  // Dónde buscar el peso (kg). Si el ensamble no lo trae, se suman sus piezas.
  propiedadesPeso: [
    "Assembly.WEIGHT",
    "Tekla Assembly.Weight",
    "Nabla Aceros.WeightNet_kg",
    "Tekla Common.Weight",
    "Part Properties.Weight"
  ],

  // Número de proyecto: se toma de los primeros dígitos del nombre del proyecto
  // de Trimble Connect (ej. "1256 Amatitlán" -> 1256). Se puede cambiar en el panel.
  patronProyecto: "^\\s*(\\d{3,5})",

  // Prefijos de marca que se ocultan con la casilla "Ocultar secundarios"
  // (se toma la parte en letras antes del número final: CT8001 -> CT, AL-2CF5 -> CF)
  // CT/CF costaneras · BC bracones · GT canal pluvial · TS tensores
  prefijosOcultables: ["CT", "CF", "BC", "GT", "TS"],
  // Grupos del proyecto de Trimble Connect que NO pueden usar la extensión
  // (mismo nombre que en Equipo → Grupos; no importan mayúsculas ni tildes)
  gruposBloqueados: ["EXTERNO"],

  // true = la misma casilla también oculta tornillos, tuercas y arandelas
  ocultarTornillos: true,

  // Actualización automática mientras el panel está abierto (minutos, 0 = no)
  autoActualizarMin: 5
};
