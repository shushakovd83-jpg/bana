// A single-sheet XLSX export. All guest-supplied strings are literal inline text cells.
const encoder = new TextEncoder();
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (~crc) >>> 0;
}

// ZIP "store" records keep the export synchronous and independent of Node or a compression library.
function archive(files) {
  const chunks = [], directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [name, xml] of Object.entries(files)) {
    const path = encoder.encode(name);
    const data = encoder.encode(declaration + xml);
    const crc = crc32(data);
    const local = new Uint8Array(30 + path.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(12, 0x21, true); // DOS date 1980-01-01.
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, path.length, true);
    local.set(path, 30);

    const central = new Uint8Array(46 + path.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    central.set(local.subarray(4, 30), 6);
    cv.setUint32(42, offset, true);
    central.set(path, 46);
    chunks.push(local, data);
    directory.push(central);
    offset += local.length + data.length;
    directorySize += central.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, directory.length, true);
  ev.setUint16(10, directory.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directorySize + end.length);
  let position = 0;
  for (const chunk of [...chunks, ...directory, end]) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

function xmlText(value) {
  // Escape SpreadsheetML's special _xHHHH_ notation before escaping XML delimiters.
  return String(value).replace(/_x[0-9a-f]{4}_/gi, match => '_x005F_' + match.slice(1))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const columns = [
  ['Дата приезда', 16, 2], ['Начало', 12, 3], ['Имя гостя', 24], ['Телефон', 23],
  ['Гости', 11], ['Часы', 11], ['Окончание', 15, 3], ['Тариф', 22], ['Статус', 18],
  ['Стоимость', 17, 4], ['Зачтено при подтверждении', 24, 4], ['Остаток после подтверждения', 27, 4],
  ['Прежние дата и время', 26], ['Версия записи', 16], ['Заявка получена', 23, 5], ['Номер заявки', 39]
];
const statuses = new Map([['new','Новая'],['confirmed','Подтверждена'],['cancelled','Отменена']]);
const tariffs = new Map([['bath','Только баня'],['barrel','Баня с бочкой']]);
const dayMS = 86400000;
const excelEpochOffset = 25569;

function timeFraction(value) {
  const match = /^(\d\d):(\d\d)$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return (Number(match[1]) * 60 + Number(match[2])) / 1440;
}

function excelDate(day) {
  const millis = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(millis) ? millis / dayMS + excelEpochOffset : null;
}

function bookingValues(row) {
  const hours = Number(row.hours);
  const count = Number(row.guests);
  const validHours = Number.isFinite(hours) && hours > 0;
  const start = timeFraction(row.start);
  const confirmed = row.status === 'confirmed';
  const price = validHours && tariffs.has(row.tariff)
    ? (row.tariff === 'barrel' ? 4500 + 1500 * hours : 1800 * hours) : null;
  const created = Date.parse(row.created);
  // Booking times are local to Chaykovsky (UTC+5), including the displayed receipt time.
  return [
    excelDate(row.day) ?? row.day, start ?? row.start, row.guestName, row.phone == null ? null : String(row.phone),
    Number.isInteger(count) && count > 0 ? count : null, validHours ? hours : null,
    start !== null && validHours ? start + hours / 24 : null,
    tariffs.get(row.tariff) ?? row.tariff, statuses.get(row.status) ?? row.status,
    price, confirmed ? 1000 : null, confirmed && price !== null ? price - 1000 : null,
    row.previous, row.version, Number.isFinite(created) ? (created / dayMS + excelEpochOffset + 5 / 24) : row.created,
    row.id == null ? null : String(row.id)
  ];
}

function rowXml(values, index, header = false) {
  const cells = values.map((value, i) => {
    const ref = String.fromCharCode(65 + i) + index;
    const style = header ? 1 : columns[i][2] ?? 0;
    if (value == null || value === '') return '<c r="' + ref + '" s="' + style + '"/>';
    if (typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xmlText(value) + '</t></is></c>';
  }).join('');
  return '<row r="' + index + '"' + (header ? ' ht="36" customHeight="1"' : '') + '>' + cells + '</row>';
}

const styles = '<styleSheet xmlns="' + sheetNs + '">' +
  '<numFmts count="4"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="#,##0&quot; ₽&quot;"/><numFmt numFmtId="167" formatCode="dd.mm.yyyy hh:mm"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF66442E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  [164,165,166,167].map(id => '<xf numFmtId="' + id + '" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>').join('') +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function relationships(entries) {
  return '<Relationships xmlns="' + packageRels + '">' + entries.map(([id, type, target]) =>
    '<Relationship Id="' + id + '" Type="' + relNs + '/' + type + '" Target="' + target + '"/>').join('') + '</Relationships>';
}

export function excel(rows) {
  if (!Array.isArray(rows) || rows.length > 1048575) throw new RangeError('Invalid number of workbook rows');
  const last = Math.max(2, rows.length + 1);
  const range = 'A1:P' + last;
  const data = rows.length ? rows.map((row,i) => rowXml(bookingValues(row), i + 2)).join('') : '<row r="2"/>';
  const sheet = '<worksheet xmlns="' + sheetNs + '" xmlns:r="' + relNs + '"><dimension ref="' + range + '"/>' +
    '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<cols>' + columns.map((col,i) => '<col min="' + (i+1) + '" max="' + (i+1) + '" width="' + col[1] + '" customWidth="1"/>').join('') + '</cols>' +
    '<sheetData>' + rowXml(columns.map(col=>col[0]), 1, true) + data + '</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>';
  const table = '<table xmlns="' + sheetNs + '" id="1" name="Bookings" displayName="Bookings" ref="' + range + '" totalsRowShown="0"><autoFilter ref="' + range + '"/><tableColumns count="' + columns.length + '">' +
    columns.map((col,i) => '<tableColumn id="' + (i+1) + '" name="' + xmlText(col[0]) + '"/>').join('') +
    '</tableColumns><tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>';
  const contentTypes = [
    ['xl/workbook.xml','sheet.main'], ['xl/styles.xml','styles'], ['xl/worksheets/sheet1.xml','worksheet'], ['xl/tables/table1.xml','table']
  ];
  return archive({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      contentTypes.map(([file,type]) => '<Override PartName="/' + file + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.' + type + '+xml"/>').join('') + '</Types>',
    '_rels/.rels': relationships([['rId1','officeDocument','xl/workbook.xml']]),
    'xl/workbook.xml': '<workbook xmlns="' + sheetNs + '" xmlns:r="' + relNs + '"><sheets><sheet name="Брони" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships([['rId1','worksheet','worksheets/sheet1.xml'],['rId2','styles','styles.xml']]),
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': sheet,
    'xl/worksheets/_rels/sheet1.xml.rels': relationships([['rId1','table','../tables/table1.xml']]),
    'xl/tables/table1.xml': table
  });
}
