const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ============================================
// 🧹 SISTEMA DE LIMPEZA AUTOMÁTICA DE SESSÕES
// ============================================

class SessionCleanup {
    constructor() {
        this.db = null;
        this.cleanupInterval = 5 * 60 * 1000; // 5 minutos
        this.maxSessionAge = 24 * 60 * 60 * 1000; // 24 horas
    }

    async init() {
        try {
            // Conectar ao banco
            this.db = await mysql.createConnection({
                host: process.env.DB_HOST || 'localhost',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'whatsapp_network'
            });

            console.log('🧹 Sistema de limpeza automática iniciado');
            this.startCleanup();
        } catch (error) {
            console.error('❌ Erro ao inicializar limpeza automática:', error);
        }
    }

    startCleanup() {
        // Limpeza imediata
        this.cleanup();
        
        // Limpeza periódica
        setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);
    }

    async cleanup() {
        try {
            console.log('🧹 Iniciando limpeza automática de sessões...');
            
            // 1. Verificar sessões expiradas no banco
            await this.cleanupExpiredSessions();
            
            // 2. Verificar arquivos de autenticação órfãos
            await this.cleanupOrphanedAuthFiles();
            
            // 3. Verificar sessões corrompidas
            await this.cleanupCorruptedSessions();
            
            console.log('✅ Limpeza automática concluída');
        } catch (error) {
            console.error('❌ Erro na limpeza automática:', error);
        }
    }

    async cleanupExpiredSessions() {
        try {
            // Marcar sessões antigas como inativas
            const [result] = await this.db.execute(`
                UPDATE whatsapp_sessions 
                SET is_active = 0 
                WHERE is_active = 1 
                AND updated_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
            `);
            
            if (result.affectedRows > 0) {
                console.log(`🧹 ${result.affectedRows} sessões expiradas marcadas como inativas`);
            }
        } catch (error) {
            console.error('❌ Erro ao limpar sessões expiradas:', error);
        }
    }

    async cleanupOrphanedAuthFiles() {
        try {
            const authDirs = fs.readdirSync('./').filter(dir => 
                dir.startsWith('auth_info_') && fs.statSync(dir).isDirectory()
            );

            for (const authDir of authDirs) {
                const sessionId = authDir.replace('auth_info_', '');
                
                // Verificar se a sessão ainda existe no banco
                const [sessions] = await this.db.execute(
                    'SELECT id FROM whatsapp_sessions WHERE session_id = ? AND is_active = 1',
                    [sessionId]
                );

                if (sessions.length === 0) {
                    // Sessão não existe mais, remover arquivos
                    fs.rmSync(authDir, { recursive: true, force: true });
                    console.log(`🧹 Arquivos órfãos removidos: ${authDir}`);
                }
            }
        } catch (error) {
            console.error('❌ Erro ao limpar arquivos órfãos:', error);
        }
    }

    async cleanupCorruptedSessions() {
        try {
            // Verificar sessões com muitos erros
            const [sessions] = await this.db.execute(`
                SELECT session_id, updated_at 
                FROM whatsapp_sessions 
                WHERE is_active = 1 
                AND updated_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
            `);

            for (const session of sessions) {
                const authDir = `./auth_info_${session.session_id}`;
                
                if (fs.existsSync(authDir)) {
                    // Verificar se os arquivos estão corrompidos
                    const files = fs.readdirSync(authDir);
                    const hasValidFiles = files.some(file => 
                        file.endsWith('.json') && fs.statSync(`${authDir}/${file}`).size > 0
                    );

                    if (!hasValidFiles) {
                        // Arquivos corrompidos, remover
                        fs.rmSync(authDir, { recursive: true, force: true });
                        
                        // Marcar sessão como inativa
                        await this.db.execute(
                            'UPDATE whatsapp_sessions SET is_active = 0 WHERE session_id = ?',
                            [session.session_id]
                        );
                        
                        console.log(`🧹 Sessão corrompida removida: ${session.session_id}`);
                    }
                }
            }
        } catch (error) {
            console.error('❌ Erro ao limpar sessões corrompidas:', error);
        }
    }

    // Método para limpeza manual
    async forceCleanup() {
        console.log('🧹 Forçando limpeza completa...');
        
        try {
            // Remover todos os arquivos de autenticação
            const authDirs = fs.readdirSync('./').filter(dir => 
                dir.startsWith('auth_info_') && fs.statSync(dir).isDirectory()
            );

            for (const authDir of authDirs) {
                fs.rmSync(authDir, { recursive: true, force: true });
                console.log(`🧹 Removido: ${authDir}`);
            }

            // Marcar todas as sessões como inativas
            await this.db.execute('UPDATE whatsapp_sessions SET is_active = 0');
            console.log('🧹 Todas as sessões marcadas como inativas');
            
        } catch (error) {
            console.error('❌ Erro na limpeza forçada:', error);
        }
    }
}

module.exports = SessionCleanup;
