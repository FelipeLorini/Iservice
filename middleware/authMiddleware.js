const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ mensagem: 'Token nao fornecido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId = decoded.id;
    req.usuarioTipo = decoded.tipo;

    next();
  } catch (error) {
    return res.status(401).json({ mensagem: 'Token invalido' });
  }
};

module.exports = authMiddleware;