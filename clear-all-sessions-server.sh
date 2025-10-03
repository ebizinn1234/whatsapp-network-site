#!/bin/bash

# Script para limpar TODAS as sessões do servidor
echo "🧹 LIMPANDO TODAS AS SESSÕES DO SERVIDOR..."

# Parar o servidor
echo "⏹️ Parando servidor..."
pm2 stop whatsapp-network

# Limpar sessões na memória (reiniciar PM2)
echo "🔄 Reiniciando PM2..."
pm2 kill
pm2 start ecosystem.config.js

# Limpar arquivos de sessão
echo "🗑️ Removendo arquivos de sessão..."
rm -rf auth_info_*
rm -rf session_vault/*
rm -rf session_backups/*

# Limpar banco de dados
echo "🗄️ Limpando banco de dados..."
mysql -u root -p -e "
USE whatsapp_network;
UPDATE whatsapp_sessions SET is_active = 0;
DELETE FROM whatsapp_sessions WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY);
"

# Limpar logs antigos
echo "📋 Limpando logs antigos..."
pm2 flush

# Reiniciar servidor
echo "🚀 Reiniciando servidor..."
pm2 start whatsapp-network

echo "✅ LIMPEZA COMPLETA!"
echo "📱 Todas as sessões foram removidas"
echo "🔄 Usuários precisarão escanear QR Code novamente"
echo "🏦 Cofre de sessões foi limpo"
echo "🗄️ Banco de dados foi limpo"
