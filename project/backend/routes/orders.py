import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db, public
from ..models.schemas import NoteIn, OrderIn, StatusIn
from ..services import orders as svc
from ..services.stats import day_start

router = APIRouter(prefix="/api/orders", tags=["orders"])


def _day(v: str):
    return datetime.fromisoformat(v).date()


@router.get("")
def list_orders(number: str = "", q: str = "", status: str = "", date_from: str = "", date_to: str = "",
                page: int = Query(1, ge=1), limit: int = Query(30, ge=1, le=100),
                db=Depends(get_db), _=Depends(current_admin)):
    f: dict = {}
    if number:
        f["number"] = {"$regex": re.escape(number.strip()), "$options": "i"}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        f["$or"] = [{"number": rx}, {"customer.name": rx}, {"customer.contact": rx}]
    if status:
        f["status"] = status
    tz = settings.timezone          # межі днів - за календарем магазину
    try:
        rng = {}
        if date_from:
            rng["$gte"] = day_start(_day(date_from), tz)
        if date_to:
            rng["$lt"] = day_start(_day(date_to) + timedelta(days=1), tz)
    except ValueError:
        raise HTTPException(422, "Дата має бути у форматі РРРР-ММ-ДД")
    if rng:
        f["created_at"] = rng
    total = db.orders.count_documents(f)
    items = list(db.orders.find(f).sort("created_at", -1).skip((page - 1) * limit).limit(limit))
    return {"items": [public(i) for i in items], "total": total, "page": page,
            "pages": max(1, -(-total // limit)), "statuses": svc.STATUS_LABELS}


@router.get("/{number}")
def get_order(number: str, db=Depends(get_db), _=Depends(current_admin)):
    o = db.orders.find_one({"number": number})
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    return public(o)


@router.post("", status_code=201)
def create(body: OrderIn, db=Depends(get_db), admin=Depends(current_admin)):
    name = body.customer_name.strip()
    if not name:
        raise HTTPException(422, "Вкажіть ім'я клієнта")
    try:
        o = svc.create_order(db, {"name": name, "contact": body.contact.strip()},
                             [i.model_dump() for i in body.items], admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    audit(db, admin, "order.create", {"number": o["number"]})
    return public(o)


@router.patch("/{number}/status")
def status(number: str, body: StatusIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.set_status(db, number, body.status, admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    audit(db, admin, "order.status", {"number": number, "status": body.status})
    return public(o)


@router.post("/{number}/notes")
def note(number: str, body: NoteIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.add_note(db, number, body.text, admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    audit(db, admin, "order.note", {"number": number})
    return public(o)
