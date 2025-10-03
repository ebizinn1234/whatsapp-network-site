#!/bin/bash

# Script para corrigir problema de sessões corrompidas
echo "🔧 CORRIGINDO PROBLEMA DE SESSÕES..."

# 1. Parar servidor
echo "⏹️ Parando servidor..."
pm2 stop whatsapp-network

# 2. Limpar arquivos de sessão corrompidos
echo "🗑️ Removendo arquivos de sessão corrompidos..."
rm -rf auth_info_*
rm -rf session_vault/*
rm -rf session_backups/*

# 3. Limpar banco de dados
echo "🗄️ Limpando banco de dados..."
mysql -u root -p -e "
USE whatsapp_network;
DELETE FROM whatsapp_sessions;
"

# 4. Limpar logs
echo "📋 Limpando logs..."
pm2 flush

# 5. Reiniciar servidor
echo "🚀 Reiniciando servidor..."
pm2 start whatsapp-network

echo "✅ PROBLEMA CORRIGIDO!"
echo "📱 Todos os usuários precisarão escanear QR Code novamente"
echo "🏦 Cofre foi limpo completamente"
echo "🗄️ Banco foi resetado"
