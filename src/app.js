const express = require('express');
const cors = require('cors');
const path = require('path');
const userRoutes = require('../routes/userRoutes');
const chatRoutes = require('../routes/chatRoutes');

// Etapas separadas preservam a chamada de connectDB entre criacao e configuracao.
function createApp() {
  return express();
}

function configureApp(app) {
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', userRoutes);
  app.use('/api/chat', chatRoutes);

  app.use(express.static(path.join(__dirname, '..', 'site-iservice-main')));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'site-iservice-main', 'index.html'));
  });
}

module.exports = { createApp, configureApp };
