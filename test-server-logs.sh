#!/bin/bash

echo "🔍 Verificando logs do servidor..."

# Conectar via SSH e verificar logs
ssh root@72.60.157.115 << 'EOF'
echo "📊 Status do PM2:"
pm2 status

echo ""
echo "📋 Últimas 20 linhas do log de saída:"
pm2 logs whatsapp-network --lines 20

echo ""
echo "📋 Últimas 10 linhas do log de erro:"
pm2 logs whatsapp-network --lines 10 | grep -A 10 -B 10 "error\|Error\|ERROR"

echo ""
echo "🔍 Verificando se o servidor está processando connect-whatsapp:"
pm2 logs whatsapp-network --lines 50 | grep -i "connect-whatsapp\|qr-code\|DEBUG"
EOF
