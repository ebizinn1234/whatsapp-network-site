-- ============================================
-- MIGRAÇÃO: Adicionar tabela user_messages
-- Data: 01/10/2025
-- Descrição: Sistema de mensagens salvas com variáveis anti-ban
-- ============================================

USE whatsapp_network;

-- Criar tabela user_messages
CREATE TABLE IF NOT EXISTS `user_messages` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `message_title` varchar(100) NOT NULL COMMENT 'Título da mensagem (ex: "Promoção Black Friday")',
  `message_text` text NOT NULL COMMENT 'Texto da mensagem com variáveis {nome}, {hora}, {data}',
  `use_variables` tinyint(1) DEFAULT '1' COMMENT 'Se deve processar variáveis na mensagem',
  `is_favorite` tinyint(1) DEFAULT '0' COMMENT 'Marcar como favorita',
  `use_count` int DEFAULT '0' COMMENT 'Quantas vezes foi usada',
  `last_used` timestamp NULL DEFAULT NULL COMMENT 'Última vez que foi usada',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_messages_user` (`user_id`),
  KEY `idx_user_messages_favorite` (`is_favorite`),
  KEY `idx_user_messages_last_used` (`last_used`),
  CONSTRAINT `user_messages_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Inserir mensagem de exemplo para TODOS os usuários existentes
INSERT INTO `user_messages` (`user_id`, `message_title`, `message_text`, `is_favorite`)
SELECT 
    `id`,
    'Exemplo: Mensagem com Variáveis',
    'Olá {nome}! {random_greeting}\n\nTemos uma novidade especial para você hoje ({data} às {hora})! {random_emoji}\n\n[Adicione seu conteúdo aqui]\n\nConfira mais em: https://seusite.com\n\nQualquer dúvida, só chamar!\n\nAtt,\nSua Equipe',
    1
FROM `users`
WHERE NOT EXISTS (
    SELECT 1 FROM `user_messages` WHERE `user_messages`.`user_id` = `users`.`id`
);

-- Inserir segunda mensagem de exemplo (Promoção)
INSERT INTO `user_messages` (`user_id`, `message_title`, `message_text`, `is_favorite`)
SELECT 
    `id`,
    'Exemplo: Promoção',
    '{random_greeting} pessoal do {nome}! {random_emoji}\n\nPromoção ESPECIAL de hoje ({data})!\n\n✨ [Descrição da promoção]\n💰 [Condições]\n⏰ Válido até às {hora}\n\nNão perca!\n\nLink: https://seusite.com/promo\n\nAtt, Equipe',
    0
FROM `users`
WHERE NOT EXISTS (
    SELECT 1 FROM `user_messages` WHERE `user_messages`.`user_id` = `users`.`id` AND `message_title` = 'Exemplo: Promoção'
);

-- Verificar migração
SELECT 
    '✅ MIGRAÇÃO CONCLUÍDA COM SUCESSO!' AS status,
    (SELECT COUNT(*) FROM `user_messages`) AS total_mensagens_criadas,
    (SELECT COUNT(*) FROM `users`) AS total_usuarios;

-- Mostrar mensagens criadas por usuário
SELECT 
    u.phone AS usuario_telefone,
    um.message_title AS titulo_mensagem,
    um.is_favorite AS favorita,
    um.created_at AS criado_em
FROM `user_messages` um
JOIN `users` u ON um.user_id = u.id
ORDER BY u.id, um.is_favorite DESC;

