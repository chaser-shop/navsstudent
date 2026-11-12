# Admin Panel Audit — Back-office (`project/`)

Audit date: 2026-11-12. Audited revision: `6022e37` (branch `main`), identical to the attached archive `Архів 3.zip`.
Method: full read of `project/backend/**`, `project/frontend/admin/index.html`, `project/tests/**`, the import data, plus a scripted run of the original panel in headless Chrome (desktop 1440×900 and mobile 390×844) against a real MongoDB 7.0 with the 800-product catalog imported.

---

## 0. Scope reconciliation (read this first)

The task brief describes an archive called `bobsmoke-redesign.zip` containing a redesigned Telegram Mini App, a bot, `PROJECT_AUDIT.md`, `REDESIGN_PLAN.md`, `PROGRESS.md`, `frontend/miniapp/`, admin sections for chats, referrals and broadcasts, and a test baseline with four known failing tests.

The archive actually provided contains something different:

| Path | What it is |
|---|---|
| repository root (`server.js`, `src/`, `public/`, `seed/`, `scripts/`) | A separate Node.js "student diary" web app (schedule, homework, Web Push). Unrelated to the shop. |
| `project/` | The shop back-office: FastAPI + MongoDB backend and a single-file admin panel for a vape catalog (liquids, pod systems, cartridges, boosters). |
| `project.zip`, `Архів*.zip`, `navs.zip` | Older copies of the same files. `project.zip` is identical to `project/` apart from `__pycache__`. |

Not present anywhere in the archive or in the git history: `frontend/miniapp/`, a Telegram bot, `PROJECT_AUDIT.md`, `REDESIGN_PLAN.md`, `PROGRESS.md`, chats, referrals, broadcasts, customer accounts or registrations. `project/README.md` states explicitly that there is no public site, no Telegram bot and no payments.

Decisions:

- The redesign targets `project/frontend/admin` and `project/backend`. The diary app at the repository root is out of scope and is not modified.
- "Mini App protection" is satisfied trivially: there is no Mini App code to break. No root files are touched.
- Brand: the only existing brand assets are the panel's colours (dark surfaces, amber accent `#f5a524`, red `#ef5350`, green `#43c06b`). There is no logo/avatar file in the archive. The new design keeps that palette; the shop name comes from the existing `settings.general.shop_name` value.
- Test baseline: **20/20 pytest tests pass** and `python -m tests.run_pure` passes 15/15. There are no failing tests in this archive.

---

## 1. Inventory

### 1.1 Backend endpoints (all require `Authorization: Bearer <JWT>` except `/health` and login)

| Method & path | Purpose | Used by original UI |
|---|---|---|
| `POST /api/auth/login` | Argon2 check, 5 failures → 15 min lock, returns JWT | yes |
| `GET /api/auth/me` | Current admin username | yes |
| `GET /api/products` | Search (`q`), filters (`category`, `brand`, `status`, `compliance`), `sort`, `page`, `limit≤100` | yes |
| `GET /api/products/{id}` | Product + USDT price | yes |
| `POST /api/products` | Create (name, brand, category, line, model, variant, volume, nicotine, purchase price, status, images) | partly (4 fields) |
| `PATCH /api/products/{id}` | Update name, category, purchase price, status, images | partly (price, status) |
| `DELETE /api/products/{id}?confirm=true` | Delete | yes |
| `GET /api/brands`, `GET /api/categories` | Distinct brands; fixed category list | brands only |
| `GET /api/media/{name}` | Authenticated image file | yes |
| `GET/PUT /api/pricing/markups`, `POST /api/pricing/markups/preview` | Category markups, preview, apply + reprice | yes |
| `POST /api/import?dry_run=` | JSON price-list import | yes |
| `GET /api/orders` | Filter by `number`, `status`, `date_from`, `date_to`, `page` (30/page) | yes (no paging) |
| `POST /api/orders` | Create order, server-side prices | yes |
| `PATCH /api/orders/{number}/status` | Change status | yes |
| `POST /api/orders/{number}/notes` | Add note | yes |
| `GET/PUT /api/settings` | `shop_name`, `contact` | **no** |
| `GET /health` | DB ping | no |

### 1.2 MongoDB collections

