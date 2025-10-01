# 🚀 COMO APLICAR A MIGRAÇÃO user_messages

## 📋 **PASSO A PASSO COMPLETO:**

### **Método 1: Via Terminal (Recomendado)**

```bash
# 1. Conectar ao MySQL
mysql -u root -p

# 2. Selecionar o banco
USE whatsapp_network;

# 3. Executar o arquivo SQL
SOURCE /Users/eberlima/Desktop/WhatsApp-Network-Site/ADD_USER_MESSAGES_TABLE.sql;

# 4. Verificar se criou
SHOW TABLES;
SELECT * FROM user_messages;
```

---

### **Método 2: Via phpMyAdmin (Mais Fácil)**

1. Acesse: `http://localhost/phpmyadmin`
2. Clique em **"whatsapp_network"** (banco de dados)
3. Clique na aba **"SQL"** no topo
4. **Copie e cole** o conteúdo do arquivo `ADD_USER_MESSAGES_TABLE.sql`
5. Clique em **"Executar"** (botão azul no canto direito)
6. Veja a mensagem: **"✅ MIGRAÇÃO CONCLUÍDA COM SUCESSO!"**

---

### **Método 3: Via Arquivo SQL Direto**

```bash
# Executar arquivo SQL diretamente
mysql -u root -p whatsapp_network < /Users/eberlima/Desktop/WhatsApp-Network-Site/ADD_USER_MESSAGES_TABLE.sql
```

---

## ✅ **VERIFICAR SE FUNCIONOU:**

### **1. Verificar tabela criada:**
```sql
USE whatsapp_network;
SHOW TABLES;
-- Deve aparecer: user_messages
```

### **2. Ver estrutura da tabela:**
```sql
DESCRIBE user_messages;
```

**Deve mostrar:**
```
+--------------+--------------+------+-----+-------------------+-------------------+
| Field        | Type         | Null | Key | Default           | Extra             |
+--------------+--------------+------+-----+-------------------+-------------------+
| id           | int          | NO   | PRI | NULL              | auto_increment    |
| user_id      | int          | NO   | MUL | NULL              |                   |
| message_title| varchar(100) | NO   |     | NULL              |                   |
| message_text | text         | NO   |     | NULL              |                   |
| use_variables| tinyint(1)   | YES  |     | 1                 |                   |
| is_favorite  | tinyint(1)   | YES  | MUL | 0                 |                   |
| use_count    | int          | YES  |     | 0                 |                   |
| last_used    | timestamp    | YES  | MUL | NULL              |                   |
| created_at   | timestamp    | YES  |     | CURRENT_TIMESTAMP |                   |
| updated_at   | timestamp    | YES  |     | CURRENT_TIMESTAMP | on update CURRENT |
+--------------+--------------+------+-----+-------------------+-------------------+
```

### **3. Ver mensagens de exemplo criadas:**
```sql
SELECT 
    u.phone,
    um.message_title,
    um.is_favorite,
    LEFT(um.message_text, 50) AS preview
FROM user_messages um
JOIN users u ON um.user_id = u.id;
```

**Resultado esperado:**
```
+-------------+--------------------------------------+-------------+---------------------------------------------------+
| phone       | message_title                        | is_favorite | preview                                           |
+-------------+--------------------------------------+-------------+---------------------------------------------------+
| 11999999999 | Exemplo: Mensagem com Variáveis      | 1           | Olá {nome}! {random_greeting}...                  |
| 11999999999 | Exemplo: Promoção                    | 0           | {random_greeting} pessoal do {nome}!...           |
| 83999424664 | Exemplo: Mensagem com Variáveis      | 1           | Olá {nome}! {random_greeting}...                  |
| 83999424664 | Exemplo: Promoção                    | 0           | {random_greeting} pessoal do {nome}!...           |
| ...         | ...                                  | ...         | ...                                               |
+-------------+--------------------------------------+-------------+---------------------------------------------------+
```

---

## 🎯 **O QUE FOI CRIADO:**

### **Tabela `user_messages`:**
- ✅ 9 usuários existentes
- ✅ 2 mensagens de exemplo para CADA usuário
- ✅ **Total: 18 mensagens criadas automaticamente!**

