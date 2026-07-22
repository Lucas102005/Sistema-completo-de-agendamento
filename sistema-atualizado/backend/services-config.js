/**
 * Configuração central dos serviços oferecidos.
 * - price: usado para o financeiro (o preço NUNCA vem do frontend, sempre daqui,
 *   pra ninguém conseguir manipular o valor no navegador e "pagar menos").
 * - stockProduct: nome do produto (tabela products) que é baixado do estoque
 *   quando o agendamento desse serviço é CONFIRMADO. Deixe null se o serviço
 *   não consome nenhum produto controlado em estoque.
 */
const SERVICES = {
  "Corte Masculino": { price: 30, stockProduct: null },
  "Barba": { price: 20, stockProduct: "Creme de Barba" },
  "Corte + Barba": { price: 45, stockProduct: "Creme de Barba" },
};

function getServiceConfig(serviceName) {
  return SERVICES[serviceName] || null;
}

module.exports = { SERVICES, getServiceConfig };