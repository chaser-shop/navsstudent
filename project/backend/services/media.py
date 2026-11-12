"""Зображення товарів: тип визначається за сигнатурою файлу, а не за розширенням."""
import hashlib
import re
from pathlib import Path

MAX_BYTES = 5 * 1024 * 1024
PREFIX = "imports/images/"          # формат посилань, як в імпортованому прайсі
_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}\.(webp|png|jpe?g)$", re.I)


def detect_ext(raw: bytes) -> str | None:
    if raw[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return None


def store(raw: bytes, images_dir: Path) -> str:
    """Ім'я файлу - з хешу вмісту, тож повторне завантаження не створює копій."""
    ext = detect_ext(raw)
    if ext is None:
        raise ValueError("Підтримуються лише зображення JPEG, PNG або WebP")
    name = hashlib.sha256(raw).hexdigest()[:10] + ext
    images_dir.mkdir(parents=True, exist_ok=True)
    target = images_dir / name
    if not target.exists():
        target.write_bytes(raw)
    return name


def normalize_refs(refs, images_dir: Path) -> list[str]:
    """Посилання -> 'imports/images/<файл>'; лише наявні файли, без повторів."""
    out: list[str] = []
    for ref in refs:
        name = str(ref).rsplit("/", 1)[-1]
        if not _NAME.match(name) or not (images_dir / name).is_file():
            raise ValueError(f"Зображення «{name}» не знайдено")
        if PREFIX + name not in out:
            out.append(PREFIX + name)
    return out
