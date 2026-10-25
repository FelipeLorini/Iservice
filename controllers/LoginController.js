const Usuario = require('../Models/usuarioModel');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
  try {

    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({ mensagem: 'Email e senha sao obrigatorios' });
    }

    const usuario = await Usuario.findOne({ email });

    if (!usuario) {
      return res.status(401).json({ mensagem: 'Email ou senha invalidos' });
    }

    const senhaValida = await usuario.compararSenha(senha);

    if (!senhaValida) {
      return res.status(401).json({ mensagem: 'Email ou senha invalidos' });
    }

    usuario.ultimo_login = new Date();
    await usuario.save();

    const token = jwt.sign(
      { id: usuario._id, email: usuario.email, tipo: usuario.tipo },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

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
    console.error('Falha interna na operacao de login');
    res.status(500).json({ mensagem: 'Erro interno do servidor' });
  }
};
