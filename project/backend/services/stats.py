"""Агрегати для дашборду, аналітики й клієнтів. Чиста логіка без звернень до БД.

Виручка рахується за сумами, зафіксованими в замовленнях під час створення;
скасовані замовлення до виручки не входять. День визначається в часовому поясі магазину.
"""
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from .orders import STATUSES
from .pricing import money

OPEN_STATUSES = ("new", "confirmed", "in_progress")
_ZERO = Decimal("0")


def as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def today(tz) -> date:
    return datetime.now(timezone.utc).astimezone(tz).date()


def day_start(d: date, tz) -> datetime:
    """Початок календарного дня магазину, переведений в UTC."""
    return datetime.combine(d, time.min, tzinfo=tz).astimezone(timezone.utc)


def normalize_order(o: dict) -> dict:
    o["created_at"] = as_utc(o["created_at"])
    return o


def customer_key(customer) -> str:
    c = customer or {}
    return f"{(c.get('name') or '').strip().lower()}|{(c.get('contact') or '').strip().lower()}"


def counts_revenue(o: dict) -> bool:
    return o.get("status") != "cancelled"


def _dec(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v or 0))


def money_sum(orders) -> Decimal:
    return money(sum((_dec(o.get("total")) for o in orders), _ZERO))


def orderable(p: dict) -> bool:
    return (p.get("status") == "in_stock" and p.get("final_price") is not None
            and (p.get("compliance") or {}).get("status") != "blocked_by_law")


def status_counts(orders) -> dict:
    c = Counter(o.get("status") for o in orders)
    return {s: c.get(s, 0) for s in STATUSES}


def period_totals(orders) -> dict:
    valid = [o for o in orders if counts_revenue(o)]
    done = [o for o in orders if o.get("status") == "done"]
    revenue = money_sum(valid)
    return {
        "orders": len(orders), "orders_valid": len(valid), "orders_done": len(done),
        "orders_cancelled": len(orders) - len(valid),
        "revenue": revenue, "revenue_done": money_sum(done),
        "avg_check": money(revenue / len(valid)) if valid else None,
        "items_sold": sum(int(i.get("qty") or 0) for o in valid for i in o.get("items", [])),
        "customers": len({customer_key(o.get("customer")) for o in valid}),
    }


def daily_series(orders, start: date, end: date, tz) -> list:
    days = {start + timedelta(days=i): {"orders": 0, "cancelled": 0, "revenue": _ZERO}
            for i in range((end - start).days + 1)}
    for o in orders:
        bucket = days.get(o["created_at"].astimezone(tz).date())
        if bucket is None:
            continue
        bucket["orders"] += 1
        if counts_revenue(o):
            bucket["revenue"] += _dec(o.get("total"))
        else:
            bucket["cancelled"] += 1
    return [{"date": d.isoformat(), "orders": v["orders"], "cancelled": v["cancelled"], "revenue": money(v["revenue"])}
            for d, v in days.items()]


def _line_total(it: dict) -> Decimal:
    if it.get("line_total") is not None:
        return _dec(it["line_total"])
    return _dec(it.get("unit_price")) * int(it.get("qty") or 0)


def top_products(orders, limit: int = 10) -> list:
    agg: dict = {}
    for o in orders:
        if not counts_revenue(o):
            continue
        for it in o.get("items", []):
            pid = str(it.get("product_id"))
            a = agg.setdefault(pid, {"product_id": pid, "name": it.get("name"), "brand": it.get("brand"),
                                     "qty": 0, "orders": 0, "revenue": _ZERO})
            a["qty"] += int(it.get("qty") or 0)
            a["orders"] += 1
            a["revenue"] += _line_total(it)
    top = sorted(agg.values(), key=lambda a: (a["revenue"], a["qty"]), reverse=True)[:limit]
    return [{**a, "revenue": money(a["revenue"])} for a in top]


def by_category(orders, categories: dict) -> list:
    """categories: {product_id: category}. Видалені товари потрапляють у 'unknown'."""
    agg: dict = {}
    for o in orders:
        if not counts_revenue(o):
            continue
        for it in o.get("items", []):
            pid = str(it.get("product_id"))
            cat = (categories.get(pid) or "none") if pid in categories else "unknown"
            a = agg.setdefault(cat, {"category": cat, "qty": 0, "revenue": _ZERO})
            a["qty"] += int(it.get("qty") or 0)
            a["revenue"] += _line_total(it)
    ranked = sorted(agg.values(), key=lambda a: a["revenue"], reverse=True)
    return [{**a, "revenue": money(a["revenue"])} for a in ranked]


def group_customers(orders) -> dict:
    """Клієнт = ім'я + контакт без урахування регістру й зайвих пробілів."""
    out: dict = {}
    for o in sorted(orders, key=lambda o: o["created_at"]):
        c = o.get("customer") or {}
        k = customer_key(c)
        s = out.get(k)
        if s is None:
            s = out[k] = {"key": k, "name": "", "contact": "", "orders": 0, "open": 0, "done": 0, "cancelled": 0,
                          "spent": _ZERO, "first_order_at": o["created_at"]}
        s["name"] = (c.get("name") or "").strip() or s["name"]
        s["contact"] = (c.get("contact") or "").strip() or s["contact"]
        s["orders"] += 1
        status = o.get("status")
        if status == "cancelled":
            s["cancelled"] += 1
        else:
            s["spent"] += _dec(o.get("total"))
        if status == "done":
            s["done"] += 1
        if status in OPEN_STATUSES:
            s["open"] += 1
        s["last_order_at"], s["last_number"], s["last_status"] = o["created_at"], o.get("number"), status
    for s in out.values():
        valid = s["orders"] - s["cancelled"]
        s["avg_check"] = money(s["spent"] / valid) if valid else None
        s["spent"] = money(s["spent"])
    return out


def top_customers(orders, limit: int = 5) -> list:
    groups = group_customers([o for o in orders if counts_revenue(o)]).values()
    return sorted(groups, key=lambda s: (s["spent"], s["orders"]), reverse=True)[:limit]


def first_orders(orders) -> dict:
    first: dict = {}
    for o in orders:
        k = customer_key(o.get("customer"))
        if k not in first or o["created_at"] < first[k]:
            first[k] = o["created_at"]
    return first
