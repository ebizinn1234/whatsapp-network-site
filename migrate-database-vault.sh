#!/bin/bash

# Script para migrar banco de dados para sistema de cofre
echo "🏦 Iniciando migração do banco de dados para sistema de cofre..."

# Verificar se MySQL está rodando
if ! pgrep -x "mysqld" > /dev/null; then
    echo "❌ MySQL não está rodando. Iniciando MySQL..."
    sudo systemctl start mysql
    sleep 3
fi

# Executar migração
echo "📊 Executando migração do banco de dados..."
mysql -u root -p < database/migration_vault.sql

if [ $? -eq 0 ]; then
    echo "✅ Migração concluída com sucesso!"
    echo "🏦 Sistema de cofre está pronto para uso!"
    
    # Mostrar status do banco
    echo ""
    echo "📊 Status das sessões no banco:"
    mysql -u root -p -e "USE whatsapp_network; SELECT COUNT(*) as total_sessions, COUNT(session_id) as with_session_id, COUNT(account_name) as with_account_name FROM whatsapp_sessions;"
    
else
    echo "❌ Erro na migração do banco de dados!"
    exit 1
fi

echo ""
echo "🚀 Próximos passos:"
echo "1. Reinicie o servidor: pm2 restart whatsapp-network"
echo "2. O sistema de cofre estará ativo automaticamente"
echo "3. Sessões serão salvas e recuperadas automaticamente"
