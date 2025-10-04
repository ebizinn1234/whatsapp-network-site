import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import crypto from 'crypto';
import authRoutes from './routes/auth.js';
import { authenticateToken } from './routes/auth.js';
import db from './config/database.js';
// import SessionCleanup from './auto-cleanup-sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rotas de autenticação
app.use('/api/auth', authRoutes);

// 🏦 ROTAS DO COFRE DE SESSÕES
app.get('/api/vault/status', async (req, res) => {
    try {
        const status = await sessionVault.getVaultStatus();
        res.json({ success: true, status });
    } catch (error) {
        console.error('❌ Erro ao obter status do cofre:', error);
        res.status(500).json({ success: false, error: 'Erro interno do servidor' });
    }
});

app.post('/api/vault/cleanup', async (req, res) => {
    try {
        await sessionVault.cleanOldSessions();
        const status = await sessionVault.getVaultStatus();
        res.json({ success: true, message: 'Limpeza concluída', status });
    } catch (error) {
        console.error('❌ Erro ao limpar cofre:', error);
        res.status(500).json({ success: false, error: 'Erro interno do servidor' });
    }
});

// Middleware para verificar autenticação
app.use('/api/*', authenticateToken);

// Armazenar sessões dos usuários
const userSessions = new Map();

// 🏦 SISTEMA DE COFRE PARA SESSÕES WHATSAPP
// 🚨 DETECTOR DE BLOQUEIOS DO WHATSAPP
class WhatsAppBlockDetector {
    constructor() {
        this.blockPatterns = {
            connectionClosed: ['Connection Closed', 'Connection lost', 'Connection timeout'],
            rateLimit: ['Rate limit', 'Too many requests', 'Request timeout'],
            banIndicators: ['Blocked', 'Banned', 'Suspended', 'Restricted'],
            suspiciousActivity: ['Suspicious activity', 'Unusual activity', 'Security check']
        };
        this.blockHistory = new Map(); // Histórico de bloqueios por usuário
        this.recoveryStrategies = new Map(); // Estratégias de recuperação
    }

    // 🔍 Detectar tipo de bloqueio
    detectBlockType(error) {
        const errorMessage = error.message || error.toString();
        
        for (const [type, patterns] of Object.entries(this.blockPatterns)) {
            for (const pattern of patterns) {
                if (errorMessage.includes(pattern)) {
                    return type;
                }
            }
        }
        return 'unknown';
    }

    // 📊 Registrar bloqueio
    recordBlock(userId, blockType, error) {
        if (!this.blockHistory.has(userId)) {
            this.blockHistory.set(userId, []);
        }
        
        const history = this.blockHistory.get(userId);
        const blockRecord = {
            type: blockType,
            timestamp: Date.now(),
            error: error.message,
            severity: this.getBlockSeverity(blockType)
        };
        
        history.push(blockRecord);
        
        // Manter apenas últimos 10 bloqueios
        if (history.length > 10) {
            history.shift();
        }
        
        console.log(`🚨 Bloqueio detectado para usuário ${userId}: ${blockType} (severidade: ${blockRecord.severity})`);
        
        // Aplicar estratégia de recuperação
        this.applyRecoveryStrategy(userId, blockType);
    }

    // ⚖️ Determinar severidade do bloqueio
    getBlockSeverity(blockType) {
        const severities = {
            'connectionClosed': 'medium',
            'rateLimit': 'high',
            'banIndicators': 'critical',
            'suspiciousActivity': 'high',
            'unknown': 'low'
        };
        return severities[blockType] || 'low';
    }

    // 🛠️ Aplicar estratégia de recuperação
    applyRecoveryStrategy(userId, blockType) {
        const strategies = {
            'connectionClosed': () => this.handleConnectionLoss(userId),
            'rateLimit': () => this.handleRateLimit(userId),
            'banIndicators': () => this.handleBan(userId),
            'suspiciousActivity': () => this.handleSuspiciousActivity(userId)
        };
        
        const strategy = strategies[blockType];
        if (strategy) {
            strategy();
        }
    }

    // 🔄 Lidar com perda de conexão
    handleConnectionLoss(userId) {
        console.log(`🔄 Aplicando estratégia de recuperação de conexão para usuário ${userId}`);
        
        // Pausar envios por 5 minutos
        this.pauseUserActivity(userId, 300000, 'Perda de conexão detectada');
        
        // Notificar usuário
        io.to(userId).emit('block-detected', {
            type: 'connection',
            message: 'Conexão perdida. Reconectando automaticamente...',
            waitTime: 300000
        });
    }

    // ⏱️ Lidar com limite de taxa
    handleRateLimit(userId) {
        console.log(`⏱️ Aplicando estratégia de rate limit para usuário ${userId}`);
        
        // Pausar por 30 minutos
        this.pauseUserActivity(userId, 1800000, 'Limite de taxa atingido');
        
        // Notificar usuário
        io.to(userId).emit('block-detected', {
            type: 'rate_limit',
            message: 'Limite de mensagens atingido. Aguarde 30 minutos.',
            waitTime: 1800000
        });
    }

    // 🚫 Lidar com banimento
    handleBan(userId) {
        console.log(`🚫 Aplicando estratégia de banimento para usuário ${userId}`);
        
        // Pausar por 2 horas
        this.pauseUserActivity(userId, 7200000, 'Possível banimento detectado');
        
        // Notificar usuário
        io.to(userId).emit('block-detected', {
            type: 'ban',
            message: 'Possível banimento detectado. Aguarde 2 horas antes de tentar novamente.',
            waitTime: 7200000
        });
    }

    // 🕵️ Lidar com atividade suspeita
    handleSuspiciousActivity(userId) {
        console.log(`🕵️ Aplicando estratégia de atividade suspeita para usuário ${userId}`);
        
        // Pausar por 1 hora
        this.pauseUserActivity(userId, 3600000, 'Atividade suspeita detectada');
        
        // Notificar usuário
        io.to(userId).emit('block-detected', {
            type: 'suspicious',
            message: 'Atividade suspeita detectada. Aguarde 1 hora.',
            waitTime: 3600000
        });
    }

    // ⏸️ Pausar atividade do usuário
    pauseUserActivity(userId, duration, reason) {
        if (!userSessions[userId]) {
            userSessions[userId] = {};
        }
        
        userSessions[userId].isPaused = true;
        userSessions[userId].pauseReason = reason;
        userSessions[userId].pauseUntil = Date.now() + duration;
        
        console.log(`⏸️ Usuário ${userId} pausado por ${Math.round(duration/60000)} minutos: ${reason}`);
        
        // Remover pausa após o tempo
        setTimeout(() => {
            if (userSessions[userId]) {
                userSessions[userId].isPaused = false;
                userSessions[userId].pauseReason = null;
                userSessions[userId].pauseUntil = null;
                console.log(`▶️ Pausa removida para usuário ${userId}`);
            }
        }, duration);
    }

    // 📈 Obter estatísticas de bloqueio
    getBlockStats(userId) {
        const history = this.blockHistory.get(userId) || [];
        const stats = {
            totalBlocks: history.length,
            lastBlock: history[history.length - 1] || null,
            blockTypes: {},
            severity: 'low'
        };
        
        // Contar tipos de bloqueio
        history.forEach(block => {
            stats.blockTypes[block.type] = (stats.blockTypes[block.type] || 0) + 1;
        });
        
        // Determinar severidade geral
        const hasCritical = history.some(block => block.severity === 'critical');
        const hasHigh = history.some(block => block.severity === 'high');
        
        if (hasCritical) stats.severity = 'critical';
        else if (hasHigh) stats.severity = 'high';
        else if (history.length > 0) stats.severity = 'medium';
        
        return stats;
    }
}

class SessionVault {
    constructor() {
        this.vaultDir = path.join(__dirname, 'session_vault');
        this.backupDir = path.join(__dirname, 'session_backups');
        this.ensureDirectories();
    }

    async ensureDirectories() {
        try {
            await fsPromises.mkdir(this.vaultDir, { recursive: true });
            await fsPromises.mkdir(this.backupDir, { recursive: true });
            console.log('🏦 Cofre de sessões inicializado');
        } catch (error) {
            console.error('❌ Erro ao criar diretórios do cofre:', error);
        }
    }

    // 💾 Salvar dados da sessão (sem criptografia)
    saveSessionData(data) {
        return JSON.stringify(data);
    }

    // 📖 Ler dados da sessão (sem descriptografia)
    readSessionData(data) {
        try {
            return JSON.parse(data);
        } catch (error) {
            console.error('❌ Erro ao ler dados da sessão:', error);
            return null;
        }
    }

    // 💾 Salvar sessão no cofre com backup
    async saveSessionToVault(userId, sessionId, sessionData) {
        try {
            const vaultKey = `${userId}_${sessionId}`;
            const vaultPath = path.join(this.vaultDir, `${vaultKey}.vault`);
            const backupPath = path.join(this.backupDir, `${vaultKey}_${Date.now()}.backup`);
            
            // Dados para salvar
            const serializedData = this.saveSessionData(sessionData);
            const vaultData = {
                userId,
                sessionId,
                timestamp: Date.now(),
                sessionData: serializedData,
                checksum: crypto.createHash('sha256').update(serializedData).digest('hex')
            };

            // Salvar no cofre principal
            await fsPromises.writeFile(vaultPath, JSON.stringify(vaultData, null, 2));
            
            // Criar backup
            await fsPromises.writeFile(backupPath, JSON.stringify(vaultData, null, 2));
            
            console.log(`🏦 Sessão salva no cofre: ${vaultKey}`);
            console.log(`💾 Backup criado: ${backupPath}`);
            
            return true;
        } catch (error) {
            console.error('❌ Erro ao salvar sessão no cofre:', error);
            return false;
        }
    }

    // 🔍 Recuperar sessão do cofre
    async recoverSessionFromVault(userId, sessionId) {
        try {
            const vaultKey = `${userId}_${sessionId}`;
            const vaultPath = path.join(this.vaultDir, `${vaultKey}.vault`);
            
            // Tentar recuperar do cofre principal
            if (fs.existsSync(vaultPath)) {
                const vaultData = JSON.parse(await fsPromises.readFile(vaultPath, 'utf8'));
                
                // Verificar integridade
                const currentChecksum = crypto.createHash('sha256').update(JSON.stringify(vaultData.sessionData)).digest('hex');
                if (currentChecksum === vaultData.checksum) {
                    console.log(`🏦 Sessão recuperada do cofre: ${vaultKey}`);
                    return this.readSessionData(vaultData.sessionData);
                } else {
                    console.log(`⚠️ Checksum inválido para sessão: ${vaultKey}`);
                }
            }
            
            // Se não encontrou no cofre principal, tentar backups
            const backupFiles = await fsPromises.readdir(this.backupDir);
            const userBackups = backupFiles.filter(file => file.startsWith(vaultKey) && file.endsWith('.backup'));
            
            // Ordenar por timestamp (mais recente primeiro)
            userBackups.sort((a, b) => {
                const timestampA = parseInt(a.split('_').pop().replace('.backup', ''));
                const timestampB = parseInt(b.split('_').pop().replace('.backup', ''));
                return timestampB - timestampA;
            });
            
            for (const backupFile of userBackups) {
                try {
                    const backupPath = path.join(this.backupDir, backupFile);
                    const vaultData = JSON.parse(await fsPromises.readFile(backupPath, 'utf8'));
                    
                    // Verificar integridade
                    const currentChecksum = crypto.createHash('sha256').update(JSON.stringify(vaultData.sessionData)).digest('hex');
                    if (currentChecksum === vaultData.checksum) {
                        console.log(`🏦 Sessão recuperada do backup: ${backupFile}`);
                        return this.readSessionData(vaultData.sessionData);
                    }
                } catch (error) {
                    console.error(`❌ Erro ao ler backup ${backupFile}:`, error);
                    continue;
                }
            }
            
            console.log(`❌ Nenhuma sessão válida encontrada no cofre para: ${vaultKey}`);
            return null;
            
        } catch (error) {
            console.error('❌ Erro ao recuperar sessão do cofre:', error);
            return null;
        }
    }

    // 🧹 Limpar sessões antigas do cofre
    async cleanOldSessions(maxAge = 30 * 24 * 60 * 60 * 1000) { // 30 dias
        try {
            const now = Date.now();
            
            // Limpar cofre principal
            const vaultFiles = await fsPromises.readdir(this.vaultDir);
            for (const file of vaultFiles) {
                if (file.endsWith('.vault')) {
                    const filePath = path.join(this.vaultDir, file);
                    const stats = await fsPromises.stat(filePath);
                    if (now - stats.mtime.getTime() > maxAge) {
                        await fsPromises.unlink(filePath);
                        console.log(`🧹 Sessão antiga removida do cofre: ${file}`);
                    }
                }
            }
            
            // Limpar backups antigos (manter apenas os 5 mais recentes por usuário)
            const backupFiles = await fsPromises.readdir(this.backupDir);
            const backupGroups = {};
            
            for (const file of backupFiles) {
                if (file.endsWith('.backup')) {
                    const userId = file.split('_')[0];
                    if (!backupGroups[userId]) backupGroups[userId] = [];
                    backupGroups[userId].push(file);
                }
            }
            
            for (const [userId, files] of Object.entries(backupGroups)) {
                if (files.length > 5) {
                    // Ordenar por timestamp e remover os mais antigos
                    files.sort((a, b) => {
                        const timestampA = parseInt(a.split('_').pop().replace('.backup', ''));
                        const timestampB = parseInt(b.split('_').pop().replace('.backup', ''));
                        return timestampA - timestampB;
                    });
                    
                    const toRemove = files.slice(0, files.length - 5);
                    for (const file of toRemove) {
                        const filePath = path.join(this.backupDir, file);
                        await fsPromises.unlink(filePath);
                        console.log(`🧹 Backup antigo removido: ${file}`);
                    }
                }
            }
            
        } catch (error) {
            console.error('❌ Erro ao limpar sessões antigas:', error);
        }
    }

    // 📊 Status do cofre
    async getVaultStatus() {
        try {
            const vaultFiles = await fsPromises.readdir(this.vaultDir);
            const backupFiles = await fsPromises.readdir(this.backupDir);
            
            return {
                vaultSessions: vaultFiles.filter(f => f.endsWith('.vault')).length,
                backupSessions: backupFiles.filter(f => f.endsWith('.backup')).length,
                totalSize: await this.getDirectorySize(this.vaultDir) + await this.getDirectorySize(this.backupDir)
            };
        } catch (error) {
            console.error('❌ Erro ao obter status do cofre:', error);
            return { vaultSessions: 0, backupSessions: 0, totalSize: 0 };
        }
    }

    async getDirectorySize(dirPath) {
        try {
            const files = await fsPromises.readdir(dirPath);
            let totalSize = 0;
            
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stats = await fsPromises.stat(filePath);
                totalSize += stats.size;
            }
            
            return totalSize;
        } catch (error) {
            return 0;
        }
    }
}

// Inicializar cofre de sessões
const sessionVault = new SessionVault();

// Inicializar detector de bloqueios
const blockDetector = new WhatsAppBlockDetector();

// 🔍 ANALISADOR DE PADRÕES DO WHATSAPP
class WhatsAppPatternAnalyzer {
    constructor() {
        this.patterns = {
            // Padrões que o WhatsApp monitora
            suspiciousPatterns: [
                'identical_messages',      // Mensagens idênticas
                'rapid_sending',          // Envio muito rápido
                'bulk_contacts',          // Muitos contatos de uma vez
                'repetitive_timing',      // Timing repetitivo
                'no_reading_time',        // Sem tempo de leitura
                'no_typing_simulation',   // Sem simulação de digitação
                'same_hour_activity',     // Atividade sempre no mesmo horário
                'no_breaks',              // Sem pausas naturais
                'too_many_groups',        // Muitos grupos
                'no_response_pattern'     // Sem padrão de resposta
            ],
            
            // Padrões seguros
            safePatterns: [
                'varied_messages',        // Mensagens variadas
                'natural_timing',         // Timing natural
                'reading_simulation',     // Simulação de leitura
                'typing_simulation',      // Simulação de digitação
                'break_patterns',         // Padrões de pausa
                'hour_variation',         // Variação de horários
                'response_simulation',    // Simulação de resposta
                'human_errors',           // Erros humanos
                'context_awareness'       // Consciência contextual
            ]
        };
        
        this.userPatterns = new Map(); // Padrões por usuário
        this.globalPatterns = new Map(); // Padrões globais
    }

