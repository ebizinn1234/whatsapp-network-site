#!/bin/bash

echo "🚀 WhatsApp Network Manager - Deploy Script"
echo "=========================================="

# Verificar se está no diretório correto
if [ ! -f "server-multi-user.js" ]; then
    echo "❌ Erro: Execute este script na pasta do projeto"
    exit 1
fi

echo "📋 Preparando projeto para deploy..."

# Verificar se git está inicializado
if [ ! -d ".git" ]; then
    echo "🔧 Inicializando Git..."
    git init
    echo "node_modules/" >> .gitignore
    echo "auth_info*/" >> .gitignore
    echo "*.log" >> .gitignore
fi

echo "📦 Adicionando arquivos ao Git..."
git add .

echo "💾 Commit inicial..."
git commit -m "WhatsApp Network Manager - Deploy Ready"

echo ""
echo "🎯 Escolha sua plataforma de deploy:"
echo "1) Railway (Recomendado)"
echo "2) Render"
echo "3) Vercel"
echo "4) Apenas preparar para GitHub"
echo ""
read -p "Digite sua escolha (1-4): " choice

case $choice in
    1)
        echo "🚂 Railway - Instruções:"
        echo "1. Acesse: https://railway.app"
        echo "2. Login com GitHub"
        echo "3. New Project → Deploy from GitHub"
        echo "4. Selecione este repositório"
        echo "5. Deploy automático!"
        echo ""
        echo "🌐 Seu site ficará: https://seu-projeto.railway.app"
        ;;
    2)
        echo "🎨 Render - Instruções:"
        echo "1. Acesse: https://render.com"
        echo "2. Get Started for Free"
        echo "3. New + → Web Service"
        echo "4. Conecte este repositório"
        echo "5. Deploy!"
        echo ""
        echo "🌐 Seu site ficará: https://seu-projeto.onrender.com"
        ;;
    3)
        echo "⚡ Vercel - Instruções:"
        echo "1. Acesse: https://vercel.com"
        echo "2. Sign Up com GitHub"
        echo "3. New Project"
        echo "4. Import este repositório"
        echo "5. Deploy!"
        echo ""
        echo "🌐 Seu site ficará: https://seu-projeto.vercel.app"
        ;;
    4)
        echo "📤 Preparando para GitHub..."
        echo "Execute os comandos abaixo:"
        echo ""
        echo "git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git"
        echo "git push -u origin main"
        ;;
    *)
        echo "❌ Opção inválida"
        exit 1
        ;;
esac

echo ""
echo "✅ Projeto preparado para deploy!"
echo "📁 Arquivos de configuração criados:"
echo "   - railway.json (Railway)"
echo "   - render.yaml (Render)"
echo "   - vercel.json (Vercel)"
echo "   - DEPLOY_GUIDE.md (Guia completo)"
echo ""
echo "🎉 Boa sorte com seu deploy!"
