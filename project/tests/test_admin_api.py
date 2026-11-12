"""API-тести адмін-панелі (mongomock + TestClient): нові та змінені маршрути."""
from decimal import Decimal

import pytest

pytest.importorskip("mongomock")
pytest.importorskip("argon2")
pytest.importorskip("httpx")
import mongomock  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.auth.security import hash_password  # noqa: E402
from backend.database import get_db, to_db  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PASSWORD = "correct-horse-1"


def _product(**kw):
    base = {"name": "Pod A", "brand": "OXVA", "category": "pod", "status": "in_stock", "purchase_price": Decimal("812"),
            "markup": Decimal("70"), "final_price": Decimal("882"), "compliance": {"status": "hold_legal_review"},
            "product_line": None, "images": [], "dedupe_key": kw.get("name", "Pod A")}
    return to_db({**base, **kw})


@pytest.fixture()
def api(monkeypatch, tmp_path):
    monkeypatch.setenv("JWT_SECRET", "s" * 40)
    monkeypatch.setenv("IMAGES_DIR", str(tmp_path))
    monkeypatch.setenv("TIMEZONE", "Europe/Kyiv")
    from backend.main import app
    db = mongomock.MongoClient(tz_aware=True).db
    db.admins.insert_one({"username": "boss", "password_hash": hash_password(PASSWORD), "failed": 0})
    ids = {
        "pod": str(db.products.insert_one(_product()).inserted_id),
        "pod2": str(db.products.insert_one(_product(name="Pod B", final_price=Decimal("500"))).inserted_id),
        "liquid": str(db.products.insert_one(_product(
            name="Mango", brand="Flavorlab", category="liquid", product_line="Flavorlab 30ml", volume_ml=30,
            nicotine_mg=50, final_price=Decimal("250"), compliance={"status": "blocked_by_law"})).inserted_id),
    }
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    token = client.post("/api/auth/login", json={"username": "boss", "password": PASSWORD}).json()["token"]
    client.headers["Authorization"] = f"Bearer {token}"
    yield client, db, ids
    app.dependency_overrides.clear()


def _order(client, ids, name="Олена", contact="+380501112233", qty=1, key="pod"):
    r = client.post("/api/orders", json={"customer_name": name, "contact": contact,
                                         "items": [{"product_id": ids[key], "qty": qty}]})
    assert r.status_code == 201, r.text
    return r.json()


def test_new_routes_require_auth(api):
    client, _, _ = api
    anon = TestClient(client.app)
    for path in ("/api/stats/overview", "/api/stats/analytics", "/api/customers", "/api/customers/detail",
                 "/api/audit", "/api/lines", "/api/orders/ORD-1"):
        assert anon.get(path).status_code == 401, path
    assert anon.post("/api/media", files={"file": ("a.png", PNG, "image/png")}).status_code == 401
    assert anon.post("/api/auth/password", json={"current_password": "x", "new_password": "y"}).status_code == 401


def test_product_patch_all_fields_and_compliance_reclassified(api):
    client, _, ids = api
    r = client.patch(f"/api/products/{ids['liquid']}", json={"volume_ml": 10, "nicotine_mg": 20})
    assert r.status_code == 200 and r.json()["compliance"]["status"] == "hold_legal_review"
    r = client.patch(f"/api/products/{ids['liquid']}", json={"nicotine_mg": 50})
    assert r.json()["compliance"]["status"] == "blocked_by_law"
    r = client.patch(f"/api/products/{ids['pod']}", json={"brand": " VAPORESSO ", "product_line": "XROS",
                                                         "model": "XROS 4", "variant": "Black", "name": "XROS 4 Black"})
    body = r.json()
    assert (body["brand"], body["product_line"], body["model"], body["variant"]) == ("VAPORESSO", "XROS", "XROS 4", "Black")
    assert client.patch(f"/api/products/{ids['pod']}", json={"name": None}).status_code == 422
    assert client.patch(f"/api/products/{ids['pod']}", json={"brand": "   "}).status_code == 422
    assert client.patch(f"/api/products/{ids['pod']}", json={"images": ["imports/images/missing.webp"]}).status_code == 422


