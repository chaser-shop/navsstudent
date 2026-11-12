'use strict';
// Паролі: scrypt із сіллю (вбудований crypto Node.js, без додаткових залежностей).

const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFC'), salt, KEYLEN, { ...params, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: +N, r: +r, p: +p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Повертає текст помилки українською або '' — якщо пароль прийнятний. */
function passwordProblem(password, fullName) {
  const pw = String(password == null ? '' : password);
  if (pw.length < MIN_LENGTH) return `Пароль має містити щонайменше ${MIN_LENGTH} символів.`;
  if (pw.length > MAX_LENGTH) return `Пароль задовгий (максимум ${MAX_LENGTH} символів).`;
  if (/^\d+$/.test(pw)) return 'Пароль не може складатися лише з цифр.';
  if (/^(.)\1+$/.test(pw)) return 'Пароль не може складатися з одного повторюваного символу.';
  const name = String(fullName || '').toLocaleLowerCase('uk').replace(/\s+/g, '');
  if (name && pw.toLocaleLowerCase('uk').replace(/\s+/g, '') === name) return 'Пароль не може збігатися з ПІБ.';
  return '';
}

// Одноразовий код скидання: без схожих символів (0/O, 1/l/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function resetCode(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, resetCode, MIN_LENGTH };
