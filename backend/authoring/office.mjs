import JSZip from 'jszip';

// =============================================================================
// backend/authoring/office.mjs
// -----------------------------------------------------------------------------
// Real Office authoring (create / edit / read) for DOCX, ODT, PPTX and XLSX.
//
// The platform could only *extract* text from documents (doc.extract). This
// module adds genuine authoring: it writes real OOXML (Word/PowerPoint/Excel)
// and ODF (OpenDocument Text) packages that Microsoft Office and LibreOffice
// open natively, and it can re-open and edit a document it produced.
//
// It builds the ZIP containers directly with jszip (already a dependency) and
// emits the minimal, standards-compliant XML parts each format requires — no new
// heavyweight dependency, no external service. Everything is deterministic and
// runs fully offline, which is why it is unit-testable end to end.
// =============================================================================

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const XML_HEADER_ODF = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escape text for inclusion in XML character data / attributes. */
export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Convert a 1-based column index to its spreadsheet letter (1 -> A, 27 -> AA). */
export function columnLetter(index) {
  let n = Math.max(1, Math.floor(Number(index) || 1));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Convert a spreadsheet A1 reference to { column, row } (1-based). */
export function parseCellRef(ref) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(ref || '').trim());
  if (!match) throw new Error('CELL_REF_INVALID');
  let column = 0;
  for (const ch of match[1].toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { column, row: Number(match[2]) };
}

const DOCX_STYLE_IDS = Object.freeze({ Title: 'Title', Heading1: 'Heading1', Heading2: 'Heading2', Normal: 'Normal' });

function normalizeParagraph(paragraph) {
  if (paragraph && typeof paragraph === 'object') {
    return { text: String(paragraph.text ?? ''), style: DOCX_STYLE_IDS[paragraph.style] ?? 'Normal' };
  }
  return { text: String(paragraph ?? ''), style: 'Normal' };
}

