-- Migração: Adicionar tabela de mensagens salvas
-- Data: 2025-10-01
-- Descrição: Permite usuários salvarem mensagens com templates e variáveis

USE whatsapp_network;

-- Criar tabela de mensagens salvas
CREATE TABLE IF NOT EXISTS user_messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    message_title VARCHAR(100) NOT NULL COMMENT 'Título da mensagem (ex: "Promoção Black Friday")',
    message_text TEXT NOT NULL COMMENT 'Texto da mensagem com variáveis {nome}, {hora}, {data}',
    use_variables BOOLEAN DEFAULT TRUE COMMENT 'Se deve processar variáveis na mensagem',
    is_favorite BOOLEAN DEFAULT FALSE COMMENT 'Marcar como favorita',
    use_count INT DEFAULT 0 COMMENT 'Quantas vezes foi usada',
    last_used TIMESTAMP NULL COMMENT 'Última vez que foi usada',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Criar índices para performance
CREATE INDEX idx_user_messages_user ON user_messages(user_id);
CREATE INDEX idx_user_messages_favorite ON user_messages(is_favorite);
CREATE INDEX idx_user_messages_last_used ON user_messages(last_used);

-- Inserir mensagens de exemplo para todos os usuários
INSERT INTO user_messages (user_id, message_title, message_text, is_favorite)
SELECT 
    id,
    'Exemplo: Promoção',
    'Olá {nome}! 😊\n\nTemos uma promoção especial hoje ({data} às {hora})!\n\nConfira: https://seusite.com/promo',
    TRUE
FROM users
WHERE NOT EXISTS (
    SELECT 1 FROM user_messages WHERE user_messages.user_id = users.id
);

-- Verificar sucesso
SELECT 'Migração concluída! Tabela user_messages criada com sucesso.' AS status;
SELECT COUNT(*) AS total_mensagens FROM user_messages;

