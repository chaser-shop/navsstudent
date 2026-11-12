// Ukrainian labels for API codes. Keep in sync with backend constants.
export const CATEGORIES = {
  liquid: { label: 'Рідини', one: 'Рідина', icon: 'droplet' },
  pod: { label: 'Под-системи', one: 'Под-система', icon: 'battery-charging' },
  cartridge: { label: 'Картриджі (пачки)', one: 'Картриджі (пачка)', icon: 'boxes' },
  booster: { label: 'Підсилювачі', one: 'Підсилювач', icon: 'flask-conical' },
};
export const CATEGORY_EXTRA = { none: 'Не визначено', unknown: 'Товар видалено' };
export const categoryLabel = (c) => CATEGORIES[c]?.label || CATEGORY_EXTRA[c || 'none'] || c;

export const AVAILABILITY = {
  in_stock: { label: 'В наявності', tone: 'success' },
  expected: { label: 'Очікується', tone: 'info' },
  unavailable: { label: 'Немає в наявності', tone: '' },
};

export const COMPLIANCE = {
  blocked_by_law: { label: 'Заборонено законом', short: 'Заборонено', tone: 'danger', icon: 'ban' },
  hold_legal_review: { label: 'Очікує юридичної перевірки', short: 'Юр. перевірка', tone: 'warning', icon: 'shield-alert' },
};
export const REASONS = {
  container_over_10ml: 'Об’єм тари понад 10 мл',
  nicotine_over_20mg_per_ml: 'Вміст нікотину понад 20 мг/мл або не вказаний',
  flavor_additives_check: 'Потрібна перевірка ароматизаторів',
  online_advertising_ban: 'Діє заборона реклами в інтернеті',
  category_unknown: 'Категорію не визначено',
  tank_over_2ml_check: 'Перевірити об’єм картриджа (понад 2 мл)',
};

export const ORDER_STATUS = {
  new: { label: 'Нове', tone: 'info', color: 'var(--chart-2)', icon: 'sparkles' },
  confirmed: { label: 'Підтверджене', tone: 'accent', color: 'var(--chart-1)', icon: 'check' },
  in_progress: { label: 'У процесі', tone: 'violet', color: 'var(--chart-4)', icon: 'clock' },
  done: { label: 'Виконане', tone: 'success', color: 'var(--chart-3)', icon: 'circle-check' },
  cancelled: { label: 'Скасоване', tone: 'danger', color: 'var(--chart-5)', icon: 'circle-x' },
};
export const ORDER_STATUS_PLURAL = {
  new: 'Нові', confirmed: 'Підтверджені', in_progress: 'У процесі', done: 'Виконані', cancelled: 'Скасовані',
};

/** Field names used in API validation errors. */
export const FIELD_LABELS = {
  name: 'Назва', brand: 'Бренд', category: 'Категорія', product_line: 'Лінійка', model: 'Модель', variant: 'Варіант',
  volume_ml: 'Об’єм', nicotine_mg: 'Нікотин', purchase_price: 'Закупівельна ціна', status: 'Статус', images: 'Зображення',
  customer_name: 'Ім’я клієнта', contact: 'Контакт', items: 'Товари', qty: 'Кількість', product_id: 'Товар', text: 'Текст',
  username: 'Логін', password: 'Пароль', current_password: 'Поточний пароль', new_password: 'Новий пароль',
  markups: 'Націнки', liquid: 'Рідини', pod: 'Под-системи', cartridge: 'Картриджі', booster: 'Підсилювачі',
  line: 'Лінійка', new_line: 'Нова назва лінійки', shop_name: 'Назва магазину', file: 'Файл', page: 'Сторінка',
  limit: 'Кількість на сторінці', date_from: 'Дата від', date_to: 'Дата до',
};

export const PRODUCT_FIELDS = {
  name: 'назва', brand: 'бренд', category: 'категорія', product_line: 'лінійка', model: 'модель', variant: 'варіант',
  volume_ml: 'об’єм', nicotine_mg: 'нікотин', purchase_price: 'закупівельна ціна', status: 'наявність', images: 'фото',
};

const name = (d) => (d?.name ? `«${d.name}»` : '');
const list = (fields) => (fields || []).map((f) => PRODUCT_FIELDS[f]).filter(Boolean).join(', ');

/** Human description of an audit-log entry. */
export function describeAudit(a) {
  const d = a.details || {};
  switch (a.action) {
    case 'login': return { icon: 'log-in', tone: '', text: 'Вхід у систему' };
    case 'product.create': return { icon: 'package-plus', tone: 'success', text: `Створено товар ${name(d)}` };
    case 'product.update': {
      const f = list(d.fields);
      return { icon: 'pencil', tone: 'info', text: `Змінено товар ${name(d)}`.trim() + (f ? ` — ${f}` : '') };
    }
    case 'product.delete': return { icon: 'trash-2', tone: 'danger', text: 'Видалено товар' };
    case 'pricing.markups': return { icon: 'percent', tone: 'accent', text: `Оновлено націнки, перераховано цін: ${d.repriced ?? 0}` };
    case 'import.apply': return { icon: 'file-up', tone: 'accent', text: `Імпортовано прайс: додано ${d.to_insert ?? 0}, оновлено ${d.to_update ?? 0}` };
    case 'order.create': return { icon: 'shopping-cart', tone: 'success', text: `Створено замовлення ${d.number || ''}`.trim() };
    case 'order.status': return { icon: 'refresh-cw', tone: 'info', text: `Замовлення ${d.number || ''}: статус «${ORDER_STATUS[d.status]?.label || d.status}»` };
    case 'order.note': return { icon: 'message-square-text', tone: '', text: `Примітка до замовлення ${d.number || ''}`.trim() };
    case 'settings.update': return { icon: 'settings', tone: '', text: 'Оновлено налаштування магазину' };
    case 'line.update': {
      const parts = [];
      if (d.new_line) parts.push(`перейменовано на «${d.new_line}»`);
      if (d.images != null) parts.push(d.images ? `фото: ${d.images}` : 'фото прибрано');
      return { icon: 'layers', tone: 'info', text: `Лінійка «${d.line || ''}»${d.brand ? ` (${d.brand})` : ''}${parts.length ? ': ' + parts.join(', ') : ''}` };
    }
    case 'media.upload': return { icon: 'image-plus', tone: '', text: 'Завантажено зображення' };
    case 'auth.password': return { icon: 'key-round', tone: 'warning', text: 'Змінено пароль' };
    default: return { icon: 'circle-dot', tone: '', text: a.action };
  }
}

export const AUDIT_FILTERS = [
  ['', 'Усі'], ['order.', 'Замовлення'], ['product.', 'Товари'], ['line.', 'Лінійки'], ['pricing.', 'Націнки'],
  ['import.', 'Імпорт'], ['settings.', 'Налаштування'], ['media.', 'Зображення'], ['auth.', 'Безпека'], ['login', 'Входи'],
];