`products`, `orders`, `counters` (order numbers), `admins`, `audit_log`, `settings` (`markups`, `general`). Money is stored as `Decimal128`. Orders embed `customer: {name, contact}`; there is no customers collection.

### 1.3 Business rules that must be preserved

- Final price = purchase price + category markup, always recomputed from the purchase price (never applied twice). Order prices are snapshotted at creation and computed by the server.
- Legal flags (`services/compliance.py`, Law 1978-IX): liquids over 10 ml or 20 mg/ml are `blocked_by_law` and can never be ordered; everything else is `hold_legal_review`. Not switchable by settings.
- Re-import updates only price/availability fields and never duplicates products (`dedupe_key`).
- Every mutating action writes to `audit_log`.

### 1.4 Original admin frontend

One file, `frontend/admin/index.html` (157 lines, ~20 KB, vanilla JS, no build step, no dependencies). Top tabs: Товари, Нове замовлення, Замовлення, Націнки, Імпорт.

---

## 2. Findings

### 2.1 Working features to preserve

- Login, lockout messages (401/429), token in `sessionStorage`, automatic logout on 401.
- Product list with search, four filters, sorting and pagination; product card with price breakdown (purchase + markup = final, USDT price and rate), authenticated image loading, edit of purchase price and availability, deletion with `confirm=true`.
- "Add to order" correctly disabled for blocked, unavailable or unpriced products.
- Order creation with server-side pricing; order list filters; status change; notes.
- Markups preview and apply; JSON import dry-run and apply.
- All interpolated values are HTML-escaped.

### 2.2 Missing or incomplete pages

| Area | State |
|---|---|
| Dashboard | Missing |
| Analytics | Missing |
| Customers | Missing (customers exist only inside orders) |
| Categories & product lines | Missing (categories are a fixed legal/pricing list; lines exist only as a product field) |
| Settings | Backend exists, no UI |
| Activity / audit log | Written by backend, never readable |
| Chats, referrals, broadcasts | Do not exist; there is no bot or customer account system to build them on |

### 2.3 Controls that do not work or mislead

1. **Orders list shows only the first 30 orders** — the backend paginates but the UI has no paging controls, so older orders are unreachable.
2. Escape does not close dialogs; no focus management in dialogs.
3. Changing an order to "Скасоване" has no confirmation.
4. Failed requests inside click handlers leave unhandled promise rejections (e.g. a failed save).
5. Toasts overwrite each other (single slot) and success/error are distinguished only by text colour.

### 2.4 Unfinished forms

- Create product: only name, brand, category and purchase price; line, model, variant, volume, nicotine, availability and images cannot be set.
- Edit product: only purchase price and availability. The backend already accepts name, category and images, but the UI never sends them; brand, line, model, variant, volume and nicotine cannot be edited at all.
- No client-side validation. FastAPI 422 responses carry a list, so the UI shows a bare "Помилка 422".
- New order: empty customer name produces the same unreadable 422.

### 2.5 Missing API integrations

- `/api/settings` and `/api/categories` are never called.
- No backend support for: dashboard/analytics aggregates, a customer list, reading the audit log, product-line management, image upload, fetching a single order, searching orders by customer, order status history, or changing the admin password.

### 2.6 Styling inconsistencies

- Product name "Back-office" (English) in the page title and header.
- Raw compliance codes such as `online_advertising_ban` shown to admins.
- Inline styles mixed with a 13-variable palette; no icon set; system font; native `confirm()` in three places (delete product, apply markups, apply import).
- No favicon (404 on every load).

### 2.7 Mobile layout

- Top navigation wraps into three rows at 390 px; no mobile navigation pattern.
- Tables keep all desktop columns inside a horizontal scroller: at 390 px the price, status and legal columns are off-screen.
- Filter controls stack unevenly; touch targets are about 34 px; dialogs are not adapted to small screens; no safe-area handling.

### 2.8 JavaScript errors (observed)

- Scripted desktop and mobile runs produced no uncaught exceptions. Console errors were the favicon 404 and the expected 401 for a wrong password.
- By inspection: unhandled rejections on failed requests (see 2.3), `o.customer.name` would throw on an order without a customer object, and dates are cut from UTC ISO strings (`slice(0,10)`), so orders created between 00:00 and 02:00/03:00 Kyiv time show the previous day.

### 2.9 Placeholder data

None. Every value comes from the API; the cart estimate is computed client-side and labelled as approximate.

