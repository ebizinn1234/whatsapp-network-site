#!/bin/bash

echo "🚀 Iniciando deploy rápido..."

# Conectar ao servidor e executar comandos
ssh root@72.60.157.115 << 'EOF'
cd /opt/whatsapp-network
echo "📥 Fazendo pull das mudanças..."
git pull origin main
echo "🔄 Reiniciando servidor..."
pm2 restart whatsapp-network
echo "✅ Deploy concluído!"
pm2 status
EOF

echo "🎉 Deploy finalizado!"
