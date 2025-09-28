import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import fetch from 'node-fetch';

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

// Configurações do WPPConnect Server
const WPP_SERVER_URL = 'http://localhost:21465';
const SESSION = 'mySession';
const SECRET_KEY = 'THISISMYSECURETOKEN';

// Estado global
let isConnected = false;
let groups = [];
let selectedGroups = [];
let token = '';
let messageConfig = {
    text: "🌐Lista de Grupos de Network\n\n👉https://networkzap.site",
    delay: 60000
};

// Função para gerar token
async function generateToken() {
    try {
        const response = await fetch(`${WPP_SERVER_URL}/api/${SESSION}/${SECRET_KEY}/generate-token`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json'
            }
        });
        
        const data = await response.json();
        token = data.full;
        console.log('✅ Token gerado!');
        return token;
    } catch (error) {
        console.error('❌ Erro ao gerar token:', error);
        return null;
    }
}

// Função para iniciar sessão
async function startSession() {
    try {
        const response = await fetch(`${WPP_SERVER_URL}/api/${SESSION}/start-session`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token.split(':')[1]}`
            }
        });
        
        const data = await response.json();
        console.log('📱 Sessão iniciada:', data.status);
        return data;
    } catch (error) {
        console.error('❌ Erro ao iniciar sessão:', error);
        return null;
    }
}

// Função para obter QR Code
async function getQRCode() {
    try {
        const response = await fetch(`${WPP_SERVER_URL}/api/${SESSION}/qr-code`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token.split(':')[1]}`
            }
        });
        
        const data = await response.json();
        if (data.qrcode) {
            const qrCodeDataURL = await QRCode.toDataURL(data.qrcode);
            io.emit('qr-code', qrCodeDataURL);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ Erro ao obter QR Code:', error);
        return false;
    }
}

// Função para verificar status da sessão
async function checkSessionStatus() {
    try {
        const response = await fetch(`${WPP_SERVER_URL}/api/${SESSION}/status-session`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token.split(':')[1]}`
            }
        });
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('❌ Erro ao verificar status:', error);
        return { status: 'CLOSED' };
    }
}

// Função para carregar grupos (usando a API que funcionou antes)
async function loadGroups() {
    try {
        console.log('🔍 Buscando grupos reais do WhatsApp...');
        
        const response = await fetch(`${WPP_SERVER_URL}/api/${SESSION}/all-groups`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token.split(':')[1]}`
            }
        });
        
        const data = await response.json();
        
        if (data.response) {
            // Filtrar apenas grupos que não são read-only
            const groupChats = data.response.filter(chat => 
                chat.isGroup === true && 
                chat.isReadOnly === false
            );
            
            groups = groupChats.map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Grupo sem nome',
                isReadOnly: chat.isReadOnly || false,
                participants: chat.participants?.length || 0
            }));
            
            console.log(`📊 Carregados ${groups.length} grupos reais do seu WhatsApp`);
            io.emit('groups-loaded', groups);
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('❌ Erro ao carregar grupos:', error);
        io.emit('groups-error', error.message);
        return false;
    }
}

// Função para conectar ao WhatsApp
async function connectToWhatsApp() {
    try {
        console.log('🔄 Iniciando conexão WhatsApp...');
        
        // Gerar token
        const tokenResult = await generateToken();
        if (!tokenResult) {
            io.emit('connection-error', 'Erro ao gerar token');
            return;
        }
        
        // Iniciar sessão
        const sessionResult = await startSession();
        if (!sessionResult) {
            io.emit('connection-error', 'Erro ao iniciar sessão');
            return;
        }
        
        // Obter QR Code
        const qrResult = await getQRCode();
        if (!qrResult) {
            io.emit('connection-error', 'Erro ao obter QR Code');
            return;
        }
        
        // Verificar status periodicamente
        const checkStatus = setInterval(async () => {
            const status = await checkSessionStatus();
            
            if (status.status === 'CONNECTED') {
                console.log('✅ Conectado ao WhatsApp!');
                isConnected = true;
                io.emit('connection-status', { connected: true, message: 'Conectado ao WhatsApp!' });
                clearInterval(checkStatus);
                
                // Carregar grupos após conectar
                setTimeout(loadGroups, 2000);
            } else if (status.status === 'CLOSED') {
                console.log('❌ Sessão fechada');
                isConnected = false;
                io.emit('connection-status', { connected: false, message: 'Sessão fechada' });
                clearInterval(checkStatus);
            }
        }, 3000);
        
    } catch (error) {
        console.error('❌ Erro na conexão:', error);
        io.emit('connection-error', error.message);
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
                const response = await fetch(`${WPP_SERVER_URL}/api/${SESSION}/send-message`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token.split(':')[1]}`
                    },
                    body: JSON.stringify({
                        phone: group.id,
                        message: messageConfig.text
                    })
                });
                
                const result = await response.json();
                
                if (result.response) {
                    success++;
                    console.log(`✅ Enviado para: ${group.name}`);
                    
                    socket.emit('message-sent', {
                        group: group.name,
                        success: true,
                        progress: i + 1,
                        total: selectedGroups.length
                    });
                } else {
                    throw new Error(result.message || 'Erro desconhecido');
                }
                
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
    console.log('⚠️  Certifique-se de que o WPPConnect Server está rodando na porta 21465');
});

// Conectar automaticamente ao WhatsApp
connectToWhatsApp();
