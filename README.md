# Merchforce Ops

Supplier operations backend. Fork of [merchforce](https://github.com/RogerDF30/merchforce)
with the public storefront removed: the catalogue is the asset, and publishing it
publishes it to competitors too.

Staff work entirely from the admin console. Requests are raised on the customer's
behalf rather than by the customer browsing a shop, and product information goes
out as generated documents instead of as a website.

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

## Local development

    node tools/mock_api.js     # http://localhost:8900, admin key admin2026

## Scope

See `PLAN-supplier-ops.md` in Workstation OS for the full scope, the phase order
and the open questions.
