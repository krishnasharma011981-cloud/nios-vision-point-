export function formatDateTime(ts: unknown): string {
  if (!ts) return '—';
  let date: Date | null = null;
  if (typeof ts === 'string' || typeof ts === 'number') {
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  } else if (typeof ts === 'object' && ts !== null && 'toDate' in ts && typeof (ts as { toDate: () => Date }).toDate === 'function') {
    date = (ts as { toDate: () => Date }).toDate();
  } else if (typeof ts === 'object' && ts !== null && 'seconds' in ts) {
    date = new Date(Number((ts as { seconds: number }).seconds) * 1000);
  }
  if (!date) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeCsvCell(val: unknown): string {
  const str = String(val ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToCsv(filename: string, headers: string[], rows: Array<Array<unknown>>): void {
  const csvLines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    csvLines.push(row.map(escapeCsvCell).join(','));
  }
  const blob = new Blob(['\uFEFF' + csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

function escapeXml(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function exportToExcel(filename: string, sheetName: string, headers: string[], rows: Array<Array<unknown>>): void {
  const headerXml = `<Row>${headers
    .map((h) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`)
    .join('')}</Row>`;
  const rowsXml = rows
    .map(
      (row) =>
        `<Row>${row
          .map((cell) => {
            const isNum = typeof cell === 'number' && Number.isFinite(cell);
            return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(cell)}</Data></Cell>`;
          })
          .join('')}</Row>`,
    )
    .join('');

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#000000" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escapeXml(sheetName.slice(0, 31))}">
  <Table>${headerXml}${rowsXml}</Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.xls') ? filename : `${filename}.xls`);
}

export function exportJsonBackup(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.json') ? filename : `${filename}.json`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseCsvText(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      current.push(cell.trim());
      cell = '';
    } else if (ch === '\r' && next === '\n') {
      current.push(cell.trim());
      if (current.some((c) => c.length > 0)) rows.push(current);
      current = [];
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      current.push(cell.trim());
      if (current.some((c) => c.length > 0)) rows.push(current);
      current = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  current.push(cell.trim());
  if (current.some((c) => c.length > 0)) rows.push(current);

  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
}
