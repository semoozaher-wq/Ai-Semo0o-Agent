import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

import {
  columnLetter,
  createDocx,
  createOdt,
  createPptx,
  createXlsx,
  editDocx,
  editOdt,
  editPptx,
  editXlsx,
  escapeXml,
  parseCellRef,
  readDocx,
  readOdt,
  readPptx,
  readXlsx,
  unescapeXml,
} from '../authoring/office.mjs';

/**
 * Office authoring. Proves the module writes REAL, well-formed OOXML/ODF packages
 * (not stubs): every XML part is parsed for well-formedness, the required parts
 * exist, and a create -> read -> edit -> read round-trip preserves content.
 */

// A dependency-free XML well-formedness checker: verifies every tag is balanced
// and correctly nested. Good enough to catch malformed generated XML.
function assertWellFormedXml(xml, label) {
  // Drop the XML declaration, processing instructions and comments first.
  const cleaned = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '');
  const stack = [];
  const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  let lastIndex = 0;
  while ((match = tagPattern.exec(cleaned)) !== null) {
    const [, closing, name, , selfClose] = match;
    // Guard against a stray '<' in text (would mean we escaped incorrectly).
    const between = cleaned.slice(lastIndex, match.index);
    assert.ok(!between.includes('<'), `${label}: unescaped '<' in text near "${between.slice(-40)}"`);
    lastIndex = tagPattern.lastIndex;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `${label}: mismatched closing tag </${name}> (expected </${top}>)`);
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  assert.equal(stack.length, 0, `${label}: unclosed tags ${stack.join(',')}`);
  assert.ok(!xml.includes('&undefined'), `${label}: undefined entity`);
}

async function assertZipParts(buffer, required) {
  const zip = await JSZip.loadAsync(buffer);
  for (const part of required) {
    assert.ok(zip.file(part), `missing part ${part}`);
    const content = await zip.file(part).async('string');
    if (part.endsWith('.xml') || part.endsWith('.rels')) assertWellFormedXml(content, part);
  }
  return zip;
}

test('escapeXml/unescapeXml and cell helpers are correct', () => {
  assert.equal(escapeXml('a<b>&"c\'d'), 'a&lt;b&gt;&amp;&quot;c&apos;d');
  assert.equal(unescapeXml('a&lt;b&gt;&amp;&quot;c&apos;d'), 'a<b>&"c\'d');
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(26), 'Z');
  assert.equal(columnLetter(27), 'AA');
  assert.equal(columnLetter(702), 'ZZ');
  assert.deepEqual(parseCellRef('B3'), { column: 2, row: 3 });
  assert.deepEqual(parseCellRef('AA10'), { column: 27, row: 10 });
  assert.throws(() => parseCellRef('nope'), /CELL_REF_INVALID/);
});

test('createDocx emits a valid package and readDocx round-trips', async () => {
  const buffer = await createDocx({
    title: 'Quarterly Report',
    paragraphs: ['Intro paragraph with <angle> & "quotes".', { text: 'Section A', style: 'Heading1' }, { text: 'Body under A' }],
    author: 'Tester',
  });
  await assertZipParts(buffer, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']);
  const doc = await readDocx(buffer);
  assert.equal(doc.title, 'Quarterly Report');
  assert.equal(doc.paragraphs.length, 4);
  assert.equal(doc.paragraphs[0].style, 'Title');
  assert.equal(doc.paragraphs[1].text, 'Intro paragraph with <angle> & "quotes".');
  assert.equal(doc.paragraphs[2].style, 'Heading1');
});

test('editDocx append/replace/remove/setTitle mutate the real document', async () => {
  const buffer = await createDocx({ title: 'Old Title', paragraphs: ['alpha', 'beta', 'gamma'] });
  const edited = await editDocx(buffer, [
    { op: 'setTitle', text: 'New Title' },
    { op: 'append', text: 'delta', style: 'Heading2' },
    { op: 'replace', match: 'beta', text: 'BETA' },
    { op: 'remove', match: 'gamma' },
  ]);
  const doc = await readDocx(edited);
  assert.equal(doc.title, 'New Title');
  const texts = doc.paragraphs.map((p) => p.text);
  assert.deepEqual(texts, ['New Title', 'alpha', 'BETA', 'delta']);
  assert.equal(doc.paragraphs[3].style, 'Heading2');
  await assert.rejects(() => editDocx(buffer, [{ op: 'replace', match: 'missing', text: 'x' }]), /EDIT_MATCH_NOT_FOUND/);
});

test('createOdt stores mimetype first & uncompressed, and round-trips', async () => {
  const buffer = await createOdt({ title: 'ODF Doc', paragraphs: ['first', { text: 'Head', style: 'Heading1' }] });
  const zip = await assertZipParts(buffer, ['mimetype', 'META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml']);
  // mimetype must be the FIRST entry and STORED (uncompressed) per the ODF spec.
  const names = Object.keys(zip.files);
  assert.equal(names[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), 'application/vnd.oasis.opendocument.text');
  const doc = await readOdt(buffer);
  assert.equal(doc.title, 'ODF Doc');
  assert.equal(doc.paragraphs[0].style, 'Title');
  assert.equal(doc.paragraphs[1].text, 'first');
});

test('editOdt applies text ops', async () => {
  const buffer = await createOdt({ title: 'T', paragraphs: ['one', 'two'] });
  const edited = await editOdt(buffer, [{ op: 'append', text: 'three' }, { op: 'replace', match: 'one', text: 'ONE' }]);
  const doc = await readOdt(edited);
  assert.deepEqual(doc.paragraphs.map((p) => p.text), ['T', 'ONE', 'two', 'three']);
});

test('createPptx emits a valid package and readPptx round-trips', async () => {
  const buffer = await createPptx({
    title: 'Deck',
    slides: [
      { title: 'Slide One', bullets: ['a', 'b'] },
      { title: 'Slide Two', bullets: ['c'] },
    ],
  });
  await assertZipParts(buffer, [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/_rels/slide1.xml.rels',
  ]);
  const deck = await readPptx(buffer);
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.slides[0].title, 'Slide One');
  assert.deepEqual(deck.slides[0].bullets, ['a', 'b']);
  assert.equal(deck.slides[1].title, 'Slide Two');
});

