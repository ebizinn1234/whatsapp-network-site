#!/bin/bash

echo "🔄 Reiniciando servidor WhatsApp Network..."

# Parar o processo PM2
echo "⏹️ Parando processo PM2..."
pm2 stop whatsapp-network

# Aguardar um pouco
sleep 2

# Iniciar o processo PM2 novamente
echo "▶️ Iniciando processo PM2..."
pm2 start whatsapp-network

# Mostrar status
echo "📊 Status do processo:"
pm2 status

# Mostrar logs
echo "📋 Últimas 10 linhas dos logs:"
pm2 logs whatsapp-network --lines 10

echo "✅ Servidor reiniciado com sucesso!"
