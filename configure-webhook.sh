#!/bin/bash

echo "🚀 Configurando Webhook no Servidor..."

# Atualizar sistema
echo "📦 Atualizando sistema..."
apt update

# Instalar webhook
echo "🔧 Instalando webhook..."
apt install -y webhook

# Criar diretório para hooks
echo "📁 Criando diretório para hooks..."
mkdir -p /opt/webhooks

# Criar configuração do webhook
echo "⚙️ Configurando webhook..."
cat > /etc/webhook.conf << 'EOF'
[
  {
    "id": "whatsapp-deploy",
    "execute-command": "/opt/deploy.sh",
    "command-working-directory": "/opt/whatsapp-network",
    "response-message": "Deploy iniciado!",
    "trigger-rule": {
      "match": {
        "type": "value",
        "value": "refs/heads/main",
        "parameter": {
          "source": "payload",
          "name": "ref"
        }
      }
    }
  }
]
EOF

# Criar script de deploy
echo "📝 Criando script de deploy..."
cat > /opt/deploy.sh << 'EOF'
#!/bin/bash
echo "🚀 Iniciando deploy..."
cd /opt/whatsapp-network
git pull origin main
npm install
pm2 restart whatsapp-network
echo "✅ Deploy concluído!"
EOF

# Dar permissão de execução
chmod +x /opt/deploy.sh

# Criar serviço systemd para webhook
echo "🔧 Configurando serviço webhook..."
cat > /etc/systemd/system/webhook.service << 'EOF'
[Unit]
Description=Webhook Service
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/webhook -hooks /etc/webhook.conf -port 9000 -verbose
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Recarregar systemd
systemctl daemon-reload

# Iniciar e habilitar webhook
echo "🚀 Iniciando webhook..."
systemctl start webhook
systemctl enable webhook

# Verificar status
echo "📊 Verificando status..."
systemctl status webhook

# Testar webhook
echo "🧪 Testando webhook..."
curl -X POST http://localhost:9000/hooks/whatsapp-deploy

echo "✅ Webhook configurado com sucesso!"
echo "🌐 URL do webhook: http://72.60.157.115:9000/hooks/whatsapp-deploy"
echo "📝 Configure no GitHub: http://72.60.157.115:9000/hooks/whatsapp-deploy"
