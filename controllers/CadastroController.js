const Usuario = require('../Models/usuarioModel');

exports.cadastrar = async (req, res) => {
  try {
    const { nome, email, senha, tipo, telefone } = req.body;

    const usuarioExiste = await Usuario.findOne({ email });
    if (usuarioExiste) {
      return res.status(400).json({ mensagem: 'Email ja cadastrado' });
    }

    const usuario = await Usuario.create({
      nome,
      email,
      senha,
      tipo,
      telefone
    });

    res.status(201).json({
      mensagem: 'Usuario cadastrado com sucesso',
      usuario: {
        id: usuario._id,
        nome: usuario.nome,
        email: usuario.email,
        tipo: usuario.tipo
      }
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao cadastrar usuario', erro: error.message });
  }
};