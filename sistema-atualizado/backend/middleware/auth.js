const jwt = require('jsonwebtoken');

// Em produção, defina ADMIN_JWT_SECRET nas variáveis de ambiente do Render/host.
// Isso aqui é só um fallback pra rodar local sem configurar nada.
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'troque-este-segredo-em-producao';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload; // { id, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
}

module.exports = { requireAuth, JWT_SECRET };
