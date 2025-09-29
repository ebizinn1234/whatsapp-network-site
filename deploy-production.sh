#!/bin/bash

echo "🚀 Aplicando correções no servidor de produção..."

# Conectar ao servidor e aplicar correções
ssh root@72.60.157.115 << 'EOF'

echo "📥 Baixando atualizações..."
cd /opt/whatsapp-network
git pull origin main

echo "🔄 Reiniciando aplicação..."
pm2 restart whatsapp-network

echo "📊 Verificando status..."
pm2 status

echo "✅ Deploy concluído!"

EOF

echo "🎉 Correções aplicadas no servidor!"