function docxParagraphXml({ text, style }) {
  const styleXml = style && style !== 'Normal' ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function docxStylesXml() {
  const heading = (id, name, size, color) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="${size}"/><w:color w:val="${color}"/></w:rPr></w:style>`;
  return `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + heading('Title', 'Title', '56', '2E74B5')
    + heading('Heading1', 'heading 1', '36', '2E74B5')
    + heading('Heading2', 'heading 2', '28', '2E74B5')
    + '</w:styles>';
}

function docxDocumentXml(paragraphs) {
  const body = paragraphs.map(docxParagraphXml).join('');
  return `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}`
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    + '</w:body></w:document>';
}

function corePropsXml({ title, author, created }) {
  const stamp = (created ? new Date(created) : new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  return `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${escapeXml(title ?? '')}</dc:title>`
    + `<dc:creator>${escapeXml(author ?? 'Semo0o Agent')}</dc:creator>`
    + `<cp:lastModifiedBy>${escapeXml(author ?? 'Semo0o Agent')}</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`
    + '</cp:coreProperties>';
}

function appPropsXml(application) {
  return `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${escapeXml(application)}</Application></Properties>`;
}

/* -------------------------------------------------------------------------- */
/*  DOCX                                                                      */
/* -------------------------------------------------------------------------- */

/** Build a real .docx package from a title + paragraphs. */
export async function createDocx({ title = '', paragraphs = [], author, created } = {}) {
  const list = [];
  if (title) list.push({ text: title, style: 'Title' });
  for (const paragraph of paragraphs) list.push(normalizeParagraph(paragraph));
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>');
  zip.file('word/_rels/document.xml.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/document.xml', docxDocumentXml(list));
  zip.file('word/styles.xml', docxStylesXml());
  zip.file('docProps/core.xml', corePropsXml({ title, author, created }));
  zip.file('docProps/app.xml', appPropsXml('Semo0o Agent'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Read a .docx back into { title, paragraphs }. */
export async function readDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('DOCX_INVALID:missing_document');
  const xml = await file.async('string');
  const paragraphs = [];
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = match[1];
    const styleMatch = /<w:pStyle w:val="([^"]+)"/.exec(inner);
    const text = [...inner.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXml(m[1])).join('');
    paragraphs.push({ text, style: styleMatch ? styleMatch[1] : 'Normal' });
  }
  const title = paragraphs.find((p) => p.style === 'Title')?.text ?? '';
  return { title, paragraphs };
}

function applyTextOps(paragraphs, ops) {
  const list = paragraphs.map((p) => ({ ...p }));
  for (const op of ops) {
    const type = String(op?.op || '').toLowerCase();
    if (type === 'append') list.push(normalizeParagraph({ text: op.text, style: op.style }));
    else if (type === 'prepend') list.unshift(normalizeParagraph({ text: op.text, style: op.style }));
    else if (type === 'replace') {
      const index = list.findIndex((p) => p.text.includes(String(op.match ?? '')));
      if (index === -1) throw new Error(`EDIT_MATCH_NOT_FOUND:${op.match}`);
      list[index] = { text: String(op.text ?? ''), style: DOCX_STYLE_IDS[op.style] ?? list[index].style };
    } else if (type === 'remove') {
      const index = list.findIndex((p) => p.text.includes(String(op.match ?? '')));
      if (index === -1) throw new Error(`EDIT_MATCH_NOT_FOUND:${op.match}`);
      list.splice(index, 1);
    } else if (type === 'settitle') {
      const index = list.findIndex((p) => p.style === 'Title');
      if (index === -1) list.unshift({ text: String(op.text ?? ''), style: 'Title' });
      else list[index] = { text: String(op.text ?? ''), style: 'Title' };
    } else throw new Error(`EDIT_OP_UNSUPPORTED:${op?.op}`);
  }
  return list;
}

/** Edit a .docx package in place (append/prepend/replace/remove/setTitle). */
export async function editDocx(buffer, ops = []) {
  const { paragraphs } = await readDocx(buffer);
  const updated = applyTextOps(paragraphs, ops);
  const zip = await JSZip.loadAsync(buffer);
  zip.file('word/document.xml', docxDocumentXml(updated));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* -------------------------------------------------------------------------- */
/*  ODT                                                                       */
/* -------------------------------------------------------------------------- */

const ODT_MIME = 'application/vnd.oasis.opendocument.text';

function odtParagraphXml({ text, style }) {
  if (style === 'Title') return `<text:h text:outline-level="1" text:style-name="Title">${escapeXml(text)}</text:h>`;
  if (style === 'Heading1') return `<text:h text:outline-level="1">${escapeXml(text)}</text:h>`;
  if (style === 'Heading2') return `<text:h text:outline-level="2">${escapeXml(text)}</text:h>`;
  return `<text:p>${escapeXml(text)}</text:p>`;
}

function odtContentXml(paragraphs) {
  return `${XML_HEADER_ODF}<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">`
    + '<office:body><office:text>'
    + paragraphs.map(odtParagraphXml).join('')
    + '</office:text></office:body></office:document-content>';
}

function odtStylesXml() {
  return `${XML_HEADER_ODF}<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">`
    + '<office:styles><style:style style:name="Title" style:family="paragraph"><style:text-properties fo:font-size="24pt" fo:font-weight="bold"/></style:style></office:styles>'
    + '</office:document-styles>';
}

function odtMetaXml({ title, author, created }) {
  const stamp = (created ? new Date(created) : new Date()).toISOString();
  return `${XML_HEADER_ODF}<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">`
    + `<office:meta><dc:title>${escapeXml(title ?? '')}</dc:title><dc:creator>${escapeXml(author ?? 'Semo0o Agent')}</dc:creator><meta:creation-date>${stamp}</meta:creation-date></office:meta>`
    + '</office:document-meta>';
}

/** Build a real .odt package (mimetype stored uncompressed and first, per spec). */
export async function createOdt({ title = '', paragraphs = [], author, created } = {}) {
  const list = [];
  if (title) list.push({ text: title, style: 'Title' });
  for (const paragraph of paragraphs) list.push(normalizeParagraph(paragraph));
  const zip = new JSZip();
  zip.file('mimetype', ODT_MIME, { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', `${XML_HEADER_ODF}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">`
    + `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODT_MIME}"/>`
    + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
    + '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'
    + '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>'
    + '</manifest:manifest>');
  zip.file('content.xml', odtContentXml(list));
  zip.file('styles.xml', odtStylesXml());
  zip.file('meta.xml', odtMetaXml({ title, author, created }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: ODT_MIME });
}

/** Read an .odt back into { title, paragraphs }. */
export async function readOdt(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('content.xml');
  if (!file) throw new Error('ODT_INVALID:missing_content');
  const xml = await file.async('string');
  const paragraphs = [];
  for (const match of xml.matchAll(/<text:(h|p)\b([^>]*)>([\s\S]*?)<\/text:\1>/g)) {
    const isHeading = match[1] === 'h';
    const styleMatch = /text:style-name="([^"]+)"/.exec(match[2]);
    const text = unescapeXml(match[3].replace(/<[^>]+>/g, ''));
    paragraphs.push({ text, style: isHeading ? (styleMatch ? styleMatch[1] : 'Heading1') : 'Normal' });
  }
  const title = paragraphs.find((p) => p.style === 'Title')?.text ?? paragraphs[0]?.text ?? '';
  return { title, paragraphs };
}

/** Edit an .odt package in place (same text ops as DOCX). */
export async function editOdt(buffer, ops = []) {
  const { paragraphs } = await readOdt(buffer);
  const updated = applyTextOps(paragraphs, ops);
  const zip = await JSZip.loadAsync(buffer);
  zip.file('content.xml', odtContentXml(updated));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: ODT_MIME });
}

