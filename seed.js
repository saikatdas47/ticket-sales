import { openDatabase, seedDatabase, addIndex } from './database.js';
const db = openDatabase();
try {
  seedDatabase(db);
  addIndex(db);
  console.log(JSON.stringify({ events: 5, seats: 10000, orders: 0 }));
} finally { db.close(); }
