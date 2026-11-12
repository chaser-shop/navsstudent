// Призначення адміністратора й (необов’язково) встановлення йому пароля.
// Використання:  MONGODB_URI=… npm run make-admin -- "Прізвище Ім'я По батькові" ["пароль"]
// Без пароля: людина входить у застосунок під цим ПІБ і створює пароль сама.
'use strict';

const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { hashPassword, passwordProblem } = require('../lib/passwords');

const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const normKey = (s) => normName(s).toLocaleLowerCase('uk');

(async () => {
  const [rawName, password] = process.argv.slice(2);
  const fullName = normName(rawName);
  if (!process.env.MONGODB_URI) throw new Error('Не задано MONGODB_URI.');
  if (fullName.split(' ').length < 2) throw new Error('Використання: npm run make-admin -- "Прізвище Ім\'я По батькові" ["пароль"]');
  if (password) {
    const problem = passwordProblem(password, fullName);
    if (problem) throw new Error(problem);
  }
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  try {
    const users = client.db(process.env.DB_NAME || 'navs').collection('users');
    const set = { isAdmin: true };
    if (password) Object.assign(set, { passwordHash: await hashPassword(password), passwordSetAt: new Date() });
    await users.updateOne(
      { nameKey: normKey(fullName) },
      {
        $set: set,
        $setOnInsert: { _id: crypto.randomUUID(), fullName, deviceIds: [], deviceMeta: {}, pendingDevices: [], createdAt: new Date() },
        ...(password ? { $inc: { sessionVersion: 1 } } : {}),
      },
      { upsert: true },
    );
    console.log(`Готово: ${fullName} — адміністратор${password ? ', пароль встановлено' : ''}.`);
  } finally {
    await client.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