/* -------------------------------------------------------------------------- */
/*  PPTX                                                                      */
/* -------------------------------------------------------------------------- */

const PPT_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function pptxSlideXml({ title, bullets }) {
  const titleShape = title ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></p:txBody></p:sp>` : '';
  const bodyParas = (bullets ?? []).map((b) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(b)}</a:t></a:r></a:p>`).join('') || '<a:p/>';
  const bodyShape = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${bodyParas}</p:txBody></p:sp>`;
  return `${XML_HEADER}<p:sld ${PPT_NS}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + titleShape + bodyShape
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

function pptxThemeXml() {
  const accent = (name, hex) => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`;
  return `${XML_HEADER}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Semo0o">`
    + '<a:themeElements><a:clrScheme name="Semo0o">'
    + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    + accent('dk2', '44546A') + accent('lt2', 'E7E6E6') + accent('accent1', '4472C4') + accent('accent2', 'ED7D31')
    + accent('accent3', 'A5A5A5') + accent('accent4', 'FFC000') + accent('accent5', '5B9BD5') + accent('accent6', '70AD47')
    + accent('hlink', '0563C1') + accent('folHlink', '954F72')
    + '</a:clrScheme>'
    + '<a:fontScheme name="Semo0o"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
    + '<a:fmtScheme name="Semo0o"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
    + '<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>'
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
    + '</a:fmtScheme></a:themeElements></a:theme>';
}

