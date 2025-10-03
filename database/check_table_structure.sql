-- Verificar estrutura atual da tabela whatsapp_sessions
USE whatsapp_network;

-- Mostrar estrutura da tabela
DESCRIBE whatsapp_sessions;

-- Mostrar dados existentes
SELECT 
    id, 
    user_id, 
    session_id, 
    account_name, 
    account_number, 
    profile_picture,
    is_active,
    created_at
FROM whatsapp_sessions 
LIMIT 5;
