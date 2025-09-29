#!/bin/bash

echo "🔄 Forçando atualização completa do servidor..."

# 1. Parar o servidor
pm2 stop whatsapp-network

# 2. Limpar logs antigos
pm2 flush whatsapp-network

# 3. Atualizar código
git pull origin main

# 4. Verificar se as mudanças foram aplicadas
echo "📋 Verificando se as correções estão no código:"
grep -n "data || {}" server-with-database.js

# 5. Reiniciar servidor
pm2 start whatsapp-network

# 6. Verificar status
pm2 status

echo "✅ Atualização forçada concluída!"
echo "🔍 Agora teste o QR Code novamente"
