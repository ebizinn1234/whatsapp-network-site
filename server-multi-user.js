import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Sistema multi-usuário
const userSessions = new Map(); // IP -> { sock, isConnected, groups, selectedGroups, messageConfig }

// Função para calcular delay inteligente e humano
function calculateHumanDelay(userSession, messageCount) {
    const config = userSession.messageConfig;
    
    // Delay base
    let baseDelay = config.delay || 120000; // 2 minutos padrão
    
    // Delay mínimo e máximo
    const minDelay = config.minDelay || 60000;  // 1 minuto
    const maxDelay = config.maxDelay || 300000; // 5 minutos
    
    // Se modo humano ativado, adicionar aleatoriedade SUPER HUMANA
    if (config.humanMode) {
        // Delay aleatório entre min e max (mais variável)
        const randomFactor = Math.random() * 0.8 + 0.6; // 0.6 a 1.4 (mais variável)
        baseDelay = Math.floor(baseDelay * randomFactor);
        
        // Aumentar delay conforme mais mensagens enviadas (comportamento humano)
        const fatigueFactor = Math.min(messageCount * 0.15, 0.8); // Máximo 80% de aumento
        baseDelay = Math.floor(baseDelay * (1 + fatigueFactor));
        
        // Pausas ocasionais MUITO longas (como humanos fazem)
        if (Math.random() < 0.15) { // 15% de chance (mais frequente)
            baseDelay += Math.floor(Math.random() * 180000); // +0 a 3 minutos extra
        }
        
        // Pausas MEGA longas ocasionais (simulando pausa para almoço, etc)
        if (Math.random() < 0.05) { // 5% de chance
            baseDelay += Math.floor(Math.random() * 300000); // +0 a 5 minutos extra
        }
        
        // Simular horário de trabalho (menos atividade em horários específicos)
        const now = new Date();
        const hour = now.getHours();
        
        // Menos atividade entre 12h-14h (almoço) e 18h-20h (jantar)
        if ((hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20)) {
            baseDelay = Math.floor(baseDelay * 1.5); // 50% mais lento
        }
        
        // Menos atividade à noite (22h-6h)
        if (hour >= 22 || hour <= 6) {
            baseDelay = Math.floor(baseDelay * 2); // 100% mais lento
        }
    }
    
    // Garantir que está dentro dos limites
    baseDelay = Math.max(minDelay, Math.min(maxDelay, baseDelay));
    
    return baseDelay;
}

// Função para simular digitação humana
function simulateHumanTyping(text) {
    // Simular tempo de digitação baseado no tamanho da mensagem
    const typingTime = Math.floor(text.length * 50); // 50ms por caractere
    return Math.min(typingTime, 5000); // Máximo 5 segundos
}

