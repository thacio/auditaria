// node_modules/scribe.js-ocr/mupdf/mupdf-worker.js
var parentPort = typeof process === "undefined" ? globalThis : (await import("node:worker_threads")).parentPort;
if (!parentPort) throw new Error("This file must be run in a worker");
function arrayBufferToBase64(arrayBuffer) {
  let base64 = "";
  const encodings = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(arrayBuffer);
  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;
  let a;
  let b;
  let c;
  let d;
  let chunk;
  for (let i = 0; i < mainLength; i += 3) {
    chunk = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    a = (chunk & 16515072) >> 18;
    b = (chunk & 258048) >> 12;
    c = (chunk & 4032) >> 6;
    d = chunk & 63;
    base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d];
  }
  if (byteRemainder == 1) {
    chunk = bytes[mainLength];
    a = (chunk & 252) >> 2;
    b = (chunk & 3) << 4;
    base64 += `${encodings[a] + encodings[b]}==`;
  } else if (byteRemainder == 2) {
    chunk = bytes[mainLength] << 8 | bytes[mainLength + 1];
    a = (chunk & 64512) >> 10;
    b = (chunk & 1008) >> 4;
    c = (chunk & 15) << 2;
    base64 += `${encodings[a] + encodings[b] + encodings[c]}=`;
  }
  return base64;
}
var mupdf = {};
var ready = false;
if (typeof process === "object") {
  globalThis.self = globalThis;
  const { createRequire } = await import("node:module");
  globalThis.require = createRequire(import.meta.url);
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  globalThis.__dirname = dirname(fileURLToPath(import.meta.url));
}
var { Module, FS } = await import("./libmupdf.js");
globalThis.Module = Module;
globalThis.FS = FS;
var wasm_pageText0;
var wasm_checkNativeText;
var wasm_extractAllFonts;
var wasm_pdfSaveDocument;
var wasm_runPDF;
var wasm_convertImageStart;
var wasm_convertImageAddPage;
var wasm_convertImageEnd;
Module.onRuntimeInitialized = function() {
  Module.ccall("initContext");
  mupdf.openDocumentFromBuffer = Module.cwrap("openDocumentFromBuffer", "number", ["string", "number", "number"]);
  mupdf.freeDocument = Module.cwrap("freeDocument", "null", ["number"]);
  mupdf.documentTitle = Module.cwrap("documentTitle", "string", ["number"]);
  mupdf.countPages = Module.cwrap("countPages", "number", ["number"]);
  mupdf.pageWidth = Module.cwrap("pageWidth", "number", ["number", "number", "number"]);
  mupdf.pageHeight = Module.cwrap("pageHeight", "number", ["number", "number", "number"]);
  mupdf.pageLinksJSON = Module.cwrap("pageLinks", "string", ["number", "number", "number"]);
  mupdf.doDrawPageAsPNG = Module.cwrap("doDrawPageAsPNG", "null", ["number", "number", "number", "number"]);
  mupdf.doDrawPageAsPNGGray = Module.cwrap("doDrawPageAsPNGGray", "null", ["number", "number", "number", "number"]);
  wasm_convertImageStart = Module.cwrap("convertImageStart", "null", ["number"]);
  wasm_convertImageAddPage = Module.cwrap("convertImageAddPage", "null", ["number", "number", "number", "number", "number"]);
  wasm_convertImageEnd = Module.cwrap("convertImageEnd", "null", ["number"]);
  wasm_runPDF = Module.cwrap("runPDF", "null", ["number", "number", "number", "number", "number", "number", "number"]);
  wasm_pdfSaveDocument = Module.cwrap("pdfSaveDocument", "null", ["number", "number", "number", "number", "number", "number", "number", "number"]);
  mupdf.getLastDrawData = Module.cwrap("getLastDrawData", "number", []);
  mupdf.getLastDrawSize = Module.cwrap("getLastDrawSize", "number", []);
  wasm_extractAllFonts = Module.cwrap("extractAllFonts", "number", ["number"]);
  wasm_pageText0 = Module.cwrap("pageText", "PageTextResults", ["number", "number", "number", "number", "number", "number", "number"]);
  mupdf.overlayDocuments = Module.cwrap("pdfOverlayDocuments", "null", ["number", "number"]);
  mupdf.subsetPages = Module.cwrap("pdfSubsetPages", "null", ["number", "number", "number"]);
  mupdf.searchJSON = Module.cwrap("search", "string", ["number", "number", "number", "string"]);
  mupdf.loadOutline = Module.cwrap("loadOutline", "number", ["number"]);
  mupdf.freeOutline = Module.cwrap("freeOutline", null, ["number"]);
  mupdf.outlineTitle = Module.cwrap("outlineTitle", "string", ["number"]);
  mupdf.outlinePage = Module.cwrap("outlinePage", "number", ["number", "number"]);
  mupdf.outlineDown = Module.cwrap("outlineDown", "number", ["number"]);
  mupdf.outlineNext = Module.cwrap("outlineNext", "number", ["number"]);
  wasm_checkNativeText = Module.cwrap("checkNativeText", "number", ["number", "number"]);
  mupdf.writeDocument = Module.cwrap("writeDocument", "null", []);
  parentPort.postMessage("READY");
  ready = true;
};
if (Module.calledRun && !ready) {
  Module.onRuntimeInitialized();
}
mupdf.save = function(doc, {
  doc1,
  minpage = 0,
  maxpage = -1,
  pagewidth = -1,
  pageheight = -1,
  humanReadable = false,
  skipTextInvis = false,
  delGarbage = true
}) {
  wasm_pdfSaveDocument(doc1, minpage, maxpage, pagewidth, pageheight, humanReadable, skipTextInvis, delGarbage);
  const content = FS.readFile("/download.pdf");
  FS.unlink("/download.pdf");
  return content;
};
mupdf.pageText = function(doc, {
  page,
  dpi = 72,
  format = "text",
  skipTextInvis = false,
  calcStats = false
}) {
  const formatCode = {
    txt: 0,
    text: 0,
    html: 1,
    xhtml: 2,
    xml: 3,
    json: 4
  }[format];
  const structPtr = wasm_pageText0(doc, page, dpi, formatCode, skipTextInvis, calcStats, true);
  const letterCountTotal = Module.getValue(structPtr, "i32");
  const letterCountVis = Module.getValue(structPtr + 4, "i32");
  const dataPtr = Module.getValue(structPtr + 8, "i32");
  const content = Module.UTF8ToString(dataPtr);
  Module._free(dataPtr);
  return {
    letterCountTotal,
    letterCountVis,
    content
  };
};
mupdf.extractAllFonts = function(doc) {
  const fontCount = wasm_extractAllFonts(doc);
  const fontArr = [];
  for (let i = 0; i < fontCount; i++) {
    const fontFile = `font-${String(i + 1).padStart(4, "0")}.ttf`;
    fontArr.push(FS.readFile(fontFile));
    FS.unlink(fontFile);
  }
  return fontArr;
};
mupdf.checkNativeText = function(doc) {
  return wasm_checkNativeText(doc, false);
};
mupdf.detectExtractText = function(doc) {
  const res = wasm_checkNativeText(doc, true);
  let text = FS.readFile("/download.txt", { encoding: "utf8" });
  if (typeof text === "string") {
    text = text.replace(/(\n\s*){3,}/g, "\n\n").trim();
  }
  FS.unlink("/download.txt");
  const type = ["Text native", "Image + OCR text", "Image native"][res];
  return {
    type,
    text
  };
};
mupdf.cleanFile = function(data) {
  FS.writeFile("test_1.pdf", data);
  mupdf.writeDocument();
  const content = FS.readFile("/test_2.pdf");
  FS.unlink("/test_1.pdf");
  FS.unlink("/test_2.pdf");
  return content;
};
mupdf.convertImageStart = function(doc, { humanReadable = false }) {
  wasm_convertImageStart(humanReadable);
};
mupdf.convertImageAddPage = function(doc, {
  image,
  i,
  pagewidth,
  pageheight,
  angle = 0
}) {
  const imgData = new Uint8Array(atob(image.split(",")[1]).split("").map((c) => c.charCodeAt(0)));
  Module.FS_createDataFile("/", `${String(i)}.png`, imgData, 1, 1, 1);
  wasm_convertImageAddPage(i, pagewidth, pageheight, angle);
  FS.unlink(`${String(i)}.png`);
};
mupdf.convertImageEnd = function() {
  wasm_convertImageEnd();
  const content = FS.readFile("/download.pdf");
  FS.unlink("/download.pdf");
  return content;
};
mupdf.run = function(doc, {
  doc1,
  minpage = 0,
  maxpage = -1,
  pagewidth = -1,
  pageheight = -1,
  humanReadable = false
}) {
  wasm_runPDF(doc1, minpage, maxpage, pagewidth, pageheight, humanReadable);
  const content = FS.readFile("/download.pdf");
  FS.unlink("/download.pdf");
  return content;
};
mupdf.openDocument = function(data, magic) {
  const n = data.byteLength;
  const ptr = Module._malloc(n);
  const src = new Uint8Array(data);
  Module.HEAPU8.set(src, ptr);
  return mupdf.openDocumentFromBuffer(magic, ptr, n);
};
mupdf.drawPageAsPNG = function(doc, {
  page,
  dpi,
  color = true,
  skipText = false
}) {
  if (color) {
    mupdf.doDrawPageAsPNG(doc, page, dpi, skipText);
  } else {
    mupdf.doDrawPageAsPNGGray(doc, page, dpi, skipText);
  }
  const n = mupdf.getLastDrawSize();
  const p = mupdf.getLastDrawData();
  return `data:image/png;base64,${arrayBufferToBase64(Module.HEAPU8.buffer.slice(p, p + n))}`;
};
mupdf.documentOutline = function(doc) {
  function makeOutline(node) {
    const list = [];
    while (node) {
      const entry = {
        title: mupdf.outlineTitle(node),
        page: mupdf.outlinePage(doc, node)
      };
      const down = mupdf.outlineDown(node);
      if (down) entry.down = makeOutline(down);
      list.push(entry);
      node = mupdf.outlineNext(node);
    }
    return list;
  }
  const root = mupdf.loadOutline(doc);
  if (root) {
    let list = null;
    try {
      list = makeOutline(root);
    } finally {
      mupdf.freeOutline(root);
    }
    return list;
  }
  return null;
};
mupdf.pageSizes = function(doc, dpi) {
  const list = [];
  const n = mupdf.countPages(doc);
  for (let i = 1; i <= n; ++i) {
    const w = mupdf.pageWidth(doc, i, dpi);
    const h = mupdf.pageHeight(doc, i, dpi);
    list[i] = [w, h];
  }
  return list;
};
mupdf.pageLinks = function(doc, page, dpi) {
  return JSON.parse(mupdf.pageLinksJSON(doc, page, dpi));
};
mupdf.search = function(doc, page, dpi, needle) {
  return JSON.parse(mupdf.searchJSON(doc, page, dpi, needle));
};
var handleMessage = (data) => {
  const [func, args, id] = data;
  if (!ready) {
    parentPort.postMessage(["ERROR", id, { name: "NotReadyError", message: "WASM module is not ready yet" }]);
    return;
  }
  try {
    const result = mupdf[func](...args);
    if (result instanceof ArrayBuffer) parentPort.postMessage(["RESULT", id, result], [result]);
    else if (result?.buffer instanceof ArrayBuffer) {
      parentPort.postMessage(["RESULT", id, result], [result.buffer]);
    } else parentPort.postMessage(["RESULT", id, result]);
  } catch (error) {
    parentPort.postMessage(["ERROR", id, { name: error.name, message: error.message }]);
  }
};
if (typeof process === "undefined") {
  onmessage = (event) => handleMessage(event.data);
} else {
  parentPort.on("message", handleMessage);
}
export {
  mupdf
};
