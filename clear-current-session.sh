#!/bin/bash

echo "🗑️ Removendo apenas a sessão atual do WhatsApp..."

# Conectar ao servidor e limpar apenas a sessão atual
ssh root@72.60.157.115 << 'EOF'
echo "🔄 Parando aplicação..."
pm2 stop whatsapp-network

echo "🗑️ Removendo apenas a pasta de autenticação atual..."
cd /opt/whatsapp-network

# Listar pastas de autenticação existentes
echo "📁 Pastas de autenticação encontradas:"
ls -la auth_info_* 2>/dev/null || echo "Nenhuma pasta encontrada"

# Remover apenas as pastas existentes
rm -rf auth_info_*

echo "🧹 Limpando logs..."
pm2 flush whatsapp-network

echo "🚀 Reiniciando aplicação..."
pm2 start whatsapp-network

echo "✅ Sessão atual removida!"
pm2 status
EOF

echo "🎉 Sessão atual removida com sucesso!"
echo "🌐 Acesse: https://disparozap.site"
echo "📱 Agora você precisará escanear o QR Code novamente!"
