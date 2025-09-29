#!/bin/bash

echo "🗑️ Limpando todas as sessões WhatsApp..."

# Parar o PM2
pm2 stop whatsapp-network

# Remover todas as pastas de sessão
rm -rf /opt/whatsapp-network/auth_info_*

# Limpar logs do PM2
pm2 flush

# Reiniciar o PM2
pm2 start whatsapp-network

echo "✅ Todas as sessões foram limpas!"
echo "🔄 Reinicie o PM2 se necessário: pm2 restart whatsapp-network"

