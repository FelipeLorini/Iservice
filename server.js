const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const dotenv = require('dotenv');
const connectDB = require('./config/database');
const { createApp, configureApp } = require('./src/app');

dotenv.config();

const app = createApp();

connectDB();

configureApp(app);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});