"""Клієнти. Окремої колекції немає: клієнтів зібрано із замовлень (ім'я + контакт)."""
from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth.security import current_admin
from ..database import get_db, load, public
from ..services import stats as st

router = APIRouter(prefix="/api/customers", tags=["customers"])
FIELDS = {"number": 1, "customer": 1, "total": 1, "status": 1, "created_at": 1}
SORTS = {
    "last": (lambda c: c["last_order_at"], True),
    "orders": (lambda c: (c["orders"], c["last_order_at"]), True),
    "spent": (lambda c: (c["spent"], c["last_order_at"]), True),
    "name": (lambda c: c["name"].lower(), False),
}


@router.get("")
def list_customers(q: str = "", sort: str = "last", page: int = Query(1, ge=1),
                   limit: int = Query(30, ge=1, le=100), db=Depends(get_db), _=Depends(current_admin)):
    groups = list(st.group_customers([st.normalize_order(load(o)) for o in db.orders.find({}, FIELDS)]).values())
    summary = {"customers": len(groups),
               "repeat": sum(1 for c in groups if c["orders"] - c["cancelled"] >= 2),
               "with_contact": sum(1 for c in groups if c["contact"])}
    needle = q.strip().lower()
    if needle:
        groups = [c for c in groups if needle in c["name"].lower() or needle in c["contact"].lower()]
    key, reverse = SORTS.get(sort, SORTS["last"])
    groups.sort(key=key, reverse=reverse)
    total = len(groups)
    return public({"items": groups[(page - 1) * limit: page * limit], "total": total, "page": page,
                   "pages": max(1, -(-total // limit)), "summary": summary})


@router.get("/detail")
def customer_detail(name: str = "", contact: str = "", db=Depends(get_db), _=Depends(current_admin)):
    key = st.customer_key({"name": name, "contact": contact})
    ids = [o["_id"] for o in db.orders.find({}, {"customer": 1}) if st.customer_key(o.get("customer")) == key]
    if not ids:
        raise HTTPException(404, "Клієнта не знайдено")
    orders = [st.normalize_order(load(o)) for o in db.orders.find({"_id": {"$in": ids}}).sort("created_at", -1)]
    return public({"customer": st.group_customers(orders)[key], "orders": orders})