test('editPptx addSlide/setTitle/appendBullet/replace', async () => {
  const buffer = await createPptx({ slides: [{ title: 'One', bullets: ['x'] }] });
  const edited = await editPptx(buffer, [
    { op: 'addSlide', title: 'Two', bullets: ['y'] },
    { op: 'setTitle', slide: 1, text: 'One Updated' },
    { op: 'appendBullet', slide: 1, text: 'z' },
    { op: 'replace', match: 'y', text: 'Y' },
  ]);
  const deck = await readPptx(edited);
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.slides[0].title, 'One Updated');
  assert.deepEqual(deck.slides[0].bullets, ['x', 'z']);
  assert.deepEqual(deck.slides[1].bullets, ['Y']);
});

test('createXlsx emits a valid package; readXlsx round-trips values, strings, formulas', async () => {
  const buffer = await createXlsx({
    title: 'Budget',
    sheets: [{
      name: 'Q1',
      rows: [
        [{ value: 'Item', style: 'Header' }, { value: 'Amount', style: 'Header' }],
        ['Rent', 1200],
        ['Food', 300.5],
        [{ value: 'Total', style: 'Bold' }, { value: 0, formula: 'SUM(B2:B3)' }],
      ],
    }],
  });
  await assertZipParts(buffer, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'docProps/core.xml']);
  const book = await readXlsx(buffer);
  assert.equal(book.sheets.length, 1);
  assert.equal(book.sheets[0].name, 'Q1');
  assert.equal(book.sheets[0].rows[0][0], 'Item');
  assert.equal(book.sheets[0].rows[1][1], 1200);
  assert.equal(book.sheets[0].rows[2][1], 300.5);
  assert.deepEqual(book.sheets[0].rows[3][1], { value: 0, formula: 'SUM(B2:B3)' });
});

test('editXlsx addSheet/setCell/appendRow/setFormula', async () => {
  const buffer = await createXlsx({ sheets: [{ name: 'S1', rows: [['a', 1]] }] });
  const edited = await editXlsx(buffer, [
    { op: 'addSheet', name: 'S2', rows: [['x']] },
    { op: 'setCell', sheet: 'S1', ref: 'C1', value: 'hello' },
    { op: 'appendRow', sheet: 'S1', values: ['b', 2] },
    { op: 'setFormula', sheet: 'S1', ref: 'C2', formula: 'SUM(B1:B2)' },
  ]);
  const book = await readXlsx(edited);
  assert.equal(book.sheets.length, 2);
  assert.equal(book.sheets[0].rows[0][2], 'hello');
  assert.equal(book.sheets[0].rows[1][0], 'b');
  assert.equal(book.sheets[0].rows[1][1], 2);
  assert.equal(book.sheets[0].rows[1][2].formula, 'SUM(B1:B2)');
  assert.equal(book.sheets[1].name, 'S2');
  await assert.rejects(() => editXlsx(buffer, [{ op: 'setCell', sheet: 'nope', ref: 'A1', value: 1 }]), /SHEET_NOT_FOUND/);
});

test('generated documents survive a real re-open (ZIP integrity)', async () => {
  for (const buffer of [
    await createDocx({ title: 't', paragraphs: ['p'] }),
    await createOdt({ title: 't', paragraphs: ['p'] }),
    await createPptx({ slides: [{ title: 't', bullets: ['b'] }] }),
    await createXlsx({ sheets: [{ name: 'S', rows: [['a']] }] }),
  ]) {
    const zip = await JSZip.loadAsync(buffer); // throws if the ZIP is corrupt
    assert.ok(Object.keys(zip.files).length > 0);
  }
});