// Função para enviar mensagens (sem retry)
async function sendMessagesWithRetry(userIP, socket, userSession) {
    const progress = userSession.sendingProgress;
    
    for (let i = progress.current; i < progress.total; i++) {
        // Verificar se o envio foi cancelado
        if (!progress.isSending) {
            console.log(`⏹️ Envio cancelado pelo usuário ${userIP}`);
            break;
        }
        
        const group = userSession.selectedGroups[i];
        progress.current = i;
        
        // Verificar se o grupo ainda está selecionado (não foi desmarcado)
        if (!group || !group.selected) {
            console.log(`⏭️ Pulando grupo desmarcado: ${group?.name || 'desconhecido'} (usuário ${userIP})`);
            socket.emit('message-sent', {
                group: group?.name || 'desconhecido',
                success: false,
                error: 'Grupo desmarcado',
                progress: i + 1,
                total: progress.total,
                success: progress.success,
                errors: progress.errors + 1
            });
            continue;
        }
        
        // Verificar se pode enviar mensagens para este grupo
        if (!group.canSendMessages) {
            console.log(`⏭️ Pulando grupo restrito: ${group.name} (usuário ${userIP})`);
            socket.emit('message-sent', {
                group: group.name,
                success: false,
                error: 'Grupo restrito - não é possível enviar mensagens',
                progress: i + 1,
                total: progress.total,
                skipped: true
            });
            continue;
        }
        
        // Tentar enviar (sem retry)
        try {
            // Verificar conexão antes de enviar
            if (!userSession.isConnected || !userSession.sock) {
                console.log(`❌ Conexão perdida durante envio para ${group.name} (usuário ${userIP})`);
                socket.emit('connection-lost', 'Conexão WhatsApp perdida');
                progress.isSending = false;
                return;
            }
            
            await userSession.sock.sendMessage(group.id, { text: userSession.messageConfig.text });
            progress.success++;
            console.log(`✅ Enviado para: ${group.name} (usuário ${userIP})`);
            
            socket.emit('message-sent', {
                group: group.name,
                success: true,
                progress: i + 1,
                total: progress.total
            });
            
        } catch (error) {
            progress.errors++;
            console.log(`❌ Erro ao enviar para: ${group.name} (usuário ${userIP}) - ${error.message}`);
            
            socket.emit('message-sent', {
                group: group.name,
                success: false,
                error: error.message,
                progress: i + 1,
                total: progress.total
            });
        }
        
        // Delay inteligente entre mensagens (exceto na última)
        if (i < progress.total - 1) {
            const smartDelay = calculateHumanDelay(userSession, i);
            console.log(`⏱️ Delay inteligente: ${Math.floor(smartDelay/1000)}s para próxima mensagem`);
            
            // Verificar se ainda está enviando durante o delay
            const delayStart = Date.now();
            while (Date.now() - delayStart < smartDelay) {
                if (!progress.isSending) {
                    console.log(`⏹️ Envio cancelado durante delay (usuário ${userIP})`);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000)); // Verificar a cada segundo
            }
        }
        
        // Log de progresso a cada 5 mensagens
        if ((i + 1) % 5 === 0) {
            const elapsed = Date.now() - progress.startTime;
            const rate = (i + 1) / (elapsed / 1000 / 60); // mensagens por minuto
            console.log(`📊 Progresso: ${i + 1}/${progress.total} (${Math.round(rate * 10) / 10} msg/min) - Sucessos: ${progress.success}, Erros: ${progress.errors}`);
        }
    }
    
    // Finalizar envio
    progress.isSending = false;
    const totalTime = Date.now() - progress.startTime;
    const rate = progress.total / (totalTime / 1000 / 60); // mensagens por minuto
    
    console.log(`🎉 Envio concluído para usuário ${userIP}!`);
    console.log(`📊 Estatísticas: ${progress.success} sucessos, ${progress.errors} erros, ${Math.round(rate * 10) / 10} msg/min`);
    
    socket.emit('sending-completed', { 
        success: progress.success, 
        errors: progress.errors, 
        total: progress.total,
        rate: Math.round(rate * 10) / 10,
        time: Math.round(totalTime / 1000)
    });
}

// Função para pausar/retomar envio
function pauseSending(userIP) {
    const userSession = userSessions.get(userIP);
    if (userSession && userSession.sendingProgress) {
        userSession.sendingProgress.isSending = false;
        console.log(`⏸️ Envio pausado para usuário ${userIP}`);
    }
}

// Função para retomar envio
function resumeSending(userIP, socket) {
    const userSession = userSessions.get(userIP);
    if (userSession && userSession.sendingProgress && !userSession.sendingProgress.isSending) {
        userSession.sendingProgress.isSending = true;
        console.log(`▶️ Envio retomado para usuário ${userIP}`);
        sendMessagesWithRetry(userIP, socket, userSession);
    }
}

