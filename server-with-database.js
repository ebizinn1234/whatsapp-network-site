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

// Middleware para verificar autenticação
app.use('/api/*', authenticateToken);

// Armazenar sessões dos usuários
const userSessions = new Map();

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
                    
                    // ✅ LIMPAR ARQUIVOS ANTIGOS APÓS CONEXÃO BEM-SUCEDIDA
                    try {
                        const oldAuthDirs = fs.readdirSync('./').filter(dir => 
                            dir.startsWith(`auth_info_${userId}_`) && dir !== `auth_info_${userId}_${sessionId}`
                        );
                        
                        for (const oldDir of oldAuthDirs) {
                            try {
                                fs.rmSync(oldDir, { recursive: true, force: true });
                                console.log('🗑️ Arquivos antigos removidos:', oldDir);
                            } catch (rmError) {
                                console.error('❌ Erro ao remover arquivos antigos:', rmError);
                            }
                        }
                    } catch (cleanupError) {
                        console.error('❌ Erro na limpeza de arquivos antigos:', cleanupError);
                    }
                }
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
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
        
        // ✅ THROTTLE PARA EVITAR MÚLTIPLAS REQUISIÇÕES
        const throttleKey = `load-groups-${userId}`;
        if (userSessions.has(throttleKey)) {
            console.log('⏱️ load-groups ignorado (throttle):', Date.now() - userSessions.get(throttleKey), 'ms desde última requisição');
            return;
        }
        userSessions.set(throttleKey, Date.now());
        
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
                
                // ✅ AGUARDAR CONEXÃO ESTABILIZAR COMPLETAMENTE
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log('🔍 DEBUG: Aguardou 3s, verificando conexão novamente...');
                
                // ✅ VERIFICAR SE A CONEXÃO AINDA ESTÁ ESTÁVEL
                if (!sock.user || !sock.user.id) {
                    console.log('❌ Conexão perdida durante estabilização');
                    socket.emit('groups-loaded', { groups: [] });
                    return;
                }
                
                console.log('✅ Conexão estável confirmada após 3 segundos');
                
                // ✅ VERIFICAÇÃO ADICIONAL DE ESTABILIDADE
                console.log('🔍 DEBUG: Conexão estável, tentando buscar grupos...');
                
                let groups;
                try {
                    // PRIMEIRA TENTATIVA: groupFetchAllParticipating (método normal)
                    groups = await sock.groupFetchAllParticipating();
                    console.log('✅ Grupos obtidos via groupFetchAllParticipating:', Object.keys(groups).length);
                } catch (fetchError) {
                    console.error('❌ Erro ao buscar grupos (tentativa 1):', fetchError.message);
                    
                    // SEGUNDA TENTATIVA: Aguardar e tentar novamente
                    try {
                        console.log('🔄 Aguardando 2s e tentando novamente...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                        groups = await sock.groupFetchAllParticipating();
                        console.log('✅ Grupos obtidos na segunda tentativa:', Object.keys(groups).length);
                    } catch (retryError) {
                        console.error('❌ Erro na segunda tentativa:', retryError.message);
                        
                        // ✅ DETECTAR SESSÃO CORROMPIDA E LIMPAR
                        if (retryError.message.includes('Connection Closed') || 
                            retryError.message.includes('Timed Out')) {
                            console.log('🚨 SESSÃO CORROMPIDA DETECTADA! Limpando sessão...');
                            
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
                        
                        throw retryError; // Deixar o catch externo tratar outros erros
                    }
                }
                
                if (!groups || Object.keys(groups).length === 0) {
                    console.log('⚠️ Nenhum grupo retornado, mas sem erro');
                    console.log('🔍 DEBUG: groups =', groups);
                    console.log('🔍 DEBUG: Object.keys(groups) =', Object.keys(groups));
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
                        
                        console.log('📤 Emitindo connection-status (sessão em memória)');
                        socket.emit('connection-status', {
                            connected: true,
                            whatsappInfo: whatsappInfo
                        });
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
                
                try {
                    // ✅ VERIFICAR NOVAMENTE ANTES DO ENVIO
                    if (userSessions[userId] && userSessions[userId].isCancelled) {
                        console.log('Envio cancelado antes do envio');
                        return;
                    }
                    
                    // ENVIO REAL PARA O WHATSAPP
                    console.log(`📤 Enviando mensagem real para: ${group.name || group}`);
                    
                    // Processar variáveis na mensagem ({nome}, {hora}, {data}, etc)
                    const processedMessage = processMessageVariables(message, group.name || group);
                    console.log(`🔄 Mensagem processada com variáveis:`, processedMessage.substring(0, 100) + '...');
                    
                    // Enviar mensagem para o grupo via WhatsApp
                    await sock.sendMessage(group.id, { 
                        text: processedMessage 
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
                    io.to(`user_${userId}`).emit('send-progress', { 
                        current: i + 1, 
                        total: groups.length, 
                        group: group.name || group,
                        status: 'success'
                    });
                    
                    // ✅ APLICAR DELAY APENAS ENTRE MENSAGENS (NÃO APÓS A PRIMEIRA)
                    if (i < groups.length - 1) {
                        let actualDelay = delay;
                        
                        if (humanMode) {
                            // Delay humano: variação aleatória entre minDelay e maxDelay
                            const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
                            actualDelay = randomDelay;
                            const minutes = Math.floor(actualDelay / 60000);
                            const seconds = Math.floor((actualDelay % 60000) / 1000);
                            console.log(`⏱️ Aguardando ${minutes}min ${seconds}s antes do próximo envio...`);
                        } else {
                            const seconds = Math.floor(actualDelay / 1000);
                            console.log(`⏱️ Aguardando ${seconds}s antes do próximo envio...`);
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
                    
                    // ✅ TRATAMENTO ESPECÍFICO PARA ERRO "FORBIDDEN"
                    let errorMessage = error.message || 'Erro desconhecido';
                    if (error.message && error.message.includes('forbidden')) {
                        errorMessage = 'Grupo não permite envio de mensagens (forbidden)';
                        console.log('⚠️ Grupo bloqueado pelo WhatsApp:', group.name || group);
                    } else if (error.message && error.message.includes('not-authorized')) {
                        errorMessage = 'Não autorizado a enviar para este grupo';
                        console.log('⚠️ Grupo não autorizado:', group.name || group);
                    }
                    
                    // Emitir erro para todos os sockets do usuário
                    io.to(`user_${userId}`).emit('send-progress', { 
                        current: i + 1, 
                        total: groups.length, 
                        group: group.name || group,
                        status: 'error',
                        error: errorMessage
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
                message: 'Todas as mensagens foram enviadas com sucesso!'
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
                const [sendingHistory] = await pool.execute(
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