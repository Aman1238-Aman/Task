const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(ROOT, 'data');
const DB = path.resolve(process.env.ORDERFLOW_DB || path.join(DATA, 'store.sqlite'));
const IS_DEFAULT_DB = DB === path.resolve(path.join(DATA, 'store.sqlite'));
const LEGACY_DB = path.join(DATA, 'store.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.dirname(DB), { recursive: true });

const isoNow = () => new Date().toISOString();
const initial = () => ({ settings: { unconfirmedHours: 2, dispatchHours: 24, highValue: 5000, manager: 'Operations Manager' }, orders: [], tasks: [], audit: [], imports: [] });
function tagOrderRows(orders) {
  const counts = new Map(); for (const order of orders) counts.set(order.orderId, (counts.get(order.orderId) || 0) + 1);
  return orders.map(order => {
    const duplicate = !order.orderId || counts.get(order.orderId) > 1;
    const key = duplicate ? `${order.orderId || 'blank'}::${order.rowNumber || crypto.randomUUID()}` : String(order.orderId);
    return { ...order, _duplicate: Boolean(order._duplicate || duplicate), _orderKey: order._orderKey || key };
  });
}
const sqlite = new DatabaseSync(DB);
sqlite.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (order_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, order_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_stable_key_idx ON tasks(stable_key);
CREATE TABLE IF NOT EXISTS audit (audit_id TEXT PRIMARY KEY, task_id TEXT, order_id TEXT, action TEXT NOT NULL, responsible_user TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports (import_id TEXT PRIMARY KEY, filename TEXT NOT NULL, imported_at TEXT NOT NULL, payload TEXT NOT NULL);`);
function readDb() {
  const settings = sqlite.prepare('SELECT payload FROM settings WHERE id = 1').get();
  if (settings) return {
    ...initial(), settings: JSON.parse(settings.payload),
    orders: sqlite.prepare('SELECT payload FROM orders ORDER BY rowid').all().map(x => JSON.parse(x.payload)),
    tasks: sqlite.prepare('SELECT payload FROM tasks ORDER BY rowid DESC').all().map(x => JSON.parse(x.payload)),
    audit: sqlite.prepare('SELECT payload FROM audit ORDER BY occurred_at DESC, rowid DESC').all().map(x => JSON.parse(x.payload)),
    imports: sqlite.prepare('SELECT payload FROM imports ORDER BY imported_at DESC, rowid DESC').all().map(x => JSON.parse(x.payload))
  };
  if (IS_DEFAULT_DB && fs.existsSync(LEGACY_DB)) {
    try { const legacy = { ...initial(), ...JSON.parse(fs.readFileSync(LEGACY_DB, 'utf8')) }; legacy.orders = tagOrderRows(legacy.orders); return legacy; } catch { /* start with a clean SQLite store */ }
  }
  return initial();
}
let db = readDb();
function save() {
  const tx = sqlite.prepare('BEGIN IMMEDIATE'); tx.run();
  try {
    sqlite.exec('DELETE FROM settings; DELETE FROM orders; DELETE FROM tasks; DELETE FROM audit; DELETE FROM imports;');
    sqlite.prepare('INSERT INTO settings(id,payload) VALUES(1,?)').run(JSON.stringify(db.settings));
    const orderInsert = sqlite.prepare('INSERT INTO orders(order_id,payload) VALUES(?,?)');
    const uniqueOrders = new Map(); for (const order of db.orders) uniqueOrders.set(String(order._orderKey || order.orderId || `row-${order.rowNumber}`), order);
    for (const [orderId, order] of uniqueOrders) orderInsert.run(orderId, JSON.stringify(order));
    const taskInsert = sqlite.prepare('INSERT INTO tasks(task_id,stable_key,order_id,status,payload) VALUES(?,?,?,?,?)');
    for (const task of db.tasks) taskInsert.run(task.id, task.stableKey, String(task.orderId), task.status, JSON.stringify(task));
    const auditInsert = sqlite.prepare('INSERT INTO audit(audit_id,task_id,order_id,action,responsible_user,occurred_at,payload) VALUES(?,?,?,?,?,?,?)');
    for (const item of db.audit) auditInsert.run(item.id, item.taskId, item.orderId, item.action, item.by, item.at, JSON.stringify(item));
    const importInsert = sqlite.prepare('INSERT INTO imports(import_id,filename,imported_at,payload) VALUES(?,?,?,?)');
    for (const item of db.imports) importInsert.run(item.id, item.filename, item.at, JSON.stringify(item));
    sqlite.exec('COMMIT');
  } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
}
if (!sqlite.prepare('SELECT 1 FROM settings WHERE id = 1').get()) save();
const id = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
function norm(row, i) {
  const get = (...keys) => { for (const key of keys) { const k = Object.keys(row).find(x => x.toLowerCase().replace(/[^a-z0-9]/g, '') === key.toLowerCase().replace(/[^a-z0-9]/g, '')); if (k !== undefined) return String(row[k] ?? '').trim(); } return ''; };
  const date = (...keys) => { const raw = get(...keys); if (!raw) return ''; const excelSerial = /^\d{1,6}(\.\d+)?$/.test(raw) ? Number(raw) : null; const parsed = excelSerial !== null && excelSerial > 20000 && excelSerial < 100000 ? new Date(Date.UTC(1899, 11, 30) + excelSerial * 864e5) : new Date(raw); return Number.isNaN(parsed.valueOf()) ? `INVALID:${raw}` : parsed.toISOString(); };
  const rawValue = get('Order Value', 'OrderValue', 'Amount', 'Value');
  return { orderId: get('Order ID', 'OrderID', 'ID'), orderDate: date('Order Date', 'OrderDate', 'Created At', 'CreatedAt'), customer: get('Customer Name', 'Customer', 'Name'), phone: get('Phone Number', 'Phone', 'Mobile'), value: rawValue === '' ? '' : Number(rawValue.replace(/[₹,\s]/g, '')), payment: get('Payment Type', 'Payment', 'Payment Method'), status: get('Order Status', 'Status'), dispatchDate: date('Dispatch Date', 'DispatchDate', 'Shipped At'), expectedDelivery: date('Expected Delivery Date', 'ExpectedDeliveryDate', 'Delivery Date', 'EDD'), employee: get('Assigned Employee', 'Employee', 'Assignee'), deliveredAt: date('Delivered At', 'Delivery Date Actual', 'DeliveredDate'), rowNumber: i + 2 };
}
function evaluate(order) {
  const now = Date.now(); const out = [];
  const status = String(order.status || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  const unconfirmed = /\b(unconfirmed|pending confirmation|awaiting confirmation|new)\b/.test(status);
  const confirmed = !unconfirmed && /\b(confirmed|processing|ready)\b/.test(status);
  const dispatched = /\b(dispatched|shipped|in transit|out for delivery|delivery failed|failed delivery|delivered)\b/.test(status);
  const failed = /\b(failed|undeliverable)\b/.test(status);
  const delivered = /\b(delivered|complete|completed|resolved)\b/.test(status);
  const required = ['orderId', 'orderDate', 'customer', 'phone', 'value', 'payment', 'status'];
  if (dispatched) required.push('dispatchDate', 'expectedDelivery');
  if (!delivered && Number.isFinite(order.value) && order.value > db.settings.highValue) required.push('expectedDelivery');
  const missing = required.filter(k => order[k] === '' || order[k] === null || order[k] === undefined || (k === 'value' && !Number.isFinite(order[k])));
  const invalid = ['orderDate', 'dispatchDate', 'expectedDelivery', 'deliveredAt'].filter(k => String(order[k] || '').startsWith('INVALID:'));
  if (missing.length || invalid.length) out.push({ type: 'Data correction', reason: `${missing.length ? `Missing ${missing.join(', ')}` : ''}${missing.length && invalid.length ? '; ' : ''}${invalid.length ? `Invalid ${invalid.join(', ')}` : ''}`, priority: 'Medium', action: 'Correct the source record, then re-import the file.', key: 'data' });
  if (order._duplicate) out.push({ type: 'Duplicate order', reason: `Order ID ${order.orderId || '(blank)'} appears more than once in this upload.`, priority: 'Medium', action: 'Verify the duplicate rows and keep the correct order record.', key: 'duplicate' });
  if (!order.orderId || order._duplicate) return out;
  const ageHours = order.orderDate && !order.orderDate.startsWith('INVALID:') ? (now - Date.parse(order.orderDate)) / 36e5 : null;
  if (failed && order.phone) out.push({ type: 'Failed delivery', reason: 'A delivery attempt failed and needs immediate customer or courier follow-up.', priority: 'High', action: 'Contact the customer, confirm availability, and coordinate a new delivery attempt.', key: 'failed' });
  else if (unconfirmed && !order.dispatchDate && ageHours !== null && ageHours > db.settings.unconfirmedHours) out.push({ type: 'Unconfirmed order', reason: `Still unconfirmed ${ageHours.toFixed(1)} hours after order creation (limit ${db.settings.unconfirmedHours}h).`, priority: 'Medium', action: 'Call the customer to confirm the order and update its status.', key: 'unconfirmed' });
  if (confirmed && !order.dispatchDate && ageHours !== null && ageHours > db.settings.dispatchHours) out.push({ type: 'Dispatch delay', reason: `Confirmed order has not dispatched within ${db.settings.dispatchHours} hours.`, priority: 'High', action: 'Check inventory and fulfilment; dispatch the order or update the customer.', key: 'dispatch' });
  const due = order.expectedDelivery && !order.expectedDelivery.startsWith('INVALID:') ? Date.parse(order.expectedDelivery) : null;
  if (!delivered && due !== null && due < now) {
    if (dispatched && order.expectedDelivery && !order.expectedDelivery.startsWith('INVALID:')) out.push({ type: 'Shipment delay', reason: `Expected delivery date passed on ${new Date(due).toLocaleDateString('en-IN')}; order remains undelivered.`, priority: 'High', action: 'Check the courier tracking status and share a revised delivery ETA with the customer.', key: 'shipment' });
    if (Number.isFinite(order.value) && Number(order.value) > db.settings.highValue) out.push({ type: 'High-value order', reason: `Undelivered order worth ₹${Number(order.value).toLocaleString('en-IN')} is past its expected delivery date.`, priority: 'High', action: 'Escalate to the courier lead and personally update the customer today.', key: 'high-value' });
  }
  return out;
}
function record(action, task, detail = '') { db.audit.unshift({ id: id('AUD'), taskId: task?.id || '', orderId: task?.orderId || '', action, detail, by: db.settings.manager || 'Operations Manager', at: isoNow() }); }
function importRows(rows, filename = 'upload.csv') {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No data rows found in the file.');
  const normalized = rows.map(norm);
  const counts = new Map(); for (const o of normalized) counts.set(o.orderId, (counts.get(o.orderId) || 0) + 1);
  for (const o of normalized) o._duplicate = !o.orderId || counts.get(o.orderId) > 1;
  const batchId = id('IMP'); let created = 0, updated = 0, kept = 0; const createdKeys = new Set(), updatedKeys = new Set(), keptKeys = new Set();
  const affectedIds = new Set(normalized.map(o => o.orderId).filter(Boolean));
  const activeKeys = new Set();
  for (const order of normalized) {
    const exceptions = evaluate(order);
    for (const ex of exceptions) {
      const stable = `${order.orderId || `row-${order.rowNumber}`}::${ex.key}`;
      activeKeys.add(stable);
      const old = db.tasks.find(t => t.stableKey === stable && t.status !== 'Resolved');
      if (old) { old.order = order; old.reason = ex.reason; old.priority = ex.priority; old.action = ex.action; old.lastSeenAt = isoNow(); old.importId = batchId; if (!createdKeys.has(stable) && !updatedKeys.has(stable)) { updatedKeys.add(stable); updated++; } continue; }
      const resolved = db.tasks.find(t => t.stableKey === stable && t.status === 'Resolved');
      if (resolved?.resolutionNote) { resolved.status = 'Open'; resolved.order = order; resolved.reason = ex.reason; resolved.priority = ex.priority; resolved.action = ex.action; resolved.updatedAt = isoNow(); resolved.lastSeenAt = isoNow(); resolved.importId = batchId; delete resolved.resolutionNote; record('Task reopened', resolved, 'Exception is active again after order data changed.'); if (!updatedKeys.has(stable)) { updatedKeys.add(stable); updated++; } continue; }
      if (resolved) { if (!keptKeys.has(stable)) { keptKeys.add(stable); kept++; } continue; }
      const deadline = Date.now() + (ex.priority === 'High' ? 4 : 24) * 36e5;
      const task = { id: id('TSK'), stableKey: stable, orderId: order.orderId || `Row ${order.rowNumber}`, order, type: ex.type, reason: ex.reason, priority: ex.priority, employee: order.employee || 'Unassigned', action: ex.action, deadline: new Date(deadline).toISOString(), status: 'Open', createdAt: isoNow(), updatedAt: isoNow(), importId: batchId, lastSeenAt: isoNow(), isNew: true };
      db.tasks.unshift(task); record('Task created', task, ex.type); if (task.employee !== 'Unassigned') record('Task assigned', task, `Assigned to ${task.employee}`); createdKeys.add(stable); created++;
    }
  }
  for (const task of db.tasks) if (affectedIds.has(task.orderId) && task.status !== 'Resolved' && !activeKeys.has(task.stableKey)) {
    const previous = task.status; task.status = 'Resolved'; task.updatedAt = isoNow(); task.resolutionNote = 'Exception no longer applies after the latest order import.';
    record('Exception cleared', task, `${task.type} cleared by latest order data (${previous} → Resolved)`);
  }
  const allOrders = new Map(db.orders.map(o => [String(o._orderKey || o.orderId || `row-${o.rowNumber}`), o]));
  const uploadedIds = new Set(normalized.map(o => o.orderId).filter(Boolean));
  for (const [key, order] of allOrders) if (uploadedIds.has(order.orderId)) allOrders.delete(key);
  for (const order of normalized) {
    order._orderKey = order._duplicate ? `${order.orderId || 'blank'}::${order.rowNumber}` : String(order.orderId || `row-${order.rowNumber}`);
    allOrders.set(order._orderKey, order);
  }
  db.orders = [...allOrders.values()];
  const missingRequiredCount = normalized.filter(o => {
    const status = String(o.status || '').toLowerCase();
    const dispatched = /\b(dispatched|shipped|in transit|out for delivery|delivery failed|failed delivery|delivered)\b/.test(status);
    const required = ['orderId','orderDate','customer','phone','value','payment','status'];
    if (dispatched) required.push('dispatchDate','expectedDelivery');
    if (!/\b(delivered|complete|completed|resolved)\b/.test(status) && Number.isFinite(o.value) && o.value > db.settings.highValue) required.push('expectedDelivery');
    return required.some(k => o[k] === '' || o[k] === null || o[k] === undefined || (k === 'value' && !Number.isFinite(o[k])));
  }).length;
  const duplicateCount = normalized.filter(o => o.orderId && counts.get(o.orderId) > 1).length;
  const invalidDateCount = normalized.filter(o => ['orderDate','dispatchDate','expectedDelivery','deliveredAt'].some(k => String(o[k] || '').startsWith('INVALID:'))).length;
  const invalidValueCount = normalized.filter(o => o.value !== '' && !Number.isFinite(o.value)).length;
  const validationCount = normalized.filter(o => o._duplicate || evaluate(o).some(ex => ex.type === 'Data correction')).length;
  const batch = { id: batchId, filename: path.basename(filename || 'upload.csv'), rows: normalized.length, uniqueOrderIds: new Set(normalized.map(o => o.orderId).filter(Boolean)).size, created, updated, kept, validationCount, missingRequiredCount, duplicateCount, invalidDateCount, invalidValueCount, validRowCount: normalized.length - validationCount, at: isoNow() };
  db.imports.unshift(batch); save();
  return batch;
}

function reprocessOrders() {
  const batchId = id('RULE'); const activeKeys = new Set(); let created = 0, updated = 0, cleared = 0; const createdKeys = new Set(), updatedKeys = new Set();
  for (const order of db.orders) for (const ex of evaluate(order)) {
    const stable = `${order.orderId || `row-${order.rowNumber}`}::${ex.key}`; activeKeys.add(stable);
    const old = db.tasks.find(t => t.stableKey === stable && t.status !== 'Resolved');
    if (old) { old.order = order; old.reason = ex.reason; old.priority = ex.priority; old.action = ex.action; old.lastSeenAt = isoNow(); if (!createdKeys.has(stable) && !updatedKeys.has(stable)) { updatedKeys.add(stable); updated++; } continue; }
    const resolved = db.tasks.find(t => t.stableKey === stable && t.status === 'Resolved');
    if (resolved?.resolutionNote) { resolved.status = 'Open'; resolved.order = order; resolved.reason = ex.reason; resolved.priority = ex.priority; resolved.action = ex.action; resolved.updatedAt = isoNow(); resolved.lastSeenAt = isoNow(); delete resolved.resolutionNote; record('Task reopened', resolved, 'Exception is active again under the saved rules.'); if (!updatedKeys.has(stable)) { updatedKeys.add(stable); updated++; } continue; }
    if (resolved) continue;
    const task = { id: id('TSK'), stableKey: stable, orderId: order.orderId || `Row ${order.rowNumber}`, order, type: ex.type, reason: ex.reason, priority: ex.priority, employee: order.employee || 'Unassigned', action: ex.action, deadline: new Date(Date.now() + (ex.priority === 'High' ? 4 : 24) * 36e5).toISOString(), status: 'Open', createdAt: isoNow(), updatedAt: isoNow(), importId: batchId, lastSeenAt: isoNow(), isNew: true };
    db.tasks.unshift(task); record('Task created', task, ex.type); if (task.employee !== 'Unassigned') record('Task assigned', task, `Assigned to ${task.employee}`); createdKeys.add(stable); created++;
  }
  for (const task of db.tasks) if (task.status !== 'Resolved' && !activeKeys.has(task.stableKey)) { task.status = 'Resolved'; task.updatedAt = isoNow(); task.resolutionNote = 'Exception no longer applies under the saved rules.'; record('Exception cleared', task, `${task.type} cleared after rule update`); cleared++; }
  save(); return { created, updated, cleared };
}

function updateSettings(b) {
  const unconfirmedHours = Number(b.unconfirmedHours), dispatchHours = Number(b.dispatchHours), highValue = Number(b.highValue);
  if (!Number.isFinite(unconfirmedHours) || unconfirmedHours <= 0 || !Number.isFinite(dispatchHours) || dispatchHours <= 0 || !Number.isFinite(highValue) || highValue < 0) throw new Error('Enter positive hour limits and a non-negative high-value threshold.');
  db.settings = { ...db.settings, unconfirmedHours, dispatchHours, highValue, manager: String(b.manager || db.settings.manager || 'Operations Manager').trim().slice(0, 80) };
  const changes = reprocessOrders(); return { ...db.settings, changes };
}

function updateTask(taskId, b) {
  const task = db.tasks.find(t => t.id === taskId); if (!task) return null;
  if (b.status && ['Open', 'In Progress', 'Resolved'].includes(b.status) && b.status !== task.status) { const previous = task.status; task.status = b.status; task.updatedAt = isoNow(); record('Status changed', task, `${previous} → ${task.status}`); }
  if (b.employee && b.employee.trim() && b.employee.trim() !== task.employee) { const previous = task.employee; task.employee = b.employee.trim().slice(0, 80); task.updatedAt = isoNow(); record('Task reassigned', task, `${previous} → ${task.employee}`); }
  if (b.deadline && !Number.isNaN(Date.parse(b.deadline))) { const previous = task.deadline; task.deadline = new Date(b.deadline).toISOString(); task.updatedAt = isoNow(); if (previous !== task.deadline) record('Deadline changed', task, `${previous} → ${task.deadline}`); }
  save(); return task;
}

function getState() {
  const active = db.tasks.filter(t => t.status !== 'Resolved');
  return { ...db, summary: { totalOrders: db.orders.length, attention: new Set(active.map(t => t.orderId)).size, overdue: active.filter(t => Date.parse(t.deadline) < Date.now()).length, pending: active.length, newToday: db.tasks.filter(t => t.isNew && new Date(t.createdAt).toDateString() === new Date().toDateString()).length } };
}

function makeReportCsv() {
  const rows = [['Report section','Order ID','Customer','Phone','Exception','Priority','Employee','Action required','Deadline','Status','Overdue','Created']];
  for (const t of db.tasks) {
    const overdue = t.status !== 'Resolved' && Date.parse(t.deadline) < Date.now();
    const fresh = new Date(t.createdAt).toDateString() === new Date().toDateString(); const sections = [];
    if (fresh) sections.push('New exception'); if (t.status !== 'Resolved') sections.push('Unresolved exception'); if (overdue) sections.push('Overdue task'); if (t.priority === 'High') sections.push('High priority');
    rows.push([sections.join('; ') || 'Resolved',t.orderId,t.order?.customer,t.order?.phone,t.type,t.priority,t.employee,t.action,t.deadline,t.status,overdue?'Yes':'No',t.createdAt]);
  }
  rows.push([]); rows.push(['Employee pending tasks','','','','','','','','','','','']);
  const workload = new Map(); for (const t of db.tasks) if (t.status !== 'Resolved') workload.set(t.employee || 'Unassigned', (workload.get(t.employee || 'Unassigned') || 0) + 1);
  for (const [employee, count] of [...workload].sort((a,b) => b[1] - a[1])) rows.push(['Employee pending','','','','','',employee,`${count} open or in-progress tasks`,'','','','']);
  const csvCell = value => { let text = String(value ?? ''); if (/^[=+@\-]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g,'""')}"`; };
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
function parseCsv(text) {
  const records = []; let record = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; } else if (c === '"') quoted = true; else if (c === ',') { record.push(field); field = ''; } else if (c === '\n') { record.push(field.replace(/\r$/, '')); if (record.some(v => v.trim())) records.push(record); record = []; field = ''; } else field += c; }
  if (field || record.length) { record.push(field.replace(/\r$/, '')); if (record.some(v => v.trim())) records.push(record); }
  const headers = (records.shift() || []).map(v => v.trim()); return records.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])));
}
if (path.resolve(DB) === path.join(DATA, 'store.sqlite') && !db.orders.length && fs.existsSync(path.join(DATA, 'sample-orders.csv'))) {
  try { importRows(parseCsv(fs.readFileSync(path.join(DATA, 'sample-orders.csv'), 'utf8')), 'vitanatura-sample-orders.csv'); } catch (err) { console.error('Sample data could not be loaded:', err.message); }
}
function send(res, status, value, headers = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', d => { raw += d; if (raw.length > 15e6) reject(new Error('Upload exceeds 15 MB.')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid request body.')); } }); req.on('error', reject); }); }
const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, getState());
    if (req.method === 'POST' && url.pathname === '/api/import') { const b = await body(req); return send(res, 200, importRows(b.rows, b.filename)); }
    if (req.method === 'PUT' && url.pathname === '/api/settings') { const b = await body(req); try { return send(res, 200, updateSettings(b)); } catch (err) { return send(res, 400, { error: err.message }); } }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) { const b = await body(req); const task = updateTask(decodeURIComponent(url.pathname.split('/').pop()), b); if (!task) return send(res, 404, { error: 'Task not found.' }); return send(res, 200, task); }
    if (req.method === 'POST' && url.pathname === '/api/seed') { if (db.orders.length) return send(res, 200, { message: 'Sample data is already loaded.' }); const b = await body(req); const out = importRows(b.rows, 'vitanatura-sample-orders.csv'); return send(res, 200, out); }
    if (req.method === 'GET' && url.pathname === '/api/report.csv') { res.writeHead(200, { 'content-type':'text/csv; charset=utf-8', 'content-disposition':'attachment; filename="vitanatura-daily-exceptions.csv"' }); return res.end(makeReportCsv()); }
    if (req.method === 'GET') {
      const files = { '/':'index.html', '/index.html':'index.html', '/app.js':'app.js', '/styles.css':'styles.css', '/favicon.ico':null };
      if (!Object.hasOwn(files, url.pathname)) return send(res, 404, { error: 'Not found.' });
      if (files[url.pathname] === null) { res.writeHead(204); return res.end(); }
      const file = path.join(ROOT, files[url.pathname]);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options':'nosniff' }); return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'Route not found.' });
  } catch (err) { send(res, 400, { error: err.message || 'Request failed.' }); }
});
if (require.main === module) app.listen(PORT, '127.0.0.1', () => console.log(`VitaNatura OrderFlow running at http://127.0.0.1:${PORT}`));
else module.exports = { app, importRows, reprocessOrders, updateSettings, updateTask, getState, makeReportCsv, save, evaluate, norm, close: () => sqlite.close() };
