import re
from datetime import datetime, timezone
from decimal import Decimal

from bson import ObjectId
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db, load, public, to_db
from ..models.schemas import ProductIn, ProductPatch
from ..services import media
from ..services.compliance import classify
from ..services.pricing import CATEGORY_LABELS, D, money, reprice, usdt_from_uah
from .pricing import get_markups

router = APIRouter(prefix="/api", tags=["products"])
STATUS_LABELS = {"in_stock": "В наявності", "expected": "Очікується на прибуття", "unavailable": "Немає в наявності"}
TEXT_FIELDS = ("name", "brand", "product_line", "model", "variant")
REQUIRED = {"name": "Назва", "brand": "Бренд", "purchase_price": "Закупівельна ціна", "status": "Наявність"}
# Поля, від яких залежить юридична позначка: зміна будь-якого з них - перекласифікація.
COMPLIANCE_INPUTS = {"category", "volume_ml", "nicotine_mg", "name"}


def _clean_text(d: dict) -> None:
    for k in TEXT_FIELDS:
        if isinstance(d.get(k), str):
            d[k] = d[k].strip() or None


def _images(refs) -> list[str]:
    try:
        return media.normalize_refs(refs, settings.images_dir)
    except ValueError as e:
        raise HTTPException(422, str(e))


def _oid(pid: str) -> ObjectId:
    try:
        return ObjectId(pid)
    except Exception:
        raise HTTPException(404, "Товар не знайдено")


def _with_usdt(p: dict) -> dict:
    """Для сторінки товару: гривня + USDT (якщо в прайсі є курс)."""
    p = load(p)
    u = p.get("usdt")
    if u and p.get("final_price") is not None:
        p["final_price_usdt"] = usdt_from_uah(p["final_price"], u["rate"])
    return p


