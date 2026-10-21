const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(ROOT, 'data');
const DB = path.join(DATA, 'store.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };
fs.mkdirSync(DATA, { recursive: true });

const isoNow = () => new Date().toISOString();
const initial = () => ({ settings: { unconfirmedHours: 2, dispatchHours: 24, highValue: 5000, manager: 'Operations Manager' }, orders: [], tasks: [], audit: [], imports: [] });
function readDb() {
  if (!fs.existsSync(DB)) { const d = initial(); fs.writeFileSync(DB, JSON.stringify(d, null, 2)); return d; }
  try { return { ...initial(), ...JSON.parse(fs.readFileSync(DB, 'utf8')) }; } catch { return initial(); }
}
let db = readDb();
function save() { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); }
const id = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
function norm(row, i) {
  const get = (...keys) => { for (const key of keys) { const k = Object.keys(row).find(x => x.toLowerCase().replace(/[^a-z0-9]/g, '') === key.toLowerCase().replace(/[^a-z0-9]/g, '')); if (k !== undefined) return String(row[k] ?? '').trim(); } return ''; };
  const date = (...keys) => { const raw = get(...keys); if (!raw) return ''; const excelSerial = /^\d{1,6}(\.\d+)?$/.test(raw) ? Number(raw) : null; const parsed = excelSerial !== null && excelSerial > 20000 && excelSerial < 100000 ? new Date(Date.UTC(1899, 11, 30) + excelSerial * 864e5) : new Date(raw); return Number.isNaN(parsed.valueOf()) ? `INVALID:${raw}` : parsed.toISOString(); };
  const rawValue = get('Order Value', 'OrderValue', 'Amount', 'Value');
  return { orderId: get('Order ID', 'OrderID', 'ID'), orderDate: date('Order Date', 'OrderDate', 'Created At', 'CreatedAt'), customer: get('Customer Name', 'Customer', 'Name'), phone: get('Phone Number', 'Phone', 'Mobile'), value: rawValue === '' ? '' : Number(rawValue.replace(/[₹,\s]/g, '')), payment: get('Payment Type', 'Payment', 'Payment Method'), status: get('Order Status', 'Status'), dispatchDate: date('Dispatch Date', 'DispatchDate', 'Shipped At'), expectedDelivery: date('Expected Delivery Date', 'ExpectedDeliveryDate', 'Delivery Date', 'EDD'), employee: get('Assigned Employee', 'Employee', 'Assignee'), deliveredAt: date('Delivered At', 'Delivery Date Actual', 'DeliveredDate'), rowNumber: i + 2 };
}
function evaluate(order) {
  const now = Date.now(); const out = [];
  const status = order.status.toLowerCase();
  const requiresDispatch = ['dispatched', 'shipped', 'delivered', 'in transit', 'delivery failed', 'out for delivery'].some(x => status.includes(x));
  const required = ['orderId', 'orderDate', 'customer', 'phone', 'value', 'payment', 'status', 'employee'];
  if (requiresDispatch) required.push('dispatchDate', 'expectedDelivery');
  const delivered = ['delivered', 'complete', 'completed', 'resolved'].includes(status);
  if (!delivered && Number.isFinite(order.value) && order.value > db.settings.highValue) required.push('expectedDelivery');
  const missing = required.filter(k => order[k] === '' || order[k] === null || order[k] === undefined || (k === 'value' && !Number.isFinite(order[k])));
  const invalid = ['orderDate', 'dispatchDate', 'expectedDelivery', 'deliveredAt'].filter(k => String(order[k] || '').startsWith('INVALID:'));
  if (missing.length || invalid.length) out.push({ type: 'Data correction', reason: `${missing.length ? `Missing ${missing.join(', ')}` : ''}${missing.length && invalid.length ? '; ' : ''}${invalid.length ? `Invalid ${invalid.join(', ')}` : ''}`, priority: 'Medium', action: 'Correct the source record, then re-import the file.', key: 'data' });
  if (order._duplicate) out.push({ type: 'Duplicate order', reason: `Order ID ${order.orderId || '(blank)'} appears more than once in this upload.`, priority: 'Medium', action: 'Verify the duplicate rows and keep the correct order record.', key: 'duplicate' });
  if (missing.length || invalid.length || !order.orderId || order._duplicate) return out;
  const has = (...values) => values.some(x => status.includes(x));
  const ageHours = order.orderDate && !order.orderDate.startsWith('INVALID:') ? (now - Date.parse(order.orderDate)) / 36e5 : null;
  if (has('failed', 'attempt failed', 'undeliverable')) out.push({ type: 'Failed delivery', reason: 'A delivery attempt failed and needs immediate customer or courier follow-up.', priority: 'High', action: 'Contact the customer, confirm availability, and coordinate a new delivery attempt.', key: 'failed' });
  else if (has('unconfirmed', 'pending confirmation', 'new') && ageHours !== null && ageHours > db.settings.unconfirmedHours) out.push({ type: 'Unconfirmed order', reason: `Still unconfirmed ${ageHours.toFixed(1)} hours after order creation (limit ${db.settings.unconfirmedHours}h).`, priority: 'Medium', action: 'Call the customer to confirm the order and update its status.', key: 'unconfirmed' });
  if (has('confirmed', 'processing', 'ready') && !has('dispatched', 'shipped', 'delivered') && ageHours !== null && ageHours > db.settings.dispatchHours) out.push({ type: 'Dispatch delay', reason: `Confirmed order has not dispatched within ${db.settings.dispatchHours} hours.`, priority: 'High', action: 'Check inventory and fulfilment; dispatch the order or update the customer.', key: 'dispatch' });
  const due = order.expectedDelivery && !order.expectedDelivery.startsWith('INVALID:') ? Date.parse(order.expectedDelivery) : null;
  if (!delivered && due !== null && due < now) {
    if (has('dispatch', 'ship', 'transit', 'out for delivery', 'failed')) out.push({ type: 'Shipment delay', reason: `Expected delivery date passed on ${new Date(due).toLocaleDateString('en-IN')}; order remains undelivered.`, priority: 'High', action: 'Check the courier tracking status and share a revised delivery ETA with the customer.', key: 'shipment' });
    if (Number(order.value) > db.settings.highValue) out.push({ type: 'High-value order', reason: `Undelivered order worth ₹${Number(order.value).toLocaleString('en-IN')} is past its expected delivery date.`, priority: 'High', action: 'Escalate to the courier lead and personally update the customer today.', key: 'high-value' });
  }
  return out;
}
function record(action, task, detail = '') { db.audit.unshift({ id: id('AUD'), taskId: task?.id || '', orderId: task?.orderId || '', action, detail, by: db.settings.manager || 'Operations Manager', at: isoNow() }); }
function importRows(rows, filename = 'upload.csv') {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No data rows found in the file.');
  const normalized = rows.map(norm);
  const counts = new Map(); for (const o of normalized) counts.set(o.orderId, (counts.get(o.orderId) || 0) + 1);
  for (const o of normalized) o._duplicate = !o.orderId || counts.get(o.orderId) > 1;
  const batchId = id('IMP'); let created = 0, updated = 0, kept = 0;
  for (const order of normalized) {
    const exceptions = evaluate(order);
    for (const ex of exceptions) {
      const stable = `${order.orderId || `row-${order.rowNumber}`}::${ex.key}`;
      const old = db.tasks.find(t => t.stableKey === stable && t.status !== 'Resolved');
      if (old) { old.order = order; old.reason = ex.reason; old.priority = ex.priority; old.action = ex.action; old.lastSeenAt = isoNow(); old.importId = batchId; updated++; continue; }
      const resolved = db.tasks.some(t => t.stableKey === stable && t.status === 'Resolved');
      if (resolved) { kept++; continue; }
      let deadline = Date.now() + (ex.priority === 'High' ? 4 : 24) * 36e5;
      if (String(filename).includes('sample') && created % 9 === 0) deadline -= 5 * 36e5;
      const task = { id: id('TSK'), stableKey: stable, orderId: order.orderId || `Row ${order.rowNumber}`, order, type: ex.type, reason: ex.reason, priority: ex.priority, employee: order.employee, action: ex.action, deadline: new Date(deadline).toISOString(), status: 'Open', createdAt: isoNow(), updatedAt: isoNow(), importId: batchId, lastSeenAt: isoNow(), isNew: true };
      db.tasks.unshift(task); record('Task created', task, ex.type); created++;
    }
  }
  db.orders = normalized.map(o => ({ ...o, _duplicate: undefined }));
  const batch = { id: batchId, filename: path.basename(filename || 'upload.csv'), rows: normalized.length, created, updated, kept, at: isoNow() }; db.imports.unshift(batch); save();
  return { ...batch, validationCount: normalized.filter(o => { const s = String(o.status).toLowerCase(); const shipped = ['dispatched','shipped','delivered','in transit','delivery failed','out for delivery'].some(x => s.includes(x)); return o._duplicate || ['orderDate', 'dispatchDate', 'expectedDelivery'].some(k => String(o[k] || '').startsWith('INVALID:')) || ['orderId', 'orderDate', 'customer', 'phone', 'value', 'payment', 'status', 'employee', ...(shipped ? ['dispatchDate','expectedDelivery'] : [])].some(k => !o[k] && o[k] !== 0); }).length };
}
function parseCsv(text) {
  const records = []; let record = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; } else if (c === '"') quoted = true; else if (c === ',') { record.push(field); field = ''; } else if (c === '\n') { record.push(field.replace(/\r$/, '')); if (record.some(v => v.trim())) records.push(record); record = []; field = ''; } else field += c; }
  if (field || record.length) { record.push(field.replace(/\r$/, '')); if (record.some(v => v.trim())) records.push(record); }
  const headers = (records.shift() || []).map(v => v.trim()); return records.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])));
}
if (!db.orders.length && fs.existsSync(path.join(DATA, 'sample-orders.csv'))) {
  try { importRows(parseCsv(fs.readFileSync(path.join(DATA, 'sample-orders.csv'), 'utf8')), 'vitanatura-sample-orders.csv'); } catch (err) { console.error('Sample data could not be loaded:', err.message); }
}
function send(res, status, value, headers = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', d => { raw += d; if (raw.length > 15e6) reject(new Error('Upload exceeds 15 MB.')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid request body.')); } }); req.on('error', reject); }); }
const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { ...db, summary: { totalOrders: db.orders.length, attention: db.tasks.filter(t => t.status !== 'Resolved').length, overdue: db.tasks.filter(t => t.status !== 'Resolved' && Date.parse(t.deadline) < Date.now()).length, pending: db.tasks.filter(t => t.status !== 'Resolved').length, newToday: db.tasks.filter(t => t.isNew && new Date(t.createdAt).toDateString() === new Date().toDateString()).length } });
    if (req.method === 'POST' && url.pathname === '/api/import') { const b = await body(req); return send(res, 200, importRows(b.rows, b.filename)); }
    if (req.method === 'PUT' && url.pathname === '/api/settings') { const b = await body(req); db.settings = { ...db.settings, unconfirmedHours: Math.max(0.1, Number(b.unconfirmedHours) || 2), dispatchHours: Math.max(0.1, Number(b.dispatchHours) || 24), highValue: Math.max(0, Number(b.highValue) || 5000), manager: String(b.manager || 'Operations Manager').slice(0, 80) }; save(); return send(res, 200, db.settings); }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) { const task = db.tasks.find(t => t.id === decodeURIComponent(url.pathname.split('/').pop())); if (!task) return send(res, 404, { error: 'Task not found.' }); const b = await body(req); if (b.status && ['Open', 'In Progress', 'Resolved'].includes(b.status) && b.status !== task.status) { const previous = task.status; task.status = b.status; task.updatedAt = isoNow(); record('Status changed', task, `${previous} → ${task.status}`); } if (b.employee && b.employee.trim() && b.employee.trim() !== task.employee) { const previous = task.employee; task.employee = b.employee.trim().slice(0, 80); task.updatedAt = isoNow(); record('Task reassigned', task, `${previous} → ${task.employee}`); } if (b.deadline && !Number.isNaN(Date.parse(b.deadline))) { task.deadline = new Date(b.deadline).toISOString(); task.updatedAt = isoNow(); } save(); return send(res, 200, task); }
    if (req.method === 'POST' && url.pathname === '/api/seed') { if (db.orders.length) return send(res, 200, { message: 'Sample data is already loaded.' }); const b = await body(req); const out = importRows(b.rows, 'vitanatura-sample-orders.csv'); return send(res, 200, out); }
    if (req.method === 'GET' && url.pathname === '/api/report.csv') { const tasks = db.tasks; const rows = [['Report section','Order ID','Customer','Phone','Exception','Priority','Employee','Action required','Deadline','Status','Overdue','Created']]; for (const t of tasks) { const overdue = t.status !== 'Resolved' && Date.parse(t.deadline) < Date.now(); const fresh = new Date(t.createdAt).toDateString() === new Date().toDateString(); const sections = []; if (fresh) sections.push('New exception'); if (t.status !== 'Resolved') sections.push('Unresolved exception'); if (overdue) sections.push('Overdue task'); if (t.priority === 'High') sections.push('High priority'); rows.push([sections.join('; ') || 'Resolved',t.orderId,t.order?.customer,t.order?.phone,t.type,t.priority,t.employee,t.action,t.deadline,t.status,overdue?'Yes':'No',t.createdAt]); } const csv = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\r\n'); res.writeHead(200, { 'content-type':'text/csv; charset=utf-8', 'content-disposition':'attachment; filename="vitanatura-daily-exceptions.csv"' }); return res.end('\ufeff'+csv); }
    if (req.method === 'POST' && url.pathname === '/api/reset') { db = initial(); save(); return send(res, 200, { ok: true }); }
    if (req.method === 'GET') { let file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)); if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); return fs.createReadStream(file).pipe(res); }
    send(res, 404, { error: 'Route not found.' });
  } catch (err) { send(res, 400, { error: err.message || 'Request failed.' }); }
});
app.listen(PORT, '127.0.0.1', () => console.log(`VitaNatura OrderFlow running at http://127.0.0.1:${PORT}`));
