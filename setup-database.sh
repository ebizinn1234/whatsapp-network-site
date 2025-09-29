#!/bin/bash

echo "🚀 Configurando banco de dados para DisparoZap..."

# Verificar se MySQL está instalado
if ! command -v mysql &> /dev/null; then
    echo "📦 Instalando MySQL..."
    sudo apt update
    sudo apt install -y mysql-server
fi

# Verificar se MySQL está rodando
if ! sudo systemctl is-active --quiet mysql; then
    echo "🔄 Iniciando MySQL..."
    sudo systemctl start mysql
    sudo systemctl enable mysql
fi

# Configurar MySQL
echo "🔧 Configurando MySQL..."
sudo mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'whatsapp123';"
sudo mysql -e "FLUSH PRIVILEGES;"

# Criar banco de dados
echo "📊 Criando banco de dados..."
mysql -u root -pwhatsapp123 < database/schema.sql

# Instalar phpMyAdmin
echo "🌐 Instalando phpMyAdmin..."
sudo apt install -y phpmyadmin

# Configurar phpMyAdmin
echo "⚙️ Configurando phpMyAdmin..."
sudo ln -s /usr/share/phpmyadmin /var/www/html/phpmyadmin

# Configurar Nginx para phpMyAdmin
sudo tee /etc/nginx/sites-available/phpmyadmin << 'EOF'
server {
    listen 80;
    server_name phpmyadmin.disparozap.site;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/phpmyadmin /etc/nginx/sites-enabled/
sudo systemctl reload nginx

echo "✅ Banco de dados configurado com sucesso!"
echo "📊 Acesse phpMyAdmin em: http://phpmyadmin.disparozap.site"
echo "🔑 Usuário: root | Senha: whatsapp123"
echo "📋 Banco: whatsapp_network"
