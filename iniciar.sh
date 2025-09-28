#!/bin/bash

echo "🚀 Iniciando WhatsApp Network Manager..."
echo ""

# Verificar se as dependências estão instaladas
if [ ! -d "node_modules" ]; then
    echo "📦 Dependências não encontradas. Instalando..."
    ./instalar.sh
fi

echo "🌐 Iniciando servidor..."
echo "📱 Acesse: http://localhost:3000"
echo ""

# Iniciar o servidor
node server-working.js

