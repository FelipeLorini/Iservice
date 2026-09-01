const Usuario = require('../Models/usuarioModel');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
  try {
    console.log('1 - Recebida requisicao de login');
    console.log('2 - Body recebido:', req.body);

    const { email, senha } = req.body;

    if (!email || !senha) {
      console.log('3 - Email ou senha nao fornecidos');
      return res.status(400).json({ mensagem: 'Email e senha sao obrigatorios' });
    }

    console.log('4 - Buscando usuario no banco...');
    const usuario = await Usuario.findOne({ email });
    console.log('5 - Usuario encontrado:', usuario ? 'Sim' : 'Nao');

    if (!usuario) {
      console.log('6 - Usuario nao encontrado');
      return res.status(401).json({ mensagem: 'Email ou senha invalidos' });
    }

    console.log('7 - Comparando senha...');
    const senhaValida = await usuario.compararSenha(senha);
    console.log('8 - Senha valida:', senhaValida ? 'Sim' : 'Nao');

    if (!senhaValida) {
      console.log('9 - Senha incorreta');
      return res.status(401).json({ mensagem: 'Email ou senha invalidos' });
    }

    console.log('10 - Gerando token...');
    const token = jwt.sign(
      { id: usuario._id, email: usuario.email, tipo: usuario.tipo },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('11 - Login realizado com sucesso');
    res.json({
      mensagem: 'Login realizado com sucesso',
      token,
      usuario: {
        id: usuario._id,
        nome: usuario.nome,
        email: usuario.email,
        tipo: usuario.tipo
      }
    });

  } catch (error) {
    console.log('12 - ERRO CAPTURADO:', error.message);
    console.log('13 - Stack:', error.stack);
    res.status(500).json({ mensagem: 'Erro interno do servidor', erro: error.message });
  }
};
