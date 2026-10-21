const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const databasePath = path.join(os.tmpdir(), `vitanatura-check-${process.pid}-${Date.now()}.sqlite`);
process.env.ORDERFLOW_DB = databasePath;
const service = require('../server');
const now = Date.now();
const ago = hours => new Date(now - hours * 3600_000).toISOString();
const dayAgo = days => new Date(now - days * 86_400_000).toISOString();
function order(i) {
  const o = { 'Order ID': `T-${String(i).padStart(3,'0')}`, 'Order Date': ago(6), 'Customer Name': `Customer ${i}`, 'Phone Number': `+91 90000${String(i).padStart(5,'0')}`, 'Order Value': 1200, 'Payment Type': 'Prepaid', 'Order Status': 'Delivered', 'Dispatch Date': ago(4), 'Expected Delivery Date': dayAgo(2), 'Assigned Employee': i % 2 ? 'Priya Nair' : 'Aarav Sharma' };
  if (i === 1) Object.assign(o, { 'Order Status':'Unconfirmed', 'Order Date':ago(3.5), 'Dispatch Date':'', 'Expected Delivery Date':'' });
  if (i === 2) Object.assign(o, { 'Order Status':'Confirmed', 'Order Date':ago(30), 'Dispatch Date':'', 'Expected Delivery Date':'' });
  if (i === 3) Object.assign(o, { 'Order Status':'In Transit', 'Order Date':ago(50), 'Dispatch Date':ago(25), 'Expected Delivery Date':dayAgo(1) });
  if (i === 4) Object.assign(o, { 'Order Status':'Delivery Failed', 'Order Date':ago(24), 'Dispatch Date':ago(10), 'Expected Delivery Date':dayAgo(1) });
  if (i === 5) Object.assign(o, { 'Order Status':'Dispatched', 'Order Date':ago(30), 'Dispatch Date':ago(25), 'Expected Delivery Date':dayAgo(1), 'Order Value':6500 });
  if (i === 6) Object.assign(o, { 'Order Status':'Confirmed', 'Order Date':ago(30), 'Customer Name':'', 'Dispatch Date':'', 'Expected Delivery Date':'' });
  if (i === 7) Object.assign(o, { 'Order Status':'Delivered', 'Dispatch Date':ago(4), 'Expected Delivery Date':dayAgo(2) });
  if (i === 8) Object.assign(o, { 'Order Status':'Confirmed', 'Order Date':'not-a-date', 'Dispatch Date':'', 'Expected Delivery Date':'' });
  if (i === 9) Object.assign(o, { 'Order Status':'In Transit', 'Dispatch Date':ago(2), 'Expected Delivery Date':'' });
  if (i === 10) Object.assign(o, { 'Order Status':'Delivery Failed', 'Phone Number':'', 'Dispatch Date':ago(3), 'Expected Delivery Date':dayAgo(1) });
  if (i === 11) Object.assign(o, { 'Order Status':'Confirmed', 'Order Date':ago(20), 'Dispatch Date':'', 'Expected Delivery Date':'' });
  if (i === 12) Object.assign(o, { 'Order Status':'Unconfirmed', 'Order Date':ago(1.5), 'Dispatch Date':'', 'Expected Delivery Date':'' });
  if (i === 13) Object.assign(o, { 'Order Status':'Dispatched', 'Order Date':ago(20), 'Dispatch Date':ago(10), 'Expected Delivery Date':dayAgo(1), 'Order Value':4500 });
  if (i === 14) Object.assign(o, { 'Order Value':'bad amount' });
  return o;
}

