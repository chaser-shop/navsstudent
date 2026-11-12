from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..auth.security import audit, authenticate, current_admin, hash_password, verify_password
from ..database import get_db
from ..models.schemas import LoginIn, PasswordIn

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginIn, db=Depends(get_db)):
    token = authenticate(db, body.username, body.password)
    audit(db, body.username, "login")
    return {"token": token}


@router.get("/me")
def me(admin: str = Depends(current_admin)):
    return {"username": admin}


@router.post("/password")
def change_password(body: PasswordIn, db=Depends(get_db), admin: str = Depends(current_admin)):
    adm = db.admins.find_one({"username": admin})
    # 400, а не 401: 401 означає завершену сесію й розлогінює клієнта
    if not verify_password(adm.get("password_hash", ""), body.current_password):
        raise HTTPException(400, "Поточний пароль невірний")
    if body.new_password == body.current_password:
        raise HTTPException(422, "Новий пароль має відрізнятися від поточного")
    try:
        new_hash = hash_password(body.new_password)
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.admins.update_one({"_id": adm["_id"]}, {"$set": {"password_hash": new_hash,
                                                       "password_changed_at": datetime.now(timezone.utc)}})
    audit(db, admin, "auth.password")
    return {"ok": True}
