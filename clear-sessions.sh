#!/bin/bash

echo "🗑️ Limpando todas as sessões WhatsApp ativas..."

# Conectar ao servidor e limpar sessões
ssh root@72.60.157.115 << 'EOF'
echo "🔄 Parando aplicação..."
pm2 stop whatsapp-network

echo "🗑️ Removendo todas as pastas de autenticação..."
cd /opt/whatsapp-network
rm -rf auth_info_*

echo "🧹 Limpando logs..."
pm2 flush whatsapp-network

echo "🚀 Reiniciando aplicação..."
pm2 start whatsapp-network

echo "✅ Todas as sessões foram limpas!"
pm2 status
EOF

echo "🎉 Sessões limpas com sucesso!"
echo "🌐 Acesse: https://disparozap.site"