def test_media_upload_validation_and_serving(api):
    client, _, ids = api
    r = client.post("/api/media", files={"file": ("photo.png", PNG, "image/png")})
    assert r.status_code == 201
    name = r.json()["name"]
    assert name.endswith(".png") and r.json()["path"] == "imports/images/" + name
    assert client.get(f"/api/media/{name}").content == PNG
    assert client.post("/api/media", files={"file": ("x.png", b"<svg></svg>", "image/png")}).status_code == 415
    big = PNG + b"\x00" * (5 * 1024 * 1024)
    assert client.post("/api/media", files={"file": ("big.png", big, "image/png")}).status_code == 413
    r = client.patch(f"/api/products/{ids['pod']}", json={"images": [name, "imports/images/" + name]})
    assert r.json()["images"] == ["imports/images/" + name]


def test_orders_search_paging_detail_and_history(api):
    client, _, ids = api
    a = _order(client, ids, name="  Олена Петренко ")
    _order(client, ids, name="Іван", contact="@ivan")
    assert a["customer"]["name"] == "Олена Петренко" and len(a["history"]) == 1
    r = client.get("/api/orders", params={"q": "олена"}).json()
    assert r["total"] == 1 and r["items"][0]["number"] == a["number"]
    assert client.get("/api/orders", params={"q": "@ivan"}).json()["total"] == 1
    r = client.get("/api/orders", params={"limit": 1, "page": 2}).json()
    assert r["pages"] == 2 and len(r["items"]) == 1
    assert client.get(f"/api/orders/{a['number']}").json()["number"] == a["number"]
    assert client.get("/api/orders/ORD-NOPE").status_code == 404
    h = client.patch(f"/api/orders/{a['number']}/status", json={"status": "confirmed"}).json()["history"]
    assert [x["status"] for x in h] == ["new", "confirmed"] and h[-1]["by"] == "boss"
    h = client.patch(f"/api/orders/{a['number']}/status", json={"status": "confirmed"}).json()["history"]
    assert len(h) == 2                                   # той самий статус - без нового запису
    assert client.post("/api/orders", json={"customer_name": "  ", "items": [{"product_id": ids["pod"], "qty": 1}]}).status_code == 422
    assert client.get("/api/orders", params={"date_from": "12.11.2026"}).status_code == 422


def test_stats_overview_and_analytics(api):
    client, _, ids = api
    a = _order(client, ids, qty=2)                       # 1764
    b = _order(client, ids, name="Іван", contact="", key="pod2")   # 500
    client.patch(f"/api/orders/{b['number']}/status", json={"status": "cancelled"})
    client.patch(f"/api/orders/{a['number']}/status", json={"status": "done"})
    ov = client.get("/api/stats/overview").json()
    assert ov["products"]["total"] == 3 and ov["products"]["orderable"] == 2
    assert ov["products"]["by_compliance"] == {"hold_legal_review": 2, "blocked_by_law": 1}
    assert ov["orders"]["total"] == 2 and ov["orders"]["today"] == 2 and ov["orders"]["by_status"]["cancelled"] == 1
    assert ov["revenue"]["last_30_days"] == "1764.00" and ov["revenue"]["done_total"] == "1764.00"
    assert len(ov["series"]) == 30 and ov["series"][-1]["orders"] == 2 and ov["series"][-1]["revenue"] == "1764.00"
    assert ov["customers"]["total"] == 2 and len(ov["recent_orders"]) == 2 and ov["activity"]
    an = client.get("/api/stats/analytics").json()
    assert an["range"]["days"] == 30 and an["totals"]["orders"] == 2 and an["totals"]["orders_cancelled"] == 1
    assert an["totals"]["revenue"] == "1764.00" and an["totals"]["avg_check"] == "1764.00"
    assert an["totals"]["new_customers"] == 1 and an["previous"]["orders"] == 0
    assert an["top_products"][0]["product_id"] == ids["pod"] and an["top_products"][0]["qty"] == 2
    assert an["by_category"] == [{"category": "pod", "qty": 2, "revenue": "1764.00"}]
    assert client.get("/api/stats/analytics", params={"date_from": "2026-02-01", "date_to": "2026-01-01"}).status_code == 422
    assert client.get("/api/stats/analytics", params={"date_from": "2024-01-01", "date_to": "2026-01-01"}).status_code == 422
    assert client.get("/api/stats/analytics", params={"date_from": "вчора"}).status_code == 422


