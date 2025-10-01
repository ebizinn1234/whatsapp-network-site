-- ==================== MIGRAÇÃO: Histórico de Envios ====================
-- Tabela para armazenar o histórico de envios e estado de pausa

CREATE TABLE IF NOT EXISTS sending_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    message_text TEXT NOT NULL,
    total_groups INT NOT NULL,
    current_group INT DEFAULT 0,
    status ENUM('sending', 'paused', 'completed', 'cancelled', 'error') DEFAULT 'sending',
    speed_mode VARCHAR(50) DEFAULT 'human',
    delay_config JSON,
    groups_list JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ==================== MIGRAÇÃO: Progresso de Envios ====================
-- Tabela para armazenar o progresso detalhado de cada envio

CREATE TABLE IF NOT EXISTS sending_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sending_history_id INT NOT NULL,
    group_id VARCHAR(255) NOT NULL,
    group_name VARCHAR(255) NOT NULL,
    status ENUM('pending', 'sending', 'sent', 'error', 'skipped') DEFAULT 'pending',
    error_message TEXT NULL,
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_sending_history_id (sending_history_id),
    INDEX idx_status (status),
    INDEX idx_group_id (group_id),
    
    FOREIGN KEY (sending_history_id) REFERENCES sending_history(id) ON DELETE CASCADE
);
