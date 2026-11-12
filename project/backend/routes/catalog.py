"""Лінійки товарів (поле product_line у межах бренду): огляд, перейменування, спільні фото."""
from collections import Counter
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db, load, public
from ..models.schemas import LinePatch
from ..services.media import normalize_refs

router = APIRouter(prefix="/api/lines", tags=["catalog"])
FIELDS = {"brand": 1, "product_line": 1, "category": 1, "status": 1, "images": 1, "final_price": 1,
          "compliance.status": 1}


@router.get("")
def list_lines(category: str = "", db=Depends(get_db), _=Depends(current_admin)):
    groups: dict = {}
    unassigned: Counter = Counter()
    for p in db.products.find({"category": category} if category else {}, FIELDS):
        p = load(p)
        line = p.get("product_line")
        if not line:
            unassigned[(p.get("brand"), p.get("category") or "none")] += 1
            continue
        g = groups.setdefault((p.get("brand"), line), {
            "brand": p.get("brand"), "line": line, "count": 0, "in_stock": 0, "blocked": 0,
            "categories": Counter(), "images": [], "min_price": None, "max_price": None})
        g["count"] += 1
        g["categories"][p.get("category") or "none"] += 1
        g["in_stock"] += p.get("status") == "in_stock"
        g["blocked"] += (p.get("compliance") or {}).get("status") == "blocked_by_law"
        for im in p.get("images") or []:
            if im not in g["images"] and len(g["images"]) < 6:
                g["images"].append(im)
        price = p.get("final_price")
        if price is not None:
            g["min_price"] = price if g["min_price"] is None else min(g["min_price"], price)
            g["max_price"] = price if g["max_price"] is None else max(g["max_price"], price)
    items = []
    for g in sorted(groups.values(), key=lambda g: ((g["brand"] or "").lower(), g["line"].lower())):
        g["category"] = g["categories"].most_common(1)[0][0]
        g["categories"] = dict(g["categories"])
        items.append(g)
    return public({"items": items, "unassigned": [
        {"brand": b, "category": c, "count": n}
        for (b, c), n in sorted(unassigned.items(), key=lambda x: ((x[0][0] or "").lower(), x[0][1]))]})


@router.patch("")
def update_line(body: LinePatch, db=Depends(get_db), admin=Depends(current_admin)):
    f = {"brand": body.brand, "product_line": body.line}
    matched = db.products.count_documents(f)
    if not matched:
        raise HTTPException(404, "Лінійку не знайдено")
    upd: dict = {}
    if body.new_line is not None:
        new_line = body.new_line.strip()
        if not new_line:
            raise HTTPException(422, "Назва лінійки не може бути порожньою")
        if new_line != body.line:
            upd["product_line"] = new_line
    if body.images is not None:
        try:
            upd["images"] = normalize_refs(body.images, settings.images_dir)
        except ValueError as e:
            raise HTTPException(422, str(e))
        upd["image_scope"] = "line" if upd["images"] else None
    if not upd:
        return {"matched": matched, "modified": 0, "brand": body.brand, "line": body.line}
    upd["updated_at"] = datetime.now(timezone.utc)
    r = db.products.update_many(f, {"$set": upd})
    audit(db, admin, "line.update", {"brand": body.brand, "line": body.line, "new_line": upd.get("product_line"),
                                     "images": len(upd["images"]) if "images" in upd else None,
                                     "products": r.matched_count})
    return {"matched": r.matched_count, "modified": r.modified_count, "brand": body.brand,
            "line": upd.get("product_line", body.line)}
