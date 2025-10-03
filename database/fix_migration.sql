-- Migração corrigida para sistema de cofre
-- Execute este comando no MySQL

USE whatsapp_network;

-- Verificar estrutura atual
DESCRIBE whatsapp_sessions;

-- Adicionar colunas apenas se não existirem
-- (MySQL não suporta IF NOT EXISTS em ALTER TABLE)

-- Verificar se account_name existe e adicionar se não existir
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS 
     WHERE TABLE_SCHEMA = 'whatsapp_network' 
       AND TABLE_NAME = 'whatsapp_sessions' 
       AND COLUMN_NAME = 'account_name') = 0,
    'ALTER TABLE whatsapp_sessions ADD COLUMN account_name VARCHAR(255)',
    'SELECT "account_name já existe" as status'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar se account_number existe e adicionar se não existir
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS 
     WHERE TABLE_SCHEMA = 'whatsapp_network' 
       AND TABLE_NAME = 'whatsapp_sessions' 
       AND COLUMN_NAME = 'account_number') = 0,
    'ALTER TABLE whatsapp_sessions ADD COLUMN account_number VARCHAR(255)',
    'SELECT "account_number já existe" as status'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar se profile_picture existe e adicionar se não existir
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS 
     WHERE TABLE_SCHEMA = 'whatsapp_network' 
       AND TABLE_NAME = 'whatsapp_sessions' 
       AND COLUMN_NAME = 'profile_picture') = 0,
    'ALTER TABLE whatsapp_sessions ADD COLUMN profile_picture TEXT',
    'SELECT "profile_picture já existe" as status'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Criar índices (ignorar erros se já existirem)
SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.STATISTICS 
     WHERE TABLE_SCHEMA = 'whatsapp_network' 
       AND TABLE_NAME = 'whatsapp_sessions' 
       AND INDEX_NAME = 'idx_sessions_session_id') = 0,
    'CREATE INDEX idx_sessions_session_id ON whatsapp_sessions(session_id)',
    'SELECT "índice session_id já existe" as status'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.STATISTICS 
     WHERE TABLE_SCHEMA = 'whatsapp_network' 
       AND TABLE_NAME = 'whatsapp_sessions' 
       AND INDEX_NAME = 'idx_sessions_account_number') = 0,
    'CREATE INDEX idx_sessions_account_number ON whatsapp_sessions(account_number)',
    'SELECT "índice account_number já existe" as status'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar resultado final
SELECT 
    COUNT(*) as total_sessions,
    COUNT(session_id) as with_session_id,
    COUNT(account_name) as with_account_name,
    COUNT(account_number) as with_account_number,
    COUNT(profile_picture) as with_profile_picture
FROM whatsapp_sessions;

-- Mostrar estrutura final
DESCRIBE whatsapp_sessions;
