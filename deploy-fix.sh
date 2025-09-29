#!/bin/bash

echo "🚀 Fazendo deploy das correções de conexão..."

# Conectar ao servidor e fazer deploy
ssh root@72.60.157.115 << 'EOF'
echo "📥 Baixando atualizações..."
cd /opt/whatsapp-network
git pull origin main

echo "📦 Instalando dependências..."
npm install

echo "🔄 Reiniciando aplicação..."
pm2 restart whatsapp-network

echo "✅ Deploy concluído!"
pm2 status
EOF

echo "🎉 Deploy finalizado! Acesse: https://disparozap.site"