    // 📊 Analisar padrão de envio
    analyzeSendingPattern(userId, messageData) {
        if (!this.userPatterns.has(userId)) {
            this.userPatterns.set(userId, {
                messages: [],
                timings: [],
                groups: new Set(),
                lastAnalysis: Date.now()
            });
        }
        
        const userPattern = this.userPatterns.get(userId);
        const now = Date.now();
        
        // Registrar dados
        userPattern.messages.push({
            content: messageData.content,
            timestamp: now,
            groupId: messageData.groupId,
            delay: messageData.delay
        });
        
        userPattern.timings.push(now);
        userPattern.groups.add(messageData.groupId);
        
        // Manter apenas últimos 50 registros
        if (userPattern.messages.length > 50) {
            userPattern.messages.shift();
            userPattern.timings.shift();
        }
        
        // Analisar padrões
        const analysis = this.performPatternAnalysis(userId);
        
        // Aplicar correções se necessário
        this.applyPatternCorrections(userId, analysis);
        
        return analysis;
    }

    // 🔍 Realizar análise de padrões
    performPatternAnalysis(userId) {
        const userPattern = this.userPatterns.get(userId);
        if (!userPattern || userPattern.messages.length < 3) {
            return { risk: 'low', issues: [], recommendations: [] };
        }
        
        const issues = [];
        const recommendations = [];
        let riskScore = 0;
        
        // 1. Verificar mensagens idênticas
        const identicalCount = this.countIdenticalMessages(userPattern.messages);
        if (identicalCount > 0.7) { // Mais de 70% idênticas
            issues.push('Muitas mensagens idênticas');
            riskScore += 2;
            recommendations.push('Varia mais o conteúdo das mensagens');
        }
        
        // 2. Verificar timing repetitivo
        const timingVariation = this.analyzeTimingVariation(userPattern.timings);
        if (timingVariation < 0.3) { // Pouca variação
            issues.push('Timing muito repetitivo');
            riskScore += 1;
            recommendations.push('Varie mais os intervalos entre mensagens');
        }
        
        // 3. Verificar velocidade
        const avgSpeed = this.calculateAverageSpeed(userPattern.timings);
        if (avgSpeed > 0.5) { // Muito rápido
            issues.push('Envio muito rápido');
            riskScore += 2;
            recommendations.push('Reduza a velocidade de envio');
        }
        
        // 4. Verificar diversidade de grupos
        const groupDiversity = userPattern.groups.size / userPattern.messages.length;
        if (groupDiversity < 0.3) { // Poucos grupos diferentes
            issues.push('Pouca diversidade de grupos');
            riskScore += 1;
            recommendations.push('Varie mais os grupos de destino');
        }
        
        // Determinar nível de risco
        let riskLevel = 'low';
        if (riskScore >= 4) riskLevel = 'critical';
        else if (riskScore >= 3) riskLevel = 'high';
        else if (riskScore >= 1) riskLevel = 'medium';
        
        return {
            risk: riskLevel,
            score: riskScore,
            issues,
            recommendations,
            stats: {
                identicalMessages: identicalCount,
                timingVariation,
                averageSpeed: avgSpeed,
                groupDiversity
            }
        };
    }

    // 🔢 Contar mensagens idênticas
    countIdenticalMessages(messages) {
        if (messages.length < 2) return 0;
        
        const contentCounts = {};
        messages.forEach(msg => {
            const content = msg.content.toLowerCase().trim();
            contentCounts[content] = (contentCounts[content] || 0) + 1;
        });
        
        const maxCount = Math.max(...Object.values(contentCounts));
        return maxCount / messages.length;
    }

    // ⏰ Analisar variação de timing
    analyzeTimingVariation(timings) {
        if (timings.length < 2) return 1;
        
        const intervals = [];
        for (let i = 1; i < timings.length; i++) {
            intervals.push(timings[i] - timings[i-1]);
        }
        
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - avg, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);
        
        return Math.min(stdDev / avg, 1); // Coeficiente de variação
    }

    // ⚡ Calcular velocidade média
    calculateAverageSpeed(timings) {
        if (timings.length < 2) return 0;
        
        const totalTime = timings[timings.length - 1] - timings[0];
        const messagesPerMinute = (timings.length - 1) / (totalTime / 60000);
        
        return Math.min(messagesPerMinute / 10, 1); // Normalizar para 0-1
    }

    // 🛠️ Aplicar correções de padrão
    applyPatternCorrections(userId, analysis) {
        if (analysis.risk === 'critical') {
            // Pausa forçada
            blockDetector.pauseUserActivity(userId, 3600000, 'Padrão crítico detectado');
        } else if (analysis.risk === 'high') {
            // Aumentar delays
            const userProfile = humanLikeAI.analyzeUserProfile(userId);
            userProfile.typingSpeed.normal *= 2; // Dobrar velocidade de digitação
        }
        
        // Notificar usuário
        io.to(userId).emit('pattern-analysis', {
            risk: analysis.risk,
            issues: analysis.issues,
            recommendations: analysis.recommendations,
            stats: analysis.stats
        });
    }
}

// Inicializar analisador de padrões
const patternAnalyzer = new WhatsAppPatternAnalyzer();

// 🛡️ SISTEMA DE PROTEÇÃO CONTRA BANIMENTO
class AntiBanProtection {
    constructor() {
        this.userStats = new Map(); // Estatísticas por usuário
        this.globalStats = {
            totalMessages: 0,
            totalGroups: 0,
            lastActivity: Date.now()
        };
    }

    // 📊 Registrar atividade do usuário (MELHORADO COM DASHBOARD)
    recordUserActivity(userId, action, details = {}) {
        if (!this.userStats.has(userId)) {
            this.userStats.set(userId, {
                messagesSent: 0,
                groupsContacted: 0,
                lastMessage: 0,
                lastGroupContact: 0,
                dailyLimit: 0,
                hourlyLimit: 0,
                riskLevel: 'low',
                riskScore: 0,
                sessionStart: Date.now(),
                consecutiveMessages: 0,
                avgDelay: 0,
                personality: 'balanced'
            });
        }

        const stats = this.userStats.get(userId);
        const now = Date.now();

        switch (action) {
            case 'message_sent':
                stats.messagesSent++;
                stats.lastMessage = now;
                this.globalStats.totalMessages++;
                break;
            case 'group_contacted':
                stats.groupsContacted++;
                stats.lastGroupContact = now;
                this.globalStats.totalGroups++;
                break;
        }

        // Atualizar nível de risco
        this.updateRiskLevel(userId);
        
        // 📊 ENVIAR ATUALIZAÇÃO DO DASHBOARD EM TEMPO REAL
        this.sendDashboardUpdate(userId);
        
        console.log(`📊 Atividade registrada: ${action} para usuário ${userId}`);
    }

    // 📊 Enviar atualização do dashboard em tempo real
    sendDashboardUpdate(userId) {
        const stats = this.userStats.get(userId);
        if (!stats) return;

        // Obter personalidade do usuário
        const userProfile = humanLikeAI.analyzeUserProfile(userId);
        
        const dashboardData = {
            score: stats.riskScore || 0,
            messagesSent: stats.messagesSent || 0,
            groupsContacted: stats.groupsContacted || 0,
            avgDelay: stats.avgDelay ? `${Math.round(stats.avgDelay/1000)}s` : '0s',
            personality: userProfile.personality || 'balanced',
            riskLevel: stats.riskLevel || 'low',
            sessionDuration: Math.round((Date.now() - stats.sessionStart) / 60000), // minutos
            consecutiveMessages: stats.consecutiveMessages || 0
        };

        // Enviar para o frontend
        io.to(`user_${userId}`).emit('risk-update', dashboardData);
        console.log(`📊 Dashboard atualizado para usuário ${userId}:`, dashboardData);
    }

    // ⚠️ Atualizar nível de risco
    updateRiskLevel(userId) {
        const stats = this.userStats.get(userId);
        if (!stats) return;

        const now = Date.now();
        const timeSinceLastMessage = now - stats.lastMessage;
        const messagesPerHour = stats.messagesSent / ((now - stats.lastMessage) / (1000 * 60 * 60));

        // Calcular risco baseado em vários fatores
        let riskScore = 0;

        // Muitas mensagens em pouco tempo = alto risco
        if (messagesPerHour > 50) riskScore += 3;
        else if (messagesPerHour > 20) riskScore += 2;
        else if (messagesPerHour > 10) riskScore += 1;

        // Muitos grupos contactados = alto risco
        if (stats.groupsContacted > 100) riskScore += 3;
        else if (stats.groupsContacted > 50) riskScore += 2;
        else if (stats.groupsContacted > 20) riskScore += 1;

        // Score base por atividade (mesmo no início)
        if (stats.messagesSent > 0) riskScore += 1; // +1 por ter enviado mensagens
        if (stats.groupsContacted > 5) riskScore += 1; // +1 por contactar muitos grupos
        if (stats.consecutiveMessages > 3) riskScore += 1; // +1 por muitas mensagens consecutivas

        // Salvar o score calculado
        stats.riskScore = riskScore;

        // Determinar nível de risco
        if (riskScore >= 5) stats.riskLevel = 'critical';
        else if (riskScore >= 3) stats.riskLevel = 'high';
        else if (riskScore >= 1) stats.riskLevel = 'medium';
        else stats.riskLevel = 'low';

        console.log(`⚠️ Nível de risco atualizado para usuário ${userId}: ${stats.riskLevel} (score: ${riskScore})`);
    }

    // 🚫 Verificar se pode enviar mensagem (MELHORADO COM PAUSAS AUTOMÁTICAS)
    canSendMessage(userId, groupId) {
        const stats = this.userStats.get(userId);
        if (!stats) return { allowed: true, reason: 'Primeira mensagem' };

        const now = Date.now();
        const timeSinceLastMessage = now - stats.lastMessage;

        // Verificações de segurança (MELHORADAS)
        const checks = {
            // Muito rápido = suspeito (AUMENTADO)
            tooFast: timeSinceLastMessage < 5000, // Menos de 5 segundos (mais seguro)
            
            // Muitas mensagens por hora (REDUZIDO)
            tooManyPerHour: stats.messagesSent > 15, // Máximo 15 por hora (muito mais seguro)
            
            // Muitos grupos diferentes (REDUZIDO)
            tooManyGroups: stats.groupsContacted > 20, // Máximo 20 grupos (mais seguro)
            
            // Risco crítico
            criticalRisk: stats.riskLevel === 'critical',
            
            // NOVO: Pausa automática quando score > 2
            autoPause: stats.riskScore > 2,
            
            // NOVO: Pausa por tempo de sessão (máximo 2 horas)
            sessionTooLong: (now - stats.sessionStart) > 7200000, // 2 horas
            
            // NOVO: Pausa por muitas mensagens consecutivas
            tooManyConsecutive: stats.consecutiveMessages > 5
        };

        // Se risco crítico, bloquear
        if (checks.criticalRisk) {
            return { 
                allowed: false, 
                reason: '🛑 Risco crítico detectado. Aguarde 2 horas antes de tentar novamente.',
                waitTime: 7200000 // 2 horas
            };
        }

        // NOVO: Pausa automática quando score > 2
        if (checks.autoPause) {
            const pauseTime = 1800000; // 30 minutos
            return { 
                allowed: false, 
                reason: '🤖 IA: Pausa automática ativada (score alto). Aguarde 30 minutos.',
                waitTime: pauseTime
            };
        }

        // NOVO: Pausa por sessão muito longa
        if (checks.sessionTooLong) {
            return { 
                allowed: false, 
                reason: '⏰ Sessão muito longa. Aguarde 1 hora para descansar.',
                waitTime: 3600000 // 1 hora
            };
        }

        // NOVO: Pausa por muitas mensagens consecutivas
        if (checks.tooManyConsecutive) {
            return { 
                allowed: false, 
                reason: '🔄 Muitas mensagens consecutivas. Pausa de 15 minutos.',
                waitTime: 900000 // 15 minutos
            };
        }

        // Se muito rápido, forçar delay (AUMENTADO)
        if (checks.tooFast) {
            return { 
                allowed: false, 
                reason: '⚡ Muito rápido! Aguarde 10 segundos.',
                waitTime: 10000 // 10 segundos
            };
        }

        // Se muitas mensagens por hora, forçar delay maior (AUMENTADO)
        if (checks.tooManyPerHour) {
            return { 
                allowed: false, 
                reason: '📊 Limite de mensagens por hora atingido. Aguarde 30 minutos.',
                waitTime: 1800000 // 30 minutos
            };
        }

        // Se muitos grupos, forçar pausa
        if (checks.tooManyGroups) {
            return { 
                allowed: false, 
                reason: '👥 Muitos grupos contactados. Aguarde 20 minutos.',
                waitTime: 1200000 // 20 minutos
            };
        }

        return { allowed: true, reason: '✅ OK para enviar' };
    }

    // ⏱️ Calcular delay inteligente
    calculateSmartDelay(userId, groupId) {
        const stats = this.userStats.get(userId);
        if (!stats) return 5000; // 5 segundos para novos usuários

        const baseDelay = 5000; // 5 segundos base
        let additionalDelay = 0;

        // Ajustar delay baseado no nível de risco
        switch (stats.riskLevel) {
            case 'critical':
                additionalDelay = 300000; // +5 minutos
                break;
            case 'high':
                additionalDelay = 120000; // +2 minutos
                break;
            case 'medium':
                additionalDelay = 60000; // +1 minuto
                break;
            case 'low':
                additionalDelay = 0;
                break;
        }

        // Adicionar variação aleatória para parecer mais humano
        const randomVariation = Math.random() * 10000; // 0-10 segundos

        const totalDelay = baseDelay + additionalDelay + randomVariation;
        
        console.log(`⏱️ Delay calculado para usuário ${userId}: ${Math.round(totalDelay/1000)}s (risco: ${stats.riskLevel})`);
        
        return totalDelay;
    }

    // 📈 Obter estatísticas
    getStats(userId = null) {
        if (userId) {
            return this.userStats.get(userId) || null;
        }
        return {
            global: this.globalStats,
            users: Array.from(this.userStats.entries()).map(([id, stats]) => ({
                userId: id,
                ...stats
            }))
        };
    }

    // 🧹 Limpar estatísticas antigas
    cleanOldStats() {
        const now = Date.now();
        const oneDayAgo = now - (24 * 60 * 60 * 1000);

        for (const [userId, stats] of this.userStats.entries()) {
            if (stats.lastMessage < oneDayAgo) {
                this.userStats.delete(userId);
                console.log(`🧹 Estatísticas antigas removidas para usuário ${userId}`);
            }
        }
    }
}

// Inicializar proteção contra banimento
const antiBanProtection = new AntiBanProtection();

// 🤖 SISTEMA DE IA PARA ENVIO HUMANO INTELIGENTE
class HumanLikeAI {
    constructor() {
        this.userProfiles = new Map(); // Perfis de comportamento por usuário
        this.globalPatterns = {
            typingSpeed: { min: 800, max: 3000 }, // Velocidade de digitação humana
            readingTime: { min: 2000, max: 8000 }, // Tempo de leitura
            breakPatterns: [30000, 60000, 120000, 300000], // Pausas naturais
            activityHours: [9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21] // Horários ativos
        };
    }

    // 🧠 Analisar perfil do usuário
    analyzeUserProfile(userId) {
        if (!this.userProfiles.has(userId)) {
            this.userProfiles.set(userId, {
                personality: this.generatePersonality(),
                typingSpeed: this.getRandomTypingSpeed(),
                activityPattern: this.generateActivityPattern(),
                messageStyle: this.generateMessageStyle(),
                riskTolerance: Math.random() * 0.3 + 0.1, // 0.1 a 0.4
                lastActivity: Date.now()
            });
        }
        return this.userProfiles.get(userId);
    }

    // 🎭 Gerar personalidade única
    generatePersonality() {
        const personalities = [
            'cautious',    // Cuidadoso - delays maiores
            'balanced',    // Equilibrado - delays médios  
            'active',      // Ativo - delays menores
            'professional', // Profissional - horários específicos
            'casual'       // Casual - padrões irregulares
        ];
        return personalities[Math.floor(Math.random() * personalities.length)];
    }

    // ⌨️ Velocidade de digitação humana mais realista
    getRandomTypingSpeed() {
        const baseSpeed = Math.random() * 1500 + 1000; // 1000-2500ms por caractere (mais realista)
        return {
            fast: baseSpeed * 0.6,    // Digitação rápida
            normal: baseSpeed,        // Velocidade normal
            slow: baseSpeed * 1.8,    // Digitação mais lenta
            verySlow: baseSpeed * 2.5 // Digitação muito lenta (pensando)
        };
    }

    // 📅 Padrão de atividade
    generateActivityPattern() {
        return {
            preferredHours: this.globalPatterns.activityHours.slice(0, Math.floor(Math.random() * 5) + 3),
            breakFrequency: Math.random() * 0.3 + 0.1, // 10-40% chance de pausa
            sessionLength: Math.random() * 30 + 10 // 10-40 minutos por sessão
        };
    }

    // ✍️ Estilo de mensagem
    generateMessageStyle() {
        const styles = [
            { useEmojis: true, useCaps: false, formal: false },
            { useEmojis: false, useCaps: true, formal: true },
            { useEmojis: true, useCaps: true, formal: false },
            { useEmojis: false, useCaps: false, formal: true }
        ];
        return styles[Math.floor(Math.random() * styles.length)];
    }

