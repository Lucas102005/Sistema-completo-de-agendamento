/**
 * Cria (ou redefine a senha de) o usuário admin.
 * Rode UMA VEZ por instalação/cliente:
 *
 *    node seed-admin.js usuario senha123
 *
 * Cada cliente que contratar o sistema roda isso com o próprio usuário/senha,
 * assim o acesso de cada instalação fica separado dos demais.
 */
const bcrypt = require('bcryptjs');
const db = require('./database');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Uso: node seed-admin.js <usuario> <senha>');
  process.exit(1);
}

if (password.length < 6) {
  console.error('❌ Use uma senha com pelo menos 6 caracteres.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);

db.run(
  `INSERT INTO admin_users (username, password_hash) VALUES (?, ?)
   ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
  [username, hash],
  function (err) {
    if (err) {
      console.error('❌ Erro ao criar/atualizar admin:', err.message);
      process.exit(1);
    }
    console.log(`✅ Usuário admin "${username}" criado/atualizado com sucesso.`);
    process.exit(0);
  }
);