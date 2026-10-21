const fs = require('node:fs');
const http = require('node:http');

const text = fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'sample-orders.csv'), 'utf8');
const records = []; let row = [], cell = '', quote = false;
for (let i = 0; i < text.length; i++) { const c = text[i]; if (quote) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quote = false; else cell += c; } else if (c === '"') quote = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); if (row.some(v => v.trim())) records.push(row); row = []; cell = ''; } else cell += c; }
if (cell || row.length) { row.push(cell.replace(/\r$/, '')); records.push(row); }
const headers = records.shift();
const body = JSON.stringify({ filename: 'vitanatura-sample-orders.csv', rows: records.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))) });
const req = http.request({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/api/seed', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { let result = ''; res.setEncoding('utf8'); res.on('data', d => result += d); res.on('end', () => { console.log(`HTTP ${res.statusCode}: ${result}`); if (res.statusCode >= 400) process.exitCode = 1; }); });
req.on('error', err => { console.error(err.message); process.exitCode = 1; }); req.end(body);