---

## 3. Implementation plan

### 3.1 Frontend architecture (no build step, no new runtime dependencies)

Keep the existing deployment model (FastAPI `StaticFiles` serving `/admin`). Replace the single file with native ES modules:

```
frontend/admin/
  index.html                 shell, fonts, favicon
  assets/css/                tokens, base, components, layout, pages
  assets/fonts/              Inter variable (latin + cyrillic, OFL)
  assets/js/main.js          bootstrap, auth gate, hash router, app shell
  assets/js/core/            api client, state, formatting, Ukrainian labels
  assets/js/ui/              icons (Lucide subset, ISC), dialogs, toasts, charts (SVG), components
  assets/js/pages/           one module per section
```

Design system: dark default with the existing amber accent, optional light theme, 4-pt spacing scale, radius and elevation tokens, Inter with tabular numerals, Lucide icons, CSS-only motion respecting `prefers-reduced-motion`.

Libraries listed in the brief (shadcn/ui, Magic UI, Aceternity, Framer Motion…) are React/Tailwind-based and would require introducing a bundler and a framework into a dependency-free Python project. Their visual patterns (shadcn tokens and component anatomy, subtle spotlight/border-glow surfaces, Lucide icons) are reproduced in plain CSS instead.

### 3.2 Sections

| Section | Plan |
|---|---|
| Login | Branded card, password visibility toggle, lockout and network errors |
| Dashboard | KPIs, 30-day orders/revenue chart, status and catalog breakdowns, recent orders, recent activity, alerts, quick actions — all from a new aggregate endpoint |
| Products | Responsive list (table → cards), debounced search, filters, thumbnails, full create/edit form with validation and image upload, availability and price management, delete confirmation |
| Categories & lines | Fixed category overview (counts, markups, legal rule), product-line list with rename and line image management, links to filtered products |
| Orders | Search by number/customer, status/date filters, paging, detail drawer (customer, items, totals, status with confirmation, history, notes) |
| New order | Product picker limited to orderable items, quantity steppers, customer form, server-calculated total |
| Customers | Derived from orders: search, sorting, stats, detail with order history, "new order for this customer" |
| Analytics | Date presets and custom range, KPIs with previous-period comparison, daily chart, status/category breakdowns, top products and customers |
| Markups | Live preview of affected products, confirmation before applying |
| Import | Drag-and-drop JSON, dry-run report, confirmation before applying |
| Activity log | Paginated audit log with action filter and Ukrainian action names |
| Settings | Shop name and contact (existing API), appearance, password change, session, system health |

### 3.3 Backend (smallest compatible additions; existing contracts unchanged)

| Change | Why |
|---|---|
| `GET /api/stats/overview` | Dashboard needs totals over all orders and products; the list endpoints paginate |
| `GET /api/stats/analytics` | Period aggregates, previous-period comparison, top products/customers |
| `GET /api/customers`, `GET /api/customers/detail` | Customers exist only inside orders; grouping must be server-side |
| `GET /api/audit` | Activity log and dashboard "recent activity" |
| `GET /api/lines`, `PATCH /api/lines` | Product-line overview, rename, line images |
| `POST /api/media` | Image upload (JPEG/PNG/WebP, 5 MB, content-addressed names, admin only) |
| `GET /api/orders/{number}` | Refresh one order in the detail drawer |
| `GET /api/orders`: optional `q`, `limit`; response adds `page`, `pages` | Search by customer; paging |
| Order `history` (created + every status change, with admin and time) | Order history |
| `PATCH /api/products/{id}` accepts brand, line, model, variant, volume, nicotine; recomputes legal flags when classification inputs change | Complete product editing without bypassing compliance |
| `POST /api/auth/password` | Password change from Settings (previously CLI only) |
| `GET /api/products`: optional `line` filter | Open a line's products |
| Day boundaries in the configured time zone (`TIMEZONE`, default `Europe/Kyiv`) | Date filters and charts match the shop's calendar day |

### 3.4 Verification plan

- Extend pytest with API tests (mongomock + TestClient) for every new or changed endpoint.
- Run the backend against a real MongoDB 7.0 with the real catalog; drive every section in headless Chrome at desktop, tablet and mobile sizes; record console errors, failed requests and server errors.
- Confirm the root diary app files are unchanged.
