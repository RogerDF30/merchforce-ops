/**
 * Merchforce Ops — product decks.
 *
 * Staff pick products, the backend produces a PDF and a PPTX carrying image,
 * specs, MOQ, price tiers and current stock, under the company identity from
 * Settings. Both are built HERE, not in the browser: product images live on
 * other origins the browser cannot read pixels from, while UrlFetchApp can.
 *
 * PPTX is a zip of OOXML parts. The part templates were lifted from the
 * Supplier HUB demo (validated against python-pptx and LibreOffice) and are
 * assembled with Utilities.zip. PDF is HTML rendered by the same path as the
 * proforma invoice, with images embedded as data URIs so nothing depends on
 * the renderer fetching remote files.
 */

var XW = 12192000, XH = 6858000;                      // 16:9 in EMU
function EMU_(inches) { return Math.round(inches * 914400); }
function xesc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/* ---------------- images ---------------- */

/** Fetch an image once per build; returns {bytes, ext, w, h, b64} or null. */
function fetchImage_(url, cache) {
  if (!url) return null;
  if (cache[url] !== undefined) return cache[url];
  var out = null;
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() === 200) {
      var bytes = res.getContent();
      var dims = imageDims_(bytes);
      if (dims) {
        out = { bytes: bytes, ext: dims.ext, w: dims.w, h: dims.h,
                b64: Utilities.base64Encode(bytes), mime: dims.ext === 'png' ? 'image/png' : 'image/jpeg' };
      }
    }
  } catch (e) { /* a missing image must not sink the deck */ }
  cache[url] = out;
  return out;
}

