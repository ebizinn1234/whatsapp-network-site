#!/bin/bash

echo "🚀 Instalando WhatsApp Network Manager..."
echo ""

# Verificar se Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado!"
    echo "📥 Instale o Node.js em: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js encontrado: $(node --version)"

# Instalar dependências
echo "📦 Instalando dependências..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependências instaladas com sucesso!"
    echo ""
    echo "🎉 Instalação concluída!"
    echo ""
    echo "Para iniciar o site:"
    echo "  npm start"
    echo ""
    echo "Depois acesse: http://localhost:3000"
else
    echo "❌ Erro ao instalar dependências"
    exit 1
fi