### **Campos principais:**
```
id              → ID único da mensagem
user_id         → ID do usuário (FK)
message_title   → Título (ex: "Promoção Black Friday")
message_text    → Texto com variáveis {nome}, {hora}, {data}
use_variables   → Se deve processar variáveis (1=sim, 0=não)
is_favorite     → Favorita (1=sim, 0=não)
use_count       → Contador de uso (quantas vezes enviou)
last_used       → Data/hora do último uso
```

---

## 🔄 **TESTANDO AS VARIÁVEIS:**

### **Mensagem de exemplo salva:**
```
Olá {nome}! {random_greeting}

Temos uma novidade especial para você hoje ({data} às {hora})! {random_emoji}

[Adicione seu conteúdo aqui]

Confira mais em: https://seusite.com

Qualquer dúvida, só chamar!

Att,
Sua Equipe
```

### **Como será enviada (processada):**

**Para grupo "MaxScale":**
```
Olá MaxScale! Oi 👋

Temos uma novidade especial para você hoje (01/10/2025 às 14:30)! 😊

[Adicione seu conteúdo aqui]

Confira mais em: https://seusite.com

Qualquer dúvida, só chamar!

Att,
Sua Equipe
```

**Para grupo "Dev Team":**
```
Olá Dev Team! E aí 🎉

Temos uma novidade especial para você hoje (01/10/2025 às 14:32)! 🚀

[Adicione seu conteúdo aqui]

Confira mais em: https://seusite.com

Qualquer dúvida, só chamar!

Att,
Sua Equipe
```

**→ Cada grupo recebe uma mensagem DIFERENTE!** 🎯

---

## 📊 **COMANDOS ÚTEIS:**

### **Ver todas as mensagens de um usuário:**
```sql
-- Usuário ID 9 (83991578520)
SELECT 
    message_title,
    LEFT(message_text, 100) AS preview,
    use_count,
    is_favorite,
    created_at
FROM user_messages
WHERE user_id = 9
ORDER BY is_favorite DESC, created_at DESC;
```

### **Adicionar nova mensagem manualmente:**
```sql
INSERT INTO user_messages (user_id, message_title, message_text, is_favorite)
VALUES (
    9, 
    'Minha Mensagem Personalizada',
    'Olá {nome}! {random_greeting}\n\n[Seu conteúdo aqui]\n\nAtt, {random_emoji}',
    1
);
```

### **Atualizar mensagem existente:**
```sql
UPDATE user_messages
SET 
    message_text = 'Texto atualizado {nome}',
    updated_at = NOW()
WHERE id = 1;
```

### **Deletar mensagem:**
```sql
DELETE FROM user_messages WHERE id = 1;
```

### **Marcar mensagem como usada:**
```sql
UPDATE user_messages
SET 
    use_count = use_count + 1,
    last_used = NOW()
WHERE id = 1;
```

---

## ⚠️ **TROUBLESHOOTING:**

### **Erro: "Table already exists"**
```sql
-- A tabela já existe! Tudo certo! ✅
-- Para recriar do zero (CUIDADO: apaga dados):
DROP TABLE IF EXISTS user_messages;
-- Depois execute o script novamente
```

### **Erro: "Foreign key constraint fails"**
```sql
-- Verificar se a tabela users existe:
SHOW TABLES LIKE 'users';

-- Ver usuários:
SELECT id, phone FROM users;
```

### **Erro: "Cannot add or update a child row"**
```sql
-- Significa que tentou adicionar mensagem para usuário inexistente
-- Ver IDs válidos:
SELECT id FROM users;
```

---

## 🚀 **PRÓXIMO PASSO:**

Após aplicar a migração:

1. ✅ Tabela `user_messages` criada
2. ✅ 18 mensagens de exemplo criadas (2 por usuário)
3. ✅ APIs backend já prontas
4. ✅ Sistema de variáveis funcionando
5. 🔄 **Falta apenas:** Criar interface (UI) para gerenciar mensagens

---

## 📝 **RESUMO DO COMANDO:**

### **COPIE E COLE NO TERMINAL:**

```bash
mysql -u root -p whatsapp_network < /Users/eberlima/Desktop/WhatsApp-Network-Site/ADD_USER_MESSAGES_TABLE.sql
```

**OU via phpMyAdmin:**

1. Abrir phpMyAdmin
2. Selecionar banco `whatsapp_network`
3. Aba "SQL"
4. Colar conteúdo de `ADD_USER_MESSAGES_TABLE.sql`
5. Executar

**Pronto! Sistema de mensagens salvas funcionando!** ✅🚀

