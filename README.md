# Iservice
# IService - Plataforma de Serviços Domésticos

## Sobre o Projeto

O IService é uma plataforma web que conecta clientes a prestadores de serviços domésticos. O sistema permite que clientes encontrem profissionais, contratem serviços e se comuniquem através de um chat integrado. Prestadores podem cadastrar seus serviços, gerenciar agendamentos e manter um perfil profissional.

Este projeto foi desenvolvido como Trabalho de Conclusão de Curso (TCC) e tem como objetivo oferecer uma solução completa e moderna para o mercado de serviços domésticos.

## Tecnologias Utilizadas

### Back-end
- Node.js
- Express
- MongoDB
- Mongoose
- JWT (JSON Web Token) para autenticação
- Bcryptjs para criptografia de senhas

### Front-end
- HTML5
- CSS3
- JavaScript (Vanilla)
- Font Awesome para ícones

## Funcionalidades

- Cadastro de usuários (cliente e prestador)
- Login com autenticação JWT
- Dashboard do cliente
- Dashboard do prestador com estatísticas
- Cadastro de serviços pelo prestador
- Busca e filtro de profissionais
- Agendamento de serviços
- Sistema de chat entre cliente e prestador
- Perfil do prestador com disponibilidade
- Design responsivo

## Estrutura do Projeto

site-iservice-main/
├── config/
│ └── database.js
├── controllers/
│ ├── CadastroController.js
│ ├── LoginController.js
│ ├── ServicoController.js
│ ├── AgendamentoController.js
│ └── chatController.js
├── Models/
│ ├── usuarioModel.js
│ ├── servicoModel.js
│ ├── agendamentoModel.js
│ └── chatModel.js
├── routes/
│ ├── userRoutes.js
│ └── chatRoutes.js
├── middleware/
│ └── auth.js
├── site-iservice-main/
│ ├── index.html
│ ├── login.html
│ ├── cadastro.html
│ ├── dashboard-prestador.html
│ ├── dashboard-cliente.html
│ ├── profissionais.html
│ ├── chat.html
│ ├── perfil_prestador.html
│ ├── style.css
│ └── ...
├── server.js
├── package.json
└── .env


## Instalação

### Pré-requisitos

- Node.js (v14 ou superior)
- MongoDB (local ou Atlas)

### Passos para instalação

1. Clone o repositório
```bash
git clone https://github.com/seu-usuario/iservice.git
cd iservice

npm install

## Configure as variáveis de ambiente
Crie um arquivo .env na raiz do projeto com:
PORT=3000
MONGO_URI=mongodb://localhost:27017/iservice
JWT_SECRET=seu_token_secreto

## Inicie o servidor com:
npm start

## Acesse o sistema com:
http://localhost:3000

Rotas da API
Usuários
Método	Rota	Descrição
POST	/api/cadastro	Cadastrar usuário
POST	/api/login	Fazer login
Serviços
Método	Rota	Descrição
GET	/api/servicos	Listar todos os serviços
GET	/api/servicos/categoria/:categoria	Filtrar por categoria
POST	/api/servicos	Cadastrar serviço (prestador)
GET	/api/servicos/prestador	Listar serviços do prestador
DELETE	/api/servicos/:id	Deletar serviço
Agendamentos
Método	Rota	Descrição
POST	/api/agendamentos	Agendar serviço (cliente)
GET	/api/agendamentos/cliente	Listar agendamentos do cliente
GET	/api/agendamentos/prestador	Listar agendamentos do prestador
PUT	/api/agendamentos/:id/status	Atualizar status
PUT	/api/agendamentos/:id/cancelar	Cancelar agendamento
Chat
Método	Rota	Descrição
POST	/api/chat/start	Iniciar chat
POST	/api/chat/message	Enviar mensagem
GET	/api/chat/:chatId	Ver mensagens do chat
GET	/api/chat	Listar chats do usuário
PUT	/api/chat/:chatId/read	Marcar mensagens como lidas
GET	/api/chat/unread/count	Contar mensagens não lidas
Segurança
Senhas criptografadas com bcrypt

Autenticação via JWT

Middleware de verificação de token em rotas protegidas

Validação de permissões por tipo de usuário

Contribuição
Este projeto foi desenvolvido para fins acadêmicos. Sugestões e melhorias são bem-vindas.

Licença
Este projeto está sob a licença MIT.

Contato
Felipe Lorini - Felipelorini@icloud.com

Link do projeto: https://github.com/seu-usuario/iservice

