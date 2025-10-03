-- Migração simples para sistema de cofre
-- Execute este comando no MySQL

USE whatsapp_network;

-- Mostrar estrutura atual
DESCRIBE whatsapp_sessions;

-- Adicionar apenas as colunas que faltam (ignorar erros se já existirem)
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS account_number VARCHAR(255);
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS profile_picture TEXT;

-- Criar índices (ignorar erros se já existirem)
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON whatsapp_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_account_number ON whatsapp_sessions(account_number);

-- Verificar resultado
SELECT 
    COUNT(*) as total_sessions,
    COUNT(session_id) as with_session_id,
    COUNT(account_name) as with_account_name,
    COUNT(account_number) as with_account_number
FROM whatsapp_sessions;
