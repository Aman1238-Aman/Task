# VitaNatura OrderFlow

A working internal operations prototype for importing D2C orders, flagging exceptions, assigning follow-up work and retaining an audit trail. The app runs locally with Node.js and uses only built-in Node modules; it does not need a database server, account, API key or npm install.

## Run it

1. Install Node.js 18 or newer.
2. In this folder run `npm start` (or `node server.js`).
3. Open [http://localhost:3000](http://localhost:3000).

The server binds to `127.0.0.1:3000`. Set `PORT` to use a different port. Persistent workspace data is saved in `data/store.json`; back up that file to preserve tasks and audit history.

## What it does

- On first start, loads 120 illustrative sample orders with normal, delayed, failed, duplicate, incomplete and invalid-data cases.
- Imports CSV and modern Excel `.xlsx` workbooks (first worksheet). The `.xls` legacy binary format is not supported; save it as `.xlsx` or CSV first.
- Detects duplicate IDs, required-field omissions, invalid dates and invalid order values. Data-quality issues create correction tasks; rules that need missing information are skipped.
- Applies adjustable unconfirmed, dispatch-delay and high-value thresholds to uploaded rows.
- Creates one task per order/exception type and prevents repeat uploads from reopening resolved work or generating duplicate active work. Existing active tasks are refreshed with the latest source details.
- Lets managers reassign employees, change task status, and change task deadlines. Each assignment, reassignment and status update is added to the persistent audit trail.
- Filters by search, exception type, employee, priority and status, and shows team workload and exception mix.
- Downloads a CSV report with new, unresolved, overdue and high-priority exceptions plus owner and next action.

## Import columns

Use these headers (case-insensitive; common alternatives such as `OrderID`, `Customer`, `Phone`, `Amount`, `Status`, `Employee`, and `EDD` are accepted):

`Order ID, Order Date, Customer Name, Phone Number, Order Value, Payment Type, Order Status, Dispatch Date, Expected Delivery Date, Assigned Employee`

For dispatched or delivered orders, include dispatch and expected delivery dates. Dates should be recognizable date strings or Excel date cells. An empty dispatch date for an order that has not shipped is valid. Order status values such as Confirmed, Dispatched, In Transit, Delivered, Unconfirmed and Delivery Failed are understood.

## Business rules

- Unconfirmed orders older than the configured order-age threshold.
- Confirmed orders not dispatched before the configured dispatch threshold.
- Dispatched shipments past their expected delivery date.
- Failed delivery attempts are high-priority immediate follow-up.
- Undelivered shipments above the configured value threshold receive an additional high-value escalation.
- If data needed to evaluate a rule is unavailable or invalid, the row is sent for data correction instead of being incorrectly marked delayed.

Deadlines are simulated from detection time (4 hours for high priority and 24 hours otherwise). This prototype uses local JSON persistence and sample data; it is not connected to live order, courier, identity or messaging systems. Sample names, phone numbers, orders and dashboard metrics are illustrative.

## Five-minute demo outline

1. Show the overview and the sample exception mix.
2. Upload `data/sample-orders.csv` again and show that active exceptions refresh rather than duplicate and resolved items remain resolved.
3. Set the dispatch threshold to 12 hours and upload again to demonstrate the configurable business rule.
4. Reassign a late/high-priority task and change it to In Progress; show the corresponding audit events.
5. Filter to high-priority work, export the daily report, then refresh the page to show persisted data.

## Measures and estimated impact

Track time from order creation to first follow-up, time to resolution, overdue share, exception rate by category, failed delivery recovery, and workload distribution. To estimate hours saved per day, compare the measured time staff currently spend checking and assigning exceptions with the time spent reviewing generated work: `(manual minutes per day - review minutes per day) / 60`. A live pilot should establish the baseline and measure this over comparable order volumes.