    // ⏱️ Calcular delay inteligente baseado em IA (MELHORADO)
    calculateIntelligentDelay(userId, messageLength, groupId) {
        const profile = this.analyzeUserProfile(userId);
        const now = new Date();
        const currentHour = now.getHours();
        
        // Base delay por personalidade (OTIMIZADOS para praticidade)
        let baseDelay = 60000; // 1 minuto base
        switch (profile.personality) {
            case 'cautious':
                baseDelay = 120000; // 2 minutos - cuidado moderado
                break;
            case 'balanced':
                baseDelay = 90000; // 1.5 minutos - equilibrado
                break;
            case 'active':
                baseDelay = 60000; // 1 minuto - ativo
                break;
            case 'professional':
                baseDelay = 240000; // 4 minutos - profissional
                break;
            case 'casual':
                baseDelay = Math.random() * 120000 + 90000; // 1.5-3.5 minutos aleatório
                break;
        }

        // Ajustar por horário (mais lento fora do horário ativo)
        if (!profile.activityPattern.preferredHours.includes(currentHour)) {
            baseDelay *= 1.5; // 50% mais lento fora do horário
        }

        // Simular tempo de digitação humana (MELHORADO)
        const typingSpeed = profile.typingSpeed;
        let typingTime = 0;
        
        // Escolher velocidade de digitação baseada no contexto
        if (messageLength > 100) {
            typingTime = messageLength * typingSpeed.slow; // Mensagens longas = digitação mais lenta
        } else if (messageLength < 20) {
            typingTime = messageLength * typingSpeed.fast; // Mensagens curtas = digitação mais rápida
        } else {
            typingTime = messageLength * typingSpeed.normal; // Mensagens médias = velocidade normal
        }
        
        // Adicionar pausa de leitura (MELHORADO)
        const readingTime = Math.random() * 8000 + 2000; // 2-10s (mais realista)

        // Variação aleatória para parecer humano (AUMENTADA)
        const humanVariation = Math.random() * 30000 + 10000; // 10-40s (muito mais variação)

        // Pausa ocasional (simular distração) - MAIS FREQUENTE
        let breakTime = 0;
        if (Math.random() < 0.4) { // 40% chance de pausa (mais humano)
            const breakOptions = [60000, 120000, 180000, 300000]; // 1-5 minutos
            breakTime = breakOptions[Math.floor(Math.random() * breakOptions.length)];
            console.log(`🤖 IA: Pausa humana detectada para usuário ${userId} (${Math.round(breakTime/1000)}s)`);
        }

        // Adicionar fator de cansaço (mais lento conforme o tempo passa)
        const sessionStart = profile.lastActivity || Date.now();
        const sessionDuration = Date.now() - sessionStart;
        const fatigueFactor = Math.min(sessionDuration / 3600000, 2); // Máximo 2x mais lento após 1 hora
        const fatigueDelay = baseDelay * fatigueFactor * 0.3; // 30% do delay base por fator de cansaço

        const totalDelay = baseDelay + typingTime + readingTime + humanVariation + breakTime + fatigueDelay;
        
        console.log(`🤖 IA Delay calculado para ${userId}: ${Math.round(totalDelay/1000)}s (${profile.personality}, ${messageLength} chars, cansaço: ${Math.round(fatigueFactor*100)}%)`);
        
        return Math.min(totalDelay, 600000); // Máximo 10 minutos (muito mais seguro)
    }

    // 🎯 Decidir se deve enviar agora (baseado em padrões humanos)
    shouldSendNow(userId) {
        const profile = this.analyzeUserProfile(userId);
        const now = new Date();
        const currentHour = now.getHours();
        
        // Verificar horário ativo
        if (!profile.activityPattern.preferredHours.includes(currentHour)) {
            const chance = 0.2; // 20% chance fora do horário
            if (Math.random() > chance) {
                console.log(`🤖 IA: Horário inativo para ${userId} (${currentHour}h) - aguardando`);
                return false;
            }
        }

        // Verificar se precisa de pausa
        if (Math.random() < profile.activityPattern.breakFrequency) {
            console.log(`🤖 IA: Pausa necessária para ${userId}`);
            return false;
        }

        return true;
    }

    // 📝 Modificar mensagem para parecer mais humana (MELHORADO)
    humanizeMessage(message, profile) {
        let humanizedMessage = message;

        // 🎭 Variações baseadas na personalidade
        const personality = profile.personality;
        
        // Adicionar emojis baseado na personalidade
        if (Math.random() < this.getEmojiChance(personality)) {
            const emojis = this.getPersonalityEmojis(personality);
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            
            // Posicionar emoji de forma natural
            if (Math.random() < 0.5) {
                humanizedMessage = emoji + ' ' + humanizedMessage; // No início
            } else {
                humanizedMessage += ' ' + emoji; // No final
            }
        }

        // 📝 Variações de formatação baseadas na personalidade
        if (personality === 'professional') {
            // Profissional: manter formal, mas ocasionalmente adicionar entusiasmo
            if (Math.random() < 0.1) {
                humanizedMessage = humanizedMessage.replace(/\.$/, '!');
            }
        } else if (personality === 'casual') {
            // Casual: mais variações
            if (Math.random() < 0.3) {
                humanizedMessage = humanizedMessage.toLowerCase();
            }
            if (Math.random() < 0.2) {
                humanizedMessage = humanizedMessage.replace(/\b(é|e)\b/gi, 'eh');
            }
        } else if (personality === 'active') {
            // Ativo: mais energia
            if (Math.random() < 0.2) {
                humanizedMessage = humanizedMessage.toUpperCase();
            }
        }

        // ⌨️ Erros de digitação mais realistas
        if (Math.random() < this.getTypoChance(personality)) {
            humanizedMessage = this.addRealisticTypos(humanizedMessage);
        }

        // 🎯 Variações de pontuação
        if (Math.random() < 0.1) {
            humanizedMessage = this.varyPunctuation(humanizedMessage);
        }

        // 📱 Simular comportamento de WhatsApp (abreviações ocasionais)
        if (personality === 'casual' && Math.random() < 0.15) {
            humanizedMessage = this.addWhatsAppAbbreviations(humanizedMessage);
        }

        return humanizedMessage;
    }

    // 🎭 Obter chance de emoji baseada na personalidade
    getEmojiChance(personality) {
        const chances = {
            'cautious': 0.1,      // Poucos emojis
            'balanced': 0.2,      // Emojis moderados
            'active': 0.4,        // Muitos emojis
            'professional': 0.05, // Quase nenhum emoji
            'casual': 0.5         // Muitos emojis
        };
        return chances[personality] || 0.2;
    }

    // 😊 Obter emojis baseados na personalidade
    getPersonalityEmojis(personality) {
        const emojiSets = {
            'cautious': ['👍', '✅', '💯'],
            'balanced': ['😊', '👍', '✨', '💪'],
            'active': ['🚀', '💪', '🔥', '⚡', '🎯'],
            'professional': ['✅', '💼', '📈'],
            'casual': ['😊', '👍', '✨', '💪', '🚀', '🔥', '💯', '🎉']
        };
        return emojiSets[personality] || emojiSets['balanced'];
    }

    // ⌨️ Obter chance de erro de digitação
    getTypoChance(personality) {
        const chances = {
            'cautious': 0.02,     // Quase nenhum erro
            'balanced': 0.05,     // Poucos erros
            'active': 0.08,       // Alguns erros
            'professional': 0.01, // Muito poucos erros
            'casual': 0.1         // Mais erros
        };
        return chances[personality] || 0.05;
    }

    // ⌨️ Adicionar erros de digitação realistas
    addRealisticTypos(message) {
        const typos = [
            // Trocar letras adjacentes
            (text) => text.replace(/([a-z])([a-z])/gi, (match, a, b) => 
                Math.random() < 0.1 ? b + a : match
            ),
            // Remover vogais ocasionais
            (text) => text.replace(/[aeiou]/gi, (match, offset) => 
                offset > 0 && Math.random() < 0.1 ? '' : match
            ),
            // Duplicar letras ocasionais
            (text) => text.replace(/([a-z])/gi, (match) => 
                Math.random() < 0.05 ? match + match : match
            ),
            // Trocar letras similares
            (text) => text.replace(/e/gi, (match) => 
                Math.random() < 0.1 ? 'i' : match
            )
        ];
        
        let result = message;
        typos.forEach(typo => {
            if (Math.random() < 0.3) {
                result = typo(result);
            }
        });
        
        return result;
    }

    // 🎯 Variações de pontuação
    varyPunctuation(message) {
        const variations = [
            message.replace(/\.$/, '!'),
            message.replace(/\.$/, '...'),
            message.replace(/!$/, '.'),
            message + '!',
            message + '...'
        ];
        
        return variations[Math.floor(Math.random() * variations.length)];
    }

    // 📱 Adicionar abreviações do WhatsApp
    addWhatsAppAbbreviations(message) {
        const abbreviations = {
            'voce': 'vc',
            'você': 'vc',
            'para': 'pra',
            'com': 'c/',
            'nao': 'n',
            'não': 'n',
            'que': 'q',
            'de': 'd',
            'do': 'd',
            'da': 'd'
        };
        
        let result = message;
        Object.entries(abbreviations).forEach(([full, abbrev]) => {
            if (Math.random() < 0.3) {
                const regex = new RegExp(`\\b${full}\\b`, 'gi');
                result = result.replace(regex, abbrev);
            }
        });
        
        return result;
    }

    // ⌨️ Simular digitação humana antes de enviar mensagem
    async simulateTyping(sock, groupId, message, userId) {
        try {
            const profile = this.analyzeUserProfile(userId);
            
            // 1. Mostrar "digitando..." no WhatsApp
            await sock.presenceSubscribe(groupId);
            await sock.sendPresenceUpdate('composing', groupId);
            
            // 2. Calcular tempo de digitação baseado na mensagem e personalidade
            const typingTime = this.calculateTypingTime(message, profile);
            
            // 3. Aguardar tempo de digitação com variações humanas
            await this.humanTypingDelay(typingTime, profile);
            
            // 4. Parar "digitando..." antes de enviar
            await sock.sendPresenceUpdate('paused', groupId);
            
                    console.log(`⌨️ Simulação de digitação concluída: ${Math.round(typingTime/1000)}s para ${message.length} caracteres`);
                    
                    // 📊 Enviar update do dashboard incluindo tempo de digitação
                    const dashboardData = {
                        score: antiBanProtection.userStats[userId]?.riskScore || 0,
                        messagesSent: antiBanProtection.userStats[userId]?.messagesSent || 0,
                        groupsContacted: antiBanProtection.userStats[userId]?.groupsContacted || 0,
                        avgDelay: antiBanProtection.userStats[userId]?.avgDelay || 0,
                        personality: profile.personality,
                        riskLevel: antiBanProtection.userStats[userId]?.riskLevel || 'low',
                        sessionDuration: Date.now() - (antiBanProtection.userStats[userId]?.sessionStart || Date.now()),
                        consecutiveMessages: antiBanProtection.userStats[userId]?.consecutiveMessages || 0,
                        typingTime: Math.round(typingTime/1000),
                        lastTypingSpeed: Math.round((message.length / (typingTime/1000)) * 60) // chars/min
                    };
                    
                    io.to(`user_${userId}`).emit('risk-update', dashboardData);
            
        } catch (error) {
            console.error('❌ Erro na simulação de digitação:', error);
            // Continuar mesmo com erro para não quebrar o envio
        }
    }
    
    // ⏱️ Calcular tempo de digitação baseado na mensagem e personalidade
    calculateTypingTime(message, profile) {
        const baseTimePerChar = 50; // 50ms por caractere (digitação média)
        
        // Ajustar velocidade baseada na personalidade
        let speedMultiplier = 1;
        switch (profile.personality) {
            case 'cautious':
                speedMultiplier = 1.5; // Digita mais devagar
                break;
            case 'balanced':
                speedMultiplier = 1.2; // Digita moderadamente
                break;
            case 'active':
                speedMultiplier = 0.8; // Digita mais rápido
                break;
            case 'professional':
                speedMultiplier = 1.3; // Digita cuidadosamente
                break;
            case 'casual':
                speedMultiplier = 0.9; // Digita naturalmente
                break;
        }
        
        // Tempo base baseado no tamanho da mensagem
        const baseTime = message.length * baseTimePerChar * speedMultiplier;
        
        // Adicionar variação aleatória (±20%)
        const variation = (Math.random() - 0.5) * 0.4; // -20% a +20%
        const finalTime = baseTime * (1 + variation);
        
        // Tempo mínimo de 1 segundo e máximo de 30 segundos
        return Math.max(1000, Math.min(30000, finalTime));
    }
    
    // 🎭 Delay de digitação com variações humanas
    async humanTypingDelay(totalTime, profile) {
        const chunks = Math.floor(totalTime / 1000); // Dividir em segundos
        
        for (let i = 0; i < chunks; i++) {
            // Variação de ±200ms por segundo para simular pausas naturais
            const variation = (Math.random() - 0.5) * 400;
            const chunkTime = 1000 + variation;
            
            await new Promise(resolve => setTimeout(resolve, chunkTime));
            
            // Pausas ocasionais para simular leitura/reflexão
            if (Math.random() < 0.1 && profile.personality === 'cautious') {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Pausa de 2s
            }
        }
        
        // Tempo restante
        const remainingTime = totalTime - (chunks * 1000);
        if (remainingTime > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingTime));
        }
    }

    // 🎲 Decidir estratégia de envio
    getSendingStrategy(userId, totalGroups) {
        const profile = this.analyzeUserProfile(userId);
        
        const strategies = {
            cautious: {
                maxPerSession: Math.min(5, totalGroups),
                sessionBreak: 300000, // 5 minutos
                dailyLimit: 20
            },
            balanced: {
                maxPerSession: Math.min(10, totalGroups),
                sessionBreak: 180000, // 3 minutos
                dailyLimit: 50
            },
            active: {
                maxPerSession: Math.min(15, totalGroups),
                sessionBreak: 120000, // 2 minutos
                dailyLimit: 100
            },
            professional: {
                maxPerSession: Math.min(8, totalGroups),
                sessionBreak: 240000, // 4 minutos
                dailyLimit: 30
            },
            casual: {
                maxPerSession: Math.min(12, totalGroups),
                sessionBreak: Math.random() * 300000 + 60000, // 1-6 minutos aleatório
                dailyLimit: 40
            }
        };

        return strategies[profile.personality];
    }
}

// Inicializar IA de envio humano
const humanLikeAI = new HumanLikeAI();

// Limpeza automática de estatísticas (a cada 6 horas)
setInterval(() => {
    antiBanProtection.cleanOldStats();
}, 6 * 60 * 60 * 1000);

// 🧹 LIMPEZA AUTOMÁTICA DO COFRE (A CADA 6 HORAS)
setInterval(async () => {
    try {
        console.log('🧹 Iniciando limpeza automática do cofre...');
        await sessionVault.cleanOldSessions();
        const status = await sessionVault.getVaultStatus();
        console.log('🧹 Limpeza automática concluída:', status);
    } catch (error) {
        console.error('❌ Erro na limpeza automática do cofre:', error);
    }
}, 6 * 60 * 60 * 1000); // 6 horas

// Controle de throttling global para cofre
const vaultThrottle = new Map();

