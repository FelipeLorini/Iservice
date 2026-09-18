const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const Faq = require('../Models/faqModel');

const faqs = [
  { pergunta: 'Como funciona o IService?', resposta: 'Clientes buscam prestadores de serviços domésticos por categoria, agendam diretamente ou publicam um pedido para receber propostas.', categoria: 'geral', ordem: 1 },
  { pergunta: 'Como criar uma conta?', resposta: 'Clique em Cadastrar, escolha se você é cliente ou prestador e preencha seus dados.', categoria: 'conta', ordem: 1 },
  { pergunta: 'Como funciona o sistema de propostas?', resposta: 'Publique um pedido descrevendo o que precisa. Prestadores da categoria enviam propostas com valor e prazo, e você escolhe a melhor.', categoria: 'pedidos', ordem: 1 },
  { pergunta: 'Como avaliar um prestador?', resposta: 'Após o serviço ser finalizado, você pode avaliar o prestador com nota de 1 a 5 estrelas e um comentário.', categoria: 'avaliacoes', ordem: 1 },
  { pergunta: 'Como favoritar um prestador?', resposta: 'Clique no ícone de coração no card do prestador para adicioná-lo aos seus favoritos.', categoria: 'favoritos', ordem: 1 },
  { pergunta: 'Como funcionam as notificações?', resposta: 'O sino no topo da página mostra novidades como propostas recebidas, agendamentos e avaliações.', categoria: 'geral', ordem: 2 }
];

(async () => {
  await connectDB();
  await Faq.deleteMany({});
  await Faq.insertMany(faqs);
  console.log('FAQ populado com sucesso');
  process.exit(0);
})();