// Função para listar contas disponíveis
function getAvailableAccounts(userIP) {
    const accounts = [];
    const userDir = `./auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    // Verificar conta padrão
    if (fs.existsSync(userDir)) {
        accounts.push({
            id: 'default',
            name: 'Conta Principal',
            path: userDir,
            isDefault: true
        });
    }
    
    // Verificar contas adicionais
    const files = fs.readdirSync('./').filter(file => 
        file.startsWith(`auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}_`) && 
        file !== `auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}`
    );
    
    files.forEach(file => {
        const accountId = file.replace(`auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}_`, '');
        accounts.push({
            id: accountId,
            name: `Conta ${accountId}`,
            path: `./${file}`,
            isDefault: false
        });
    });
    
    return accounts;
}

// Função para criar nova conta
function createNewAccount(userIP, accountId) {
    const newPath = `./auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}_${accountId}`;
    if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
        console.log(`📱 Nova conta criada: ${accountId} para usuário ${userIP}`);
        return true;
    }
    return false;
}

// Função para obter IP do usuário
function getUserIP(socket) {
    return socket.handshake.address || socket.handshake.headers['x-forwarded-for'] || 'unknown';
}

// Função para conectar ao WhatsApp para um usuário específico
async function connectToWhatsApp(userIP, socket, accountId = null) {
    try {
        // Sistema de múltiplas contas
        let userAuthPath;
        
        if (accountId) {
            // Usar conta específica
            userAuthPath = `./auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}_${accountId}`;
            console.log(`📱 Conectando com conta específica: ${accountId} para usuário ${userIP}`);
        } else {
            // Usar conta padrão do usuário
            userAuthPath = `./auth_info_${userIP.replace(/[^a-zA-Z0-9]/g, '_')}`;
            console.log(`📱 Conectando com conta padrão para usuário ${userIP}`);
        }
        
        // Se não existe pasta específica, criar nova
        if (!fs.existsSync(userAuthPath)) {
            fs.mkdirSync(userAuthPath, { recursive: true });
            console.log(`📁 Criando nova sessão para usuário ${userIP}${accountId ? ` (conta: ${accountId})` : ''}`);
        } else {
            console.log(`📁 Usando sessão existente para usuário ${userIP}${accountId ? ` (conta: ${accountId})` : ''}`);
        }

        const { state, saveCreds } = await useMultiFileAuthState(userAuthPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: 'silent' }),
            auth: state,
            browser: ['WhatsApp Network Site', 'Chrome', '4.0.0'],
            generateHighQualityLinkPreview: true
        });

        // Inicializar ou atualizar sessão do usuário
        const existingSession = userSessions.get(userIP);
        if (existingSession) {
            existingSession.sock = sock;
            existingSession.isConnected = false; // Será definido como true quando conectar
        } else {
            userSessions.set(userIP, {
                sock,
                isConnected: false,
                groups: [],
                selectedGroups: [],
                messageConfig: {
                    text: "🌐Lista de Grupos de Network\n\n👉https://networkzap.site",
                    delay: 60000,
                    minDelay: 30000,
                    maxDelay: 180000,
                    humanMode: true,
                    randomDelay: true
                }
            });
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log(`📱 QR Code gerado para usuário ${userIP}!`);
                const qrCodeDataURL = await QRCode.toDataURL(qr);
                socket.emit('qr-code', qrCodeDataURL);
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log(`🔄 Reconectando usuário ${userIP}...`);
                    setTimeout(() => connectToWhatsApp(userIP, socket), 3000);
                } else {
                    const userSession = userSessions.get(userIP);
                    if (userSession) {
                        userSession.isConnected = false;
                    }
                    socket.emit('connection-status', { connected: false, message: 'Desconectado do WhatsApp' });
                }
            } else if (connection === 'open') {
                console.log(`✅ Usuário ${userIP} conectado ao WhatsApp!`);
                const userSession = userSessions.get(userIP);
                if (userSession) {
                    userSession.isConnected = true;
                    userSession.sock = sock; // Garantir que o sock está salvo
                }
                
                // Obter informações do usuário conectado
                let whatsappInfo = null;
                try {
                    if (sock.user) {
                        whatsappInfo = {
                            name: sock.user.name || 'Usuário',
                            number: sock.user.id?.split(':')[0] || 'Número não disponível',
                            profilePicture: null // Baileys não fornece foto de perfil diretamente
                        };
                        console.log(`📱 Usuário conectado: ${whatsappInfo.name} (${whatsappInfo.number})`);
                    }
                } catch (error) {
                    console.log('⚠️ Erro ao obter informações do usuário:', error.message);
                }
                
                socket.emit('connection-status', { 
                    connected: true, 
                    message: 'Conectado ao WhatsApp!',
                    whatsappInfo: whatsappInfo
                });
                
                // Buscar grupos após conectar
                setTimeout(() => loadGroups(userIP, socket), 2000);
            }
        });

        sock.ev.on('messages.upsert', (m) => {
            if (m.type === 'notify') {
                socket.emit('message-received', 'Nova mensagem recebida');
            }
        });

    } catch (error) {
        console.error(`❌ Erro na conexão do usuário ${userIP}:`, error);
        socket.emit('connection-error', error.message);
    }
}

// Função para carregar grupos reais do WhatsApp para um usuário específico
async function loadGroups(userIP, socket) {
    const userSession = userSessions.get(userIP);
    if (!userSession || !userSession.isConnected || !userSession.sock) {
        console.log(`❌ Usuário ${userIP} não está conectado ou sessão inválida`);
        return;
    }
    
    try {
        console.log(`🔍 Carregando grupos reais do WhatsApp para usuário ${userIP}...`);
        
        // Verificar se o socket ainda está ativo e pertence ao usuário correto
        if (!userSession.sock.user || !userSession.sock.user.id) {
            console.log(`❌ Sessão inválida para usuário ${userIP} - reconectando...`);
            socket.emit('connection-status', {
                connected: false,
                message: 'Sessão expirada - reconecte'
            });
            return;
        }
        
        // Buscar grupos reais do WhatsApp
        const chats = await userSession.sock.groupFetchAllParticipating();
        const realGroups = [];
        let communitiesFiltered = 0;
        
        for (const [id, chat] of Object.entries(chats)) {
            if (chat.subject) { // Só grupos com nome
                // Verificar se é um grupo (não comunidade)
                const isGroup = id.endsWith('@g.us');
                const participantCount = Object.keys(chat.participants || {}).length;
                
                // Verificar se o usuário atual é participante do grupo
                const currentUserId = userSession.sock.user.id;
                const isParticipant = chat.participants && chat.participants[currentUserId];
                
                // Log para debug - verificar se o usuário é participante
                if (!isParticipant) {
                    console.log(`🔍 Grupo ${chat.subject} - verificando participação do usuário ${currentUserId}`);
                    console.log(`🔍 Participantes disponíveis:`, Object.keys(chat.participants || {}));
                    // Temporariamente permitir todos os grupos para debug
                    console.log(`⚠️ Permitindo grupo ${chat.subject} temporariamente para debug`);
                }
                
                // Detectar comunidades de várias formas mais precisas
                const isCommunity = 
                    // Comunidades têm endOfHistoryTransparencyDenied = true
                    chat.endOfHistoryTransparencyDenied ||
                    // Grupos com poucos participantes (comunidades de avisos)
                    participantCount <= 2 ||
                    // Nomes que indicam comunidades
                    chat.subject.includes('AVISOS') ||
                    chat.subject.includes('ATIVOS') ||
                    chat.subject.includes('COMUNIDADE') ||
                    chat.subject.includes('ANÚNCIOS') ||
                    chat.subject.includes('ANUNCIOS') ||
                    // Grupos que são canais de aviso
                    (participantCount <= 5 && (
                        chat.subject.includes('🚨') ||
                        chat.subject.includes('💬') ||
                        chat.subject.includes('📢')
                    ));
                
                if (isCommunity) {
                    communitiesFiltered++;
                    console.log(`🔒 Comunidade filtrada: ${chat.subject} (${participantCount} participantes)`);
                    continue; // Pular comunidades
                }
                
                // Verificar se é um grupo privado (só admin pode enviar)
                const isPrivateGroup = chat.readOnly || 
                    (chat.participants && chat.participants.length > 0 && 
                     chat.participants.some(p => p.admin === 'admin' && p.id.split('@')[0] === userSession.sock?.user?.id?.split('@')[0]));
                
                // Só incluir grupos abertos reais (não comunidades, não privados)
                if (isGroup && !isCommunity && !isPrivateGroup && participantCount > 5) {
                    // Verificar se o usuário pode enviar mensagens
                    const canSendMessages = !chat.readOnly && participantCount > 5;
                    
                    realGroups.push({
                        id: id,
                        name: chat.subject,
                        isReadOnly: chat.readOnly || false,
                        participants: participantCount,
                        canSendMessages: canSendMessages,
                        isPrivate: isPrivateGroup,
                        isCommunity: false
                    });
                }
            }
        }
        
        userSession.groups = realGroups;
        
        console.log(`📊 Carregados ${realGroups.length} grupos abertos para usuário ${userIP}`);
        console.log(`🔒 ${communitiesFiltered} comunidades privadas filtradas`);
        socket.emit('groups-loaded', realGroups);
        
    } catch (error) {
        console.error(`❌ Erro ao carregar grupos do usuário ${userIP}:`, error);
        socket.emit('groups-error', error.message);
    }
}

// Socket.io events
io.on('connection', (socket) => {
    const userIP = getUserIP(socket);
    console.log(`👤 Cliente conectado: ${socket.id} (IP: ${userIP})`);
    
    // Inicializar sessão do usuário se não existir
    if (!userSessions.has(userIP)) {
        userSessions.set(userIP, {
            sock: null,
            isConnected: false,
            groups: [],
            selectedGroups: [],
            messageConfig: {
                text: "🌐Lista de Grupos de Network\n\n👉https://networkzap.site",
                delay: 60000,
                minDelay: 30000,
                maxDelay: 180000,
                humanMode: true,
                randomDelay: true
            }
        });
    }
    
    const userSession = userSessions.get(userIP);
    
    // Enviar status atual
    socket.emit('connection-status', { 
        connected: userSession.isConnected, 
        message: userSession.isConnected ? 'Conectado' : 'Desconectado' 
    });
    
    if (userSession.groups.length > 0) {
        socket.emit('groups-loaded', userSession.groups);
    }
    
    // Enviar progresso de envio se existir
    if (userSession.sendingProgress) {
        socket.emit('sending-progress', {
            current: userSession.sendingProgress.current,
            total: userSession.sendingProgress.total,
            success: userSession.sendingProgress.success,
            errors: userSession.sendingProgress.errors,
            isSending: userSession.sendingProgress.isSending
        });
    }
    
    // Eventos do cliente
    socket.on('connect-whatsapp', (data = {}) => {
        const accountId = data.accountId || null;
        console.log(`🔄 Iniciando conexão WhatsApp para usuário ${userIP}${accountId ? ` (conta: ${accountId})` : ''}...`);
        connectToWhatsApp(userIP, socket, accountId);
    });
    
    // Eventos de gerenciamento de contas
    socket.on('get-accounts', () => {
        const accounts = getAvailableAccounts(userIP);
        socket.emit('accounts-list', accounts);
        console.log(`📱 Listando ${accounts.length} contas para usuário ${userIP}`);
    });
    
    socket.on('create-account', (data) => {
        const { accountId, accountName } = data;
        if (createNewAccount(userIP, accountId)) {
            socket.emit('account-created', { id: accountId, name: accountName || `Conta ${accountId}` });
            console.log(`✅ Nova conta criada: ${accountId} para usuário ${userIP}`);
        } else {
            socket.emit('account-error', 'Conta já existe');
        }
    });
    
    socket.on('disconnect-whatsapp', async () => {
        console.log(`🔄 Desconectando WhatsApp do usuário ${userIP}...`);
        if (userSession.sock) {
            try {
                await userSession.sock.logout();
                userSession.isConnected = false;
                userSession.sock = null;
                
                // Limpar grupos e progresso para receber outro dispositivo
                userSession.groups = [];
                userSession.selectedGroups = [];
                userSession.sendingProgress = null;
                
                socket.emit('connection-status', { connected: false, message: 'Desconectado do WhatsApp' });
                socket.emit('groups-loaded', []); // Limpar lista de grupos
                socket.emit('groups-selected', 0); // Limpar seleção
                
                console.log(`✅ WhatsApp desconectado com sucesso para usuário ${userIP}!`);
                console.log(`🧹 Grupos e progresso limpos - pronto para novo dispositivo`);
            } catch (error) {
                console.error(`❌ Erro ao desconectar usuário ${userIP}:`, error);
            }
        }
    });

    socket.on('clear-session', async () => {
        console.log(`🗑️ Limpando sessão completa para usuário ${userIP}...`);
        
        // Desconectar se estiver conectado
        if (userSession.sock) {
            try {
                await userSession.sock.logout();
                console.log(`✅ Logout realizado para usuário ${userIP}`);
            } catch (error) {
                console.log(`⚠️ Erro no logout (normal): ${error.message}`);
            }
        }
        
        // Remover sessão do mapa
        userSessions.delete(userIP);
        console.log(`🗑️ Sessão removida do mapa para usuário ${userIP}`);
        
        // Limpar pasta de autenticação
        const fs = require('fs');
        const path = require('path');
        const authPath = path.join(process.cwd(), `auth_info_${userIP}`);
        
        try {
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log(`✅ Pasta de autenticação removida: ${authPath}`);
            } else {
                console.log(`📁 Pasta de autenticação não encontrada: ${authPath}`);
            }
        } catch (error) {
            console.log(`⚠️ Erro ao remover pasta de autenticação: ${error.message}`);
        }
        
        socket.emit('connection-status', {
            connected: false,
            message: 'Sessão limpa! Conecte novamente'
        });
        
        socket.emit('session-cleared', 'Sessão limpa com sucesso!');
        console.log(`🎉 Sessão completamente limpa para usuário ${userIP}!`);
    });
    
    socket.on('load-groups', () => {
        // Verificar se o usuário tem uma sessão válida
        if (!userSession || !userSession.isConnected || !userSession.sock) {
            console.log(`❌ Tentativa de carregar grupos sem sessão válida para ${userIP}`);
            socket.emit('groups-error', 'Sessão inválida - reconecte o WhatsApp');
            return;
        }
        
        // Verificar se o socket ainda está ativo
        if (!userSession.sock.user || !userSession.sock.user.id) {
            console.log(`❌ Sessão expirada para usuário ${userIP}`);
            socket.emit('connection-status', {
                connected: false,
                message: 'Sessão expirada - reconecte'
            });
            return;
        }
        
        console.log(`🔄 Recarregando grupos para usuário ${userIP} (${userSession.sock.user.id})...`);
        loadGroups(userIP, socket);
    });
    
    socket.on('select-groups', (selected) => {
        // Filtrar apenas grupos realmente selecionados (não desmarcados)
        userSession.selectedGroups = (selected || []).filter(group => group && group.selected !== false);
        console.log(`📋 ${userSession.selectedGroups.length} grupos selecionados pelo usuário ${userIP}`);
        console.log(`   - Grupos: ${userSession.selectedGroups.map(g => g.name).join(', ')}`);
        socket.emit('groups-selected', userSession.selectedGroups.length);
    });
    
    socket.on('update-message', (config) => {
        userSession.messageConfig = config;
        console.log(`💬 Mensagem atualizada pelo usuário ${userIP}:`, config.text);
        socket.emit('message-updated', 'Mensagem atualizada!');
    });
    
    socket.on('send-messages', async () => {
        console.log(`🔍 Verificando envio para usuário ${userIP}:`);
        console.log(`   - Conectado: ${userSession.isConnected}`);
        console.log(`   - Grupos selecionados: ${userSession.selectedGroups.length}`);
        console.log(`   - Sock disponível: ${userSession.sock ? 'Sim' : 'Não'}`);
        
        // Verificar se o sock está realmente conectado
        if (userSession.sock && userSession.sock.user) {
            console.log(`   - Sock conectado: Sim (usuário: ${userSession.sock.user.id})`);
        } else {
            console.log(`   - Sock conectado: Não`);
        }
        
        if (!userSession.isConnected) {
            socket.emit('send-error', 'WhatsApp não conectado');
            return;
        }
        
        if (!userSession.sock) {
            socket.emit('send-error', 'Conexão WhatsApp não disponível');
            return;
        }
        
        if (userSession.selectedGroups.length === 0) {
            socket.emit('send-error', 'Nenhum grupo selecionado');
            return;
        }
        
        console.log(`🚀 Iniciando envio para ${userSession.selectedGroups.length} grupos do usuário ${userIP}...`);
        socket.emit('sending-started', { total: userSession.selectedGroups.length });
        
        // Inicializar ou restaurar progresso na sessão
        if (!userSession.sendingProgress) {
            userSession.sendingProgress = {
                current: 0,
                total: userSession.selectedGroups.length,
                success: 0,
                errors: 0,
                isSending: true,
                startTime: Date.now()
            };
        } else {
            // Restaurar progresso existente
            userSession.sendingProgress.isSending = true;
            console.log(`🔄 Restaurando progresso: ${userSession.sendingProgress.current}/${userSession.sendingProgress.total} (usuário ${userIP})`);
        }
        
        await sendMessagesWithRetry(userIP, socket, userSession);
    });
    
    // Eventos de controle de envio
    socket.on('pause-sending', () => {
        pauseSending(userIP);
        socket.emit('sending-paused', 'Envio pausado');
    });
    
    socket.on('resume-sending', () => {
        resumeSending(userIP, socket);
        socket.emit('sending-resumed', 'Envio retomado');
    });
    
    socket.on('cancel-sending', () => {
        pauseSending(userIP);
        socket.emit('sending-cancelled', 'Envio cancelado');
    });
    
    socket.on('new-sending', () => {
        const userSession = userSessions.get(userIP);
        if (userSession) {
            // Resetar progresso para começar do zero
            userSession.sendingProgress = null;
            console.log(`🆕 Progresso resetado para novo envio (usuário ${userIP})`);
            socket.emit('new-sending-ready', 'Pronto para novo envio');
        }
    });
    
    socket.on('check-connection', () => {
        console.log(`🔍 Verificando conexão para usuário ${userIP}`);
        const userSession = userSessions.get(userIP);
        
        // Verificar se existe sessão e se está realmente conectada
        if (userSession && userSession.isConnected && userSession.sock) {
            try {
                // Verificar se o socket ainda está ativo
                if (userSession.sock.user && userSession.sock.user.id) {
                    console.log(`✅ Usuário ${userIP} está conectado ao WhatsApp`);
                    
                    // Obter informações do usuário conectado
                    let whatsappInfo = null;
                    try {
                        if (userSession.sock.user) {
                            whatsappInfo = {
                                name: userSession.sock.user.name || 'Usuário',
                                number: userSession.sock.user.id?.split(':')[0] || 'Número não disponível',
                                profilePicture: null
                            };
                        }
                    } catch (error) {
                        console.log('⚠️ Erro ao obter informações do usuário:', error.message);
                    }
                    
                    socket.emit('connection-status', {
                        connected: true,
                        message: 'WhatsApp conectado',
                        whatsappInfo: whatsappInfo
                    });
                    return;
                }
            } catch (error) {
                console.log(`⚠️ Erro ao verificar conexão: ${error.message}`);
            }
        }
        
        console.log(`❌ Usuário ${userIP} não está conectado ao WhatsApp`);
        if (userSession) {
            console.log(`📊 Status da sessão: isConnected=${userSession.isConnected}, sock=${!!userSession.sock}, user=${!!userSession.sock?.user}`);
        }
        socket.emit('connection-status', {
            connected: false,
            message: 'Seu WhatsApp está desconectado'
        });
    });
    
    socket.on('disconnect', () => {
        console.log(`👤 Cliente desconectado: ${socket.id} (IP: ${userIP})`);
        // Não remover a sessão imediatamente, pode reconectar
    });
});

// Rotas da API
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
    const userIP = req.ip || req.connection.remoteAddress;
    const userSession = userSessions.get(userIP);
    
    if (userSession) {
        res.json({
            connected: userSession.isConnected,
            groupsCount: userSession.groups.length,
            selectedCount: userSession.selectedGroups.length
        });
    } else {
        res.json({
            connected: false,
            groupsCount: 0,
            selectedCount: 0
        });
    }
});

// Limpeza periódica de sessões inativas (opcional)
setInterval(() => {
    console.log(`📊 Sessões ativas: ${userSessions.size}`);
}, 60000); // A cada minuto

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor multi-usuário rodando em http://localhost:${PORT}`);
    console.log('📱 Cada usuário terá sua própria sessão WhatsApp!');
    console.log('🌐 Pronto para deploy online!');
});