/** PNG and JPEG dimensions from the header. Anything else is refused: PowerPoint would not render it. */
function imageDims_(bytes) {
  function u(i) { return bytes[i] & 0xff; }
  if (bytes.length > 24 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4e && u(3) === 0x47) {
    return { ext: 'png', w: (u(16) << 24 | u(17) << 16 | u(18) << 8 | u(19)) >>> 0, h: (u(20) << 24 | u(21) << 16 | u(22) << 8 | u(23)) >>> 0 };
  }
  if (bytes.length > 4 && u(0) === 0xff && u(1) === 0xd8) {
    var i = 2;
    while (i < bytes.length - 9) {
      if (u(i) !== 0xff) { i++; continue; }
      var m = u(i + 1);
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      var len = (u(i + 2) << 8) | u(i + 3);
      if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        return { ext: 'jpg', w: (u(i + 7) << 8) | u(i + 8), h: (u(i + 5) << 8) | u(i + 6) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Contain an image inside a box, centred. All EMU. */
function fitBox_(img, x, y, w, h) {
  if (!img || !img.w || !img.h) return { x: x, y: y, w: w, h: h };
  var r = Math.min(w / img.w, h / img.h);
  var dw = Math.round(img.w * r), dh = Math.round(img.h * r);
  return { x: x + Math.round((w - dw) / 2), y: y + Math.round((h - dh) / 2), w: dw, h: dh };
}

/* ---------------- deck content ---------------- */

function deckProducts_(skus) {
  var tiers = {};
  readRows_('PriceTiers').forEach(function (t) {
    var k = skuKey_(t.sku);
    (tiers[k] = tiers[k] || []).push({ min: toNum_(t.min_qty), price: toNum_(t.unit_price) });
  });
  var brands = {};
  readRows_('Brands').forEach(function (b) { brands[b.brand_id] = b.name; });
  var byKey = {};
  readRows_('Products').forEach(function (r) { byKey[skuKey_(r.sku)] = r; });

  return skus.map(function (sku) {
    var r = byKey[skuKey_(sku)];
    if (!r) return null;
    return {
      sku: String(r.sku), name: r.name, brand: brands[r.brand_id] || r.brand_id || '',
      category: r.category, description: String(r.description || ''),
      specs: String(r.specs || '').split('|').map(function (s) { return s.trim(); }).filter(String),
      image: String(r.image_urls || '').split('|').filter(String)[0] || '',
      moq: toNum_(r.moq) || 1, gst: toNum_(r.gst_rate), hsn: String(r.hsn || ''),
      lead_time: r.lead_time || '', mrp: toNum_(r.mrp) || 0, atp: atp_(r),
      tiers: (tiers[skuKey_(r.sku)] || []).sort(function (a, b) { return a.min - b.min; })
    };
  }).filter(Boolean);
}

function inr_(n) { return '₹' + Math.round(toNum_(n)).toLocaleString('en-IN'); }

/* ---------------- theme ---------------- */

/** Colours and layout come from Settings so the supplier can brand the decks. */
function hex6_(v, fallback) {
  var m = String(v || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(m) ? m.toUpperCase() : fallback;
}
function deckTheme_(s) {
  return {
    accent: hex6_(s.deck_accent, '2447F5'),
    ink: hex6_(s.deck_ink, '1D1D1F'),
    muted: hex6_(s.deck_muted, '6E6E73'),
    plate: hex6_(s.deck_plate, 'F5F5F7'),
    line: 'E5E5EA', ok: '248A3D', warn: 'B25000',
    layout: s.deck_layout === 'spacious' ? 'spacious' : 'compact'
  };
}
function clip_(str, n) { str = String(str || ''); return str.length > n ? str.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : str; }
function fromPrice_(p) { return p.tiers.length ? p.tiers[0].price : 0; }
function stockText_(p) { return p.atp > 0 ? 'In stock · ' + p.atp.toLocaleString('en-IN') + ' available' : 'Made to order'; }
function factsText_(p) { return 'MOQ ' + p.moq + (p.lead_time ? '   ·   Lead time ' + p.lead_time : '') + '   ·   GST ' + p.gst + '%'; }

/* ---------------- PPTX ---------------- */

var PPT_FONT_ = 'Arial';
function pptPara_(p) {
  var rPr = '<a:rPr lang="en-IN" sz="' + (p.sz || 1400) + '" b="' + (p.b ? 1 : 0) + '" dirty="0"><a:solidFill><a:srgbClr val="' + (p.col || '1D1D1F') + '"/></a:solidFill><a:latin typeface="' + PPT_FONT_ + '"/><a:cs typeface="' + PPT_FONT_ + '"/></a:rPr>';
  var pPr = '<a:pPr' + (p.align ? ' algn="' + p.align + '"' : '') + '>' +
    '<a:lnSpc><a:spcPct val="' + (p.lh || 110000) + '"/></a:lnSpc>' +
    (p.sp ? '<a:spcAft><a:spcPts val="' + p.sp + '"/></a:spcAft>' : '') + '</a:pPr>';
  if (!p.t) return '<a:p>' + pPr + '<a:endParaRPr lang="en-IN" sz="' + (p.sz || 1400) + '"/></a:p>';
  return '<a:p>' + pPr + '<a:r>' + rPr + '<a:t>' + xesc_(p.t) + '</a:t></a:r></a:p>';
}
function txSp_(id, x, y, w, h, paras, anchor) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="tx' + id + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"' + (anchor ? ' anchor="' + anchor + '"' : '') + '><a:normAutofit/></a:bodyPr><a:lstStyle/>' + paras.map(pptPara_).join('') + '</p:txBody></p:sp>';
}
function rectSp_(id, x, y, w, h, color, radius) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="rc' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm>' +
    (radius === 0 ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ' + (radius || 6000) + '"/></a:avLst></a:prstGeom>') +
    '<a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
}
function picSp_(id, rid, x, y, w, h) {
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="im' + id + '"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
/**
 * A real table (a:tbl). rows: [[cell,...]] where cell = {t, sz, b, col, align}.
 * Header row gets a bottom rule; body rows a hairline. Column widths in EMU.
 */
function tblSp_(id, x, y, colW, rows, T, rowH) {
  rowH = rowH || EMU_(.26);
  function tc(c, isHead) {
    c = c || {};
    return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
      pptPara_({ t: c.t, sz: c.sz || 1000, b: c.b, col: c.col || T.ink, align: c.align, lh: 100000 }) +
      '</a:txBody><a:tcPr marL="45720" marR="45720" marT="27432" marB="27432" anchor="ctr">' +
      '<a:lnL><a:noFill/></a:lnL><a:lnR><a:noFill/></a:lnR><a:lnT><a:noFill/></a:lnT>' +
      '<a:lnB w="' + (isHead ? 12700 : 6350) + '"><a:solidFill><a:srgbClr val="' + (isHead ? T.ink : T.line) + '"/></a:solidFill></a:lnB>' +
      '<a:noFill/></a:tcPr></a:tc>';
  }
  var total = colW.reduce(function (a, b) { return a + b; }, 0);
  return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="tb' + id + '"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + total + '" cy="' + (rowH * rows.length) + '"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>' +
    colW.map(function (w) { return '<a:gridCol w="' + w + '"/>'; }).join('') + '</a:tblGrid>' +
    rows.map(function (r, i) { return '<a:tr h="' + rowH + '">' + r.map(function (c) { return tc(c, i === 0); }).join('') + '</a:tr>'; }).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
}
function slideXml_(shapes) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + shapes +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
function pptTheme_(T) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Ops"><a:themeElements>' +
  '<a:clrScheme name="Ops"><a:dk1><a:srgbClr val="' + T.ink + '"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="' + T.muted + '"/></a:dk2><a:lt2><a:srgbClr val="' + T.plate + '"/></a:lt2><a:accent1><a:srgbClr val="' + T.accent + '"/></a:accent1><a:accent2><a:srgbClr val="248A3D"/></a:accent2><a:accent3><a:srgbClr val="B25000"/></a:accent3><a:accent4><a:srgbClr val="D70015"/></a:accent4><a:accent5><a:srgbClr val="8A5A10"/></a:accent5><a:accent6><a:srgbClr val="00A3B4"/></a:accent6><a:hlink><a:srgbClr val="' + T.accent + '"/></a:hlink><a:folHlink><a:srgbClr val="' + T.muted + '"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Ops"><a:majorFont><a:latin typeface="' + PPT_FONT_ + '"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="' + PPT_FONT_ + '"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Ops"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements></a:theme>';
}

/** Price tiers as a table: one column per tier, header "25+ units", value the price. */
function tierTable_(id, x, y, width, p, T, big) {
  if (!p.tiers.length) return '';
  var tiers = p.tiers.slice(0, 4);
  var w = Math.floor(width / tiers.length);
  return tblSp_(id, x, y, tiers.map(function () { return w; }), [
    tiers.map(function (t) { return { t: t.min.toLocaleString('en-IN') + '+ units', sz: big ? 900 : 800, col: T.muted }; }),
    tiers.map(function (t) { return { t: inr_(t.price), sz: big ? 1400 : 1200, b: 1 }; })
  ], T, big ? EMU_(.3) : EMU_(.26));
}

/** Header and footer chrome shared by every content slide. */
function chrome_(coName, deckName, T, page, pages, footNote) {
  return rectSp_(90, 0, 0, XW, EMU_(.05), T.accent, 0) +
    txSp_(91, EMU_(.6), EMU_(.32), EMU_(6), EMU_(.3), [{ t: coName.toUpperCase(), sz: 850, b: 1, col: T.muted }]) +
    txSp_(92, EMU_(6.7), EMU_(.32), EMU_(6.03), EMU_(.3), [{ t: deckName, sz: 850, col: T.muted, align: 'r' }]) +
    rectSp_(93, EMU_(.6), EMU_(.66), EMU_(12.13), 6350, T.line, 0) +
    txSp_(94, EMU_(.6), EMU_(7.05), EMU_(9), EMU_(.25), [{ t: footNote, sz: 800, col: T.muted }]) +
    txSp_(95, EMU_(10.7), EMU_(7.05), EMU_(2.03), EMU_(.25), [{ t: page + ' / ' + pages, sz: 800, col: T.muted, align: 'r' }]);
}

/** One product card. Compact: two per slide; spacious: one per slide. Returns {shapes, media}. */
function productCard_(p, img, rid, x, y, w, T, compact, idBase) {
  var sh = '', id = idBase;
  if (compact) {
    // image plate left with identity, stock and facts beside it; specs and prices run full width below
    var plate = EMU_(3.05), gap = EMU_(.32), tx = x + plate + gap, tw = w - plate - gap;
    sh += rectSp_(id++, x, y, plate, plate, T.plate, 5000);
    if (img) { var b = fitBox_(img, x + EMU_(.18), y + EMU_(.18), plate - EMU_(.36), plate - EMU_(.36)); sh += picSp_(id++, rid, b.x, b.y, b.w, b.h); }
    sh += txSp_(id++, tx, y + EMU_(.05), tw, plate, [
      { t: [p.brand, p.category].filter(String).join('  ·  ').toUpperCase(), sz: 800, b: 1, col: T.accent, sp: 500 },
      { t: clip_(p.name, 64), sz: 1800, b: 1, col: T.ink, sp: 500, lh: 105000 },
      { t: p.sku + (p.hsn ? '  ·  HSN ' + p.hsn : ''), sz: 850, col: T.muted, sp: 900 },
      { t: 'MOQ ' + p.moq + '   ·   GST ' + p.gst + '%', sz: 1050, b: 1, col: T.ink, sp: 250 },
      { t: 'Lead time ' + (p.lead_time || '—'), sz: 1050, b: 1, col: T.ink, sp: 900 },
      { t: stockText_(p), sz: 1050, b: 1, col: p.atp > 0 ? T.ok : T.warn }
    ]);
    var y2 = y + plate + EMU_(.3);
    var specs = p.specs.slice(0, 4).map(function (s) { return { t: '•  ' + clip_(s, 110), sz: 1000, col: T.ink, sp: 200 }; });
    if (specs.length) sh += txSp_(id++, x, y2, w, EMU_(1.1), specs);
    sh += tierTable_(id++, x, y2 + (specs.length ? EMU_(1.22) : 0), w, p, T, true);
  } else {
    var plateW = EMU_(5.3);
    sh += rectSp_(id++, x, y, plateW, plateW, T.plate, 4000);
    if (img) { var b2 = fitBox_(img, x + EMU_(.3), y + EMU_(.3), plateW - EMU_(.6), plateW - EMU_(.6)); sh += picSp_(id++, rid, b2.x, b2.y, b2.w, b2.h); }
    var tx2 = x + plateW + EMU_(.6), tw2 = w - plateW - EMU_(.6);
    var paras2 = [
      { t: [p.brand, p.category].filter(String).join('  ·  ').toUpperCase(), sz: 950, b: 1, col: T.accent, sp: 600 },
      { t: clip_(p.name, 90), sz: 2800, b: 1, col: T.ink, sp: 500, lh: 105000 },
      { t: p.sku + (p.hsn ? '  ·  HSN ' + p.hsn : ''), sz: 1000, col: T.muted, sp: 900 }
    ];
    p.specs.slice(0, 6).forEach(function (s) { paras2.push({ t: '•  ' + clip_(s, 110), sz: 1200, col: T.ink, sp: 300 }); });
    sh += txSp_(id++, tx2, y, tw2, EMU_(3.2), paras2);
    // three facts as label/value pairs
    var facts = [['MOQ', String(p.moq)], ['Lead time', p.lead_time || '—'], ['GST', p.gst + '%']];
    var fy = y + EMU_(3.35), fw = Math.floor(tw2 / 3);
    facts.forEach(function (f, i) {
      sh += txSp_(id++, tx2 + fw * i, fy, fw - EMU_(.1), EMU_(.62), [
        { t: f[0].toUpperCase(), sz: 800, b: 1, col: T.muted, sp: 200 }, { t: f[1], sz: 1500, b: 1, col: T.ink }]);
    });
    sh += tierTable_(id++, tx2, fy + EMU_(.8), tw2, p, T, true);
    var sy = fy + EMU_(.8) + (p.tiers.length ? EMU_(.75) : 0);
    sh += txSp_(id++, tx2, sy, tw2, EMU_(.3), [{ t: stockText_(p), sz: 1100, b: 1, col: p.atp > 0 ? T.ok : T.warn }]);
  }
  return sh;
}

function buildPptx_(deck, products, s, cache) {
  var T = deckTheme_(s);
  var compact = T.layout === 'compact';
  var per = compact ? 2 : 1;
  var parts = [];
  function put(name, content) {
    parts.push(typeof content === 'string' ? Utilities.newBlob(content, 'text/plain', name) : Utilities.newBlob(content, 'application/octet-stream', name));
  }
  var relsHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  var layoutRel = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>';
  var imgRel = function (rid, target) { return '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + target + '"/>'; };

  var today = Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy');
  var coName = s.co_name || s.site_name || APP_NAME;
  var logo = fetchImage_(s.co_logo_url, cache);
  var footNote = 'Prices in INR, exclusive of GST  ·  Stock as at ' + today;

  // slide plan: cover, product slides, summary slides (14 rows each)
  var productSlides = Math.ceil(products.length / per);
  var SUMMARY_ROWS = 14;
  var summarySlides = Math.ceil(products.length / SUMMARY_ROWS);
  var N = 1 + productSlides + summarySlides;
  var slides = [];   // {xml, rels}

  // ---- cover
  var cover = rectSp_(2, 0, 0, XW, EMU_(.05), T.accent, 0) +
    rectSp_(3, EMU_(.75), EMU_(2.35), EMU_(.5), EMU_(.06), T.accent, 0) +
    txSp_(4, EMU_(.75), EMU_(2.55), EMU_(11.8), EMU_(.35), [{ t: coName.toUpperCase() + '   ·   PRODUCT DECK', sz: 1000, b: 1, col: T.accent }]) +
    txSp_(5, EMU_(.75), EMU_(2.95), EMU_(11.5), EMU_(1.75), [{ t: deck.name, sz: 4000, b: 1, col: T.ink, lh: 100000 }], 't') +
    txSp_(6, EMU_(.75), EMU_(4.85), EMU_(11.5), EMU_(.5), [{ t: (deck.company ? 'Prepared for ' + deck.company + '   ·   ' : '') + today + '   ·   ' + products.length + ' product' + (products.length === 1 ? '' : 's'), sz: 1400, col: T.muted }]) +
    txSp_(7, EMU_(.75), EMU_(6.55), EMU_(11.8), EMU_(.6), [
      { t: [coName, s.co_address, s.co_gstin ? 'GSTIN ' + s.co_gstin : '', s.co_phone, s.co_email].filter(String).join('   ·   '), sz: 850, col: T.muted, sp: 200 },
      { t: footNote, sz: 850, col: T.muted }]);
  var coverRels = layoutRel;
  if (logo) {
    put('ppt/media/logo.' + logo.ext, logo.bytes);
    var lb = fitBox_(logo, EMU_(.75), EMU_(.7), EMU_(2.6), EMU_(1.0));
    cover += picSp_(8, 'rId2', lb.x, lb.y, lb.w, lb.h);
    coverRels += imgRel('rId2', 'logo.' + logo.ext);
  }
  slides.push({ xml: slideXml_(cover), rels: coverRels });

  // ---- product slides
  for (var si = 0; si < productSlides; si++) {
    var group = products.slice(si * per, si * per + per);
    var shapes = chrome_(coName, deck.name, T, si + 2, N, footNote);
    var rels = layoutRel;
    group.forEach(function (p, gi) {
      var idx = si * per + gi;
      var img = fetchImage_(p.image, cache);
      var rid = '';
      if (img) {
        var fname = 'image' + (idx + 1) + '.' + img.ext;
        put('ppt/media/' + fname, img.bytes);
        rid = 'rId' + (10 + gi);
        rels += imgRel(rid, fname);
      }
      if (compact) {
        var cx = gi === 0 ? EMU_(.6) : EMU_(6.95);
        if (gi === 1) shapes += rectSp_(89, EMU_(6.66), EMU_(1.0), 6350, EMU_(5.8), T.line, 0);   // divider
        shapes += productCard_(p, img, rid, cx, EMU_(1.0), EMU_(5.78), T, true, 100 + gi * 20);
      } else {
        shapes += productCard_(p, img, rid, EMU_(.6), EMU_(1.0), EMU_(12.13), T, false, 100);
      }
    });
    slides.push({ xml: slideXml_(shapes), rels: rels });
  }

  // ---- summary slides
  for (var ss = 0; ss < summarySlides; ss++) {
    var chunk = products.slice(ss * SUMMARY_ROWS, ss * SUMMARY_ROWS + SUMMARY_ROWS);
    var sh2 = chrome_(coName, deck.name, T, 2 + productSlides + ss, N, footNote) +
      txSp_(2, EMU_(.6), EMU_(.95), EMU_(8), EMU_(.5), [{ t: 'At a glance' + (summarySlides > 1 ? ' (' + (ss + 1) + '/' + summarySlides + ')' : ''), sz: 2000, b: 1, col: T.ink }]);
    var cols = [EMU_(1.7), EMU_(5.0), EMU_(.9), EMU_(1.4), EMU_(1.5), EMU_(1.63)];
    var rows = [[{ t: 'SKU', sz: 800, b: 1, col: T.muted }, { t: 'Product', sz: 800, b: 1, col: T.muted }, { t: 'MOQ', sz: 800, b: 1, col: T.muted, align: 'r' },
                 { t: 'Lead time', sz: 800, b: 1, col: T.muted }, { t: 'From (ex-GST)', sz: 800, b: 1, col: T.muted, align: 'r' }, { t: 'Stock', sz: 800, b: 1, col: T.muted, align: 'r' }]];
    chunk.forEach(function (p) {
      rows.push([{ t: p.sku, sz: 900 }, { t: clip_(p.name, 60), sz: 900 }, { t: String(p.moq), sz: 900, align: 'r' },
                 { t: p.lead_time || '—', sz: 900 }, { t: fromPrice_(p) ? inr_(fromPrice_(p)) : '—', sz: 900, b: 1, align: 'r' },
                 { t: p.atp > 0 ? p.atp.toLocaleString('en-IN') : 'MTO', sz: 900, col: p.atp > 0 ? T.ok : T.warn, align: 'r' }]);
    });
    sh2 += tblSp_(3, EMU_(.6), EMU_(1.55), cols, rows, T, EMU_(.34));
    slides.push({ xml: slideXml_(sh2), rels: layoutRel });
  }

  // ---- package
  var overrides = '';
  slides.forEach(function (_, i) { overrides += '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'; });
  put('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + overrides + '</Types>');
  put('_rels/.rels', relsHead + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  var sldIds = '', sldRels = '';
  slides.forEach(function (sl, j) {
    sldIds += '<p:sldId id="' + (256 + j) + '" r:id="rId' + (j + 2) + '"/>';
    sldRels += '<Relationship Id="rId' + (j + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (j + 1) + '.xml"/>';
    put('ppt/slides/slide' + (j + 1) + '.xml', sl.xml);
    put('ppt/slides/_rels/slide' + (j + 1) + '.xml.rels', relsHead + sl.rels + '</Relationships>');
  });
  put('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + sldIds + '</p:sldIdLst>' +
    '<p:sldSz cx="' + XW + '" cy="' + XH + '"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
  put('ppt/_rels/presentation.xml.rels', relsHead + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' + sldRels + '</Relationships>');
  put('ppt/slideMasters/slideMaster1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>');
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsHead + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
  put('ppt/slideLayouts/slideLayout1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsHead + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');
  put('ppt/theme/theme1.xml', pptTheme_(T));

  var zip = Utilities.zip(parts, deck.name + '.pptx');
  return zip.setContentType('application/vnd.openxmlformats-officedocument.presentationml.presentation');
}

/* ---------------- PDF ---------------- */

function buildPdf_(deck, products, s, cache) {
  var T = deckTheme_(s);
  var compact = T.layout === 'compact';
  var per = compact ? 2 : 1;
  var today = Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy');
  var coName = s.co_name || s.site_name || APP_NAME;
  var logo = fetchImage_(s.co_logo_url, cache);
  var footNote = 'Prices in INR, exclusive of GST  ·  Stock as at ' + today;
  function dataUri(img) { return img ? 'data:' + img.mime + ';base64,' + img.b64 : ''; }
  function c(h) { return '#' + h; }

  var productPages = Math.ceil(products.length / per);
  var SUMMARY_ROWS = 28;
  var summaryPages = Math.ceil(products.length / SUMMARY_ROWS);
  var pages = 1 + productPages + summaryPages;

  var css = '<style>' +
    '@page{size:A4;margin:14mm 16mm 16mm}' +
    'body{font-family:Helvetica,Arial,sans-serif;color:' + c(T.ink) + ';margin:0;font-size:10pt;line-height:1.35}' +
    '.pg{page-break-after:always}.pg:last-child{page-break-after:auto}' +
    '.hdr{display:flex;justify-content:space-between;color:' + c(T.muted) + ';font-size:7.5pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-bottom:.4pt solid ' + c(T.line) + ';padding-bottom:2.5mm;margin-bottom:6mm}' +
    '.ftr{display:flex;justify-content:space-between;color:' + c(T.muted) + ';font-size:7.5pt;margin-top:6mm;border-top:.4pt solid ' + c(T.line) + ';padding-top:2.5mm}' +
    '.eyebrow{color:' + c(T.accent) + ';font-weight:700;font-size:7.5pt;letter-spacing:.08em;text-transform:uppercase}' +
    '.rule{width:12mm;height:1.2mm;background:' + c(T.accent) + ';margin-bottom:4mm}' +
    '.cover{padding-top:58mm}.cover h1{font-size:30pt;margin:3mm 0 4mm;line-height:1.08;font-weight:700}.cover .meta{color:' + c(T.muted) + ';font-size:11.5pt}' +
    '.cover .who{color:' + c(T.muted) + ';font-size:8.5pt;margin-top:70mm;line-height:1.6}' +
    '.card{display:flex;gap:9mm;padding:' + (compact ? '6mm 0 0' : '4mm 0') + ';height:' + (compact ? '112mm' : '228mm') + ';box-sizing:border-box;border-bottom:.4pt solid ' + c(T.line) + '}.card:last-of-type{border-bottom:none}' +
    '.plate{width:' + (compact ? '70mm' : '96mm') + ';height:' + (compact ? '70mm' : '96mm') + ';display:flex;align-items:center;justify-content:center;background:' + c(T.plate) + ';border-radius:3mm;flex:none}' +
    '.plate img{max-width:' + (compact ? '60mm' : '84mm') + ';max-height:' + (compact ? '60mm' : '84mm') + '}' +
    '.body{flex:1;min-width:0}.name{font-size:' + (compact ? '15pt' : '20pt') + ';font-weight:700;margin:1.5mm 0 .8mm;line-height:1.15}.sku{color:' + c(T.muted) + ';font-size:8.5pt;margin-bottom:3mm}' +
    'ul{margin:0 0 3.5mm 3.5mm;padding:0;font-size:' + (compact ? '9.3pt' : '10pt') + '}li{margin-bottom:.9mm}' +
    '.facts{font-weight:700;font-size:' + (compact ? '9.5pt' : '10.5pt') + ';margin:1mm 0 2.5mm}' +
    '.tiers{border-collapse:collapse;margin:0 0 2.5mm}.tiers th{text-align:left;font-weight:400;color:' + c(T.muted) + ';font-size:7.5pt;padding:0 7mm .8mm 0;border-bottom:.4pt solid ' + c(T.line) + '}' +
    '.tiers td{font-weight:700;font-size:' + (compact ? '12pt' : '13pt') + ';padding:1.2mm 8mm 0 0}' +
    '.stock{font-weight:700;font-size:' + (compact ? '9.5pt' : '10.5pt') + '}.ok{color:' + c(T.ok) + '}.mto{color:' + c(T.warn) + '}' +
    'h2{font-size:16pt;margin:0 0 5mm}' +
    '.sum{width:100%;border-collapse:collapse;font-size:8.8pt}.sum th{text-align:left;color:' + c(T.muted) + ';font-weight:700;font-size:7.5pt;text-transform:uppercase;letter-spacing:.05em;padding:0 3mm 1.5mm 0;border-bottom:.6pt solid ' + c(T.ink) + '}' +
    '.sum td{padding:1.6mm 3mm 1.6mm 0;border-bottom:.4pt solid ' + c(T.line) + ';vertical-align:top}.num{text-align:right}' +
    '</style>';

  function header() { return '<div class="hdr"><span>' + esc_(coName) + '</span><span>' + esc_(deck.name) + '</span></div>'; }
  function footer(n) { return '<div class="ftr"><span>' + esc_(footNote) + '</span><span>' + n + ' / ' + pages + '</span></div>'; }

  var html = '<html><head><meta charset="utf-8">' + css + '</head><body>';
  html += '<div class="pg cover">' + (logo ? '<img src="' + dataUri(logo) + '" style="height:20mm;margin-bottom:10mm"><br>' : '') +
    '<div class="rule"></div><div class="eyebrow">' + esc_(coName) + ' · Product deck</div><h1>' + esc_(deck.name) + '</h1>' +
    '<div class="meta">' + (deck.company ? 'Prepared for ' + esc_(deck.company) + ' · ' : '') + today + ' · ' + products.length + ' product' + (products.length === 1 ? '' : 's') + '</div>' +
    '<div class="who">' + esc_([coName, s.co_address, s.co_gstin ? 'GSTIN ' + s.co_gstin : '', s.co_phone, s.co_email].filter(String).join(' · ')) + '<br>' + esc_(footNote) + '</div></div>';

  for (var pi = 0; pi < productPages; pi++) {
    html += '<div class="pg">' + header();
    products.slice(pi * per, pi * per + per).forEach(function (p) {
      var img = fetchImage_(p.image, cache);
      html += '<div class="card"><div class="plate">' + (img ? '<img src="' + dataUri(img) + '">' : '') + '</div><div class="body">' +
        '<div class="eyebrow">' + esc_([p.brand, p.category].filter(String).join(' · ')) + '</div>' +
        '<div class="name">' + esc_(p.name) + '</div>' +
        '<div class="sku">' + esc_(p.sku) + (p.hsn ? ' · HSN ' + esc_(p.hsn) : '') + '</div>' +
        (p.specs.length ? '<ul>' + p.specs.slice(0, compact ? 5 : 8).map(function (x) { return '<li>' + esc_(clip_(x, compact ? 110 : 160)) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="facts">' + esc_(factsText_(p)).replace(/ {3}· {3}/g, ' &nbsp;·&nbsp; ') + '</div>' +
        (p.tiers.length ? '<table class="tiers"><tr>' + p.tiers.slice(0, 4).map(function (t) { return '<th>' + t.min.toLocaleString('en-IN') + '+ units</th>'; }).join('') + '</tr><tr>' +
          p.tiers.slice(0, 4).map(function (t) { return '<td>' + inr_(t.price) + '</td>'; }).join('') + '</tr></table>' : '') +
        '<div class="stock ' + (p.atp > 0 ? 'ok' : 'mto') + '">' + esc_(stockText_(p)) + '</div>' +
        '</div></div>';
    });
    html += footer(pi + 2) + '</div>';
  }

  for (var sp = 0; sp < summaryPages; sp++) {
    var chunk = products.slice(sp * SUMMARY_ROWS, sp * SUMMARY_ROWS + SUMMARY_ROWS);
    html += '<div class="pg">' + header() + '<h2>At a glance' + (summaryPages > 1 ? ' (' + (sp + 1) + '/' + summaryPages + ')' : '') + '</h2>' +
      '<table class="sum"><tr><th>SKU</th><th>Product</th><th class="num">MOQ</th><th>Lead time</th><th class="num">From (ex-GST)</th><th class="num">Stock</th></tr>' +
      chunk.map(function (p) {
        return '<tr><td>' + esc_(p.sku) + '</td><td>' + esc_(clip_(p.name, 70)) + '</td><td class="num">' + p.moq + '</td><td>' + esc_(p.lead_time || '—') + '</td>' +
          '<td class="num"><b>' + (fromPrice_(p) ? inr_(fromPrice_(p)) : '—') + '</b></td>' +
          '<td class="num ' + (p.atp > 0 ? 'ok' : 'mto') + '">' + (p.atp > 0 ? p.atp.toLocaleString('en-IN') : 'MTO') + '</td></tr>';
      }).join('') + '</table>' + footer(2 + productPages + sp) + '</div>';
  }
  html += '</body></html>';
  return Utilities.newBlob(html, 'text/html', deck.name + '.html').getAs('application/pdf').setName(deck.name + '.pdf');
}

/* ---------------- endpoints ---------------- */

function decksFolder_() {
  var root = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  return ensureChild_(root, 'Decks');
}

function fnAdminDecks_(p) {
  if (!db_().getSheetByName('Decks')) return err_('The Decks tab does not exist yet. Run setupRun once in the Apps Script editor.');
  var rows = readRows_('Decks').map(function (d) {
    return {
      id: String(d.deck_id), name: d.name, skus: String(d.skus || '').split('|').filter(String),
      company_id: String(d.company_id || ''), company: d.company || '',
      pdf_url: d.pdf_url || '', pptx_url: d.pptx_url || '', folder_id: d.folder_id || '',
      created_by: d.created_by || '', created: String(d.created || ''),
      sent_to: d.sent_to || '', last_sent: String(d.last_sent || '')
    };
  }).reverse();
  return ok_({ decks: rows });
}

function fnAdminDeckBuild_(p) {
  if (!db_().getSheetByName('Decks')) return err_('The Decks tab does not exist yet. Run setupRun once in the Apps Script editor.');
  var name = String(p.name || '').trim();
  var skus = (p.skus || []).map(String).filter(String);
  if (!name) return err_('Give the deck a name');
  if (!skus.length) return err_('Pick at least one product');
  if (skus.length > 40) return err_('40 products per deck at most — split it');

  var products = deckProducts_(skus);
  if (!products.length) return err_('None of those SKUs exist');
  var s = getSettings_();
  var deck = { name: name, company: String(p.company || ''), company_id: String(p.company_id || '') };
  var cache = {};

  var id = nextId_('Decks', 'deck_id', 'DK');
  var folder = ensureChild_(decksFolder_(), id + ' ' + name.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60));

  var pdfFile = folder.createFile(buildPdf_(deck, products, s, cache));
  var pptFile = folder.createFile(buildPptx_(deck, products, s, cache));
  var pdfUrl = publicFileUrl_(pdfFile), pptUrl = publicFileUrl_(pptFile);

  appendRecord_('Decks', {
    deck_id: id, name: name, skus: products.map(function (x) { return x.sku; }).join('|'),
    company_id: deck.company_id, company: deck.company,
    pdf_url: pdfUrl, pptx_url: pptUrl, folder_id: folder.getId(),
    created_by: p.actor || 'admin', created: now_(), sent_to: '', last_sent: ''
  });
  audit_(p.actor || 'admin', 'deck_build', id, products.length + ' products');
  return ok_({ id: id, pdf_url: pdfUrl, pptx_url: pptUrl, products: products.length,
               missing: skus.length - products.length });
}

function fnAdminDeckSend_(p) {
  var rowNum = findRow_('Decks', function (r) { return String(r.deck_id) === String(p.id); });
  if (rowNum < 0) return err_('Deck not found');
  var d = readRows_('Decks')[rowNum - 2];
  var to = String(p.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err_('A valid email address is required');

  var s = getSettings_();
  var coName = s.co_name || s.site_name || APP_NAME;
  var body = (p.message ? String(p.message).trim() + '\n\n' : '') +
    'Product deck: ' + d.name + '\n' +
    'PDF: ' + d.pdf_url + '\n' + 'PowerPoint: ' + d.pptx_url + '\n\n' +
    'Prices are in INR, exclusive of GST. Stock is as at the date on the deck.\n\n' + coName +
    (s.co_phone ? ' · ' + s.co_phone : '') + (s.co_email ? ' · ' + s.co_email : '');
  var r = sendMail_(to, '[' + coName + '] ' + d.name, body, { replyTo: s.co_email || '' });
  if (!r.ok) return err_(r.error || 'Send failed');

  d.sent_to = (d.sent_to ? d.sent_to + ', ' : '') + to;
  d.last_sent = now_();
  writeRecord_('Decks', rowNum, d);
  audit_(p.actor || 'admin', 'deck_send', d.deck_id, to);
  return ok_({ id: d.deck_id, via: r.via });
}

function fnAdminDeckDelete_(p) {
  var rowNum = findRow_('Decks', function (r) { return String(r.deck_id) === String(p.id); });
  if (rowNum < 0) return err_('Deck not found');
  var d = readRows_('Decks')[rowNum - 2];
  try { if (d.folder_id) DriveApp.getFolderById(d.folder_id).setTrashed(true); } catch (e) {}
  sheet_('Decks').deleteRow(rowNum);
  audit_(p.actor || 'admin', 'deck_delete', p.id, '');
  return ok_({ id: p.id });
}

/** Editor-only: build a deck from the first three products and log the links. */
function deckSelfTest() {
  var skus = readRows_('Products').slice(0, 3).map(function (r) { return String(r.sku); });
  var res = fnAdminDeckBuild_({ name: 'Self-test deck', skus: skus, actor: 'self-test' });
  Logger.log(res.getContent());
}
