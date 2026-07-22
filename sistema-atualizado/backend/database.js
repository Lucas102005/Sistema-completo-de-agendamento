const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'agendamentos.db'));

db.serialize(() => {
  // Usuários administradores (login do dono do negócio)
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Agendamentos, agora com preço travado no momento da criação e status ampliado
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      service_price REAL NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      stock_applied INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // status possíveis: pendente, confirmado, recusado, concluido, cancelado
  // stock_applied: 1 quando o estoque já foi baixado para esse agendamento (evita baixar 2x)

  // Produtos / estoque
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Pedidos de compra de produtos (loja)
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      stock_applied INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // status possíveis: pendente, confirmado, recusado, concluido, cancelado
  // stock_applied: 1 quando o estoque de TODOS os itens já foi baixado (evita baixar 2x)

  // Itens de cada pedido (preço travado no momento da compra)
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);
  
  console.log('✅ Banco de dados pronto (admin_users, bookings, products, orders, order_items)');
});

module.exports = db;