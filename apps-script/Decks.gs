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

/* ---------------- PPTX ---------------- */

function pptPara_(p) {
  var rPr = '<a:rPr lang="en-IN" sz="' + (p.sz || 1400) + '" b="' + (p.b ? 1 : 0) + '" dirty="0"><a:solidFill><a:srgbClr val="' + (p.col || '1D1D1F') + '"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr>';
  var pPr = '<a:pPr' + (p.align ? ' algn="' + p.align + '"' : '') + '>' + (p.sp ? '<a:spcAft><a:spcPts val="' + p.sp + '"/></a:spcAft>' : '') + '</a:pPr>';
  if (!p.t) return '<a:p>' + pPr + '<a:endParaRPr lang="en-IN" sz="' + (p.sz || 1400) + '"/></a:p>';
  return '<a:p>' + pPr + '<a:r>' + rPr + '<a:t>' + xesc_(p.t) + '</a:t></a:r></a:p>';
}
function txSp_(id, x, y, w, h, paras) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="tx' + id + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>' + paras.map(pptPara_).join('') + '</p:txBody></p:sp>';
}
function rectSp_(id, x, y, w, h, color) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="rc' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 8000"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
}
function picSp_(id, rid, x, y, w, h) {
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="im' + id + '"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
function slideXml_(shapes) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + shapes +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
var PPT_THEME_ = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Ops"><a:themeElements>' +
  '<a:clrScheme name="Ops"><a:dk1><a:srgbClr val="1D1D1F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="6E6E73"/></a:dk2><a:lt2><a:srgbClr val="F5F5F7"/></a:lt2><a:accent1><a:srgbClr val="2447F5"/></a:accent1><a:accent2><a:srgbClr val="248A3D"/></a:accent2><a:accent3><a:srgbClr val="B25000"/></a:accent3><a:accent4><a:srgbClr val="D70015"/></a:accent4><a:accent5><a:srgbClr val="8A5A10"/></a:accent5><a:accent6><a:srgbClr val="00A3B4"/></a:accent6><a:hlink><a:srgbClr val="2447F5"/></a:hlink><a:folHlink><a:srgbClr val="6E6E73"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Ops"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Ops"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements></a:theme>';

function buildPptx_(deck, products, s, cache) {
  var parts = [];
  function put(name, content) {
    parts.push(typeof content === 'string' ? Utilities.newBlob(content, 'text/plain', name) : Utilities.newBlob(content, 'application/octet-stream', name));
  }
  var N = products.length + 1;
  var layoutRel = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>';
  var relsHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

  var overrides = '';
  for (var i = 1; i <= N; i++) overrides += '<Override PartName="/ppt/slides/slide' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  put('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + overrides + '</Types>');
  put('_rels/.rels', relsHead + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');

  var sldIds = '', sldRels = '';
  for (var j = 0; j < N; j++) {
    sldIds += '<p:sldId id="' + (256 + j) + '" r:id="rId' + (j + 2) + '"/>';
    sldRels += '<Relationship Id="rId' + (j + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (j + 1) + '.xml"/>';
  }
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
  put('ppt/theme/theme1.xml', PPT_THEME_);

  var today = Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy');
  var coName = s.co_name || s.site_name || APP_NAME;
  var logo = fetchImage_(s.co_logo_url, cache);

  // ---- cover
  var cover = rectSp_(2, EMU_(.75), EMU_(3.05), EMU_(.55), EMU_(.09), '2447F5') +
    txSp_(3, EMU_(.75), EMU_(2.0), EMU_(11.8), EMU_(.5), [{ t: coName.toUpperCase() + ' · PRODUCT DECK', sz: 1100, b: 1, col: '2447F5' }]) +
    txSp_(4, EMU_(.75), EMU_(3.3), EMU_(11.5), EMU_(1.8), [{ t: deck.name, sz: 4000, b: 1 }]) +
    txSp_(5, EMU_(.75), EMU_(5.05), EMU_(11.5), EMU_(.9), [{ t: (deck.company ? 'Prepared for ' + deck.company + '  ·  ' : '') + today + '  ·  ' + products.length + ' product' + (products.length === 1 ? '' : 's'), sz: 1500, col: '6E6E73' }]) +
    txSp_(6, EMU_(.75), EMU_(6.6), EMU_(11.5), EMU_(.6), [
      { t: [coName, s.co_address, s.co_gstin ? 'GSTIN ' + s.co_gstin : '', s.co_phone, s.co_email].filter(String).join('  ·  '), sz: 900, col: '6E6E73' },
      { t: 'Prices in INR, exclusive of GST. Stock as at ' + today + '.', sz: 900, col: '6E6E73' }]);
  var coverRels = layoutRel;
  if (logo) {
    put('ppt/media/logo.' + logo.ext, logo.bytes);
    var lb = fitBox_(logo, EMU_(.75), EMU_(.6), EMU_(2.6), EMU_(1.0));
    cover += picSp_(7, 'rId2', lb.x, lb.y, lb.w, lb.h);
    coverRels += '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.' + logo.ext + '"/>';
  }
  put('ppt/slides/slide1.xml', slideXml_(cover));
  put('ppt/slides/_rels/slide1.xml.rels', relsHead + coverRels + '</Relationships>');

  // ---- one slide per product
  products.forEach(function (p, i) {
    var n = i + 2;
    var img = fetchImage_(p.image, cache);
    var paras = [
      { t: (p.brand || '').toUpperCase() + (p.category ? '  ·  ' + p.category.toUpperCase() : ''), sz: 1100, b: 1, col: '2447F5', sp: 300 },
      { t: p.name, sz: 2600, b: 1, sp: 200 },
      { t: p.sku + (p.hsn ? '  ·  HSN ' + p.hsn : ''), sz: 1100, col: '6E6E73', sp: 500 }
    ];
    p.specs.slice(0, 5).forEach(function (sp) { paras.push({ t: '•  ' + sp, sz: 1200, col: '3D3D42', sp: 100 }); });
    paras.push({ t: '', sz: 600 });
    paras.push({ t: 'MOQ ' + p.moq + (p.lead_time ? '   ·   Lead time ' + p.lead_time : '') + '   ·   GST ' + p.gst + '%', sz: 1200, b: 1, sp: 400 });
    if (p.tiers.length) {
      paras.push({ t: 'Pricing per unit, ex-GST' + (p.mrp ? '   (MRP ' + inr_(p.mrp) + ')' : ''), sz: 1000, b: 1, col: '6E6E73', sp: 150 });
      p.tiers.forEach(function (t) { paras.push({ t: t.min + '+ units    ' + inr_(t.price), sz: 1300, sp: 80 }); });
    }
    paras.push({ t: '', sz: 400 });
    paras.push(p.atp > 0 ? { t: 'In stock — ' + p.atp.toLocaleString('en-IN') + ' available', sz: 1200, b: 1, col: '248A3D' }
                         : { t: 'Made to order', sz: 1200, b: 1, col: 'B25000' });

    var shapes = '';
    var rels = layoutRel;
    if (img) {
      put('ppt/media/image' + (i + 1) + '.' + img.ext, img.bytes);
      var box = fitBox_(img, EMU_(.75), EMU_(1.25), EMU_(4.9), EMU_(4.9));
      shapes += picSp_(2, 'rId2', box.x, box.y, box.w, box.h);
      rels += '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image' + (i + 1) + '.' + img.ext + '"/>';
    } else {
      shapes += rectSp_(2, EMU_(.75), EMU_(1.25), EMU_(4.9), EMU_(4.9), 'F5F5F7');
    }
    shapes += txSp_(3, EMU_(6.0), EMU_(1.25), EMU_(6.5), EMU_(5.4), paras) +
      txSp_(4, EMU_(.75), EMU_(6.95), EMU_(11.5), EMU_(.35), [{ t: coName + '  ·  ' + deck.name + '  ·  ' + (i + 1) + ' of ' + products.length, sz: 900, col: '6E6E73' }]);
    put('ppt/slides/slide' + n + '.xml', slideXml_(shapes));
    put('ppt/slides/_rels/slide' + n + '.xml.rels', relsHead + rels + '</Relationships>');
  });

  var zip = Utilities.zip(parts, deck.name + '.pptx');
  return zip.setContentType('application/vnd.openxmlformats-officedocument.presentationml.presentation');
}

/* ---------------- PDF ---------------- */

function buildPdf_(deck, products, s, cache) {
  var today = Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy');
  var coName = s.co_name || s.site_name || APP_NAME;
  var logo = fetchImage_(s.co_logo_url, cache);
  function dataUri(img) { return img ? 'data:' + img.mime + ';base64,' + img.b64 : ''; }

  var css = '<style>' +
    '@page{size:A4;margin:16mm 16mm 18mm}' +
    'body{font-family:Helvetica,Arial,sans-serif;color:#1d1d1f;margin:0;font-size:11pt}' +
    '.pg{page-break-after:always}.pg:last-child{page-break-after:auto}' +
    '.eyebrow{color:#2447f5;font-weight:700;font-size:9pt;letter-spacing:.06em;text-transform:uppercase}' +
    '.cover{padding-top:60mm}.cover h1{font-size:30pt;margin:6mm 0 4mm;line-height:1.1}.cover .meta{color:#6e6e73;font-size:12pt}' +
    '.foot{color:#6e6e73;font-size:8.5pt;margin-top:40mm}' +
    '.prod{display:flex;gap:10mm}.img{width:80mm;height:80mm;display:flex;align-items:center;justify-content:center;background:#f5f5f7;border-radius:4mm;flex:none}' +
    '.img img{max-width:74mm;max-height:74mm}' +
    '.body{flex:1}.name{font-size:18pt;font-weight:700;margin:2mm 0 1mm}.sku{color:#6e6e73;font-size:9.5pt;margin-bottom:4mm}' +
    'ul{margin:0 0 4mm 4mm;padding:0;color:#3d3d42;font-size:10pt}li{margin-bottom:1mm}' +
    '.kv{font-weight:700;margin:3mm 0}.tiers{border-collapse:collapse;margin:1mm 0 3mm}.tiers td{padding:1mm 8mm 1mm 0;font-size:10.5pt}' +
    '.stock{font-weight:700}.ok{color:#248a3d}.mto{color:#b25000}' +
    '.pfoot{position:fixed;bottom:0;left:0;right:0;color:#6e6e73;font-size:8pt}' +
    '</style>';

  var html = '<html><head><meta charset="utf-8">' + css + '</head><body>';
  html += '<div class="pg cover">' + (logo ? '<img src="' + dataUri(logo) + '" style="height:22mm;margin-bottom:8mm"><br>' : '') +
    '<div class="eyebrow">' + esc_(coName) + ' · Product deck</div><h1>' + esc_(deck.name) + '</h1>' +
    '<div class="meta">' + (deck.company ? 'Prepared for ' + esc_(deck.company) + ' · ' : '') + today + ' · ' + products.length + ' product' + (products.length === 1 ? '' : 's') + '</div>' +
    '<div class="foot">' + esc_([coName, s.co_address, s.co_gstin ? 'GSTIN ' + s.co_gstin : '', s.co_phone, s.co_email].filter(String).join(' · ')) +
    '<br>Prices in INR, exclusive of GST. Stock as at ' + today + '.</div></div>';

  products.forEach(function (p, i) {
    var img = fetchImage_(p.image, cache);
    html += '<div class="pg"><div class="prod"><div class="img">' + (img ? '<img src="' + dataUri(img) + '">' : '') + '</div><div class="body">' +
      '<div class="eyebrow">' + esc_(p.brand) + (p.category ? ' · ' + esc_(p.category) : '') + '</div>' +
      '<div class="name">' + esc_(p.name) + '</div>' +
      '<div class="sku">' + esc_(p.sku) + (p.hsn ? ' · HSN ' + esc_(p.hsn) : '') + '</div>' +
      (p.specs.length ? '<ul>' + p.specs.slice(0, 8).map(function (x) { return '<li>' + esc_(x) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="kv">MOQ ' + p.moq + (p.lead_time ? ' · Lead time ' + esc_(p.lead_time) : '') + ' · GST ' + p.gst + '%</div>' +
      (p.tiers.length ? '<div class="eyebrow" style="font-size:8pt">Pricing per unit, ex-GST' + (p.mrp ? ' (MRP ' + inr_(p.mrp) + ')' : '') + '</div><table class="tiers">' +
        p.tiers.map(function (t) { return '<tr><td>' + t.min + '+ units</td><td><b>' + inr_(t.price) + '</b></td></tr>'; }).join('') + '</table>' : '') +
      '<div class="stock ' + (p.atp > 0 ? 'ok' : 'mto') + '">' + (p.atp > 0 ? 'In stock — ' + p.atp.toLocaleString('en-IN') + ' available' : 'Made to order') + '</div>' +
      '</div></div><div class="pfoot">' + esc_(coName) + ' · ' + esc_(deck.name) + ' · ' + (i + 1) + ' of ' + products.length + '</div></div>';
  });
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
