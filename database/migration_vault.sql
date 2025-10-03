-- Migração para sistema de cofre de sessões WhatsApp
-- Execute este script para atualizar o banco de dados

USE whatsapp_network;

-- Verificar e adicionar colunas necessárias para o sistema de cofre
-- (apenas se não existirem)

-- Verificar se session_id existe
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists 
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = 'whatsapp_network' 
  AND TABLE_NAME = 'whatsapp_sessions' 
  AND COLUMN_NAME = 'session_id';

-- Adicionar session_id se não existir
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE whatsapp_sessions ADD COLUMN session_id VARCHAR(255) AFTER user_id', 
    'SELECT "session_id já existe" as status');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar se account_name existe
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists 
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = 'whatsapp_network' 
  AND TABLE_NAME = 'whatsapp_sessions' 
  AND COLUMN_NAME = 'account_name';

-- Adicionar account_name se não existir
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE whatsapp_sessions ADD COLUMN account_name VARCHAR(255) AFTER session_id', 
    'SELECT "account_name já existe" as status');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar se account_number existe
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists 
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = 'whatsapp_network' 
  AND TABLE_NAME = 'whatsapp_sessions' 
  AND COLUMN_NAME = 'account_number';

-- Adicionar account_number se não existir
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE whatsapp_sessions ADD COLUMN account_number VARCHAR(255) AFTER account_name', 
    'SELECT "account_number já existe" as status');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verificar se profile_picture existe
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists 
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = 'whatsapp_network' 
  AND TABLE_NAME = 'whatsapp_sessions' 
  AND COLUMN_NAME = 'profile_picture';

-- Adicionar profile_picture se não existir
SET @sql = IF(@col_exists = 0, 
    'ALTER TABLE whatsapp_sessions ADD COLUMN profile_picture TEXT AFTER account_number', 
    'SELECT "profile_picture já existe" as status');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Criar índices para performance
CREATE INDEX idx_sessions_session_id ON whatsapp_sessions(session_id);
CREATE INDEX idx_sessions_account_number ON whatsapp_sessions(account_number);

-- Migrar dados existentes (se houver)
-- Se já existem sessões com dados em JSON, extrair para as novas colunas
UPDATE whatsapp_sessions 
SET session_id = CONCAT('user_', user_id, '_', UNIX_TIMESTAMP(created_at) * 1000)
WHERE session_id IS NULL;

-- Atualizar account_name e account_number se existirem dados em whatsapp_info
UPDATE whatsapp_sessions 
SET account_name = JSON_UNQUOTE(JSON_EXTRACT(whatsapp_info, '$.name')),
    account_number = JSON_UNQUOTE(JSON_EXTRACT(whatsapp_info, '$.number')),
    profile_picture = JSON_UNQUOTE(JSON_EXTRACT(whatsapp_info, '$.profilePicture'))
WHERE whatsapp_info IS NOT NULL 
  AND JSON_VALID(whatsapp_info)
  AND JSON_EXTRACT(whatsapp_info, '$.name') IS NOT NULL;

-- Verificar se a migração foi bem-sucedida
SELECT 
    COUNT(*) as total_sessions,
    COUNT(session_id) as sessions_with_id,
    COUNT(account_name) as sessions_with_name,
    COUNT(account_number) as sessions_with_number
FROM whatsapp_sessions;

-- Mostrar estrutura final da tabela
DESCRIBE whatsapp_sessions;
