"""Журнал дій адміністраторів (колекція audit_log). Лише читання."""
import re

from fastapi import APIRouter, Depends, Query

from ..auth.security import current_admin
from ..database import get_db, public

router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.get("")
def list_audit(action: str = "", page: int = Query(1, ge=1), limit: int = Query(30, ge=1, le=100),
               db=Depends(get_db), _=Depends(current_admin)):
    f = {"action": {"$regex": "^" + re.escape(action.strip())}} if action.strip() else {}
    total = db.audit_log.count_documents(f)
    items = list(db.audit_log.find(f).sort("at", -1).skip((page - 1) * limit).limit(limit))
    return {"items": [public(i) for i in items], "total": total, "page": page, "pages": max(1, -(-total // limit))}
