const jwt = require('jsonwebtoken');

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ mensagem: 'Acesso negado. Token nao fornecido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId = decoded.id;
    req.usuarioTipo = decoded.tipo;

    next();
  } catch (error) {
    return res.status(401).json({ mensagem: 'Token invalido ou expirado' });
  }
};

const verificarPrestador = (req, res, next) => {
  if (req.usuarioTipo !== 'prestador') {
    return res.status(403).json({ mensagem: 'Acesso negado. Apenas prestadores podem realizar esta acao' });
  }
  next();
};

const verificarCliente = (req, res, next) => {
  if (req.usuarioTipo !== 'cliente') {
    return res.status(403).json({ mensagem: 'Acesso negado. Apenas clientes podem realizar esta acao' });
  }
  next();
};

module.exports = { auth, verificarPrestador, verificarCliente };