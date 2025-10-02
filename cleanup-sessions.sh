#!/bin/bash

echo "🧹 LIMPEZA AUTOMÁTICA DE SESSÕES CORROMPIDAS"
echo "=============================================="

# Parar o servidor
echo "⏹️ Parando servidor..."
pm2 stop whatsapp-network

# Limpar arquivos de autenticação
echo "🗑️ Removendo arquivos de autenticação..."
rm -rf ./auth_info_*
rm -rf ./auth_info
rm -rf ./auth_info_backup_*

# Limpar sessões do banco
echo "🗑️ Limpando sessões do banco de dados..."
mysql -u root -p -e "
USE whatsapp_network;
DELETE FROM whatsapp_sessions WHERE is_active = 1;
UPDATE whatsapp_sessions SET is_active = 0;
"

# Limpar logs antigos
echo "🗑️ Limpando logs antigos..."
pm2 flush whatsapp-network

# Reiniciar servidor
echo "🔄 Reiniciando servidor..."
pm2 start whatsapp-network

echo "✅ Limpeza concluída!"
echo "📱 Agora você pode conectar novamente com QR code limpo"