// Função para criar socket WhatsApp
async function createWhatsAppSocket(userId, sessionId = 'default') {
    const authDir = `auth_info_${userId}_${sessionId}`;
    
    // ✅ VERIFICAR SE O DIRETÓRIO DE AUTENTICAÇÃO EXISTE
    if (!fs.existsSync(authDir)) {
        console.log('⚠️ Diretório de autenticação não encontrado:', authDir);
        console.log('🔄 Criando nova sessão...');
        
        // Criar diretório se não existir
        fs.mkdirSync(authDir, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['DisparoZap', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // VERIFICAR SE JÁ ESTÁ CONECTADO - NÃO GERAR QR CODE
            const userSession = userSessions.get(userId);
            if (userSession && userSession[sessionId] && userSession[sessionId].isConnected) {
                console.log('🔍 DEBUG: WhatsApp já conectado, ignorando QR Code');
                return;
            }
            
            // Verificar se o socket já tem usuário conectado
            if (sock.user && sock.user.id) {
                console.log('🔍 DEBUG: Socket já tem usuário conectado, ignorando QR Code');
                return;
            }
            
            // PERMITIR QR Code apenas quando usuário clica em "Conectar"
            console.log('🔍 DEBUG: QR Code gerado para userId:', userId);
            
            const qrCode = await qrcode.toDataURL(qr);
            console.log('🔍 DEBUG: Enviando QR Code para sala user_' + userId);
            io.to(`user_${userId}`).emit('qr-code', qrCode);
            console.log('🔍 DEBUG: QR Code enviado com sucesso!');
            
            // Também enviar para a sala default como fallback
            if (userId !== 'default') {
                console.log('🔍 DEBUG: Enviando QR Code também para sala user_default como fallback');
                io.to('user_default').emit('qr-code', qrCode);
            }
        } else {
            console.log('🔍 DEBUG: Nenhum QR Code gerado');
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => createWhatsAppSocket(userId, sessionId), 3000);
            }
        } else if (connection === 'open') {
                // Verificar se já emitimos connection-status para esta sessão
                const userSession = userSessions.get(userId);
                const alreadyEmitted = userSession && userSession[sessionId]?.connectionStatusEmitted;
                
                if (!alreadyEmitted) {
                    console.log(`✅ WhatsApp conectado para usuário ${userId} (PRIMEIRA VEZ)`);
                } else {
                    console.log(`🔄 WhatsApp reconectado para usuário ${userId} (mantendo sessão ativa)`);
                }
                
                // Atualizar status da sessão na memória
                if (userSessions.has(userId) && userSessions.get(userId)[sessionId]) {
                    userSessions.get(userId)[sessionId].isConnected = true;
                    console.log('✅ Status da sessão atualizado na memória');
                }
                
                // Salvar sessão no banco de dados APENAS NA PRIMEIRA CONEXÃO
                if (!alreadyEmitted) {
            try {
                const userInfo = sock.user;
                        console.log('🔍 DEBUG: Informações COMPLETAS do WhatsApp:', userInfo);
                        console.log('🔍 DEBUG: userInfo.name:', userInfo?.name);
                        console.log('🔍 DEBUG: userInfo.id:', userInfo?.id);
                        console.log('🔍 DEBUG: userInfo.verifiedName:', userInfo?.verifiedName);
                        console.log('🔍 DEBUG: userInfo.notify:', userInfo?.notify);
                        
                        // Tentar pegar nome de várias fontes
                        const accountName = userInfo?.verifiedName || userInfo?.notify || userInfo?.name || 'WhatsApp User';
                const accountNumber = userInfo?.id?.split(':')[0] || '';
                const profilePicture = userInfo?.profilePicture || null;
                        
                        console.log('✅ Nome da conta salvo:', accountName);
                
                // Usar o sessionId que foi passado para a função createWhatsAppSocket
                const uniqueSessionId = sessionId || `user_${userId}_${Date.now()}`;
                console.log('🔍 DEBUG: sessionId único gerado para conexão:', uniqueSessionId);
                
                // ✅ LIMPAR SESSÕES ANTIGAS DO MESMO USUÁRIO
                try {
                    await db.execute(
                        'UPDATE whatsapp_sessions SET is_active = 0 WHERE user_id = ? AND session_id != ?',
                        [userId, uniqueSessionId]
                    );
                    console.log('🧹 Sessões antigas marcadas como inativas para usuário:', userId);
                    
                    // ✅ LIMPEZA DE ARQUIVOS SERÁ FEITA APÓS CONEXÃO BEM-SUCEDIDA
                    console.log('🧹 Limpeza de arquivos antigos será feita após conexão');
                } catch (cleanupError) {
                    console.error('❌ Erro ao limpar sessões antigas:', cleanupError);
                }
                
                // Verificar se já existe sessão
                const [existingSession] = await db.execute(
                    'SELECT id FROM whatsapp_sessions WHERE user_id = ? AND session_id = ?',
                    [userId, uniqueSessionId]
                );
                
                if (existingSession.length === 0) {
                    // Criar nova sessão
                    await db.execute(
                        'INSERT INTO whatsapp_sessions (user_id, session_id, account_name, account_number, is_active) VALUES (?, ?, ?, ?, 1)',
                        [userId, uniqueSessionId, accountName, accountNumber]
                    );
                    console.log('💾 Sessão salva no banco de dados para usuário:', userId, 'sessionId:', uniqueSessionId);
                } else {
                    // Atualizar sessão existente
                    await db.execute(
                        'UPDATE whatsapp_sessions SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND session_id = ?',
                        [userId, uniqueSessionId]
                    );
                    console.log('🔄 Sessão atualizada no banco de dados para usuário:', userId, 'sessionId:', uniqueSessionId);
                }
            } catch (error) {
                console.error('❌ Erro ao salvar sessão no banco:', error);
            }
            
                    // Enviar informações do WhatsApp quando conectar APENAS NA PRIMEIRA VEZ
            const userInfo = sock.user;
            const whatsappInfo = userInfo ? {
                name: userInfo.name || 'WhatsApp User',
                number: userInfo.id?.split(':')[0] || '',
                profilePicture: userInfo.profilePicture || null
            } : null;
            
                    console.log('📤 Emitindo connection-status ÚNICA VEZ para usuário:', userId);
            io.to(`user_${userId}`).emit('connection-status', { 
                connected: true,
                whatsappInfo: whatsappInfo
            });
                    
                    // Marcar como já emitido para evitar múltiplas emissões
                    if (userSessions.has(userId) && userSessions.get(userId)[sessionId]) {
                        userSessions.get(userId)[sessionId].connectionStatusEmitted = true;
                        console.log('✅ connection-status marcado como emitido (não será emitido novamente)');
                    }
                    
                    // ❌ LIMPEZA AUTOMÁTICA DESABILITADA - ESTAVA DELETANDO ARQUIVOS NECESSÁRIOS
                    // try {
                    //     const oldAuthDirs = fs.readdirSync('./').filter(dir => 
                    //         dir.startsWith(`auth_info_${userId}_`) && dir !== `auth_info_${userId}_${sessionId}`
                    //     );
                    //     
                    //     for (const oldDir of oldAuthDirs) {
                    //         try {
                    //             fs.rmSync(oldDir, { recursive: true, force: true });
                    //             console.log('🗑️ Arquivos antigos removidos:', oldDir);
                    //         } catch (rmError) {
                    //             console.error('❌ Erro ao remover arquivos antigos:', rmError);
                    //         }
                    //     }
                    // } catch (cleanupError) {
                    //     console.error('❌ Erro na limpeza de arquivos antigos:', cleanupError);
                    // }
                }
        }
    });

    sock.ev.on('creds.update', async () => {
        // Salvar credenciais normalmente
        saveCreds();
        
        // 🏦 SALVAR NO COFRE COM THROTTLING GLOBAL (máximo 1x por minuto por usuário)
        const throttleKey = `${userId}_${sessionId}`;
        const now = Date.now();
        const lastSave = vaultThrottle.get(throttleKey) || 0;
        
        if (now - lastSave > 60000) { // 1 minuto
            try {
                const sessionData = {
                    userId,
                    sessionId,
                    authDir,
                    timestamp: now,
                    userInfo: sock.user ? {
                        id: sock.user.id,
                        name: sock.user.name,
                        verifiedName: sock.user.verifiedName,
                        notify: sock.user.notify,
                        profilePicture: sock.user.profilePicture
                    } : null
                };
                
                await sessionVault.saveSessionToVault(userId, sessionId, sessionData);
                console.log(`🏦 Sessão salva no cofre: ${userId}_${sessionId}`);
                vaultThrottle.set(throttleKey, now);
            } catch (error) {
                console.error('❌ Erro ao salvar sessão no cofre:', error);
            }
        }
    });
    
    return sock;
}

