const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const connectDB = require('./config/database');
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');

dotenv.config();

const app = express();

connectDB();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', userRoutes);
app.use('/api/chat', chatRoutes);

app.use(express.static(path.join(__dirname, 'site-iservice-main')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'site-iservice-main', 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});