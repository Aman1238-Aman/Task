const fs = require('node:fs');
const path = require('node:path');

const headers = ['Order ID','Order Date','Customer Name','Phone Number','Order Value','Payment Type','Order Status','Dispatch Date','Expected Delivery Date','Assigned Employee'];
const people = ['Aarav Sharma','Priya Nair','Rohan Das','Meera Iyer','Kabir Khan','Ananya Rao'];
const statuses = ['Delivered','Confirmed','Dispatched','In Transit','Unconfirmed','Delivery Failed'];
const now = Date.now();
const rows = Array.from({ length: 120 }, (_, idx) => {
  const i = idx + 1;
  const created = new Date(now - ((i * 17) % 110) * 3600e3);
  const status = statuses[(i * 7) % statuses.length];
  let dispatch = '', delivery = '';
  if (status === 'Delivered') { dispatch = new Date(created.getTime() + 5 * 3600e3).toISOString(); delivery = new Date(created.getTime() + 36 * 3600e3).toISOString(); }
  else if (['Dispatched','In Transit','Delivery Failed'].includes(status)) { dispatch = new Date(created.getTime() + ((i % 10) + 1) * 3600e3).toISOString(); delivery = new Date(now - ((i % 6) + 1) * 864e5).toISOString(); }
  else if (status === 'Confirmed' && i % 3 === 0) created.setTime(now - 48 * 3600e3);
  return [`VN-${String(i).padStart(4, '0')}`,created.toISOString(),people[i % people.length],`+91 98${String(10000000 + i).slice(-8)}`,799 + ((i * 887) % 7800),i % 3 ? 'Prepaid' : 'COD',status,dispatch,delivery,people[(i + 2) % people.length]];
});
rows[20][2] = '';
rows[34][1] = 'not-a-date';
rows[50][0] = rows[49][0];
rows[60][3] = '';
rows[75][4] = 'bad amount';
const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const target = path.join(__dirname, '..', 'data', 'sample-orders.csv');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, csv, 'utf8');
console.log(`Wrote ${rows.length} illustrative sample orders to ${target}`);