// Socket.io events
io.on('connection', (socket) => {
    console.log(`👤 Cliente conectado: ${socket.id}`);
    console.log('🔍 DEBUG: Total de userSessions:', userSessions.size);
    console.log('🔍 DEBUG: userSessions keys:', Array.from(userSessions.keys()));
    
    // Logger global para todos os eventos
    socket.onAny((eventName, ...args) => {
        console.log(`🔍 DEBUG: Evento recebido: ${eventName}`, args);
    });
    
    socket.on('join-user', async (data = {}) => {
        const { userId } = data || {};
        socket.join(`user_${userId}`);
        console.log(`👤 Usuário ${userId} entrou na sala`);
        console.log('🔍 DEBUG: Total de userSessions após join:', userSessions.size);
        console.log('🔍 DEBUG: userSessions keys após join:', Array.from(userSessions.keys()));
    });

    socket.on('connect-whatsapp', async (data = {}) => {
        console.log('🔍 DEBUG: connect-whatsapp recebido com data:', data);
        console.log('🔍 DEBUG: Total de userSessions antes de connect:', userSessions.size);
        console.log('🔍 DEBUG: userSessions keys antes de connect:', Array.from(userSessions.keys()));
        const { userId, accountId, sessionId } = data || {};
        
        // CORREÇÃO CRÍTICA: Usar userId específico, não 'default'
        const userIdentifier = userId || accountId;
        
        // Proteção contra múltiplas conexões simultâneas
        if (userSessions.has(userIdentifier)) {
            const existingSessions = userSessions.get(userIdentifier);
            for (const [sessionKey, session] of Object.entries(existingSessions)) {
                if (session.sock && session.sock.user && session.sock.user.id && session.isConnected) {
                    console.log('✅ WhatsApp já conectado para usuário:', userIdentifier, '- ignorando nova conexão');
                    console.log('🔍 DEBUG: session.isConnected:', session.isConnected);
                    console.log('🔍 DEBUG: session.sock.user.id:', session.sock.user.id);
                    return;
                }
            }
        }
        
        // Verificar se já existe uma conexão ativa para este usuário
        if (userSessions.has(userIdentifier)) {
            const existingSessions = userSessions.get(userIdentifier);
            for (const [sessionKey, session] of Object.entries(existingSessions)) {
                if (session.sock && session.sock.user && session.sock.user.id && session.isConnected) {
                    console.log('✅ WhatsApp já conectado para usuário:', userIdentifier);
                    console.log('🔍 DEBUG: Emitindo connection-status para usuário já conectado:', userIdentifier);
                    console.log('🔍 DEBUG: session.isConnected:', session.isConnected);
                    console.log('🔍 DEBUG: session.sock.user.id:', session.sock.user.id);
                    
                    const userInfo = session.sock.user;
                    const whatsappInfo = userInfo ? {
                        name: userInfo.name || 'WhatsApp User',
                        number: userInfo.id?.split(':')[0] || '',
                        profilePicture: userInfo.profilePicture || null
                    } : null;
                    
                    socket.emit('connection-status', { 
                        connected: true,
                        whatsappInfo: whatsappInfo
                    });
                    return;
                }
            }
        }

        // Verificar se existe sessão salva no banco de dados ANTES de criar nova conexão
        try {
            const [savedSessions] = await db.execute(
                'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
                [userIdentifier]
            );
            
            if (savedSessions.length > 0) {
                const savedSession = savedSessions[0];
                console.log('💾 Sessão ativa encontrada no banco para usuário:', userIdentifier, 'sessionId:', savedSession.session_id);
                
                // Verificar se já existe uma sessão ativa na memória
                if (userSessions.has(userIdentifier) && userSessions.get(userIdentifier)[savedSession.session_id]) {
                    const existingSession = userSessions.get(userIdentifier)[savedSession.session_id];
                    
                    // Se já está conectado, retornar status
                    if (existingSession.sock && existingSession.sock.user && existingSession.sock.user.id) {
                        console.log('✅ WhatsApp já conectado com sessão salva!');
                        
                        const userInfo = existingSession.sock.user;
                        const whatsappInfo = userInfo ? {
                            name: userInfo.name || 'WhatsApp User',
                            number: userInfo.id?.split(':')[0] || '',
                            profilePicture: userInfo.profilePicture || null
                        } : null;
                        
                        socket.emit('connection-status', { 
                            connected: true,
                            whatsappInfo: whatsappInfo
                        });
                        return;
                    }
                }
                
                // PERMITIR reconexão quando usuário clica em "Conectar"
                console.log('🔄 Tentando reconectar com sessão salva...');
                
                // Apenas verificar se já existe na memória
                if (userSessions.has(userIdentifier) && userSessions.get(userIdentifier)[savedSession.session_id]) {
                    const existingSession = userSessions.get(userIdentifier)[savedSession.session_id];
                    
                    if (existingSession.sock && existingSession.sock.user && existingSession.sock.user.id) {
                        console.log('✅ WhatsApp já conectado com sessão salva!');
                        socket.emit('connection-status', { 
                            connected: true, 
                            userId: userIdentifier,
                            sessionId: savedSession.session_id,
                            message: 'WhatsApp já conectado!'
                        });
                        return;
                    }
                }
                
                // Tentar reconectar com a sessão salva
                try {
                    const sock = await createWhatsAppSocket(userIdentifier, savedSession.session_id);
                    
                    if (!userSessions.has(userIdentifier)) {
                        userSessions.set(userIdentifier, {});
                    }
                    
                    userSessions.get(userIdentifier)[savedSession.session_id] = {
                        sock,
                        isConnected: false,
                        sessionId: savedSession.session_id
                    };
                    
                    console.log('✅ Reconexão com sessão salva iniciada!');
                    
                    // Aguardar um pouco para a conexão se estabelecer
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    // Verificar se está conectado
                    if (sock.user && sock.user.id) {
                        console.log('✅ WhatsApp conectado com sessão salva!');
                        
                        const userInfo = sock.user;
                        const whatsappInfo = userInfo ? {
                            name: userInfo.name || 'WhatsApp User',
                            number: userInfo.id?.split(':')[0] || '',
                            profilePicture: userInfo.profilePicture || null
                        } : null;
                        
                        socket.emit('connection-status', { 
                            connected: true,
                            whatsappInfo: whatsappInfo
                        });
                        return;
                    } else {
                        console.log('⚠️ Reconexão falhou - sessão expirada, continuando com nova conexão...');
                    }
                } catch (reconnectError) {
                    console.error('❌ Erro ao reconectar com sessão salva:', reconnectError);
                    console.log('⚠️ Sessão salva inválida, continuando com nova conexão...');
                }
            }
        } catch (dbError) {
            console.error('❌ Erro ao verificar sessão no banco:', dbError);
        }
        
        // Gerar session_id único para cada usuário
        const uniqueSessionId = sessionId || `user_${userIdentifier}_${Date.now()}`;
        console.log('🔍 DEBUG: sessionId único gerado:', uniqueSessionId);
        if (!userIdentifier) {
            console.log('❌ ERRO: userId não fornecido - conexão negada por segurança');
            socket.emit('connection-error', { message: 'Usuário não identificado. Faça login novamente.' });
            return;
        }
        
        console.log('🔍 DEBUG: userIdentifier =', userIdentifier);
        console.log('🔍 DEBUG: Chegou na parte de criar nova conexão');
        
        try {
            // Verificar se já existe sessão salva no banco
            if (userIdentifier !== 'default') {
                const [savedSessions] = await db.execute(
                    'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1',
                    [userIdentifier]
                );
                
                if (savedSessions.length > 0) {
                    console.log('💾 Sessão salva encontrada para usuário:', userIdentifier);
                    console.log('🔄 Tentando reconectar com sessão salva...');
                    
                    // Tentar usar sessão salva
                    const savedSession = savedSessions[0];
                    const sessionId = savedSession.session_id;
                    
                    // Verificar se a sessão ainda existe na memória
                    if (userSessions.has(userIdentifier) && userSessions.get(userIdentifier)[sessionId]) {
                        console.log('✅ Sessão encontrada na memória, reconectando...');
                        const existingSession = userSessions.get(userIdentifier)[sessionId];
                        
                        // Verificar se ainda está conectado
                        if (existingSession.sock && existingSession.isConnected) {
                            console.log('✅ WhatsApp já conectado com sessão salva!');
                            
                            // Enviar informações do WhatsApp se disponíveis
                            const userInfo = existingSession.sock.user;
                            const whatsappInfo = userInfo ? {
                                name: userInfo.name || 'WhatsApp User',
                                number: userInfo.id?.split(':')[0] || '',
                                profilePicture: userInfo.profilePicture || null
                            } : null;
                            
                            console.log('🔍 DEBUG: Emitindo connection-status para usuário conectado:', userIdentifier);
                            console.log('🔍 DEBUG: Total de userSessions antes de connection-status conectado:', userSessions.size);
                            console.log('🔍 DEBUG: userSessions keys antes de connection-status conectado:', Array.from(userSessions.keys()));
                            socket.emit('connection-status', { 
                                connected: true,
                                whatsappInfo: whatsappInfo
                            });
                            return;
                        } else {
                            console.log('🔄 Sessão encontrada mas não conectada, tentando reconectar...');
                            
                            // Tentar reconectar a sessão existente
                            try {
                                const sock = await createWhatsAppSocket(userIdentifier, sessionId);
                                
                                userSessions.get(userIdentifier)[sessionId] = {
                                    sock,
                                    isConnected: false,
                                    sessionId: sessionId
                                };
                                
                                console.log('✅ Sessão reconectada com sucesso!');
                                
                                // Aguardar um pouco para a conexão estabilizar
                                setTimeout(() => {
                                    if (sock.user && sock.user.id) {
                                        console.log('✅ WhatsApp reconectado com sucesso!');
                                        
                                        const userInfo = sock.user;
                                        const whatsappInfo = {
                                            name: userInfo.name || 'WhatsApp User',
                                            number: userInfo.id?.split(':')[0] || '',
                                            profilePicture: userInfo.profilePicture || null
                                        };
                                        
                                        socket.emit('connection-status', { 
                                            connected: true,
                                            whatsappInfo: whatsappInfo
                                        });
                                    }
                                }, 3000);
                                
                                return;
                            } catch (error) {
                                console.error('❌ Erro ao reconectar sessão:', error);
                                console.log('⚠️ Falha na reconexão, continuando para gerar QR code...');
                                // Se falhar, continuar com nova conexão
                            }
                        }
                    }
                    
                    console.log('🔄 Criando nova conexão com sessão salva...');
                }
            }
            
            
            if (!userSessions.has(userIdentifier)) {
                userSessions.set(userIdentifier, {});
            }
            
            console.log('🔍 DEBUG: ANTES de createWhatsAppSocket');
            console.log('🔍 DEBUG: userIdentifier:', userIdentifier);
            console.log('🔍 DEBUG: uniqueSessionId:', uniqueSessionId);
            
                const sock = await createWhatsAppSocket(userIdentifier, uniqueSessionId);
            console.log('🔍 DEBUG: DEPOIS de createWhatsAppSocket');
            console.log('🔍 DEBUG: sock criado:', !!sock);
            
                userSessions.get(userIdentifier)[uniqueSessionId] = {
                    sock,
                    isConnected: false,
                    sessionId: uniqueSessionId
                };
            
            console.log(`📱 Conectando WhatsApp para usuário ${userIdentifier}`);
            console.log('🔍 DEBUG: Socket adicionado ao userSessions');
        } catch (error) {
            console.error('Erro ao conectar WhatsApp:', error);
            socket.emit('connection-error', { message: 'Erro ao conectar WhatsApp' });
        }
    });

    socket.on('load-groups', async (data = {}) => {
        console.log('🔍 DEBUG: load-groups recebido com data:', data);
        console.log('🔍 DEBUG: Timestamp:', new Date().toISOString());
        console.log('🔍 DEBUG: Socket ID:', socket.id);
        console.log('🔍 DEBUG: EVENTO LOAD-GROUPS PROCESSADO!');
        console.log('🔍 DEBUG: userSessions total:', userSessions.size);
        console.log('🔍 DEBUG: userSessions keys:', Array.from(userSessions.keys()));
        
        let { userId, sessionId, filters = {} } = data || {};
        console.log('🔍 DEBUG: userId recebido:', userId, 'sessionId recebido:', sessionId);
        console.log('🔍 DEBUG: filtros recebidos:', filters);
        
        // ✅ THROTTLE PARA EVITAR MÚLTIPLAS REQUISIÇÕES (5 segundos)
        const throttleKey = `load-groups-${userId}`;
        const now = Date.now();
        const throttleTime = 5000; // 5 segundos
        
        if (userSessions.has(throttleKey)) {
            const lastRequest = userSessions.get(throttleKey);
            const timeSinceLastRequest = now - lastRequest;
            
            if (timeSinceLastRequest < throttleTime) {
                const remainingTime = Math.ceil((throttleTime - timeSinceLastRequest) / 1000);
                console.log('⏱️ load-groups ignorado (throttle):', timeSinceLastRequest, 'ms desde última requisição (mínimo:', throttleTime, 'ms)');
                console.log('⏱️ Aguarde', remainingTime, 'segundos antes de tentar novamente');
                
                // ✅ ENVIAR MENSAGEM PARA O FRONTEND
                socket.emit('groups-loaded', { 
                    groups: [], 
                    message: `Aguarde ${remainingTime} segundos antes de filtrar novamente`,
                    throttle: true 
                });
                return;
            }
        }
        userSessions.set(throttleKey, now);
        
        try {
            console.log('🔍 DEBUG: Buscando userSession para userId:', userId);
            const userSession = userSessions.get(userId);
            console.log('🔍 DEBUG: userSession encontrada:', !!userSession);
            
            if (!userSession) {
                console.log('❌ userSession não encontrada para userId:', userId);
                console.log('❌ userSessions disponíveis:', Array.from(userSessions.keys()));
                
                // Tentar encontrar sessão ativa no banco de dados
                try {
                    const [activeSessions] = await db.execute(
                        'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
                        [userId]
                    );
                    
                    if (activeSessions.length > 0) {
                        const activeSession = activeSessions[0];
                        console.log('💾 Sessão ativa encontrada no banco:', activeSession.session_id);
                        
                        // Tentar reconectar com a sessão salva
                        try {
                            const sock = await createWhatsAppSocket(userId, activeSession.session_id);
                            
                            if (!userSessions.has(userId)) {
                                userSessions.set(userId, {});
                            }
                            
                            userSessions.get(userId)[activeSession.session_id] = {
                                sock,
                                isConnected: false,
                                sessionId: activeSession.session_id
                            };
                            
                            console.log('✅ Sessão reconectada com sucesso!');
                            
                            // Aguardar um pouco para a conexão se estabelecer
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            
                            // Verificar se está conectado
                            if (sock.user && sock.user.id) {
                                console.log('✅ WhatsApp conectado, carregando grupos...');
                                const groups = await sock.groupFetchAllParticipating();
                                const groupsList = Object.values(groups)
                                    .map(group => ({
                                        id: group.id,
                                        name: group.subject || 'Sem nome',
                                        description: group.desc || '',
                                        participantCount: group.participants ? Object.keys(group.participants).length : 0,
                                        isCommunity: group.endOfHistoryTransparencyDenied || false,
                                        isPrivate: group.restrict || false
                                    }))
                                    .filter(group => {
                                        // ✅ FILTRAR COMUNIDADES E CANAIS DE ANÚNCIO
                                        const isCommunity = group.isCommunity;
                                        const isAnnouncement = group.name.includes('📢') || 
                                                             group.name.includes('ANÚNCIO') || 
                                                             group.name.includes('ANUNCIO') ||
                                                             group.name.includes('AVISO');
                                        
                                        if (isCommunity) {
                                            console.log('🚫 Comunidade filtrada:', group.name);
                                            return false;
                                        }
                                        
                                        if (isAnnouncement) {
                                            console.log('🚫 Canal de anúncio filtrado:', group.name);
                                            return false;
                                        }
                                        
                                        // ✅ APLICAR FILTROS DO USUÁRIO
                                        const minParticipants = filters.minParticipants || 10;
                                        const includeKeywords = filters.includeKeywords || [];
                                        const excludeKeywords = filters.excludeKeywords || [];
                                        
                                        console.log('🔍 DEBUG FILTROS:', {
                                            minParticipants,
                                            includeKeywords,
                                            excludeKeywords,
                                            groupName: group.name,
                                            participantCount: group.participantCount
                                        });
                                        
                                        // Filtrar por número mínimo de participantes
                                        if (group.participantCount < minParticipants) {
                                            console.log('🚫 Grupo com poucos participantes filtrado:', group.name, `(${group.participantCount} membros, mínimo: ${minParticipants})`);
                                            return false;
                                        }
                                        
                                        // Filtrar por palavras-chave de inclusão
                                        if (includeKeywords.length > 0) {
                                            const groupName = group.name.toLowerCase();
                                            const hasIncludeKeyword = includeKeywords.some(keyword => 
                                                groupName.includes(keyword.toLowerCase())
                                            );
                                            
                                            if (!hasIncludeKeyword) {
                                                console.log('🚫 Grupo sem palavras-chave de inclusão filtrado:', group.name);
                                                return false;
                                            }
                                        }
                                        
                                        // Filtrar por palavras-chave de exclusão
                                        if (excludeKeywords.length > 0) {
                                            const groupName = group.name.toLowerCase();
                                            const hasExcludeKeyword = excludeKeywords.some(keyword => 
                                                groupName.includes(keyword.toLowerCase())
                                            );
                                            
                                            if (hasExcludeKeyword) {
                                                console.log('🚫 Grupo com palavras-chave de exclusão filtrado:', group.name);
                                                return false;
                                            }
                                        }
                                        
                                        return true; // Incluir grupo que passou em todos os filtros
                                    });
                                
                                console.log('📊 Grupos carregados (após filtro):', groupsList.length);
                                socket.emit('groups-loaded', { groups: groupsList });
                                return;
                            }
                        } catch (reconnectError) {
                            console.error('❌ Erro ao reconectar sessão:', reconnectError);
                        }
                    }
                } catch (dbError) {
                    console.error('❌ Erro ao buscar sessão no banco:', dbError);
                }
                
                // SEGURANÇA: Não usar sessão default para outros usuários
                console.log('❌ SEGURANÇA: Sessão não encontrada para userId:', userId);
                console.log('❌ SEGURANÇA: Negando acesso por segurança');
                socket.emit('groups-loaded', { groups: [] });
                return;
            }
            
            // Se sessionId não foi fornecido, usar a primeira sessão disponível
            if (!sessionId) {
                const availableSessions = Object.keys(userSession);
                if (availableSessions.length > 0) {
                    sessionId = availableSessions[0];
                    console.log('🔍 DEBUG: sessionId não fornecido, usando primeiro disponível:', sessionId);
                } else {
                    console.log('❌ Nenhuma sessão disponível para userId:', userId);
                    socket.emit('groups-loaded', { groups: [] });
                    return;
                }
            }
            
            console.log('🔍 DEBUG: userId =', userId, 'sessionId =', sessionId);
            console.log('🔍 DEBUG: userSession content:', Object.keys(userSession));
            
            if (!userSession[sessionId]) {
                console.log('❌ Sessão não encontrada para userId:', userId);
                console.log('❌ userSessions disponíveis:', Array.from(userSessions.keys()));
                
                // Tentar encontrar sessão ativa no banco de dados
                try {
                    const [activeSessions] = await db.execute(
                        'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
                        [userId]
                    );
                    
                    if (activeSessions.length > 0) {
                        const activeSession = activeSessions[0];
                        console.log('💾 Sessão ativa encontrada no banco:', activeSession.session_id);
                        
                        // Tentar reconectar com a sessão salva
                        try {
                            const sock = await createWhatsAppSocket(userId, activeSession.session_id);
                            
                            if (!userSessions.has(userId)) {
                                userSessions.set(userId, {});
                            }
                            
                            userSessions.get(userId)[activeSession.session_id] = {
                                sock,
                                isConnected: false,
                                sessionId: activeSession.session_id
                            };
                            
                            console.log('✅ Sessão reconectada com sucesso!');
                            
                            // Aguardar um pouco para a conexão se estabelecer
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            
                            // Verificar se está conectado
                            if (sock.user && sock.user.id) {
                                console.log('✅ WhatsApp conectado, carregando grupos...');
                                const groups = await sock.groupFetchAllParticipating();
                                const groupsList = Object.values(groups)
                                    .map(group => ({
                                        id: group.id,
                                        name: group.subject || 'Sem nome',
                                        description: group.desc || '',
                                        participantCount: group.participants ? Object.keys(group.participants).length : 0,
                                        isCommunity: group.endOfHistoryTransparencyDenied || false,
                                        isPrivate: group.restrict || false
                                    }))
                                    .filter(group => {
                                        // ✅ FILTRAR COMUNIDADES E CANAIS DE ANÚNCIO
                                        const isCommunity = group.isCommunity;
                                        const isAnnouncement = group.name.includes('📢') || 
                                                             group.name.includes('ANÚNCIO') || 
                                                             group.name.includes('ANUNCIO') ||
                                                             group.name.includes('AVISO');
                                        
                                        if (isCommunity) {
                                            console.log('🚫 Comunidade filtrada:', group.name);
                                            return false;
                                        }
                                        
                                        if (isAnnouncement) {
                                            console.log('🚫 Canal de anúncio filtrado:', group.name);
                                            return false;
                                        }
                                        
                                        // ✅ APLICAR FILTROS DO USUÁRIO
                                        const minParticipants = filters.minParticipants || 10;
                                        const includeKeywords = filters.includeKeywords || [];
                                        const excludeKeywords = filters.excludeKeywords || [];
                                        
                                        console.log('🔍 DEBUG FILTROS:', {
                                            minParticipants,
                                            includeKeywords,
                                            excludeKeywords,
                                            groupName: group.name,
                                            participantCount: group.participantCount
                                        });
                                        
                                        // Filtrar por número mínimo de participantes
                                        if (group.participantCount < minParticipants) {
                                            console.log('🚫 Grupo com poucos participantes filtrado:', group.name, `(${group.participantCount} membros, mínimo: ${minParticipants})`);
                                            return false;
                                        }
                                        
                                        // Filtrar por palavras-chave de inclusão
                                        if (includeKeywords.length > 0) {
                                            const groupName = group.name.toLowerCase();
                                            const hasIncludeKeyword = includeKeywords.some(keyword => 
                                                groupName.includes(keyword.toLowerCase())
                                            );
                                            
                                            if (!hasIncludeKeyword) {
                                                console.log('🚫 Grupo sem palavras-chave de inclusão filtrado:', group.name);
                                                return false;
                                            }
                                        }
                                        
                                        // Filtrar por palavras-chave de exclusão
                                        if (excludeKeywords.length > 0) {
                                            const groupName = group.name.toLowerCase();
                                            const hasExcludeKeyword = excludeKeywords.some(keyword => 
                                                groupName.includes(keyword.toLowerCase())
                                            );
                                            
                                            if (hasExcludeKeyword) {
                                                console.log('🚫 Grupo com palavras-chave de exclusão filtrado:', group.name);
                                                return false;
                                            }
                                        }
                                        
                                        return true; // Incluir grupo que passou em todos os filtros
                                    });
                                
                                console.log('📊 Grupos carregados (após filtro):', groupsList.length);
                                socket.emit('groups-loaded', { groups: groupsList });
                                return;
                            }
                        } catch (reconnectError) {
                            console.error('❌ Erro ao reconectar sessão:', reconnectError);
                        }
                    }
                } catch (dbError) {
                    console.error('❌ Erro ao buscar sessão no banco:', dbError);
                }
                
                // SEGURANÇA: Não usar sessão default para outros usuários
                console.log('❌ SEGURANÇA: Sessão não encontrada para userId:', userId);
                console.log('❌ SEGURANÇA: Negando acesso por segurança');
                socket.emit('groups-loaded', { groups: [] });
                return;
            }
            
            const { sock } = userSession[sessionId];
            console.log('🔍 DEBUG: sock encontrado:', !!sock);
            
            if (!sock) {
                console.log('❌ Socket WhatsApp não encontrado');
                socket.emit('groups-loaded', { groups: [] });
                return;
            }
            
                console.log('🔄 Buscando grupos do WhatsApp...');
                console.log('🔍 DEBUG: Socket WhatsApp status:', sock.user ? 'Conectado' : 'Desconectado');
                console.log('🔍 DEBUG: Socket WhatsApp user:', sock.user ? sock.user.name : 'N/A');
                console.log('🔍 DEBUG: Socket authState existe:', !!sock.authState);
                console.log('🔍 DEBUG: userSession isConnected:', userSession[sessionId].isConnected);
                
                // Verificar se a conexão está realmente ativa
                if (!sock.user || !sock.user.id) {
                    console.log('⚠️ WhatsApp não está completamente conectado, tentando verificar conexão...');
                    
                    // Tentar forçar reconexão do socket
                    try {
                        // Aguardar um pouco para o socket se estabilizar
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        
                        // Verificar novamente
                        if (!sock.user || !sock.user.id) {
                            console.log('❌ WhatsApp definitivamente não conectado após aguardar');
                    socket.emit('groups-loaded', { groups: [] });
                            socket.emit('connection-status', {
                                connected: false,
                                message: 'Conexão perdida. Clique em Conectar novamente.'
                            });
                    return;
                        }
                    } catch (waitError) {
                        console.error('❌ Erro ao aguardar reconexão:', waitError);
                        socket.emit('groups-loaded', { groups: [] });
                        return;
                    }
                }
                
                console.log('✅ Socket WhatsApp confirmado como conectado');
                console.log('🔍 DEBUG: Aguardando conexão estabilizar antes de buscar grupos...');
                
                // ✅ AGUARDAR CONEXÃO ESTABILIZAR COMPLETAMENTE (MAIS TEMPO PARA NÚMEROS INSTÁVEIS)
                console.log('🔍 DEBUG: Aguardando conexão estabilizar (10s para números instáveis)...');
                await new Promise(resolve => setTimeout(resolve, 10000));
                console.log('🔍 DEBUG: Aguardou 10s, verificando conexão novamente...');
                
                // ✅ VERIFICAR SE A CONEXÃO AINDA ESTÁ ESTÁVEL
                if (!sock.user || !sock.user.id) {
                    console.log('❌ Conexão perdida durante estabilização');
                    socket.emit('groups-loaded', { groups: [] });
                    return;
                }
                
                console.log('✅ Conexão estável confirmada após 10 segundos');
                
                // ✅ VERIFICAÇÃO ADICIONAL DE ESTABILIDADE
                console.log('🔍 DEBUG: Conexão estável, testando operações básicas...');
                
                // ✅ VERIFICAÇÃO FINAL ANTES DE BUSCAR GRUPOS
                let connectionStable = false;
                try {
                    // Testar a conexão com uma operação simples
                    const testResult = await sock.query({ json: ["query", "getStatus"] });
                    console.log('✅ Teste de conexão bem-sucedido');
                    connectionStable = true;
                } catch (testError) {
                    console.log('⚠️ Teste de conexão falhou, tentando novamente em 3s...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    try {
                        const retryTest = await sock.query({ json: ["query", "getStatus"] });
                        console.log('✅ Teste de conexão bem-sucedido na segunda tentativa');
                        connectionStable = true;
                    } catch (retryTestError) {
                        console.log('❌ Teste de conexão falhou mesmo na segunda tentativa');
                        connectionStable = false;
                    }
                }
                
                if (!connectionStable) {
                    console.log('⚠️ Conexão instável detectada, mas tentando buscar grupos mesmo assim...');
                }
                
                let groups;
                try {
                    // PRIMEIRA TENTATIVA: groupFetchAllParticipating (método normal)
                    groups = await sock.groupFetchAllParticipating();
                    console.log('✅ Grupos obtidos via groupFetchAllParticipating:', Object.keys(groups).length);
                } catch (fetchError) {
                    console.error('❌ Erro ao buscar grupos (tentativa 1):', fetchError.message);
                    
                    // ✅ VERIFICAR SE É UM ERRO RECUPERÁVEL
                    if (fetchError.message.includes('Connection Closed') || 
                        fetchError.message.includes('Timed Out') ||
                        fetchError.message.includes('Connection lost')) {
                        console.log('🔄 Erro de conexão detectado, aguardando mais tempo...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    
                    // SEGUNDA TENTATIVA: Aguardar e tentar novamente
                    try {
                        console.log('🔄 Segunda tentativa com 5s de espera...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        groups = await sock.groupFetchAllParticipating();
                        console.log('✅ Grupos obtidos na segunda tentativa:', Object.keys(groups).length);
                    } catch (retryError) {
                        console.error('❌ Erro na segunda tentativa:', retryError.message);
                        
                        // ✅ TENTAR UMA TERCEIRA TENTATIVA COM MAIS TEMPO
                        try {
                            console.log('🔄 Terceira tentativa com 10s de espera...');
                            await new Promise(resolve => setTimeout(resolve, 10000));
                            groups = await sock.groupFetchAllParticipating();
                            console.log('✅ Grupos obtidos na terceira tentativa:', Object.keys(groups).length);
                        } catch (thirdError) {
                            console.error('❌ Erro na terceira tentativa:', thirdError.message);
                            
                            // ✅ TENTAR UMA QUARTA TENTATIVA (ÚLTIMA CHANCE)
                            try {
                                console.log('🔄 Quarta tentativa (última chance) com 15s de espera...');
                                await new Promise(resolve => setTimeout(resolve, 15000));
                                groups = await sock.groupFetchAllParticipating();
                                console.log('✅ Grupos obtidos na quarta tentativa:', Object.keys(groups).length);
                            } catch (fourthError) {
                                console.error('❌ Erro na quarta tentativa:', fourthError.message);
                                
                                // ✅ APENAS AGORA MARCAR COMO CORROMPIDA SE FALHAR 4 VEZES
                                console.log('🚨 SESSÃO REALMENTE CORROMPIDA APÓS 4 TENTATIVAS! Limpando sessão...');
                                
                                // Limpar sessão corrompida da memória
                                if (userSessions.has(userId) && userSessions.get(userId)[sessionId]) {
                                    delete userSessions.get(userId)[sessionId];
                                    console.log('🗑️ Sessão corrompida removida da memória');
                                }
                                
                                // Marcar sessão como inativa no banco
                                try {
                                    await db.execute(
                                        'UPDATE whatsapp_sessions SET is_active = 0 WHERE user_id = ? AND session_id = ?',
                                        [userId, sessionId]
                                    );
                                    console.log('🗑️ Sessão marcada como inativa no banco');
                                } catch (dbError) {
                                    console.error('❌ Erro ao marcar sessão como inativa:', dbError);
                                }
                                
                                // Emitir erro específico para sessão corrompida
                                socket.emit('groups-loaded', { groups: [] });
                                socket.emit('connection-status', {
                                    connected: false,
                                    message: 'Sessão corrompida detectada. Clique em Conectar para criar nova sessão.'
                                });
                                return;
                            }
                        }
                    }
                }
                
                if (!groups || Object.keys(groups).length === 0) {
                    console.log('⚠️ Nenhum grupo retornado, mas sem erro');
                    console.log('🔍 DEBUG: groups =', groups);
                    console.log('🔍 DEBUG: Object.keys(groups) =', Object.keys(groups));
                    console.log('🔍 DEBUG: Verificando se a conexão ainda está ativa...');
                    
                    // ✅ VERIFICAR SE A CONEXÃO AINDA ESTÁ ATIVA
                    if (!sock.user || !sock.user.id) {
                        console.log('❌ Conexão perdida - sock.user não existe');
                        socket.emit('groups-loaded', { groups: [] });
                        return;
                    }
                    
                    // ✅ VERIFICAÇÃO ADICIONAL: Tentar uma operação simples para confirmar que a conexão está realmente ativa
                    try {
                        console.log('🔍 DEBUG: Testando conexão com operação simples...');
                        const testConnection = await sock.query({ json: ["query", "getStatus"] });
                        console.log('✅ Conexão confirmada como ativa');
                        
                        // ✅ TENTAR BUSCAR CONTATOS PARA VERIFICAR SE É PROBLEMA ESPECÍFICO DE GRUPOS
                        try {
                            const contacts = await sock.query({ json: ["query", "getContacts"] });
                            console.log('✅ Contatos obtidos:', contacts ? 'sim' : 'não');
                        } catch (contactError) {
                            console.log('⚠️ Erro ao buscar contatos:', contactError.message);
                        }
                        
                    } catch (connectionTestError) {
                        console.log('❌ Teste de conexão falhou:', connectionTestError.message);
                        console.log('⚠️ Possível problema de conexão, mas enviando resultado vazio mesmo assim');
                    }
                    
                    console.log('✅ Conexão ainda ativa, mas sem grupos. Isso pode ser normal para contas novas ou números sem grupos.');
                    socket.emit('groups-loaded', { groups: [] });
                    return;
                }
            console.log('📊 Grupos encontrados:', Object.keys(groups).length);
            console.log('📊 Primeiros 3 grupos:', Object.keys(groups).slice(0, 3));
            
            // Processar e filtrar grupos (excluir comunidades e anúncios)
            const allGroupsList = Object.values(groups).map(group => {
                // Verificar se é comunidade
                const isCommunity = group.id.includes('@newsletter') || // Canais de anúncio
                                   group.isParentGroup ||                // Grupo pai de comunidade
                                   group.linkedParent ||                 // Vinculado a comunidade
                                   (group.participants && Object.keys(group.participants).length === 0); // Sem participantes
                
                return {
                    id: group.id,
                    name: group.subject || 'Sem nome',
                    description: group.desc || '',
                    participantCount: group.participants ? Object.keys(group.participants).length : 0,
                    isCommunity: isCommunity,
                    isPrivate: group.restrict || false,
                    announce: group.announce || false
                };
            });
            
            console.log('📊 Total de grupos retornados pela API:', allGroupsList.length);
            console.log('📊 Primeiros 5 grupos ANTES do filtro:', allGroupsList.slice(0, 5).map(g => `${g.name} (${g.participantCount} participantes, ID: ${g.id})`));
            
            // FILTRAR: Apenas grupos normais (sem comunidades, sem canais de anúncio)
            const groupsList = allGroupsList.filter(group => {
                // Excluir se for comunidade
                if (group.isCommunity) {
                    console.log('🚫 Excluindo comunidade/canal:', group.name);
                    return false;
                }
                
                // Excluir se ID contém @newsletter (canais de anúncio)
                if (group.id.includes('@newsletter')) {
                    console.log('🚫 Excluindo canal de anúncio:', group.name);
                    return false;
                }
                
                // Incluir apenas grupos normais (@g.us)
                if (group.id.includes('@g.us')) {
                    console.log('✅ Incluindo grupo:', group.name);
                    return true;
                }
                
                console.log('🚫 Excluindo (ID desconhecido):', group.name, group.id);
                return false;
            });
            
            console.log('📊 Total ANTES do filtro:', allGroupsList.length);
            console.log('📊 Total APÓS filtro (apenas grupos):', groupsList.length);
            console.log('📊 Primeiros 5 grupos APÓS filtro:', groupsList.slice(0, 5).map(g => `${g.name} (${g.participantCount} participantes)`));
            
            // ✅ APLICAR FILTROS DO USUÁRIO SE FORNECIDOS
            let finalGroupsList = groupsList;
            if (filters && filters.minParticipants > 0) {
                console.log('🔍 APLICANDO FILTRO DE PARTICIPANTES:', filters.minParticipants);
                
                finalGroupsList = groupsList.filter(group => {
                    // Filtrar por número mínimo de participantes
                    if (group.participantCount < filters.minParticipants) {
                        console.log('🚫 Grupo com poucos participantes filtrado:', group.name, `(${group.participantCount} membros, mínimo: ${filters.minParticipants})`);
                        return false;
                    }
                    
                    return true; // Incluir grupo que passou no filtro
                });
                
                console.log('📊 Total APÓS filtro de participantes:', finalGroupsList.length);
            }
            
            // ✅ ORDENAR GRUPOS POR NÚMERO DE PARTICIPANTES (DECRESCENTE)
            const sortedGroupsList = finalGroupsList.sort((a, b) => {
                const participantsA = a.participantCount || 0;
                const participantsB = b.participantCount || 0;
                return participantsB - participantsA; // Decrescente: mais participantes primeiro
            });
            
            console.log('📊 Grupos ordenados por participantes (decrescente):', sortedGroupsList.slice(0, 5).map(g => `${g.name} (${g.participantCount} participantes)`));
            console.log('📊 Últimos 5 grupos (menos participantes):', sortedGroupsList.slice(-5).map(g => `${g.name} (${g.participantCount} participantes)`));
            console.log('🔍 DEBUG: EVENTO LOAD-GROUPS FINALIZADO COM SUCESSO!');
            socket.emit('groups-loaded', { groups: sortedGroupsList });
            } catch (error) {
                console.error('❌ Erro ao carregar grupos:', error);
                console.log('🔍 DEBUG: EVENTO LOAD-GROUPS FINALIZADO COM ERRO!');
                
                // ✅ NÃO RECONECTAR AUTOMATICAMENTE - EVITAR LOOP INFINITO
                if (error.message.includes('Connection Closed') || error.message.includes('Timed Out')) {
                    console.log('🚨 SESSÃO CORROMPIDA - NÃO RECONECTANDO AUTOMATICAMENTE');
                    console.log('🛑 Usuário deve reconectar manualmente para evitar loop');
                    
                    // Limpar sessão corrompida
                    if (userSessions.has(userId) && userSessions.get(userId)[sessionId]) {
                            delete userSessions.get(userId)[sessionId];
                        console.log('🗑️ Sessão corrompida removida da memória');
                    }
                    
                    // Marcar como inativa no banco
                    try {
                        await db.execute(
                            'UPDATE whatsapp_sessions SET is_active = 0 WHERE user_id = ? AND session_id = ?',
                            [userId, sessionId]
                        );
                        console.log('🗑️ Sessão marcada como inativa no banco');
                    } catch (dbError) {
                        console.error('❌ Erro ao marcar sessão como inativa:', dbError);
                    }
                }
                
                console.log('🔍 DEBUG: EVENTO LOAD-GROUPS FINALIZADO COM ERRO - ENVIANDO GRUPOS VAZIOS!');
                socket.emit('groups-loaded', { groups: [] });
            }
    });

    // Rota para listar sessões salvas do usuário
    socket.on('get-saved-sessions', async (data = {}) => {
        const { userId } = data || {};
        console.log('🔍 DEBUG: get-saved-sessions recebido para userId:', userId);
        console.log('🔍 DEBUG: Total de userSessions antes de get-saved-sessions:', userSessions.size);
        console.log('🔍 DEBUG: userSessions keys antes de get-saved-sessions:', Array.from(userSessions.keys()));
        try {
            const [sessions] = await db.execute(
                'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC',
                [userId]
            );
            console.log('🔍 DEBUG: Sessões encontradas no banco:', sessions.length);
            console.log('🔍 DEBUG: Sessões:', sessions);
            socket.emit('saved-sessions', sessions);
            console.log('📋 Sessões salvas enviadas para usuário:', userId);
        } catch (error) {
            console.error('❌ Erro ao buscar sessões salvas:', error);
            socket.emit('saved-sessions', []);
        }
    });

    // Rota para verificar e reconectar com sessão existente
    socket.on('check-connection', async (data = {}) => {
        const { userId, accountId } = data || {};
        const userIdentifier = accountId || userId;
        
        console.log('🔍 DEBUG: check-connection recebido para userId:', userIdentifier);
        
        // VALIDAÇÃO: userId é obrigatório
        if (!userIdentifier) {
            console.error('❌ check-connection: userId não fornecido');
            socket.emit('connection-status', {
                connected: false,
                message: 'Erro: Usuário não identificado'
            });
            return;
        }
        
        // PROTEÇÃO: Verificar se já foi emitido recentemente (throttle de 2 segundos)
        const now = Date.now();
        if (!socket.lastCheckConnection) {
            socket.lastCheckConnection = {};
        }
        
        if (socket.lastCheckConnection[userIdentifier]) {
            const timeSinceLastCheck = now - socket.lastCheckConnection[userIdentifier];
            if (timeSinceLastCheck < 2000) {
                console.log(`⏱️ check-connection ignorado (throttle): ${timeSinceLastCheck}ms desde última verificação`);
                return;
            }
        }
        
        socket.lastCheckConnection[userIdentifier] = now;
        
        try {
            // Verificar se já existe conexão ativa na memória
            if (userSessions.has(userIdentifier)) {
                const userSessionsMap = userSessions.get(userIdentifier);
                const sessionIds = Object.keys(userSessionsMap);
                
                for (const sessionId of sessionIds) {
                    const sessionData = userSessionsMap[sessionId];
                    if (sessionData.isConnected && sessionData.sock && sessionData.sock.user) {
                        console.log('✅ Sessão ativa encontrada na memória:', sessionId);
                        
                        const userInfo = sessionData.sock.user;
                        const whatsappInfo = {
                            name: userInfo.name || 'WhatsApp User',
                            number: userInfo.id?.split(':')[0] || '',
                            profilePicture: userInfo.profilePicture || null
                        };
                        
                        // ✅ EMITIR EVENTO APENAS SE NÃO FOI EMITIDO RECENTEMENTE
                        const now = Date.now();
                        if (!socket.lastConnectionStatus || (now - socket.lastConnectionStatus) > 5000) {
                            console.log('📤 Emitindo connection-status (sessão em memória)');
                            socket.emit('connection-status', {
                                connected: true,
                                whatsappInfo: whatsappInfo
                            });
                            socket.lastConnectionStatus = now;
                        } else {
                            console.log('✅ Sessão ativa encontrada na memória - evento recente ignorado');
                        }
                        return;
                    }
                }
            }
            
            // Se não há conexão na memória, verificar no banco de dados
            const [sessions] = await db.execute(
                'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
                [userIdentifier]
            );
            
            if (sessions.length > 0) {
                const savedSession = sessions[0];
                console.log('💾 Sessão encontrada no banco, tentando reconectar:', savedSession.session_id);
                
                // 🏦 TENTAR RECUPERAR DO COFRE PRIMEIRO
                console.log('🏦 Tentando recuperar sessão do cofre...');
                const vaultSession = await sessionVault.recoverSessionFromVault(userIdentifier, savedSession.session_id);
                
                if (vaultSession && vaultSession.userInfo) {
                    console.log('🏦 Sessão recuperada do cofre com sucesso!');
                    console.log('🔍 DEBUG: Dados do cofre:', {
                        userId: vaultSession.userId,
                        sessionId: vaultSession.sessionId,
                        hasUserInfo: !!vaultSession.userInfo,
                        userName: vaultSession.userInfo.name || 'N/A'
                    });
                    
                    // Usar dados do cofre para reconexão
                    const whatsappInfo = {
                        name: vaultSession.userInfo.name || vaultSession.userInfo.verifiedName || vaultSession.userInfo.notify || 'Usuário WhatsApp',
                        number: vaultSession.userInfo.id?.split(':')[0] || savedSession.account_number || '',
                        profilePicture: vaultSession.userInfo.profilePicture || null
                    };
                    
                    console.log('✅ Usando dados do cofre para reconexão:', whatsappInfo);
                    
                    // Emitir status de conexão com dados do cofre
                    socket.emit('connection-status', {
                        connected: true,
                        whatsappInfo: whatsappInfo,
                        fromVault: true
                    });
                    
                    return;
                } else {
                    console.log('⚠️ Sessão não encontrada no cofre, tentando reconexão normal...');
                }
                
                // Verificar se os arquivos de autenticação existem
                const authDir = `./auth_info_${userIdentifier}_${savedSession.session_id}`;
                console.log('🔍 DEBUG: Procurando arquivos em:', authDir);
                if (fs.existsSync(authDir)) {
                    console.log('✅ Arquivos de autenticação encontrados, reconectando...');
                    
                    // Tentar reconectar
                    try {
                        console.log('🔄 Iniciando reconexão com createWhatsAppSocket...');
                        const sock = await createWhatsAppSocket(userIdentifier, savedSession.session_id);
                        console.log('✅ createWhatsAppSocket executado com sucesso');
                        
                        if (!userSessions.has(userIdentifier)) {
                            userSessions.set(userIdentifier, {});
                        }
                        
                        userSessions.get(userIdentifier)[savedSession.session_id] = {
                            sock,
                            isConnected: false,
                            sessionId: savedSession.session_id
                        };
                        
                        console.log('🔄 Reconexão iniciada com sessão salva');
                        console.log('🔍 DEBUG: sock.user antes do timeout:', sock.user);
                        
                        // Aguardar conexão
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        
                        console.log('🔍 DEBUG: sock.user após timeout:', sock.user);
                        console.log('🔍 DEBUG: sock.user.id:', sock.user?.id);
                        
                        // Verificar se conectou
                        if (sock.user && sock.user.id) {
                            console.log('✅ Reconexão bem-sucedida!');
                            
                            // Atualizar status na memória
                            userSessions.get(userIdentifier)[savedSession.session_id].isConnected = true;
                            
                            const userInfo = sock.user;
                            const whatsappInfo = {
                                name: userInfo.name || 'WhatsApp User',
                                number: userInfo.id?.split(':')[0] || '',
                                profilePicture: userInfo.profilePicture || null
                            };
                            
                            console.log('📤 Emitindo connection-status para reconexão bem-sucedida');
                            socket.emit('connection-status', {
                                connected: true,
                                whatsappInfo: whatsappInfo
                            });
                        } else {
                            console.log('⚠️ Reconexão falhou - sessão expirada');
                            console.log('🔍 DEBUG: sock.user é:', sock.user);
                            console.log('🔍 DEBUG: sock.user.id é:', sock.user?.id);
                            
                            socket.emit('connection-status', {
                                connected: false,
                                message: 'Sessão expirada - escaneie o QR code novamente'
                            });
                        }
                    } catch (reconnectError) {
                        console.error('❌ Erro ao reconectar:', reconnectError);
                        socket.emit('connection-status', {
                            connected: false,
                            message: 'Erro ao reconectar'
                        });
                    }
                } else {
                    console.log('⚠️ Arquivos de autenticação não encontrados');
                    console.log('🔄 Tentando criar nova sessão...');
                    
                    // ✅ TENTAR CRIAR NOVA SESSÃO QUANDO ARQUIVOS NÃO EXISTEM
                    try {
                        const newSessionId = `user_${userIdentifier}_${Date.now()}`;
                        const sock = await createWhatsAppSocket(userIdentifier, newSessionId);
                        
                        if (!userSessions.has(userIdentifier)) {
                            userSessions.set(userIdentifier, {});
                        }
                        
                        userSessions.get(userIdentifier)[newSessionId] = {
                            sock,
                            isConnected: false,
                            sessionId: newSessionId
                        };
                        
                        console.log('✅ Nova sessão criada com sucesso!');
                        console.log('📱 Aguarde o QR Code para conectar...');
                        
                        // Não emitir connection-status aqui, aguardar o QR code
                        return;
                        
                    } catch (newSessionError) {
                        console.error('❌ Erro ao criar nova sessão:', newSessionError);
                        socket.emit('connection-status', {
                            connected: false,
                            message: 'Erro ao criar nova sessão'
                        });
                    }
                }
            } else {
                console.log('ℹ️ Nenhuma sessão encontrada no banco');
                socket.emit('connection-status', {
                    connected: false,
                    message: 'Não conectado ao WhatsApp'
                });
            }
        } catch (error) {
            console.error('❌ Erro ao verificar conexão:', error);
            socket.emit('connection-status', {
                connected: false,
                message: 'Erro ao verificar conexão'
            });
        }
    });

    // Rota para desconectar WhatsApp e deletar sessão
    socket.on('disconnect-whatsapp', async (data = {}) => {
        const { userId, accountId } = data || {};
        console.log('🔴 DEBUG: disconnect-whatsapp recebido para userId:', userId, 'accountId:', accountId);
        
        try {
            const userIdentifier = accountId || userId;
            
            if (!userIdentifier) {
                console.error('❌ Erro: userId ou accountId não fornecido');
                socket.emit('disconnect-status', { success: false, error: 'Usuário não identificado' });
                return;
            }
            
            console.log('🔍 Procurando sessão para desconectar - userIdentifier:', userIdentifier);
            
            // Buscar sessão ativa no banco de dados
            const [sessions] = await db.execute(
                'SELECT * FROM whatsapp_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
                [userIdentifier]
            );
            
            if (sessions.length === 0) {
                console.log('⚠️ Nenhuma sessão ativa encontrada no banco para desconectar');
                socket.emit('disconnect-status', { success: false, error: 'Nenhuma sessão ativa encontrada' });
                return;
            }
            
            const sessionToDelete = sessions[0];
            const sessionId = sessionToDelete.session_id;
            console.log('📋 Sessão encontrada para desconectar:', sessionId);
            
            // 1. Fechar socket do WhatsApp se existir na memória
            if (userSessions.has(userIdentifier) && userSessions.get(userIdentifier)[sessionId]) {
                const sessionData = userSessions.get(userIdentifier)[sessionId];
                
                if (sessionData.sock) {
                    try {
                        await sessionData.sock.logout();
                        console.log('✅ Socket do WhatsApp desconectado (logout)');
                    } catch (logoutError) {
                        console.log('⚠️ Erro ao fazer logout:', logoutError.message);
                        // Continuar mesmo com erro de logout
                    }
                    
                    try {
                        sessionData.sock.end();
                        console.log('✅ Socket do WhatsApp fechado (end)');
                    } catch (endError) {
                        console.log('⚠️ Erro ao fechar socket:', endError.message);
                    }
                }
                
                // Remover da memória
                delete userSessions.get(userIdentifier)[sessionId];
                console.log('🗑️ Sessão removida da memória');
                
                // Se não houver mais sessões para este usuário, remover o Map inteiro
                if (Object.keys(userSessions.get(userIdentifier)).length === 0) {
                    userSessions.delete(userIdentifier);
                    console.log('🗑️ Map do usuário removido (sem mais sessões)');
                }
            }
            
            // 2. Deletar sessão do banco de dados
            await db.execute(
                'DELETE FROM whatsapp_sessions WHERE id = ?',
                [sessionToDelete.id]
            );
            console.log('✅ Sessão deletada do banco de dados - ID:', sessionToDelete.id);
            
            // 3. Remover arquivos de autenticação (auth_info_*)
            const authDir = `./auth_info_${sessionId}`;
            try {
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                    console.log('🗑️ Pasta de autenticação removida:', authDir);
                } else {
                    console.log('⚠️ Pasta de autenticação não encontrada:', authDir);
                }
            } catch (fsError) {
                console.error('❌ Erro ao remover pasta de autenticação:', fsError);
            }
            
            // 4. Notificar o frontend
            socket.emit('disconnect-status', { 
                success: true, 
                message: 'WhatsApp desconectado com sucesso!' 
            });
            
            // 5. Atualizar status de conexão
            socket.emit('connection-status', { 
                connected: false,
                whatsappInfo: null
            });
            
            console.log('✅ WhatsApp desconectado com sucesso para usuário:', userIdentifier);
            
        } catch (error) {
            console.error('❌ Erro ao desconectar WhatsApp:', error);
            socket.emit('disconnect-status', { 
                success: false, 
                error: error.message || 'Erro ao desconectar' 
            });
        }
    });

    // Evento para enviar mensagens
        socket.on('send-messages', async (data = {}) => {
            console.log('🔍 DEBUG: send-messages recebido com data:', data);
            let { groups, message, userId, sessionId, delay = 2000, minDelay = 1000, maxDelay = 5000, humanMode = true } = data || {};
            
            // 🛡️ VERIFICAR PROTEÇÃO CONTRA BANIMENTO
            const protectionCheck = antiBanProtection.canSendMessage(userId, groups[0]?.id);
            if (!protectionCheck.allowed) {
                console.log(`🛡️ Envio bloqueado por proteção: ${protectionCheck.reason}`);
                socket.emit('send-error', { 
                    message: protectionCheck.reason,
                    waitTime: protectionCheck.waitTime
                });
                return;
            }
            
            // ✅ VERIFICAR SE JÁ EXISTE ENVIO ATIVO
            if (userSessions[userId] && userSessions[userId].isSending) {
                console.log('⚠️ Já existe um envio ativo para este usuário');
                socket.emit('send-error', { message: 'Já existe um envio em andamento' });
                return;
            }
            
            // ✅ MARCAR ENVIO COMO ATIVO
            if (!userSessions[userId]) {
                userSessions[userId] = {};
            }
            userSessions[userId].isSending = true;
            userSessions[userId].isPaused = false;
            userSessions[userId].isCancelled = false;
            
            // ✅ SALVAR HISTÓRICO DE ENVIO NO BANCO
            try {
                const [result] = await db.execute(
                    `INSERT INTO sending_history 
                     (user_id, session_id, message_text, total_groups, current_group, status, speed_mode, delay_config, groups_list) 
                     VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
                    [
                        userId,
                        sessionId || `user_${userId}_${Date.now()}`,
                        message,
                        groups.length,
                        0,
                        humanMode ? 'human' : 'fast',
                        JSON.stringify({ delay, minDelay, maxDelay, humanMode }),
                        JSON.stringify(groups.map(g => ({ id: g.id, name: g.name || g })))
                    ]
                );
                
                userSessions[userId].sendingHistoryId = result.insertId;
                console.log('📝 Histórico de envio salvo no banco:', result.insertId);
            } catch (dbError) {
                console.error('❌ Erro ao salvar histórico:', dbError);
            }
            
            console.log('⏱️ DEBUG: Configurações de delay recebidas:', {
                delay: delay,
                minDelay: minDelay,
                maxDelay: maxDelay,
                humanMode: humanMode
            });
            console.log('🔍 DEBUG: userId recebido:', userId, 'sessionId recebido:', sessionId);
        
        try {
            // Verificar se WhatsApp está conectado
            const userSession = userSessions.get(userId);
            if (!userSession) {
                console.log('❌ userSession não encontrada para envio - userId:', userId);
                console.log('❌ userSessions disponíveis:', Array.from(userSessions.keys()));
                socket.emit('send-error', { message: 'WhatsApp não conectado' });
                return;
            }
            
            // Se sessionId não foi fornecido, usar primeira sessão disponível
            if (!sessionId) {
                const availableSessions = Object.keys(userSession);
                if (availableSessions.length > 0) {
                    sessionId = availableSessions[0];
                    console.log('🔍 DEBUG: sessionId não fornecido, usando primeiro disponível:', sessionId);
                } else {
                    console.log('❌ Nenhuma sessão disponível para envio');
                    socket.emit('send-error', { message: 'Nenhuma sessão WhatsApp disponível' });
                    return;
                }
            }
            
            console.log('🔍 DEBUG: Usando sessionId:', sessionId);
            
            if (!userSession[sessionId]) {
                console.log('❌ Sessão específica não encontrada:', sessionId);
                console.log('❌ Sessões disponíveis:', Object.keys(userSession));
                socket.emit('send-error', { message: 'Sessão WhatsApp não encontrada' });
                return;
            }
            
            const { sock } = userSession[sessionId];
            if (!sock) {
                console.log('❌ Socket WhatsApp não encontrado para envio');
                socket.emit('send-error', { message: 'WhatsApp não conectado' });
                return;
            }
            
            console.log('📤 Iniciando envio para', groups.length, 'grupos');
            console.log('📝 Mensagem:', message);
            
            // Contadores para estatísticas
            let successCount = 0;
            let errorCount = 0;
            
            // 🚀 ENVIAR DADOS INICIAIS IMEDIATAMENTE
            const userProfile = humanLikeAI.analyzeUserProfile(userId);
            io.to(`user_${userId}`).emit('send-progress', { 
                current: 0, 
                total: groups.length, 
                group: 'Preparando envio...',
                status: 'preparing',
                delay: 0,
                personality: userProfile.personality,
                riskScore: antiBanProtection.userStats.get(userId)?.riskScore || 0,
                successCount: 0,
                errorCount: 0
            });
            
            // Processar cada grupo
            for (let i = 0; i < groups.length; i++) {
                // ✅ VERIFICAR SE FOI CANCELADO
                if (userSessions[userId] && userSessions[userId].isCancelled) {
                    console.log('Envio cancelado pelo usuário');
                    io.to(`user_${userId}`).emit('send-cancelled', {
                        success: true,
                        message: 'Envio cancelado com sucesso'
                    });
                    return;
                }
                
                // ✅ VERIFICAR SE ESTÁ PAUSADO
                while (userSessions[userId] && userSessions[userId].isPaused) {
                    console.log('Envio pausado, aguardando...');
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Aguardar 1 segundo
                }
                
                // ✅ VERIFICAR NOVAMENTE SE FOI CANCELADO APÓS PAUSA
                if (userSessions[userId] && userSessions[userId].isCancelled) {
                    console.log('Envio cancelado após pausa');
                    io.to(`user_${userId}`).emit('send-cancelled', {
                        success: true,
                        message: 'Envio cancelado com sucesso'
                    });
                    return;
                }
                
                const group = groups[i];
                console.log(`📤 Enviando para grupo ${i + 1}/${groups.length}: ${group.name || group}`);
                
                // 🤖 IA: Calcular delay inteligente (sempre calcular, mas só aplicar entre mensagens)
                const messageLength = message.length;
                const intelligentDelay = humanLikeAI.calculateIntelligentDelay(userId, messageLength, group.id);
                let actualDelay = intelligentDelay;
                
                try {
                    // ✅ VERIFICAR NOVAMENTE ANTES DO ENVIO
                    if (userSessions[userId] && userSessions[userId].isCancelled) {
                        console.log('Envio cancelado antes do envio');
                        return;
                    }
                    
                    // ENVIO REAL PARA O WHATSAPP
                    console.log(`📤 Enviando mensagem real para: ${group.name || group}`);
                    
                    // 🤖 IA: Verificar se deve enviar agora
                    if (!humanLikeAI.shouldSendNow(userId)) {
                        console.log(`🤖 IA: Pausa inteligente ativada para usuário ${userId}`);
                        await new Promise(resolve => setTimeout(resolve, 30000)); // 30s de pausa
                    }
                    
                    // Processar variáveis na mensagem ({nome}, {hora}, {data}, etc)
                    let processedMessage = processMessageVariables(message, group.name || group);
                    
                    // 🤖 IA: Humanizar mensagem
                    const userProfile = humanLikeAI.analyzeUserProfile(userId);
                    processedMessage = humanLikeAI.humanizeMessage(processedMessage, userProfile);
                    
                    console.log(`🔄 Mensagem processada com IA:`, processedMessage.substring(0, 100) + '...');
                    
                    // ⌨️ SIMULAR DIGITAÇÃO HUMANA ANTES DE ENVIAR
                    console.log(`⌨️ Iniciando simulação de digitação para: ${group.name || group}`);
                    await humanLikeAI.simulateTyping(sock, group.id, processedMessage, userId);
                    
                    // Enviar mensagem para o grupo via WhatsApp
                    await sock.sendMessage(group.id, { 
                        text: processedMessage 
                    });
                    
                    // 🛡️ REGISTRAR ATIVIDADE PARA PROTEÇÃO
                    antiBanProtection.recordUserActivity(userId, 'message_sent', { groupId: group.id });
                    antiBanProtection.recordUserActivity(userId, 'group_contacted', { groupId: group.id });
                    
                    // 🔍 ANALISAR PADRÃO DE ENVIO
                    patternAnalyzer.analyzeSendingPattern(userId, {
                        content: processedMessage,
                        groupId: group.id,
                        delay: actualDelay || 0
                    });
                    
                    console.log(`✅ Mensagem enviada com sucesso para: ${group.name || group}`);
                    
                    // ✅ VERIFICAR APÓS O ENVIO
                    if (userSessions[userId] && userSessions[userId].isCancelled) {
                        console.log('Envio cancelado após envio');
                        return;
                    }
                    
                    // ✅ ATUALIZAR PROGRESSO NO BANCO
                    if (userSessions[userId] && userSessions[userId].sendingHistoryId) {
                        try {
                            await db.execute(
                                'UPDATE sending_history SET current_group = ? WHERE id = ?',
                                [i + 1, userSessions[userId].sendingHistoryId]
                            );
                        } catch (dbError) {
                            console.error('❌ Erro ao atualizar progresso:', dbError);
                        }
                    }
                    
                    // Emitir para TODOS os sockets do usuário (não apenas o socket atual)
                    // Isso garante que o progresso seja recebido mesmo se o socket reconectar
                    // Incrementar contador de sucesso
                    successCount++;
                    
                    io.to(`user_${userId}`).emit('send-progress', { 
                        current: i + 1, 
                        total: groups.length, 
                        group: group.name || group,
                        status: 'success',
                        delay: actualDelay,
                        personality: userProfile.personality,
                        riskScore: antiBanProtection.userStats.get(userId)?.riskScore || 0,
                        successCount: successCount,
                        errorCount: errorCount
                    });
                    
                    // ✅ Delay já calculado no início do loop
                    
                    // ✅ APLICAR DELAY APENAS ENTRE MENSAGENS (NÃO APÓS A PRIMEIRA)
                    if (i < groups.length - 1) {
                    
                    if (humanMode) {
                        // Usar delay da IA (já é inteligente)
                        const minutes = Math.floor(actualDelay / 60000);
                        const seconds = Math.floor((actualDelay % 60000) / 1000);
                        console.log(`🤖 IA: Aguardando ${minutes}min ${seconds}s (delay inteligente)...`);
                    } else {
                        // Modo rápido: usar delay menor mas ainda inteligente
                        actualDelay = Math.min(actualDelay * 0.3, 5000); // 30% do delay IA, máximo 5s
                        const seconds = Math.floor(actualDelay / 1000);
                        console.log(`⚡ Modo rápido: Aguardando ${seconds}s...`);
                    }
                        
                        // ✅ DELAY INTERROMPÍVEL
                        const delayStart = Date.now();
                        while (Date.now() - delayStart < actualDelay) {
                            // Verificar cancelamento a cada 100ms
                            if (userSessions[userId] && userSessions[userId].isCancelled) {
                                console.log('Envio cancelado durante delay');
                                return;
                            }
                            
                            // Verificar pausa durante delay
                            while (userSessions[userId] && userSessions[userId].isPaused) {
                                console.log('Envio pausado durante delay');
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }
                    
                } catch (error) {
                    console.error(`❌ Erro ao enviar para ${group.name || group}:`, error);
                    
                    // 🚨 DETECTAR E REGISTRAR BLOQUEIO
                    const blockType = blockDetector.detectBlockType(error);
                    if (blockType !== 'unknown') {
                        blockDetector.recordBlock(userId, blockType, error);
                    }
                    
                    // ✅ TRATAMENTO ESPECÍFICO PARA ERRO "FORBIDDEN"
                    let errorMessage = error.message || 'Erro desconhecido';
                    if (error.message && error.message.includes('forbidden')) {
                        errorMessage = 'Grupo não permite envio de mensagens (forbidden)';
                        console.log('⚠️ Grupo bloqueado pelo WhatsApp:', group.name || group);
                    } else if (error.message && error.message.includes('not-authorized')) {
                        errorMessage = 'Não autorizado a enviar para este grupo';
                        console.log('⚠️ Grupo não autorizado:', group.name || group);
                    } else if (error.message && error.message.includes('Connection Closed')) {
                        errorMessage = 'Conexão perdida - Bloqueio detectado';
                        console.log('🚨 Bloqueio de conexão detectado para:', group.name || group);
                    }
                    
                    // Incrementar contador de erro
                    errorCount++;
                    
                    // Emitir erro para todos os sockets do usuário
                    io.to(`user_${userId}`).emit('send-progress', { 
                        current: i + 1, 
                        total: groups.length, 
                        group: group.name || group,
                        status: 'error',
                        error: errorMessage,
                        delay: actualDelay || 0,
                        personality: userProfile.personality,
                        riskScore: antiBanProtection.userStats.get(userId)?.riskScore || 0,
                        successCount: successCount,
                        errorCount: errorCount
                    });
                    
                    // ✅ CONTINUAR ENVIO MESMO COM ERRO
                    console.log('Continuando para próximo grupo...');
                }
            }
            
            console.log('✅ Envio concluído para todos os grupos');
            
            // ✅ RESETAR ESTADO DE ENVIO
            if (userSessions[userId]) {
                userSessions[userId].isSending = false;
                userSessions[userId].isPaused = false;
                userSessions[userId].isCancelled = false;
            }
            
            // Emitir conclusão para todos os sockets do usuário
            io.to(`user_${userId}`).emit('send-complete', { 
                total: groups.length,
                success: successCount,
                errors: errorCount,
                successRate: Math.round((successCount / groups.length) * 100),
                message: `Envio concluído! ${successCount} sucessos, ${errorCount} erros`
            });
            
        } catch (error) {
            console.error('❌ Erro no envio de mensagens:', error);
            
            // ✅ RESETAR ESTADO EM CASO DE ERRO
            if (userSessions[userId]) {
                userSessions[userId].isSending = false;
                userSessions[userId].isPaused = false;
                userSessions[userId].isCancelled = false;
            }
            
            // Emitir erro para todos os sockets do usuário
            io.to(`user_${userId}`).emit('send-error', { message: 'Erro interno do servidor' });
        }
    });

    // ✅ EVENTOS DE PAUSAR/CANCELAR/RETOMAR ENVIO
    socket.on('pause-sending', (data) => {
        console.log('Pausar envio solicitado:', data);
        const { userId } = data;
        
        // Marcar envio como pausado na memória
        if (userSessions[userId]) {
            userSessions[userId].isPaused = true;
            console.log('Envio pausado para usuário:', userId);
            
            // ✅ ATUALIZAR STATUS NO BANCO
            if (userSessions[userId].sendingHistoryId) {
                db.execute(
                    'UPDATE sending_history SET status = ? WHERE id = ?',
                    ['paused', userSessions[userId].sendingHistoryId]
                ).catch(err => console.error('❌ Erro ao atualizar status pausado:', err));
            }
            
            // Notificar frontend
            io.to(`user_${userId}`).emit('send-paused', {
                success: true,
                message: 'Envio pausado com sucesso'
            });
        } else {
            console.log('Usuário não encontrado para pausar envio:', userId);
        }
    });

    socket.on('cancel-sending', (data) => {
        console.log('Cancelar envio solicitado:', data);
        const { userId } = data;
        
        // Marcar envio como cancelado na memória
        if (userSessions[userId]) {
            userSessions[userId].isCancelled = true;
            userSessions[userId].isPaused = false;
            userSessions[userId].isSending = false; // ✅ RESETAR ENVIO
            console.log('Envio cancelado para usuário:', userId);
            
            // Notificar frontend
            io.to(`user_${userId}`).emit('send-cancelled', {
                success: true,
                message: 'Envio cancelado com sucesso'
            });
        } else {
            console.log('Usuário não encontrado para cancelar envio:', userId);
        }
    });

    socket.on('resume-sending', (data) => {
        console.log('Retomar envio solicitado:', data);
        const { userId } = data;
        
        // Marcar envio como retomado na memória
        if (userSessions[userId]) {
            userSessions[userId].isPaused = false;
            userSessions[userId].isCancelled = false;
            console.log('Envio retomado para usuário:', userId);
            
            // Notificar frontend
            io.to(`user_${userId}`).emit('send-resumed', {
                success: true,
                message: 'Envio retomado com sucesso'
            });
        } else {
            console.log('Usuário não encontrado para retomar envio:', userId);
        }
    });

    // ============================================
    // 🔄 VERIFICAR STATUS DO ENVIO
    // ============================================
    
    socket.on('check-sending-status', async (data) => {
        const { userId } = data;
        console.log('🔍 Verificando status do envio para usuário:', userId);
        
        try {
            // Verificar se há envio em andamento na memória
            const userSession = userSessions[userId];
            if (userSession && userSession.isSending) {
                console.log('📊 Envio em andamento na memória:', {
                    isSending: userSession.isSending,
                    isPaused: userSession.isPaused,
                    isCancelled: userSession.isCancelled
                });
                
                // Enviar status atual
                io.to(`user_${userId}`).emit('sending-status', {
                    isSending: userSession.isSending,
                    isPaused: userSession.isPaused,
                    isCancelled: userSession.isCancelled,
                    current: userSession.currentGroup || 0,
                    total: userSession.totalGroups || 0
                });
            } else {
                // Verificar no banco de dados
                const [sendingHistory] = await db.execute(
                    'SELECT * FROM sending_history WHERE user_id = ? AND status IN ("sending", "paused") ORDER BY created_at DESC LIMIT 1',
                    [userId]
                );
                
                if (sendingHistory.length > 0) {
                    const history = sendingHistory[0];
                    console.log('📊 Envio encontrado no banco:', {
                        id: history.id,
                        status: history.status,
                        current: history.current_group,
                        total: history.total_groups
                    });
                    
                    // Enviar status do banco
                    io.to(`user_${userId}`).emit('sending-status', {
                        isSending: history.status === 'sending',
                        isPaused: history.status === 'paused',
                        isCancelled: false,
                        current: history.current_group,
                        total: history.total_groups
                    });
                } else {
                    console.log('📊 Nenhum envio em andamento encontrado');
                    io.to(`user_${userId}`).emit('sending-status', {
                        isSending: false,
                        isPaused: false,
                        isCancelled: false,
                        current: 0,
                        total: 0
                    });
                }
            }
        } catch (error) {
            console.error('❌ Erro ao verificar status do envio:', error);
            io.to(`user_${userId}`).emit('sending-status', {
                isSending: false,
                isPaused: false,
                isCancelled: false,
                current: 0,
                total: 0
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`👤 Cliente desconectado: ${socket.id}`);
    });
});

// Rotas
app.get('/', (req, res) => {
    res.redirect('/home/');
});

app.get('/home/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home', 'index.html'));
});

// ==================== API: Histórico de Envios ====================
// Buscar histórico de envios do usuário
app.get('/api/sending-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Buscar histórico de envios
        const [history] = await db.query(
            `SELECT id, message_text, total_groups, current_group, status, speed_mode, 
                    created_at, updated_at, completed_at
             FROM sending_history 
             WHERE user_id = ? 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [userId]
        );
        
        res.json({ 
            success: true, 
            history: history 
        });
    } catch (error) {
        console.error('❌ Erro ao buscar histórico:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== API: Buscar Info da Conta WhatsApp ====================
// Buscar informações da última sessão WhatsApp ativa do usuário
app.get('/api/whatsapp-info/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Buscar última sessão ativa do banco
        const [sessions] = await db.query(
            `SELECT account_name, account_number, profile_picture 
             FROM whatsapp_sessions 
             WHERE user_id = ? AND is_active = 1
             ORDER BY updated_at DESC
             LIMIT 1`,
            [userId]
        );
        
        if (sessions.length > 0) {
            const session = sessions[0];
            res.json({ 
                success: true, 
                whatsappInfo: {
                    name: session.account_name || 'Usuário WhatsApp',
                    number: session.account_number || '',
                    profilePicture: session.profile_picture || null
                }
            });
        } else {
            res.json({ 
                success: false, 
                message: 'Nenhuma sessão WhatsApp encontrada' 
            });
        }
    } catch (error) {
        console.error('❌ Erro ao buscar info WhatsApp:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== API: Buscar Info da Conta WhatsApp ====================
// Buscar informações da última sessão WhatsApp ativa do usuário
app.get('/api/whatsapp-info/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Buscar última sessão ativa do banco
        const [sessions] = await db.query(
            `SELECT account_name, account_number, profile_picture 
             FROM whatsapp_sessions 
             WHERE user_id = ? AND is_active = 1
             ORDER BY updated_at DESC
             LIMIT 1`,
            [userId]
        );
        
        if (sessions.length > 0) {
            const session = sessions[0];
            res.json({ 
                success: true, 
                whatsappInfo: {
                    name: session.account_name || 'Usuário WhatsApp',
                    number: session.account_number || '',
                    profilePicture: session.profile_picture || null
                }
            });
        } else {
            res.json({ 
                success: false, 
                message: 'Nenhuma sessão WhatsApp encontrada' 
            });
        }
    } catch (error) {
        console.error('❌ Erro ao buscar info WhatsApp:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== APIs de Mensagens Salvas ====================

// Listar mensagens salvas do usuário
app.get('/api/messages/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const [messages] = await db.query(
            `SELECT id, message_title, message_text, use_variables, is_favorite, 
                    use_count, last_used, created_at
             FROM user_messages 
             WHERE user_id = ? 
             ORDER BY is_favorite DESC, last_used DESC, created_at DESC`,
            [userId]
        );
        
        res.json({ success: true, messages });
    } catch (error) {
        console.error('❌ Erro ao listar mensagens:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Salvar nova mensagem
app.post('/api/messages', async (req, res) => {
    try {
        const { userId, messageTitle, messageText, useVariables, isFavorite } = req.body;
        
        if (!userId || !messageTitle || !messageText) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId, messageTitle e messageText são obrigatórios' 
            });
        }
        
        const [result] = await db.query(
            `INSERT INTO user_messages (user_id, message_title, message_text, use_variables, is_favorite)
             VALUES (?, ?, ?, ?, ?)`,
            [userId, messageTitle, messageText, useVariables || true, isFavorite || false]
        );
        
        res.json({ 
            success: true, 
            messageId: result.insertId,
            message: 'Mensagem salva com sucesso!' 
        });
    } catch (error) {
        console.error('❌ Erro ao salvar mensagem:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Atualizar mensagem existente
app.put('/api/messages/:messageId', async (req, res) => {
    try {
        const { messageId } = req.params;
        const { messageTitle, messageText, useVariables, isFavorite } = req.body;
        
        const [result] = await db.query(
            `UPDATE user_messages 
             SET message_title = ?, message_text = ?, use_variables = ?, is_favorite = ?
             WHERE id = ?`,
            [messageTitle, messageText, useVariables, isFavorite, messageId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Mensagem não encontrada' });
        }
        
        res.json({ success: true, message: 'Mensagem atualizada!' });
    } catch (error) {
        console.error('❌ Erro ao atualizar mensagem:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Deletar mensagem
app.delete('/api/messages/:messageId', async (req, res) => {
    try {
        const { messageId } = req.params;
        
        const [result] = await db.query(
            'DELETE FROM user_messages WHERE id = ?',
            [messageId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Mensagem não encontrada' });
        }
        
        res.json({ success: true, message: 'Mensagem deletada!' });
    } catch (error) {
        console.error('❌ Erro ao deletar mensagem:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Marcar mensagem como usada (atualizar contador e data)
app.post('/api/messages/:messageId/use', async (req, res) => {
    try {
        const { messageId } = req.params;
        
        await db.query(
            `UPDATE user_messages 
             SET use_count = use_count + 1, last_used = NOW()
             WHERE id = ?`,
            [messageId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Erro ao marcar mensagem como usada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Processar variáveis na mensagem
function processMessageVariables(messageText, groupName) {
    const now = new Date();
    const emojis = ['😊', '👋', '🎉', '✨', '💫', '🌟', '💪', '🚀', '🔥', '⭐'];
    const greetings = ['Olá', 'Oi', 'E aí', 'Salve', 'Fala'];
    
    return messageText
        .replace(/{nome}/g, groupName || 'pessoal')
        .replace(/{hora}/g, now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
        .replace(/{data}/g, now.toLocaleDateString('pt-BR'))
        .replace(/{random_emoji}/g, emojis[Math.floor(Math.random() * emojis.length)])
        .replace(/{random_greeting}/g, greetings[Math.floor(Math.random() * greetings.length)]);
}

// ============================================
// 🧹 SISTEMA DE LIMPEZA AUTOMÁTICA (TEMPORARIAMENTE DESABILITADO)
// ============================================
// const sessionCleanup = new SessionCleanup();
// sessionCleanup.init().catch(console.error);

// ============================================
// 🧹 ENDPOINT PARA LIMPEZA MANUAL (TEMPORARIAMENTE DESABILITADO)
// ============================================
// app.post('/api/cleanup-sessions', authenticateToken, async (req, res) => {
//     try {
//         console.log('🧹 Limpeza manual solicitada por:', req.user.id);
//         await sessionCleanup.forceCleanup();
//         res.json({ success: true, message: 'Limpeza manual concluída' });
//     } catch (error) {
//         console.error('❌ Erro na limpeza manual:', error);
//         res.status(500).json({ success: false, message: 'Erro na limpeza manual' });
//     }
// });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor com banco de dados rodando em http://localhost:${PORT}`);
    console.log(`📱 Sistema de autenticação ativo!`);
    console.log(`🧹 Sistema de limpeza automática ativo!`);
    console.log(`🌐 Pronto para deploy online!`);
    console.log('🔍 DEBUG: Servidor server-with-database.js iniciado!');
});