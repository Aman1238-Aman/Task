# VitaNatura OrderFlow

OrderFlow is a working local operations app for importing D2C orders, identifying follow-up exceptions, assigning team tasks, and keeping a persistent audit history. It uses a responsive browser dashboard, a Node.js HTTP server, and SQLite storage.

## Run it

1. Install Node.js 22.13 or newer (the built-in `node:sqlite` module is used).
2. In this folder run `npm start` (or `node server.js`). No npm install is required.
3. Open [http://localhost:3000](http://localhost:3000).

The server binds to `127.0.0.1:3000`. Set `PORT` to choose another port. The SQLite database is `data/store.sqlite`; it stores orders, tasks, assignments, settings, imports, and audit entries. Existing `data/store.json` workspaces are migrated into SQLite the first time the updated app starts. Set `ORDERFLOW_DB` to use another SQLite file (useful for a separate demo or test workspace).

If port 3000 is already in use on Windows PowerShell, set `$env:PORT='3001'` and then run `npm start`. Run `npm run verify` for the repeatable 100-order persistence and rules check.

## Features

- Ships with 120 illustrative sample orders covering normal, delayed, failed, duplicate, incomplete, and invalid-data cases.
- Imports `.csv` and modern Excel `.xlsx` files (first worksheet). Legacy `.xls` files should be saved as `.xlsx` or CSV first.
- Detects duplicate IDs, missing required order data, invalid dates, and invalid amounts. Data correction tasks are kept separate from delay rules when the needed rule inputs are missing.
- Supports unconfirmed-order, dispatch-delay, shipment-delay, failed-delivery, and high-value-overdue rules. Dispatch and unconfirmed thresholds and the high-value threshold are configurable; saving changes immediately reprocesses saved orders.
- Adds one task per order and exception type, updates active tasks on repeat imports, and leaves resolved tasks closed. New uploads merge into the saved order set instead of replacing earlier uploads.
- Supports employee assignment/reassignment, `Open`, `In Progress`, and `Resolved` statuses, and editable deadlines. Changes are stored in SQLite and recorded in the audit trail with the responsible workspace user and timestamp.
- Filters tasks by Order ID/customer, date, exception type, employee, priority, and status. Team workload and exception mix show all active categories.
- Exports a daily CSV with new, unresolved, overdue, and high-priority cases and an employee-wise pending-task summary.

## Import columns

Headers are case-insensitive; common alternatives such as `OrderID`, `Customer`, `Phone`, `Amount`, `Status`, `Employee`, and `EDD` are accepted:

`Order ID, Order Date, Customer Name, Phone Number, Order Value, Payment Type, Order Status, Dispatch Date, Expected Delivery Date, Assigned Employee`

For orders already dispatched or delivered, include dispatch and expected-delivery dates. Dates may be standard date strings or Excel date cells. An empty dispatch date is valid before dispatch. Common order statuses include Confirmed, Unconfirmed, Dispatched, In Transit, Delivered, and Delivery Failed.

## Business rules

- Unconfirmed orders older than the saved hour threshold need confirmation follow-up.
- Confirmed/processing orders that have exceeded the dispatch threshold need fulfilment follow-up.
- A dispatched, undelivered order past its expected delivery date is a shipment exception.
- A failed delivery attempt creates an immediate high-priority follow-up.
- An undelivered order above the saved value threshold and past its expected delivery date gets an additional high-value escalation.
- Missing or invalid information creates a correction task; rules that depend on unavailable inputs are skipped rather than guessed.

Task deadlines are set from detection time (4 hours for high priority and 24 hours otherwise). This demo uses sample data and is not connected to live order, courier, identity, or messaging systems. Sample names, phone numbers, orders, and dashboard metrics are illustrative.

## Five-minute demo

1. Show the overview and sample exception mix.
2. Import `data/sample-orders.csv` again; the order total should stay stable and existing exceptions should refresh rather than duplicate.
3. Change the dispatch threshold to 12 hours; the saved order set is reprocessed immediately.
4. Reassign a task and change its status; show the audit events.
5. Filter the queue, download the daily report, refresh the page, and restart the server to show that data persists.

## Measures and estimated impact

Track time to first follow-up, time to resolution, overdue share, exception rate by category, failed-delivery recovery, and workload distribution. Estimate daily hours saved as `(manual minutes per day - review minutes per day) / 60` after measuring a representative baseline and pilot period.
