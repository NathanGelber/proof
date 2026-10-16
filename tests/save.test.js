// Regression tests for what ends up inside a saved file. Each test plants a secret string
// somewhere it must not survive (a deleted page, a note under a redaction, metadata) and
// checks the bytes Proof would write.
// Run with `npm test` (node --test, with tests/stubs.mjs standing in for pdf.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as mu from 'mupdf';
import { compose, finalize } from '../src/engine.js';

/** Every string in the file, with streams decompressed and unreferenced objects kept, so nothing hides. */
function rawText(bytes, password = '') {
  const d = mu.Document.openDocument(bytes, 'application/pdf');
  if (password) d.authenticatePassword(password);
  const s = Buffer.from(d.saveToBuffer('decompress,encrypt=none').asUint8Array()).toString('latin1');
  d.destroy?.();
  // pdf-lib writes text as hex strings; MuPDF as literals. Decode the hex ones too.
  return s + s.replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s/g, ''), 'hex').toString('latin1'));
}
const has = (bytes, secret, pw) => rawText(bytes, pw).includes(secret);

async function twoPages() {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText('KEEP-THIS-PAGE', { x: 50, y: 700, font: f, size: 20 });
  d.addPage([595, 842]).drawText('DELETED-PAGE-SECRET', { x: 50, y: 700, font: f, size: 20 });
  return d.save();
}
const docOf = bytes => ({ id: 'd1', name: 'test.pdf', bytes, values: {}, xfa: false, fields: [] });
const page = (doc, idx, items = []) => ({ doc, idx, rot: 0, items });
const opts = (o = {}) => ({ flatten: false, strip: false, stamps: null, compress: false, password: '', ...o });

/** One page with SECRET-TEXT at PDF (100, 700), a sticky note on it, a sticky note far away, and metadata. */
function redactionFixture({ bookmark = false } = {}) {
  const doc = new mu.PDFDocument();
  const font = doc.addSimpleFont(new mu.Font('Helvetica'));
  const pg = doc.addPage([0, 0, 595, 842], 0, doc.addObject({ Font: { F1: font } }), 'BT /F1 24 Tf 100 700 Td (SECRET-TEXT) Tj ET BT /F1 24 Tf 100 300 Td (VISIBLE-TEXT) Tj ET');
  doc.insertPage(-1, pg);
  const p = doc.loadPage(0);
  // MuPDF annotation rects are top-down: PDF y=700 is MuPDF y=142.
  const under = p.createAnnotation('Text'); under.setRect([120, 125, 140, 145]); under.setContents('SECRET-STICKY'); under.update();
  const away = p.createAnnotation('Text'); away.setRect([500, 700, 520, 720]); away.setContents('UNRELATED-NOTE'); away.update();
  doc.setMetaData('info:Title', 'SECRET-TITLE');
  if (bookmark) doc.outlineIterator().insert({ title: 'Chapter', uri: '#page=1' });
  const bytes = doc.saveToBuffer('').asUint8Array().slice();
  doc.destroy?.();
  return bytes;
}
// PDF user space: a box over SECRET-TEXT only.
const box = { type: 'redact', x: 90, y: 690, w: 250, h: 40, theta: 0 };

describe('deleted pages', () => {
  it('are gone with compression off', async () => {
    const d = docOf(await twoPages());
    const { bytes } = await compose([page(d, 0)], opts());
    assert.ok(has(bytes, 'KEEP-THIS-PAGE'));
    assert.ok(!has(bytes, 'DELETED-PAGE-SECRET'));
  });
  it('are gone with compression off and a password', async () => {
    const d = docOf(await twoPages());
    const { bytes } = await compose([page(d, 0)], opts({ password: 'pw-123' }));
    assert.ok(has(bytes, 'KEEP-THIS-PAGE', 'pw-123'));
    assert.ok(!has(bytes, 'DELETED-PAGE-SECRET', 'pw-123'));
  });
});

describe('metadata stripping', () => {
  it('removes the XMP stream itself, not just the link to it', async () => {
    const ld = await PDFDocument.create(); ld.addPage();
    const xmp = ld.context.flateStream('<x:xmpmeta>SECRET-XMP</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' });
    ld.catalog.set(PDFName.of('Metadata'), ld.context.register(xmp));
    ld.setTitle('SECRET-TITLE');
    const { bytes } = await compose([page(docOf(await ld.save()), 0)], opts({ strip: true }));
    assert.ok(!has(bytes, 'SECRET-XMP'));
    assert.ok(!has(bytes, 'SECRET-TITLE'));
  });
});

describe('redaction', () => {
  it('removes the text and the note under the box, keeps the rest', async () => {
    const d = docOf(redactionFixture());
    const { bytes } = await compose([page(d, 0, [box])], opts());
    assert.ok(!has(bytes, 'SECRET-TEXT'));
    assert.ok(!has(bytes, 'SECRET-STICKY'));
    assert.ok(has(bytes, 'VISIBLE-TEXT'));
    assert.ok(has(bytes, 'UNRELATED-NOTE'));
  });
  it('strips metadata even when Strip metadata is off', async () => {
    const d = docOf(redactionFixture());
    const { bytes } = await compose([page(d, 0, [box])], opts({ strip: false }));
    assert.ok(!has(bytes, 'SECRET-TITLE'));
  });
  it('warns about bookmarks', async () => {
    const withBm = await compose([page(docOf(redactionFixture({ bookmark: true })), 0, [box])], opts());
    assert.match(withBm.errs.join(' '), /bookmarks/);
    const without = await compose([page(docOf(redactionFixture()), 0, [box])], opts());
    assert.doesNotMatch(without.errs.join(' '), /bookmarks/);
  });
});

describe('passwords', () => {
  it('refuses a comma instead of passing it to MuPDF', async () => {
    const bytes = await twoPages();
    await assert.rejects(finalize(bytes, { password: 'abc,encrypt=none' }), /comma/);
  });
});
