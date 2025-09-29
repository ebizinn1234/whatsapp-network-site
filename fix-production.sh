#!/bin/bash

echo "🚀 Aplicando correções no servidor de produção..."

# Comandos para executar no servidor
echo "Execute estes comandos no servidor:"
echo ""
echo "1. Conecte ao servidor:"
echo "ssh root@72.60.157.115"
echo ""
echo "2. Execute estes comandos:"
echo "cd /opt/whatsapp-network"
echo "git pull origin main"
echo "pm2 restart whatsapp-network"
echo "pm2 status"
echo ""
echo "3. Se não funcionar, execute também:"
echo "pm2 stop whatsapp-network"
echo "pm2 delete whatsapp-network"
echo "pm2 start server-multi-user.js --name whatsapp-network"
echo "pm2 status"
echo ""
echo "4. Teste o site:"
echo "https://disparozap.site"
