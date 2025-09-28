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

// Função para carregar grupos reais do WhatsApp
async function loadGroups() {
    if (!isConnected || !sock) return;
    
    try {
        console.log('🔍 Carregando grupos reais do WhatsApp...');
        
        // Buscar grupos reais do WhatsApp
        const chats = await sock.groupFetchAllParticipating();
        const realGroups = [];
        
        for (const [id, chat] of Object.entries(chats)) {
            if (chat.subject) { // Só grupos com nome
                realGroups.push({
                    id: id,
                    name: chat.subject,
                    isReadOnly: chat.readOnly || false,
                    participants: chat.participants ? Object.keys(chat.participants).length : 0
                });
            }
        }
        
        groups = realGroups;
        
        console.log(`📊 Carregados ${groups.length} grupos reais do WhatsApp`);
        io.emit('groups-loaded', groups);
        
    } catch (error) {
        console.error('❌ Erro ao carregar grupos:', error);
        io.emit('groups-error', error.message);
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
    
    socket.on('disconnect-whatsapp', async () => {
        console.log('🔄 Desconectando WhatsApp...');
        if (sock) {
            try {
                await sock.logout();
                isConnected = false;
                io.emit('connection-status', { connected: false, message: 'Desconectado do WhatsApp' });
                console.log('✅ WhatsApp desconectado com sucesso!');
            } catch (error) {
                console.error('❌ Erro ao desconectar:', error);
            }
        }
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