let passed = false;
try {
  const rows = Array.from({ length:99 }, (_, i) => order(i + 1)); rows.push({ ...order(7), 'Order Date':ago(3) });
  const first = service.importRows(rows, 'checklist-100.csv');
  let state = service.getState();
  assert.equal(first.rows, 100); assert.equal(first.uniqueOrderIds, 99); assert.equal(first.duplicateCount, 2); assert.equal(state.summary.totalOrders, 100);
  assert.equal(first.missingRequiredCount, 4); assert.equal(first.invalidDateCount, 1); assert.equal(first.invalidValueCount, 1); assert.equal(first.validationCount, 7);
  for (const type of ['Unconfirmed order','Dispatch delay','Shipment delay','Failed delivery','High-value order','Data correction','Duplicate order']) assert(state.tasks.some(t => t.type === type), `missing rule type: ${type}`);
  for (const task of state.tasks) { assert(task.reason && task.priority && task.action, `incomplete exception fields on ${task.orderId}`); assert(Number.isFinite(Date.parse(task.deadline)), `invalid deadline on ${task.orderId}`); }
  assert(!state.tasks.some(t => t.orderId === 'T-008' && t.type === 'Dispatch delay'), 'invalid date falsely triggered a delay');
  assert(!state.tasks.some(t => t.orderId === 'T-009' && t.type === 'Shipment delay'), 'missing expected date falsely triggered a shipment delay');
  assert(!state.tasks.some(t => t.orderId === 'T-010' && t.type === 'Failed delivery'), 'failed delivery without a contact number was assigned');
  const taskCount = state.tasks.length;
  const repeated = service.importRows(rows, 'checklist-100.csv'); state = service.getState();
  assert.equal(repeated.created, 0); assert.equal(state.tasks.length, taskCount, 'repeat import created duplicate tasks');

  const settings = service.updateSettings({ unconfirmedHours:1, dispatchHours:12, highValue:4000, manager:'QA Manager' });
  assert(settings.changes.created >= 3, 'changed rules did not create the newly qualifying cases');
  state = service.getState();
  assert(state.tasks.some(t => t.orderId === 'T-011' && t.type === 'Dispatch delay'));
  assert(state.tasks.some(t => t.orderId === 'T-012' && t.type === 'Unconfirmed order'));
  assert(state.tasks.some(t => t.orderId === 'T-013' && t.type === 'High-value order'));
  const target = state.tasks.find(t => t.orderId === 'T-011' && t.type === 'Dispatch delay');
  service.updateTask(target.id, { employee:'Meera Iyer' });
  service.updateTask(target.id, { status:'In Progress', deadline:ago(2) });
  state = service.getState();
  assert.equal(state.summary.overdue, 1); assert.equal(state.summary.pending, state.tasks.filter(t => t.status !== 'Resolved').length);
  for (const action of ['Task reassigned','Status changed','Deadline changed']) { const entry=state.audit.find(a => a.action === action && a.orderId === 'T-011' && a.by === 'QA Manager'); assert(entry,`missing audit: ${action}`); assert(Number.isFinite(Date.parse(entry.at)),`invalid audit time: ${action}`); }
  const report = service.makeReportCsv();
  for (const text of ['New exception','Unresolved exception','Overdue task','High priority','Employee pending tasks','Meera Iyer']) assert(report.includes(text), `report missing ${text}`);
  service.importRows([{ ...order(101), 'Order ID':'T-101', 'Order Status':'Delivered' }], 'incremental.csv');
  assert.equal(service.getState().summary.totalOrders, 101, 'new upload replaced earlier orders');
  service.updateSettings({ unconfirmedHours:2, dispatchHours:24, highValue:5000, manager:'QA Manager' });
  service.updateSettings({ unconfirmedHours:1, dispatchHours:12, highValue:4000, manager:'QA Manager' });
  assert.equal(service.getState().tasks.filter(t => t.orderId === 'T-011' && t.type === 'Dispatch delay').length, 1, 'rule reprocessing duplicated an auto-cleared task');

  const snapshot = { orders:service.getState().orders.length, tasks:service.getState().tasks.length, audit:service.getState().audit.length };
  service.save(); service.close();
  const child = spawnSync(process.execPath, ['-e', `process.env.ORDERFLOW_DB=${JSON.stringify(databasePath)};const s=require(${JSON.stringify(path.join(__dirname,'..','server.js'))});console.log(JSON.stringify({orders:s.getState().orders.length,tasks:s.getState().tasks.length,audit:s.getState().audit.length,manager:s.getState().settings.manager}));s.close();`], { encoding:'utf8' });
  assert.equal(child.status, 0, child.stderr || 'restart read failed');
  const reopened = JSON.parse(child.stdout.trim()); assert.deepEqual({ orders:reopened.orders, tasks:reopened.tasks, audit:reopened.audit }, snapshot); assert.equal(reopened.manager,'QA Manager');
  const projectRoot = path.resolve(__dirname,'..'); const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(),'vitanatura-legacy-')); let migratedOrderCount = 0;
  try {
    fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});
    for (const file of ['server.js']) fs.copyFileSync(path.join(projectRoot,file),path.join(legacyRoot,file));
    for (const file of ['store.json','sample-orders.csv']) fs.copyFileSync(path.join(projectRoot,'data',file),path.join(legacyRoot,'data',file));
    const legacyExpected = JSON.parse(fs.readFileSync(path.join(legacyRoot,'data','store.json'),'utf8')); migratedOrderCount = legacyExpected.orders.length;
    const migration = spawnSync(process.execPath,['-e',`const s=require('./server.js');const d=s.getState();console.log(JSON.stringify({orders:d.orders.length,tasks:d.tasks.length,audit:d.audit.length,imports:d.imports.length}));s.close();`],{cwd:legacyRoot,encoding:'utf8',env:{...process.env,ORDERFLOW_DB:''}});
    assert.equal(migration.status,0,migration.stderr || 'legacy migration failed');
    const migrated = JSON.parse(migration.stdout.trim());
    assert.deepEqual(migrated,{orders:legacyExpected.orders.length,tasks:legacyExpected.tasks.length,audit:legacyExpected.audit.length,imports:legacyExpected.imports.length});
    assert(fs.existsSync(path.join(legacyRoot,'data','store.sqlite')),'SQLite database was not created from legacy JSON');
  } finally {
    const tempRoot = path.resolve(os.tmpdir()), target = path.resolve(legacyRoot);
    if (target.startsWith(tempRoot + path.sep) && path.basename(target).startsWith('vitanatura-legacy-')) fs.rmSync(target,{recursive:true,force:true});
  }
  passed = true;
  console.log(`PASS: 100-row import, validation and duplicates, seven exception types, false-delay guards, idempotent repeat import, rule reprocessing, reassignment/status/deadline audit, overdue counts, employee report, cumulative import, SQLite restart persistence (${snapshot.orders} orders, ${snapshot.tasks} tasks, ${snapshot.audit} audit events), and migration of ${migratedOrderCount} legacy orders.`);
} finally {
  if (!passed) { try { service.close(); } catch {} }
  for (const suffix of ['', '-wal', '-shm']) { const file = databasePath + suffix; if (fs.existsSync(file)) fs.rmSync(file, { force:true }); }
}
