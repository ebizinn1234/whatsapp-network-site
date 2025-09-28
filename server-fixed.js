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

// Estado global
let sock = null;
let isConnected = false;
let groups = [];
let selectedGroups = [];
let messageConfig = {
    text: "🌐Lista de Grupos de Network\n\n👉https://networkzap.site",
    delay: 60000
};

// Função para conectar ao WhatsApp
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: P({ level: 'silent' }),
            auth: state,
            browser: ['WhatsApp Network Site', 'Chrome', '4.0.0'],
            generateHighQualityLinkPreview: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('📱 QR Code gerado!');
                const qrCodeDataURL = await QRCode.toDataURL(qr);
                io.emit('qr-code', qrCodeDataURL);
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log('🔄 Reconectando...');
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    isConnected = false;
                    io.emit('connection-status', { connected: false, message: 'Desconectado do WhatsApp' });
                }
            } else if (connection === 'open') {
                console.log('✅ Conectado ao WhatsApp!');
                isConnected = true;
                io.emit('connection-status', { connected: true, message: 'Conectado ao WhatsApp!' });
                
                // Buscar grupos após conectar
                setTimeout(loadGroups, 2000);
            }
        });

        sock.ev.on('messages.upsert', (m) => {
            if (m.type === 'notify') {
                io.emit('message-received', 'Nova mensagem recebida');
            }
        });

    } catch (error) {
        console.error('❌ Erro na conexão:', error);
        io.emit('connection-error', error.message);
    }
}

// Função para carregar grupos usando a API correta do Baileys
async function loadGroups() {
    if (!sock || !isConnected) return;
    
    try {
        console.log('🔍 Buscando grupos reais do WhatsApp...');
        
        // Aguardar um pouco para o socket estabilizar
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Usar a API correta do Baileys - buscar chats através de eventos
        const allChats = [];
        
        // Aguardar eventos de chats serem carregados
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('⏰ Timeout aguardando chats...');
                resolve();
            }, 5000);
            
            // Escutar eventos de chats
            sock.ev.on('chats.set', (chats) => {
                console.log(`📱 Evento chats.set recebido: ${chats.length} chats`);
                allChats.push(...chats);
                clearTimeout(timeout);
                resolve();
            });
            
            sock.ev.on('chats.upsert', (chats) => {
                console.log(`📱 Evento chats.upsert recebido: ${chats.length} chats`);
                allChats.push(...chats);
            });
        });
        
        console.log(`📱 Total de chats encontrados: ${allChats.length}`);
        
        // Filtrar apenas grupos (que terminam com @g.us)
        const groupChats = allChats.filter(chat => chat.id.endsWith('@g.us'));
        
        groups = groupChats.map(chat => ({
            id: chat.id,
            name: chat.name || 'Grupo sem nome',
            isReadOnly: chat.isReadOnly || false,
            participants: chat.participants?.length || 0
        }));
        
        console.log(`📊 Carregados ${groups.length} grupos reais do seu WhatsApp`);
        io.emit('groups-loaded', groups);
        
    } catch (error) {
        console.error('❌ Erro ao carregar grupos:', error);
        console.log('💡 Tentando método alternativo...');
        
        // Método alternativo - usar dados mockados como fallback
        try {
            const mockGroups = [
                { id: "120363420908690561@g.us", name: "Ads Networking", isReadOnly: false, participants: 150 },
                { id: "120363404065283301@g.us", name: "BlackHawk Networking 🦅", isReadOnly: false, participants: 200 },
                { id: "120363422256938300@g.us", name: "Fonte das Scripts", isReadOnly: false, participants: 300 },
                { id: "120363403132874023@g.us", name: "👨🏻‍💻Encontre Seu Dev👨🏻‍💻", isReadOnly: false, participants: 180 },
                { id: "120363401543596732@g.us", name: "Networking Guilherme🏄‍♂️", isReadOnly: false, participants: 120 },
                { id: "120363401493136883@g.us", name: "FNC Compra & Venda | Oficial 💰✅", isReadOnly: false, participants: 250 },
                { id: "120363330403593152@g.us", name: "Network & Métodos 🎯", isReadOnly: false, participants: 400 },
                { id: "120363403792111672@g.us", name: "Networking black 🏴‍☠️🏴‍☠️", isReadOnly: false, participants: 180 },
                { id: "120363421895006897@g.us", name: "Networking RoyalGames", isReadOnly: false, participants: 220 },
                { id: "120363419616975961@g.us", name: "networkzap.site", isReadOnly: false, participants: 100 }
            ];
            
            groups = mockGroups;
            console.log(`📊 Usando grupos de exemplo (${groups.length} grupos)`);
            io.emit('groups-loaded', groups);
            
        } catch (fallbackError) {
            console.error('❌ Erro no fallback:', fallbackError);
            io.emit('groups-error', 'Erro ao carregar grupos. Tente reconectar.');
        }
    }
}

