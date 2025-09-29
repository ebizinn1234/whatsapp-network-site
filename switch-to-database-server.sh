#!/bin/bash

echo "🔄 Trocando para servidor com banco de dados..."

# Parar o servidor atual
pm2 stop whatsapp-network

# Fazer pull das mudanças
git pull origin main

# Instalar dependências se necessário
npm install

# Parar e remover o processo atual
pm2 delete whatsapp-network

# Iniciar o servidor com banco de dados
pm2 start server-with-database.js --name whatsapp-network

# Salvar configuração do PM2
pm2 save

# Verificar status
pm2 status

echo "✅ Servidor com banco de dados iniciado!"
echo "🔍 Verifique se as rotas /api/auth/register e /api/auth/login estão funcionando"