@router.get("/products")
def list_products(q: str = "", category: str = "", brand: str = "", status: str = "",
                  compliance: str = "", line: str = "", images: str = "", sort: str = "name", page: int = Query(1, ge=1),
                  limit: int = Query(30, ge=1, le=100), db=Depends(get_db), _=Depends(current_admin)):
    f: dict = {}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        f["$or"] = [{"name": rx}, {"brand": rx}, {"model": rx}, {"variant": rx}, {"sku": rx}]
    for k, v in (("category", category), ("brand", brand), ("status", status), ("compliance.status", compliance),
                 ("product_line", line)):
        if v:
            f[k] = v
    if category == "none":          # товари без категорії (без ціни)
        f["category"] = None
    if line == "__none__":          # товари без лінійки
        f["product_line"] = None
    if images in ("with", "without"):
        f["images.0"] = {"$exists": images == "with"}
    order = {"name": [("name", 1)], "price_asc": [("final_price", 1)], "price_desc": [("final_price", -1)]}.get(sort, [("name", 1)])
    total = db.products.count_documents(f)
    items = list(db.products.find(f).sort(order).skip((page - 1) * limit).limit(limit))
    return {"items": [public(i) for i in items], "total": total, "page": page, "pages": max(1, -(-total // limit))}


@router.get("/brands")
def brands(db=Depends(get_db), _=Depends(current_admin)):
    return sorted(db.products.distinct("brand"))


@router.get("/categories")
def categories(_=Depends(current_admin)):
    return [{"id": k, "label": v} for k, v in CATEGORY_LABELS.items()]


@router.get("/products/{pid}")
def get_product(pid: str, db=Depends(get_db), _=Depends(current_admin)):
    p = db.products.find_one({"_id": _oid(pid)})
    if not p:
        raise HTTPException(404, "Товар не знайдено")
    return public(_with_usdt(p))


@router.post("/products", status_code=201)
def create_product(body: ProductIn, db=Depends(get_db), admin=Depends(current_admin)):
    d = body.model_dump()
    _clean_text(d)
    for k in ("name", "brand"):
        if not d.get(k):
            raise HTTPException(422, f"Поле «{REQUIRED[k]}» не може бути порожнім")
    d["images"] = _images(d.get("images") or [])
    d["purchase_price"] = money(D(d["purchase_price"]))
    d["category_label"] = CATEGORY_LABELS.get(d["category"], "Не визначено")
    d["status_label"] = STATUS_LABELS[d["status"]]
    d["dedupe_key"] = f"{d['brand']}|{d.get('product_line') or ''}|{d['name'].lower()}"
    d["compliance"] = classify(d["category"], d.get("volume_ml"), d.get("nicotine_mg"), d["name"])
    d["usdt"], d["internal"], d["image_scope"] = None, {"manual": True}, None
    d.update(reprice(d, get_markups(db)))
    now = datetime.now(timezone.utc)
    d["created_at"] = d["updated_at"] = now
    if db.products.find_one({"dedupe_key": d["dedupe_key"]}):
        raise HTTPException(409, "Такий товар уже існує")
    res = db.products.insert_one(to_db(d))
    audit(db, admin, "product.create", {"id": str(res.inserted_id), "name": d["name"]})
    return public(db.products.find_one({"_id": res.inserted_id}))


@router.patch("/products/{pid}")
def update_product(pid: str, body: ProductPatch, db=Depends(get_db), admin=Depends(current_admin)):
    p = db.products.find_one({"_id": _oid(pid)})
    if not p:
        raise HTTPException(404, "Товар не знайдено")
    p = load(p)
    patch = body.model_dump(exclude_unset=True)
    _clean_text(patch)
    for k, label in REQUIRED.items():
        if k in patch and not patch[k]:
            raise HTTPException(422, f"Поле «{label}» не може бути порожнім")
    if "images" in patch:
        patch["images"] = _images(patch["images"] or [])
    if "purchase_price" in patch:
        patch["purchase_price"] = money(D(patch["purchase_price"]))
        patch["usdt"] = None          # ручна ціна: USDT-джерело більше неактуальне
    if "category" in patch:
        patch["category_label"] = CATEGORY_LABELS.get(patch["category"], "Не визначено")
    if "status" in patch:
        patch["status_label"] = STATUS_LABELS[patch["status"]]
    merged = {**p, **patch}
    if COMPLIANCE_INPUTS & patch.keys():
        merged["compliance"] = patch["compliance"] = classify(merged.get("category"), merged.get("volume_ml"),
                                                              merged.get("nicotine_mg"), merged["name"])
    patch.update(reprice(merged, get_markups(db)))     # завжди від закупівельної, не від final
    patch["updated_at"] = datetime.now(timezone.utc)
    db.products.update_one({"_id": p["_id"]}, {"$set": to_db(patch)})
    audit(db, admin, "product.update", {"id": pid, "name": merged["name"],
                                        "fields": [k for k in patch if k != "updated_at"]})
    return public(_with_usdt(db.products.find_one({"_id": p["_id"]})))


@router.delete("/products/{pid}")
def delete_product(pid: str, confirm: bool = False, db=Depends(get_db), admin=Depends(current_admin)):
    if not confirm:
        raise HTTPException(400, "Потрібне підтвердження (confirm=true)")
    r = db.products.delete_one({"_id": _oid(pid)})
    if not r.deleted_count:
        raise HTTPException(404, "Товар не знайдено")
    audit(db, admin, "product.delete", {"id": pid})
    return {"deleted": True}


@router.post("/media", status_code=201)
async def upload_media(file: UploadFile = File(...), db=Depends(get_db), admin=Depends(current_admin)):
    raw = await file.read(media.MAX_BYTES + 1)
    if len(raw) > media.MAX_BYTES:
        raise HTTPException(413, "Файл завеликий: максимум 5 МБ")
    try:
        name = media.store(raw, settings.images_dir)
    except ValueError as e:
        raise HTTPException(415, str(e))
    audit(db, admin, "media.upload", {"name": name, "size": len(raw)})
    return {"name": name, "path": media.PREFIX + name}


@router.get("/media/{name}")
def get_media(name: str, _=Depends(current_admin)):
    f = (settings.images_dir / name).resolve()
    if f.parent != settings.images_dir.resolve() or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f)
