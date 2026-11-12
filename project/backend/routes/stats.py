"""Агреговані показники для дашборду й аналітики. Лише читання."""
from collections import Counter
from datetime import date, datetime, timedelta

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException

from ..auth.security import current_admin
from ..config import settings
from ..database import get_db, load, public
from ..services import stats as st
from ..services.orders import STATUS_LABELS
from ..services.pricing import CATEGORY_LABELS

router = APIRouter(prefix="/api/stats", tags=["stats"])
ORDER_FIELDS = {"number": 1, "customer": 1, "total": 1, "status": 1, "created_at": 1, "items": 1}
PRODUCT_FIELDS = {"category": 1, "status": 1, "compliance.status": 1, "final_price": 1, "images": 1}


def _orders(db, f=None, fields=ORDER_FIELDS) -> list:
    return [st.normalize_order(load(o)) for o in db.orders.find(f or {}, fields)]


def _day(v: str, label: str) -> date:
    try:
        return datetime.fromisoformat(v).date()
    except ValueError:
        raise HTTPException(422, f"Дата «{label}» має бути у форматі РРРР-ММ-ДД")


@router.get("/overview")
def overview(db=Depends(get_db), _=Depends(current_admin)):
    tz = settings.timezone
    today = st.today(tz)
    start = today - timedelta(days=29)
    since, today_from = st.day_start(start, tz), st.day_start(today, tz)

    products = [load(p) for p in db.products.find({}, PRODUCT_FIELDS)]
    catalog = {
        "total": len(products),
        "by_category": {k: 0 for k in CATEGORY_LABELS} | dict(Counter(p.get("category") or "none" for p in products)),
        "by_status": {"in_stock": 0, "expected": 0, "unavailable": 0} | dict(Counter(p.get("status") for p in products)),
        "by_compliance": dict(Counter((p.get("compliance") or {}).get("status") or "none" for p in products)),
        "orderable": sum(1 for p in products if st.orderable(p)),
        "without_price": sum(1 for p in products if p.get("final_price") is None),
        "without_images": sum(1 for p in products if not p.get("images")),
    }
    orders = _orders(db, fields={"number": 1, "customer": 1, "total": 1, "status": 1, "created_at": 1})
    last30 = [o for o in orders if o["created_at"] >= since]
    open_orders = [o for o in orders if o.get("status") in st.OPEN_STATUSES]
    customers = list(st.group_customers(orders).values())
    t30 = st.period_totals(last30)
    return public({
        "timezone": str(tz), "today": today.isoformat(),
        "products": catalog,
        "orders": {"total": len(orders), "by_status": st.status_counts(orders), "open": len(open_orders),
                   "today": sum(1 for o in orders if o["created_at"] >= today_from), "last_30_days": len(last30)},
        "revenue": {"done_total": st.money_sum([o for o in orders if o.get("status") == "done"]),
                    "open_total": st.money_sum(open_orders), "last_30_days": t30["revenue"],
                    "done_30_days": t30["revenue_done"], "avg_check_30_days": t30["avg_check"]},
        "customers": {"total": len(customers),
                      "new_30_days": sum(1 for c in customers if c["first_order_at"] >= since),
                      "repeat": sum(1 for c in customers if c["orders"] - c["cancelled"] >= 2)},
        "series": st.daily_series(last30, start, today, tz),
        "recent_orders": list(db.orders.find({}).sort("created_at", -1).limit(6)),
        "activity": list(db.audit_log.find({}).sort("at", -1).limit(8)),
        "statuses": STATUS_LABELS,
    })


@router.get("/analytics")
def analytics(date_from: str = "", date_to: str = "", db=Depends(get_db), _=Depends(current_admin)):
    tz = settings.timezone
    end = _day(date_to, "до") if date_to else st.today(tz)
    start = _day(date_from, "від") if date_from else end - timedelta(days=29)
    if start > end:
        raise HTTPException(422, "Початкова дата не може бути пізнішою за кінцеву")
    days = (end - start).days + 1
    if days > 366:
        raise HTTPException(422, "Період не може перевищувати 366 днів")
    prev_start = start - timedelta(days=days)          # попередній період такої ж довжини
    cur_from = st.day_start(start, tz)
    orders = _orders(db, {"created_at": {"$gte": st.day_start(prev_start, tz),
                                         "$lt": st.day_start(end + timedelta(days=1), tz)}})
    cur = [o for o in orders if o["created_at"] >= cur_from]
    prev = [o for o in orders if o["created_at"] < cur_from]

    first = st.first_orders(_orders(db, {"status": {"$ne": "cancelled"}}, {"customer": 1, "created_at": 1}))
    keys = {st.customer_key(o.get("customer")) for o in cur if st.counts_revenue(o)}
    new = sum(1 for k in keys if first.get(k, cur_from) >= cur_from)
    pids = {str(i.get("product_id")) for o in cur for i in o.get("items", [])}
    oids = [ObjectId(p) for p in pids if ObjectId.is_valid(p)]
    cats = {str(p["_id"]): p.get("category") for p in db.products.find({"_id": {"$in": oids}}, {"category": 1})}
    return public({
        "range": {"from": start.isoformat(), "to": end.isoformat(), "days": days,
                  "previous_from": prev_start.isoformat(), "previous_to": (start - timedelta(days=1)).isoformat()},
        "timezone": str(tz),
        "totals": {**st.period_totals(cur), "new_customers": new, "returning_customers": len(keys) - new},
        "previous": st.period_totals(prev),
        "series": st.daily_series(cur, start, end, tz),
        "by_status": st.status_counts(cur),
        "by_category": st.by_category(cur, cats),
        "top_products": st.top_products(cur, 10),
        "top_customers": st.top_customers(cur, 5),
        "statuses": STATUS_LABELS,
    })