def test_customers_grouping_and_detail(api):
    client, _, ids = api
    _order(client, ids, name="Олена ", contact="+380501112233")
    _order(client, ids, name="олена", contact=" +380501112233", key="pod2")
    _order(client, ids, name="Іван", contact="")
    r = client.get("/api/customers").json()
    assert r["total"] == 2 and r["summary"] == {"customers": 2, "repeat": 1, "with_contact": 1}
    top = client.get("/api/customers", params={"sort": "spent"}).json()["items"][0]
    assert top["orders"] == 2 and top["spent"] == "1382.00" and top["avg_check"] == "691.00"
    assert client.get("/api/customers", params={"q": "іван"}).json()["total"] == 1
    d = client.get("/api/customers/detail", params={"name": "ОЛЕНА", "contact": "+380501112233"}).json()
    assert len(d["orders"]) == 2 and d["customer"]["orders"] == 2
    assert client.get("/api/customers/detail", params={"name": "Нікого"}).status_code == 404


def test_lines_overview_rename_and_images(api):
    client, db, _ = api
    lines = client.get("/api/lines").json()
    assert [(i["brand"], i["line"], i["count"], i["blocked"]) for i in lines["items"]] == [("Flavorlab", "Flavorlab 30ml", 1, 1)]
    assert sum(u["count"] for u in lines["unassigned"]) == 2
    name = client.post("/api/media", files={"file": ("l.png", PNG, "image/png")}).json()["name"]
    r = client.patch("/api/lines", json={"brand": "Flavorlab", "line": "Flavorlab 30ml", "new_line": " Flavorlab Salt ",
                                         "images": [name]})
    assert r.status_code == 200 and r.json()["line"] == "Flavorlab Salt" and r.json()["matched"] == 1
    p = db.products.find_one({"name": "Mango"})
    assert p["product_line"] == "Flavorlab Salt" and p["images"] == ["imports/images/" + name] and p["image_scope"] == "line"
    assert client.get("/api/products", params={"line": "Flavorlab Salt"}).json()["total"] == 1
    assert client.get("/api/products", params={"images": "without"}).json()["total"] == 2
    assert client.patch("/api/lines", json={"brand": "X", "line": "Nope"}).status_code == 404
    assert client.patch("/api/lines", json={"brand": "Flavorlab", "line": "Flavorlab Salt", "new_line": " "}).status_code == 422


def test_audit_log_listing(api):
    client, _, ids = api
    a = _order(client, ids)
    client.post(f"/api/orders/{a['number']}/notes", json={"text": "Передзвонити"})
    r = client.get("/api/audit").json()
    assert [i["action"] for i in r["items"]][:3] == ["order.note", "order.create", "login"]
    assert client.get("/api/audit", params={"action": "order."}).json()["total"] == 2


def test_password_change(api):
    client, _, _ = api
    url = "/api/auth/password"
    assert client.post(url, json={"current_password": "wrong-one!", "new_password": "another-pass-1"}).status_code == 400
    assert client.post(url, json={"current_password": PASSWORD, "new_password": "short"}).status_code == 422
    assert client.post(url, json={"current_password": PASSWORD, "new_password": PASSWORD}).status_code == 422
    assert client.post(url, json={"current_password": PASSWORD, "new_password": "another-pass-1"}).json() == {"ok": True}
    anon = TestClient(client.app)
    assert anon.post("/api/auth/login", json={"username": "boss", "password": PASSWORD}).status_code == 401
    assert anon.post("/api/auth/login", json={"username": "boss", "password": "another-pass-1"}).status_code == 200
