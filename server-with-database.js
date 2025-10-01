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
                        console.log('🔍 DEBUG: Informações do WhatsApp:', {
                            name: userInfo?.name,
                            id: userInfo?.id,
                            profilePicture: userInfo?.profilePicture
                        });
                        
                        const accountName = userInfo?.name || 'WhatsApp User';
                        const accountNumber = userInfo?.id?.split(':')[0] || '';
                        const profilePicture = userInfo?.profilePicture || null;
                        
                        // Usar o sessionId que foi passado para a função createWhatsAppSocket
                        const uniqueSessionId = sessionId || `user_${userId}_${Date.now()}`;
                        console.log('🔍 DEBUG: sessionId único gerado para conexão:', uniqueSessionId);
                        
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
                if (session.sock && session.sock.user && session.sock.user.id) {
                    console.log('✅ WhatsApp já conectado para usuário:', userIdentifier, '- ignorando nova conexão');
                    return;
                }
            }
        }
        
        // Verificar se já existe uma conexão ativa para este usuário
        if (userSessions.has(userIdentifier)) {
            const existingSessions = userSessions.get(userIdentifier);
            for (const [sessionKey, session] of Object.entries(existingSessions)) {
                if (session.sock && session.sock.user && session.sock.user.id) {
                    console.log('✅ WhatsApp já conectado para usuário:', userIdentifier);
                    console.log('🔍 DEBUG: Emitindo connection-status para usuário já conectado:', userIdentifier);
                    
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
            
                const sock = await createWhatsAppSocket(userIdentifier, uniqueSessionId);
                userSessions.get(userIdentifier)[uniqueSessionId] = {
                    sock,
                    isConnected: false,
                    sessionId: uniqueSessionId
                };
            
            console.log(`📱 Conectando WhatsApp para usuário ${userIdentifier}`);
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
        const { userId, sessionId = 'default' } = data || {};
        console.log('🔍 DEBUG: userId =', userId, 'sessionId =', sessionId);
        console.log('🔍 DEBUG: EVENTO LOAD-GROUPS INICIADO!');
        
        try {
            console.log('🔍 DEBUG: userSessions keys:', Array.from(userSessions.keys()));
            const userSession = userSessions.get(userId);
            console.log('🔍 DEBUG: userSession encontrada:', !!userSession);
            console.log('🔍 DEBUG: userSession content:', userSession);
            
            if (!userSession || !userSession[sessionId]) {
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
                                const groupsList = Object.values(groups).map(group => ({
                                    id: group.id,
                                    name: group.subject || 'Sem nome',
                                    description: group.desc || '',
                                    participantCount: group.participants ? Object.keys(group.participants).length : 0,
                                    isCommunity: group.endOfHistoryTransparencyDenied || false,
                                    isPrivate: group.restrict || false
                                }));
                                
                                console.log('📊 Grupos carregados:', groupsList.length);
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
                
                // Verificar se a conexão está realmente ativa
                if (!sock.user || !sock.user.id) {
                    console.log('❌ WhatsApp não está completamente conectado');
                    socket.emit('groups-loaded', { groups: [] });
                    return;
                }
                
                // Aguardar um pouco para garantir estabilidade
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const groups = await sock.groupFetchAllParticipating();
            console.log('📊 Grupos encontrados:', Object.keys(groups).length);
            console.log('📊 Primeiros 3 grupos:', Object.keys(groups).slice(0, 3));
            
            // TESTE: Retornar TODOS os grupos sem filtros para debug
            const groupsList = Object.values(groups).map(group => {
                console.log('🔍 DEBUG: Processando grupo:', group.subject, 'ID:', group.id);
                console.log('🔍 DEBUG: Grupo details:', {
                    subject: group.subject,
                    participants: group.participants ? Object.keys(group.participants).length : 0,
                    endOfHistoryTransparencyDenied: group.endOfHistoryTransparencyDenied,
                    restrict: group.restrict
                });
                
                return {
                    id: group.id,
                    name: group.subject || 'Sem nome',
                    description: group.desc || '',
                    participantCount: group.participants ? Object.keys(group.participants).length : 0,
                    isCommunity: group.endOfHistoryTransparencyDenied || false,
                    isPrivate: group.restrict || false
                };
            });
            
            console.log('🔍 DEBUG: TODOS os grupos (sem filtros):', groupsList.length);
            console.log('🔍 DEBUG: Primeiros 3 grupos:', groupsList.slice(0, 3));
            
            console.log('📊 Grupos filtrados (sem comunidades/privados):', groupsList.length);
            console.log('🔍 DEBUG: EVENTO LOAD-GROUPS FINALIZADO COM SUCESSO!');
            socket.emit('groups-loaded', { groups: groupsList });
            } catch (error) {
                console.error('❌ Erro ao carregar grupos:', error);
                console.log('🔍 DEBUG: EVENTO LOAD-GROUPS FINALIZADO COM ERRO!');
                
                // Se for erro de conexão, tentar reconectar
                if (error.message.includes('Connection Closed') || error.message.includes('Timed Out')) {
                    console.log('🔄 Tentando reconectar WhatsApp...');
                    try {
                        // Limpar sessão atual
                        if (userSessions.has(userId)) {
                            delete userSessions.get(userId)[sessionId];
                        }
                        
                        // Tentar reconectar
                        setTimeout(async () => {
                            try {
                                const newSock = await createWhatsAppSocket(userId, sessionId);
                                userSessions.get(userId)[sessionId] = {
                                    sock: newSock,
                                    isConnected: false,
                                    sessionId
                                };
                                console.log('✅ Reconexão iniciada');
                            } catch (reconnectError) {
                                console.error('❌ Erro na reconexão:', reconnectError);
                            }
                        }, 5000);
                    } catch (reconnectError) {
                        console.error('❌ Erro ao tentar reconectar:', reconnectError);
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
                const authDir = `./auth_info_${savedSession.session_id}`;
                if (fs.existsSync(authDir)) {
                    console.log('✅ Arquivos de autenticação encontrados, reconectando...');
                    
                    // Tentar reconectar
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
                        
                        console.log('🔄 Reconexão iniciada com sessão salva');
                        
                        // Aguardar conexão
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        
                        // Verificar se conectou
                        if (sock.user && sock.user.id) {
                            console.log('✅ Reconexão bem-sucedida!');
                            
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
                        } else {
                            console.log('⚠️ Reconexão falhou - sessão expirada');
                            socket.emit('connection-status', {
                                connected: false,
                                message: 'Não conectado ao WhatsApp'
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
                    socket.emit('connection-status', {
                        connected: false,
                        message: 'Sessão expirada'
                    });
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
            const { groups, message, userId, sessionId = 'default', delay = 2000, minDelay = 1000, maxDelay = 5000, humanMode = true } = data || {};
            
            console.log('⏱️ DEBUG: Configurações de delay recebidas:', {
                delay: delay,
                minDelay: minDelay,
                maxDelay: maxDelay,
                humanMode: humanMode
            });
        
        try {
            // Verificar se WhatsApp está conectado
            const userSession = userSessions.get(userId) || userSessions.get('default');
            if (!userSession || !userSession[sessionId]) {
                console.log('❌ Sessão não encontrada para envio');
                socket.emit('send-error', { message: 'WhatsApp não conectado' });
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
            
            // Aplicar delay inicial se humanMode estiver ativo
            if (humanMode && groups.length > 0) {
                const initialDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
                console.log(`⏱️ Delay inicial: ${initialDelay}ms`);
                await new Promise(resolve => setTimeout(resolve, initialDelay));
            }
            
            // Processar cada grupo
            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                console.log(`📤 Enviando para grupo ${i + 1}/${groups.length}: ${group}`);
                
                try {
                    // ENVIO REAL PARA O WHATSAPP
                    console.log(`📤 Enviando mensagem real para: ${group.name || group}`);
                    
                    // Enviar mensagem para o grupo via WhatsApp
                    await sock.sendMessage(group.id, { 
                        text: message 
                    });
                    
                    console.log(`✅ Mensagem enviada com sucesso para: ${group.name || group}`);
                    socket.emit('send-progress', { 
                        current: i + 1, 
                        total: groups.length, 
                        group: group.name || group,
                        status: 'success'
                    });
                    
                    // Delay entre envios baseado na configuração do usuário
                    let actualDelay = delay;
                    
                    if (humanMode) {
                        // Delay humano: variação aleatória entre minDelay e maxDelay
                        const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
                        actualDelay = randomDelay;
                        console.log(`⏱️ Delay humano: ${actualDelay}ms (${minDelay}-${maxDelay}ms)`);
                    } else {
                        console.log(`⏱️ Delay fixo: ${actualDelay}ms`);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, actualDelay));
                    
                } catch (error) {
                    console.error(`❌ Erro ao enviar para ${group}:`, error);
                    socket.emit('send-progress', { 
                        current: i + 1, 
                        total: groups.length, 
                        group: group,
                        status: 'error',
                        error: error.message
                    });
                }
            }
            
            console.log('✅ Envio concluído para todos os grupos');
            socket.emit('send-complete', { 
                total: groups.length,
                message: 'Todas as mensagens foram enviadas com sucesso!'
            });
            
        } catch (error) {
            console.error('❌ Erro no envio de mensagens:', error);
            socket.emit('send-error', { message: 'Erro interno do servidor' });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor com banco de dados rodando em http://localhost:${PORT}`);
    console.log(`📱 Sistema de autenticação ativo!`);
    console.log(`🌐 Pronto para deploy online!`);
    console.log('🔍 DEBUG: Servidor server-with-database.js iniciado!');
});