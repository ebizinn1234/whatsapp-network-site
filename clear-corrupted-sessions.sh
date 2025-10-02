#!/bin/bash

echo "🧹 LIMPANDO SESSÕES CORROMPIDAS DO WHATSAPP..."

# Parar o servidor
echo "⏹️ Parando servidor..."
pm2 stop whatsapp-network

# Limpar arquivos de autenticação corrompidos
echo "🗑️ Removendo arquivos de autenticação corrompidos..."
rm -rf ./auth_info_*
rm -rf ./auth_info

# Limpar sessões do banco de dados
echo "🗑️ Limpando sessões do banco de dados..."
mysql -u root -p -e "
USE whatsapp_network;
DELETE FROM whatsapp_sessions WHERE is_active = 1;
UPDATE whatsapp_sessions SET is_active = 0;
"

# Limpar sessões da memória (se necessário)
echo "🧹 Limpeza concluída!"

# Reiniciar servidor
echo "🔄 Reiniciando servidor..."
pm2 start whatsapp-network

echo "✅ Processo concluído! Agora você pode conectar novamente."
echo "📱 Escaneie o QR code quando aparecer."
