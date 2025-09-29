#!/bin/bash

echo "🚀 Iniciando WhatsApp Network Manager Multi-Usuário..."
echo ""

# Verificar se as dependências estão instaladas
if [ ! -d "node_modules" ]; then
    echo "📦 Dependências não encontradas. Instalando..."
    ./instalar.sh
fi

echo "🌐 Iniciando servidor multi-usuário..."
echo "📱 Cada usuário terá sua própria sessão WhatsApp!"
echo "🌍 Acesse: http://localhost:3000"
echo ""

# Iniciar o servidor multi-usuário
node server-multi-user.js