function pptxSlideMasterXml() {
  return `${XML_HEADER}<p:sldMaster ${PPT_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>';
}

function pptxSlideLayoutXml() {
  return `${XML_HEADER}<p:sldLayout ${PPT_NS} type="title" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function pptxPresentationXml(slideCount) {
  const sldIds = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  return `${XML_HEADER}<p:presentation ${PPT_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + `<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

function pptxPresentationRels(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    + slides
    + `<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`
    + '</Relationships>';
}

function pptxContentTypes(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + slides
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
}

function pptxSlideRels() {
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
}

/** Build a real .pptx package from a title + slides. */
export async function createPptx({ title = '', slides = [], author, created } = {}) {
  const list = slides.length ? slides : [{ title, bullets: [] }];
  const zip = new JSZip();
  zip.file('[Content_Types].xml', pptxContentTypes(list.length));
  zip.file('_rels/.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>');
  zip.file('ppt/presentation.xml', pptxPresentationXml(list.length));
  zip.file('ppt/_rels/presentation.xml.rels', pptxPresentationRels(list.length));
  zip.file('ppt/slideMasters/slideMaster1.xml', pptxSlideMasterXml());
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', pptxSlideLayoutXml());
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  zip.file('ppt/theme/theme1.xml', pptxThemeXml());
  list.forEach((slide, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, pptxSlideXml({ title: slide.title ?? '', bullets: slide.bullets ?? [] }));
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, pptxSlideRels());
  });
  zip.file('docProps/core.xml', corePropsXml({ title, author, created }));
  zip.file('docProps/app.xml', appPropsXml('Semo0o Agent'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Read a .pptx back into { title, slides: [{ title, bullets }] }. */
export async function readPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    const shapeTexts = [];
    for (const shape of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const isTitle = /<p:ph type="title"/.test(shape[1]);
      const runs = [...shape[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
      shapeTexts.push({ isTitle, runs });
    }
    const title = shapeTexts.find((s) => s.isTitle)?.runs.join('') ?? '';
    const bullets = shapeTexts.filter((s) => !s.isTitle).flatMap((s) => s.runs);
    slides.push({ title, bullets });
  }
  return { title: slides[0]?.title ?? '', slides };
}

/** Edit a .pptx package in place (addSlide/setTitle/appendBullet/replace). */
export async function editPptx(buffer, ops = []) {
  const { slides } = await readPptx(buffer);
  const list = slides.map((s) => ({ title: s.title, bullets: [...s.bullets] }));
  for (const op of ops) {
    const type = String(op?.op || '').toLowerCase();
    if (type === 'addslide') list.push({ title: String(op.title ?? ''), bullets: [...(op.bullets ?? [])] });
    else if (type === 'settitle') {
      const index = (Number(op.slide) || 1) - 1;
      if (!list[index]) throw new Error(`SLIDE_NOT_FOUND:${op.slide}`);
      list[index].title = String(op.text ?? '');
    } else if (type === 'appendbullet') {
      const index = (Number(op.slide) || 1) - 1;
      if (!list[index]) throw new Error(`SLIDE_NOT_FOUND:${op.slide}`);
      list[index].bullets.push(String(op.text ?? ''));
    } else if (type === 'replace') {
      let found = false;
      for (const slide of list) {
        if (slide.title.includes(String(op.match ?? ''))) { slide.title = String(op.text ?? ''); found = true; break; }
        const bi = slide.bullets.findIndex((b) => b.includes(String(op.match ?? '')));
        if (bi !== -1) { slide.bullets[bi] = String(op.text ?? ''); found = true; break; }
      }
      if (!found) throw new Error(`EDIT_MATCH_NOT_FOUND:${op.match}`);
    } else throw new Error(`EDIT_OP_UNSUPPORTED:${op?.op}`);
  }
  const zip = await JSZip.loadAsync(buffer);
  zip.file('ppt/presentation.xml', pptxPresentationXml(list.length));
  zip.file('ppt/_rels/presentation.xml.rels', pptxPresentationRels(list.length));
  zip.file('[Content_Types].xml', pptxContentTypes(list.length));
  // Remove any stale slide parts beyond the new count, then (re)write all slides.
  for (const name of Object.keys(zip.files)) {
    const match = /^ppt\/slides\/(slide\d+\.xml|_rels\/slide\d+\.xml\.rels)$/.exec(name);
    if (match && Number(match[1].match(/(\d+)/)[1]) > list.length) zip.remove(name);
  }
  list.forEach((slide, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, pptxSlideXml({ title: slide.title, bullets: slide.bullets }));
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, pptxSlideRels());
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* -------------------------------------------------------------------------- */
/*  XLSX                                                                      */
/* -------------------------------------------------------------------------- */

const XLSX_STYLES = Object.freeze({ Normal: 0, Header: 1, Bold: 2, Italic: 3, Number: 4 });

function xlsxStylesXml() {
  return `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="5">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

function normalizeCell(cell) {
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    return { value: cell.value, formula: cell.formula, style: cell.style };
  }
  return { value: cell };
}

function xlsxCellXml(cell, ref) {
  const { value, formula, style } = normalizeCell(cell);
  const styleIndex = style != null ? (XLSX_STYLES[style] ?? (Number.isInteger(style) ? style : 0)) : 0;
  const styleAttr = styleIndex ? ` s="${styleIndex}"` : '';
  if (formula) return `<c r="${ref}"${styleAttr}><f>${escapeXml(formula)}</f><v>${escapeXml(value ?? 0)}</v></c>`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${styleAttr}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"${styleAttr}><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function xlsxSheetXml(rows) {
  const rowXml = rows.map((cells, rowIndex) => {
    const r = rowIndex + 1;
    const cellXml = (cells ?? []).map((cell, colIndex) => xlsxCellXml(cell, `${columnLetter(colIndex + 1)}${r}`)).join('');
    return `<row r="${r}">${cellXml}</row>`;
  }).join('');
  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

function normalizeSheet(sheet, index) {
  return { name: String(sheet?.name || `Sheet${index + 1}`).slice(0, 31), rows: (sheet?.rows ?? []).map((row) => [...row]) };
}

function xlsxWorkbookXml(sheets) {
  const sheetXml = sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets></workbook>`;
}

function xlsxWorkbookRels(sheets) {
  const sheetRels = sheets.map((sheet, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function xlsxContentTypes(sheets) {
  const sheetOverrides = sheets.map((sheet, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheetOverrides
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
}

async function writeXlsxParts(zip, sheets, { title, author, created }) {
  zip.file('[Content_Types].xml', xlsxContentTypes(sheets));
  zip.file('_rels/.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>');
  zip.file('xl/workbook.xml', xlsxWorkbookXml(sheets));
  zip.file('xl/_rels/workbook.xml.rels', xlsxWorkbookRels(sheets));
  zip.file('xl/styles.xml', xlsxStylesXml());
  sheets.forEach((sheet, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xlsxSheetXml(sheet.rows)));
  zip.file('docProps/core.xml', corePropsXml({ title, author, created }));
  zip.file('docProps/app.xml', appPropsXml('Semo0o Agent'));
}

/** Build a real .xlsx package from one or more sheets (rows of cells). */
export async function createXlsx({ title = '', sheets = [], author, created } = {}) {
  const list = (sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]).map(normalizeSheet);
  const zip = new JSZip();
  await writeXlsxParts(zip, list, { title, author, created });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Read an .xlsx back into { sheets: [{ name, rows }] } (values + formulas). */
export async function readXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = zip.file('xl/workbook.xml');
  if (!workbook) throw new Error('XLSX_INVALID:missing_workbook');
  const workbookXml = await workbook.async('string');
  const sheetDefs = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].map((m) => ({ name: unescapeXml(m[1]), rid: m[2] }));
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string') ?? '';
  const relMap = new Map([...rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [];
  for (const def of sheetDefs) {
    const target = relMap.get(def.rid) ?? `worksheets/sheet${sheets.length + 1}.xml`;
    const path = `xl/${target.replace(/^\//, '')}`;
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowIndex = Number(rowMatch[1]) - 1;
      const row = rows[rowIndex] ?? (rows[rowIndex] = []);
      for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
        const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
        const inner = cellMatch[2] ?? '';
        const refMatch = /r="([A-Za-z]+\d+)"/.exec(attrs);
        const colIndex = refMatch ? parseCellRef(refMatch[1]).column - 1 : row.length;
        const formula = /<f>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        const isStr = /t="(inlineStr|s)"/.test(attrs);
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
        let value;
        if (formula) value = raw !== undefined ? Number(raw) : null;
        else if (isStr) value = unescapeXml(inline ?? raw ?? '');
        else if (raw !== undefined) value = Number(raw);
        else value = null;
        row[colIndex] = formula ? { value, formula: unescapeXml(formula) } : value;
      }
    }
    sheets.push({ name: def.name, rows });
  }
  return { sheets };
}

/** Edit an .xlsx package in place (addSheet/setCell/appendRow/setFormula). */
export async function editXlsx(buffer, ops = []) {
  const { sheets } = await readXlsx(buffer);
  const list = sheets.map((s) => ({ name: s.name, rows: s.rows.map((row) => [...row]) }));
  const sheetIndex = (name) => {
    if (name == null) return 0;
    const index = list.findIndex((s) => s.name === name);
    if (index === -1) throw new Error(`SHEET_NOT_FOUND:${name}`);
    return index;
  };
  const ensure = (rowIndex, colIndex, sheet) => {
    while (sheet.rows.length <= rowIndex) sheet.rows.push([]);
    const row = sheet.rows[rowIndex];
    while (row.length <= colIndex) row.push(null);
  };
  for (const op of ops) {
    const type = String(op?.op || '').toLowerCase();
    if (type === 'addsheet') list.push(normalizeSheet({ name: op.name, rows: op.rows }, list.length));
    else if (type === 'setcell') {
      const sheet = list[sheetIndex(op.sheet)];
      const { row, column } = parseCellRef(op.ref);
      ensure(row - 1, column - 1, sheet);
      sheet.rows[row - 1][column - 1] = op.formula ? { value: op.value ?? 0, formula: op.formula } : (op.value ?? null);
    } else if (type === 'setformula') {
      const sheet = list[sheetIndex(op.sheet)];
      const { row, column } = parseCellRef(op.ref);
      ensure(row - 1, column - 1, sheet);
      sheet.rows[row - 1][column - 1] = { value: op.value ?? 0, formula: op.formula };
    } else if (type === 'appendrow') {
      const sheet = list[sheetIndex(op.sheet)];
      sheet.rows.push([...(op.values ?? [])]);
    } else throw new Error(`EDIT_OP_UNSUPPORTED:${op?.op}`);
  }
  const zip = await JSZip.loadAsync(buffer);
  // Remove stale sheet parts before rewriting (in case the count shrank).
  for (const name of Object.keys(zip.files)) {
    const match = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name);
    if (match && Number(match[1]) > list.length) zip.remove(name);
  }
  const core = await zip.file('docProps/core.xml')?.async('string') ?? '';
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? '';
  await writeXlsxParts(zip, list, { title: unescapeXml(title) });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Decode the five predefined XML entities. */
export function unescapeXml(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
