const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');    
const path = require('path');

const db = require('./database');
const { requireAuth, JWT_SECRET } = require('./middleware/auth');
const { SERVICES, getServiceConfig } = require('./services-config');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('../frontend'));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({ storage });

const PORT = process.env.PORT || 3000;
const STATUS_VALIDOS = ['pendente', 'confirmado', 'recusado', 'concluido', 'cancelado'];

// ==================== UPLOAD DE IMAGEM ====================
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  res.json({ image_url: `/uploads/${req.file.filename}` });
});

// ==================== LOGIN ====================

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }

  db.get('SELECT * FROM admin_users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '12h',
    });
    res.json({ token, username: user.username });
  });
});

// ==================== SERVIÇOS (público, pra popular o select do agendamento) ====================

app.get('/api/services', (req, res) => {
  const list = Object.entries(SERVICES).map(([name, cfg]) => ({ name, price: cfg.price }));
  res.json(list);
});

// ==================== AGENDAMENTOS - ROTAS PÚBLICAS (cliente final) ====================

// Só devolve horários ocupados por data, SEM nome/telefone de ninguém.
// Substitui o antigo uso de GET /api/bookings no frontend público.
app.get('/api/availability', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'Informe "from" e "to" (YYYY-MM-DD).' });
  }
  db.all(
    `SELECT date, time FROM bookings
     WHERE date BETWEEN ? AND ? AND status NOT IN ('recusado', 'cancelado')`,
    [from, to],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Cliente cria o agendamento (fica como "pendente" até o dono aceitar)
app.post('/api/bookings', (req, res) => {
  const { service, date, time, name, phone } = req.body;

  if (!service || !date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  const serviceCfg = getServiceConfig(service);
  if (!serviceCfg) {
    return res.status(400).json({ error: 'Serviço inválido.' });
  }

  db.get(
    `SELECT * FROM bookings WHERE date = ? AND time = ? AND status NOT IN ('recusado', 'cancelado')`,
    [date, time],
    (err, existing) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existing) return res.status(409).json({ error: 'Horário já ocupado' });

      db.run(
        `INSERT INTO bookings (service, service_price, date, time, name, phone, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pendente')`,
        [service, serviceCfg.price, date, time, name, phone],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.status(201).json({
            id: this.lastID, service, date, time, name, phone, status: 'pendente',
          });
        }
      );
    }
  );
});

// ==================== LOJA - ROTAS PÚBLICAS (cliente final) ====================

// Lista produtos com estoque disponível (não mostra o "id interno" de outros dados sensíveis)
app.get('/api/store/products', (req, res) => {
  db.all(
    'SELECT id, name, price, stock, image_url FROM products WHERE stock > 0 ORDER BY name',
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Cliente faz um pedido (fica "pendente" até o dono aceitar — só então o estoque baixa)
app.post('/api/orders', (req, res) => {
  const { name, phone, items } = req.body;

  if (!name || !phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe nome, telefone e ao menos um item.' });
  }

  const productIds = items.map((i) => i.product_id);
  const placeholders = productIds.map(() => '?').join(',');

  db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds, (err, products) => {
    if (err) return res.status(500).json({ error: err.message });

    const productMap = new Map(products.map((p) => [p.id, p]));
    let total = 0;
    const resolvedItems = [];

    for (const item of items) {
      const product = productMap.get(item.product_id);
      const quantity = parseInt(item.quantity, 10);

      if (!product) return res.status(400).json({ error: `Produto inválido (id ${item.product_id}).` });
      if (!quantity || quantity < 1) return res.status(400).json({ error: `Quantidade inválida para ${product.name}.` });
      if (quantity > product.stock) {
        return res.status(409).json({ error: `Estoque insuficiente para ${product.name}. Disponível: ${product.stock}.` });
      }

      // preço sempre travado no servidor, nunca confia no que o cliente mandou
      total += product.price * quantity;
      resolvedItems.push({ product_id: product.id, product_name: product.name, unit_price: product.price, quantity });
    }

    db.run(
      `INSERT INTO orders (name, phone, total, status) VALUES (?, ?, ?, 'pendente')`,
      [name, phone, total],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        const orderId = this.lastID;

        const stmt = db.prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)`
        );
        resolvedItems.forEach((i) => {
          stmt.run(orderId, i.product_id, i.product_name, i.unit_price, i.quantity);
        });
        stmt.finalize((err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.status(201).json({ id: orderId, name, phone, total, status: 'pendente', items: resolvedItems });
        });
      }
    );
  });
});

// ==================== A PARTIR DAQUI: TUDO PRECISA DE LOGIN ====================
app.use('/api/admin', requireAuth);

// ---- Agendamentos (admin) ----

app.get('/api/admin/bookings', (req, res) => {
  const { status, date } = req.query;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  if (date) {
    query += ' AND date = ?';
    params.push(date);
  }
  query += ' ORDER BY date ASC, time ASC';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Editar dados do agendamento (data/hora/serviço/cliente)
app.put('/api/admin/bookings/:id', (req, res) => {
  const { id } = req.params;
  const { service, date, time, name, phone } = req.body;

  const serviceCfg = service ? getServiceConfig(service) : null;
  if (service && !serviceCfg) {
    return res.status(400).json({ error: 'Serviço inválido.' });
  }

  db.get('SELECT * FROM bookings WHERE id = ?', [id], (err, booking) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    const novo = {
      service: service || booking.service,
      service_price: serviceCfg ? serviceCfg.price : booking.service_price,
      date: date || booking.date,
      time: time || booking.time,
      name: name || booking.name,
      phone: phone || booking.phone,
    };

    db.run(
      `UPDATE bookings SET service=?, service_price=?, date=?, time=?, name=?, phone=?, updated_at=CURRENT_TIMESTAMP
       WHERE id = ?`,
      [novo.service, novo.service_price, novo.date, novo.time, novo.name, novo.phone, id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: Number(id), ...novo });
      }
    );
  });
});

// Aceitar / recusar / concluir / cancelar — aqui é onde o estoque é ajustado automaticamente
app.patch('/api/admin/bookings/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  db.get('SELECT * FROM bookings WHERE id = ?', [id], (err, booking) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!booking) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    const serviceCfg = getServiceConfig(booking.service);
    const produto = serviceCfg && serviceCfg.stockProduct;

    const aplicarBaixa = status === 'confirmado' && !booking.stock_applied && produto;
    const estornar = ['recusado', 'cancelado'].includes(status) && booking.stock_applied && produto;

    const finalizar = (novoStockApplied) => {
      db.run(
        `UPDATE bookings SET status=?, stock_applied=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [status, novoStockApplied, id],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ id: Number(id), status, stock_applied: novoStockApplied });
        }
      );
    };

    if (aplicarBaixa) {
      db.run(
        'UPDATE products SET stock = stock - 1 WHERE name = ? AND stock > 0',
        [produto],
        () => finalizar(1)
      );
    } else if (estornar) {
      db.run(
        'UPDATE products SET stock = stock + 1 WHERE name = ?',
        [produto],
        () => finalizar(0)
      );
    } else {
      finalizar(booking.stock_applied);
    }
  });
});

