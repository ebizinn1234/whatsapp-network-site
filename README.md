# 🚀 WhatsApp Network Manager

Site para gerenciar grupos do WhatsApp e enviar mensagens em massa.

## 📋 Como Usar

### 1. Instalar Dependências
```bash
cd ~/Desktop/WhatsApp-Network-Site
npm install
```

### 2. Iniciar o Site
```bash
npm start
```

### 3. Acessar o Site
Abra seu navegador e vá para: http://localhost:3000

## 🔧 Funcionalidades

- ✅ Conectar ao WhatsApp via QR Code
- ✅ Listar todos os seus grupos
- ✅ Selecionar grupos para envio
- ✅ Configurar mensagem personalizada
- ✅ Definir delay entre envios
- ✅ Envio em massa com progresso
- ✅ Botão de desconectar

## 📁 Arquivos Importantes

- `server-working.js` - Servidor principal (FUNCIONANDO)
- `public/index.html` - Interface do site
- `package.json` - Dependências do projeto

## 🚨 Problemas Conhecidos

- O site usa dados mockados (simulados) para os grupos
- Para grupos reais, seria necessário implementar melhor integração com Baileys

## 🔄 Como Reconectar

1. Clique em "Desconectar" se estiver conectado
2. Clique em "Conectar WhatsApp"
3. Escaneie o novo QR Code
4. Aguarde a conexão

## 📞 Suporte

Se precisar de ajuda, verifique:
- Se o Node.js está instalado
- Se as dependências foram instaladas
- Se a porta 3000 está livre

---
**Criado por:** Eber Lima
**Data:** $(date)

