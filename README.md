# Merchforce Ops

Supplier operations backend. Fork of [merchforce](https://github.com/RogerDF30/merchforce)
with the public storefront removed: the catalogue is the asset, and publishing it
publishes it to competitors too.

Staff work entirely from the admin console. Enquiries are raised on the customer's
behalf rather than by the customer browsing a shop, and product information goes
out as generated documents instead of as a website.

An enquiry runs New → Accepted → PI Sent → PI Accepted; the customer's purchase
order converts it into an order (PO Received → In Production → Dispatched →
Delivered → Closed). Each enquiry has a follow-up owner drawn from the staff
accounts, and My enquiries shows a person their own. Accounts hold the people,
structured billing and shipping addresses, dated notes and Drive attachments.
The search box above the tabs covers products, enquiries, orders, accounts and
contacts.

## What is here

- **Admin console** (`admin.html`) — catalogue, stock, brands, orders, quotation
  builder and GST proforma, shipments, sheet sync, settings, analytics.
- **Customer order page** (`order.html?t=<token>`) — one order, no login, no
  catalogue. Stage timeline, PI download, accept or decline, PO upload, tracking.
- **Backend** (`apps-script/`) — Google Apps Script over a Google Sheet.

## What analytics measures

Order and stock movement, not browsing. Consumption comes from actual dispatches
recorded in StockLog; reorder suggestions cover lead time plus 30 days at the
measured rate, rounded to a whole MOQ. These are rules, not forecasts. Forecasting
waits for a season of dispatch history.

## Stock tab

Four views, all measured from StockLog and the order book. **Reorder** lists
products at or below their reorder point with a suggested quantity that nets off
what is already on order or in production, rounded up to the lot. **Fulfilment**
is the queue of orders from PO Received onward, aged against the stage SLA.
**Production** holds runs for goods made in house and **Purchases** holds vendor
orders for goods bought in; a product's `supply_mode` (make | buy) decides which
plan a reorder lands in. Receiving a supply order is the only action here that
changes on hand, and it writes a StockLog row like every other movement. A daily
reorder digest can be emailed to the notification address.

## Decks

PDF (A4) and PPTX (16:9) are built server side from the same data. Compact
layout puts two products on each page and slide; spacious puts one. Both end
with an at-a-glance table. Colours and layout come from Settings → Deck design.

## Local development

    node tools/mock_api.js     # http://localhost:8900, admin key admin2026

## Scope

See `PLAN-supplier-ops.md` in Workstation OS for the full scope, the phase order
and the open questions.