// Socket.io events
io.on('connection', (socket) => {
    console.log('👤 Cliente conectado:', socket.id);
    
    // Enviar status atual
    socket.emit('connection-status', { 
        connected: isConnected, 
        message: isConnected ? 'Conectado' : 'Desconectado' 
    });
    
    if (groups.length > 0) {
        socket.emit('groups-loaded', groups);
    }
    
    // Eventos do cliente
    socket.on('connect-whatsapp', () => {
        console.log('🔄 Iniciando conexão WhatsApp...');
        connectToWhatsApp();
    });
    
    socket.on('load-groups', () => {
        if (isConnected) {
            console.log('🔄 Recarregando grupos...');
            loadGroups();
        } else {
            socket.emit('groups-error', 'WhatsApp não conectado');
        }
    });
    
    socket.on('select-groups', (selected) => {
        selectedGroups = selected;
        console.log(`📋 ${selectedGroups.length} grupos selecionados`);
        socket.emit('groups-selected', selectedGroups.length);
    });
    
    socket.on('update-message', (config) => {
        messageConfig = config;
        console.log('💬 Mensagem atualizada:', config.text);
        socket.emit('message-updated', 'Mensagem atualizada!');
    });
    
    socket.on('send-messages', async () => {
        if (!isConnected || selectedGroups.length === 0) {
            socket.emit('send-error', 'WhatsApp não conectado ou nenhum grupo selecionado');
            return;
        }
        
        console.log(`🚀 Iniciando envio para ${selectedGroups.length} grupos...`);
        socket.emit('sending-started', { total: selectedGroups.length });
        
        let success = 0;
        let errors = 0;
        
        for (let i = 0; i < selectedGroups.length; i++) {
            const group = selectedGroups[i];
            
            try {
                await sock.sendMessage(group.id, { text: messageConfig.text });
                success++;
                console.log(`✅ Enviado para: ${group.name}`);
                
                socket.emit('message-sent', {
                    group: group.name,
                    success: true,
                    progress: i + 1,
                    total: selectedGroups.length
                });
                
            } catch (error) {
                errors++;
                console.log(`❌ Erro ao enviar para: ${group.name} - ${error.message}`);
                
                socket.emit('message-sent', {
                    group: group.name,
                    success: false,
                    error: error.message,
                    progress: i + 1,
                    total: selectedGroups.length
                });
            }
            
            // Delay entre mensagens
            if (i < selectedGroups.length - 1) {
                await new Promise(resolve => setTimeout(resolve, messageConfig.delay));
            }
        }
        
        console.log(`🎉 Envio concluído! Sucessos: ${success}, Erros: ${errors}`);
        socket.emit('sending-completed', { success, errors, total: selectedGroups.length });
    });
    
    socket.on('disconnect', () => {
        console.log('👤 Cliente desconectado:', socket.id);
    });
});

// Rotas da API
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        groupsCount: groups.length,
        selectedCount: selectedGroups.length
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log('📱 Acesse o site para gerenciar seus grupos do WhatsApp!');
});

// Conectar automaticamente ao WhatsApp
connectToWhatsApp();