app.delete('/api/admin/bookings/:id', (req, res) => {
  db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes > 0 });
  });
});

// ---- Estoque (admin) ----

app.get('/api/admin/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/admin/products', (req, res) => {
  const { name, price, stock = 0 } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });

  db.run(
    'INSERT INTO products (name, price, stock) VALUES (?, ?, ?)',
    [name, price, stock],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID, name, price, stock });
    }
  );
});

// Editar produto (nome, preço, e AJUSTE de estoque — soma/subtrai, não substitui)
app.put('/api/admin/products/:id', (req, res) => {
  const { id } = req.params;
  const { name, price, stock } = req.body;

  db.get('SELECT * FROM products WHERE id = ?', [id], (err, product) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

    const novo = {
      name: name ?? product.name,
      price: price ?? product.price,
      stock: stock ?? product.stock,
    };

    db.run(
      'UPDATE products SET name=?, price=?, stock=? WHERE id=?',
      [novo.name, novo.price, novo.stock, id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: Number(id), ...novo });
      }
    );
  });
});

app.delete('/api/admin/products/:id', (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes > 0 });
  });
});

// ---- Pedidos da loja (admin) ----

app.get('/api/admin/orders', (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC';

  db.all(query, params, (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });
    if (orders.length === 0) return res.json([]);

    const orderIds = orders.map((o) => o.id);
    const placeholders = orderIds.map(() => '?').join(',');
    db.all(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`, orderIds, (err2, items) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const itemsByOrder = {};
      items.forEach((i) => {
        if (!itemsByOrder[i.order_id]) itemsByOrder[i.order_id] = [];
        itemsByOrder[i.order_id].push(i);
      });
      res.json(orders.map((o) => ({ ...o, items: itemsByOrder[o.id] || [] })));
    });
  });
});

// Aceitar / recusar / concluir / cancelar pedido — baixa/estorna estoque de TODOS os itens
app.patch('/api/admin/orders/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use um de: ${STATUS_VALIDOS.join(', ')}` });
  }

  db.get('SELECT * FROM orders WHERE id = ?', [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    db.all('SELECT * FROM order_items WHERE order_id = ?', [id], (err2, items) => {
      if (err2) return res.status(500).json({ error: err2.message });

      const aplicarBaixa = status === 'confirmado' && !order.stock_applied;
      const estornar = ['recusado', 'cancelado'].includes(status) && order.stock_applied;

      const finalizar = (novoStockApplied) => {
        db.run(
          `UPDATE orders SET status=?, stock_applied=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [status, novoStockApplied, id],
          function (err3) {
            if (err3) return res.status(500).json({ error: err3.message });
            res.json({ id: Number(id), status, stock_applied: novoStockApplied });
          }
        );
      };

      if (aplicarBaixa) {
        // Verifica estoque suficiente para TODOS os itens antes de baixar qualquer um
        db.all(
          `SELECT id, stock FROM products WHERE id IN (${items.map(() => '?').join(',')})`,
          items.map((i) => i.product_id),
          (err4, products) => {
            if (err4) return res.status(500).json({ error: err4.message });
            const stockMap = new Map(products.map((p) => [p.id, p.stock]));
            const insuficiente = items.find((i) => (stockMap.get(i.product_id) ?? 0) < i.quantity);
            if (insuficiente) {
              return res.status(409).json({ error: `Estoque insuficiente para ${insuficiente.product_name}.` });
            }
            const stmt = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
            items.forEach((i) => stmt.run(i.quantity, i.product_id));
            stmt.finalize(() => finalizar(1));
          }
        );
      } else if (estornar) {
        const stmt = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
        items.forEach((i) => stmt.run(i.quantity, i.product_id));
        stmt.finalize(() => finalizar(0));
      } else {
        finalizar(order.stock_applied);
      }
    });
  });
});

app.delete('/api/admin/orders/:id', (req, res) => {
  db.run('DELETE FROM order_items WHERE order_id = ?', [req.params.id], () => {
    db.run('DELETE FROM orders WHERE id = ?', [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: this.changes > 0 });
    });
  });
});

// ---- Financeiro (admin) ----

app.get('/api/admin/financeiro', (req, res) => {
  const { from, to } = req.query;
  const params = [];
  let dateFilter = '';
  if (from && to) {
    dateFilter = 'AND date BETWEEN ? AND ?';
    params.push(from, to);
  }

  // Faturamento de agendamentos: só confirmado/concluído entra
  db.all(
    `SELECT * FROM bookings WHERE status IN ('confirmado', 'concluido') ${dateFilter}`,
    params,
    (err, bookingRows) => {
      if (err) return res.status(500).json({ error: err.message });

      // Faturamento de pedidos da loja (o filtro de data usa created_at, já que orders não tem "date" de agendamento)
      let orderDateFilter = '';
      const orderParams = [];
      if (from && to) {
        orderDateFilter = "AND date(created_at) BETWEEN ? AND ?";
        orderParams.push(from, to);
      }

      db.all(
        `SELECT * FROM orders WHERE status IN ('confirmado', 'concluido') ${orderDateFilter}`,
        orderParams,
        (errO, orderRows) => {
          if (errO) return res.status(500).json({ error: errO.message });

          const orderIds = orderRows.map((o) => o.id);
          const withItems = (items) => {
            const itemsByOrder = {};
            items.forEach((i) => {
              if (!itemsByOrder[i.order_id]) itemsByOrder[i.order_id] = [];
              itemsByOrder[i.order_id].push(i);
            });

            const faturamentoServicos = bookingRows.reduce((acc, b) => acc + b.service_price, 0);
            const faturamentoProdutos = orderRows.reduce((acc, o) => acc + o.total, 0);
            const totalFaturado = faturamentoServicos + faturamentoProdutos;

            const totalAtendimentos = bookingRows.length;
            const totalPedidos = orderRows.length;
            const ticketMedioServicos = totalAtendimentos ? faturamentoServicos / totalAtendimentos : 0;
            const ticketMedioProdutos = totalPedidos ? faturamentoProdutos / totalPedidos : 0;

            const porServico = {};
            const porDia = {};
            bookingRows.forEach((b) => {
              porServico[b.service] = (porServico[b.service] || 0) + b.service_price;
              porDia[b.date] = (porDia[b.date] || 0) + b.service_price;
            });

            const porProduto = {};
            orderRows.forEach((o) => {
              const dia = o.created_at.slice(0, 10);
              porDia[dia] = (porDia[dia] || 0) + o.total;
              (itemsByOrder[o.id] || []).forEach((i) => {
                porProduto[i.product_name] = (porProduto[i.product_name] || 0) + i.unit_price * i.quantity;
              });
            });

            db.get(
              `SELECT
                 (SELECT COUNT(*) FROM bookings WHERE status = 'pendente') AS pendBookings,
                 (SELECT COUNT(*) FROM orders WHERE status = 'pendente') AS pendOrders`,
              [],
              (err2, pendRow) => {
                res.json({
                  totalFaturado,
                  faturamentoServicos,
                  faturamentoProdutos,
                  totalAtendimentos,
                  totalPedidos,
                  ticketMedioServicos,
                  ticketMedioProdutos,
                  porServico,
                  porProduto,
                  porDia,
                  pendentesAguardandoAceite: pendRow ? pendRow.pendBookings + pendRow.pendOrders : 0,
                });
              }
            );
          };

          if (orderIds.length === 0) return withItems([]);
          db.all(
            `SELECT * FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')})`,
            orderIds,
            (errI, items) => withItems(errI ? [] : items)
          );
        }
      );
    }
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
